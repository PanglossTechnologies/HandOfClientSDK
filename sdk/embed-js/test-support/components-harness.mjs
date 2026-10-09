// A site server for the browser components: pages that host each element, plus the fake `hoc/api/*`.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createFakeSite } from "./fake-site.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const page = (title, inner, extra = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{margin:0;padding:12px;font-family:sans-serif} #secret{color:#333}${extra}</style></head>
<body><p id="secret">Customer Jane Q. Public paid 4412 dollars</p>${inner}
<script src="/embed.global.js"></script>
<script>HandOfClient.configure({ apiBaseUrl: "http://unused.invalid", embedOrigin: "http://unused.invalid", sitePrefix: "/hoc/" });</script>
</body></html>`;

export async function startComponentsHarness() {
  const embedGlobal = await readFile(path.join(root, "dist/embed.global.js"));
  const fake = createFakeSite();
  const pages = {
    "/request": () => page("request", "<hoc-request-feature></hoc-request-feature>"),
    "/request-change": () => page("request-change", '<hoc-request-feature feature-id="f1"></hoc-request-feature>'),
    "/request-nosnap": () => page("request-nosnap", '<hoc-request-feature snapshot="off"></hoc-request-feature>'),
    "/mine": () => page("mine", "<hoc-my-features></hoc-my-features>"),
    "/admin": () => page("admin", "<hoc-feature-admin></hoc-feature-admin>"),
    "/themed": () => page("themed", "<hoc-request-feature></hoc-request-feature>", "hoc-request-feature{--hoc-accent:rgb(200,30,30);--hoc-radius:0px}"),
    "/fn": () => page("fn", '<div id="a"></div><div id="b"></div>'),
  };
  const server = createServer(async (req, res) => {
    if (await fake.handle(req, res)) return;
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/embed.global.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end(embedGlobal);
    }
    const render = pages[url.pathname];
    if (render) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(render());
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { fake, origin, siteUrl: (p) => `${origin}${p}`, close: () => server.close() };
}
