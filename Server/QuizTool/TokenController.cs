using System.Net;
using System.Text.Json;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Net.Http.Headers;
using QuizTool.Services;

namespace QuizTool;

public sealed class TokenController
{
    private readonly IAuthenticationService _authService;

    public TokenController(IAuthenticationService authService)
    {
        _authService = authService;
    }

    private record LoginRequest(string Username, string Password);

    [Function("IssueToken")]
    public async Task<HttpResponseData> IssueTokenAsync(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "auth/login")]
        HttpRequestData req,
        FunctionContext context,
        CancellationToken cancellationToken)
    {
        string body;
        using (var sr = new StreamReader(req.Body))
        {
            body = await sr.ReadToEndAsync(cancellationToken);
        }

        if (string.IsNullOrWhiteSpace(body))
        {
            var r = req.CreateResponse(HttpStatusCode.BadRequest);
            await r.WriteStringAsync("Missing body", cancellationToken);
            return r;
        }

        LoginRequest? login;
        try
        {
            login = JsonSerializer.Deserialize<LoginRequest>(body,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        }
        catch
        {
            login = null;
        }

        if (login is null || string.IsNullOrWhiteSpace(login.Username) || string.IsNullOrWhiteSpace(login.Password))
        {
            var r = req.CreateResponse(HttpStatusCode.BadRequest);
            await r.WriteStringAsync("Invalid payload", cancellationToken);
            return r;
        }
        
        var (valid, roles, token, refreshToken) = await _authService.AuthenticateAsync(login.Username, login.Password, cancellationToken);
        if (valid && token is not null)
        {
            var resp = req.CreateResponse(HttpStatusCode.OK);
            resp.Headers.Add("Content-Type", "application/json");

            // Set refresh token cookie: HttpOnly; Secure; SameSite=Strict;
            if (!string.IsNullOrEmpty(refreshToken))
            {
                SetRefreshTokenCookie(refreshToken, resp);
            }

            var payload = JsonSerializer.Serialize(new { accessToken = token });
            await resp.WriteStringAsync(payload, cancellationToken);
            return resp;
        }

        var respUnauthorized = req.CreateResponse(HttpStatusCode.Unauthorized);
        await respUnauthorized.WriteStringAsync("Invalid credentials", cancellationToken);
        return respUnauthorized;
    }

    [Function("Refresh")]
    public async Task<HttpResponseData> RefreshTokenAsync(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "auth/refresh")]
        HttpRequestData req,
        FunctionContext context,
        CancellationToken cancellationToken)
    {
        var refreshToken = ExtractRefreshTokenFromCookie(req);

        if (string.IsNullOrEmpty(refreshToken))
        {
            var r = req.CreateResponse(HttpStatusCode.Unauthorized);
            await r.WriteStringAsync("Missing refresh token", cancellationToken);
            return r;
        }

        var (valid, roles, token, newRefresh) = await _authService.RefreshTokenAsync(refreshToken, cancellationToken);
        if (valid && token is not null)
        {
            var resp = req.CreateResponse(HttpStatusCode.OK);
            resp.Headers.Add("Content-Type", "application/json");
            if (!string.IsNullOrEmpty(newRefresh))
            {
                SetRefreshTokenCookie(newRefresh, resp);
            }
            var payload = JsonSerializer.Serialize(new { accessToken = token });
            await resp.WriteStringAsync(payload, cancellationToken);
            return resp;
        }

        var respUnauthorized = req.CreateResponse(HttpStatusCode.Unauthorized);
        await respUnauthorized.WriteStringAsync("Invalid refresh token", cancellationToken);
        return respUnauthorized;
    }

    [Function("Logout")]
    public async Task<HttpResponseData> LogoutAsync(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "auth/logout")]
        HttpRequestData req,
        FunctionContext context,
        CancellationToken cancellationToken)
    {
        var refreshToken = ExtractRefreshTokenFromCookie(req);
        if (!string.IsNullOrEmpty(refreshToken))
        {
            await _authService.LogoutAsync(refreshToken, cancellationToken);
        }

        var resp = req.CreateResponse(HttpStatusCode.OK);
        ClearRefreshTokenCookie(resp);
        return resp;
    }

    [Function("LogoutAll")]
    public async Task<HttpResponseData> LogoutAllAsync(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "auth/logout-all")]
        HttpRequestData req,
        FunctionContext context,
        CancellationToken cancellationToken)
    {
        var refreshToken = ExtractRefreshTokenFromCookie(req);
        var logouted = false;
        if (!string.IsNullOrEmpty(refreshToken))
        {
            logouted = await _authService.LogoutAllAsync(refreshToken, cancellationToken);
        }
        
        var resp = logouted ? req.CreateResponse(HttpStatusCode.OK) : req.CreateResponse(HttpStatusCode.BadRequest);
        if (logouted)
        {
            ClearRefreshTokenCookie(resp);
        }
        return resp;
    }

    private static string? ExtractRefreshTokenFromCookie(HttpRequestData req)
    {
        if (!req.Headers.TryGetValues("Cookie", out var cookieHeaders)) return null;

        foreach (var cookie in CookieHeaderValue.ParseList(cookieHeaders.ToList()))
        {
            if (cookie.Name == "refreshToken")
            {
                return Uri.UnescapeDataString(cookie.Value.ToString());
            }
        }

        return null;
    }

    private static void SetRefreshTokenCookie(string refreshToken, HttpResponseData resp)
    {
        var refreshTokenExpiresDays =
            int.Parse(Environment.GetEnvironmentVariable("JWT_REFRESH_TOKEN_EXPIRES_DAYS") ?? "30");
        var maxAgeTotalSeconds = TimeSpan.FromDays(refreshTokenExpiresDays).TotalSeconds;
        var cookieValue =
            $"refreshToken={Uri.EscapeDataString(refreshToken)}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age={maxAgeTotalSeconds}";
        resp.Headers.Add("Set-Cookie", cookieValue);
    }

    private static void ClearRefreshTokenCookie(HttpResponseData resp)
    {
        resp.Headers.Add("Set-Cookie", "refreshToken=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0");
    }
}