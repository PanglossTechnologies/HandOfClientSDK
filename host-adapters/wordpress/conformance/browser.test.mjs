// Real-browser test of the WordPress plugin against the fake platform, at a desktop and an iPhone viewport (same code).
// A throwaway WordPress (see wp-instance.mjs) with real WordPress users and real wp-login sign-in:
//   request box -> built -> the page changes for the requester only -> My features -> wp-admin screens.
//
// Needs: Node 20+, `npm install` at the repo root (playwright-core), Chrome, and the dev harness
// (`node host-adapters/wordpress/devharness/setup.mjs`, once) plus `node host-adapters/wordpress/build.mjs`
// so the plugin has embed.global.js.
//   node --test host-adapters/wordpress/conformance/browser.test.mjs
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright-core";
import { freePort, startWordPress } from "./wp-instance.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeCli = path.resolve(here, "../../../host-modules/conformance/fake-platform/cli.mjs");

const API_KEY = "browser-api-key", SECRET = "whsec_browser", TENANT = "browser-tenant", HOST = "browser-host";
const PASSWORD = "pw-browser-test";
const POST_PATH = "/hello-world/";
let wp, platform, platformProc, browser;
const ids = {}; // user login -> WordPress user id

async function waitFor(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { await fetch(url); return; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error(`${url} did not come up`);
}

before(async () => {
  wp = await startWordPress();
  const platformPort = await freePort();
  platform = `http://127.0.0.1:${platformPort}`;
  platformProc = spawn(process.execPath, [fakeCli, "--port", String(platformPort), "--api-key", API_KEY, "--webhook-secret", SECRET,
    "--webhook-url", `${wp.url}/hoc/webhook`, "--host-id", HOST, "--tenant-id", TENANT], { stdio: "inherit" });
  await waitFor(`${platform}/host/v1/jwks`);

  wp.cli(["option", "update", "hoc_settings", JSON.stringify({
    enabled: true, platform_base_url: platform, host_id: HOST, tenant_id: TENANT, api_key: API_KEY, webhook_secret: SECRET, show_dock: true,
  }), "--format=json"]);
  for (const login of ["alice", "bob"]) {
    wp.cli(["user", "create", login, `${login}@example.invalid`, "--role=subscriber", `--user_pass=${PASSWORD}`, `--display_name=${login}`]);
  }
  for (const login of ["admin", "alice", "bob"]) ids[login] = wp.cli(["user", "get", login, "--field=ID"]);
  try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ channel: "chrome" }); }
});

after(async () => {
  await browser?.close();
  platformProc?.kill();
  await wp?.stop();
});

const viewports = [
  { name: "desktop", requester: "alice", other: "bob", options: { viewport: { width: 1920, height: 1080 } } },
  { name: "iPhone", requester: "bob", other: "alice", options: { ...devices["iPhone 13"] } },
];

/** Signs in through the real wp-login.php form and returns the page plus every console/page error it will see. */
async function signIn(context, login, password = PASSWORD) {
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const problems = [];
  page.on("console", (m) => {
    if ((m.type() === "error" || /Content Security Policy|Refused to/.test(m.text())) && !/favicon|ViewTransition/.test(m.location().url + m.text())) problems.push(m.text());
  });
  // WordPress's own cross-document view transitions (the block themes) abort when a click navigates mid-transition; not ours.
  page.on("pageerror", (e) => { if (!/ViewTransition/.test(String(e))) problems.push(String(e)); });
  await page.goto(`${wp.url}/wp-login.php`);
  await page.locator("#user_login").fill(login);
  await page.locator("#user_pass").fill(password);
  await page.locator("#wp-submit").click();
  await page.waitForURL(/wp-admin/);
  return { page, problems };
}

/** From wherever the user is (wp-admin), click through to the site's home page and then the sample post. */
async function openPost(page) {
  await page.locator("#wp-admin-bar-site-name > a").first().click(); // "Visit Site" in the admin bar
  await page.getByRole("link", { name: "Hello world!" }).first().click();
  await page.waitForURL(`**${POST_PATH}`);
}

const banner = (user) => `Custom view built for ${user}`;
// What a built feature does: edit the page in place (inject mode hands the bundle `window.HandOfClientInject.pending`).
const bundle = (user) => `const ctx = window.HandOfClientInject.pending;
const p = document.createElement("p"); p.id = "custom-banner"; p.textContent = ${JSON.stringify(banner(user))};
document.querySelector("h1").after(p);\n`;

async function publishFor(login) {
  const calls = await (await fetch(`${platform}/_fake/calls`)).json();
  const list = Array.isArray(calls) ? calls : calls.calls;
  const mine = list.filter((c) => c.method === "POST" && c.path === "/host/v1/builds" && c.body?.user?.id === ids[login]).pop();
  assert.ok(mine?.body.requestRef, `a build for ${login} (WordPress user ${ids[login]}) should exist`);
  const res = await fetch(`${platform}/_fake/publish`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestRef: mine.body.requestRef, version: "1.0.0", path: POST_PATH, kind: "page-override", mode: "inject", content: bundle(login) }),
  });
  assert.equal(res.status, 200);
}

