// A throwaway WordPress for tests: the dev harness's PHP + WordPress (.wp-local/, see
// ../devharness/setup.mjs) with the HandOfClient plugin active, a brand-new SQLite database in a temp
// directory, served on a free port. The 8088 harness's own data is never touched.
//
//   const wp = await startWordPress({ conformance: true });   // conformance profile (cookie identity, fixed keys)
//   const wp = await startWordPress({ env: { ... } });        // a plain site; configure it with wp.cli([...])
//   wp.url, wp.port, wp.cli(args), await wp.stop()
import { spawn, spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const wpLocal = join(repoRoot, ".wp-local");
const php = join(wpLocal, "php", "php.exe");
const wpCli = join(wpLocal, "wp-cli.phar");
const wpRoot = join(wpLocal, "wordpress");
const router = join(wpLocal, "router.php");
const profileSource = join(here, "hoc-conformance-profile.php");
const profileTarget = join(wpRoot, "wp-content", "mu-plugins", "hoc-conformance-profile.php");

export const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/**
 * @param {{ conformance?: boolean, env?: Record<string,string>, port?: number }} options
 * `conformance`: install the conformance profile mu-plugin for the lifetime of the instance.
 */
export async function startWordPress(options = {}) {
  for (const needed of [php, wpCli, router, join(wpRoot, "index.php")]) {
    if (!existsSync(needed)) throw new Error(`${needed} is missing; run: node host-adapters/wordpress/devharness/setup.mjs`);
  }
  const tmp = mkdtempSync(join(tmpdir(), "hoc-wp-"));
  const port = options.port ?? (await freePort());
  const url = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    HOC_WP_DB_PATH: join(tmp, "wordpress.sqlite"),
    HOC_WP_URL: url,
    ...(options.conformance ? { HOC_WP_CONFORMANCE: "1" } : {}),
    ...options.env,
  };
  const logFile = join(tmp, "server.log");
  const log = openSync(logFile, "w");
  let app = null;

  const cli = (cliArgs, { allowFailure = false } = {}) => {
    const res = spawnSync(php, [wpCli, ...cliArgs, `--path=${wpRoot}`, `--url=${url}`], { env, encoding: "utf8" });
    if (res.status !== 0 && !allowFailure) throw new Error(`wp ${cliArgs.join(" ")} failed:\n${res.stdout}\n${res.stderr}`);
    return res.stdout.trim();
  };

  const stop = async () => {
    if (app) {
      app.kill();
      await new Promise((r) => (app.exitCode !== null ? r() : app.once("exit", r)));
      app = null;
    }
    closeSync(log);
    if (options.conformance) rmSync(profileTarget, { force: true });
    rmSync(tmp, { recursive: true, force: true });
  };

  /** Last lines of the PHP server log (connection noise removed), for failure reports. */
  const serverLog = () => {
    try {
      return readFileSync(logFile, "utf8").split("\n").filter((l) => !/ (Accepted|Closing)$/.test(l)).slice(-40).join("\n");
    } catch {
      return "";
    }
  };

  try {
    if (options.conformance) copyFileSync(profileSource, profileTarget);
    cli(["core", "install", "--title=HOC test site", "--admin_user=admin", "--admin_password=hocadmin", "--admin_email=test@example.invalid", "--skip-email"]);
    cli(["rewrite", "structure", "/%postname%/"], { allowFailure: true });
    cli(["plugin", "activate", "handofclient"]);
    app = spawn(php, ["-S", `127.0.0.1:${port}`, "-t", wpRoot, router], { env, cwd: wpRoot, stdio: ["ignore", "ignore", log] });
    const deadline = Date.now() + 90_000;
    for (;;) {
      if (app.exitCode !== null) throw new Error(`php exited early with code ${app.exitCode}`);
      if (Date.now() > deadline) throw new Error("WordPress did not start in time");
      try {
        await fetch(`${url}/hoc/api/features`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  } catch (error) {
    await stop();
    throw error;
  }
  return { url, port, cli, stop, serverLog };
}
