/**
 * Builds a real, local WordPress at .wp-local/ and mounts this repo's plugin into it.
 *
 *   node host-adapters/wordpress/devharness/setup.mjs          # create it
 *   node host-adapters/wordpress/devharness/setup.mjs --start  # ...and leave the server running
 *   node host-adapters/wordpress/devharness/setup.mjs --test   # run the plugin's PHP tests and exit
 *
 * Why not wp-env: wp-env needs Docker, and Docker Desktop is not available on the Windows Server
 * box this is developed on. This gets the same thing - a genuine WordPress running genuine PHP -
 * out of a portable PHP build plus the official SQLite integration drop-in, with no daemon, no
 * container runtime, and no MySQL. PHP is the real native binary, not WASM, so ext/openssl, curl
 * and the network stack behave exactly as they will on a customer's host, which is the entire point
 * of testing here rather than in unit tests.
 *
 * Everything it creates lives under .wp-local/ and is gitignored. Re-running is safe: existing
 * downloads and an existing install are reused unless --clean is passed.
 */

import { execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, rm, readFile, writeFile, access, cp, symlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePhp } from "./php-path.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ROOT = path.join(REPO_ROOT, ".wp-local");
const DL = path.join(ROOT, "_dl");
const PHP_DIR = path.join(ROOT, "php");
const { php: PHP, bundled: BUNDLED_PHP } = resolvePhp(ROOT);
const WP = path.join(ROOT, "wordpress");
const WP_CLI = path.join(ROOT, "wp-cli.phar");

const PORT = 8088;
const SITE_URL = `http://localhost:${PORT}`;
const ADMIN_USER = "admin";
const ADMIN_PASS = "hocadmin";

// PHP 8.3 rather than 8.4/8.5: it is what WordPress is best tested against today. windows.php.net only
// keeps the newest patch release under /releases/, so a pinned file name 404s as soon as 8.3.N+1 ships;
// the newest 8.3 NTS x64 build is looked up in releases.json instead.
const PHP_RELEASES = "https://downloads.php.net/~windows/releases";
async function latestPhpZipUrl() {
  const response = await fetch(`${PHP_RELEASES}/releases.json`, { redirect: "follow" });
  if (!response.ok) throw new Error(`${PHP_RELEASES}/releases.json -> HTTP ${response.status}`);
  const build = (await response.json())["8.3"]?.["nts-vs16-x64"]?.zip?.path;
  if (!build) throw new Error("releases.json has no PHP 8.3 nts-vs16-x64 build");
  return `${PHP_RELEASES}/${build}`;
}

const DOWNLOADS = [
  ...(BUNDLED_PHP ? [{ file: "php.zip", url: latestPhpZipUrl }, { file: "cacert.pem", url: "https://curl.se/ca/cacert.pem" }] : []),
  { file: "wordpress.zip", url: "https://wordpress.org/latest.zip" },
  { file: "sqlite-db.zip", url: "https://downloads.wordpress.org/plugin/sqlite-database-integration.zip" },
  { file: "wp-cli.phar", url: "https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar" },
];

const args = new Set(process.argv.slice(2));
const log = (line) => console.log(line);

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function download(url, dest) {
  if (await exists(dest)) return;
  log(`  downloading ${path.basename(dest)} ...`);
  if (typeof url === "function") url = await url();
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
}

/** Windows ships bsdtar as tar.exe. Never Compress-Archive: it writes backslash ZIP entries. */
function untar(zip, into) {
  // Full path on Windows: a GNU tar earlier on PATH (Git for Windows) reads "Z:" as a remote host.
  const tarBin = process.platform === "win32" ? "C:\\Windows\\System32\\tar.exe" : "tar";
  execFileSync(tarBin, ["-xf", zip, "-C", into], { stdio: "inherit" });
}

function php(scriptArgs, options = {}) {
  return execFileSync(PHP, scriptArgs, { encoding: "utf8", ...options });
}

function wp(cliArgs) {
  return php([WP_CLI, ...cliArgs, `--path=${WP}`, `--url=${SITE_URL}`], { stdio: "inherit" });
}

