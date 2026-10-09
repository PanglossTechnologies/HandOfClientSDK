import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { ZipFile } from "yazl";

// Mirrors services/platform/HandOfClient.Platform/Storage/BundleStore.cs's caps exactly, checked here
// too so an oversized bundle fails fast with a clear local message instead of a late server rejection
// after however long the upload took.
const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_ENTRY_COUNT = 5000;

export interface PackedFile {
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  sri: string; // "sha256-<base64>"
}

export interface PackedBundle {
  zipBytes: Buffer;
  bundleHash: string; // sha256 hex of zipBytes - what the server's BundleStore also computes
  files: PackedFile[];
}

export interface HygieneIssue {
  file: string;
  message: string;
}

export async function packDirectory(bundleDir: string): Promise<PackedBundle> {
  const relativePaths = await walk(bundleDir);
  if (relativePaths.length > MAX_ENTRY_COUNT) {
    throw new Error(`Bundle has ${relativePaths.length} files, exceeding the ${MAX_ENTRY_COUNT}-entry cap`);
  }

  const files: PackedFile[] = [];
  const zip = new ZipFile();
  let totalBytes = 0;

  for (const relativePath of relativePaths.sort()) {
    const absolutePath = join(bundleDir, relativePath);
    const contents = await readFile(absolutePath);
    totalBytes += contents.length;
    if (totalBytes > MAX_UNCOMPRESSED_BYTES) {
      throw new Error(`Bundle exceeds the ${MAX_UNCOMPRESSED_BYTES / (1024 * 1024)} MB uncompressed cap`);
    }
    const sri = `sha256-${createHash("sha256").update(contents).digest("base64")}`;
    files.push({ relativePath, absolutePath, sizeBytes: contents.length, sri });
    zip.addBuffer(contents, relativePath);
  }
  zip.end();

  const zipBytes = await streamToBuffer(zip.outputStream);
  const bundleHash = createHash("sha256").update(zipBytes).digest("hex");

  return { zipBytes, bundleHash, files };
}

/** Hygiene checks only - not a security boundary (the boundary is origin sandboxing + CSP +
 * server-side scope enforcement, see design doc "6. Relationship to DotNetShared.Extensibility"). Text
 * pattern matching is trivially defeated by minification/eval/dynamic import against a determined
 * adversary; this exists to catch honest-author mistakes and obvious red flags, not to vet hostile
 * code. */
export async function scanForHygieneIssues(files: PackedFile[]): Promise<HygieneIssue[]> {
  const issues: HygieneIssue[] = [];
  const textFilePattern = /\.(js|mjs|cjs|map|html|json)$/i;

  for (const file of files) {
    if (/(^|\/)sw\.js$/i.test(file.relativePath) || /service-?worker/i.test(file.relativePath)) {
      issues.push({ file: file.relativePath, message: "filename suggests a service worker, which plugins may not register" });
    }
    if (!textFilePattern.test(file.relativePath)) continue;

    const text = await readFile(file.absolutePath, "utf8");
    if (/navigator\s*\.\s*serviceWorker\s*\.\s*register\s*\(/.test(text)) {
      issues.push({ file: file.relativePath, message: "registers a service worker (navigator.serviceWorker.register) - not allowed, see design doc security model" });
    }
    if (/\beval\s*\(/.test(text) || /new\s+Function\s*\(/.test(text)) {
      issues.push({ file: file.relativePath, message: "contains eval()/new Function() - dynamic code execution is disallowed" });
    }
    for (const secretMatch of scanForSecretPatterns(text)) {
      issues.push({ file: file.relativePath, message: secretMatch });
    }
  }
  return issues;
}

// Static `import x from "y"` / `import "y"`, `export ... from "y"`, and `import("y")` with a literal
// specifier. Bounded quantifiers keep the scan linear on large minified bundles.
const IMPORT_SPECIFIER_PATTERNS = [
  /\bimport\s*(?:[\w$*{}\s,]{1,2000}?\s*from\s*)?(["'])([^"'\n]{1,500})\1/g,
  /\bexport\s*(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]{0,2000}\})\s*from\s*(["'])([^"'\n]{1,500})\1/g,
  /\bimport\s*\(\s*(["'`])([^"'`\n]{1,500})\1\s*\)/g,
];

/** An inject entry is the only file the browser verifies against the published sha256, so it must not
 * pull in any other module: a relative import would load unverified bytes, and a bare specifier
 * ("lodash") cannot resolve in a browser at all. Bundle dependencies into the one file instead.
 * Hygiene only (a regex over source), like scanForHygieneIssues. */
export async function scanInjectEntry(entry: PackedFile): Promise<HygieneIssue[]> {
  const text = await readFile(entry.absolutePath, "utf8");
  const specifiers = new Set<string>();
  for (const pattern of IMPORT_SPECIFIER_PATTERNS) {
    for (const match of text.matchAll(pattern)) specifiers.add(match[2]);
  }
  return [...specifiers].map((specifier) => ({
    file: entry.relativePath,
    message: `imports "${specifier}" - an inject entry must be one self-contained module (only this file is covered by the integrity hash); bundle all dependencies into it`,
  }));
}

function scanForSecretPatterns(text: string): string[] {
  const found: string[] = [];
  if (/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) found.push("contains an embedded private key");
  if (/AKIA[0-9A-Z]{16}/.test(text)) found.push("contains what looks like an AWS access key ID");
  if (/sk_live_[0-9a-zA-Z]{16,}/.test(text)) found.push("contains what looks like a live Stripe secret key");
  if (/AIza[0-9A-Za-z\-_]{35}/.test(text)) found.push("contains what looks like a Google API key");
  return found;
}

async function walk(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walk(full, base)));
    } else if (entry.isFile()) {
      results.push(relative(base, full).replace(/\\/g, "/"));
    }
  }
  return results;
}

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(chunk as Buffer));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

export async function fileExistsAndIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
