import { Code, ConnectError, type Interceptor } from "@connectrpc/connect";
import type { TokenProvider } from "./tokenProvider.js";

export interface AuthInterceptorOptions {
  /** Bearer-token source for EmbedJwt-gated RPCs (calls made from inside a plugin iframe). Omit for a
   * host-backend-only client that never presents an embed token - see AuthPolicy.Methods server-side. */
  tokenProvider?: TokenProvider;
  /** x-api-key value for HostApiKey/SuperAdminKey-gated RPCs (registry management, audit query,
   * entitlement admin - calls made from a host's own backend). Omit for a plugin-side client. */
  apiKey?: string;
  /** Sent as x-hoc-host on every call: the host an operator (super-admin) key acts for. Ignored by the
   * platform for a host's own API key. */
  onBehalfOfHost?: string;
}

/**
 * Injects `x-api-key` (if configured) and `Authorization: Bearer <token>` (if a tokenProvider is
 * configured) on every call. On an Unauthenticated response from a bearer-authenticated call,
 * refreshes the token once and retries - a rejected x-api-key is a bad key, not something a refresh
 * fixes, so that retry only ever applies to the bearer flow.
 *
 * Retry-on-refresh only applies to non-streaming requests: a client-stream request body (e.g.
 * TenantStorage.WriteFile) is single-consume, so it cannot be safely replayed after the caller has
 * already started sending chunks. Streaming callers are responsible for their own retry.
 */
export function authInterceptor(options: AuthInterceptorOptions): Interceptor {
  return (next) => async (req) => {
    if (options.apiKey) req.header.set("x-api-key", options.apiKey);
    if (options.onBehalfOfHost) req.header.set("x-hoc-host", options.onBehalfOfHost);
    if (!options.tokenProvider) return next(req);

    const tokenProvider = options.tokenProvider;
    const token = await tokenProvider.getToken();
    req.header.set("Authorization", `Bearer ${token}`);

    try {
      return await next(req);
    } catch (err) {
      if (req.stream || !(err instanceof ConnectError) || err.code !== Code.Unauthenticated) {
        throw err;
      }
      const fresh = await tokenProvider.refreshToken();
      req.header.set("Authorization", `Bearer ${fresh}`);
      return await next(req);
    }
  };
}
