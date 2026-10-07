// Bundles the host-side SDK into one dependency-free, browser-global script for hosts with no JS
// bundler of their own (drop a plain <script src="embed.global.js">). Runs after `tsc` (see
// package.json's build script) - tsc produces the per-module dist/ output that "@handofclient/embed-js/host"
// and "/plugin" resolve to; esbuild separately bundles the *source* directly into one IIFE, since a
// browser-global script needs everything (including @handofclient/api and its own dependencies)
// inlined rather than left as ES module imports.
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/host/global.ts"],
  bundle: true,
  format: "iife",
  target: "es2022",
  outfile: "dist/embed.global.js",
  minify: true,
});

console.log("Built dist/embed.global.js");
