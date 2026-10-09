/**
 * Which PHP the harness and the conformance runner use. Windows: the build setup.mjs downloads into
 * .wp-local/php (its own php.ini). Anywhere else, or when HOC_PHP is set: the `php` on PATH (CI
 * installs it with setup-php, which already has the needed extensions and CA bundle).
 */
import path from "node:path";

export function resolvePhp(wpLocal) {
  const override = process.env.HOC_PHP;
  if (override) return { php: override, bundled: false };
  if (process.platform === "win32") return { php: path.join(wpLocal, "php", "php.exe"), bundled: true };
  return { php: "php", bundled: false };
}
