using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using QuizTool.Repository;
using QuizTool.Utils;

namespace QuizTool.Data;

public static class DataServiceCollectionExtensions
{
    /// <summary>
    /// Registers the EF Core Cosmos data layer when COSMOS_ENDPOINT/COSMOS_KEY are configured.
    /// Returns false (and registers nothing) otherwise, so callers can fall back exactly as they
    /// did when the raw Cosmos client was absent.
    /// </summary>
    public static bool AddQuizToolData(this IServiceCollection services)
    {
        var settings = CosmosSettings.FromEnvironment();
        if (settings is null) return false;

        services.AddSingleton(settings);
        services.AddSingleton<IDbContextFactory<QuizToolDbContext>, QuizToolDbContextFactory>();
        services.AddSingleton<PasswordHasher>();
        services.AddSingleton<IUserRepository, UserRepository>();
        return true;
    }
}
