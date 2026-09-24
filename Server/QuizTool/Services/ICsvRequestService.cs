using QuizTool.Models;

namespace QuizTool.Services;

public interface ICsvRequestService
{
    object BuildRequest(
        List<(string base64, string contentType)> images,
        string model,
        CsvGenerationOptions options);
}
