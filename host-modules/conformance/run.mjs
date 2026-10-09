#!/usr/bin/env node
// Run the conformance suite against a running host module.
//   node run.mjs --base-url http://127.0.0.1:5000/hoc
// Starts the fake platform (webhooks go to <base-url>/webhook), runs every suite file one at a time, exits
// non-zero on any failure. Options: --platform-port --platform-bind --fresh-db --only <name-substring> --reporter <name>
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { createFakePlatform } from "./fake-platform/platform.mjs";
import { profile } from "./lib/profile.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

export async function runConformance({ baseUrl, platformPort, platformBind, freshDb = false, only = null, reporter = "spec", quiet = false } = {}) {
  baseUrl = baseUrl.replace(/\/+$/, "");
  const platform = createFakePlatform({
    port: platformPort ?? profile.platformPort(), bind: platformBind ?? profile.platformBind(),
    apiKey: profile.apiKey(), webhookSecret: profile.webhookSecret(), hostId: profile.hostId(), tenantId: profile.tenantId(),
    webhookUrl: `${baseUrl}/webhook`,
  });
  const controlUrl = await platform.start();
  const files = readdirSync(path.join(here, "suite")).filter((f) => f.endsWith(".test.mjs") && (!only || f.includes(only))).sort().map((f) => path.join(here, "suite", f));
  const env = { ...process.env, HOC_CONFORMANCE_BASE_URL: baseUrl, HOC_CONFORMANCE_PLATFORM_URL: controlUrl, ...(freshDb ? { HOC_CONFORMANCE_FRESH_DB: "1" } : {}) };
  try {
    return await new Promise((resolve) => {
      const child = spawn(process.execPath, ["--test", "--test-concurrency=1", `--test-reporter=${reporter}`, ...files], { env, stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit" });
      let out = "";
      child.stdout?.on("data", (d) => { out += d; });
      child.stderr?.on("data", (d) => { out += d; });
      child.on("exit", (code) => resolve({ code: code ?? 1, output: out }));
    });
  } finally {
    await platform.stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
  const baseUrl = arg("base-url", process.env.HOC_CONFORMANCE_BASE_URL);
  if (!baseUrl) { console.error("usage: node run.mjs --base-url <module prefix URL, e.g. http://127.0.0.1:5000/hoc>"); process.exit(2); }
  const { code } = await runConformance({
    baseUrl, platformPort: arg("platform-port") ? Number(arg("platform-port")) : undefined, platformBind: arg("platform-bind"),
    freshDb: process.argv.includes("--fresh-db"), only: arg("only", null), reporter: arg("reporter", "spec"),
  });
  process.exit(code);
}
