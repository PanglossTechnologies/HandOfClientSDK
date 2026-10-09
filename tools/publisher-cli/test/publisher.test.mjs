// hoc-publish tests: manifest/bundle validation (negative cases) and an end-to-end publish of an iframe
// bundle and an inject bundle against a stub platform that speaks the real wire formats (raw zip upload
// at POST /internal/bundles, grpc-web PublishVersion). Needs `npm run build` first (uses dist/).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { PublishVersionRequest, PublishVersionResponse, PackageVersion, RenderMode, FeatureKind } from "@handofclient/gen-ts/handofclient/v1/package_registry_pb";
import { validateAuthorManifest } from "../dist/authorManifest.js";
import { packDirectory, scanInjectEntry } from "../dist/bundle.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist", "cli.js");

const sri = (bytes) => `sha256-${createHash("sha256").update(bytes).digest("base64")}`;

const baseManifest = (over = {}) => ({
  packageId: "acme/orders-tweak", publisher: "Acme", name: "Orders tweak", version: "1.0.0", hostId: "acme-host",
  entryPoints: { main: "feature.js" },
  slots: [{ slotId: "main", kind: "panel", hostPanelId: "main" }],
  ...over,
});
const injectManifest = (over = {}) => baseManifest({ render: "inject", kind: "page-override", path: "/orders", ...over });
const issuesFor = (manifest, files = ["feature.js", "index.html"]) =>
  validateAuthorManifest(manifest, new Set(files)).map((i) => `${i.field}: ${i.message}`);

describe("manifest validation: inject and feature fields", () => {
  test("a valid inject manifest has no issues", () => {
    assert.deepEqual(issuesFor(injectManifest()), []);
  });

  test("inject allows several slot ids to share the one entry file", () => {
    const manifest = injectManifest({
      entryPoints: { a: "feature.js", b: "./feature.js" },
      slots: [{ slotId: "a", kind: "panel", hostPanelId: "a" }, { slotId: "b", kind: "panel", hostPanelId: "b" }],
    });
    assert.deepEqual(issuesFor(manifest), []);
  });

  test("inject with two different entry files is rejected", () => {
    const manifest = injectManifest({
      entryPoints: { a: "feature.js", b: "other.js" },
      slots: [{ slotId: "a", kind: "panel", hostPanelId: "a" }, { slotId: "b", kind: "panel", hostPanelId: "b" }],
    });
    assert.ok(issuesFor(manifest, ["feature.js", "other.js"]).some((i) => i.includes("single JS module entry")));
  });

  test("inject with an HTML entry is rejected", () => {
    const manifest = injectManifest({ entryPoints: { main: "index.html" } });
    assert.ok(issuesFor(manifest).some((i) => i.includes("must be a JavaScript module")));
  });

  test("inject combined with strictCsp is rejected", () => {
    assert.ok(issuesFor(injectManifest({ strictCsp: true })).some((i) => i.includes("strictCsp")));
  });

  test("the same HTML entry is fine for iframe mode", () => {
    assert.deepEqual(issuesFor(baseManifest({ entryPoints: { main: "index.html" } })), []);
  });

  for (const bad of ["orders", "//evil.example/x", "/orders?x=1", "/orders#top", "/or ders", ""]) {
    test(`page-override path ${JSON.stringify(bad)} is rejected`, () => {
      assert.ok(issuesFor(injectManifest({ path: bad })).some((i) => i.startsWith("path:")));
    });
  }

  test("path on a slot-kind feature is rejected", () => {
    assert.ok(issuesFor(baseManifest({ kind: "slot", path: "/orders" })).some((i) => i.startsWith("path:")));
  });

  test("unknown render and kind values are rejected", () => {
    const issues = issuesFor(baseManifest({ render: "popup", kind: "sidebar" }));
    assert.ok(issues.some((i) => i.startsWith("render:")));
    assert.ok(issues.some((i) => i.startsWith("kind:")));
  });
});

