using Microsoft.Azure.Cosmos;
using Microsoft.Azure.Cosmos.Fluent;
using Microsoft.Azure.Functions.Worker.Builder;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using QuizTool.Repository;
using QuizTool.Services;
using QuizTool.Utils;

var builder = FunctionsApplication.CreateBuilder(args);

// Configure Cosmos DB client if env vars are present
var cosmosEndpoint = Environment.GetEnvironmentVariable("COSMOS_ENDPOINT");
var cosmosKey = Environment.GetEnvironmentVariable("COSMOS_KEY");
if (!string.IsNullOrWhiteSpace(cosmosEndpoint) && !string.IsNullOrWhiteSpace(cosmosKey))
{
    var cosmosClient = new CosmosClientBuilder(cosmosEndpoint, cosmosKey)
        .WithSerializerOptions(new CosmosSerializationOptions
        {
            PropertyNamingPolicy = CosmosPropertyNamingPolicy.CamelCase
        })
        .Build();
    builder.Services.AddSingleton(cosmosClient);
    // Register user repository and hasher
    builder.Services.AddSingleton<PasswordHasher>();
    builder.Services.AddSingleton<ICosmosUserRepository, CosmosUserRepository>();
}

// Register authentication service (uses Cosmos repo if available, otherwise falls back to env-based auth)
builder.Services.AddSingleton<IAuthenticationService, AuthenticationService>();

builder.ConfigureFunctionsWebApplication();

builder.Build().Run();