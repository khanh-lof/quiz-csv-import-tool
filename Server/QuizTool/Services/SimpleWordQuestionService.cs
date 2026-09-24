using QuizTool.Models;

namespace QuizTool.Services;

public class SimpleWordQuestionService : ISimpleWordQuestionService
{
    public object BuildRequest(
        List<(string base64, string contentType)> images,
        string model,
        CsvGenerationOptions options)
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
}
