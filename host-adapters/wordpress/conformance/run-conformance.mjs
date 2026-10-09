// Runs the language-neutral host-module conformance suite (host-modules/conformance) against the WordPress
// plugin, in a throwaway WordPress built by the dev harness.
//
//   node host-adapters/wordpress/conformance/run-conformance.mjs [--only <suite file part>] [--reporter dot]
//
// Needs `node host-adapters/wordpress/devharness/setup.mjs` to have been run once (it downloads PHP and
// WordPress into .wp-local/) and Node 20+. Each run installs a brand-new WordPress (SQLite) into a temp
// directory's database file, serves it on a free port with the conformance profile
// (hoc-conformance-profile.php, installed as a mu-plugin for the duration of the run), runs the suite, and
// stops it again. The 8088 harness's own data is never touched.
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, startWordPress } from "./wp-instance.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const runMjs = join(here, "..", "..", "..", "host-modules", "conformance", "run.mjs");

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : null;
};
const only = opt("only");
const reporter = opt("reporter");

const platformPort = await freePort();
const wp = await startWordPress({ conformance: true, env: { HOC_CONFORMANCE_PLATFORM_PORT: String(platformPort) } });
let code = 1;
try {
  console.log(`== wordpress on :${wp.port} ==`);

  // WordPress-specific policy the language-neutral suite cannot cover (it sends no Origin): a browser write
  // from another site is refused, the same write from this site is served, and the signed webhook is exempt.
  const base = `${wp.url}/hoc`;
  const asAlice = { "content-type": "application/json", cookie: "hoc_user=alice" };
  const post = (origin) => fetch(`${base}/api/requests`, { method: "POST", headers: { ...asAlice, origin }, body: JSON.stringify({ text: "csrf" }) });
  const hookBody = JSON.stringify({ type: "something.new", sentAt: new Date().toISOString() });
  const hookSignature = "sha256=" + createHmac("sha256", "whsec_conformance").update(hookBody).digest("hex");
  const hook = await fetch(`${base}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example", "x-handofclient-signature": hookSignature },
    body: hookBody,
  });
  const got = { crossSitePost: (await post("https://evil.example")).status, nullOriginPost: (await post("null")).status, signedWebhookFromElsewhere: hook.status };
  const want = { crossSitePost: 403, nullOriginPost: 403, signedWebhookFromElsewhere: 200 };
  console.log(`csrf: ${JSON.stringify(got)} (want ${JSON.stringify(want)})`);
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error("CSRF policy check failed");

  const extra = [...(only ? ["--only", only] : []), ...(reporter ? ["--reporter", reporter] : [])];
  const res = spawnSync(
    process.execPath,
    [runMjs, "--base-url", base, "--platform-port", String(platformPort), "--fresh-db", ...extra],
    { env: { ...process.env, HOC_CONFORMANCE_PLATFORM_PORT: String(platformPort) }, stdio: "inherit" },
  );
  code = res.status ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  if (code !== 0) console.error(`--- php server log (last 40 lines, connections hidden) ---\n${wp.serverLog()}`);
  await wp.stop();
}
console.log(`wordpress: ${code === 0 ? "PASS" : "FAIL"}`);
process.exit(code);
