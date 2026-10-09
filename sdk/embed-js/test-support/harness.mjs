// Two real HTTP servers, like production: the customer's "site" (pages, hoc/token, hoc/api/resolve) and
// the platform "embed" origin (bundles under /embed/{packageIdB64}/{version}/{path}, with CORS).
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const b64url = (value) => Buffer.from(value).toString("base64url");

function fakeJwt(claims) {
  return `${b64url(JSON.stringify({ alg: "none" }))}.${b64url(JSON.stringify(claims))}.sig`;
}

export async function startHarness() {
  const embedGlobal = await readFile(path.join(root, "dist/embed.global.js"));
  const hocHead = await readFile(path.join(root, "dist/hoc-head.min.js"), "utf8");
  const injectPlugin = await readFile(path.join(root, "test-support/inject-plugin.js"));
  const iframePluginJs = (
    await esbuild.build({ entryPoints: [path.join(root, "test-support/iframe-plugin.ts")], bundle: true, format: "esm", write: false, target: "es2022" })
  ).outputFiles[0].text;
  const injectSha = createHash("sha256").update(injectPlugin).digest("hex");

  const log = { tokenRequests: [], resolveRequests: [] };
  let embedPort = 0;
  const embedOrigin = () => `http://localhost:${embedPort}`;

  const feature = (over) => ({
    featureId: "f1", kind: "page-override", mode: "inject", slotId: "main-panel", path: null,
    packageId: "acme/f-1", version: "1.0.0", sha256: injectSha, entry: "index.js", ...over,
  });
  const iframeFeature = (over) => feature({ mode: "iframe", entry: "index.html", sha256: "unused", ...over });

  // route -> { features, delayMs?, status?, guard (default true), csp?, slot?, emptyPage?, timeoutMs?, loadTimeoutMs? }
  const scenarios = {
    "/inject": { features: [feature({ featureId: "f-inject" })], delayMs: 300 },
    "/inject-noguard": { features: [feature({ featureId: "f-inject" })], delayMs: 300, guard: false },
    "/override": { features: [iframeFeature({ featureId: "f-override" })], delayMs: 300 },
    "/ext/hello": { features: [iframeFeature({ featureId: "f-newpage", kind: "new-page", path: "/ext/hello" })], delayMs: 100, emptyPage: true },
    "/slot": { features: [iframeFeature({ featureId: "f-slot", kind: "slot" })], slot: true },
    "/slot-inject": { features: [feature({ featureId: "f-slot-inject", kind: "slot" })], slot: true },
    "/noslot": { features: [feature({ featureId: "f-noslot", kind: "slot" })] },
    "/plain": { features: [] },
    "/slow": { features: [feature({ featureId: "f-slow" })], delayMs: 2500, timeoutMs: 300 },
    "/unauth": { features: [], status: 401 },
    "/badhash": { features: [feature({ featureId: "f-bad", sha256: "0".repeat(64) })], delayMs: 100 },
    "/stuck": { features: [iframeFeature({ featureId: "f-stuck", entry: "stuck.html" })], loadTimeoutMs: 600 },
    "/csp": { features: [feature({ featureId: "f-csp" })], csp: "script-src 'self' 'unsafe-inline'" },
  };

  const pageHtml = (route, sc) => `<!doctype html><html><head><meta charset="utf-8"><title>${route}</title>
<script>window.__frames = { originalVisible: 0 };
(function sample() {
  var c = document.getElementById("content");
  if (c && document.body && getComputedStyle(document.body).visibility !== "hidden" && getComputedStyle(c).display !== "none" && c.textContent.indexOf("ORIGINAL") >= 0) window.__frames.originalVisible++;
  requestAnimationFrame(sample);
})();</script>
${sc.guard === false ? "" : `<script>${hocHead}</script>`}
</head><body>${sc.emptyPage ? "" : `<div id="content">ORIGINAL PAGE ${route}</div>`}
${sc.slot ? '<div data-hoc-slot="main-panel" id="slot" style="height:120px">EMPTY SLOT</div>' : ""}
<script src="/embed.global.js"></script>
<script>
HandOfClient.configure({ apiBaseUrl: "${embedOrigin()}", embedOrigin: "${embedOrigin()}", sitePrefix: "/hoc/" });
HandOfClient.autoMount({ timeoutMs: ${sc.timeoutMs ?? 1500}, loadTimeoutMs: ${sc.loadTimeoutMs ?? 3000}, onError: function (e, f) { (window.__errors = window.__errors || []).push({ reason: e.reason, message: e.message, feature: f && f.featureId }); } })
  .then(function (r) { window.__result = { applied: r.applied.map(function (f) { return f.featureId; }), failed: r.failed.map(function (x) { return x.error.reason; }), loadTimedOut: r.loadTimedOut }; });
</script></body></html>`;

  const site = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (status, type, body, headers = {}) => { res.writeHead(status, { "content-type": type, ...headers }); res.end(body); };
    if (url.pathname === "/embed.global.js") return send(200, "text/javascript", embedGlobal);
    if (url.pathname === "/hoc/token") {
      log.tokenRequests.push(url.search);
      const featureId = url.searchParams.get("featureId");
      return send(200, "application/json", JSON.stringify({
        token: fakeJwt({ sub: "user-7", hid: "host-1", tid: "tenant-9", pkg: "acme/f-1", ver: "1.0.0", slot: "main-panel" }),
        expiresAt: new Date(Date.now() + 480000).toISOString(), userId: "user-7", displayName: featureId ? `for ${featureId}` : undefined,
      }));
    }
    if (url.pathname === "/hoc/api/resolve") {
      const route = url.searchParams.get("path");
      log.resolveRequests.push(route);
      const sc = scenarios[route] ?? { features: [] };
      await new Promise((r) => setTimeout(r, sc.delayMs ?? 0));
      if (sc.status) return send(sc.status, "application/json", JSON.stringify({ error: "unauthenticated", message: "no" }));
      return send(200, "application/json", JSON.stringify({ path: route, features: sc.features }));
    }
    const sc = scenarios[url.pathname];
    if (sc) return send(200, "text/html", pageHtml(url.pathname, sc), sc.csp ? { "content-security-policy": sc.csp } : {});
    send(404, "text/plain", "not found");
  });

  const embed = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const cors = { "access-control-allow-origin": "*" };
    const m = url.pathname.match(/^\/embed\/[^/]+\/[^/]+\/(.+)$/);
    const serve = (type, body) => { res.writeHead(200, { "content-type": type, ...cors }); res.end(body); };
    if (m && m[1] === "index.js") return serve("text/javascript", injectPlugin);
    if (m && m[1] === "index.html") return serve("text/html", '<!doctype html><body><script type="module" src="plugin.js"></script></body>');
    if (m && m[1] === "stuck.html") return serve("text/html", "<!doctype html><body>never says hello</body>");
    if (m && m[1] === "plugin.js") return serve("text/javascript", iframePluginJs);
    res.writeHead(404, cors);
    res.end();
  });

  await new Promise((r) => embed.listen(0, "127.0.0.1", r));
  embedPort = embed.address().port;
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const sitePort = site.address().port;

  return {
    siteUrl: (p) => `http://127.0.0.1:${sitePort}${p}`,
    embedOrigin,
    log,
    close: () => { site.close(); embed.close(); },
  };
}