describe("scanInjectEntry", () => {
  let dir;
  before(async () => { dir = await mkdtemp(path.join(tmpdir(), "hoc-inject-scan-")); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  const scan = async (source) => {
    await writeFile(path.join(dir, "e.js"), source);
    const packed = await packDirectory(dir);
    return scanInjectEntry(packed.files.find((f) => f.relativePath === "e.js"));
  };

  test("a self-contained module passes", async () => {
    assert.deepEqual(await scan(`const m = import.meta.url; export const x = 1; console.log("import is a word", m);`), []);
  });

  for (const [name, source] of [
    ["relative static import", `import { a } from "./a.js"; a();`],
    ["bare static import", `import lodash from 'lodash'; lodash();`],
    ["side-effect import", `import "./polyfill.js";`],
    ["minified import", `import{a as b}from"./chunk-1.js";b();`],
    ["re-export", `export * from "./other.js";`],
    ["named re-export", `export { a } from './other.js';`],
    ["literal dynamic import", `const m = await import("./lazy.js");`],
  ]) {
    test(`${name} is flagged`, async () => {
      const issues = await scan(source);
      assert.equal(issues.length, 1, JSON.stringify(issues));
      assert.match(issues[0].message, /self-contained/);
    });
  }
});

// ---- end to end against a stub platform -------------------------------------------------------------

const frame = (flag, payload) => {
  const out = Buffer.alloc(5 + payload.length);
  out[0] = flag;
  out.writeUInt32BE(payload.length, 1);
  Buffer.from(payload).copy(out, 5);
  return out;
};
const trailer = (status, message = "") => frame(0x80, Buffer.from(`grpc-status: ${status}\r\n${message ? `grpc-message: ${message}\r\n` : ""}`));

describe("hoc-publish end to end (stub platform)", () => {
  let server, baseUrl, work;
  /** @type {{uploads: any[], publishes: any[]}} */
  let seen;
  // Per-test knobs.
  let behavior;

  before(async () => {
    work = await mkdtemp(path.join(tmpdir(), "hoc-publish-e2e-"));
    server = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      if (req.method === "POST" && req.url === "/internal/bundles") {
        seen.uploads.push({ key: req.headers["x-api-key"], size: body.length });
        if (behavior.rejectUpload) { res.writeHead(401).end(); return; }
        const bundleHash = createHash("sha256").update(body).digest("hex");
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ bundleHash }));
        return;
      }
      if (req.method === "POST" && req.url === "/handofclient.v1.PackageRegistry/PublishVersion") {
        const request = PublishVersionRequest.fromBinary(body.subarray(5));
        seen.publishes.push({ key: req.headers["x-api-key"], host: req.headers["x-hoc-host"], request });
        res.writeHead(200, { "content-type": "application/grpc-web+proto" });
        if (behavior.publishError) { res.end(trailer(6, behavior.publishError)); return; }
        const manifest = request.manifest.clone();
        if (manifest.render === RenderMode.INJECT) {
          // The real platform overwrites file_integrity with its own SRI of each entry point.
          for (const file of Object.values(manifest.bundle.entryPoints)) {
            manifest.bundle.fileIntegrity[file] = behavior.platformIntegrity ?? manifest.bundle.fileIntegrity[file];
          }
        }
        const message = new PublishVersionResponse({ version: new PackageVersion({ packageId: manifest.packageId, version: manifest.version, manifest }) });
        res.end(Buffer.concat([frame(0, message.toBinary()), trailer(0)]));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(work, { recursive: true, force: true });
  });

  const run = (args, env = {}) => new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { env: { ...process.env, ...env }, timeout: 60_000 }, (error, stdout, stderr) =>
      resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr }));
  });

  /** Writes manifest.json + a bundle dir and returns the CLI args to publish them. */
  const fixture = async (name, manifest, files) => {
    const dir = path.join(work, name);
    const bundle = path.join(dir, "bundle");
    await mkdir(bundle, { recursive: true });
    await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest));
    for (const [file, text] of Object.entries(files)) await writeFile(path.join(bundle, file), text);
    return ["--manifest", path.join(dir, "manifest.json"), "--bundle", bundle];
  };

  const reset = (over = {}) => { seen = { uploads: [], publishes: [] }; behavior = over; };

  test("publishes an iframe bundle", async () => {
    reset();
    const args = await fixture("iframe", baseManifest({ entryPoints: { main: "index.html" } }),
      { "index.html": "<html><body>hi</body></html>", "plugin.js": "console.log(1);" });
    const result = await run([...args, "--api-base-url", baseUrl, "--api-key", "host-key"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(seen.uploads.length, 1);
    assert.equal(seen.uploads[0].key, "host-key");
    assert.equal(seen.publishes.length, 1);
    const { manifest } = seen.publishes[0].request;
    assert.equal(manifest.render, RenderMode.IFRAME);
    assert.equal(manifest.kind, FeatureKind.SLOT);
    assert.equal(manifest.bundle.entryPoints.main, "index.html");
    assert.equal(seen.publishes[0].host, undefined);
    assert.match(result.stdout, /iframe entry main: index\.html {2}integrity sha256-/);
    assert.match(result.stdout, /Published\./);
  });

  test("publishes an inject bundle, prints and verifies its SRI, sends x-hoc-host", async () => {
    reset();
    const source = `const root = document.body; root.append("hello");\nexport {};\n`;
    const args = await fixture("inject", injectManifest(), { "feature.js": source });
    const result = await run([...args, "--api-base-url", baseUrl, "--api-key", "super-key", "--host-id", "acme-host", "--json"]);
    assert.equal(result.code, 0, result.stderr);

    const expected = sri(Buffer.from(source));
    const printed = JSON.parse(result.stdout); // stdout is exactly one JSON object with --json
    assert.equal(printed.published, true);
    assert.equal(printed.render, "inject");
    assert.deepEqual(printed.entries, [{ slotId: "main", path: "feature.js", integrity: expected }]);
    assert.match(result.stderr, new RegExp(`inject entry main: feature\\.js {2}integrity ${expected}`));

    const sent = seen.publishes[0];
    assert.equal(sent.host, "acme-host");
    assert.equal(sent.key, "super-key");
    assert.equal(sent.request.manifest.render, RenderMode.INJECT);
    assert.equal(sent.request.manifest.kind, FeatureKind.PAGE_OVERRIDE);
    assert.equal(sent.request.manifest.path, "/orders");
    assert.equal(sent.request.manifest.bundle.fileIntegrity["feature.js"], expected);
    assert.equal(sent.request.manifest.bundle.bundleHash, printed.bundleHash);
  });

  test("reads key, base url and host from the environment", async () => {
    reset();
    const args = await fixture("env", injectManifest(), { "feature.js": "export {};" });
    const result = await run(args, { HOC_API_KEY: "env-key", HOC_API_BASE_URL: baseUrl, HOC_HOST_ID: "env-host" });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(seen.publishes[0].key, "env-key");
    assert.equal(seen.publishes[0].host, "env-host");
  });

  test("--dry-run prints the integrity and contacts nothing", async () => {
    reset();
    const source = "export {};";
    const args = await fixture("dry", injectManifest(), { "feature.js": source });
    const result = await run([...args, "--api-key", "x", "--dry-run"]);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes(sri(Buffer.from(source))));
    assert.match(result.stdout, /Dry run/);
    assert.equal(seen.uploads.length + seen.publishes.length, 0);
  });

  test("an inject bundle that imports another module fails before upload", async () => {
    reset();
    const args = await fixture("imports", injectManifest(), { "feature.js": `import { a } from "./a.js"; a();`, "a.js": "export const a = () => {};" });
    const result = await run([...args, "--api-base-url", baseUrl, "--api-key", "k"]);
    assert.equal(result.code, 1);
    assert.match(result.stdout + result.stderr, /HYGIENE ISSUE \[feature\.js\].*self-contained/);
    assert.equal(seen.uploads.length, 0);
  });

  test("an inject manifest with an HTML entry fails before upload", async () => {
    reset();
    const args = await fixture("html-entry", injectManifest({ entryPoints: { main: "index.html" } }), { "index.html": "<html></html>" });
    const result = await run([...args, "--api-base-url", baseUrl, "--api-key", "k"]);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /MANIFEST ERROR \[entryPoints\].*JavaScript module/);
    assert.equal(seen.uploads.length, 0);
  });

  test("a platform that records a different integrity is reported as a failure", async () => {
    reset({ platformIntegrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" });
    const args = await fixture("mismatch", injectManifest(), { "feature.js": "export {};" });
    const result = await run([...args, "--api-base-url", baseUrl, "--api-key", "k"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /platform recorded integrity/);
  });

  test("a rejected upload fails with its status", async () => {
    reset({ rejectUpload: true });
    const args = await fixture("upload-401", injectManifest(), { "feature.js": "export {};" });
    const result = await run([...args, "--api-base-url", baseUrl, "--api-key", "bad"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Bundle upload failed: 401/);
    assert.equal(seen.publishes.length, 0);
  });

  test("an already-published version fails with the platform's reason", async () => {
    reset({ publishError: "already published" });
    const args = await fixture("dupe", injectManifest(), { "feature.js": "export {};" });
    const result = await run([...args, "--api-base-url", baseUrl, "--api-key", "k"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /PublishVersion failed:.*already published/);
  });

  test("a missing manifest file is a clean failure, not a stack trace", async () => {
    reset();
    const dir = path.join(work, "nomanifest");
    await mkdir(dir, { recursive: true });
    const result = await run(["--manifest", path.join(dir, "nope.json"), "--bundle", dir, "--api-key", "k", "--dry-run"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /FAILED: Could not read manifest/);
  });

  test("missing required arguments print usage", async () => {
    const result = await run(["--bundle", work]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Usage: hoc-publish/);
  });
});
