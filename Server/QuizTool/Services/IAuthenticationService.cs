namespace QuizTool.Services
{
    public interface IAuthenticationService
    {
        /// <summary>
        /// Authenticate a user by username/password. Returns (Valid, Roles, Token, RefreshToken).
        /// Token is null when Valid is false.
        /// RefreshToken will be returned when authentication succeeds.
        /// </summary>
        Task<(bool Valid, string[] Roles, string? Token, string? RefreshToken)> AuthenticateAsync(string username,
            string password, CancellationToken cancellationToken);

        /// <summary>
        /// Use a refresh token to obtain a new access token. Returns new access token and (rotated) refresh token.
        /// </summary>
        Task<(bool Valid, string[] Roles, string? Token, string? RefreshToken)> RefreshTokenAsync(string refreshToken, CancellationToken cancellationToken);

        /// <summary>
        /// Revoke the given refresh token (logout of a single device/session). Returns whether a matching user was found.
        /// </summary>
        Task<bool> LogoutAsync(string refreshToken, CancellationToken cancellationToken);

        /// <summary>
        /// Revoke all refresh tokens for the user owning the given refresh token (logout of all devices/sessions).
        /// </summary>
        Task<bool> LogoutAllAsync(string refreshToken, CancellationToken cancellationToken);
    }
}