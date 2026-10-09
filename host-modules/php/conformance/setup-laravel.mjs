// Builds the Laravel conformance app at <repo>/.laravel-conformance/ (gitignored; outside the package so the composer path repository
// cannot recurse into itself): a stock `laravel/laravel` skeleton that requires
// this package from the working tree (a composer path repository) and serves it through the Laravel adapter.
//
//   node conformance/setup-laravel.mjs [--laravel 12]        # default: whatever laravel/laravel's newest release is
//
// Environment: PHP (php binary, default "php"), COMPOSER_BIN (composer, default "composer"; a .phar is run through PHP).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const app = join(repoRoot, ".laravel-conformance");
const php = process.env.PHP ?? "php";
const composer = process.env.COMPOSER_BIN ?? "composer";
const args = process.argv.slice(2);
const i = args.indexOf("--laravel");
const major = i >= 0 ? args[i + 1] : null;

const run = (cwd, ...cmd) => {
  const [bin, ...rest] = composer.endsWith(".phar") ? [php, composer, ...cmd] : [composer, ...cmd];
  execFileSync(bin, rest, { cwd, stdio: "inherit" });
};

if (existsSync(app)) rmSync(app, { recursive: true, force: true });
run(repoRoot, "create-project", major ? `laravel/laravel:^${major}` : "laravel/laravel", ".laravel-conformance", "--prefer-dist", "--no-interaction", "--no-progress");
run(app, "config", "repositories.hoc", "path", "../host-modules/php");
run(app, "require", "handofclient/host:@dev", "--no-interaction", "--no-progress");
copyFileSync(join(here, "laravel", "routes-web.php"), join(app, "routes", "web.php"));
console.log("Laravel conformance app ready:", app);
