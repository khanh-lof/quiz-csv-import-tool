using System.Net;
using Microsoft.Azure.Cosmos;
using QuizTool.Models;
using QuizTool.Utils;

namespace QuizTool.Repository;

public class CosmosUserRepository : ICosmosUserRepository
{
    private readonly Container _userContainer;
    private readonly PasswordHasher _hasher;
    private readonly int _maxRefreshTokensPerUser;

    public CosmosUserRepository(CosmosClient client, PasswordHasher hasher)
    {
        _hasher = hasher;
        var dbName = Environment.GetEnvironmentVariable("COSMOS_DATABASE") ?? "QuizDb";
        var containerName = Environment.GetEnvironmentVariable("COSMOS_CONTAINER") ?? "Users";
        _maxRefreshTokensPerUser = int.Parse(Environment.GetEnvironmentVariable("MAX_REFRESH_TOKENS_PER_USER") ?? "5");

        var dbResponse = client.CreateDatabaseIfNotExistsAsync(dbName).GetAwaiter().GetResult();
        var containerResponse = dbResponse.Database
            .CreateContainerIfNotExistsAsync(new ContainerProperties(containerName, "/username")).GetAwaiter()
            .GetResult();
        _userContainer = containerResponse.Container;
    }

    public async Task<QuizToolUser?> GetUserByUsernameAsync(string username, CancellationToken cancellationToken)
    {
        try
        {
            var sql = "SELECT * FROM c WHERE c.username = @username";
            var query = _userContainer.GetItemQueryIterator<QuizToolUser>(
                new QueryDefinition(sql).WithParameter("@username", username));
            while (query.HasMoreResults)
            {
                var res = await query.ReadNextAsync(cancellationToken);
                if (res.Any()) return res.First();
            }

            return null;
        }
        catch
        {
            return null;
        }
    }

