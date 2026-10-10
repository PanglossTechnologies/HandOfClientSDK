#!/usr/bin/env node
// Stamps a release version into the npm packages published by .github/workflows/release.yml, so a tag
// vX.Y.Z publishes them at X.Y.Z (the nuget job does the same with -p:PackageVersion).
//
//   node tools/ci/set-npm-release-version.mjs <version|vX.Y.Z|refs/tags/vX.Y.Z>
//
// The edit is made in the CI checkout right before `npm publish` and is never committed: package.json
// keeps its last released version between releases and the git tag is the source of truth.
// The packages are released together, so a dependency of one on another is pinned to the exact same
// version (an installed @handofclient/api gets the @handofclient/gen-ts it was built against).
// To try it locally, run it and then `git checkout -- gen/ts/package.json clients/ts/package.json sdk/embed-js/package.json`.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const targets = ["gen/ts/package.json", "clients/ts/package.json", "sdk/embed-js/package.json"];

const arg = process.argv[2];
if (!arg) {
  console.error("usage: set-npm-release-version.mjs <version>   (e.g. 0.2.0, v0.2.0 or refs/tags/v0.2.0)");
  process.exit(1);
}

const version = arg.replace(/^refs\/tags\//, "").replace(/^v/, "");
// Semver core plus an optional prerelease (0.2.0, 0.2.0-rc.1). No build metadata, no leading zeros.
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
if (!semver.test(version)) {
  console.error(`"${arg}" is not a release tag/version: expected vX.Y.Z or vX.Y.Z-prerelease (e.g. v0.2.0, v0.2.0-rc.1)`);
  process.exit(1);
}

const pkgs = targets.map((path) => ({ path, json: JSON.parse(readFileSync(join(root, path), "utf8")) }));
const names = new Set(pkgs.map((p) => p.json.name));

for (const { path, json } of pkgs) {
  json.version = version;
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const dep of Object.keys(json[field] ?? {})) {
      if (names.has(dep)) json[field][dep] = version;
    }
  }
  writeFileSync(join(root, path), JSON.stringify(json, null, 2) + "\n");
  console.log(`${json.name}: ${version} (${path})`);
}

// For the workflow: prereleases go out under the "next" dist-tag, never "latest".
if (process.env.GITHUB_OUTPUT) {
  writeFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ndist_tag=${version.includes("-") ? "next" : "latest"}\n`, { flag: "a" });
}