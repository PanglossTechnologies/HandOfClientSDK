// Produces bundle-dist/ - the directory handed to `hoc-publish --bundle` (see package.json's
// publish/publish:dry-run scripts). A plugin bundle is a leaf artifact, not a library a host imports,
// so unlike sdk/embed-js's tsc-based build, everything (including @handofclient/embed-js and its own
// @handofclient/api dependency) is bundled into one self-contained plugin.js - the platform serves the
// bundle to a browser directly, which has no node_modules to resolve against.
import { cp, mkdir } from "node:fs/promises";
import * as esbuild from "esbuild";

await mkdir("bundle-dist", { recursive: true });

await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  // ESM, not IIFE: index.ts uses a top-level `await hoc.init(...)`, which esbuild only supports
  // outputting for module formats - loaded via <script type="module"> below.
  format: "esm",
  target: "es2022",
  outfile: "bundle-dist/plugin.js",
  minify: true,
});

await cp("src/index.html", "bundle-dist/index.html");

console.log("Built bundle-dist/ (plugin.js + index.html)");
