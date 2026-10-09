// Smoke test for samples/hosts/dotnet: starts the sample, checks its endpoints and loads the page in a headless browser.
//
//   npm run build && dotnet build samples/hosts/dotnet/HandOfClient.Samples.DotNetHost -c Debug
//   node tools/ci/smoke-dotnet-sample.mjs
//
// The sample talks to the platform over gRPC (token issuing), which the fake platform does not speak, so the
// platform base URL points at a closed port. That is deliberate: it proves the host side (config, embed.js
// serving, webhook signature check, a clean 502 when the platform is unreachable) and that the page runs embed.js
// through to its error path, without a real platform. The request -> build -> visible-to-requester loop is covered
// by the Flask sample and the host-module conformance suites.
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const project = path.join(root, "samples/hosts/dotnet/HandOfClient.Samples.DotNetHost");

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok    " : "FAIL  "}${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures.push(name);
};

const port = await freePort();
const closedPort = await freePort();
const base = `http://127.0.0.1:${port}`;
const SECRET = "ci-webhook-secret";
// The built dll, not `dotnet run`: killing `dotnet run` can leave the app it launched listening.
const dll = path.join(project, "bin/Debug/net8.0/HandOfClient.Samples.DotNetHost.dll");
const child = spawn("dotnet", [dll, "--urls", base], {
  cwd: project,
  stdio: "inherit",
  env: {
    ...process.env,
    ASPNETCORE_ENVIRONMENT: "Development",
    Platform__ApiBaseUrl: `https://127.0.0.1:${closedPort}`,
    Platform__EmbedOrigin: `https://127.0.0.1:${closedPort}`,
    Platform__HostId: "ci-host",
    Platform__HostApiKey: "ci-host-api-key",
    Platform__WebhookSecret: SECRET,
  },
});
let browser;
try {
  const end = Date.now() + 60000;
  for (;;) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error("sample did not start");
    await new Promise((r) => setTimeout(r, 250));
  }

  check("/healthz", (await (await fetch(`${base}/healthz`)).json()).status === "ok");

  const cfg = await (await fetch(`${base}/api/host-config`)).json();
  check("/api/host-config reflects configuration", cfg.hostId === "ci-host" && cfg.slotId === "main-panel", JSON.stringify(cfg));

  const embed = await fetch(`${base}/embed.global.js`);
  const embedText = await embed.text();
  check("/embed.global.js serves the built embed.js", embed.ok && embedText.includes("HandOfClient"), `status ${embed.status}`);

  const body = JSON.stringify({ kind: "activation.changed" });
  const sign = (s) => "sha256=" + createHmac("sha256", s).update(body).digest("hex");
  const post = (sig) => fetch(`${base}/webhooks/handofclient`, {
    method: "POST", body, headers: { "content-type": "application/json", ...(sig ? { "X-HandOfClient-Signature": sig } : {}), "X-HandOfClient-Event": "activation.changed" },
  });
  check("webhook with a valid signature -> 200", (await post(sign(SECRET))).status === 200);
  check("webhook with a wrong signature -> 401", (await post(sign("not-the-secret"))).status === 401);
  check("webhook without a signature -> 401", (await post(null)).status === 401);

  const token = await fetch(`${base}/api/embed-token`);
  check("/api/embed-token with the platform down -> 502, not a crash", token.status === 502, `status ${token.status}`);

  try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ channel: "chrome" }); }
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(base);
  await page.waitForFunction(() => /Mount failed|Plugin mounted/.test(document.getElementById("status")?.textContent ?? ""), null, { timeout: 30000 });
  check("page: embed.js loaded and mount ran to its error path",
    await page.evaluate(() => typeof window.HandOfClient?.mount === "function") &&
      /Mount failed/.test(await page.locator("#status").textContent()));
  check("page: no uncaught exceptions", pageErrors.length === 0, pageErrors.join("; "));
} catch (e) {
  console.error(e);
  failures.push("exception");
} finally {
  await browser?.close();
  child.kill();
}
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\ndotnet sample smoke: all checks passed");