async function main() {
  if (args.has("--clean")) {
    log("Removing the existing harness ...");
    await rm(ROOT, { recursive: true, force: true });
  }

  await mkdir(DL, { recursive: true });
  log("Fetching components ...");
  for (const { file, url } of DOWNLOADS) await download(url, path.join(DL, file));

  if (BUNDLED_PHP && !(await exists(PHP))) {
    log("Unpacking PHP ...");
    await mkdir(PHP_DIR, { recursive: true });
    untar(path.join(DL, "php.zip"), PHP_DIR);
  }
  if (!(await exists(WP))) {
    log("Unpacking WordPress ...");
    untar(path.join(DL, "wordpress.zip"), ROOT);
  }
  if (BUNDLED_PHP) await cp(path.join(DL, "cacert.pem"), path.join(PHP_DIR, "cacert.pem"), { force: true });
  await cp(path.join(DL, "wp-cli.phar"), WP_CLI, { force: true });

  // php.ini. openssl.cnf matters more than it looks: without it openssl_pkey_new() fails, which
  // breaks the plugin's own crypto tests (they generate a throwaway P-256 key). Verification, which
  // is all the plugin does at runtime, works without it - so a missing cnf fails only in testing.
  if (BUNDLED_PHP) {
    await writeFile(
      path.join(PHP_DIR, "php.ini"),
      [
        "; Generated by host-adapters/wordpress/devharness/setup.mjs - edit that, not this.",
        'extension_dir = "ext"',
        ...["openssl", "curl", "mbstring", "sqlite3", "pdo_sqlite", "fileinfo", "gd", "zip", "intl", "exif", "sockets"]
          .map((ext) => `extension=${ext}`),
        'curl.cainfo = "cacert.pem"',
        'openssl.cafile = "cacert.pem"',
        // NB: there is deliberately no "openssl.conf" line here - no such php.ini directive exists.
        // OpenSSL's config file comes from the OPENSSL_CONF environment variable only, which is why
        // --test below sets it rather than relying on the ini.
        "memory_limit = 512M",
        "max_execution_time = 120",
        "upload_max_filesize = 64M",
        "post_max_size = 64M",
        "display_errors = On",
        "error_reporting = E_ALL",
        "log_errors = On",
        'date.timezone = "UTC"',
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(PHP_DIR, "openssl.cnf"),
      "[ req ]\ndefault_bits = 2048\ndefault_md = sha256\ndistinguished_name = req_distinguished_name\n[ req_distinguished_name ]\n",
    );
  }

  // SQLite drop-in. The plugin folder is the implementation; wp-content/db.php is the shim that
  // loads it in place of the MySQL driver.
  const sqlitePluginDir = path.join(WP, "wp-content/plugins/sqlite-database-integration");
  if (!(await exists(sqlitePluginDir))) {
    untar(path.join(DL, "sqlite-db.zip"), path.join(WP, "wp-content/plugins"));
  }
  const dropIn = (await readFile(path.join(sqlitePluginDir, "db.copy"), "utf8"))
    // Left empty on purpose - the drop-in falls back to a realpath() of its own directory, which is
    // correct here and avoids embedding an absolute path in a generated file.
    .replace("'{SQLITE_IMPLEMENTATION_FOLDER_PATH}'", "''")
    .replaceAll("'{SQLITE_PLUGIN}'", "'sqlite-database-integration/load.php'");
  await writeFile(path.join(WP, "wp-content/db.php"), dropIn);

  if (!(await exists(path.join(WP, "wp-config.php")))) {
    log("Writing wp-config.php ...");
    const salts = await (await fetch("https://api.wordpress.org/secret-key/1.1/salt/")).text();
    await writeFile(
      path.join(WP, "wp-config.php"),
      `<?php
/** Generated by host-adapters/wordpress/devharness/setup.mjs. Local harness only. */
define( 'DB_NAME', 'wordpress' );
define( 'DB_USER', '' );
define( 'DB_PASSWORD', '' );
define( 'DB_HOST', 'localhost' );
define( 'DB_CHARSET', 'utf8mb4' );
define( 'DB_COLLATE', '' );

${salts}
$table_prefix = 'wp_';

define( 'WP_HOME', getenv( 'HOC_WP_URL' ) ? getenv( 'HOC_WP_URL' ) : '${SITE_URL}' );
define( 'WP_SITEURL', getenv( 'HOC_WP_URL' ) ? getenv( 'HOC_WP_URL' ) : '${SITE_URL}' );
define( 'WP_DEBUG', true );
define( 'WP_DEBUG_LOG', true );
define( 'WP_DEBUG_DISPLAY', false );
define( 'SCRIPT_DEBUG', true );
define( 'FS_METHOD', 'direct' );
define( 'AUTOMATIC_UPDATER_DISABLED', true );
define( 'WP_ENVIRONMENT_TYPE', 'local' );

if ( ! defined( 'ABSPATH' ) ) {
\tdefine( 'ABSPATH', __DIR__ . '/' );
}
require_once ABSPATH . 'wp-settings.php';
`,
    );
  }

  // Lets the conformance runner point a throwaway WordPress at its own database file (HOC_WP_DB_PATH)
  // without touching the 8088 harness's data. Idempotent: an older wp-config.php gets the block added.
  const configPath = path.join(WP, "wp-config.php");
  const configText = await readFile(configPath, "utf8");
  // HOC_WP_URL: the conformance/browser runs serve the same WordPress on another port (see conformance/wp-instance.mjs).
  const migrated = configText
    .replace("define( 'WP_HOME', '" + SITE_URL + "' );", "define( 'WP_HOME', getenv( 'HOC_WP_URL' ) ? getenv( 'HOC_WP_URL' ) : '" + SITE_URL + "' );")
    .replace("define( 'WP_SITEURL', '" + SITE_URL + "' );", "define( 'WP_SITEURL', getenv( 'HOC_WP_URL' ) ? getenv( 'HOC_WP_URL' ) : '" + SITE_URL + "' );");
  if (migrated !== configText) await writeFile(configPath, migrated);
  if (!configText.includes("HOC_WP_DB_PATH")) {
    const block = [
      "// Conformance runs: a throwaway database (host-adapters/wordpress/conformance).",
      "if ( getenv( 'HOC_WP_DB_PATH' ) ) {",
      "  define( 'DB_PATH', getenv( 'HOC_WP_DB_PATH' ) );",
      "}",
      "",
      "",
    ].join(String.fromCharCode(10));
    await writeFile(configPath, migrated.replace("if ( ! defined( 'ABSPATH' ) ) {", block + "if ( ! defined( 'ABSPATH' ) ) {"));
  }

  // Router + auto-login, copied from this folder so they are versioned as source.
  await cp(path.join(REPO_ROOT, "host-adapters/wordpress/devharness/router.php"), path.join(ROOT, "router.php"), { force: true });
  await mkdir(path.join(WP, "wp-content/mu-plugins"), { recursive: true });
  await cp(
    path.join(REPO_ROOT, "host-adapters/wordpress/devharness/hoc-harness-autologin.php"),
    path.join(WP, "wp-content/mu-plugins/hoc-harness-autologin.php"),
    { force: true },
  );

  // The plugin itself is a junction, not a copy, so edits in host-adapters/wordpress/handofclient are live.
  const pluginLink = path.join(WP, "wp-content/plugins/handofclient");
  if (!(await exists(pluginLink))) {
    log("Linking the plugin into wp-content ...");
    const pluginSource = path.join(REPO_ROOT, "host-adapters/wordpress/handofclient");
    if (process.platform === "win32") {
      execFileSync("cmd", ["/c", "mklink", "/J", pluginLink, pluginSource], { stdio: "inherit" });
    } else {
      await symlink(pluginSource, pluginLink, "dir");
    }
  }

  if (args.has("--test")) {
    // OPENSSL_CONF, not php.ini: openssl_pkey_new() reads its config from the environment, and
    // test-jwt.php generates a throwaway P-256 key. Without this it fails with a misleading
    // "is ext/openssl configured?" even though the extension is loaded and working.
    const env = BUNDLED_PHP ? { ...process.env, OPENSSL_CONF: path.join(PHP_DIR, "openssl.cnf") } : process.env;
    for (const test of ["test-jwt.php", "test-hooks.php", "test-site.php"]) {
      log(`\n--- ${test} ---`);
      execFileSync(PHP, [path.join(REPO_ROOT, "host-adapters/wordpress/handofclient/tests", test)], { stdio: "inherit", env });
    }
    return;
  }

  log("Installing WordPress (SQLite) ...");
  try {
    wp(["core", "install", `--title=HandOfClient WP Harness`, `--admin_user=${ADMIN_USER}`,
      `--admin_password=${ADMIN_PASS}`, "--admin_email=harness@example.invalid", "--skip-email"]);
  } catch {
    log("  (already installed)");
  }
  wp(["rewrite", "structure", "/%postname%/"]);
  wp(["plugin", "activate", "handofclient"]);

  log("");
  log(`Ready.  ${SITE_URL}    admin / ${ADMIN_PASS}`);
  log(`Start:  ${PHP} -S localhost:${PORT} -t .wp-local/wordpress .wp-local/router.php`);
  log(`Pair:   HandOfClient > Settings in wp-admin, or set the hoc_settings option with wp-cli.`);
  log("");
  log("Note: PHP's built-in server is single-threaded, so wp-admin feels slow. That is the server,");
  log("not the plugin - do not chase it as a performance bug.");

  if (args.has("--start")) {
    execFileSync(PHP, ["-S", `localhost:${PORT}`, "-t", WP, path.join(ROOT, "router.php")], { stdio: "inherit" });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