/** wp-admin: open the HandOfClient menu entry `item`, using the mobile menu toggle when the sidebar is hidden. */
async function openHocAdminPage(page, item) {
  const sidebar = page.locator("#adminmenuwrap");
  if (!(await sidebar.isVisible())) await page.locator("#wp-admin-bar-menu-toggle > a").click();
  await page.locator("#toplevel_page_hoc-root > a").click();
  await page.locator("#toplevel_page_hoc-root").getByRole("link", { name: item, exact: true }).click();
}

for (const vp of viewports) {
  describe(`wordpress @ ${vp.name}`, () => {
    test("request -> built -> only the requester sees the change", async () => {
      const me = await browser.newContext(vp.options);
      const { page, problems } = await signIn(me, vp.requester);

      await openPost(page);
      assert.equal(await page.locator("#custom-banner").count(), 0, "nothing built yet");

      // the dock is a real, pressable control on this viewport
      await page.getByRole("button", { name: "Request a feature" }).click();
      const panel = await page.locator("#hoc-dock-panel").boundingBox();
      assert.ok(panel && panel.x >= 0 && panel.x + panel.width <= page.viewportSize().width, `the dock panel fits the ${vp.name} viewport`);
      await page.locator("hoc-request-feature textarea").fill(`Show a banner for ${vp.requester}`);
      await page.getByRole("button", { name: "Send request" }).click();
      await page.getByRole("heading", { name: "Request received" }).waitFor();

      await publishFor(vp.requester);

      // My features lists it
      try {
        await page.locator("hoc-my-features").getByText(`Show a banner for ${vp.requester}`).first().waitFor({ timeout: 15000 });
      } catch (error) {
        throw new Error(`My features did not list the request. It shows: ${JSON.stringify(await page.locator("hoc-my-features").evaluate((el) => (el.shadowRoot ?? el).textContent))}; page problems: ${JSON.stringify(problems)}`, { cause: error });
      }

      // a fresh page load applies it: back to the dashboard, then through the site to the post again
      await page.goto(`${wp.url}/wp-admin/profile.php`);
      await openPost(page);
      await page.locator("#custom-banner").waitFor({ timeout: 15000 });
      assert.equal(await page.locator("#custom-banner").textContent(), banner(vp.requester));
      assert.equal(await page.locator("body").evaluate((b) => getComputedStyle(b).visibility), "visible", "hoc-head.js revealed the body");

      // the other user sees the original page
      const them = await browser.newContext(vp.options);
      const other = await signIn(them, vp.other);
      await openPost(other.page);
      await other.page.getByRole("button", { name: "Request a feature" }).waitFor();
      await other.page.waitForTimeout(2500); // longer than autoMount's lookup + load timeouts
      const seen = await other.page.locator("#custom-banner").allTextContents();
      assert.ok(!seen.includes(banner(vp.requester)), `${vp.other} must not see ${vp.requester}'s change`);
      assert.deepEqual(other.problems, [], "no console errors for the other user");

      assert.deepEqual(problems, [], "no console errors for the requester");
      await me.close();
      await them.close();
    });

    test("admin screens in wp-admin", async () => {
      const ctx = await browser.newContext(vp.options);
      const { page, problems } = await signIn(ctx, "admin", "hocadmin");

      await openHocAdminPage(page, "Request a Feature");
      await page.locator("hoc-request-feature textarea").waitFor({ timeout: 15000 });
      await page.getByRole("button", { name: "Send request" }).waitFor();

      await openHocAdminPage(page, "Feature admin");
      await page.locator("hoc-feature-admin").getByRole("heading", { name: "Settings" }).waitFor({ timeout: 15000 });

      await openHocAdminPage(page, "Settings");
      await page.getByText(`${wp.url}/hoc/webhook`).waitFor();
      await page.getByText("Ready", { exact: true }).waitFor();

      assert.deepEqual(problems, []);
      await ctx.close();
    });

    test("signed-out visitors and non-admins get nothing", async () => {
      const anon = await browser.newContext(vp.options);
      const page = await anon.newPage();
      await page.goto(`${wp.url}/`);
      await page.getByRole("link", { name: "Hello world!" }).first().click();
      await page.waitForURL(`**${POST_PATH}`);
      assert.equal(await page.locator("#hoc-dock").count(), 0, "no dock when signed out");
      assert.equal(await page.evaluate(() => typeof window.HandOfClient), "undefined", "embed.js is not even loaded when signed out");
      assert.equal((await fetch(`${wp.url}/hoc/api/features`)).status, 401);
      assert.equal((await fetch(`${wp.url}/hoc/api/resolve?path=${POST_PATH}`)).status, 401);
      await anon.close();

      // a subscriber may not open the admin screens, and the admin API refuses them
      const sub = await browser.newContext(vp.options);
      const { page: sp } = await signIn(sub, vp.requester);
      const denied = await sp.goto(`${wp.url}/wp-admin/admin.php?page=hoc-features`);
      assert.ok(denied.status() === 403 || /not allowed|permission/i.test(await sp.content()), "subscriber is refused the Feature admin screen");
      const settings = await sp.evaluate(async () => (await fetch("/hoc/api/settings")).status);
      assert.equal(settings, 403, "the module answers 403 to a non-admin on the admin API");
      await sub.close();
    });
  });
}
