using System.Net;
using System.Text.Json;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using QuizTool.Models;
using QuizTool.Repository;
using QuizTool.Utils;

namespace QuizTool;

public sealed class UsersController
{
    private readonly ICosmosUserRepository _userRepo;
    private readonly PasswordHasher _hasher;

    public UsersController(ICosmosUserRepository userRepo, PasswordHasher hasher)
    {
        _userRepo = userRepo;
        _hasher = hasher;
    }

    private record CreateUserRequest(string Username, string Password, string[]? Roles);

    [Function("CreateUser")]
    public async Task<HttpResponseData> CreateUser(
        [HttpTrigger(AuthorizationLevel.Admin, "post", Route = "users")]
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

        CreateUserRequest? payload;
        try
        {
            payload = JsonSerializer.Deserialize<CreateUserRequest>(body,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        }
        catch
        {
            payload = null;
        }

        if (payload is null || string.IsNullOrWhiteSpace(payload.Username) ||
            string.IsNullOrWhiteSpace(payload.Password))
        {
            var r = req.CreateResponse(HttpStatusCode.BadRequest);
            await r.WriteStringAsync("Invalid payload", cancellationToken);
            return r;
        }

        var existing = await _userRepo.GetUserByUsernameAsync(payload.Username, cancellationToken);
        if (existing != null)
        {
            var r = req.CreateResponse(HttpStatusCode.Conflict);
            await r.WriteStringAsync("User already exists", cancellationToken);
            return r;
        }

        var user = new QuizToolUser
        {
            Id = payload.Username,
            Username = payload.Username,
            PasswordHash = _hasher.Hash(payload.Password),
            Roles = payload.Roles ?? Array.Empty<string>(),
            CreatedAt = DateTime.UtcNow
        };

        await _userRepo.CreateUserAsync(user, cancellationToken);

        var resp = req.CreateResponse(HttpStatusCode.Created);
        resp.Headers.Add("Content-Type", "application/json");
        await resp.WriteStringAsync(JsonSerializer.Serialize(new { username = user.Username }), cancellationToken);
        return resp;
    }
}