// In-memory fake of the site's `hoc/api/*` (openapi/site-hoc-api.yaml): identity from a `hoc_user` cookie,
// every documented status code and error shape, plus knobs for slow and failing responses. It is the
// conformance double the browser components are tested against. Not a real implementation: no build is ever
// started, nothing persists.
const POLICIES = ["owner", "admins", "nobody"];

export const USERS = [
  { id: "admin", name: "Ada Admin", admin: true },
  { id: "alice", name: "Alice Owner" },
  { id: "bob", name: "Bob Builder" },
  { id: "carol", name: "Carol Customer" },
  { id: "dave", name: "Dave Dev" },
];

export function createFakeSite() {
  const fake = { state: null, log: [], failures: [], delayMs: 0 };

  fake.reset = (seed = {}) => {
    fake.log.length = 0;
    fake.failures.length = 0;
    fake.delayMs = 0;
    fake.nextId = 1;
    fake.state = {
      settings: { renderingMode: "inject", shareWithNamedUsers: "owner", shareWithEveryone: "admins", viewAllRequests: "admins", dataSources: [] },
      requests: [],
      features: [],
      ...seed,
    };
  };
  fake.reset();

  /** The next call whose path matches answers with this error instead (once, or `times`). */
  fake.failNext = (pathPattern, status, code, message, times = 1) => fake.failures.push({ pathPattern, status, code, message, times });

  const isAdmin = (userId) => USERS.find((u) => u.id === userId)?.admin === true;
  const nameOf = (id) => USERS.find((u) => u.id === id)?.name ?? null;

  function visible(feature, userId) {
    return feature.ownerUserId === userId || feature.everyone || feature.userIds.includes(userId);
  }

  function view(feature, userId) {
    const out = {
      id: feature.id, title: feature.title, kind: feature.kind, path: feature.path ?? null, slotId: feature.slotId ?? "main",
      mode: feature.mode ?? "inject", packageId: feature.packageId ?? `acme/f-${feature.id}`, currentVersion: feature.currentVersion,
      pinnedVersion: feature.pins?.[userId] ?? null, enabled: !feature.disabledFor?.includes(userId), ownerUserId: feature.ownerUserId,
      requestId: feature.requestId ?? null,
    };
    if (feature.ownerUserId === userId || isAdmin(userId)) out.sharing = { everyone: feature.everyone, userIds: [...feature.userIds] };
    return out;
  }

  const allowed = (policy, userId, feature) => policy === "nobody" ? false : policy === "admins" ? isAdmin(userId) || false : feature.ownerUserId === userId || isAdmin(userId);

  /** Handles one request; returns false when the path is not under `/hoc/api/`. */
  fake.handle = async (req, res) => {
    const url = new URL(req.url, "http://x");
    const match = url.pathname.match(/^\/hoc\/api\/(.*)$/);
    if (!match) return false;
    const path = match[1];
    const method = req.method;
    let body;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (chunks.length) {
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = undefined; }
    }
    const cookie = /(?:^|;\s*)hoc_user=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    fake.log.push({ method, path, query: url.search, body, user: cookie ?? null });

    const send = (status, payload) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
    const fail = (status, error, message) => send(status, { error, message });
    if (fake.delayMs) await new Promise((r) => setTimeout(r, fake.delayMs));

    const forced = fake.failures.find((f) => new RegExp(f.pathPattern).test(`${method} ${path}`) && f.times > 0);
    if (forced) { forced.times--; return fail(forced.status, forced.code, forced.message), true; }
    const me = USERS.find((u) => u.id === cookie);
    if (!me) return fail(401, "unauthenticated", "Please sign in first."), true;
    const s = fake.state;
    const bad = (message) => fail(400, "invalid_request", message);
    const featureById = (id) => s.features.find((f) => f.id === decodeURIComponent(id));

    let m;
    if (path === "requests" && method === "POST") {
      if (!body || typeof body.text !== "string" || !body.text.trim()) return bad("Text is required."), true;
      if (body.text.length > 20000 || JSON.stringify(body.snapshot ?? "").length > 2 * 1024 * 1024) return fail(413, "payload_too_large", "That request is too large."), true;
      if (body.featureId) {
        const f = featureById(body.featureId);
        if (!f || !visible(f, me.id)) return fail(404, "not_found", "That feature was not found."), true;
      }
      const now = new Date().toISOString();
      const request = { id: `req-${fake.nextId++}`, text: body.text, status: "InProgress", message: null, featureId: body.featureId ?? null, userId: me.id, userName: me.name, createdAt: now, updatedAt: now, snapshot: body.snapshot };
      s.requests.unshift(request);
      const { snapshot, ...visibleRequest } = request;
      return send(201, visibleRequest), true;
    }
    if (path === "requests" && method === "GET") {
      const scope = url.searchParams.get("scope") ?? "mine";
      if (scope === "all" && !(s.settings.viewAllRequests === "everyone" || isAdmin(me.id))) return fail(403, "forbidden", "Only administrators can see every request."), true;
      const statuses = url.searchParams.getAll("status");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const rows = s.requests.filter((r) => (scope === "all" || r.userId === me.id) && (!statuses.length || statuses.includes(r.status)));
      const page = rows.slice(start, start + limit).map(({ snapshot, ...r }) => r);
      return send(200, { requests: page, nextCursor: start + limit < rows.length ? String(start + limit) : null }), true;
    }
    if ((m = path.match(/^requests\/([^/]+)\/reply$/)) && method === "POST") {
      const r = s.requests.find((x) => x.id === decodeURIComponent(m[1]));
      if (!r || r.userId !== me.id) return fail(404, "not_found", "That request was not found."), true;
      if (!body || typeof body.text !== "string" || !body.text.trim()) return bad("An answer is required."), true;
      if (r.status !== "NeedsInfo") return fail(409, "not_awaiting_reply", "This request is not waiting for an answer."), true;
      r.status = "InProgress"; r.message = null; r.updatedAt = new Date().toISOString(); r.lastReply = body.text;
      const { snapshot, ...out } = r;
      return send(200, out), true;
    }
    if (path === "features" && method === "GET") return send(200, { features: s.features.filter((f) => visible(f, me.id)).map((f) => view(f, me.id)) }), true;
    if ((m = path.match(/^features\/([^/]+)\/(versions|pin|current|share|enabled)$/)) || (m = path.match(/^features\/([^/]+)\/(share)\/([^/]+)$/))) {
      const feature = featureById(m[1]);
      if (!feature || !visible(feature, me.id)) return fail(404, "not_found", "That feature was not found."), true;
      const action = m[2];
      const hasVersion = (v) => feature.versions.some((x) => x.version === v);
      if (action === "versions" && method === "GET") {
        return send(200, { featureId: feature.id, currentVersion: feature.currentVersion, pinnedVersion: feature.pins?.[me.id] ?? null, versions: feature.versions }), true;
      }
      if (action === "pin" && method === "POST") {
        if (!body || !("version" in body)) return bad("version is required."), true;
        if (body.version !== null && !hasVersion(body.version)) return fail(404, "version_not_found", "That version does not exist."), true;
        feature.pins ??= {};
        if (body.version === null) delete feature.pins[me.id]; else feature.pins[me.id] = body.version;
        return send(200, view(feature, me.id)), true;
      }
      if (action === "current" && method === "POST") {
        if (feature.ownerUserId !== me.id && !isAdmin(me.id)) return fail(403, "forbidden", "Only the owner or an administrator can do that."), true;
        if (!body?.version) return bad("version is required."), true;
        if (!hasVersion(body.version)) return fail(404, "version_not_found", "That version does not exist."), true;
        feature.currentVersion = body.version;
        return send(200, view(feature, me.id)), true;
      }
      if (action === "enabled" && method === "POST") {
        if (typeof body?.enabled !== "boolean") return bad("enabled is required."), true;
        feature.disabledFor ??= [];
        feature.disabledFor = feature.disabledFor.filter((u) => u !== me.id);
        if (!body.enabled) feature.disabledFor.push(me.id);
        return send(200, view(feature, me.id)), true;
      }
      if (action === "share" && method === "POST") {
        if (body?.everyone === true) {
          if (!allowed(s.settings.shareWithEveryone, me.id, feature)) return fail(403, "sharing_not_allowed", "You may not share this with everyone."), true;
          feature.everyone = true;
        } else if (Array.isArray(body?.userIds) && body.userIds.length) {
          if (!allowed(s.settings.shareWithNamedUsers, me.id, feature)) return fail(403, "sharing_not_allowed", "You may not share this with other people."), true;
          if (body.userIds.some((id) => !USERS.some((u) => u.id === id))) return bad("Unknown user."), true;
          for (const id of body.userIds) if (!feature.userIds.includes(id)) feature.userIds.push(id);
        } else return bad("Send userIds or everyone."), true;
        return send(200, view(feature, me.id)), true;
      }
      if (action === "share" && method === "DELETE") {
        if (feature.ownerUserId !== me.id && !isAdmin(me.id)) return fail(403, "forbidden", "Only the owner or an administrator can do that."), true;
        const target = decodeURIComponent(m[3]);
        if (target === "everyone") feature.everyone = false;
        else { feature.userIds = feature.userIds.filter((u) => u !== target); if (feature.pins) delete feature.pins[target]; }
        return send(200, view(feature, me.id)), true;
      }
    }
    if (path === "users" && method === "GET") {
      const q = (url.searchParams.get("query") ?? "").trim().toLowerCase();
      if (!q) return bad("query is required."), true;
      if (s.settings.shareWithNamedUsers === "nobody" || (s.settings.shareWithNamedUsers === "admins" && !isAdmin(me.id))) return fail(403, "sharing_not_allowed", "You may not share with other people."), true;
      const limit = Number(url.searchParams.get("limit") ?? 20);
      return send(200, { users: USERS.filter((u) => u.id !== me.id && (u.name.toLowerCase().includes(q) || u.id.includes(q))).slice(0, limit).map((u) => ({ id: u.id, name: u.name })) }), true;
    }
    if (path === "settings") {
      if (!isAdmin(me.id)) return fail(403, "forbidden", "Only administrators can change settings."), true;
      if (method === "GET") return send(200, s.settings), true;
      if (method === "PUT") {
        const b = body;
        if (!b || !["inject", "iframe"].includes(b.renderingMode) || !POLICIES.includes(b.shareWithNamedUsers) || !POLICIES.includes(b.shareWithEveryone)
          || !["admins", "everyone"].includes(b.viewAllRequests) || !Array.isArray(b.dataSources)) return bad("Settings are not valid."), true;
        fake.lastSettingsPut = structuredClone(b);
        s.settings = { ...b, dataSources: b.dataSources.map((d) => ({ ...d, ...(d.auth ? { auth: { type: d.auth.type, secret: d.auth.secret } } : {}) })) };
        return send(200, s.settings), true;
      }
    }
    return fail(404, "not_found", "No such endpoint."), true;
  };

  return fake;
}

export const version = (v, daysAgo = 0) => ({ version: v, publishedAt: new Date(Date.now() - daysAgo * 86400000).toISOString(), requestId: null, sha256: "a".repeat(64) });
export const feature = (over) => ({
  id: "f1", title: "Orders dashboard", kind: "page-override", path: "/orders", ownerUserId: "alice", everyone: false, userIds: [],
  currentVersion: "1.1.0", versions: [version("1.1.0", 1), version("1.0.0", 5)], ...over,
});
