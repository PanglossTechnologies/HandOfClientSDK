import { HocMountError } from "./errors.js";

/** Contract for a host's own tokenUrl backend endpoint - see docs/postmessage-protocol.md section 4
 * step 1. The host mints this by calling TokenService.IssueEmbedToken server-to-server; embed.js only
 * ever talks to the host's own endpoint over same-origin fetch, never to the Platform API directly for
 * token issuance. */
export interface TokenEndpointResponse {
  token: string;
  expiresAt: string;
  userId: string;
  displayName?: string;
}

/** `tokenUrl` with `featureId` added as a query parameter (openapi/site-hoc-api.yaml `GET hoc/token`).
 * Without a featureId the URL is returned untouched, which keeps the original single-plugin
 * integration working. */
export function tokenUrlFor(tokenUrl: string, featureId?: string): string {
  if (!featureId) return tokenUrl;
  const url = new URL(tokenUrl, document.baseURI);
  url.searchParams.set("featureId", featureId);
  return url.toString();
}

export async function fetchEmbedToken(url: string): Promise<TokenEndpointResponse> {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`tokenUrl responded ${response.status}`);
  return (await response.json()) as TokenEndpointResponse;
}

export async function fetchEmbedTokenOrThrow(url: string): Promise<TokenEndpointResponse> {
  try {
    return await fetchEmbedToken(url);
  } catch (cause) {
    throw new HocMountError("token-fetch-failed", `Failed to fetch embed token: ${(cause as Error).message}`);
  }
}

export interface EmbedClaims {
  hostId?: string;
  tenantId?: string;
  packageId?: string;
  version?: string;
  slotId?: string;
}

/** Reads the platform-set claims (`hid`, `tid`, `pkg`, `ver`, `slot`; openapi/platform-host-v1.yaml) from
 * an embed JWT WITHOUT verifying it. Used only to fill the plugin's display context; the platform
 * re-verifies the token on every API call, so a forged value gains nothing. */
export function readEmbedClaims(token: string): EmbedClaims {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)));
    const claims = JSON.parse(json) as Record<string, string | undefined>;
    return { hostId: claims.hid, tenantId: claims.tid, packageId: claims.pkg, version: claims.ver, slotId: claims.slot };
  } catch (cause) {
    console.warn("HandOfClient: could not read embed token claims", cause);
    return {};
  }
}
