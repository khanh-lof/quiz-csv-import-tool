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

    private static async Task<string> GenerateCsvFromImageAsync(List<(string base64, string contentType)> images,
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

        var request = isCreative? BuildCreativeRequest(images, model, exportType, hskLevel, lessonNumber) : BuildSimpleWordQuestionRequest(images, model);

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

    private static object BuildSimpleWordQuestionRequest(List<(string base64, string contentType)> images, string model)
    {
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
        return request;
    }

    private static object BuildCreativeRequest(List<(string base64, string contentType)> images, string model, ExportType exportType, int hskLevel, int lessonNumber)
    {
        var systemMessage = new
        {
            role = "system",
            content =
                """
                You are an expert Chinese-language teacher and quiz author specializing in HSK vocabulary review.
                The user will provide:
                - One or more images containing Chinese vocabulary from an HSK lesson
                - The HSK level and lesson number (HSK 3.0 Standard)
                - A CSV format/template required by their online quiz platform
                - Optional additional instructions

                Your task:
                1. Carefully read and extract all vocabulary, meanings, pinyin, example phrases, and grammar information visible in the images.
                2. Create creative, practical, effective review questions that help the student recognize, understand, recall, and actively use the vocabulary.
                3. Ensure every Chinese word used in questions, answer choices, explanations, and answers is limited to:
                   - Vocabulary visible in the provided lesson images, and
                   - Very basic Chinese needed to form understandable questions, appropriate for the stated or lower HSK level.
                   - The student are Vietnamese. Therefore, all contents should be in Vietnamese and Chinese
                   - The explanations if has, it must be Vietnamese
                4. Prioritize the newly learned vocabulary from the provided images. Do not use vocabulary from later HSK levels.
                5. Create a varied mix of question types when supported by the user’s CSV format, such as:
                   - Chinese word → meaning
                   - Meaning → Chinese word
                   - Pinyin → Chinese word
                   - Fill in the blank
                   - Choose the correct word for a context
                   - Sentence ordering
                   - Match or distinguish similar words
                   - Short practical dialogue situations
                6. Make questions clear, natural, age-neutral, and useful for real-life Chinese communication.
                7. Verify that every answer is correct, unambiguous, and matches the question exactly.
                8. Include pinyin and Vietnamese translations only if the user’s CSV format has fields for them or explicitly requests them.
                9. Follow the user-provided CSV structure, column names, field order, quoting rules, and delimiters exactly.
                10. Return only valid CSV content without headers. Do not include explanations, markdown, headings, notes, code fences, or any text outside the CSV.
                11. If the images or CSV template are unclear, incomplete, or unreadable, return only valid CSV rows according to the provided template indicating that clarification is needed; do not guess or invent vocabulary.
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

        List<string> userMessages = [
            .. GetAdditionalUserMessagesForExportType(exportType),
            $"HSK Level: {hskLevel}",
            $"Lesson number: {lessonNumber}"
        ];
        userContentList.AddRange(userMessages.Select(message => new
        {
            type = "text",
            text = message
        }));

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
        return request;
    }

    private static IEnumerable<string> GetAdditionalUserMessagesForExportType(ExportType exportType)
    {
        return exportType switch
        {
            ExportType.GimKit => GetAdditionalUserMessagesForGimKit(),
            ExportType.Blooket => GetAdditionalUserMessagesForBlooket(),
            ExportType.Wayground => GetAdditionalUserMessagesForWayground(),
            _ => throw new ArgumentOutOfRangeException(nameof(exportType), exportType, null)
        };
    }

    private static IEnumerable<string> GetAdditionalUserMessagesForGimKit()
    {
        yield return
            "CSV columns: Question,Correct Answer,Incorrect Answer 1,Incorrect Answer 2 (Optional),Incorrect Answer 3 (Optional)";
    }

    private static IEnumerable<string> GetAdditionalUserMessagesForBlooket()
    {
        yield return
            "CSV columns: Question #,Question Text,Answer 1,Answer 2,Answer 3,Answer 4,Time Limit (sec),Correct Answer(s)";
    }

    private static IEnumerable<string> GetAdditionalUserMessagesForWayground()
    {
        yield return
            "Question Text,Question Type,Option 1,Option 2,Option 3,Option 4,Option 5,Correct Answer,Time in seconds,Image Link,Answer explanation";
        yield return
            "Question type will be \"\"Multiple Choice\"\" or \"\"Fill-in-the-Blank\"\". The option 2-5 will be the alternative answers for \"\"Fill-in-the-Blank\"\" and optional in this case";
        yield return
            """
            "Text of the question
            
            (required)
            
            
            ","Question Type
            
            (default is Multiple Choice)
            
            ","Text for option 1
            
            (required in all cases)","Text for option 2","Text for option 3
            
            (optional)
            
            
            ","Text for option 4
            
            (optional)
            
            
            ","Text for option 5
            
            (optional)
            
            
            ","The correct option choice (between 1-5).
            
            Leave blank for ""Fill-in-the-Blank"".","Time in seconds
            
            (optional, default value is 30 seconds)
            ","Link of the image
            
            (optional)
            
            
            ","Explanation for the answer
            (optional)
            """;
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
