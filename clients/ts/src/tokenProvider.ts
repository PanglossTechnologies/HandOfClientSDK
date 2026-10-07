/**
 * Supplies the bearer token for every Platform API call and refreshes it
 * when the platform reports it as expired/expiring. Two independent
 * implementations exist because the token lifecycle differs by caller:
 *
 * - Inside the embed iframe (plugin-side SDK, C3), refresh must transit the
 *   host page via hoc:token-refresh - see design doc "2. postMessage Embed
 *   Protocol + JS SDK". A dead host session should kill plugin API access.
 * - A host's own backend (samples/hosts/*) mints tokens directly via
 *   TokenService.IssueEmbedToken using its host API key and has no need to
 *   "refresh" the same way - it just issues a new one.
 *
 * This package only defines the interface; both call sites provide their
 * own implementation.
 */
export interface TokenProvider {
  /** Returns the current token, refreshing first if it is expired or missing. */
  getToken(): Promise<string>;
  /**
   * Called when the server rejects the current token as expired/invalid.
   * Implementations should fetch a fresh token and return it; the request
   * that triggered this is retried once with the new token.
   */
  refreshToken(): Promise<string>;
}

/** A TokenProvider that always returns a fixed token and never refreshes. */
export function staticTokenProvider(token: string): TokenProvider {
  return {
    getToken: () => Promise.resolve(token),
    refreshToken: () => Promise.resolve(token),
  };
}
