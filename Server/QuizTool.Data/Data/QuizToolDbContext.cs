using Microsoft.EntityFrameworkCore;
using QuizTool.Models;

namespace QuizTool.Data;

/// <summary>
/// EF Core (Cosmos provider) context over the single Users container.
/// The mapping below deliberately reproduces the document shape the Cosmos SDK used to write
/// (camelCase property names, no discriminator, refresh tokens embedded as a JSON array),
/// so documents written before the EF Core migration keep round-tripping unchanged.
/// </summary>
public class QuizToolDbContext(DbContextOptions<QuizToolDbContext> options, CosmosSettings settings)
    : DbContext(options)
{
    public DbSet<QuizToolUser> Users => Set<QuizToolUser>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        var user = modelBuilder.Entity<QuizToolUser>();

        user.ToContainer(settings.ContainerName);
        user.HasNoDiscriminator();
        user.HasKey(u => u.Id);
        user.HasShadowId(false);
        user.HasPartitionKey(u => u.Username);
        user.UseETagConcurrency();

        user.Property(u => u.Id).ToJsonProperty("id");
        user.Property(u => u.Username).ToJsonProperty("username");
        user.Property(u => u.PasswordHash).ToJsonProperty("passwordHash");
        user.Property(u => u.Roles).ToJsonProperty("roles");
        user.Property(u => u.CreatedAt).ToJsonProperty("createdAt");
        user.Property(u => u.AiCallCountInRound).ToJsonProperty("aiCallCountInRound");
        user.Property(u => u.StartRoundTime).ToJsonProperty("startRoundTime");

        user.OwnsMany(u => u.RefreshTokens, token =>
        {
            token.ToJsonProperty("refreshTokens");
            token.Property(t => t.Token).ToJsonProperty("token");
            token.Property(t => t.ExpiresAt).ToJsonProperty("expiresAt");
            token.Property(t => t.CreatedAt).ToJsonProperty("createdAt");
        });
    }
}
