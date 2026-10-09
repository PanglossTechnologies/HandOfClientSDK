// Runs the language-neutral conformance suite (host-modules/conformance) against this package, plain PHP and Laravel.
//
//   node conformance/run-conformance.mjs [plain|laravel|laravel-csrf ...] [--only <suite file part>] [--reporter dot]
//        [--db sqlite|env] [--transport curl|stream]
//
// Each app is started on a free port with a brand-new SQLite database (or HOC_CONFORMANCE_DATABASE_URL with --db env, which
// must be an EMPTY PostgreSQL / MySQL database), the suite runs against it, and the app is stopped again. Exit code is
// non-zero if any framework fails.
//
//   plain         conformance/plain_app.php under PHP's built-in server
//   laravel       the stock Laravel skeleton from setup-laravel.mjs, CSRF exempt on the browser routes, using Laravel's own PDO
//   laravel-csrf  the same with CSRF protection ON (no suite: it posts bare JSON): browser POSTs are refused (419), GETs and the signed webhook work
//
// Environment: PHP (php binary, default "php"). Needs Node 20+.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runMjs = join(here, "..", "..", "conformance", "run.mjs");
const laravelApp = join(here, "..", "..", "..", ".laravel-conformance");
const php = process.env.PHP ?? "php";
const APPS = ["plain", "laravel", "laravel-csrf"];

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : null;
};
const only = opt("only");
const reporter = opt("reporter");
const db = opt("db") ?? "sqlite";
const transport = opt("transport") ?? "curl";
const frameworks = args.length > 0 ? args : ["plain", "laravel"];
const unknown = frameworks.filter((f) => !APPS.includes(f));
if (unknown.length > 0) throw new Error(`unknown framework ${unknown}; choose from ${APPS}`);
if (db === "env" && !process.env.HOC_CONFORMANCE_DATABASE_URL) throw new Error("--db env needs HOC_CONFORMANCE_DATABASE_URL");
if (frameworks.some((f) => f.startsWith("laravel")) && !existsSync(laravelApp)) {
  throw new Error(".laravel-conformance is missing; run: node host-modules/php/conformance/setup-laravel.mjs");
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function waitReady(port, child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`app exited early with code ${child.exitCode}`);
    try {
      await fetch(`http://127.0.0.1:${port}/hoc/api/features`); // 401 = the module is answering
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error("app did not start in time");
}

// The built-in server logs every connection to stderr; keep that (and PHP's own error_log output) in a file, shown only on failure.
function startApp(framework, port, tmp, env, log) {
  const stdio = ["ignore", "ignore", log];
  if (framework === "plain") {
    return spawn(php, ["-S", `127.0.0.1:${port}`, join(here, "plain_app.php")], { env, cwd: tmp, stdio });
  }
  const server = join(laravelApp, "vendor", "laravel", "framework", "src", "Illuminate", "Foundation", "resources", "server.php");
  return spawn(php, ["-S", `127.0.0.1:${port}`, "-t", join(laravelApp, "public"), server], { env, cwd: join(laravelApp, "public"), stdio });
}

async function runOne(framework) {
  const tmp = mkdtempSync(join(tmpdir(), `hoc-php-${framework}-`));
  const [port, platformPort] = [await freePort(), await freePort()];
  const dbFile = join(tmp, "hoc.db");
  const env = { ...process.env, HOC_CONFORMANCE_DB: dbFile, HOC_CONFORMANCE_PLATFORM_PORT: String(platformPort), HOC_CONFORMANCE_TRANSPORT: transport };
  if (db === "sqlite") delete env.HOC_CONFORMANCE_DATABASE_URL;
  if (framework !== "plain") {
    writeFileSync(dbFile, ""); // Laravel wants the SQLite file to exist
    Object.assign(env, {
      APP_ENV: "testing",
      APP_DEBUG: "false",
      DB_CONNECTION: "sqlite",
      DB_DATABASE: dbFile,
      SESSION_DRIVER: "array",
      CACHE_STORE: "array",
      QUEUE_CONNECTION: "sync",
      LOG_CHANNEL: "stderr",
      HOC_CONFORMANCE_CSRF_EXEMPT: framework === "laravel-csrf" ? "0" : "1",
    });
    if (db === "env") {
      const u = new URL(process.env.HOC_CONFORMANCE_DATABASE_URL);
      env.DB_CONNECTION = u.protocol.startsWith("postgres") ? "pgsql" : "mysql";
      env.DB_URL = process.env.HOC_CONFORMANCE_DATABASE_URL;
    }
  }
  const logFile = join(tmp, "server.log");
  const log = openSync(logFile, "w");
  const app = startApp(framework, port, tmp, env, log);
  let code = 1;
  try {
    await waitReady(port, app);
    console.log(`== ${framework} on :${port} ==`);
    if (framework === "laravel-csrf") {
      // The suite itself needs CSRF off (it posts bare JSON), so this variant checks the policy directly instead.
      const base = `http://127.0.0.1:${port}/hoc`;
      const asAlice = { "content-type": "application/json", cookie: "hoc_user=alice" };
      const post = await fetch(`${base}/api/requests`, { method: "POST", headers: asAlice, body: JSON.stringify({ text: "csrf" }) });
      const get = await fetch(`${base}/api/features`, { headers: asAlice });
      const body = JSON.stringify({ type: "something.new", sentAt: new Date().toISOString() });
      const signature = "sha256=" + createHmac("sha256", env.HOC_CONFORMANCE_WEBHOOK_SECRET ?? "whsec_conformance").update(body).digest("hex");
      const hook = await fetch(`${base}/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-handofclient-signature": signature }, body });
      const got = { browserPost: post.status, browserGet: get.status, signedWebhook: hook.status };
      const want = { browserPost: 419, browserGet: 200, signedWebhook: 200 };
      console.log(`laravel-csrf: ${JSON.stringify(got)} (want ${JSON.stringify(want)})`);
      return (code = JSON.stringify(got) === JSON.stringify(want) ? 0 : 1);
    }
    const extra = [...(only ? ["--only", only] : []), ...(reporter ? ["--reporter", reporter] : [])];
    const res = spawnSync(
      process.execPath,
      [runMjs, "--base-url", `http://127.0.0.1:${port}/hoc`, "--platform-port", String(platformPort), "--fresh-db", ...extra],
      { env, stdio: "inherit" },
    );
    code = res.status ?? 1;
    return code;
  } finally {
    app.kill();
    await new Promise((r) => (app.exitCode !== null ? r() : app.once("exit", r)));
    closeSync(log);
    if (code !== 0) {
      const lines = readFileSync(logFile, "utf8").split("\n").filter((l) => !/ (Accepted|Closing)$/.test(l));
      console.error(`--- ${framework} server log (last 40 lines, connections hidden) ---\n${lines.slice(-40).join("\n")}`);
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

const codes = {};
for (const f of frameworks) codes[f] = await runOne(f);
console.log(Object.entries(codes).map(([f, c]) => `${f}: ${c === 0 ? "PASS" : "FAIL"}`).join("\n"));
process.exit(Object.values(codes).every((c) => c === 0) ? 0 : 1);
