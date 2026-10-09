/**
 * The host module proper: every `hoc/token`, `hoc/api/*` and `hoc/webhook` call, independent of web framework.
 *
 * Adapters (`@handofclient/host/express`, `@handofclient/host/fastify`) translate their framework's request into
 * {@link HostModule.handle} and its {@link HocResponse} back. Contract: `openapi/site-hoc-api.yaml`.
 */
import { randomBytes } from "node:crypto";
import { HocError, forbidden, invalid, notFound, platformUnavailable, unauthenticated } from "./errors.js";
import { defaultLogger, describeError, type Logger } from "./logger.js";
import type { PlatformApi } from "./platformClient.js";
import type { Assignment, FeatureRec, RequestRec, Storage, StorageTx, UserState } from "./storage/base.js";
import { nowIso } from "./timeutil.js";
import { toUser, type HocUser } from "./users.js";
import { SIGNATURE_HEADER, isStale, verifySignature } from "./webhook.js";

export const POLICIES = ["owner", "admins", "nobody"] as const;
export const STATUSES = ["InProgress", "NeedsInfo", "Rejected", "Success"] as const;
export const KINDS = ["slot", "page-override", "new-page"] as const;
export const MODES = ["inject", "iframe"] as const;
export const TEXT_MAX = 20000;
export const SNAPSHOT_MAX = 2 * 1024 * 1024;
export const DEFAULT_SETTINGS = {
  renderingMode: "inject",
  shareWithNamedUsers: "owner",
  shareWithEveryone: "admins",
  viewAllRequests: "admins",
  dataSources: [] as unknown[],
};
const SECRET_NAME = /^[a-z0-9_-]{1,64}$/;
/** Seconds before each retry of a build the platform could not take at submit time. */
export const BUILD_RETRY_DELAYS = [1, 2, 5, 15, 60, 300];

/** Sent with every response: JSON, and never cached (answers depend on the signed-in user). */
export const RESPONSE_HEADERS: Readonly<Record<string, string>> = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export interface HocResponse {
  status: number;
  payload?: unknown;
}

/** The JSON bytes of a response (empty when there is no payload). */
export function responseBody(res: HocResponse): Buffer {
  return res.payload === undefined || res.payload === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(res.payload), "utf8");
}

export interface HocRequest {
  method: string;
  /** Relative to the mount prefix and already percent-decoded, e.g. `api/features/abc/pin`. */
  path: string;
  /** Parsed query string: name -> list of values. */
  query?: Record<string, string[]>;
  /** Request headers with lower-case names (only the webhook signature is read). */
  headers?: Record<string, string | string[] | undefined>;
  /** The raw request body bytes. */
  body?: Uint8Array;
  /** Handed to `getCurrentUser`: the web framework's own request object. */
  request?: unknown;
}

export interface HostModuleOptions {
  /** Where requests, features, versions and settings live, e.g. `SqlStorage.sqlite("hoc.db")`. */
  storage: Storage;
  /** The platform client for your tenant (`new PlatformClient({...})`). */
  platform: PlatformApi;
  /** The host's webhook secret; verifies `hoc/webhook`. */
  webhookSecret: string;
  /**
   * `(request) => user | null`. `user` is an object with `id` and optionally `name` / `email`; null means signed
   * out. `request` is the web framework's own request object. May be async. The ONLY source of identity.
   */
  getCurrentUser: (request: any) => unknown | Promise<unknown>;
  /** `(user) => boolean`, given what `getCurrentUser` returned. May be async. */
  isAdmin: (user: any) => boolean | Promise<boolean>;
  /** `(query) => [{ id, name? }]`; backs the share picker. May be async. */
  findUsers: (query: string) => Iterable<any> | null | undefined | Promise<Iterable<any> | null | undefined>;
  /** Rejects unknown ids when sharing. Without it the module asks `findUsers` for the id and wants an exact match. */
  userExists?: (userId: string) => boolean | Promise<boolean>;
  /** Only for `GET token` without `featureId` (the original single-plugin endpoint): the package and slot to mint for. */
  legacyPackageId?: string;
  legacySlotId?: string;
  /** Run `storage.migrate()` once, on first use (default true). */
  autoMigrate?: boolean;
  /** Retry (with timers) builds the platform could not take at submit time (default true). */
  retryBuilds?: boolean;
  /** Receives per-call info and errors; default logs only warnings and errors to the console. */
  logger?: Logger;
}

