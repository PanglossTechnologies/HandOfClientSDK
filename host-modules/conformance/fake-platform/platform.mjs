// Fake HandOfClient platform: the slice of /host/v1 a host module calls (builds, embed-token, data-sources,
// secrets, jwks), the public bundle route, and a control API under /_fake that records every call, injects
// failures and sends HMAC-signed webhooks to the module under test. See ../README.md.
//
// It is a test double and a local-development stand-in, not the platform: nothing is persisted, no build ever
// runs (unless `autoBuild` publishes a trivial placeholder bundle), and the embed JWT is real ES256 but signed
// with a throwaway key generated at start-up (served at /host/v1/jwks).
import http from "node:http";
import crypto from "node:crypto";

const REF = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SECRET_NAME = /^[a-z0-9_-]{1,64}$/;
const SNAPSHOT_MAX = 2 * 1024 * 1024;
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const sha256Hex = (data) => crypto.createHash("sha256").update(data).digest("hex");

export function signBody(secret, rawBody) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function createFakePlatform(options = {}) {
  const cfg = {
    port: 4010,
    bind: "127.0.0.1",
    apiKey: "conformance-host-api-key",
    webhookSecret: "whsec_conformance",
    hostId: "conformance",
    tenantId: "conformance-tenant",
    webhookUrl: null, // e.g. http://127.0.0.1:5000/hoc/webhook
    autoBuild: false, // publish a placeholder 1.0.0 shortly after every build, like a real platform would
    autoBuildDelayMs: 300,
    ...options,
  };
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "fake-" + Date.now(), use: "sig", alg: "ES256" };

  const state = { calls: [], seq: 0, builds: new Map(), packages: new Map(), failures: [], events: 0, secrets: new Map(), dataSources: [] };
  const origin = () => `http://${cfg.bind === "0.0.0.0" ? "127.0.0.1" : cfg.bind}:${server.address().port}`;

  // ---------- webhooks ----------
  async function deliver({ body, rawBody, secret, signature, omitSignature, omitEvent, event, url } = {}) {
    const raw = rawBody ?? JSON.stringify(body);
    const headers = { "content-type": "application/json" };
    if (!omitSignature) headers["x-handofclient-signature"] = signature ?? signBody(secret ?? cfg.webhookSecret, raw);
    if (!omitEvent) headers["x-handofclient-event"] = event ?? body?.type ?? body?.event ?? "build.status";
    const target = url ?? cfg.webhookUrl;
    if (!target) throw new Error("fake platform has no webhookUrl configured");
    const res = await fetch(target, { method: "POST", headers, body: raw });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text };
  }

  const nextEventId = () => `evt_${++state.events}`;
  const sentAt = (override) => override ?? new Date().toISOString();

  function findBuild({ buildId, requestRef }) {
    if (buildId) return state.builds.get(buildId);
    return [...state.builds.values()].reverse().find((b) => b.requestRef === requestRef);
  }

  async function sendStatus({ buildId, requestRef, status, message = null, eventId, sentAt: at }) {
    const b = findBuild({ buildId, requestRef });
    const body = { type: "build.status", eventId: eventId ?? nextEventId(), sentAt: sentAt(at), buildId: b?.buildId ?? buildId ?? "0".repeat(32), requestRef: requestRef ?? b?.requestRef, status, message };
    if (b) { b.status = status; b.message = message; b.updatedAt = new Date().toISOString(); }
    return { event: body, response: await deliver({ body }) };
  }

  /** Publishes a version into the fake registry and sends build.version (then build.status Success unless `success:false`). */
  async function publish(o) {
    const b = findBuild(o);
    const featureRef = o.featureRef ?? b?.featureRef ?? o.requestRef;
    const packageId = o.packageId ?? b?.packageId ?? `${cfg.hostId}/f-${featureRef}`;
    const version = o.version ?? "1.0.0";
    const entry = o.entry ?? "index.js";
    const content = o.content ?? `export default ${JSON.stringify({ feature: featureRef, version })};\n`;
    const sha256 = o.sha256 ?? sha256Hex(content);
    const slotId = o.slotId ?? "main";
    let pkg = state.packages.get(packageId);
    if (!pkg) state.packages.set(packageId, (pkg = { packageId, versions: new Map() }));
    pkg.versions.set(version, { version, entry, content, sha256, slotId, withdrawn: false });
    const body = {
      type: "build.version", eventId: o.eventId ?? nextEventId(), sentAt: sentAt(o.sentAt), buildId: b?.buildId ?? o.buildId ?? "0".repeat(32),
      requestRef: o.requestRef ?? b?.requestRef, featureRef, packageId, version, sha256, entry,
      kind: o.kind ?? b?.kind ?? "page-override", path: o.path ?? null, slotId, mode: o.mode ?? b?.mode ?? "inject",
    };
    const out = { versionEvent: body, versionResponse: await deliver({ body }) };
    if (o.success !== false) Object.assign(out, await sendStatus({ buildId: body.buildId, requestRef: body.requestRef, status: "Success" }).then((r) => ({ statusEvent: r.event, statusResponse: r.response })));
    return out;
  }

  // ---------- HTTP plumbing ----------
  const readBody = async (req) => { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c); };
  const sendJson = (res, status, payload, extra = {}) => { res.writeHead(status, { "content-type": "application/json", ...extra }); res.end(payload === undefined ? "" : JSON.stringify(payload)); };

  function jwt(claims) {
    const header = { alg: "ES256", typ: "JWT", kid: jwk.kid };
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
    return `${input}.${b64url(crypto.sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" }))}`;
  }

  function validateBuild(b) {
    const bad = (m) => ({ error: "invalid_request", message: m });
    if (!b || typeof b !== "object") return bad("body must be a JSON object");
    for (const f of ["tenantId", "requestRef"]) if (typeof b[f] !== "string" || !b[f] || b[f].length > 128) return bad(`${f} is required (max 128 characters)`);
    if (!REF.test(b.requestRef)) return bad("requestRef has invalid characters");
    if (!b.user || typeof b.user.id !== "string" || !b.user.id || b.user.id.length > 128) return bad("user.id is required (max 128 characters)");
    if (b.user.name != null && (typeof b.user.name !== "string" || b.user.name.length > 200)) return bad("user.name too long");
    if (b.user.email != null && (typeof b.user.email !== "string" || b.user.email.length > 320)) return bad("user.email too long");
    if (typeof b.text !== "string" || !b.text.trim() || b.text.trim().length > 20000) return bad("text is required (max 20000 characters)");
    if (b.snapshot != null && (typeof b.snapshot !== "object" || Array.isArray(b.snapshot) || JSON.stringify(b.snapshot).length > SNAPSHOT_MAX)) return bad("snapshot must be an object of at most 2 MiB");
    if (b.feature != null && (typeof b.feature.ref !== "string" || !REF.test(b.feature.ref) || b.feature.ref.length > 128)) return bad("feature.ref is invalid");
    if (!["inject", "iframe"].includes(String(b.mode).toLowerCase())) return bad("mode must be inject or iframe");
    if (b.kind != null && !["slot", "page-override", "new-page"].includes(String(b.kind).toLowerCase())) return bad("kind is invalid");
    return null;
  }

  async function handleHost(req, res, url, raw, record) {
    const path = url.pathname;
    if (req.headers["x-api-key"] !== cfg.apiKey) return record(401), sendJson(res, 401, undefined);
    let body = null;
    if (raw.length) { try { body = JSON.parse(raw.toString("utf8")); } catch { return record(400), sendJson(res, 400, { error: "invalid_request", message: "malformed JSON" }); } }
    const reply = (status, payload) => { record(status); sendJson(res, status, payload); };
    const legacy = (status, msg) => reply(status, { error: msg });

    if (req.method === "POST" && path === "/host/v1/builds") {
      const problem = validateBuild(body);
      if (problem) return reply(400, problem);
      const existing = [...state.builds.values()].find((b) => b.tenantId === body.tenantId && b.requestRef === body.requestRef);
      if (existing) return reply(200, { buildId: existing.buildId });
      const featureRef = body.feature?.ref ?? body.requestRef;
      const b = {
        buildId: crypto.randomBytes(16).toString("hex"), tenantId: body.tenantId, requestRef: body.requestRef, featureRef,
        packageId: body.feature?.packageId ?? `${cfg.hostId}/f-${featureRef}`, mode: String(body.mode).toLowerCase(),
        kind: body.kind ? String(body.kind).toLowerCase() : null, status: "InProgress", message: null, taskId: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), replies: [],
      };
      state.builds.set(b.buildId, b);
      if (cfg.autoBuild && cfg.webhookUrl) setTimeout(() => publish({ buildId: b.buildId, requestRef: b.requestRef, version: "1.0.0", path: body.snapshot?.path ?? null }).catch((e) => console.error("[fake-platform] autoBuild failed:", e.message)), cfg.autoBuildDelayMs);
      return reply(200, { buildId: b.buildId });
    }
    let m = path.match(/^\/host\/v1\/builds\/([^/]+)(\/reply)?$/);
    if (m) {
      const b = state.builds.get(m[1]);
      if (!b) return reply(404, { error: "build_not_found", message: "No such build." });
      if (req.method === "GET" && !m[2]) { const { replies, ...pub } = b; return reply(200, pub); }
      if (req.method === "POST" && m[2]) {
        if (typeof body?.text !== "string" || !body.text.trim() || body.text.length > 20000) return reply(400, { error: "invalid_request", message: "text is required (max 20000 characters)" });
        if (b.status !== "NeedsInfo") return reply(409, { error: "build_not_awaiting_reply", message: "The build is not waiting for an answer." });
        b.replies.push(body.text); b.status = "InProgress"; b.message = null;
        return reply(200, { buildId: b.buildId, status: b.status });
      }
    }
    if (req.method === "POST" && path === "/host/v1/embed-token") {
      for (const f of ["tenantId", "userId", "packageId", "slotId"]) if (typeof body?.[f] !== "string" || !body[f]) return legacy(400, `${f} is required`);
      if (body.version == null) return legacy(412, "No active activation for this tenant and slot.");
      const pkg = state.packages.get(body.packageId);
      if (!pkg) return legacy(404, "Unknown package.");
      const v = pkg.versions.get(body.version);
      if (!v) return legacy(404, "Unknown version.");
      if (v.withdrawn) return legacy(409, "The version has been withdrawn.");
      if (v.slotId !== body.slotId) return legacy(400, "The version does not declare that slot.");
      const now = Math.floor(Date.now() / 1000);
      const token = jwt({ iss: "handofclient", aud: "handofclient-platform-api", sub: body.userId, jti: crypto.randomBytes(16).toString("hex"), hid: cfg.hostId, tid: body.tenantId, pkg: body.packageId, ver: body.version, slot: body.slotId, scope: "", xv: "1", nbf: now, exp: now + 480 });
      return reply(200, { token, expiresAt: new Date((now + 480) * 1000).toISOString() });
    }
    if (req.method === "PUT" && path === "/host/v1/data-sources") {
      if (typeof body?.tenantId !== "string" || !Array.isArray(body.dataSources)) return reply(400, { error: "invalid_request", message: "tenantId and dataSources are required" });
      state.dataSources = body.dataSources;
      return reply(200, { tenantId: body.tenantId, dataSources: body.dataSources.map((d) => d.name), allowedHostsAdded: [] });
    }
    if (req.method === "PUT" && path === "/host/v1/secrets") {
      if (typeof body?.tenantId !== "string" || !SECRET_NAME.test(body?.name ?? "") || typeof body?.value !== "string" || !body.value) return legacy(400, "tenantId, name ([a-z0-9_-]{1,64}) and a non-empty value are required");
      state.secrets.set(`${body.tenantId}/${body.name}`, body.value);
      return reply(200, { tenantId: body.tenantId, name: body.name, updatedAt: new Date().toISOString() });
    }
    reply(404, { error: "not_found", message: `The fake platform does not implement ${req.method} ${path}.` });
  }

  async function handleControl(req, res, url, raw) {
    const json = raw.length ? JSON.parse(raw.toString("utf8")) : {};
    const route = `${req.method} ${url.pathname}`;
    const ok = (payload) => sendJson(res, 200, payload);
    switch (route) {
      case "GET /_fake/calls": {
        const since = Number(url.searchParams.get("since") ?? 0);
        return ok({ calls: state.calls.filter((c) => c.seq > since) });
      }
      case "GET /_fake/builds": return ok({ builds: [...state.builds.values()] });
      case "GET /_fake/state": return ok({ secrets: Object.fromEntries(state.secrets), dataSources: state.dataSources });
      case "POST /_fake/reset": state.calls.length = 0; state.failures.length = 0; state.builds.clear(); state.packages.clear(); state.secrets.clear(); state.dataSources = []; return ok({});
      case "POST /_fake/failures": state.failures.push({ match: json.match, status: json.status ?? 500, times: json.times ?? 1, drop: !!json.drop }); return ok({});
      case "DELETE /_fake/failures": state.failures.length = 0; return ok({});
      case "POST /_fake/publish": return ok(await publish(json));
      case "POST /_fake/status": return ok(await sendStatus(json));
      case "POST /_fake/withdraw": { const v = state.packages.get(json.packageId)?.versions.get(json.version); if (!v) return sendJson(res, 404, { error: "unknown package version" }); v.withdrawn = json.withdrawn !== false; return ok({}); }
      case "POST /_fake/deliver": return ok(await deliver(json));
      case "GET /_fake/config": return ok({ hostId: cfg.hostId, tenantId: cfg.tenantId, webhookUrl: cfg.webhookUrl });
      default: return sendJson(res, 404, { error: "unknown control route" });
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://fake");
      const raw = await readBody(req);
      if (url.pathname.startsWith("/_fake/")) return await handleControl(req, res, url, raw);
      if (url.pathname === "/host/v1/jwks") return sendJson(res, 200, { keys: [jwk] });
      const bundle = url.pathname.match(/^\/embed\/([^/]+)\/([^/]+)\/(.*)$/);
      if (bundle && req.method === "GET") {
        const pkg = state.packages.get(Buffer.from(bundle[1], "base64url").toString("utf8"));
        const v = pkg?.versions.get(decodeURIComponent(bundle[2]));
        const file = bundle[3] || "index.html";
        if (!v || v.withdrawn || file !== v.entry) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { "content-type": "text/javascript", "access-control-allow-origin": "*", "cache-control": "public, max-age=31536000, immutable" });
        return res.end(v.content);
      }
      if (!url.pathname.startsWith("/host/v1/")) { res.writeHead(404); return res.end(); }

      const call = { seq: ++state.seq, method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), apiKey: req.headers["x-api-key"] ?? null, body: null, status: null, at: new Date().toISOString() };
      try { call.body = raw.length ? JSON.parse(raw.toString("utf8")) : null; } catch { call.body = raw.toString("utf8"); }
      const record = (status) => { call.status = status; };
      state.calls.push(call);
      const key = `${req.method} ${url.pathname}`;
      const failure = state.failures.find((f) => f.times > 0 && new RegExp(f.match).test(key));
      if (failure) {
        failure.times--;
        if (failure.drop) { call.status = 0; return req.socket.destroy(); }
        call.status = failure.status;
        return sendJson(res, failure.status, { error: "injected_failure", message: "Failure injected by the test." });
      }
      await handleHost(req, res, url, raw, record);
    } catch (e) {
      console.error("[fake-platform]", e);
      if (!res.headersSent) sendJson(res, 500, { error: "fake_platform_error", message: String(e.message) });
    }
  });

  return {
    cfg, state, publish, sendStatus, deliver,
    get url() { return origin(); },
    start: () => new Promise((resolve, reject) => { server.once("error", reject); server.listen(cfg.port, cfg.bind, () => resolve(origin())); }),
    stop: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}
