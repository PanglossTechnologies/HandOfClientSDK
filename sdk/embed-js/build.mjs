// Bundles the host-side SDK into one dependency-free, browser-global script for hosts with no JS
// bundler of their own (drop a plain <script src="embed.global.js">). Runs after `tsc` (see
// package.json's build script) - tsc produces the per-module dist/ output that "@handofclient/embed-js/host"
// and "/plugin" resolve to; esbuild separately bundles the *source* directly into one IIFE, since a
// browser-global script needs everything (including @handofclient/api and its own dependencies)
// inlined rather than left as ES module imports.
import * as esbuild from "esbuild";
import { copyFile, readFile, writeFile } from "node:fs/promises";

await esbuild.build({
  entryPoints: ["src/host/global.ts"],
  bundle: true,
  format: "iife",
  target: "es2022",
  outfile: "dist/embed.global.js",
  minify: true,
});

console.log("Built dist/embed.global.js");

// hoc-head.js is a hand-written inline snippet (hides the body until autoMount finishes). Ship it as-is
// and minified, since sites paste the minified form into <head>.
await copyFile("src/host/hoc-head.js", "dist/hoc-head.js");
const head = await esbuild.transform(await readFile("src/host/hoc-head.js", "utf8"), { minify: true, target: "es2015" });
await writeFile("dist/hoc-head.min.js", head.code);
console.log("Built dist/hoc-head.js, dist/hoc-head.min.js");
