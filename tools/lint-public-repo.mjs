#!/usr/bin/env node
// Public-repo lint: this repository is public and must explain itself, so it may not point at private
// tooling, private paths or internal design documents. Fails (exit 1) on banned terms in tracked files
// outside the allowlist below, and on broken relative links in README.md and docs/*.md.
//
//   node tools/lint-public-repo.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Case-insensitive banned terms. Add a term here when something private leaks once. */
const BANNED = [
  "DotNetShared",
  "ProjectsAzure",
  "createpluginforcustomer",
  "iterdone",
  "/internal/",
  "design doc",
];

/**
 * Files allowed to contain a banned term, with the reason. Keep this list short and justified.
 * Paths are repo-relative, forward slashes.
 */
const ALLOWLIST = new Map([
  ["tools/lint-public-repo.mjs", "defines the banned terms"],
]);

/** Tracked files that are never scanned (lockfiles and vendored dependency trees). */
const SKIP = [/(^|\/)package-lock\.json$/, /(^|\/)vendor\//, /(^|\/)node_modules\//, /\.(png|jpg|jpeg|gif|ico|woff2?|zip|phar)$/i];

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  .split("\0")
  .filter(Boolean);

const problems = [];

for (const file of tracked) {
  if (SKIP.some((re) => re.test(file)) || ALLOWLIST.has(file)) continue;
  const path = join(root, file);
  if (!existsSync(path)) continue;
  const buffer = readFileSync(path);
  if (buffer.includes(0)) continue; // binary
  const lines = buffer.toString("utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    const lower = line.toLowerCase();
    for (const term of BANNED) {
      if (lower.includes(term.toLowerCase())) problems.push(`${file}:${index + 1}: banned term "${term}"`);
    }
  });
}

// Relative markdown links in README.md and docs/*.md must point at files that exist.
const linkPattern = /\]\((?!https?:|mailto:|#)([^)#\s]+)(#[^)\s]*)?\)/g;
for (const file of tracked.filter((f) => f === "README.md" || /^docs\/[^/]+\.md$/.test(f))) {
  const text = readFileSync(join(root, file), "utf8");
  for (const match of text.matchAll(linkPattern)) {
    const target = resolve(root, dirname(file), decodeURIComponent(match[1]));
    if (!existsSync(target)) problems.push(`${file}: broken relative link "${match[1]}"`);
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} problem(s). See tools/lint-public-repo.mjs for the banned terms and allowlist.`);
  process.exit(1);
}
console.log(`public-repo lint clean (${tracked.length} tracked files checked).`);
