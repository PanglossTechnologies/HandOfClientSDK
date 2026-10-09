// HTTP helpers: a signed-in browser (cookie identity) against the module under test, and the control API of
// the fake platform. Plain fetch, no dependencies.
import { profile, SESSION_COOKIE, USERS } from "./profile.mjs";

async function send(url, { method = "GET", headers = {}, body, rawBody } = {}) {
  const init = { method, headers: { ...headers }, redirect: "manual" };
  if (rawBody !== undefined) init.body = rawBody;
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers["content-type"] = "application/json"; }
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, body: json, text, headers: res.headers };
}

function withQuery(path, query) {
  if (!query) return path;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) for (const x of Array.isArray(v) ? v : [v]) if (x !== undefined) q.append(k, x);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/** A browser signed in as `userId` (a key of USERS, a raw user id, or null for no session). Paths are relative to the module's prefix. */
export function as(user, extraHeaders = {}) {
  const id = user === null ? null : (USERS[user]?.id ?? user);
  const cookie = { ...(id === null ? {} : { cookie: `${SESSION_COOKIE}=${id}` }), ...extraHeaders };
  const url = (path, query) => `${profile.baseUrl()}/${withQuery(path.replace(/^\//, ""), query)}`;
  return {
    get: (path, query) => send(url(path, query), { headers: cookie }),
    post: (path, body, query) => send(url(path, query), { method: "POST", headers: cookie, body }),
    put: (path, body) => send(url(path), { method: "PUT", headers: cookie, body }),
    del: (path) => send(url(path), { method: "DELETE", headers: cookie }),
    /** Send a raw string body (for malformed-JSON and oversize tests). */
    postRaw: (path, rawBody) => send(url(path), { method: "POST", headers: { ...cookie, "content-type": "application/json" }, rawBody }),
  };
}

/** Control client for the fake platform. */
export const platform = {
  call: (method, path, body) => send(`${profile.platformControlUrl()}${path}`, { method, body }).then((r) => {
    if (r.status >= 400) throw new Error(`fake platform ${method} ${path} -> ${r.status} ${r.text}`);
    return r.body;
  }),
  /** All recorded /host/v1 calls (optionally only those after `since`, a seq number). */
  async calls(since = 0) { return (await this.call("GET", `/_fake/calls?since=${since}`)).calls; },
  /** Highest call seq so far, to scope later `calls(since)` queries to "what happened because of my action". */
  async mark() { const all = await this.calls(); return all.length ? all[all.length - 1].seq : 0; },
  /** Poll for a recorded call matching `predicate` (the module may call the platform asynchronously). */
  async waitForCall(predicate, { since = 0, timeoutMs = 8000 } = {}) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const hit = (await this.calls(since)).find(predicate);
      if (hit) return hit;
      if (Date.now() > end) return null;
      await new Promise((r) => setTimeout(r, 100));
    }
  },
  /** Make the next `times` calls whose "METHOD /path" matches the regex string fail with `status` (or drop the connection). */
  failNext: (match, status = 500, times = 1, drop = false) => platform.call("POST", "/_fake/failures", { match, status, times, drop }),
  clearFailures: () => platform.call("DELETE", "/_fake/failures"),
  publish: (o) => platform.call("POST", "/_fake/publish", o),
  status: (o) => platform.call("POST", "/_fake/status", o),
  withdraw: (packageId, version) => platform.call("POST", "/_fake/withdraw", { packageId, version }),
  /** Deliver an arbitrary webhook; sign it (default), sign with another secret/signature, or omit the signature. */
  deliver: (o) => platform.call("POST", "/_fake/deliver", o),
  state: () => platform.call("GET", "/_fake/state"),
  builds: async () => (await platform.call("GET", "/_fake/builds")).builds,
};
