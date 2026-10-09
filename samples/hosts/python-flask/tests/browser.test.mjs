// Real-browser test of the Flask sample against the fake platform, at a desktop and an iPhone viewport (same code).
// Proves the README's loop in a browser, under the sample's real Content-Security-Policy:
//   sign in -> request box -> built -> the page changes for the requester only -> My features -> admin page.
//
// Needs: Node 20+, `npm install` at the repo root (playwright-core), Chrome, `python fetch_assets.py`, and a Python with
// flask + handofclient (set HOC_PYTHON to its path if `python` is not it).
//   node --test samples/hosts/python-flask/tests/browser.test.mjs
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const sampleDir = path.resolve(here, "..");
const fakeCli = path.resolve(sampleDir, "../../../host-modules/conformance/fake-platform/cli.mjs");
const python = process.env.HOC_PYTHON || "python";

const API_KEY = "browser-api-key", SECRET = "whsec_browser", TENANT = "browser-tenant", HOST = "browser-host";
let sitePort, platformPort, site, platform, browser;
const children = [];

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function waitFor(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { await fetch(url); return; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error(`${url} did not come up`);
}

before(async () => {
  sitePort = await freePort();
  platformPort = await freePort();
  site = `http://127.0.0.1:${sitePort}`;
  platform = `http://127.0.0.1:${platformPort}`;
  children.push(spawn(process.execPath, [fakeCli, "--port", String(platformPort), "--api-key", API_KEY, "--webhook-secret", SECRET,
    "--webhook-url", `${site}/hoc/webhook`, "--host-id", HOST, "--tenant-id", TENANT], { stdio: "inherit" }));
  children.push(spawn(python, ["-c", `from app import create_app; create_app().run(port=${sitePort})`], {
    cwd: sampleDir, stdio: "inherit",
    env: { ...process.env, HOC_API_BASE_URL: platform, HOC_HOST_ID: HOST, HOC_TENANT_ID: TENANT, HOC_HOST_API_KEY: API_KEY,
      HOC_WEBHOOK_SECRET: SECRET, FLASK_SECRET_KEY: "browser-test", HOC_DB: path.join(process.env.TEMP || process.env.TMPDIR || ".", `hoc-sample-${sitePort}.db`) },
  }));
  await waitFor(`${platform}/host/v1/jwks`);
  await waitFor(`${site}/login`);
  try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ channel: "chrome" }); }
});

after(async () => {
  await browser?.close();
  for (const c of children) c.kill();
});

const viewports = [
  { name: "desktop", requester: "alice", other: "bob", options: { viewport: { width: 1920, height: 1080 } } },
  { name: "iPhone", requester: "bob", other: "alice", options: { ...devices["iPhone 13"] } },
];

async function signIn(browserContext, user) {
  const page = await browserContext.newPage();
  const problems = [];
  page.on("console", (m) => { if (m.type() === "error" || /Content Security Policy|Refused to/.test(m.text())) problems.push(m.text()); });
  page.on("pageerror", (e) => problems.push(String(e)));
  await page.goto(`${site}/login`);
  await page.getByLabel("Username").fill(user);
  await page.getByLabel("Password").fill("demo");
  await page.getByRole("button", { name: "Sign in" }).last().click();
  await page.waitForURL(`${site}/`);
  return { page, problems };
}

const banner = (user) => `Custom orders view built for ${user}`;
// What a built feature does: edit the page in place (inject mode hands the bundle `window.HandOfClientInject.pending`).
const bundle = (user) => `const ctx = window.HandOfClientInject.pending;
const p = document.createElement("p"); p.id = "custom-banner"; p.textContent = ${JSON.stringify(banner(user))};
document.querySelector("h1").after(p);\n`;

async function publishFor(user) {
  const calls = await (await fetch(`${platform}/_fake/calls`)).json();
  const list = Array.isArray(calls) ? calls : calls.calls;
  const mine = list.filter((c) => c.method === "POST" && c.path === "/host/v1/builds" && c.body?.user?.id === user).pop();
  const requestRef = mine?.body.requestRef;
  assert.ok(requestRef, `a build for ${user} should exist`);
  const res = await fetch(`${platform}/_fake/publish`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestRef, version: "1.0.0", path: "/orders", kind: "page-override", mode: "inject", content: bundle(user) }),
  });
  assert.equal(res.status, 200);
}

for (const vp of viewports) {
  describe(`sample @ ${vp.name}`, () => {
    test("request on Orders -> built -> only the requester sees the change", async () => {
      const me = await browser.newContext(vp.options);
      const { page, problems } = await signIn(me, vp.requester);

      await page.getByRole("navigation").getByRole("link", { name: "Orders", exact: true }).click();
      await page.getByRole("heading", { name: "Orders", level: 1 }).waitFor();
      assert.equal(await page.locator("#custom-banner").count(), 0, "nothing built yet");

      await page.locator("hoc-request-feature textarea").fill("Show a banner above the orders table");
      await page.getByRole("button", { name: "Send request" }).click();
      await page.getByRole("heading", { name: "Request received" }).waitFor();

      await publishFor(vp.requester);

      // My features shows it (clicking through the nav, as a user would)
      await page.getByRole("navigation").getByRole("link", { name: "My features" }).click();
      await page.locator("hoc-my-features").getByText("Show a banner above the orders table").first().waitFor({ timeout: 15000 });

      await page.getByRole("navigation").getByRole("link", { name: "Orders", exact: true }).click();
      await page.locator("#custom-banner").waitFor({ timeout: 15000 });
      assert.equal(await page.locator("#custom-banner").textContent(), banner(vp.requester));
      assert.equal(await page.locator("body").evaluate((b) => getComputedStyle(b).visibility), "visible", "hoc-head.js revealed the body");

      // the other user sees the original page
      const them = await browser.newContext(vp.options);
      const other = await signIn(them, vp.other);
      await other.page.getByRole("navigation").getByRole("link", { name: "Orders", exact: true }).click();
      await other.page.getByRole("heading", { name: "Orders", level: 1 }).waitFor();
      await other.page.waitForTimeout(2500); // longer than autoMount's lookup + load timeouts
      const otherBanner = await other.page.locator("#custom-banner").allTextContents();
      assert.ok(!otherBanner.includes(banner(vp.requester)), `${vp.other} must not see ${vp.requester}'s change`);
      assert.deepEqual(other.problems, [], "no CSP violations or console errors for the other user");

      assert.deepEqual(problems, [], "no CSP violations or console errors for the requester");
      await me.close();
      await them.close();
    });

    test("admin page and 404s", async () => {
      const ctx = await browser.newContext(vp.options);
      const { page, problems } = await signIn(ctx, "admin");
      await page.getByRole("navigation").getByRole("link", { name: "Admin" }).click();
      await page.locator("hoc-feature-admin").getByRole("heading", { name: "Settings" }).waitFor({ timeout: 15000 });
      assert.deepEqual(problems, []);
      const missing = await page.goto(`${site}/ext/does-not-exist`); // unknown paths get the site's own 404
      assert.equal(missing.status(), 404);
      await ctx.close();
    });
  });
}
