/**
 * Client for the platform calls a site makes (`/host/v1`, authenticated with the host API key).
 * Uses the global `fetch` (Node 18+), so the package has no dependencies. Replace it by passing any object
 * with the same methods ({@link PlatformApi}) to `HostModule` (the tests do).
 */
import { defaultLogger, describeError, type Logger } from "./logger.js";

/** `status` is 0 when the platform could not be reached at all. */
export interface PlatformResult {
  status: number;
  body: any;
  ok: boolean;
}

export interface PlatformApi {
  startBuild(
    requestRef: string,
    user: Record<string, unknown>,
    text: string,
    mode: string,
    snapshot?: unknown,
    feature?: { ref: string; packageId: string } | null,
  ): Promise<PlatformResult>;
  replyToBuild(buildId: string, text: string): Promise<PlatformResult>;
  embedToken(userId: string, packageId: string, slotId: string, version: string | null): Promise<PlatformResult>;
  putSecret(name: string, value: string, updatedBy: string): Promise<PlatformResult>;
  putDataSources(dataSources: unknown[]): Promise<PlatformResult>;
}

export interface PlatformClientOptions {
  /** Platform API origin, e.g. `https://api.example.com`. */
  baseUrl: string;
  /** Your host API key (server side only). */
  apiKey: string;
  tenantId: string;
  /** Per-call timeout in milliseconds (default 10000). */
  timeoutMs?: number;
  logger?: Logger;
}

export class PlatformClient implements PlatformApi {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly tenantId: string;
  private readonly timeoutMs: number;
  private readonly log: Logger;

  constructor(opts: PlatformClientOptions) {
    if (!opts?.baseUrl || !opts.apiKey || !opts.tenantId) throw new Error("PlatformClient needs baseUrl, apiKey and tenantId");
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.tenantId = opts.tenantId;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.log = opts.logger ?? defaultLogger;
  }

  private async call(method: string, path: string, body?: unknown): Promise<PlatformResult> {
    let status: number;
    let raw: string;
    try {
      const res = await fetch(this.baseUrl + path, {
        method,
        headers: { "x-api-key": this.apiKey, "content-type": "application/json", accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      status = res.status;
      raw = await res.text();
    } catch (e) {
      this.log.error(`platform call ${method} ${path} failed\n${describeError(e)}`); // connection refused, DNS, timeout...
      return { status: 0, body: null, ok: false };
    }
    let parsed: any = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null; // a non-JSON error page from a proxy; the status is what matters
    }
    if (status >= 400) this.log.warn(`platform call ${method} ${path} answered ${status}`);
    return { status, body: parsed, ok: status >= 200 && status < 300 };
  }

  startBuild(
    requestRef: string,
    user: Record<string, unknown>,
    text: string,
    mode: string,
    snapshot?: unknown,
    feature?: { ref: string; packageId: string } | null,
  ) {
    const body: Record<string, unknown> = { tenantId: this.tenantId, requestRef, user, text, mode };
    if (snapshot) body.snapshot = snapshot;
    if (feature) body.feature = feature;
    return this.call("POST", "/host/v1/builds", body);
  }

  replyToBuild(buildId: string, text: string) {
    return this.call("POST", `/host/v1/builds/${encodeURIComponent(buildId)}/reply`, { text });
  }

  embedToken(userId: string, packageId: string, slotId: string, version: string | null) {
    const body: Record<string, unknown> = { tenantId: this.tenantId, userId, packageId, slotId };
    if (version !== null) body.version = version;
    return this.call("POST", "/host/v1/embed-token", body);
  }

  putSecret(name: string, value: string, updatedBy: string) {
    return this.call("PUT", "/host/v1/secrets", { tenantId: this.tenantId, name, value, updatedBy });
  }

  putDataSources(dataSources: unknown[]) {
    return this.call("PUT", "/host/v1/data-sources", { tenantId: this.tenantId, dataSources });
  }
}
