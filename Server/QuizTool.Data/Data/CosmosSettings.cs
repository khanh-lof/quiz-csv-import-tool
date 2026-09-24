namespace QuizTool.Data;

/// <summary>
/// Connection and behaviour settings for the Cosmos-backed store, read from the same
/// environment variables the raw Cosmos SDK setup used.
/// </summary>
public sealed record CosmosSettings(
    string Endpoint,
    string Key,
    string DatabaseName,
    string ContainerName,
    int MaxRefreshTokensPerUser)
{
    /// <summary>
    /// Builds settings from the environment, or returns null when COSMOS_ENDPOINT/COSMOS_KEY
    /// are not configured (the data layer is then simply not registered).
    /// </summary>
    public static CosmosSettings? FromEnvironment()
    {
        var endpoint = Environment.GetEnvironmentVariable("COSMOS_ENDPOINT");
        var key = Environment.GetEnvironmentVariable("COSMOS_KEY");
        if (string.IsNullOrWhiteSpace(endpoint) || string.IsNullOrWhiteSpace(key)) return null;

        return new CosmosSettings(
            endpoint,
            key,
            Environment.GetEnvironmentVariable("COSMOS_DATABASE") ?? "QuizDb",
            Environment.GetEnvironmentVariable("COSMOS_CONTAINER") ?? "Users",
            int.Parse(Environment.GetEnvironmentVariable("MAX_REFRESH_TOKENS_PER_USER") ?? "5"));
    }
}
