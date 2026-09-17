namespace QuizTool.Models;

/// <summary>
/// Everything the creative prompt needs to know about the lesson being generated.
/// <see cref="Level"/> is optional for courses other than HSK/YCT, and images are optional
/// altogether: without them the model falls back to the canonical word list of the lesson.
/// </summary>
public sealed record CsvGenerationOptions
{
    public ExportType ExportType { get; init; } = ExportType.GimKit;

    public CourseType CourseType { get; init; } = CourseType.Hsk;

    /// <summary>Free-text course name, only used when <see cref="CourseType"/> is <see cref="Models.CourseType.Other"/>.</summary>
    public string? CourseName { get; init; }

    public int? Level { get; init; }

    public int? LessonNumber { get; init; }

    /// <summary>Human readable course name handed to the model, e.g. "HSK (HSK 3.0 Standard)".</summary>
    public string CourseDisplayName => CourseType switch
    {
        CourseType.Hsk => "HSK (HSK 3.0 Standard)",
        CourseType.Yct => "YCT (Youth Chinese Test)",
        _ => string.IsNullOrWhiteSpace(CourseName) ? "an unnamed Chinese course" : CourseName
    };
}
