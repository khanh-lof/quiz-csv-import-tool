namespace QuizTool.Models;

public class RefreshTokenEntry
{
    public required string Token { get; set; }
    public required DateTime ExpiresAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class QuizToolUser
{
    // Cosmos DB requires an "id" property
    public required string Id { get; set; }
    public required string Username { get; set; }
    public required string PasswordHash { get; set; }
    public string[] Roles { get; set; } = Array.Empty<string>();
    public required DateTime CreatedAt { get; set; }

    // Refresh token support: one entry per active device/session
    public List<RefreshTokenEntry> RefreshTokens { get; set; } = new();

    public int AiCallCountInRound { get; set; }

    public DateTime? StartRoundTime { get; set; }
}