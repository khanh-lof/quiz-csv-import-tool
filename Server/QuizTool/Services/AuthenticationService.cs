using System.Security.Cryptography;
using Microsoft.Extensions.DependencyInjection;
using QuizTool.Repository;

namespace QuizTool.Services
{
    public class AuthenticationService : IAuthenticationService
    {
        private readonly IServiceProvider _provider;
        private readonly int _refreshTokenExpiresDays;
        private readonly int _accessTokenExpiresMinutes;

        public AuthenticationService(IServiceProvider provider)
        {
            _provider = provider;
            _refreshTokenExpiresDays = int.Parse(Environment.GetEnvironmentVariable("JWT_REFRESH_TOKEN_EXPIRES_DAYS") ?? "30");
            _accessTokenExpiresMinutes = int.Parse(Environment.GetEnvironmentVariable("JWT_ACCESS_TOKEN_EXPIRES_MINUTES") ?? "15");
        }

        public async Task<(bool Valid, string[] Roles, string? Token, string? RefreshToken)> AuthenticateAsync(
            string username, string password, CancellationToken cancellationToken)
        {
            // Try Cosmos repo if registered
            var repo = _provider.GetService<ICosmosUserRepository>();
            if (repo != null)
            {
                var (valid, roles) = await repo.ValidateCredentialsAsync(username, password, cancellationToken);
                if (valid)
                {
                    var token = JwtTokenIssuer.CreateToken(username, roles, _accessTokenExpiresMinutes);
                    var (refreshToken, expiresAt) = GenerateRefreshToken();
                    await repo.AddRefreshTokenAsync(username, refreshToken, expiresAt, cancellationToken);
                    return (true, roles, token, refreshToken);
                }
            }

            return (false, Array.Empty<string>(), null, null);
        }

        public async Task<(bool Valid, string[] Roles, string? Token, string? RefreshToken)> RefreshTokenAsync(string refreshToken, CancellationToken cancellationToken)
        {
            var repo = _provider.GetService<ICosmosUserRepository>();
            if (repo != null)
            {
                var user = await repo.GetUserByRefreshTokenAsync(refreshToken, cancellationToken);
                var entry = user?.RefreshTokens.FirstOrDefault(t => t.Token == refreshToken);
                if (user != null && entry != null && entry.ExpiresAt > DateTime.UtcNow)
                {
                    var token = JwtTokenIssuer.CreateToken(user.Username, user.Roles, _accessTokenExpiresMinutes);
                    // rotate refresh token
                    var (newRefresh, expiresAt) = GenerateRefreshToken();
                    await repo.RotateRefreshTokenAsync(user.Username, refreshToken, newRefresh, expiresAt, cancellationToken);
                    return (true, user.Roles, token, newRefresh);
                }
            }

            return (false, Array.Empty<string>(), null, null);
        }

        public async Task<bool> LogoutAsync(string refreshToken, CancellationToken cancellationToken)
        {
            var repo = _provider.GetService<ICosmosUserRepository>();
            if (repo == null) return false;
            var user = await repo.GetUserByRefreshTokenAsync(refreshToken, cancellationToken);
            if (user == null) return false;
            await repo.RemoveRefreshTokenAsync(user.Username, refreshToken, cancellationToken);
            return true;
        }

        public async Task<bool> LogoutAllAsync(string refreshToken, CancellationToken cancellationToken)
        {
            var repo = _provider.GetService<ICosmosUserRepository>();
            if (repo == null) return false;
            var user = await repo.GetUserByRefreshTokenAsync(refreshToken, cancellationToken);
            if (user == null) return false;
            await repo.ClearAllRefreshTokensAsync(user.Username, cancellationToken);
            return true;
        }

        private (string refreshToken, DateTime expiresAt) GenerateRefreshToken()
        {
            var bytes = new byte[64];
            using var rng = RandomNumberGenerator.Create();
            rng.GetBytes(bytes);
            var refreshToken = Convert.ToBase64String(bytes);
            var expiresAt = DateTime.UtcNow.AddDays(_refreshTokenExpiresDays);
            return (refreshToken, expiresAt);
        }
    }
}