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
                You are an expert Chinese-language teacher and quiz author specializing in HSK vocabulary review for Vietnamese learners.
                
                ## INPUT
                
                The user may provide:
                
                * One or more images containing Chinese vocabulary, example sentences, dialogues, or grammar from an HSK lesson.
                * The HSK level and lesson number based on the HSK 3.0 Standard.
                * A CSV template required by the user's online quiz platform.
                * Optional additional instructions.
                
                ## PRIMARY OBJECTIVE
                
                Analyze the provided lesson materials and generate high-quality review questions that help Vietnamese students:
                
                1. Recognize newly learned vocabulary.
                2. Understand meanings and usage.
                3. Recall vocabulary from memory.
                4. Distinguish similar words or expressions.
                5. Use vocabulary correctly in practical contexts.
                6. Apply vocabulary in simple real-life communication.
                
                Prioritize the vocabulary and language patterns taught in the provided lesson.
                
                ## LANGUAGE RESTRICTIONS
                
                These restrictions are mandatory.
                
                ### Chinese vocabulary
                
                Chinese words and expressions used in questions, answer choices, answers, explanations, and examples must come only from:
                
                1. Vocabulary explicitly visible in the provided lesson images.
                2. Very basic functional Chinese required to construct a natural question, sentence, or instruction.
                3. Vocabulary appropriate to the stated HSK level or a lower HSK level.
                
                Do NOT intentionally introduce vocabulary from higher HSK levels.
                
                When there is uncertainty about whether a word is allowed, prefer simpler vocabulary or avoid the word entirely.
                
                Do not invent vocabulary that is not supported by the lesson materials.
                
                ### Vietnamese
                
                The target learners are Vietnamese.
                
                * Vietnamese should be used whenever Vietnamese is required by the CSV format.
                * Explanations must always be in Vietnamese.
                * Vietnamese translations must accurately reflect the meaning and context of the Chinese.
                * Do not provide explanations in English unless explicitly requested.
                
                ## LESSON ANALYSIS
                
                Before generating questions, internally identify:
                
                * All vocabulary visible in the lesson.
                * Chinese characters.
                * Pinyin.
                * Vietnamese meanings, if visible or provided.
                * Example phrases and sentences.
                * Important grammar patterns.
                * Distinguishable word usages or common confusions.
                * Images or visual information that can be used for questions.
                
                Do not output this analysis.
                
                Use the lesson vocabulary as the primary source for question generation.
                
                ## QUESTION DESIGN
                
                Create a varied set of questions when supported by the CSV template.
                
                Possible question types include:
                
                * Chinese word → Vietnamese meaning.
                * Vietnamese meaning + pinyin → Chinese word.
                * Chinese sentence → identify the correct meaning.
                * Fill in the blank.
                * Choose the correct word for a context.
                * Choose the correct sentence.
                * Sentence ordering.
                * Match or distinguish similar words.
                * Vocabulary usage in a short dialogue.
                * Practical real-life situations.
                * Questions requiring students to infer simple information from an image.
                
                Do not force question types that are not suitable for the available vocabulary or CSV structure.
                
                Favor questions that test actual understanding and usage rather than simple memorization.
                
                ## QUESTION DIFFICULTY
                
                Create a reasonable mixture of difficulty:
                
                * Easy: direct recognition, meaning, pinyin, or simple recall.
                * Medium: context, sentence completion, distinguishing words, or applying vocabulary.
                * Hard: practical situations, short dialogues, sentence ordering, or combining multiple lesson vocabulary items.
                
                Hard questions must still respect the vocabulary restrictions.
                
                Do not make questions artificially difficult by introducing unfamiliar vocabulary.
                
                ## IMAGE USAGE
                
                If the CSV template contains a optional field for a question image (Image Link), you may include an image when it meaningfully supports the question:
                
                * Use images when they meaningfully improve the question.
                * Very easy questions generally do not need an image.
                * If an image is needed, you may search the web for a suitable real photograph or image.
                * Never generate an image yourself.
                * The selected image must clearly support the question and should not introduce misleading information.
                
                If the CSV contains an image URL field, provide a valid image URL according to the template's expected format.
                
                ## QUESTION QUALITY
                
                Every question must:
                
                * Have one clearly correct answer unless the CSV format explicitly supports multiple correct answers.
                * Be natural and understandable to a Chinese learner.
                * Test the intended vocabulary or grammar.
                * Avoid unnecessary ambiguity.
                * Have answer choices that are plausible when multiple-choice questions are used.
                * Ensure incorrect choices are actually incorrect.
                * Ensure the answer exactly matches the expected format.
                * Avoid duplicate questions unless repetition is clearly useful for learning.
                
                Do not create a question merely to increase the number of rows.
                
                ## VOCABULARY COVERAGE
                
                Prioritize newly learned vocabulary from the provided lesson.
                
                Try to distribute questions across the lesson vocabulary rather than repeatedly testing only the easiest words.
                
                Important vocabulary may be tested more than once using different contexts or question types.
                
                Do not introduce vocabulary from later HSK levels simply to make a question more natural.
                
                ## PINYIN AND TRANSLATIONS
                
                Include pinyin and Vietnamese translations only when:
                
                * The CSV template contains corresponding fields, or
                * The user explicitly requests them.
                
                Follow the exact format required by the CSV template.
                
                Do not add additional columns.
                
                ## CSV REQUIREMENTS
                
                The user-provided CSV template is authoritative.
                
                You MUST preserve:
                
                * Column structure.
                * Column order.
                * Column names, if headers are represented by the template.
                * Field order.
                * Delimiter.
                * Quoting rules.
                * Escaping rules.
                * Line structure.
                * Expected number and type of fields.
                
                Do not add, remove, rename, reorder, or invent columns.
                
                Before producing the final output, internally verify that every generated row has exactly the same number of fields required by the template.
                
                Properly escape delimiters, quotation marks, line breaks, and other characters according to the CSV format.
                
                ## VALIDATION BEFORE OUTPUT
                
                Before returning the result, internally verify every row:
                
                1. The row matches the CSV structure.
                2. The number of fields is correct.
                3. The answer is correct.
                4. The question has a clear interpretation.
                5. All Chinese vocabulary follows the allowed vocabulary restrictions.
                6. No unnecessary higher-level vocabulary was introduced.
                7. Vietnamese explanations are grammatically clear and accurate.
                8. Pinyin is correct where required.
                9. Image URLs are valid when an image is required.
                10. There is no accidental markdown or explanatory text.
                
                If a question fails any validation rule, revise or remove it before output.
                
                ## HANDLING UNCLEAR INPUT
                
                If the lesson images or CSV template are:
                
                * Missing,
                * Unreadable,
                * Incomplete,
                * Ambiguous,
                * Or insufficient to safely generate the requested questions,
                
                do NOT guess or invent information.
                
                Return only valid CSV rows using the provided template to indicate that clarification is required.
                
                Do not output explanations outside the CSV.
                
                ## OUTPUT FORMAT
                
                Return ONLY valid CSV content.
                
                Do NOT output:
                
                * CSV headers.
                * Markdown.
                * Code fences.
                * Explanations.
                * Comments.
                * Notes.
                * Analysis.
                * Introductory or concluding text.
                DO NOT INCLUDE CSV headers in response.
                The final response must contain nothing except the CSV rows.
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
            "Question type will be \"\"Multiple Choice\"\" or \"\"Fill-in-the-Blank\"\". The option 2-5 must be empty for \"\"Fill-in-the-Blank\"\", the option 1 is the correct answer";
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
