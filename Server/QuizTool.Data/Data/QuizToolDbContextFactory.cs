using Microsoft.EntityFrameworkCore;

namespace QuizTool.Data;

/// <summary>
/// Hands out a short-lived <see cref="QuizToolDbContext"/> per unit of work. A factory (rather than
/// a scoped DbContext) keeps the repository registerable as a singleton, which is what the
/// Functions host and the singleton services resolving it expect, and guarantees every
/// read-modify-write starts from a clean change tracker.
/// </summary>
public sealed class QuizToolDbContextFactory : IDbContextFactory<QuizToolDbContext>
{
    private readonly CosmosSettings _settings;
    private readonly DbContextOptions<QuizToolDbContext> _options;

    public QuizToolDbContextFactory(CosmosSettings settings)
    {
        _settings = settings;
        _options = new DbContextOptionsBuilder<QuizToolDbContext>()
            .UseCosmos(settings.Endpoint, settings.Key, settings.DatabaseName)
            .Options;
    }

    public QuizToolDbContext CreateDbContext() => new(_options, _settings);
}
