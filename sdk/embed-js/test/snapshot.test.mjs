// Real-browser tests for HandOfClient.captureSnapshot: redaction, keep/skip, stylesheet inlining. Each test
// runs at a desktop and an iPhone viewport (same test code). Needs `npm run build` first (uses dist/).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium, devices } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Every string below must NOT appear in a redacted snapshot (except where a test says otherwise).
const SECRETS = [
  "Jane Q. Customer", "jane@example.com", "SECRET-ORDER-9981", "hunter2-password", "private note body",
  "Gold Plan Subscriber", "Avatar of Jane", "Close Jane panel", "SCRIPTSECRET", "COMMENTSECRET", "CSSSECRET",
  "INLINESTYLESECRET", "token=abc123", "frag-secret", "TOP SECRET PAYROLL", "Jane Orders Page", "Search customers",
  "uid-4471", "Hidden field secret", "Typed by user", "Option Alpha", "BEACON-SECRET",
];

const sitePage = (crossOriginCss) => `<!doctype html>
<html lang="en" class="theme-dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Jane Q. Customer's account"><title>Jane Orders Page</title>
<link rel="stylesheet" href="/site.css?v=3">
<link rel="stylesheet" href="${crossOriginCss}">
<link rel="icon" href="/favicon.ico?u=jane">
<style id="inline">.inline-rule { color: rgb(1, 2, 3); } /* INLINESTYLESECRET */ .banner::before { content: "INLINESTYLESECRET"; }</style>
<script>window.SCRIPTSECRET = 1;</script></head>
<body class="app">
<!-- COMMENTSECRET -->
<header class="top"><h1 class="title">Jane Q. Customer</h1><img class="avatar" src="/img/a.png?sig=BEACON-SECRET" alt="Avatar of Jane" title="Gold Plan Subscriber">
<a id="close" class="btn" href="/orders?token=abc123#frag-secret" aria-label="Close Jane panel" data-user-id="uid-4471">Order SECRET-ORDER-9981</a></header>
<main class="grid"><aside class="sidebar card">Gold Plan Subscriber</aside>
<section class="content card">
  <form class="form" action="/save?token=abc123">
    <input id="name" name="name" type="text" value="Typed by user" placeholder="Search customers">
    <input id="pw" name="pw" type="password" value="hunter2-password">
    <input id="hid" name="h" type="hidden" value="Hidden field secret">
    <input id="agree" name="agree" type="checkbox" checked>
    <textarea id="note" name="note">private note body</textarea>
    <select id="sel" name="sel"><option value="a" selected>Option Alpha</option><option value="b">Option Beta</option></select>
  </form>
  <div id="keepme" class="pricing" data-hoc-keep><h2>Public Pricing Headline</h2><p>Plans from 9 dollars</p></div>
  <div id="skipme" class="payroll" data-hoc-skip style="width:200px;height:50px">TOP SECRET PAYROLL <span>more</span></div>
</section></main>
<div class="ctn">card text inside a layout box</div>
<script>
  const s = document.getElementById("inline").sheet; s.insertRule(".added-by-cssom { padding: 7px; }", 0);
</script></body></html>`;

const SITE_CSS = `
.app { margin: 0; font: 16px/1.4 sans-serif; }
.grid { display: grid; grid-template-columns: 180px 1fr; gap: 12px; }
.sidebar { width: 180px; }
.card { background: url(img/bg.png); border: 1px solid #ccc; }
.card::after { content: 'CSSSECRET'; }
`;

let site, other, siteUrl, browser;

before(async () => {
  other = createServer((req, res) => {
    // Cross-origin stylesheet with NO CORS header: its rules are unreadable from the page.
    res.writeHead(200, { "content-type": "text/css" });
    res.end(".other-origin { color: rgb(9, 9, 9); }");
  });
  await new Promise((r) => other.listen(0, "127.0.0.1", r));
  const otherCss = `http://127.0.0.1:${other.address().port}/theme.css?family=Inter`;
  const embedGlobal = await readFile(path.join(root, "dist/embed.global.js"));
  site = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (type, body) => { res.writeHead(200, { "content-type": type }); res.end(body); };
    if (url.pathname === "/embed.global.js") return send("text/javascript", embedGlobal);
    if (url.pathname === "/site.css") return send("text/css", SITE_CSS);
    if (url.pathname === "/orders") return send("text/html", sitePage(otherCss));
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  siteUrl = `http://127.0.0.1:${site.address().port}`;
  try {
    browser = await chromium.launch();
  } catch (error) {
    console.warn("bundled chromium unavailable, using installed Chrome:", error.message.split("\n")[0]);
    browser = await chromium.launch({ channel: "chrome" });
  }
});

