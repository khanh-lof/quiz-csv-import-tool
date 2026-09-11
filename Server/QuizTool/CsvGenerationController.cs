using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Net.Http.Headers;
using QuizTool.Models;
using QuizTool.Repository;
using QuizTool.Services;
using ContentDispositionHeaderValue = Microsoft.Net.Http.Headers.ContentDispositionHeaderValue;
using MediaTypeHeaderValue = Microsoft.Net.Http.Headers.MediaTypeHeaderValue;

namespace QuizTool;

public sealed class CsvGenerationController
{
    private readonly IUserRepository _userRepo;
    private readonly ISimpleWordQuestionService _simpleWordQuestionService;
    private readonly ICreativeRequestService _creativeRequestService;

    public CsvGenerationController(
        IUserRepository userRepo,
        ISimpleWordQuestionService simpleWordQuestionService,
        ICreativeRequestService creativeRequestService)
    {
        _userRepo = userRepo;
        _simpleWordQuestionService = simpleWordQuestionService;
        _creativeRequestService = creativeRequestService;
    }

    [Function("GenerateCsvFromImage")]
    public async Task<HttpResponseData> RunAsync(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "csv/generate-from-image")]
        HttpRequestData req,
        FunctionContext context,
        CancellationToken cancellationToken)
    {
        var logger = context.GetLogger<CsvGenerationController>();

        // Authorization header
        if (!req.Headers.TryGetValues("Authorization", out var authVals) || authVals is null)
        {
            var r = req.CreateResponse(HttpStatusCode.Unauthorized);
            return r;
        }

        var authHeader = authVals.FirstOrDefault();
        if (string.IsNullOrWhiteSpace(authHeader) ||
            !AuthenticationHeaderValue.TryParse(authHeader, out var authHeaderValue) ||
            !string.Equals(authHeaderValue.Scheme, "Bearer", StringComparison.OrdinalIgnoreCase) ||
            string.IsNullOrWhiteSpace(authHeaderValue.Parameter))
        {
            var r = req.CreateResponse(HttpStatusCode.Unauthorized);
            return r;
        }

        var token = authHeaderValue.Parameter;
        ClaimsPrincipal principal;
        try
        {
            principal = JwtAuth.ValidateToken(token);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "JWT validation failed");
            var r = req.CreateResponse(HttpStatusCode.Unauthorized);
            return r;
        }

        var username = principal.Claims.Single(x => x.Type == ClaimTypes.Name).Value;
        var user = await _userRepo.GetUserByUsernameAsync(username, cancellationToken);
        if (user == null)
        {
            var r = req.CreateResponse(HttpStatusCode.NotFound);
            await r.WriteStringAsync("User not found", cancellationToken);
            return r;
        }

        if (!JwtAuth.HasAnyRole(principal, "User", "Admin"))
        {
            var r = req.CreateResponse(HttpStatusCode.Forbidden);
            return r;
        }

        // Expect multipart/form-data with one or more file fields
        if (!req.Headers.TryGetValues(HeaderNames.ContentType, out var contentTypeVals))
        {
            var r = req.CreateResponse(HttpStatusCode.BadRequest);
            await r.WriteStringAsync("Missing Content-Type header", cancellationToken);
            return r;
        }
        var contentType = contentTypeVals.FirstOrDefault();
        if (string.IsNullOrWhiteSpace(contentType) ||
            !contentType.Contains("multipart/form-data", StringComparison.OrdinalIgnoreCase))
        {
            var r = req.CreateResponse(HttpStatusCode.BadRequest);
            await r.WriteStringAsync("Expected multipart/form-data", cancellationToken);
            return r;
        }

        var mediaType = MediaTypeHeaderValue.Parse(contentType);
        var boundary = HeaderUtilities.RemoveQuotes(mediaType.Boundary).Value;
        if (string.IsNullOrWhiteSpace(boundary))
        {
            var r = req.CreateResponse(HttpStatusCode.BadRequest);
            await r.WriteStringAsync("Missing multipart boundary", cancellationToken);
            return r;
        }

        var reader = new MultipartReader(boundary, req.Body);
        var section = await reader.ReadNextSectionAsync(cancellationToken);
        var images = new List<(MemoryStream Stream, string ContentType)>();

        while (section != null)
        {
            var hasContentDispositionHeader =
                ContentDispositionHeaderValue.TryParse(section.ContentDisposition, out var contentDisposition);
            if (hasContentDispositionHeader && contentDisposition != null &&
                contentDisposition.DispositionType.Equals("form-data") &&
                !string.IsNullOrEmpty(contentDisposition.FileName.Value))
            {
                var contentTypeHeader = section.ContentType ?? "application/octet-stream";
                var ms = new MemoryStream();
                await section.Body.CopyToAsync(ms, cancellationToken);
                ms.Position = 0;
                images.Add((ms, contentTypeHeader));
            }

            section = await reader.ReadNextSectionAsync(cancellationToken);
        }

        if (images.Count == 0)
        {
            var r = req.CreateResponse(HttpStatusCode.BadRequest);
            await r.WriteStringAsync("Image is required.", cancellationToken);
            return r;
        }

        var callCountAcceptedInARound = int.Parse(Environment.GetEnvironmentVariable("CALL_COUNT_ACCEPTED_IN_A_ROUND") ?? "2");
        var roundMinutes = int.Parse(Environment.GetEnvironmentVariable("ROUND_MINUTES") ?? "1");
        if (user.AiCallCountInRound >= callCountAcceptedInARound && user.StartRoundTime.HasValue && user.StartRoundTime.Value.AddMinutes(roundMinutes) > DateTime.UtcNow)
        {
            var r = req.CreateResponse(HttpStatusCode.Forbidden);
            await r.WriteStringAsync("You have reached the limit for AI calls.", cancellationToken);
            return r;
        }

        if (user.StartRoundTime.HasValue && DateTime.UtcNow.AddMinutes(-roundMinutes) <= user.StartRoundTime.Value)
        {
            await _userRepo.IncreaseAiCallCountInRound(user, cancellationToken);
        }
        else
        {
            await _userRepo.StartRoundAsync(user, cancellationToken);
        }

        var imageData = new List<(string base64, string contentType)>();
        foreach (var (ms, ct) in images)
        {
            ms.Position = 0;
            var base64 = await ReadStreamAsBase64(ms);
            imageData.Add((base64, ct));
        }
        var isCreative = bool.TryParse(req.Query.Get("isCreative"), out var creative) && creative;
        var exportType = ExportType.GimKit;
        var hskLevel = 0;
        var lessonNumber = 0;
        if (isCreative)
        {
            if (Enum.TryParse<ExportType>(req.Query.Get("exportType"), out var type) && Enum.IsDefined(type))
            {
                exportType = type;
            }
            else
            {
                var r = req.CreateResponse(HttpStatusCode.BadRequest);
                await r.WriteStringAsync("Invalid or missing exportType parameter.", cancellationToken);
                return r;
            }

            if (!int.TryParse(req.Query.Get("hskLevel"), out hskLevel))
            {
                var r = req.CreateResponse(HttpStatusCode.BadRequest);
                await r.WriteStringAsync("Invalid or missing hskLevel parameter.", cancellationToken);
                return r;
            }

            if (!int.TryParse(req.Query.Get("lessonNumber"), out lessonNumber))
            {
                var r = req.CreateResponse(HttpStatusCode.BadRequest);
                await r.WriteStringAsync("Invalid or missing lessonNumber parameter.", cancellationToken);
                return r;
            }
        }
        var csv = await GenerateCsvFromImageAsync(imageData, isCreative, exportType, hskLevel, lessonNumber, logger, cancellationToken);

        var ok = req.CreateResponse(HttpStatusCode.OK);
        ok.Headers.Add("Content-Type", "text/csv; charset=utf-8");
        await ok.WriteStringAsync(csv, cancellationToken);
        return ok;
    }

    private async Task<string> GenerateCsvFromImageAsync(List<(string base64, string contentType)> images,
        bool isCreative,
        ExportType exportType,
        int hskLevel, int lessonNumber,
        ILogger<CsvGenerationController> logger, CancellationToken cancellationToken)
    {
        var apiKey = GetEnv("OPENAI_API_KEY");
        var baseUrl = GetEnv("OPENAI_BASE_URL").TrimEnd('/');
        var model = GetEnv("LLM_MODEL");

        using var httpClient = new HttpClient();

        httpClient.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", apiKey);

        ICsvRequestService requestService = isCreative ? _creativeRequestService : _simpleWordQuestionService;
        var request = requestService.BuildRequest(images, model, exportType, hskLevel, lessonNumber);

        var response = await httpClient.PostAsJsonAsync(
            $"{baseUrl}/chat/completions",
            request, cancellationToken: cancellationToken);

        var responseBody = await response.Content.ReadAsStringAsync(cancellationToken);

        logger.LogInformation(responseBody);

        response.EnsureSuccessStatusCode();

        using var document = JsonDocument.Parse(responseBody);

        var content = document.RootElement
            .GetProperty("choices")[0]
            .GetProperty("message")
            .GetProperty("content")
            .GetString() ?? string.Empty;

        return ExtractCsvContent(content);
    }

    private static string GetEnv(string envKey)
    {
        var apiKey = Environment.GetEnvironmentVariable(envKey);

        return string.IsNullOrWhiteSpace(apiKey) ? throw new ArgumentException($"{envKey} key is required.") : apiKey;
    }

    private static string ExtractCsvContent(string rawText)
    {
        var trimmed = rawText?.Trim() ?? string.Empty;

        if (string.IsNullOrEmpty(trimmed))
            return string.Empty;

        var fenced = Regex.Match(
            trimmed,
            @"```(?:csv)?\s*([\s\S]*?)```",
            RegexOptions.IgnoreCase);

        if (fenced.Success)
            return fenced.Groups[1].Value.Trim();

        var header = Regex.Match(
            trimmed,
            @"(?:^|\n)(Câu hỏi\s*,\s*Đáp án[\s\S]*)",
            RegexOptions.IgnoreCase);

        if (header.Success)
            return header.Groups[1].Value.Trim();

        return trimmed;
    }

    private static async Task<string> ReadStreamAsBase64(Stream stream)
    {
        using var memory = new MemoryStream();
        await stream.CopyToAsync(memory);
        return Convert.ToBase64String(memory.ToArray());
    }
}
