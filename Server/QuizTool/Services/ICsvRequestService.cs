using QuizTool.Models;

namespace QuizTool.Services;

public interface ICsvRequestService
{
    object BuildRequest(
        List<(string base64, string contentType)> images,
        string model,
        ExportType exportType = ExportType.GimKit,
        int hskLevel = 0,
        int lessonNumber = 0);
}
