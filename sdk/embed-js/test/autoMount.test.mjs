// Real-browser tests for page lookup (autoMount), per-feature tokens, the inject loader, full-window
// iframe pages and hoc-head.js. Each test runs at a desktop and an iPhone viewport (same test code).
// Needs `npm run build` first (uses dist/). Run: node --test "test/**/*.test.mjs"
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chromium, devices } from "playwright-core";
import { startHarness } from "../test-support/harness.mjs";

let harness;
let browser;

before(async () => {
  harness = await startHarness();
  // Playwright's own Chromium when its revision is installed, else the machine's Chrome.
  try {
    browser = await chromium.launch();
  } catch (error) {
    console.warn("bundled chromium unavailable, using installed Chrome:", error.message.split("\n")[0]);
    browser = await chromium.launch({ channel: "chrome" });
  }
});

after(async () => {
  await browser?.close();
  harness?.close();
});

const viewports = [
  { name: "desktop", options: { viewport: { width: 1920, height: 1080 } } },
  { name: "iPhone", options: { ...devices["iPhone 13"] } },
];

for (const vp of viewports) {
  describe(`autoMount @ ${vp.name}`, () => {
    let context;

    before(async () => {
      context = await browser.newContext(vp.options);
    });
    after(async () => {
      await context.close();
    });

    /** Opens a scenario page and waits for autoMount to finish. */
    async function open(route) {
      const page = await context.newPage();
      const messages = [];
      page.on("console", (m) => messages.push(m.text()));
      await page.goto(harness.siteUrl(route));
      await page.waitForFunction(() => window.__result !== undefined, null, { timeout: 8000 });
      return { page, messages };
    }
    const result = (page) => page.evaluate(() => window.__result);
    const originalFrames = (page) => page.evaluate(() => window.__frames.originalVisible);
    const bodyVisible = (page) => page.evaluate(() => getComputedStyle(document.body).visibility === "visible");

    test("inject: bundle runs with the host handoff, token minted per feature, no flash of the original", async () => {
      harness.log.tokenRequests.length = 0;
      const { page } = await open("/inject");
      assert.deepEqual((await result(page)).applied, ["f-inject"]);
      assert.equal(
        await page.locator("#content").textContent(),
        "INJECTED f-inject user=user-7 host=host-1 tenant=tenant-9",
      );
      assert.ok(harness.log.tokenRequests.some((q) => q === "?featureId=f-inject"), `token requests: ${harness.log.tokenRequests}`);
      assert.equal(await originalFrames(page), 0, "original page was visible before the feature applied");
      assert.ok(await bodyVisible(page));
      await page.close();
    });

    test("control: without hoc-head.js the original does flash (proves the detector works)", async () => {
      const { page } = await open("/inject-noguard");
      assert.ok((await originalFrames(page)) > 0);
      await page.close();
    });

    test("iframe page-override: full-window iframe replaces the page, no flash", async () => {
      const { page } = await open("/override");
      assert.deepEqual((await result(page)).applied, ["f-override"]);
      const frame = page.frameLocator("[data-hoc-page-frame] iframe");
      await frame.locator("#msg").waitFor();
      assert.match(await frame.locator("#msg").textContent(), /IFRAME user-7 host=host-1 tenant=tenant-9/);
      assert.equal(await page.locator("#content").isVisible(), false);
      const box = await page.locator("[data-hoc-page-frame] iframe").boundingBox();
      const viewport = page.viewportSize();
      assert.ok(box.width >= viewport.width - 1 && box.height >= viewport.height - 1, `iframe ${box.width}x${box.height} vs ${viewport.width}x${viewport.height}`);
      assert.equal(await originalFrames(page), 0);
      assert.ok(await bodyVisible(page));
      await page.close();
    });

    test("hoc:navigate from a full-window iframe moves the host page (same origin only)", async () => {
      const { page, messages } = await open("/override");
      const frame = page.frameLocator("[data-hoc-page-frame] iframe");
      await frame.locator("#go-evil").click();
      await page.waitForTimeout(300);
      assert.equal(new URL(page.url()).pathname, "/override", "cross-origin navigate must be ignored");
      assert.ok(messages.some((m) => m.includes("ignoring hoc:navigate to another origin")));
      await frame.locator("#go-plain").click();
      await page.waitForURL("**/plain");
      await page.waitForFunction(() => window.__result !== undefined);
      assert.equal(await page.locator("#content").isVisible(), true, "original shows on the page without a feature");
      await page.close();
    });

    test("new-page: catch-all empty page is filled by a full-window iframe", async () => {
      const { page } = await open("/ext/hello");
      assert.deepEqual((await result(page)).applied, ["f-newpage"]);
      await page.frameLocator("[data-hoc-page-frame] iframe").locator("#msg").waitFor();
      await page.close();
    });

    test("slot (iframe): mounted into the declared element", async () => {
      const { page } = await open("/slot");
      assert.deepEqual((await result(page)).applied, ["f-slot"]);
      await page.frameLocator("#slot iframe").locator("#msg").waitFor();
      assert.equal(await page.locator("#content").isVisible(), true, "slot features leave the page in place");
      await page.close();
    });

    test("slot (inject): script receives the slot element", async () => {
      const { page } = await open("/slot-inject");
      assert.deepEqual((await result(page)).applied, ["f-slot-inject"]);
      assert.match(await page.locator("#slot").textContent(), /^INJECTED f-slot-inject/);
      await page.close();
    });

    test("slot feature with no element on the page: reported, original shows", async () => {
      const { page } = await open("/noslot");
      const r = await result(page);
      assert.deepEqual(r.applied, []);
      assert.deepEqual(r.failed, ["no-slot"]);
      assert.match(await page.locator("#content").textContent(), /ORIGINAL/);
      assert.ok(await bodyVisible(page));
      await page.close();
    });

    test("no feature: original shows immediately", async () => {
      const { page } = await open("/plain");
      assert.deepEqual(await result(page), { applied: [], failed: [], loadTimedOut: false });
      assert.match(await page.locator("#content").textContent(), /ORIGINAL/);
      assert.ok(await bodyVisible(page));
      await page.close();
    });

    test("resolve answers 401: original shows, failure reported", async () => {
      const { page } = await open("/unauth");
      assert.deepEqual((await result(page)).failed, ["resolve-failed"]);
      assert.ok(await bodyVisible(page));
      await page.close();
    });

    test("resolve slower than timeoutMs: original shows and the late answer is ignored", async () => {
      const started = Date.now();
      const { page } = await open("/slow");
      const elapsed = Date.now() - started;
      assert.deepEqual((await result(page)).failed, ["timeout"]);
      assert.match(await page.locator("#content").textContent(), /ORIGINAL/);
      assert.ok(await bodyVisible(page));
      assert.ok(elapsed < 2000, `revealed after ${elapsed}ms`);
      await page.close();
    });

    test("inject with a sha256 that does not match: not run, original shows", async () => {
      const { page } = await open("/badhash");
      assert.deepEqual((await result(page)).failed, ["inject-load-failed"]);
      assert.match(await page.locator("#content").textContent(), /ORIGINAL/);
      assert.ok(await bodyVisible(page));
      await page.close();
    });

    test("full-window iframe that never becomes ready: given up after loadTimeoutMs, original restored", async () => {
      const { page } = await open("/stuck");
      const r = await result(page);
      assert.equal(r.loadTimedOut, true);
      assert.deepEqual(r.failed, ["timeout"]);
      assert.equal(await page.locator("[data-hoc-page-frame]").count(), 0);
      assert.equal(await page.locator("#content").isVisible(), true);
      assert.match(await page.locator("#content").textContent(), /ORIGINAL/);
      await page.close();
    });

    test("page CSP blocks the script: clear csp-blocked error naming the origin", async () => {
      const { page } = await open("/csp");
      const errors = await page.evaluate(() => window.__errors);
      assert.equal(errors[0].reason, "csp-blocked");
      assert.ok(errors[0].message.includes(harness.embedOrigin()), errors[0].message);
      assert.match(await page.locator("#content").textContent(), /ORIGINAL/);
      assert.ok(await bodyVisible(page));
      await page.close();
    });

    test("legacy mount(): token URL has no featureId; featureId is added only when given", async () => {
      const { page } = await open("/plain");
      harness.log.tokenRequests.length = 0;
      const outcome = await page.evaluate(async () => {
        const base = { hostId: "h", tenantId: "t", packageId: "p/x", slotId: "s", tokenUrl: "hoc/token", locale: "en", theme: {} };
        const reasons = [];
        for (const extra of [{}, { featureId: "f-9" }]) {
          try {
            await HandOfClient.mount(document.body, { ...base, ...extra });
          } catch (error) {
            reasons.push(error.reason);
          }
        }
        return reasons;
      });
      assert.deepEqual(outcome, ["no-active-version", "no-active-version"]); // token fetched OK, platform lookup unavailable
      assert.deepEqual(harness.log.tokenRequests, ["", "?featureId=f-9"]);
      await page.close();
    });
  });
}
