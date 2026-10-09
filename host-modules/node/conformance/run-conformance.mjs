// Runs the language-neutral conformance suite (host-modules/conformance) against this package under each framework.
//
//   node conformance/run-conformance.mjs [express|fastify|node ...] [--only <suite file part>] [--reporter dot] [--db sqlite|env]
//
// Each app is started on a free port with a brand-new SQLite database (or HOC_CONFORMANCE_DATABASE_URL with --db env,
// which must be an EMPTY database), the suite runs against it, and the app is stopped again. Exit code is non-zero
// if any framework fails.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runMjs = join(here, "..", "..", "conformance", "run.mjs");
const APPS = { express: "express-app.mjs", fastify: "fastify-app.mjs", node: "node-app.mjs" };

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : null;
};
const only = opt("only");
const reporter = opt("reporter");
const db = opt("db") ?? "sqlite";
const frameworks = args.length > 0 ? args : Object.keys(APPS);
const unknown = frameworks.filter((f) => !(f in APPS));
if (unknown.length > 0) throw new Error(`unknown framework ${unknown}; choose from ${Object.keys(APPS)}`);
if (db === "env" && !process.env.HOC_CONFORMANCE_DATABASE_URL) throw new Error("--db env needs HOC_CONFORMANCE_DATABASE_URL");

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function waitReady(port, child, timeoutMs = 30_000) {
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

async function runOne(framework) {
  const tmp = mkdtempSync(join(tmpdir(), `hoc-${framework}-`));
  const [port, platformPort] = [await freePort(), await freePort()];
  const env = { ...process.env, HOC_CONFORMANCE_DB: join(tmp, "hoc.db"), HOC_CONFORMANCE_PLATFORM_PORT: String(platformPort) };
  if (db === "sqlite") delete env.HOC_CONFORMANCE_DATABASE_URL;
  const app = spawn(process.execPath, [join(here, APPS[framework]), "--port", String(port)], { env, cwd: tmp, stdio: "inherit" });
  try {
    await waitReady(port, app);
    console.log(`== ${framework} on :${port} ==`);
    const extra = [...(only ? ["--only", only] : []), ...(reporter ? ["--reporter", reporter] : [])];
    const res = spawnSync(
      process.execPath,
      [runMjs, "--base-url", `http://127.0.0.1:${port}/hoc`, "--platform-port", String(platformPort), "--fresh-db", ...extra],
      { env, stdio: "inherit" },
    );
    return res.status ?? 1;
  } finally {
    app.kill();
    await new Promise((r) => (app.exitCode !== null ? r() : app.once("exit", r)));
    rmSync(tmp, { recursive: true, force: true });
  }
}

const codes = {};
for (const f of frameworks) codes[f] = await runOne(f);
console.log(Object.entries(codes).map(([f, c]) => `${f}: ${c === 0 ? "PASS" : "FAIL"}`).join("\n"));
process.exit(Object.values(codes).every((c) => c === 0) ? 0 : 1);
