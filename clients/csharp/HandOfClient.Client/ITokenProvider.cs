namespace HandOfClient.Client;

/// <summary>
/// Supplies the bearer token for every Platform API call. A host's own
/// backend mints tokens directly via TokenService.IssueEmbedToken using its
/// host API key; inside an embed iframe the token is refreshed through the host page
/// (see docs/postmessage-protocol.md).
/// </summary>
public interface ITokenProvider
{
    /// <summary>Returns the current token, refreshing first if expired or missing.</summary>
    Task<string> GetTokenAsync(CancellationToken cancellationToken = default);

    /// <summary>
    /// Called when the server rejects the current token as
    /// Unauthenticated. Implementations fetch a fresh token; the call that
    /// triggered this is retried once with the new token.
    /// </summary>
    Task<string> RefreshTokenAsync(CancellationToken cancellationToken = default);
}

/// <summary>An <see cref="ITokenProvider"/> that always returns a fixed token and never refreshes.</summary>
public sealed class StaticTokenProvider(string token) : ITokenProvider
{
    public Task<string> GetTokenAsync(CancellationToken cancellationToken = default) => Task.FromResult(token);
    public Task<string> RefreshTokenAsync(CancellationToken cancellationToken = default) => Task.FromResult(token);
}
