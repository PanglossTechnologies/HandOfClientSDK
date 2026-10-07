// Produces bundle-dist/ - the directory handed to `hoc-publish --bundle` (see package.json's
// publish/publish:dry-run scripts). Mirrors samples/plugins/hello-world/build.mjs.
import { cp, mkdir } from "node:fs/promises";
import * as esbuild from "esbuild";

await mkdir("bundle-dist", { recursive: true });

await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  // ESM, not IIFE: index.ts uses a top-level `await hoc.init(...)`.
  format: "esm",
  target: "es2022",
  outfile: "bundle-dist/plugin.js",
  minify: true,
});

await cp("src/index.html", "bundle-dist/index.html");

console.log("Built bundle-dist/ (plugin.js + index.html)");