interface Call {
  user: HocUser;
  query: Record<string, string[]>;
  body: unknown;
  params: string[];
  admin?: boolean;
}

interface Loaded {
  feature: FeatureRec;
  assignments: Assignment[];
  state: UserState;
}

type Handler = (c: Call) => Promise<HocResponse>;
type Route = { method: string; pattern: RegExp; handler: Handler; wantsBody: boolean };

const EMPTY = new Uint8Array(0);
const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const field = (obj: unknown, name: string): unknown => (isObject(obj) ? obj[name] : undefined);
const codePoints = (s: string) => Array.from(s).length;
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

/** JSON with object keys sorted, so equal data compares equal. */
function canon(x: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : isObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v;
  return JSON.stringify(sort(x));
}

function title(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") ?? "Feature";
  const flat = line.replace(/\s+/g, " ");
  return flat.length <= 60 ? flat : flat.slice(0, 59).trimEnd() + "...";
}

export class HostModule {
  readonly storage: Storage;
  readonly platform: PlatformApi;
  private readonly secret: string;
  private readonly opts: HostModuleOptions;
  private readonly log: Logger;
  private readonly routes: Route[] = [];
  private ready: Promise<void> | null = null;

  constructor(opts: HostModuleOptions) {
    if (!opts.webhookSecret) throw new Error("webhookSecret is required");
    if (!opts.storage || !opts.platform) throw new Error("storage and platform are required");
    this.opts = opts;
    this.storage = opts.storage;
    this.platform = opts.platform;
    this.secret = opts.webhookSecret;
    this.log = opts.logger ?? defaultLogger;
    this.buildRoutes();
  }

  // ------------------------------------------------------------------ entry point
  /** Serve one call. Never throws: failures become `4xx` / `500` responses (the exception is logged). */
  async handle(req: HocRequest): Promise<HocResponse> {
    const method = req.method.toUpperCase();
    const path = req.path.replace(/^\/+|\/+$/g, "");
    try {
      await this.ensureReady();
      if (path === "webhook" && method === "POST") return await this.webhook(req.headers ?? {}, req.body ?? EMPTY);
      const user = toUser(await this.opts.getCurrentUser(req.request));
      if (user === null) throw unauthenticated();
      for (const route of this.routes) {
        const match = route.pattern.exec(path);
        if (route.method === method && match) {
          const parsed = route.wantsBody && req.body && req.body.length > 0 ? this.parseJson(req.body) : null;
          this.log.info(`hoc ${method} ${path} user=${user.id}`);
          return await route.handler({ user, query: req.query ?? {}, body: parsed, params: match.slice(1) });
        }
      }
      throw new HocError(404, "not_found", "Not found.");
    } catch (e) {
      if (e instanceof HocError) return { status: e.status, payload: { error: e.code, message: e.message } };
      this.log.error(`hoc ${method} ${path} failed\n${describeError(e)}`);
      return { status: 500, payload: { error: "internal", message: "Internal error." } };
    }
  }

  /** Start platform builds for requests that were stored but never reached the platform. Returns how many started. */
  async retryUnstartedBuilds(limit = 100): Promise<number> {
    const pending = await this.storage.transaction(false, (tx) => tx.listUnstartedBuilds(limit));
    let started = 0;
    for (const r of pending) if (await this.startBuild(r.id)) started++;
    return started;
  }

