import type { TokenProvider } from "@handofclient/api";
import { PostMessageChannel } from "../channel.js";
import { MessageType, type TokenRefreshReplyPayload } from "../protocol.js";

const PROACTIVE_REFRESH_FRACTION = 0.8;

/**
 * Implements @handofclient/api's TokenProvider by round-tripping hoc:token-refresh through the host
 * page - see docs/postmessage-protocol.md section 5.7. Two independent triggers land on the same
 * request: reactively, when the generated client's authInterceptor gets an Unauthenticated response
 * (refreshToken()), and proactively, on a timer here at 80% of the token's remaining TTL, so a
 * long-lived plugin session refreshes ahead of expiry instead of always paying a failed-call round
 * trip first.
 */
export class HostRelayTokenProvider implements TokenProvider {
  private token: string;
  private expiresAt: Date;
  private refreshPromise: Promise<string> | null = null;
  private proactiveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly channel: PostMessageChannel,
    initialToken: string,
    initialExpiresAt: string,
  ) {
    this.token = initialToken;
    this.expiresAt = new Date(initialExpiresAt);
    this.scheduleProactiveRefresh();
  }

  async getToken(): Promise<string> {
    return this.token;
  }

  async refreshToken(): Promise<string> {
    // Coalesce concurrent refresh calls (e.g. several in-flight requests all hitting 401 at once) into
    // one hoc:token-refresh round trip rather than racing multiple requests to the host.
    if (!this.refreshPromise) {
      this.refreshPromise = this.doRefresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  dispose(): void {
    if (this.proactiveTimer !== null) clearTimeout(this.proactiveTimer);
  }

  private async doRefresh(): Promise<string> {
    const reply = await this.channel.request<Record<string, never>, TokenRefreshReplyPayload>(MessageType.TokenRefresh, {});
    if ("error" in reply) {
      throw new Error(reply.error);
    }
    this.token = reply.token;
    this.expiresAt = new Date(reply.expiresAt);
    this.scheduleProactiveRefresh();
    return this.token;
  }

  private scheduleProactiveRefresh(): void {
    if (this.proactiveTimer !== null) clearTimeout(this.proactiveTimer);
    const remainingMs = this.expiresAt.getTime() - Date.now();
    const delayMs = Math.max(remainingMs * PROACTIVE_REFRESH_FRACTION, 0);
    this.proactiveTimer = setTimeout(() => {
      this.refreshToken().catch(() => {
        // A proactive refresh failure is not fatal here - the reactive path (authInterceptor retrying
        // on Unauthenticated) is still there as a fallback for the next real API call.
      });
    }, delayMs);
  }
}