after(async () => {
  await browser?.close();
  site?.close();
  other?.close();
});

const viewports = [
  { name: "desktop", options: { viewport: { width: 1920, height: 1080 } } },
  { name: "iPhone", options: { ...devices["iPhone 13"] } },
];

for (const vp of viewports) {
  describe(`captureSnapshot @ ${vp.name}`, () => {
    let context;
    before(async () => {
      context = await browser.newContext(vp.options);
    });
    after(async () => {
      await context.close();
    });

    /** Opens the sample page, types into the name field, and captures with the given options. */
    async function capture(options) {
      const page = await context.newPage();
      await page.goto(`${siteUrl}/orders?token=abc123#frag-secret`);
      await page.addScriptTag({ url: "/embed.global.js" });
      await page.fill("#name", "Typed by user");
      const snapshot = await page.evaluate((o) => HandOfClient.captureSnapshot(o), options);
      return { page, snapshot };
    }

    test("redacted by default: no original text, form values, titles, query strings or comments survive", async () => {
      const { page, snapshot } = await capture(undefined);
      const haystack = JSON.stringify(snapshot);
      for (const secret of SECRETS) assert.ok(!haystack.includes(secret), `leaked: ${secret}`);
      assert.equal(snapshot.redacted, true);
      assert.equal(snapshot.url, `${siteUrl}/orders`);
      assert.equal(snapshot.path, "/orders");
      assert.equal(snapshot.title, "xxxx xxxxxx xxxx", "title is a same-length placeholder");
      assert.equal(snapshot.viewport.width, await page.evaluate(() => window.innerWidth));
      assert.ok(snapshot.viewport.height > 0 && snapshot.viewport.devicePixelRatio >= 1);
      await page.close();
    });

    test("redaction keeps structure: same-length text, classes, ids, names, whitespace", async () => {
      const { page, snapshot } = await capture({ redact: true });
      const doc = await page.evaluate((html) => {
        const d = new DOMParser().parseFromString(html, "text/html");
        const q = (s) => d.querySelector(s);
        return {
          title: q("h1.title")?.textContent,
          gridClass: q("main")?.className,
          cardCount: d.querySelectorAll(".card").length,
          link: q("#close")?.getAttribute("href"),
          linkData: q("#close")?.getAttribute("data-user-id"),
          linkAria: q("#close")?.getAttribute("aria-label"),
          avatarAlt: q(".avatar")?.getAttribute("alt"),
          avatarSrc: q(".avatar")?.getAttribute("src"),
          bodyClass: d.body.className,
          htmlClass: d.documentElement.className,
          fieldName: q("#name")?.getAttribute("name"),
          viewportMeta: q('meta[name="viewport"]')?.getAttribute("content"),
          descriptionMeta: !!q('meta[name="description"]'),
          scripts: d.querySelectorAll("script").length,
          base: q("base")?.getAttribute("href"),
        };
      }, snapshot.html);
      assert.equal(doc.title, "xxxx xx xxxxxxxx");
      assert.equal(doc.gridClass, "grid");
      assert.equal(doc.cardCount, 2);
      assert.equal(doc.link, "/orders", "query string and fragment stripped");
      assert.equal(doc.linkData, "xxxxxxxx", "data-* values redacted");
      assert.equal(doc.linkAria, "xxxxx xxxx xxxxx");
      assert.equal(doc.avatarAlt, "xxxxxx xx xxxx");
      assert.equal(doc.avatarSrc, "/img/a.png");
      assert.equal(doc.bodyClass, "app");
      assert.equal(doc.htmlClass, "theme-dark");
      assert.equal(doc.fieldName, "name", "field names are structure, not values");
      assert.equal(doc.viewportMeta, "width=device-width, initial-scale=1");
      assert.equal(doc.descriptionMeta, false, "free-text meta dropped");
      assert.equal(doc.scripts, 0);
      assert.equal(doc.base, `${siteUrl}/orders`);
      await page.close();
    });

    test("data-hoc-keep subtree is verbatim; data-hoc-skip subtree is gone but keeps its box", async () => {
      const { page, snapshot } = await capture({ redact: true });
      assert.ok(snapshot.html.includes("Public Pricing Headline"));
      assert.ok(snapshot.html.includes("Plans from 9 dollars"));
      assert.ok(!snapshot.html.includes("TOP SECRET PAYROLL"));
      assert.ok(!snapshot.html.includes("more</span>"));
      const skipped = await page.evaluate((html) => {
        const el = new DOMParser().parseFromString(html, "text/html").querySelector("[data-hoc-skipped]");
        return el && { tag: el.localName, cls: el.className, style: el.getAttribute("style"), children: el.childNodes.length };
      }, snapshot.html);
      assert.deepEqual(skipped, { tag: "div", cls: "payroll", style: "width:200px;height:50px", children: 0 });
      await page.close();
    });

    test("stylesheets: readable ones inlined (incl. CSSOM-inserted rules and url() made absolute), unreadable left by URL", async () => {
      const { page, snapshot } = await capture({ redact: true });
      const css = await page.evaluate((html) => [...new DOMParser().parseFromString(html, "text/html").querySelectorAll("style")].map((s) => s.textContent).join("\n"), snapshot.html);
      assert.match(css, /\.grid\s*\{[^}]*display:\s*grid/, "linked sheet inlined");
      assert.match(css, /\.inline-rule/, "<style> element inlined");
      assert.match(css, /\.added-by-cssom/, "rule added through the CSSOM is captured");
      assert.ok(css.includes(`${siteUrl}/img/bg.png`), "relative url() resolved against the sheet");
      assert.ok(!css.includes("CSSSECRET") && !css.includes("INLINESTYLESECRET"), "content: strings redacted");
      assert.equal(snapshot.stylesheets.inlined, 2);
      assert.equal(snapshot.stylesheets.byUrl.length, 1);
      assert.match(snapshot.stylesheets.byUrl[0], /\/theme\.css\?family=Inter$/, "unreadable sheet referenced by URL, query kept");
      assert.ok(snapshot.html.includes(`href="${snapshot.stylesheets.byUrl[0]}"`));
      await page.close();
    });

    test("fidelity: the snapshot renders with the same layout (grid, fixed-width sidebar)", async () => {
      const { page, snapshot } = await capture({ redact: true });
      const original = await page.evaluate(() => ({
        sidebar: document.querySelector(".sidebar").getBoundingClientRect().width,
        display: getComputedStyle(document.querySelector("main")).display,
      }));
      const copy = await context.newPage();
      await copy.goto(`${siteUrl}/orders`); // same origin so relative references resolve; then replace the document
      await copy.evaluate((html) => { document.open(); document.write(html); document.close(); }, snapshot.html);
      await copy.waitForLoadState("load");
      const rendered = await copy.evaluate(() => ({
        sidebar: document.querySelector(".sidebar").getBoundingClientRect().width,
        display: getComputedStyle(document.querySelector("main")).display,
      }));
      assert.equal(rendered.display, original.display);
      assert.equal(rendered.sidebar, original.sidebar);
      await copy.close();
      await page.close();
    });

    test("redact:false keeps text, URLs and typed values; password, scripts, comments still never captured; skip still honoured", async () => {
      const { page, snapshot } = await capture({ redact: false });
      assert.equal(snapshot.redacted, false);
      assert.equal(snapshot.title, "Jane Orders Page");
      assert.ok(snapshot.url.endsWith("/orders?token=abc123#frag-secret"));
      for (const keep of ["Jane Q. Customer", "Order SECRET-ORDER-9981", "Typed by user", "private note body", "Gold Plan Subscriber", "Search customers", "token=abc123", "Option Alpha"]) {
        assert.ok(snapshot.html.includes(keep), `expected unredacted: ${keep}`);
      }
      const state = await page.evaluate((html) => {
        const d = new DOMParser().parseFromString(html, "text/html");
        return { agree: d.querySelector("#agree").hasAttribute("checked"), selected: d.querySelector("option[selected]")?.textContent, pw: d.querySelector("#pw").getAttribute("value") };
      }, snapshot.html);
      assert.equal(state.agree, true);
      assert.equal(state.selected, "Option Alpha");
      assert.equal(state.pw, null, "password value is never captured, even with redaction off");
      for (const never of ["hunter2-password", "SCRIPTSECRET", "COMMENTSECRET", "TOP SECRET PAYROLL"]) assert.ok(!snapshot.html.includes(never), `captured: ${never}`);
      await page.close();
    });
  });
}
