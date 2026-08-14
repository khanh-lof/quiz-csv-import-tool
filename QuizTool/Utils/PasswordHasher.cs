using System.Security.Cryptography;

namespace QuizTool.Utils;

public class PasswordHasher
{
    private const int Iterations = 100_000;
    private const int SaltSize = 16;
    private const int KeySize = 32;

    public string Hash(string password)
    {
        using var rng = RandomNumberGenerator.Create();
        var salt = new byte[SaltSize];
        rng.GetBytes(salt);
        // Use static Pbkdf2 to avoid SYSLIB0060
        var key = Rfc2898DeriveBytes.Pbkdf2(password, salt, Iterations, HashAlgorithmName.SHA256, KeySize);
        return $"{Iterations}.{Convert.ToBase64String(salt)}.{Convert.ToBase64String(key)}";
    }

    public bool Verify(string password, string hashed)
    {
        try
        {
            var parts = hashed.Split('.');
            if (parts.Length != 3) return false;
            var iterations = int.Parse(parts[0]);
            var salt = Convert.FromBase64String(parts[1]);
            var key = Convert.FromBase64String(parts[2]);
            var keyToCheck =
                Rfc2898DeriveBytes.Pbkdf2(password, salt, iterations, HashAlgorithmName.SHA256, key.Length);
            return CryptographicOperations.FixedTimeEquals(key, keyToCheck);
        }
        catch
        {
            return false;
        }
    }
}