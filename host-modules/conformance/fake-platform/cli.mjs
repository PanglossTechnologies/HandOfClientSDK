#!/usr/bin/env node
// Run the fake platform on its own, e.g. as the platform behind a site you are developing locally.
//   node fake-platform/cli.mjs --webhook-url http://127.0.0.1:5000/hoc/webhook [--auto-build]
import { createFakePlatform } from "./platform.mjs";
import { profile } from "../lib/profile.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

if (flag("help")) {
  console.log(`Fake HandOfClient platform
  --port <n>            default ${profile.platformPort()} (HOC_CONFORMANCE_PLATFORM_PORT)
  --bind <addr>         default ${profile.platformBind()}; use 0.0.0.0 to reach it from a container
  --api-key <key>       default ${profile.apiKey()} (HOC_CONFORMANCE_API_KEY): what the site sends as x-api-key
  --webhook-secret <s>  default ${profile.webhookSecret()} (HOC_CONFORMANCE_WEBHOOK_SECRET)
  --webhook-url <url>   where to deliver events, e.g. http://127.0.0.1:5000/hoc/webhook
  --host-id <id>        default ${profile.hostId()}
  --tenant-id <id>      default ${profile.tenantId()}
  --auto-build          answer every build with a placeholder version 1.0.0 (build.version + build.status Success)`);
  process.exit(0);
}

const platform = createFakePlatform({
  port: Number(arg("port", profile.platformPort())),
  bind: arg("bind", profile.platformBind()),
  apiKey: arg("api-key", profile.apiKey()),
  webhookSecret: arg("webhook-secret", profile.webhookSecret()),
  webhookUrl: arg("webhook-url", process.env.HOC_CONFORMANCE_WEBHOOK_URL ?? null),
  hostId: arg("host-id", profile.hostId()),
  tenantId: arg("tenant-id", profile.tenantId()),
  autoBuild: flag("auto-build"),
});
const url = await platform.start();
console.log(`fake platform listening on ${url}`);
console.log(`  site config: API base ${url}, host api key ${platform.cfg.apiKey}, tenant ${platform.cfg.tenantId}`);
console.log(`  webhook: ${platform.cfg.webhookUrl ?? "(none: pass --webhook-url)"}  secret ${platform.cfg.webhookSecret}`);
console.log(`  control API: ${url}/_fake/*  (calls, builds, publish, status, deliver, failures, withdraw, reset)`);
