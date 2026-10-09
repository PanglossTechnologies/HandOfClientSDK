// Real-browser tests for <hoc-request-feature>, <hoc-my-features>, <hoc-feature-admin> and HandOfClient.features,
// against the fake site (test-support/fake-site.mjs). Every test runs at a desktop and an iPhone viewport
// (same code). Needs `npm run build` first (uses dist/).
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chromium, devices } from "playwright-core";
import { expect } from "../test-support/expect.mjs";
import { startComponentsHarness } from "../test-support/components-harness.mjs";
import { feature, version } from "../test-support/fake-site.mjs";

let harness, browser;

before(async () => {
  harness = await startComponentsHarness();
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
  { name: "desktop", phone: false, options: { viewport: { width: 1920, height: 1080 } } },
  { name: "iPhone", phone: true, options: { ...devices["iPhone 13"] } },
];

const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000).toISOString();
const request = (over) => ({
  id: "req-x", text: "Add a CSV export", status: "InProgress", message: null, featureId: null, userId: "alice", userName: "Alice Owner",
  createdAt: iso(60), updatedAt: iso(30), ...over,
});

for (const vp of viewports) {
  describe(`components @ ${vp.name}`, () => {
    let context;
    const fake = () => harness.fake;
    before(async () => {
      context = await browser.newContext(vp.options);
    });
    after(async () => {
      await context.close();
    });
    beforeEach(() => fake().reset({ features: [feature({ id: "f1" })] }));

    /** Opens a page as `user` (a cookie; the fake treats it as the signed-in session). */
    async function open(route, user = "alice", wait = "load") {
      await context.clearCookies();
      if (user) await context.addCookies([{ name: "hoc_user", value: user, url: harness.origin }]);
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      await page.goto(harness.siteUrl(route), { waitUntil: wait });
      return page;
    }
    const lastLog = (method, path) => [...fake().log].reverse().find((l) => l.method === method && l.path.startsWith(path));
    const count = (method, path) => fake().log.filter((l) => l.method === method && l.path.startsWith(path)).length;

    /** No sideways scroll and every rendered button is a comfortable touch target. */
    async function assertFits(page, selector) {
      const fits = await page.evaluate((sel) => {
        const hostEl = document.querySelector(sel);
        const buttons = [...hostEl.shadowRoot.querySelectorAll("button")].filter((b) => b.getBoundingClientRect().height > 0);
        return {
          overflow: document.documentElement.scrollWidth - window.innerWidth,
          hostOverflow: hostEl.scrollWidth - hostEl.clientWidth,
          smallest: Math.min(...buttons.map((b) => Math.min(b.getBoundingClientRect().height, b.getBoundingClientRect().width))),
        };
      }, selector);
      assert.ok(fits.overflow <= 0, `page scrolls sideways by ${fits.overflow}px`);
      assert.ok(fits.hostOverflow <= 0, `component overflows its box by ${fits.hostOverflow}px`);
      assert.ok(fits.smallest >= 43.5, `a button is only ${fits.smallest}px`);
    }

    describe("<hoc-request-feature>", () => {
      test("shows loading, then submits text and a redacted snapshot and confirms", async () => {
        fake().delayMs = 250;
        const page = await open("/request", "alice", "domcontentloaded");
        await expect(page.getByText("Loading...")).toBeVisible();
        const text = page.getByLabel("What would you like?");
        await text.fill("Please add a CSV export to the orders page");
        const submitted = page.evaluate(() => new Promise((r) => document.addEventListener("hoc-request-submitted", (e) => r(e.detail.id), { once: true })));
        await page.getByRole("button", { name: "Send request" }).click();
        await expect(page.getByRole("heading", { name: "Request received" })).toBeVisible();
        assert.match(await submitted, /^req-/);
        const sent = lastLog("POST", "requests").body;
        assert.equal(sent.text, "Please add a CSV export to the orders page");
        assert.equal(sent.featureId, undefined);
        assert.equal(sent.snapshot.redacted, true);
        assert.equal(sent.snapshot.path, "/request");
        assert.ok(!sent.snapshot.html.includes("Jane Q. Public"), "snapshot must be redacted");
        assert.ok(sent.snapshot.viewport.width > 0);
        const focusedInConfirmation = await page.evaluate(() => document.querySelector("hoc-request-feature").shadowRoot.activeElement?.dataset.key);
        assert.equal(focusedInConfirmation, "confirmation", "focus moves to the confirmation");
        await page.getByRole("button", { name: "Send another request" }).click();
        await expect(page.getByLabel("What would you like?")).toHaveValue("");
        await page.close();
      });

      test("empty text is refused locally and nothing is sent", async () => {
        const page = await open("/request");
        await page.getByRole("button", { name: "Send request" }).click();
        await expect(page.getByRole("alert")).toContainText("Please describe what you would like.");
        await expect(page.getByLabel("What would you like?")).toHaveAttribute("aria-invalid", "true");
        assert.equal(count("POST", "requests"), 0);
        await page.close();
      });

      test("works from the keyboard alone: Tab to the button and Enter, and Ctrl+Enter in the box", async () => {
        const page = await open("/request");
        const active = () => page.evaluate(() => {
          const s = document.querySelector("hoc-request-feature").shadowRoot.activeElement;
          return s ? `${s.tagName}:${s.dataset.key ?? ""}` : "none";
        });
        await expect(page.getByLabel("What would you like?")).toBeVisible();
        await page.keyboard.press("Tab");
        assert.equal(await active(), "TEXTAREA:");
        await page.keyboard.type("Keyboard only request");
        for (let i = 0; i < 6 && (await active()) !== "BUTTON:submit"; i++) await page.keyboard.press("Tab");
        assert.equal(await active(), "BUTTON:submit");
        await page.keyboard.press("Enter");
        await expect(page.getByRole("heading", { name: "Request received" })).toBeVisible();
        assert.equal(count("POST", "requests"), 1, "Enter on the button sends exactly once");
        await page.getByRole("button", { name: "Send another request" }).press("Enter");
        await page.getByLabel("What would you like?").fill("Second one");
        await page.getByLabel("What would you like?").press("Control+Enter");
        await expect(page.getByRole("heading", { name: "Request received" })).toBeVisible();
        assert.equal(count("POST", "requests"), 2);
        await page.close();
      });

      test("can target an existing feature, or be fixed to one with feature-id", async () => {
        let page = await open("/request");
        await page.getByLabel("Is this a change to something you already have?").selectOption({ label: "Change: Orders dashboard" });
        await page.getByLabel("What would you like?").fill("Make the table wider");
        await page.getByRole("button", { name: "Send request" }).click();
        await expect(page.getByRole("heading", { name: "Request received" })).toBeVisible();
        assert.equal(lastLog("POST", "requests").body.featureId, "f1");
        await page.close();

        page = await open("/request-change");
        await expect(page.getByRole("heading", { name: "Request a change" })).toBeVisible();
        assert.equal(await page.getByLabel("Is this a change to something you already have?").count(), 0);
        await page.getByLabel("What would you like?").fill("Another tweak");
        await page.getByRole("button", { name: "Send request" }).click();
        await expect(page.getByRole("heading", { name: "Request received" })).toBeVisible();
        assert.equal(lastLog("POST", "requests").body.featureId, "f1");
        await page.close();
      });

      test("the page copy is optional: untick it, or switch it off with snapshot=off", async () => {
        let page = await open("/request");
        await page.getByRole("checkbox").uncheck();
        await page.getByLabel("What would you like?").fill("No picture please");
        await page.getByRole("button", { name: "Send request" }).click();
        await expect(page.getByRole("heading", { name: "Request received" })).toBeVisible();
        assert.equal(lastLog("POST", "requests").body.snapshot, undefined);
        await page.close();

        page = await open("/request-nosnap");
        await expect(page.getByLabel("What would you like?")).toBeVisible();
        assert.equal(await page.getByRole("checkbox").count(), 0);
        await page.close();
      });

      test("a server refusal and a dropped connection both show a message, keep the text and allow a retry", async () => {
        const page = await open("/request");
        await page.getByLabel("What would you like?").fill("A big request");
        fake().failNext("POST requests", 413, "payload_too_large", "That request is too large.");
        await page.getByRole("button", { name: "Send request" }).click();
        await expect(page.getByRole("alert")).toContainText("That request is too large.");
        await expect(page.getByLabel("What would you like?")).toHaveValue("A big request");
        await expect(page.getByRole("button", { name: "Send request" })).toBeEnabled();

        await page.route("**/hoc/api/requests", (route) => route.abort());
        await page.getByRole("button", { name: "Send request" }).click();
        await expect(page.getByRole("alert")).toContainText("Could not reach the site");
        await page.unroute("**/hoc/api/requests");

        await page.getByRole("button", { name: "Send request" }).click();
        await expect(page.getByRole("heading", { name: "Request received" })).toBeVisible();
        await page.close();
      });

      test("a signed-out visitor sees the site's message", async () => {
        const page = await open("/request", null);
        await page.getByLabel("What would you like?").fill("hello");
        await page.getByRole("button", { name: "Send request" }).click();
        await expect(page.getByRole("alert")).toContainText("Please sign in first.");
        await page.close();
      });

      test("fits the screen and is themed by --hoc-* variables", async () => {
        const page = await open("/request");
        await expect(page.getByRole("button", { name: "Send request" })).toBeVisible();
        await assertFits(page, "hoc-request-feature");
        await page.close();
        const themed = await open("/themed");
        const style = await themed.getByRole("button", { name: "Send request" }).evaluate((b) => {
          const css = getComputedStyle(b);
          return { background: css.backgroundColor, radius: css.borderTopLeftRadius };
        });
        assert.equal(style.background, "rgb(200, 30, 30)");
        assert.equal(style.radius, "0px");
        await themed.close();
      });
    });

    describe("<hoc-my-features>", () => {
      test("empty and loading states", async () => {
        fake().reset({});
        fake().delayMs = 250;
        const page = await open("/mine", "alice", "domcontentloaded");
        await expect(page.getByText("Loading requests...")).toBeVisible();
        await expect(page.getByText("Loading features...")).toBeVisible();
        await expect(page.getByText("You have not asked for anything yet.")).toBeVisible();
        await expect(page.getByText("You do not have any features yet.")).toBeVisible();
        await page.close();
      });

      test("an error shows a message and Try again recovers", async () => {
        fake().failNext("GET features$", 502, "platform_unavailable", "The platform is not available right now.");
        fake().failNext("GET requests", 502, "platform_unavailable", "The platform is not available right now.");
        const page = await open("/mine");
        await expect(page.getByRole("alert")).toHaveCount(2);
        await expect(page.getByRole("alert").first()).toContainText("The platform is not available right now.");
        await page.getByRole("button", { name: "Try again" }).first().click();
        await page.getByRole("button", { name: "Try again" }).first().click();
        await expect(page.getByRole("alert")).toHaveCount(0);
        await expect(page.getByRole("heading", { name: "Orders dashboard" })).toBeVisible();
        await page.close();
      });

      test("requests show their status; a NeedsInfo question can be answered", async () => {
        fake().reset({
          features: [feature({ id: "f1" })],
          requests: [
            request({ id: "r4", text: "Dark mode", status: "Success", featureId: "f1" }),
            request({ id: "r3", text: "Delete everything", status: "Rejected", message: "That would break the site." }),
            request({ id: "r2", text: "Add a CSV export", status: "NeedsInfo", message: "Which columns should it include?" }),
            request({ id: "r1", text: "Faster page", status: "InProgress" }),
            request({ id: "other", text: "Not mine", userId: "bob" }),
          ],
        });
        const page = await open("/mine");
        await expect(page.getByText("Not mine")).toHaveCount(0);
        await expect(page.getByText("Reason: That would break the site.")).toBeVisible();
        await expect(page.getByRole("link", { name: "See where it appears" })).toHaveAttribute("href", "/orders");
        await expect(page.getByText("Which columns should it include?")).toBeVisible();

        await page.getByRole("button", { name: "Send answer" }).click();
        await expect(page.getByRole("alert")).toContainText("Please type your answer first.");
        assert.equal(count("POST", "requests/r2/reply"), 0);

        await page.getByLabel("Your answer").fill("Date, total and customer");
        await page.getByRole("button", { name: "Send answer" }).click();
        await expect(page.getByRole("button", { name: "Send answer" })).toHaveCount(0);
        assert.deepEqual(lastLog("POST", "requests/r2/reply").body, { text: "Date, total and customer" });
        await expect(page.getByText("Needs your answer")).toHaveCount(0);
        await page.close();
      });

      test("a reply the site refuses shows its message", async () => {
        fake().reset({ features: [], requests: [request({ id: "r2", status: "NeedsInfo", message: "Which columns?" })] });
        const page = await open("/mine");
        await page.getByLabel("Your answer").fill("All of them");
        fake().failNext("POST requests/r2/reply", 409, "not_awaiting_reply", "This request is not waiting for an answer.");
        await page.getByRole("button", { name: "Send answer" }).click();
        await expect(page.getByRole("alert")).toContainText("This request is not waiting for an answer.");
        await expect(page.getByLabel("Your answer")).toHaveValue("All of them");
        await page.close();
      });

      test("long request lists page with Show more", async () => {
        fake().reset({ features: [], requests: Array.from({ length: 25 }, (_, i) => request({ id: `r${i}`, text: `Request number ${i}` })) });
        const page = await open("/mine");
        await expect(page.getByText(/^Request number \d+$/)).toHaveCount(20);
        await page.getByRole("button", { name: "Show more" }).click();
        await expect(page.getByText(/^Request number \d+$/)).toHaveCount(25);
        await expect(page.getByRole("button", { name: "Show more" })).toHaveCount(0);
        await page.close();
      });

      test("keep a version, then follow the latest again", async () => {
        const page = await open("/mine");
        await expect(page.getByText("Version 1.1.0 (following the latest)")).toBeVisible();
        await page.getByText("Versions", { exact: true }).click();
        await expect(page.getByText("Version 1.0.0", { exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Keep version 1.0.0" }).click();
        await expect(page.getByText("Version 1.0.0 (you kept it; latest is 1.1.0)")).toBeVisible();
        await expect(page.getByText("Kept by you")).toBeVisible();
        assert.deepEqual(lastLog("POST", "features/f1/pin").body, { version: "1.0.0" });
        await page.getByRole("button", { name: "Follow the latest version of Orders dashboard" }).click();
        await expect(page.getByText("Version 1.1.0 (following the latest)")).toBeVisible();
        await expect(page.getByText("Kept by you")).toHaveCount(0);
        assert.deepEqual(lastLog("POST", "features/f1/pin").body, { version: null });
        await page.close();
      });

      test("turn a feature off and on, from the keyboard", async () => {
        const page = await open("/mine");
        const off = page.getByRole("button", { name: "Turn off Orders dashboard" });
        await off.focus();
        await page.keyboard.press("Enter");
        await expect(page.getByText("This feature is turned off for you.")).toBeVisible();
        assert.deepEqual(lastLog("POST", "features/f1/enabled").body, { enabled: false });
        await page.getByRole("button", { name: "Turn on Orders dashboard" }).click();
        await expect(page.getByText("This feature is turned off for you.")).toHaveCount(0);
        await page.close();
      });

      test("the owner shares through the picker, removes a person, and the site's refusal is shown", async () => {
        const page = await open("/mine");
        await page.getByText("Sharing", { exact: true }).click();
        await page.getByLabel("Share with someone").fill("bo");
        await page.getByRole("button", { name: "Share with Bob Builder" }).click();
        await expect(page.getByRole("button", { name: "Stop sharing with Bob Builder" })).toBeVisible();
        assert.deepEqual(lastLog("POST", "features/f1/share").body, { userIds: ["bob"] });
        await page.getByRole("button", { name: "Stop sharing with Bob Builder" }).click();
        await expect(page.getByRole("button", { name: "Stop sharing with Bob Builder" })).toHaveCount(0);
        await page.getByRole("button", { name: "Share with everyone", exact: true }).click();
        await expect(page.getByRole("alert")).toContainText("You may not share this with everyone.");
        await page.getByLabel("Share with someone").fill("zzz");
        await expect(page.getByText("No one found.")).toBeVisible();
        await page.close();
      });

      test("someone a feature was shared with can keep or turn it off, but sees no sharing controls", async () => {
        fake().reset({ features: [feature({ id: "f1", userIds: ["bob"] })] });
        const page = await open("/mine", "bob");
        await expect(page.getByRole("heading", { name: "Orders dashboard" })).toBeVisible();
        await expect(page.getByText("Sharing", { exact: true })).toBeHidden();
        await expect(page.getByRole("button", { name: "Turn off Orders dashboard" })).toBeVisible();
        await page.close();
      });

      test("fits the screen", async () => {
        fake().reset({ features: [feature({ id: "f1" })], requests: [request({ id: "r2", status: "NeedsInfo", message: "Which columns should the export include?" })] });
        const page = await open("/mine");
        await page.getByText("Versions", { exact: true }).click();
        await page.getByText("Sharing", { exact: true }).click();
        await expect(page.getByRole("button", { name: "Keep version 1.0.0" })).toBeVisible();
        await assertFits(page, "hoc-my-features");
        await page.close();
      });
    });

    describe("<hoc-feature-admin>", () => {
      test("a non-admin is told it is for administrators", async () => {
        const page = await open("/admin", "bob");
        await expect(page.getByRole("alert")).toContainText("Only administrators can manage features.");
        await page.close();
      });

      test("settings load, explain the rendering modes, and save", async () => {
        const page = await open("/admin", "admin");
        await expect(page.getByRole("radio", { name: /^Inject/ })).toBeChecked();
        await expect(page.getByText("can use your site's own API with the signed-in user's login", { exact: false })).toBeVisible();
        await expect(page.getByText("cannot read or change the rest of the page", { exact: false })).toBeVisible();
        await page.getByRole("radio", { name: /^Iframe/ }).check();
        await page.getByLabel("Who can share a feature with named people").selectOption("admins");
        await page.getByLabel("Who can share a feature with everyone").selectOption("nobody");
        await page.getByLabel("Who can see every request").selectOption("everyone");
        await page.getByRole("button", { name: "Save settings" }).click();
        await expect(page.getByText("Settings saved.", { exact: true }).first()).toBeVisible();
        assert.deepEqual(fake().lastSettingsPut, { renderingMode: "iframe", shareWithNamedUsers: "admins", shareWithEveryone: "nobody", viewAllRequests: "everyone", dataSources: [] });
        await page.close();
      });

      test("data sources: validation, then save sends the secret once and never shows it again", async () => {
        const page = await open("/admin", "admin");
        await expect(page.getByText("No data sources.")).toBeVisible();
        await page.getByRole("button", { name: "Add data source" }).click();
        await page.getByRole("textbox", { name: "Name", exact: true }).fill("orders-api");
        await page.getByLabel("Base URL").fill("not a url");
        await page.getByLabel("Secret name (optional)").fill("Bad Name");
        await page.getByLabel("OpenAPI description (optional, JSON)").fill("{broken");
        await page.getByRole("button", { name: "Save settings" }).click();
        const alert = page.getByRole("alert").filter({ hasText: "Please fix these first:" });
        await expect(alert).toContainText("enter a full web address");
        await expect(alert).toContainText("secret name may use lowercase");
        await expect(alert).toContainText("not a valid JSON object");
        assert.equal(count("PUT", "settings"), 0);

        await page.getByLabel("Base URL").fill("https://orders.example.com/api");
        await page.getByLabel("Secret name (optional)").fill("orders-key");
        await page.getByLabel("Secret value", { exact: true }).fill("s3cret-value");
        await page.getByLabel("OpenAPI description (optional, JSON)").fill('{"openapi":"3.1.0"}');
        await page.getByRole("button", { name: "Save settings" }).click();
        await expect(page.getByText("Settings saved.", { exact: true }).first()).toBeVisible();
        assert.deepEqual(fake().lastSettingsPut.dataSources, [{
          name: "orders-api", baseUrl: "https://orders.example.com/api", openapi: { openapi: "3.1.0" },
          auth: { type: "bearer", secret: "orders-key", secretValue: "s3cret-value" },
        }]);
        await expect(page.getByLabel("Secret name (optional)")).toHaveValue("orders-key");
        await expect(page.getByLabel("New secret value (leave blank to keep the stored one)")).toHaveValue("");

        await page.getByRole("button", { name: "Save settings" }).click();
        await expect(page.getByText("Settings saved.", { exact: true }).first()).toBeVisible();
        assert.equal(fake().lastSettingsPut.dataSources[0].auth.secretValue, undefined, "a blank value keeps the stored secret");

        await page.getByRole("button", { name: "Remove data source orders-api" }).click();
        await expect(page.getByText("No data sources.")).toBeVisible();
        await page.close();
      });

      test("a failed save shows the platform error and nothing is saved", async () => {
        const page = await open("/admin", "admin");
        fake().failNext("PUT settings", 502, "platform_unavailable", "Could not reach HandOfClient.");
        await page.getByRole("button", { name: "Save settings" }).click();
        await expect(page.getByRole("alert").filter({ hasText: "Could not reach HandOfClient." })).toBeVisible();
        assert.equal(fake().state.settings.renderingMode, "inject");
        await page.close();
      });

      test("all requests can be filtered by status", async () => {
        fake().reset({
          features: [],
          requests: [
            request({ id: "r1", text: "From Alice", userId: "alice", userName: "Alice Owner", status: "InProgress" }),
            request({ id: "r2", text: "From Bob", userId: "bob", userName: "Bob Builder", status: "NeedsInfo", message: "Which one?" }),
          ],
        });
        const page = await open("/admin", "admin");
        await expect(page.getByText("From Alice")).toBeVisible();
        await expect(page.getByText("From Bob")).toBeVisible();
        await expect(page.getByText("by Bob Builder")).toBeVisible();
        await page.getByLabel("Filter by status").selectOption("NeedsInfo");
        await expect(page.getByText("From Alice")).toHaveCount(0);
        await expect(page.getByText("From Bob")).toBeVisible();
        assert.equal(await page.getByRole("button", { name: "Send answer" }).count(), 0, "admins read, they do not answer for users");
        await page.close();
      });

      test("roll back for everyone needs a second confirming step, and Cancel backs out", async () => {
        fake().reset({ features: [feature({ id: "f1", ownerUserId: "admin" })] });
        const page = await open("/admin", "admin");
        await page.getByText("Versions and roll back", { exact: true }).click();
        await page.getByRole("button", { name: "Roll back to version 1.0.0" }).click();
        await expect(page.getByText("will replace version 1.1.0 for everyone")).toBeVisible();
        assert.equal(count("POST", "features/f1/current"), 0);
        await page.getByRole("button", { name: "Cancel" }).click();
        await expect(page.getByRole("button", { name: "Roll back to version 1.0.0" })).toBeVisible();
        assert.equal(count("POST", "features/f1/current"), 0);

        await page.getByRole("button", { name: "Roll back to version 1.0.0" }).press("Enter");
        await page.getByRole("button", { name: "Confirm: Roll back to version 1.0.0" }).press("Enter");
        await expect(page.getByText("Version 1.0.0 (following the latest)")).toBeVisible();
        assert.deepEqual(lastLog("POST", "features/f1/current").body, { version: "1.0.0" });
        await page.close();
      });

      test("fits the screen", async () => {
        fake().reset({ features: [feature({ id: "f1", ownerUserId: "admin", versions: [version("2.0.0"), version("1.0.0")], currentVersion: "2.0.0" })], requests: [request({ id: "r1" })] });
        const page = await open("/admin", "admin");
        await page.getByRole("button", { name: "Add data source" }).click();
        await page.getByText("Versions and roll back", { exact: true }).click();
        await expect(page.getByRole("button", { name: "Roll back to version 1.0.0" })).toBeVisible();
        await assertFits(page, "hoc-feature-admin");
        await page.close();
      });
    });

    describe("function forms", () => {
      test("HandOfClient.requestFeature/myFeatures/featureAdmin mount into any element and destroy cleanly", async () => {
        const page = await open("/fn", "admin");
        await page.evaluate(() => {
          window.handles = {
            request: HandOfClient.requestFeature(document.getElementById("a")),
            mine: HandOfClient.myFeatures(document.getElementById("b")),
          };
        });
        await expect(page.getByRole("button", { name: "Send request" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "My requests" })).toBeVisible();
        await page.evaluate(() => { window.handles.request.destroy(); window.handles.mine.destroy(); });
        await expect(page.getByRole("button", { name: "Send request" })).toHaveCount(0);
        await page.close();
      });

      test("HandOfClient.features.* make the same calls without UI", async () => {
        const page = await open("/fn", "alice");
        const result = await page.evaluate(async () => {
          const created = await HandOfClient.features.createRequest({ text: "From code" });
          const list = await HandOfClient.features.listFeatures();
          let error;
          try { await HandOfClient.features.getSettings(); } catch (e) { error = { name: e.name, code: e.code, status: e.status }; }
          return { status: created.status, features: list.map((f) => f.id), error };
        });
        assert.deepEqual(result, { status: "InProgress", features: ["f1"], error: { name: "FeaturesApiError", code: "forbidden", status: 403 } });
        await page.close();
      });
    });
  });
}
