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
using QuizTool.Repository;
using ContentDispositionHeaderValue = Microsoft.Net.Http.Headers.ContentDispositionHeaderValue;
using MediaTypeHeaderValue = Microsoft.Net.Http.Headers.MediaTypeHeaderValue;

namespace QuizTool;

public sealed class CsvGenerationController
{
    private readonly ICosmosUserRepository _userRepo;

    public CsvGenerationController(ICosmosUserRepository  userRepo)
    {
        _userRepo = userRepo;
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
        if (user.AiCallCountInRound > callCountAcceptedInARound && user.StartRoundTime.HasValue && user.StartRoundTime.Value.AddMinutes(roundMinutes) > DateTime.UtcNow)
        {
            var r = req.CreateResponse(HttpStatusCode.Forbidden);
            await r.WriteStringAsync("You have reached the limit for AI calls.", cancellationToken);
            return r;
        }

        if (user.StartRoundTime.HasValue && user.StartRoundTime.Value.AddMinutes(roundMinutes) <= DateTime.UtcNow)
        {
            await _userRepo.IncreaseAiCallCountInRound(user, cancellationToken);
        }
        else
        {
            await _userRepo.StartRoundAsync(user, cancellationToken);
        }

        var imageDatas = new List<(string base64, string contentType)>();
        foreach (var (ms, ct) in images)
        {
            ms.Position = 0;
            var base64 = await ReadStreamAsBase64(ms);
            imageDatas.Add((base64, ct));
        }

        var csv = await GenerateCsvFromImageAsync(imageDatas, logger, cancellationToken);

        var ok = req.CreateResponse(HttpStatusCode.OK);
        ok.Headers.Add("Content-Type", "text/csv; charset=utf-8");
        await ok.WriteStringAsync(csv, cancellationToken);
        return ok;
    }

    private static async Task<string> GenerateCsvFromImageAsync(List<(string base64, string contentType)> images,
        ILogger<CsvGenerationController> logger, CancellationToken cancellationToken)
    {
        var apiKey = GetEnv("OPENAI_API_KEY");
        var baseUrl = GetEnv("OPENAI_BASE_URL").TrimEnd('/');
        var model = GetEnv("LLM_MODEL");

        using var httpClient = new HttpClient();

        httpClient.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", apiKey);

        var systemMessage = new
        {
            role = "system",
            content =
            """
                        You are a helpful assistant that converts images of Chinese vocabulary into CSV.
                        Return ONLY a CSV string with exactly two columns named Câu hỏi và Đáp án.
                        Each row must contain one Chinese word.
                        In the Câu hỏi column, write Vietnamese meaning + pinyin + "Chữ Hán là gì?".
                        In the Đáp án column, write the Chinese word itself.
                        Do not include extra explanation, markdown, or code fences.
                        """
        };

        var userContentList = new List<object>
        {
            new
            {
                type = "text",
                text = "Convert the image to CSV using the required format."
            }
        };

        foreach (var img in images)
        {
            userContentList.Add(new
            {
                type = "image_url",
                image_url = new
                {
                    url = $"data:{img.contentType};base64,{img.base64}"
                }
            });
        }

        var request = new
        {
            model,
            messages = new object[]
            {
                systemMessage,
                new
                {
                    role = "user",
                    content = userContentList.ToArray()
                }
            },
            max_output_tokens = 10000
        };

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

        if (string.IsNullOrWhiteSpace(apiKey)) throw new InvalidOperationException($"{envKey} is not configured.");

        if (string.IsNullOrWhiteSpace(apiKey)) throw new ArgumentException($"{envKey} key is required.");

        return apiKey;
    }

    private static string ExtractCsvContent(string rawText)
    {
        var trimmed = rawText?.Trim() ?? string.Empty;

        if (string.IsNullOrEmpty(trimmed))
            return string.Empty;

        var fenced = Regex.Match(
            trimmed,
            @"```(?:csv)?\\s*([\\s\\S]*?)```",
            RegexOptions.IgnoreCase);

        if (fenced.Success)
            return fenced.Groups[1].Value.Trim();

        var header = Regex.Match(
            trimmed,
            @"(?:^|\\n)(Câu hỏi\\s*,\\s*Đáp án[\\s\\S]*)",
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
