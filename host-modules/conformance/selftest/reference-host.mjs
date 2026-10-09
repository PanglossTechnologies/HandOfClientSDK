// In-memory reference host module. Exists to prove the conformance suite itself: if this passes and the
// deliberately broken variants (selftest/mutants.mjs) fail, the suite is testing what it claims. It is also a
// readable executable form of site-hoc-api.yaml. Not for production: no persistence, no CSRF, roster auth only.
import http from "node:http";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { USERS, SESSION_COOKIE } from "../lib/profile.mjs";

const POLICIES = ["owner", "admins", "nobody"];
const STATUSES = ["InProgress", "NeedsInfo", "Rejected", "Success"];
const KINDS = ["slot", "page-override", "new-page"];
const MODES = ["inject", "iframe"];
const TEXT_MAX = 20000;
const SNAPSHOT_MAX = 2 * 1024 * 1024;
const TOLERANCE_MS = 300 * 1000;

export function createReferenceHost(opts = {}) {
  const cfg = {
    port: 0, prefix: "hoc", platformUrl: "http://127.0.0.1:4010", apiKey: "conformance-host-api-key", tenantId: "conformance-tenant",
    webhookSecret: "whsec_conformance", bugs: [], ...opts,
  };
  const bug = (name) => cfg.bugs.includes(name);
  let seq = 0;
  const state = {
    settings: { renderingMode: "inject", shareWithNamedUsers: "owner", shareWithEveryone: "admins", viewAllRequests: "admins", dataSources: [] },
    requests: [], features: new Map(), seenEvents: new Set(),
  };
  const roster = Object.values(USERS);

  // ---------- helpers ----------
  const send = (res, status, payload) => { res.writeHead(status, { "content-type": "application/json" }); res.end(payload === undefined ? "" : JSON.stringify(payload)); };
  class HttpError extends Error { constructor(status, code, message) { super(message); Object.assign(this, { status, code }); } }
  const fail = (status, code, message) => { throw new HttpError(status, code, message); };

  function currentUser(req) {
    const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(req.headers.cookie ?? "");
    return m ? roster.find((u) => u.id === m[1]) ?? null : null;
  }
  const isAdmin = (u) => u.admin === true;
  const sees = (f, u) => f.assignments.some((a) => a.userId === null || a.userId === u.id);
  const getVisible = (id, u) => { const f = state.features.get(id); if (!f || !sees(f, u)) fail(404, "not_found", "No such feature."); return f; };
  const versionOf = (f, u) => f.pins[u.id] ?? f.currentVersion;

  function view(f, u) {
    const out = {
      id: f.id, title: f.title, kind: f.kind, path: f.path, slotId: f.slotId, mode: f.mode, packageId: f.packageId, currentVersion: f.currentVersion,
      pinnedVersion: f.pins[u.id] ?? null, enabled: !f.disabledFor.has(u.id), ownerUserId: f.ownerUserId, requestId: f.requestId,
    };
    if (f.ownerUserId === u.id || isAdmin(u)) out.sharing = { everyone: f.assignments.some((a) => a.userId === null), userIds: f.assignments.filter((a) => a.userId !== null).map((a) => a.userId) };
    return out;
  }

  async function platformCall(method, path, body) {
    let res;
    try {
      res = await fetch(cfg.platformUrl + path, { method, headers: { "x-api-key": cfg.apiKey, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    } catch (e) { return { ok: false, status: 0, body: null, error: e }; }
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* ignore */ }
    return { ok: res.ok, status: res.status, body: json };
  }

  async function startBuild(r) {
    const body = { tenantId: cfg.tenantId, requestRef: r.id, user: { id: r.userId, name: r.userName ?? undefined }, text: r.text, mode: r.mode };
    if (r.snapshot) body.snapshot = r.snapshot;
    if (r.changeOf) { const f = state.features.get(r.changeOf); body.feature = { ref: f.id, packageId: f.packageId }; }
    const res = await platformCall("POST", "/host/v1/builds", body);
    if (res.ok && res.body?.buildId) { r.buildId = res.body.buildId; return true; }
    return false;
  }
  function startBuildWithRetry(r, attempt = 1) {
    startBuild(r).then((ok) => { if (!ok && attempt < 5) setTimeout(() => startBuildWithRetry(r, attempt + 1), 500 * attempt).unref(); });
  }

  // ---------- handlers ----------
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp(`^${pattern}$`), handler, ...opts });

  route("GET", "token", async ({ user, query, res }) => {
    const id = query.get("featureId");
    if (!id) fail(400, "invalid_request", "featureId is required.");
    const f = bug("token-no-visibility") ? state.features.get(id) : getVisible(id, user);
    if (!f) fail(404, "not_found", "No such feature.");
    if (!bug("token-no-visibility") && f.disabledFor.has(user.id)) fail(404, "not_found", "No such feature.");
    const userId = bug("user-from-query") && query.get("userId") ? query.get("userId") : user.id;
    const out = await platformCall("POST", "/host/v1/embed-token", { tenantId: cfg.tenantId, userId, packageId: f.packageId, version: versionOf(f, user), slotId: f.slotId });
    if (out.status === 409) fail(409, "version_unavailable", "That version is no longer available.");
    if (!out.ok) fail(502, "platform_unavailable", "The HandOfClient platform could not be reached.");
    send(res, 200, { token: out.body.token, expiresAt: out.body.expiresAt, userId, displayName: user.name ?? null });
  });

  route("POST", "api/requests", async ({ user, body, res }) => {
    if (typeof body?.text !== "string" || !body.text.trim()) fail(400, "invalid_request", "text is required.");
    if (body.text.length > TEXT_MAX) fail(413, "payload_too_large", "The request text is too long.");
    if (body.snapshot != null) {
      if (typeof body.snapshot !== "object" || Array.isArray(body.snapshot)) fail(400, "invalid_request", "snapshot must be an object.");
      if (JSON.stringify(body.snapshot).length > SNAPSHOT_MAX) fail(413, "payload_too_large", "The page snapshot is too large.");
    }
    if (body.featureId != null && typeof body.featureId !== "string") fail(400, "invalid_request", "featureId must be a string.");
    if (body.featureId != null) getVisible(body.featureId, user);
    const now = new Date().toISOString();
    const r = {
      id: `req-${crypto.randomBytes(6).toString("hex")}`, text: body.text, status: "InProgress", message: null, featureId: body.featureId ?? null,
      userId: user.id, userName: user.name ?? null, createdAt: now, updatedAt: now, seq: ++seq, snapshot: body.snapshot ?? null,
      changeOf: body.featureId ?? null, mode: state.settings.renderingMode, buildId: null,
    };
    state.requests.push(r);
    if (!(await startBuild(r))) startBuildWithRetry(r, 2);
    send(res, 201, publicRequest(r));
  });

  const publicRequest = (r) => ({ id: r.id, text: r.text, status: r.status, message: r.message, featureId: r.featureId, userId: r.userId, userName: r.userName, createdAt: r.createdAt, updatedAt: r.updatedAt });

  route("GET", "api/requests", async ({ user, query, res }) => {
    const scope = query.get("scope") ?? "mine";
    if (!["mine", "all"].includes(scope)) fail(400, "invalid_request", "scope must be mine or all.");
    const statuses = query.getAll("status");
    if (statuses.some((s) => !STATUSES.includes(s))) fail(400, "invalid_request", "Unknown status.");
    const limitRaw = query.get("limit");
    const limit = limitRaw === null ? 50 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail(400, "invalid_request", "limit must be 1-200.");
    if (scope === "all" && !(state.settings.viewAllRequests === "everyone" || (state.settings.viewAllRequests === "admins" && isAdmin(user)))) fail(403, "forbidden", "You may not see everyone's requests.");
    let offset = 0;
    if (query.get("cursor") != null) { offset = Number(Buffer.from(query.get("cursor"), "base64url").toString("utf8")); if (!Number.isInteger(offset) || offset < 0) fail(400, "invalid_request", "Bad cursor."); }
    const all = state.requests.filter((r) => (scope === "all" || r.userId === user.id) && (!statuses.length || statuses.includes(r.status))).sort((a, b) => b.seq - a.seq);
    const page = all.slice(offset, offset + limit);
    send(res, 200, { requests: page.map(publicRequest), nextCursor: offset + limit < all.length ? Buffer.from(String(offset + limit)).toString("base64url") : null });
  });

  route("POST", "api/requests/([^/]+)/reply", async ({ user, params, body, res }) => {
    const r = state.requests.find((x) => x.id === params[0]);
    if (!r || r.userId !== user.id) fail(404, "not_found", "No such request.");
    if (typeof body?.text !== "string" || !body.text.trim() || body.text.length > TEXT_MAX) fail(400, "invalid_request", "text is required (max 20000 characters).");
    if (r.status !== "NeedsInfo") fail(409, "not_awaiting_reply", "This request is not waiting for an answer.");
    const out = await platformCall("POST", `/host/v1/builds/${r.buildId}/reply`, { text: body.text });
    if (!out.ok) fail(502, "platform_unavailable", "The HandOfClient platform could not be reached.");
    r.status = "InProgress"; r.message = null; r.updatedAt = new Date().toISOString();
    send(res, 200, publicRequest(r));
  });

  route("GET", "api/features", async ({ user, res }) => {
    send(res, 200, { features: [...state.features.values()].filter((f) => sees(f, user)).map((f) => view(f, user)) });
  });

  route("GET", "api/resolve", async ({ user, query, res }) => {
    const path = query.get("path");
    if (!path || !path.startsWith("/")) fail(400, "invalid_request", "path must start with /.");
    const rank = (f) => { const mine = f.assignments.find((a) => a.userId === user.id); const every = f.assignments.find((a) => a.userId === null); const a = mine ?? every; return { specific: mine ? 1 : 0, seq: a.seq }; };
    const cands = [...state.features.values()].filter((f) => f.path === path && sees(f, user) && !f.disabledFor.has(user.id));
    const pages = cands.filter((f) => f.kind !== "slot").sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      const bySpecific = bug("everyone-beats-user") ? ra.specific - rb.specific : rb.specific - ra.specific;
      return bySpecific || rb.seq - ra.seq;
    }).slice(0, 1);
    const chosen = [...pages, ...cands.filter((f) => f.kind === "slot")];
    send(res, 200, { path, features: chosen.map((f) => { const v = f.versions.find((x) => x.version === versionOf(f, user)); return { featureId: f.id, kind: f.kind, mode: f.mode, slotId: f.slotId, path: f.path, packageId: f.packageId, version: v.version, sha256: v.sha256, entry: v.entry }; }) });
  });

  route("GET", "api/features/([^/]+)/versions", async ({ user, params, res }) => {
    const f = getVisible(decodeURIComponent(params[0]), user);
    send(res, 200, { featureId: f.id, currentVersion: f.currentVersion, pinnedVersion: f.pins[user.id] ?? null, versions: [...f.versions].sort((a, b) => b.seq - a.seq).map(({ seq: _s, entry: _e, ...v }) => v) });
  });

  route("POST", "api/features/([^/]+)/pin", async ({ user, params, body, res }) => {
    const f = getVisible(decodeURIComponent(params[0]), user);
    if (!body || !("version" in body) || (body.version !== null && typeof body.version !== "string")) fail(400, "invalid_request", "version is required (a version string or null).");
    if (body.version !== null && !f.versions.some((v) => v.version === body.version)) fail(404, "version_not_found", "No such version.");
    if (bug("pin-leaks")) f.currentVersion = body.version ?? f.currentVersion;
    else if (body.version === null) delete f.pins[user.id]; else f.pins[user.id] = body.version;
    send(res, 200, view(f, user));
  });

  route("POST", "api/features/([^/]+)/current", async ({ user, params, body, res }) => {
    const f = getVisible(decodeURIComponent(params[0]), user);
    if (typeof body?.version !== "string" || !body.version) fail(400, "invalid_request", "version is required.");
    if (f.ownerUserId !== user.id && !isAdmin(user)) fail(403, "forbidden", "Only the owner or an admin may do this.");
    if (!f.versions.some((v) => v.version === body.version)) fail(404, "version_not_found", "No such version.");
    f.currentVersion = body.version;
    send(res, 200, view(f, user));
  });

  const allowedBy = (policy, user, f) => policy === "nobody" ? false : policy === "admins" ? isAdmin(user) : (f.ownerUserId === user.id || isAdmin(user));

  route("POST", "api/features/([^/]+)/share", async ({ user, params, body, res }) => {
    const f = getVisible(decodeURIComponent(params[0]), user);
    const keys = body && typeof body === "object" ? Object.keys(body) : [];
    const named = keys.length === 1 && keys[0] === "userIds" && Array.isArray(body.userIds) && body.userIds.length > 0 && body.userIds.every((x) => typeof x === "string");
    const everyone = keys.length === 1 && keys[0] === "everyone" && body.everyone === true;
    if (!named && !everyone) fail(400, "invalid_request", "Send either userIds (non-empty) or everyone: true.");
    if (!bug("share-ignore-policy") && !allowedBy(everyone ? state.settings.shareWithEveryone : state.settings.shareWithNamedUsers, user, f)) fail(403, "sharing_not_allowed", "Sharing is not allowed for you.");
    if (named && body.userIds.some((id) => !roster.some((u) => u.id === id))) fail(400, "invalid_request", "Unknown user id.");
    const targets = everyone ? [null] : [...new Set(body.userIds)];
    for (const t of targets) if (!f.assignments.some((a) => a.userId === t)) f.assignments.push({ userId: t, seq: ++seq });
    send(res, 200, view(f, user));
  });

  route("DELETE", "api/features/([^/]+)/share/([^/]+)", async ({ user, params, res }) => {
    const f = getVisible(decodeURIComponent(params[0]), user);
    if (f.ownerUserId !== user.id && !isAdmin(user)) fail(403, "forbidden", "Only the owner or an admin may do this.");
    const target = decodeURIComponent(params[1]);
    f.assignments = f.assignments.filter((a) => (target === "everyone" ? a.userId !== null : a.userId !== target));
    if (target !== "everyone") delete f.pins[target];
    send(res, 200, view(f, user));
  });

  route("POST", "api/features/([^/]+)/enabled", async ({ user, params, body, res }) => {
    const f = getVisible(decodeURIComponent(params[0]), user);
    if (typeof body?.enabled !== "boolean") fail(400, "invalid_request", "enabled must be a boolean.");
    if (body.enabled) f.disabledFor.delete(user.id); else f.disabledFor.add(user.id);
    send(res, 200, view(f, user));
  });

  route("GET", "api/users", async ({ user, query, res }) => {
    const q = query.get("query");
    if (!q || q.length > 100) fail(400, "invalid_request", "query is required (max 100 characters).");
    const limitRaw = query.get("limit");
    const limit = limitRaw === null ? 20 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail(400, "invalid_request", "limit must be 1-50.");
    const policy = state.settings.shareWithNamedUsers;
    if (policy === "nobody" || (policy === "admins" && !isAdmin(user))) fail(403, "sharing_not_allowed", "Sharing with named users is not allowed for you.");
    const needle = q.toLowerCase();
    send(res, 200, { users: roster.filter((u) => u.id !== user.id && (u.id.toLowerCase().includes(needle) || u.name.toLowerCase().includes(needle))).slice(0, limit).map((u) => ({ id: u.id, name: u.name })) });
  });

  const publicSettings = (s) => ({ ...s, dataSources: s.dataSources.map((d) => { const { secretValue: _drop, ...auth } = d.auth ?? {}; return d.auth ? { ...d, auth } : d; }) });

  route("GET", "api/settings", async ({ user, res }) => {
    if (!isAdmin(user)) fail(403, "forbidden", "Admins only.");
    send(res, 200, publicSettings(state.settings));
  });

  route("PUT", "api/settings", async ({ user, body, res }) => {
    if (!isAdmin(user)) fail(403, "forbidden", "Admins only.");
    const bad = (m) => fail(400, "invalid_request", m);
    if (!body || typeof body !== "object") bad("Body must be an object.");
    if (!MODES.includes(body.renderingMode)) bad("renderingMode must be inject or iframe.");
    if (!POLICIES.includes(body.shareWithNamedUsers) || !POLICIES.includes(body.shareWithEveryone)) bad("Sharing policies must be owner, admins or nobody.");
    if (!["admins", "everyone"].includes(body.viewAllRequests)) bad("viewAllRequests must be admins or everyone.");
    if (!Array.isArray(body.dataSources)) bad("dataSources must be an array.");
    for (const d of body.dataSources) {
      if (!d || typeof d.name !== "string" || !d.name || typeof d.baseUrl !== "string") bad("Each data source needs a name and baseUrl.");
      try { new URL(d.baseUrl); } catch { bad("baseUrl must be a URL."); }
      if (d.auth && (d.auth.type !== "bearer" || !/^[a-z0-9_-]{1,64}$/.test(d.auth.secret ?? ""))) bad("auth must be bearer with a secret name [a-z0-9_-]{1,64}.");
    }
    const strip = (list) => JSON.stringify(publicSettings({ dataSources: list }).dataSources);
    const changed = strip(body.dataSources) !== strip(state.settings.dataSources) || body.dataSources.some((d) => d.auth?.secretValue);
    if (changed) {
      for (const d of body.dataSources) if (d.auth?.secretValue) {
        const s = await platformCall("PUT", "/host/v1/secrets", { tenantId: cfg.tenantId, name: d.auth.secret, value: d.auth.secretValue, updatedBy: user.id });
        if (!s.ok) fail(502, "platform_unavailable", "The HandOfClient platform could not be reached.");
      }
      const out = await platformCall("PUT", "/host/v1/data-sources", { tenantId: cfg.tenantId, dataSources: publicSettings({ dataSources: body.dataSources }).dataSources });
      if (!out.ok) fail(502, "platform_unavailable", "The HandOfClient platform could not be reached.");
    }
    state.settings = { renderingMode: body.renderingMode, shareWithNamedUsers: body.shareWithNamedUsers, shareWithEveryone: body.shareWithEveryone, viewAllRequests: body.viewAllRequests, dataSources: publicSettings({ dataSources: body.dataSources }).dataSources };
    send(res, 200, publicSettings(state.settings));
  });

  // ---------- webhook ----------
  function applyEvent(ev) {
    if (ev.type === "build.status") {
      const r = state.requests.find((x) => x.id === ev.requestRef);
      if (!r || !STATUSES.includes(ev.status)) return;
      r.status = ev.status; r.message = ev.status === "NeedsInfo" || ev.status === "Rejected" ? ev.message ?? null : null; r.updatedAt = new Date().toISOString();
    } else if (ev.type === "build.version") {
      const r = state.requests.find((x) => x.id === ev.requestRef);
      let f = state.features.get(ev.featureRef);
      if (!f) {
        if (!r) return;
        f = {
          id: ev.featureRef, title: r.text.slice(0, 60), kind: KINDS.includes(ev.kind) ? ev.kind : "page-override", path: ev.path ?? null, slotId: ev.slotId, mode: ev.mode,
          packageId: ev.packageId, currentVersion: ev.version, ownerUserId: r.userId, requestId: r.id, versions: [], assignments: [{ userId: r.userId, seq: ++seq }], pins: {}, disabledFor: new Set(),
        };
        state.features.set(f.id, f);
      }
      f.versions = f.versions.filter((v) => v.version !== ev.version);
      f.versions.push({ version: ev.version, publishedAt: new Date().toISOString(), requestId: ev.requestRef, sha256: ev.sha256, entry: ev.entry, seq: ++seq });
      f.currentVersion = ev.version;
      if (r) { r.featureId = f.id; r.updatedAt = new Date().toISOString(); }
    }
  }

  async function handleWebhook(req, res, raw) {
    const header = req.headers["x-handofclient-signature"];
    if (!bug("webhook-no-signature")) {
      const expected = "sha256=" + crypto.createHmac("sha256", cfg.webhookSecret).update(raw).digest("hex");
      const a = Buffer.from(String(header ?? "")), b = Buffer.from(expected);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return send(res, 401, { error: "invalid_signature", message: "Signature missing or wrong." });
    }
    let ev;
    try { ev = JSON.parse(raw.toString("utf8")); } catch { return send(res, 400, { error: "invalid_request", message: "Malformed JSON." }); }
    if (!ev || typeof ev !== "object") return send(res, 400, { error: "invalid_request", message: "Body must be an object." });
    if (ev.sentAt !== undefined && !bug("webhook-no-stale-check")) {
      const t = Date.parse(ev.sentAt);
      if (Number.isNaN(t) || Math.abs(Date.now() - t) > TOLERANCE_MS) return send(res, 400, { error: "stale_event", message: "sentAt is outside the tolerance." });
    }
    if (ev.eventId) { if (state.seenEvents.has(ev.eventId)) return send(res, 200, {}); state.seenEvents.add(ev.eventId); }
    applyEvent(ev);
    send(res, 200, {});
  }

  // ---------- server ----------
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://site");
      const prefix = `/${cfg.prefix}/`;
      if (!url.pathname.startsWith(prefix)) return send(res, 404, { error: "not_found", message: "Not found." });
      const rest = url.pathname.slice(prefix.length);
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 8 * 1024 * 1024) return send(res, 413, { error: "payload_too_large", message: "Body too large." }); chunks.push(c); }
      const raw = Buffer.concat(chunks);
      if (rest === "webhook" && req.method === "POST") return await handleWebhook(req, res, raw);
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: "unauthenticated", message: "Please sign in." });
      const r = routes.map((x) => ({ x, m: x.re.exec(rest) })).find((o) => o.m && o.x.method === req.method);
      if (!r) return send(res, 404, { error: "not_found", message: "Not found." });
      let body;
      if (raw.length && req.method !== "GET") { try { body = JSON.parse(raw.toString("utf8")); } catch { return send(res, 400, { error: "invalid_request", message: "Malformed JSON." }); } }
      await r.x.handler({ req, res, user, query: url.searchParams, params: r.m.slice(1), body });
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.code, message: e.message });
      console.error("[reference-host]", e);
      if (!res.headersSent) send(res, 500, { error: "internal", message: "Internal error." });
    }
  });

  return {
    cfg, state,
    get baseUrl() { return `http://127.0.0.1:${server.address().port}/${cfg.prefix}`; },
    start: () => new Promise((resolve, reject) => { server.once("error", reject); server.listen(cfg.port, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}/${cfg.prefix}`)); }),
    stop: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
  const host = createReferenceHost({ port: Number(arg("port", 5000)), platformUrl: arg("platform-url", "http://127.0.0.1:4010"), bugs: (arg("bugs", "") || "").split(",").filter(Boolean) });
  console.log("reference host module at", await host.start());
}
