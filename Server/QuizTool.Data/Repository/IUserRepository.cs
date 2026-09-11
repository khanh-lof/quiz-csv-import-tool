using QuizTool.Models;

namespace QuizTool.Repository;

public interface IUserRepository
{
    Task<QuizToolUser?> GetUserByUsernameAsync(string username, CancellationToken cancellationToken);
    Task CreateUserAsync(QuizToolUser quizToolUser, CancellationToken cancellationToken);
    Task<(bool Valid, string[] Roles)> ValidateCredentialsAsync(string username, string password,
        CancellationToken cancellationToken);

    // Refresh-token related operations
    Task AddRefreshTokenAsync(string username, string refreshToken, DateTime expiresAt, CancellationToken cancellationToken);
    Task RotateRefreshTokenAsync(string username, string oldRefreshToken, string newRefreshToken, DateTime newExpiresAt, CancellationToken cancellationToken);
    Task RemoveRefreshTokenAsync(string username, string refreshToken, CancellationToken cancellationToken);
    Task ClearAllRefreshTokensAsync(string username, CancellationToken cancellationToken);
    Task<QuizToolUser?> GetUserByRefreshTokenAsync(string refreshToken, CancellationToken cancellationToken);
    Task StartRoundAsync(QuizToolUser user, CancellationToken cancellationToken);
    Task IncreaseAiCallCountInRound(QuizToolUser user, CancellationToken cancellationToken);
}
