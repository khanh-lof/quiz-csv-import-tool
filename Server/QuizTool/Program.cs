using Microsoft.Azure.Functions.Worker.Builder;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using QuizTool.Data;
using QuizTool.Services;

var builder = FunctionsApplication.CreateBuilder(args);

// Registers the EF Core Cosmos data layer (repository + password hasher) when the Cosmos
// environment variables are present; a no-op otherwise.
builder.Services.AddQuizToolData();

// Register authentication service (uses the user repository if available, otherwise falls back to env-based auth)
builder.Services.AddSingleton<IAuthenticationService, AuthenticationService>();
builder.Services.AddSingleton<ISimpleWordQuestionService, SimpleWordQuestionService>();
builder.Services.AddSingleton<ICreativeRequestService, CreativeRequestService>();

builder.ConfigureFunctionsWebApplication();

builder.Build().Run();
