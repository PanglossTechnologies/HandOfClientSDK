// Builds the distributable WordPress plugin.
//
// Three jobs:
//
//  1. Copy sdk/embed-js's built embed.global.js into the plugin's own assets. The plugin loads it
//     from its own directory, never from the platform at runtime - fetching executable code from a
//     remote server violates the wordpress.org plugin guidelines outright, and it would also mean a
//     platform outage breaks the page rather than just the panel.
//  2. Stage exactly what ships into dist/staging/handofclient (tests and build scratch stay behind).
//  3. Zip the staged directory, ready to upload through Plugins > Add New > Upload.
//
// The archiver is bsdtar, not PowerShell's Compress-Archive: Compress-Archive on Windows PowerShell
// 5.1 writes entry names with backslash separators, which the ZIP spec forbids (4.4.17.1 requires
// forward slashes) and which some unzip implementations turn into files literally named
// "handofclient\includes\class-hoc-rest.php" in a flat directory. bsdtar ships in System32 on
// Windows 10+ and as the system tar on macOS, and writes correct entry names on both.
import { cp, mkdir, readFile, rm, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const execFileAsync = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const pluginDir = path.join(here, "handofclient");
const distDir = path.join(here, "dist");
const stagingDir = path.join(distDir, "staging");

const embedSource = path.join(repoRoot, "sdk/embed-js/dist/embed.global.js");
const embedTarget = path.join(pluginDir, "assets/js/embed.global.js");

// Present in the repo but not in the shipped plugin. tests/ is a developer tool, and shipping it
// would put an executable PHP file with no ABSPATH guard of its own into wp-content/plugins.
const EXCLUDE_FROM_DIST = new Set(["tests"]);

try {
  await access(embedSource);
} catch {
  console.error(
    `Missing ${path.relative(repoRoot, embedSource)}.\n` +
      `Build the SDK first:  npm run build --workspace=@handofclient/embed-js`,
  );
  process.exit(1);
}

await mkdir(path.dirname(embedTarget), { recursive: true });
await cp(embedSource, embedTarget);
console.log(`Copied embed.global.js -> ${path.relative(repoRoot, embedTarget)}`);

// The plugin header is the single source of truth for the version - a mismatch between it and the
// zip name is the kind of thing nobody notices until they are debugging the wrong build.
const header = await readFile(path.join(pluginDir, "handofclient.php"), "utf8");
const versionMatch = header.match(/^\s*\*\s*Version:\s*(.+)$/m);
if (!versionMatch) {
  console.error("Could not read the Version header from handofclient.php");
  process.exit(1);
}
const version = versionMatch[1].trim();

await rm(stagingDir, { recursive: true, force: true });
await mkdir(stagingDir, { recursive: true });

await cp(pluginDir, path.join(stagingDir, "handofclient"), {
  recursive: true,
  filter: (source) => {
    const relative = path.relative(pluginDir, source);
    if (relative === "") return true;
    return !EXCLUDE_FROM_DIST.has(relative.split(path.sep)[0]);
  },
});

const zipPath = path.join(distDir, `handofclient-${version}.zip`);
await rm(zipPath, { force: true });

// WordPress unzips the archive straight into wp-content/plugins, so it must contain a single
// top-level "handofclient/" directory - archiving the directory's *contents* installs a plugin with
// no folder of its own and breaks every plugin_dir_path() call in it.
const tarBin = process.platform === "win32" ? "C:\\Windows\\System32\\tar.exe" : "tar";
await execFileAsync(tarBin, ["-a", "-c", "-f", zipPath, "-C", stagingDir, "handofclient"]);

await rm(stagingDir, { recursive: true, force: true });

console.log(`Built ${path.relative(repoRoot, zipPath)}`);
