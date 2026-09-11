using Microsoft.EntityFrameworkCore;
using QuizTool.Data;
using QuizTool.Models;
using QuizTool.Utils;

namespace QuizTool.Repository;

public class UserRepository : IUserRepository
{
    private readonly IDbContextFactory<QuizToolDbContext> _contextFactory;
    private readonly PasswordHasher _hasher;
    private readonly int _maxRefreshTokensPerUser;
    private readonly SemaphoreSlim _initLock = new(1, 1);
    private bool _initialized;

    public UserRepository(IDbContextFactory<QuizToolDbContext> contextFactory, PasswordHasher hasher,
        CosmosSettings settings)
    {
        _contextFactory = contextFactory;
        _hasher = hasher;
        _maxRefreshTokensPerUser = settings.MaxRefreshTokensPerUser;
    }

    public async Task<QuizToolUser?> GetUserByUsernameAsync(string username, CancellationToken cancellationToken)
    {
        try
        {
            await using var db = await CreateContextAsync(cancellationToken);
            return await db.Users
                .WithPartitionKey(username)
                .AsNoTracking()
                .FirstOrDefaultAsync(u => u.Username == username, cancellationToken);
        }
        catch
        {
            return null;
        }
    }

    public async Task CreateUserAsync(QuizToolUser quizToolUser, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(quizToolUser.Id)) quizToolUser.Id = quizToolUser.Username;

        await using var db = await CreateContextAsync(cancellationToken);
        var existing = await db.Users
            .WithPartitionKey(quizToolUser.Username)
            .FirstOrDefaultAsync(u => u.Id == quizToolUser.Id, cancellationToken);

        if (existing is null)
        {
            db.Users.Add(quizToolUser);
        }
        else
        {
            // Upsert semantics: overwrite the stored document with the supplied one.
            db.Entry(existing).CurrentValues.SetValues(quizToolUser);
            existing.Roles = quizToolUser.Roles;
            existing.RefreshTokens = quizToolUser.RefreshTokens;
        }

        await db.SaveChangesAsync(cancellationToken);
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
        await MutateUserWithRetryAsync(username, user =>
        {
            if (user.RefreshTokens.Count == 0) return false;
            user.RefreshTokens.Clear();
            return true;
        }, cancellationToken);
    }

    public async Task<QuizToolUser?> GetUserByRefreshTokenAsync(string refreshToken, CancellationToken cancellationToken)
    {
        try
        {
            await using var db = await CreateContextAsync(cancellationToken);
            return await db.Users
                .AsNoTracking()
                .FirstOrDefaultAsync(u => u.RefreshTokens.Any(t => t.Token == refreshToken), cancellationToken);
        }
        catch
        {
            return null;
        }
    }

    // Read-modify-write with optimistic concurrency: retries when a concurrent write bumped the
    // ETag first, so two devices logging in/refreshing at the same time cannot silently drop each
    // other's entries.
    private async Task<QuizToolUser?> MutateUserWithRetryAsync(
        string username,
        Func<QuizToolUser, bool> mutate,
        CancellationToken cancellationToken,
        int maxAttempts = 5)
    {
        for (var attempt = 0; attempt < maxAttempts; attempt++)
        {
            await using var db = await CreateContextAsync(cancellationToken);

            var user = await db.Users
                .WithPartitionKey(username)
                .FirstOrDefaultAsync(u => u.Id == username, cancellationToken);
            if (user is null) return null;

            if (!mutate(user)) return user;

            try
            {
                await db.SaveChangesAsync(cancellationToken);
                return user;
            }
            catch (DbUpdateConcurrencyException)
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

    // The Cosmos database and container are created on first use, mirroring the
    // CreateDatabaseIfNotExists/CreateContainerIfNotExists calls the old constructor made eagerly.
    private async Task<QuizToolDbContext> CreateContextAsync(CancellationToken cancellationToken)
    {
        var db = await _contextFactory.CreateDbContextAsync(cancellationToken);
        if (_initialized) return db;

        await _initLock.WaitAsync(cancellationToken);
        try
        {
            if (!_initialized)
            {
                await db.Database.EnsureCreatedAsync(cancellationToken);
                _initialized = true;
            }
        }
        finally
        {
            _initLock.Release();
        }

        return db;
    }
}
