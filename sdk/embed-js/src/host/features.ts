/**
 * `HandOfClient.features.*`: the site's `hoc/api/*` (openapi/site-hoc-api.yaml) as typed calls with no UI.
 * The browser components in `components/` are built on this and nothing else, so a host that wants its
 * own screens gets exactly the same behaviour.
 */
import { resolveSitePrefix } from "./config.js";
import type { PageSnapshot } from "./snapshot.js";

export type RequestStatus = "InProgress" | "NeedsInfo" | "Rejected" | "Success";
export type FeatureKind = "slot" | "page-override" | "new-page";
export type RenderingMode = "inject" | "iframe";
export type SharePolicy = "owner" | "admins" | "nobody";

export interface SiteRequest {
  id: string;
  text: string;
  status: RequestStatus;
  message?: string | null;
  featureId?: string | null;
  userId: string;
  userName?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Feature {
  id: string;
  title: string;
  kind: FeatureKind;
  path?: string | null;
  slotId: string;
  mode: RenderingMode;
  packageId: string;
  currentVersion: string;
  pinnedVersion?: string | null;
  enabled: boolean;
  ownerUserId: string;
  requestId?: string | null;
  /** Present only for the owner and for admins. */
  sharing?: { everyone: boolean; userIds: string[] };
}

export interface FeatureVersion {
  version: string;
  publishedAt: string;
  requestId?: string | null;
  sha256: string;
}

export interface FeatureVersions {
  featureId: string;
  currentVersion: string;
  pinnedVersion?: string | null;
  versions: FeatureVersion[];
}

export interface DataSource {
  name: string;
  baseUrl: string;
  openapi?: Record<string, unknown>;
  auth?: { type: "bearer"; secret: string; /** write-only: stored on the platform, never returned */ secretValue?: string };
}

export interface Settings {
  renderingMode: RenderingMode;
  shareWithNamedUsers: SharePolicy;
  shareWithEveryone: SharePolicy;
  viewAllRequests: "admins" | "everyone";
  dataSources: DataSource[];
}

/** What `createRequest` sends: the contract's `PageSnapshot` (the capture's extra fields are dropped). */
export type RequestSnapshot = Pick<PageSnapshot, "html" | "url" | "path" | "title" | "redacted" | "capturedAt"> & {
  viewport?: { width: number; height: number };
};

export interface RequestPage {
  requests: SiteRequest[];
  nextCursor: string | null;
}

export interface ListRequestsOptions {
  scope?: "mine" | "all";
  status?: RequestStatus[];
  limit?: number;
  cursor?: string;
}

export type FeaturesApiErrorCode =
  | "unauthenticated" | "forbidden" | "sharing_not_allowed" | "not_found" | "version_not_found"
  | "invalid_request" | "payload_too_large" | "not_awaiting_reply" | "version_unavailable" | "platform_unavailable"
  /** Not from the site: the request never got an answer (offline, blocked, aborted). */
  | "network_error"
  /** Not from the site: it answered with something that is not the documented error shape. */
  | "unexpected_response";

export class FeaturesApiError extends Error {
  constructor(public readonly code: FeaturesApiErrorCode, message: string, public readonly status: number) {
    super(message);
    this.name = "FeaturesApiError";
  }
}

export interface FeaturesApiOptions {
  /** Site mount prefix; default: the configured `sitePrefix`, else "hoc/". Absolute URLs work too. */
  sitePrefix?: string;
  /** Replaces global fetch, e.g. to add the site's CSRF header to every non-GET call. */
  fetch?: typeof fetch;
}

export interface FeaturesApi {
  createRequest(body: { text: string; snapshot?: RequestSnapshot; featureId?: string }): Promise<SiteRequest>;
  listRequests(options?: ListRequestsOptions): Promise<RequestPage>;
  replyToRequest(requestId: string, text: string): Promise<SiteRequest>;
  listFeatures(): Promise<Feature[]>;
  listFeatureVersions(featureId: string): Promise<FeatureVersions>;
  /** `null` follows the feature's current version again. */
  pinFeatureVersion(featureId: string, version: string | null): Promise<Feature>;
  /** Roll back (or forward) for everyone who has not pinned. Owner or admin. */
  setFeatureCurrentVersion(featureId: string, version: string): Promise<Feature>;
  shareFeature(featureId: string, target: { userIds: string[] } | { everyone: true }): Promise<Feature>;
  unshareFeature(featureId: string, target: string | "everyone"): Promise<Feature>;
  setFeatureEnabled(featureId: string, enabled: boolean): Promise<Feature>;
  findUsers(query: string, limit?: number): Promise<Array<{ id: string; name?: string | null }>>;
  getSettings(): Promise<Settings>;
  putSettings(settings: Settings): Promise<Settings>;
}

export function createFeaturesApi(options: FeaturesApiOptions = {}): FeaturesApi {
  const prefix = (): string => {
    const raw = options.sitePrefix ?? resolveSitePrefix();
    return raw.endsWith("/") ? raw : `${raw}/`;
  };
  const doFetch = (): typeof fetch => options.fetch ?? ((input, init) => fetch(input, init));

  async function call<T>(method: string, path: string, query?: URLSearchParams, body?: unknown): Promise<T> {
    const base = typeof document !== "undefined" ? document.baseURI : undefined;
    const url = new URL(`${prefix()}api/${path}`, base);
    if (query) url.search = query.toString();
    let response: Response;
    try {
      response = await doFetch()(url.toString(), {
        method,
        credentials: "same-origin",
        headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      console.warn("HandOfClient: request to the site failed", cause);
      throw new FeaturesApiError("network_error", "Could not reach the site. Check your connection and try again.", 0);
    }
    if (response.ok) {
      try {
        return (await response.json()) as T;
      } catch (cause) {
        console.warn("HandOfClient: unreadable answer from the site", cause);
        throw new FeaturesApiError("unexpected_response", "The site sent an answer that could not be read.", response.status);
      }
    }
    let error: { error?: string; message?: string } | undefined;
    try {
      error = (await response.json()) as { error?: string; message?: string };
    } catch (cause) {
      console.warn("HandOfClient: error answer was not JSON", cause); // falls through to unexpected_response
    }
    if (error?.error && typeof error.message === "string") {
      throw new FeaturesApiError(error.error as FeaturesApiErrorCode, error.message, response.status);
    }
    throw new FeaturesApiError("unexpected_response", `The site answered ${response.status}.`, response.status);
  }

  const id = encodeURIComponent;
  return {
    createRequest: (body) => call("POST", "requests", undefined, body),
    listRequests(o = {}) {
      const q = new URLSearchParams();
      if (o.scope) q.set("scope", o.scope);
      for (const s of o.status ?? []) q.append("status", s);
      if (o.limit) q.set("limit", String(o.limit));
      if (o.cursor) q.set("cursor", o.cursor);
      return call<{ requests: SiteRequest[]; nextCursor?: string | null }>("GET", "requests", q).then((r) => ({
        requests: r.requests,
        nextCursor: r.nextCursor ?? null,
      }));
    },
    replyToRequest: (requestId, text) => call("POST", `requests/${id(requestId)}/reply`, undefined, { text }),
    listFeatures: () => call<{ features: Feature[] }>("GET", "features").then((r) => r.features),
    listFeatureVersions: (featureId) => call("GET", `features/${id(featureId)}/versions`),
    pinFeatureVersion: (featureId, version) => call("POST", `features/${id(featureId)}/pin`, undefined, { version }),
    setFeatureCurrentVersion: (featureId, version) => call("POST", `features/${id(featureId)}/current`, undefined, { version }),
    shareFeature: (featureId, target) => call("POST", `features/${id(featureId)}/share`, undefined, target),
    unshareFeature: (featureId, target) => call("DELETE", `features/${id(featureId)}/share/${id(target)}`),
    setFeatureEnabled: (featureId, enabled) => call("POST", `features/${id(featureId)}/enabled`, undefined, { enabled }),
    findUsers: (query, limit) => {
      const q = new URLSearchParams({ query });
      if (limit) q.set("limit", String(limit));
      return call<{ users: Array<{ id: string; name?: string | null }> }>("GET", "users", q).then((r) => r.users);
    },
    getSettings: () => call("GET", "settings"),
    putSettings: (settings) => call("PUT", "settings", undefined, settings),
  };
}

/** The default instance behind `HandOfClient.features`: reads the configured `sitePrefix` on every call. */
export const features: FeaturesApi = createFeaturesApi();