    public async Task CreateUserAsync(QuizToolUser quizToolUser, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(quizToolUser.Id)) quizToolUser.Id = quizToolUser.Username;
        await _userContainer.UpsertItemAsync(quizToolUser, new PartitionKey(quizToolUser.Username), cancellationToken: cancellationToken);
    }

    public async Task<(bool Valid, string[] Roles)> ValidateCredentialsAsync(string username, string password,
        CancellationToken cancellationToken)
    {
        var user = await GetUserByUsernameAsync(username, cancellationToken);
        if (user == null) return (false, Array.Empty<string>());
        var ok = _hasher.Verify(password, user.PasswordHash);
        return (ok, user.Roles);
    }

    // Adds a new refresh-token entry for this user without touching other existing entries,
    // pruning expired entries and enforcing the max-concurrent-sessions cap (evicting oldest first).
    public async Task AddRefreshTokenAsync(string username, string refreshToken, DateTime expiresAt, CancellationToken cancellationToken)
    {
        await MutateUserWithRetryAsync(username, user =>
        {
            var now = DateTime.UtcNow;
            user.RefreshTokens.RemoveAll(t => t.ExpiresAt <= now);
            user.RefreshTokens.Add(new RefreshTokenEntry { Token = refreshToken, ExpiresAt = expiresAt, CreatedAt = now });
            if (user.RefreshTokens.Count > _maxRefreshTokensPerUser)
            {
                user.RefreshTokens = user.RefreshTokens
                    .OrderByDescending(t => t.CreatedAt)
                    .Take(_maxRefreshTokensPerUser)
                    .ToList();
            }
            return true;
        }, cancellationToken);
    }

    // Atomically removes oldRefreshToken (if present) and adds a new entry, in one ETag-guarded write.
    public async Task RotateRefreshTokenAsync(string username, string oldRefreshToken, string newRefreshToken, DateTime newExpiresAt, CancellationToken cancellationToken)
    {
        await MutateUserWithRetryAsync(username, user =>
        {
            var now = DateTime.UtcNow;
            user.RefreshTokens.RemoveAll(t => t.Token == oldRefreshToken || t.ExpiresAt <= now);
            user.RefreshTokens.Add(new RefreshTokenEntry { Token = newRefreshToken, ExpiresAt = newExpiresAt, CreatedAt = now });
            return true;
        }, cancellationToken);
    }

    // Removes exactly one matching token entry (logout of a single device/session).
    public async Task RemoveRefreshTokenAsync(string username, string refreshToken, CancellationToken cancellationToken)
    {
        await MutateUserWithRetryAsync(username, user =>
        {
            var now = DateTime.UtcNow;
            var removed = user.RefreshTokens.RemoveAll(t => t.Token == refreshToken);
            var pruned = user.RefreshTokens.RemoveAll(t => t.ExpiresAt <= now);
            return removed > 0 || pruned > 0;
        }, cancellationToken);
    }

    // Removes every token entry for the user (logout of all devices/sessions).
    public async Task ClearAllRefreshTokensAsync(string username, CancellationToken cancellationToken)
    {
        for (var attempt = 0; attempt < 5; attempt++)
        {
            ItemResponse<QuizToolUser> response;

            try
            {
                response = await _userContainer.ReadItemAsync<QuizToolUser>(
                    username,
                    new PartitionKey(username),
                    cancellationToken: cancellationToken);
            }
            catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
            {
                return;
            }

            if (response.Resource.RefreshTokens.Count == 0)
            {
                return;
            }

            try
            {
                await _userContainer.PatchItemAsync<QuizToolUser>(
                    username,
                    new PartitionKey(username),
                    [
                        PatchOperation.Set(
                            "/refreshTokens",
                            Array.Empty<RefreshTokenEntry>())
                    ],
                    new PatchItemRequestOptions
                    {
                        IfMatchEtag = response.ETag
                    },
                    cancellationToken);

                return;
            }
            catch (CosmosException ex)
                when (ex.StatusCode == HttpStatusCode.PreconditionFailed)
            {
                // Concurrent update. Read again and retry.
            }
        }

        throw new InvalidOperationException(
            $"Failed to clear refresh tokens for user '{username}'.");
    }

    public async Task<QuizToolUser?> GetUserByRefreshTokenAsync(string refreshToken, CancellationToken cancellationToken)
    {
        try
        {
            var sql = "SELECT DISTINCT VALUE c FROM c JOIN t IN c.refreshTokens WHERE t.token = @token";
            var query = _userContainer.GetItemQueryIterator<QuizToolUser>(
                new QueryDefinition(sql).WithParameter("@token", refreshToken));
            while (query.HasMoreResults)
            {
                var res = await query.ReadNextAsync(cancellationToken);
                if (res.Any()) return res.First();
            }
            return null;
        }
        catch
        {
            return null;
        }
    }

    // Read-modify-write with optimistic concurrency: retries on a concurrent write (HTTP 412)
    // so two devices logging in/refreshing at the same time can't silently drop each other's entries.
    private async Task<QuizToolUser?> MutateUserWithRetryAsync(
        string username,
        Func<QuizToolUser, bool> mutate,
        CancellationToken cancellationToken,
        int maxAttempts = 5)
    {
        for (var attempt = 0; attempt < maxAttempts; attempt++)
        {
            ItemResponse<QuizToolUser> readResponse;
            try
            {
                readResponse = await _userContainer.ReadItemAsync<QuizToolUser>(
                    username, new PartitionKey(username), cancellationToken: cancellationToken);
            }
            catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
            {
                return null;
            }

            var user = readResponse.Resource;
            if (!mutate(user)) return user;

            try
            {
                var writeResponse = await _userContainer.UpsertItemAsync(
                    user, new PartitionKey(user.Username),
                    new ItemRequestOptions { IfMatchEtag = readResponse.ETag },
                    cancellationToken);
                return writeResponse.Resource;
            }
            catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.PreconditionFailed)
            {
                // Concurrent update landed first — reread and retry.
            }
        }

        throw new InvalidOperationException(
            $"Failed to update refresh tokens for user '{username}' after {maxAttempts} attempts due to concurrent writes.");
    }

    public async Task StartRoundAsync(QuizToolUser user, CancellationToken cancellationToken)
    {
        await MutateUserWithRetryAsync(user.Username, u =>
        {
            u.AiCallCountInRound = 1;
            u.StartRoundTime = DateTime.UtcNow;
            return true;
        }, cancellationToken);
    }

    public async Task IncreaseAiCallCountInRound(QuizToolUser user, CancellationToken cancellationToken)
    {
        await MutateUserWithRetryAsync(user.Username, u =>
        {
            u.AiCallCountInRound++;
            return true;
        }, cancellationToken);
    }
}