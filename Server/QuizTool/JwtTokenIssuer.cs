using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.IdentityModel.Tokens;

namespace QuizTool;

public static class JwtTokenIssuer
{
    public static string CreateToken(string username, string[] roles, int expiresMinutes)
    {
        var secret = Environment.GetEnvironmentVariable("JWT_SECRET");
        var issuer = Environment.GetEnvironmentVariable("JWT_ISSUER");
        var audience = Environment.GetEnvironmentVariable("JWT_AUDIENCE");

        if (string.IsNullOrWhiteSpace(secret))
            throw new InvalidOperationException("JWT_SECRET is not configured.");

        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(secret));
        var creds = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);

        var claims = new List<Claim> { new(ClaimTypes.Name, username) };
        claims.AddRange(roles.Select(r => new Claim(ClaimTypes.Role, r)));
        var token = new JwtSecurityToken(
            string.IsNullOrWhiteSpace(issuer) ? null : issuer,
            string.IsNullOrWhiteSpace(audience) ? null : audience,
            claims,
            DateTime.UtcNow,
            DateTime.UtcNow.AddMinutes(expiresMinutes),
            creds
        );

        return new JwtSecurityTokenHandler().WriteToken(token);
    }
}