  // ------------------------------------------------------------------ plumbing
  private ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        if (this.opts.autoMigrate !== false) await this.storage.migrate();
        if (this.opts.retryBuilds !== false) setTimeout(() => void this.safeRetryUnstarted(), 2000).unref();
      })().catch((e) => {
        this.ready = null; // try again on the next call
        throw e;
      });
    }
    return this.ready;
  }

  private async safeRetryUnstarted(): Promise<void> {
    try {
      await this.retryUnstartedBuilds();
    } catch (e) {
      this.log.error(`retrying unstarted builds failed\n${describeError(e)}`);
    }
  }

  private parseJson(raw: Uint8Array): unknown {
    try {
      return JSON.parse(Buffer.from(raw).toString("utf8"));
    } catch {
      throw invalid("Malformed JSON.");
    }
  }

  private route(method: string, pattern: string, handler: Handler, wantsBody = false): void {
    this.routes.push({ method, pattern: new RegExp(`^${pattern}$`), handler: handler.bind(this), wantsBody });
  }

  private async admin(c: Call): Promise<boolean> {
    if (c.admin === undefined) c.admin = Boolean(await this.opts.isAdmin(c.user.raw));
    return c.admin;
  }

  private static q1(query: Record<string, string[]>, name: string): string | null {
    const v = query[name];
    return v && v.length > 0 ? v[0] : null;
  }

  private static intParam(query: Record<string, string[]>, name: string, dflt: number, lo: number, hi: number): number {
    const raw = HostModule.q1(query, name);
    if (raw === null) return dflt;
    if (!/^[0-9]+$/.test(raw) || Number(raw) < lo || Number(raw) > hi) throw invalid(`${name} must be ${lo}-${hi}.`);
    return Number(raw);
  }

  private async settings(tx: StorageTx): Promise<typeof DEFAULT_SETTINGS> {
    const stored = (await tx.getSettings()) ?? {};
    const merged = { ...DEFAULT_SETTINGS, ...stored };
    merged.dataSources = [...(merged.dataSources ?? [])];
    return merged;
  }

  private static allowedBy(policy: string, admin: boolean, owner: boolean): boolean {
    if (policy === "nobody") return false;
    if (policy === "admins") return admin;
    return owner || admin;
  }

  private async loadVisible(tx: StorageTx, featureId: string, user: HocUser): Promise<Loaded> {
    const f = await tx.getFeature(featureId);
    if (!f) throw notFound();
    const assignments = (await tx.getAssignments([f.id])).get(f.id) ?? [];
    if (!assignments.some((a) => a.userId === null || a.userId === user.id)) throw notFound();
    const state = (await tx.getUserState([f.id], user.id)).get(f.id)!;
    return { feature: f, assignments, state };
  }

  private async view(c: Call, ld: Loaded): Promise<Record<string, unknown>> {
    const f = ld.feature;
    const out: Record<string, unknown> = {
      id: f.id,
      title: f.title,
      kind: f.kind,
      path: f.path,
      slotId: f.slotId,
      mode: f.mode,
      packageId: f.packageId,
      currentVersion: f.currentVersion,
      pinnedVersion: ld.state.pinnedVersion,
      enabled: !ld.state.disabled,
      ownerUserId: f.ownerUserId,
      requestId: f.requestId,
    };
    if (f.ownerUserId === c.user.id || (await this.admin(c))) {
      out.sharing = {
        everyone: ld.assignments.some((a) => a.userId === null),
        userIds: ld.assignments.filter((a) => a.userId !== null).map((a) => a.userId),
      };
    }
    return out;
  }

  private async reloadView(tx: StorageTx, c: Call, featureId: string): Promise<HocResponse> {
    return { status: 200, payload: await this.view(c, await this.loadVisible(tx, featureId, c.user)) };
  }

  private static publicRequest(r: RequestRec): Record<string, unknown> {
    return {
      id: r.id,
      text: r.text,
      status: r.status,
      message: r.message,
      featureId: r.featureId,
      userId: r.userId,
      userName: r.userName,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  // ------------------------------------------------------------------ routes
  private buildRoutes(): void {
    const r = this.route.bind(this);
    r("GET", "token", this.token);
    r("POST", "api/requests", this.createRequest, true);
    r("GET", "api/requests", this.listRequests);
    r("POST", "api/requests/([^/]+)/reply", this.reply, true);
    r("GET", "api/features", this.listFeatures);
    r("GET", "api/resolve", this.resolve);
    r("GET", "api/features/([^/]+)/versions", this.versions);
    r("POST", "api/features/([^/]+)/pin", this.pin, true);
    r("POST", "api/features/([^/]+)/current", this.setCurrent, true);
    r("POST", "api/features/([^/]+)/share", this.share, true);
    r("DELETE", "api/features/([^/]+)/share/(.+)", this.unshare);
    r("POST", "api/features/([^/]+)/enabled", this.enabled, true);
    r("GET", "api/users", this.users);
    r("GET", "api/settings", this.getSettings);
    r("PUT", "api/settings", this.putSettings, true);
  }

  // ---- token
  private async token(c: Call): Promise<HocResponse> {
    const featureId = HostModule.q1(c.query, "featureId");
    let packageId: string | undefined;
    let slotId: string | undefined;
    let version: string | null = null;
    if (!featureId) {
      packageId = this.opts.legacyPackageId;
      slotId = this.opts.legacySlotId;
      if (!packageId || !slotId) throw invalid("featureId is required.");
    } else {
      const ld = await this.storage.transaction(false, (tx) => this.loadVisible(tx, featureId, c.user));
      if (ld.state.disabled) throw notFound();
      packageId = ld.feature.packageId;
      slotId = ld.feature.slotId;
      version = ld.state.pinnedVersion ?? ld.feature.currentVersion;
    }
    const res = await this.platform.embedToken(c.user.id, packageId, slotId, version);
    if (res.status === 409) throw new HocError(409, "version_unavailable", "That version is no longer available.");
    if (!res.ok || !isObject(res.body) || !res.body.token) throw platformUnavailable();
    return { status: 200, payload: { token: res.body.token, expiresAt: res.body.expiresAt ?? null, userId: c.user.id, displayName: c.user.name } };
  }

  // ---- requests
  private async createRequest(c: Call): Promise<HocResponse> {
    const body = c.body;
    if (!isObject(body)) throw invalid("Body must be an object.");
    const text = body.text;
    if (typeof text !== "string" || text.trim() === "") throw invalid("text is required.");
    if (codePoints(text) > TEXT_MAX) throw new HocError(413, "payload_too_large", "The request text is too long.");
    let snapshotJson: string | null = null;
    if (body.snapshot !== undefined && body.snapshot !== null) {
      if (!isObject(body.snapshot)) throw invalid("snapshot must be an object.");
      snapshotJson = JSON.stringify(body.snapshot);
      if (Buffer.byteLength(snapshotJson, "utf8") > SNAPSHOT_MAX) throw new HocError(413, "payload_too_large", "The page snapshot is too large.");
    }
    const featureId = body.featureId ?? null;
    if (featureId !== null && typeof featureId !== "string") throw invalid("featureId must be a string.");
    const rec = await this.storage.transaction(true, async (tx) => {
      if (featureId !== null) await this.loadVisible(tx, featureId, c.user);
      const now = nowIso();
      const r: RequestRec = {
        id: "req-" + randomBytes(6).toString("hex"),
        seq: await tx.nextSeq(),
        userId: c.user.id,
        userName: c.user.name,
        userEmail: c.user.email,
        text,
        status: "InProgress",
        message: null,
        featureId,
        changeOf: featureId,
        mode: (await this.settings(tx)).renderingMode,
        snapshot: snapshotJson,
        buildId: null,
        createdAt: now,
        updatedAt: now,
      };
      await tx.insertRequest(r);
      return r;
    });
    if (!(await this.startBuild(rec.id))) this.scheduleBuildRetry(rec.id, 0);
    return { status: 201, payload: HostModule.publicRequest(rec) };
  }

  /** Tell the platform about a stored request. Idempotent on the platform side (keyed by the request id). */
  private async startBuild(requestId: string): Promise<boolean> {
    const loaded = await this.storage.transaction(false, async (tx) => {
      const r = await tx.getRequest(requestId);
      const feature = r && r.changeOf ? await tx.getFeature(r.changeOf) : null;
      return { r, feature };
    });
    const { r, feature } = loaded;
    if (r === null || r.buildId) return r !== null;
    const user: Record<string, unknown> = { id: r.userId };
    if (r.userName) user.name = r.userName;
    if (r.userEmail) user.email = r.userEmail;
    const res = await this.platform.startBuild(
      r.id,
      user,
      r.text,
      r.mode,
      r.snapshot ? JSON.parse(r.snapshot) : undefined,
      feature ? { ref: feature.id, packageId: feature.packageId } : null,
    );
    const buildId = res.ok && isObject(res.body) ? res.body.buildId : null;
    if (!buildId) {
      this.log.warn(`platform did not take the build for request ${r.id} (status ${res.status})`);
      return false;
    }
    await this.storage.transaction(true, (tx) => tx.updateRequest(r.id, { buildId: String(buildId) }));
    return true;
  }

  private scheduleBuildRetry(requestId: string, attempt: number): void {
    if (this.opts.retryBuilds === false || attempt >= BUILD_RETRY_DELAYS.length) return;
    setTimeout(() => {
      this.startBuild(requestId).then(
        (started) => {
          if (!started) this.scheduleBuildRetry(requestId, attempt + 1);
        },
        (e) => {
          this.log.error(`retrying the build for request ${requestId} failed\n${describeError(e)}`);
          this.scheduleBuildRetry(requestId, attempt + 1);
        },
      );
    }, BUILD_RETRY_DELAYS[attempt] * 1000).unref();
  }

  private async listRequests(c: Call): Promise<HocResponse> {
    const scope = HostModule.q1(c.query, "scope") ?? "mine";
    if (scope !== "mine" && scope !== "all") throw invalid("scope must be mine or all.");
    const statuses = c.query.status ?? [];
    if (statuses.some((s) => !oneOf(STATUSES, s))) throw invalid("Unknown status.");
    const limit = HostModule.intParam(c.query, "limit", 50, 1, 200);
    let offset = 0;
    const cursor = HostModule.q1(c.query, "cursor");
    if (cursor !== null) {
      const decoded = /^[A-Za-z0-9_-]+$/.test(cursor) ? Buffer.from(cursor, "base64url").toString("ascii") : "";
      if (!/^[0-9]+$/.test(decoded)) throw invalid("Bad cursor.");
      offset = Number(decoded);
    }
    const page = await this.storage.transaction(false, async (tx) => {
      if (scope === "all") {
        const policy = (await this.settings(tx)).viewAllRequests;
        if (!(policy === "everyone" || (policy === "admins" && (await this.admin(c))))) throw forbidden("You may not see everyone's requests.");
      }
      return tx.listRequests(scope === "all" ? null : c.user.id, statuses, limit, offset);
    });
    const nextCursor = page.more ? Buffer.from(String(offset + limit), "ascii").toString("base64url") : null;
    return { status: 200, payload: { requests: page.rows.map(HostModule.publicRequest), nextCursor } };
  }

  private async reply(c: Call): Promise<HocResponse> {
    let r = await this.storage.transaction(false, (tx) => tx.getRequest(c.params[0]));
    if (r === null || r.userId !== c.user.id) throw notFound("No such request.");
    const text = field(c.body, "text");
    if (typeof text !== "string" || text.trim() === "" || codePoints(text) > TEXT_MAX) throw invalid("text is required (max 20000 characters).");
    if (r.status !== "NeedsInfo" || !r.buildId) throw new HocError(409, "not_awaiting_reply", "This request is not waiting for an answer.");
    if (!(await this.platform.replyToBuild(r.buildId, text)).ok) throw platformUnavailable();
    const id = r.id;
    r = await this.storage.transaction(true, async (tx) => {
      await tx.updateRequest(id, { status: "InProgress", message: null, updatedAt: nowIso() });
      return tx.getRequest(id);
    });
    return { status: 200, payload: HostModule.publicRequest(r!) };
  }

  // ---- features
  private async visibleWithState(tx: StorageTx, user: HocUser, path?: string): Promise<Loaded[]> {
    const feats = await tx.listVisibleFeatures(user.id, path);
    const ids = feats.map((f) => f.id);
    const assigns = await tx.getAssignments(ids);
    const states = await tx.getUserState(ids, user.id);
    return feats.map((f) => ({ feature: f, assignments: assigns.get(f.id) ?? [], state: states.get(f.id)! }));
  }

  private async listFeatures(c: Call): Promise<HocResponse> {
    const loaded = await this.storage.transaction(false, (tx) => this.visibleWithState(tx, c.user));
    const features: Record<string, unknown>[] = [];
    for (const ld of loaded) features.push(await this.view(c, ld));
    return { status: 200, payload: { features } };
  }

  private async resolve(c: Call): Promise<HocResponse> {
    const path = HostModule.q1(c.query, "path");
    if (!path || !path.startsWith("/")) throw invalid("path must start with /.");
    const features = await this.storage.transaction(false, async (tx) => {
      const cands = (await this.visibleWithState(tx, c.user, path)).filter((ld) => !ld.state.disabled);
      // Page overrides / new pages: one per path. A user-specific assignment beats "everyone"; the newest assignment wins.
      const rank = (ld: Loaded): [number, number] => {
        const mine = ld.assignments.filter((a) => a.userId === c.user.id);
        const every = ld.assignments.filter((a) => a.userId === null);
        return [mine.length > 0 ? 1 : 0, (mine[0] ?? every[0]).seq];
      };
      const pages = cands
        .filter((ld) => ld.feature.kind !== "slot")
        .sort((a, b) => {
          const [am, as] = rank(a);
          const [bm, bs] = rank(b);
          return bm - am || bs - as;
        })
        .slice(0, 1);
      const chosen = [...pages, ...cands.filter((ld) => ld.feature.kind === "slot")];
      const out: Record<string, unknown>[] = [];
      for (const ld of chosen) {
        const f = ld.feature;
        const wanted = ld.state.pinnedVersion ?? f.currentVersion;
        const v = await tx.getVersion(f.id, wanted);
        if (v === null) {
          this.log.warn(`feature ${f.id} has no record of version ${wanted}`);
          continue;
        }
        out.push({ featureId: f.id, kind: f.kind, mode: f.mode, slotId: f.slotId, path: f.path, packageId: f.packageId, version: v.version, sha256: v.sha256, entry: v.entry });
      }
      return out;
    });
    return { status: 200, payload: { path, features } };
  }

  private async versions(c: Call): Promise<HocResponse> {
    const { ld, versions } = await this.storage.transaction(false, async (tx) => {
      const loaded = await this.loadVisible(tx, c.params[0], c.user);
      return { ld: loaded, versions: await tx.listVersions(loaded.feature.id) };
    });
    return {
      status: 200,
      payload: {
        featureId: ld.feature.id,
        currentVersion: ld.feature.currentVersion,
        pinnedVersion: ld.state.pinnedVersion,
        versions: versions.map((v) => ({ version: v.version, publishedAt: v.publishedAt, requestId: v.requestId, sha256: v.sha256 })),
      },
    };
  }

  private pin(c: Call): Promise<HocResponse> {
    return this.storage.transaction(true, async (tx) => {
      const ld = await this.loadVisible(tx, c.params[0], c.user);
      const body = c.body;
      if (!isObject(body) || !has(body, "version") || (body.version !== null && typeof body.version !== "string")) {
        throw invalid("version is required (a version string or null).");
      }
      const version: string | null = body.version;
      if (version !== null && (await tx.getVersion(ld.feature.id, version)) === null) throw new HocError(404, "version_not_found", "No such version.");
      await tx.setPin(ld.feature.id, c.user.id, version);
      return this.reloadView(tx, c, ld.feature.id);
    });
  }

  private setCurrent(c: Call): Promise<HocResponse> {
    return this.storage.transaction(true, async (tx) => {
      const ld = await this.loadVisible(tx, c.params[0], c.user);
      const version = field(c.body, "version");
      if (typeof version !== "string" || version === "") throw invalid("version is required.");
      if (ld.feature.ownerUserId !== c.user.id && !(await this.admin(c))) throw forbidden("Only the owner or an admin may do this.");
      if ((await tx.getVersion(ld.feature.id, version)) === null) throw new HocError(404, "version_not_found", "No such version.");
      await tx.updateFeature(ld.feature.id, { currentVersion: version });
      return this.reloadView(tx, c, ld.feature.id);
    });
  }

  private async share(c: Call): Promise<HocResponse> {
    const { ld, policies } = await this.storage.transaction(false, async (tx) => ({
      ld: await this.loadVisible(tx, c.params[0], c.user),
      policies: await this.settings(tx),
    }));
    const body: any = c.body;
    const keys = isObject(body) ? Object.keys(body) : [];
    const named =
      keys.length === 1 && keys[0] === "userIds" && Array.isArray(body.userIds) && body.userIds.length > 0 && body.userIds.every((x: unknown) => typeof x === "string");
    const everyone = keys.length === 1 && keys[0] === "everyone" && body.everyone === true;
    if (!named && !everyone) throw invalid("Send either userIds (non-empty) or everyone: true.");
    const policy = everyone ? policies.shareWithEveryone : policies.shareWithNamedUsers;
    if (!HostModule.allowedBy(policy, await this.admin(c), ld.feature.ownerUserId === c.user.id)) {
      throw new HocError(403, "sharing_not_allowed", "Sharing is not allowed for you.");
    }
    const targets: (string | null)[] = everyone ? [null] : [...new Set<string>(body.userIds)];
    if (named) {
      for (const uid of targets) if (uid !== c.user.id && !(await this.userKnown(String(uid)))) throw invalid("Unknown user id.");
    }
    return this.storage.transaction(true, async (tx) => {
      await this.loadVisible(tx, ld.feature.id, c.user);
      for (const t of targets) await tx.addAssignment(ld.feature.id, t, await tx.nextSeq());
      return this.reloadView(tx, c, ld.feature.id);
    });
  }

  private async userKnown(userId: string): Promise<boolean> {
    if (this.opts.userExists) return Boolean(await this.opts.userExists(userId));
    for (const m of (await this.opts.findUsers(userId)) ?? []) if (String(field(m, "id")) === userId) return true;
    return false;
  }

  private unshare(c: Call): Promise<HocResponse> {
    return this.storage.transaction(true, async (tx) => {
      const ld = await this.loadVisible(tx, c.params[0], c.user);
      if (ld.feature.ownerUserId !== c.user.id && !(await this.admin(c))) throw forbidden("Only the owner or an admin may do this.");
      const target = c.params[1];
      await tx.removeAssignment(ld.feature.id, target === "everyone" ? null : target);
      return this.reloadView(tx, c, ld.feature.id);
    });
  }

  private enabled(c: Call): Promise<HocResponse> {
    return this.storage.transaction(true, async (tx) => {
      const ld = await this.loadVisible(tx, c.params[0], c.user);
      const enabled = field(c.body, "enabled");
      if (typeof enabled !== "boolean") throw invalid("enabled must be a boolean.");
      await tx.setDisabled(ld.feature.id, c.user.id, !enabled);
      return this.reloadView(tx, c, ld.feature.id);
    });
  }

  private async users(c: Call): Promise<HocResponse> {
    const q = HostModule.q1(c.query, "query");
    if (!q || codePoints(q) > 100) throw invalid("query is required (max 100 characters).");
    const limit = HostModule.intParam(c.query, "limit", 20, 1, 50);
    const policy = (await this.storage.transaction(false, (tx) => this.settings(tx))).shareWithNamedUsers;
    if (policy === "nobody" || (policy === "admins" && !(await this.admin(c)))) {
      throw new HocError(403, "sharing_not_allowed", "Sharing with named users is not allowed for you.");
    }
    const found: { id: string; name: string | null }[] = [];
    for (const m of (await this.opts.findUsers(q)) ?? []) {
      const uid = field(m, "id");
      if (uid === undefined || uid === null || String(uid) === c.user.id) continue;
      const name = field(m, "name");
      found.push({ id: String(uid), name: name === undefined || name === null || name === "" ? null : String(name) });
      if (found.length >= limit) break;
    }
    return { status: 200, payload: { users: found } };
  }

  // ---- settings
  /** Settings as returned to the browser: a data source's `auth.secretValue` is write-only and never echoed. */
  private static publicSettings(s: Record<string, any>): Record<string, any> {
    const sources = (s.dataSources ?? []).map((d: any) => {
      const copy = { ...d };
      if (isObject(copy.auth)) {
        const { secretValue: _omit, ...rest } = copy.auth;
        copy.auth = rest;
      }
      return copy;
    });
    return { ...s, dataSources: sources };
  }

  private async getSettings(c: Call): Promise<HocResponse> {
    if (!(await this.admin(c))) throw forbidden("Admins only.");
    return { status: 200, payload: HostModule.publicSettings(await this.storage.transaction(false, (tx) => this.settings(tx))) };
  }

  private async putSettings(c: Call): Promise<HocResponse> {
    if (!(await this.admin(c))) throw forbidden("Admins only.");
    const body = c.body;
    if (!isObject(body)) throw invalid("Body must be an object.");
    if (!oneOf(MODES, body.renderingMode)) throw invalid("renderingMode must be inject or iframe.");
    if (!oneOf(POLICIES, body.shareWithNamedUsers) || !oneOf(POLICIES, body.shareWithEveryone)) throw invalid("Sharing policies must be owner, admins or nobody.");
    if (body.viewAllRequests !== "admins" && body.viewAllRequests !== "everyone") throw invalid("viewAllRequests must be admins or everyone.");
    const sources = body.dataSources;
    if (!Array.isArray(sources)) throw invalid("dataSources must be an array.");
    for (const d of sources) {
      if (!isObject(d) || typeof d.name !== "string" || d.name === "" || typeof d.baseUrl !== "string") throw invalid("Each data source needs a name and baseUrl.");
      if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/]+/.test(d.baseUrl)) throw invalid("baseUrl must be a URL.");
      const auth = d.auth;
      if (
        auth !== undefined &&
        auth !== null &&
        (!isObject(auth) ||
          auth.type !== "bearer" ||
          typeof auth.secret !== "string" ||
          !SECRET_NAME.test(auth.secret) ||
          (has(auth, "secretValue") && typeof auth.secretValue !== "string"))
      ) {
        throw invalid("auth must be bearer with a secret name [a-z0-9_-]{1,64}.");
      }
    }
    const next = {
      renderingMode: body.renderingMode,
      shareWithNamedUsers: body.shareWithNamedUsers,
      shareWithEveryone: body.shareWithEveryone,
      viewAllRequests: body.viewAllRequests,
      dataSources: HostModule.publicSettings({ dataSources: sources }).dataSources,
    };
    const old = await this.storage.transaction(false, (tx) => this.settings(tx));
    const hasNewSecret = sources.some((d: any) => isObject(d.auth) && d.auth.secretValue);
    if (canon(next.dataSources) !== canon(old.dataSources) || hasNewSecret) {
      for (const d of sources) {
        const value = isObject(d.auth) ? d.auth.secretValue : undefined;
        if (value && !(await this.platform.putSecret(d.auth.secret, value, c.user.id)).ok) throw platformUnavailable();
      }
      if (!(await this.platform.putDataSources(next.dataSources)).ok) throw platformUnavailable();
    }
    await this.storage.transaction(true, (tx) => tx.saveSettings(next));
    return { status: 200, payload: HostModule.publicSettings(next) };
  }

  // ------------------------------------------------------------------ webhook
  private async webhook(headers: Record<string, string | string[] | undefined>, raw: Uint8Array): Promise<HocResponse> {
    const sig = headers[SIGNATURE_HEADER];
    if (!verifySignature(this.secret, raw, Array.isArray(sig) ? sig[0] : sig)) {
      return { status: 401, payload: { error: "invalid_signature", message: "Signature missing or wrong." } };
    }
    let ev: unknown;
    try {
      ev = JSON.parse(Buffer.from(raw).toString("utf8"));
    } catch {
      return { status: 400, payload: { error: "invalid_request", message: "Malformed JSON." } };
    }
    if (!isObject(ev)) return { status: 400, payload: { error: "invalid_request", message: "Body must be an object." } };
    if (has(ev, "sentAt") && isStale(ev.sentAt)) return { status: 400, payload: { error: "stale_event", message: "sentAt is outside the tolerance." } };
    const eventId = ev.eventId;
    await this.storage.transaction(true, async (tx) => {
      if (typeof eventId === "string" && eventId !== "" && !(await tx.recordEvent(eventId, nowIso()))) return; // a repeat; nothing was changed
      await this.applyEvent(tx, ev as Record<string, any>);
    });
    return { status: 200, payload: {} };
  }

  private async applyEvent(tx: StorageTx, ev: Record<string, any>): Promise<void> {
    const etype = ev.type;
    if (etype !== "build.status" && etype !== "build.version") return; // activation.changed (legacy) and anything new: acknowledged, ignored
    const ref = ev.requestRef;
    const r = typeof ref === "string" ? await tx.getRequest(ref) : null;
    const now = nowIso();
    const buildId = ev.buildId;
    const newBuildId = r !== null && !r.buildId && typeof buildId === "string" && buildId !== "" ? buildId : undefined;
    if (etype === "build.status") {
      const status = ev.status;
      if (r === null || !oneOf(STATUSES, status)) return;
      const message = (status === "NeedsInfo" || status === "Rejected") && typeof ev.message === "string" ? ev.message : null;
      await tx.updateRequest(r.id, { status, message, updatedAt: now, buildId: newBuildId });
      return;
    }
    const featureRef = ev.featureRef;
    const version = ev.version;
    if (typeof featureRef !== "string" || featureRef === "" || typeof version !== "string" || version === "") {
      this.log.warn(`ignoring build.version without featureRef/version: ${ev.eventId}`);
      return;
    }
    const kind = oneOf(KINDS, ev.kind) ? ev.kind : "page-override";
    const slotId = typeof ev.slotId === "string" && ev.slotId !== "" ? ev.slotId : "main";
    const mode = oneOf(MODES, ev.mode) ? ev.mode : r ? r.mode : "inject";
    let f = await tx.getFeature(featureRef);
    if (f === null) {
      if (r === null) {
        this.log.warn(`build.version for unknown feature ${featureRef} and unknown request ${ref}`);
        return;
      }
      f = {
        id: featureRef,
        title: title(r.text),
        kind,
        path: typeof ev.path === "string" ? ev.path : null,
        slotId,
        mode,
        packageId: String(ev.packageId || ""),
        currentVersion: version,
        ownerUserId: r.userId,
        requestId: r.id,
        createdAt: now,
      };
      await tx.insertFeature(f);
      await tx.addAssignment(f.id, r.userId, await tx.nextSeq());
    } else {
      await tx.updateFeature(f.id, { currentVersion: version, slotId, mode });
    }
    await tx.upsertVersion({
      featureId: f.id,
      version,
      publishedAt: now,
      requestId: r ? r.id : null,
      sha256: String(ev.sha256 || ""),
      entry: String(ev.entry || ""),
      seq: await tx.nextSeq(),
    });
    if (r !== null) await tx.updateRequest(r.id, { featureId: f.id, updatedAt: now, buildId: newBuildId });
  }
}
