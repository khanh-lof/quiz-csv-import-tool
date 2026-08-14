using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.IdentityModel.Tokens;

namespace QuizTool;

public static class JwtAuth
{
    public static ClaimsPrincipal ValidateToken(string token)
    {
        var secret = Environment.GetEnvironmentVariable("JWT_SECRET");
        var issuer = Environment.GetEnvironmentVariable("JWT_ISSUER");
        var audience = Environment.GetEnvironmentVariable("JWT_AUDIENCE");

        if (string.IsNullOrWhiteSpace(secret))
            throw new InvalidOperationException("JWT_SECRET is not configured.");

        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(secret));
        var tokenHandler = new JwtSecurityTokenHandler();

        var parameters = new TokenValidationParameters
        {
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = key,
            ValidateIssuer = !string.IsNullOrWhiteSpace(issuer),
            ValidIssuer = issuer,
            ValidateAudience = !string.IsNullOrWhiteSpace(audience),
            ValidAudience = audience,
            ValidateLifetime = true,
            ClockSkew = TimeSpan.FromMinutes(2)
        };

        var principal = tokenHandler.ValidateToken(token, parameters, out var validatedToken);
        return principal;
    }

    public static bool HasAnyRole(ClaimsPrincipal? principal, params string[] roles)
    {
        if (principal is null) return false;
        var claimValues = principal.Claims
            .Where(c => c.Type == ClaimTypes.Role || string.Equals(c.Type, "role", StringComparison.OrdinalIgnoreCase))
            .Select(c => c.Value);

        return claimValues.Any(cv => roles.Any(r => string.Equals(r, cv, StringComparison.OrdinalIgnoreCase)));
    }
}