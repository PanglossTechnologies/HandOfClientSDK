// Builds both module formats with tsc: dist/esm (ES modules) and dist/cjs (CommonJS).
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
rmSync(join(root, "dist"), { recursive: true, force: true });
for (const project of ["tsconfig.json", "tsconfig.cjs.json"]) {
  execFileSync(process.execPath, [tsc, "-p", join(root, project)], { stdio: "inherit", cwd: root });
}
// package.json has no "type", so .js files are CommonJS by default; the esm folder must say it is not.
mkdirSync(join(root, "dist", "esm"), { recursive: true });
writeFileSync(join(root, "dist", "esm", "package.json"), '{"type":"module"}\n');
writeFileSync(join(root, "dist", "cjs", "package.json"), '{"type":"commonjs"}\n');
