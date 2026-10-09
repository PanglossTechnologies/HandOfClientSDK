#!/usr/bin/env node
import { PublishError, publish } from "./publish.js";

function printUsageAndExit(code: number): never {
  console.error(`Usage: hoc-publish --manifest <manifest.json> --bundle <bundle-dir> --api-base-url <url> --api-key <key> [--host-id <id>] [--json] [--dry-run]

  --manifest       Path to the author manifest.json (see src/authorManifest.ts for the schema)
  --bundle         Path to the directory containing the plugin's static bundle files
  --api-base-url   Platform API base URL, e.g. https://api.handofclient.com   (or env HOC_API_BASE_URL)
  --api-key        Host API key (from RegisterHost) - never commit this to source control   (or env HOC_API_KEY)
  --host-id        Publish as this host; required when --api-key is the platform super-admin key
                   (build automation). Sent as x-hoc-host.   (or env HOC_HOST_ID)
  --json           Print one machine-readable result object to stdout (progress goes to stderr)
  --dry-run        Validate and pack, print entry integrity hashes, but do not upload or publish anything

For "render": "inject" manifests the bundle must be a single self-contained JS module; the sha256 SRI
of each entry file is printed (the value for <script type="module" integrity=...>).
`);
  process.exit(code);
}

interface CliArgs {
  manifest?: string;
  bundle?: string;
  apiBaseUrl?: string;
  apiKey?: string;
  hostId?: string;
  json: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = { json: false, dryRun: false };
  const value = (i: number): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) {
      console.error(`Missing value for ${argv[i - 1]}`);
      printUsageAndExit(1);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--manifest": result.manifest = value(++i); break;
      case "--bundle": result.bundle = value(++i); break;
      case "--api-base-url": result.apiBaseUrl = value(++i); break;
      case "--api-key": result.apiKey = value(++i); break;
      case "--host-id": result.hostId = value(++i); break;
      case "--json": result.json = true; break;
      case "--dry-run": result.dryRun = true; break;
      case "--help": case "-h": printUsageAndExit(0);
      default: console.error(`Unknown argument: ${argv[i]}`); printUsageAndExit(1);
    }
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = args.apiKey ?? process.env.HOC_API_KEY;
  if (!args.manifest || !args.bundle || !apiKey) printUsageAndExit(1);
  // apiBaseUrl has a narrow, safe default for dry runs (never actually contacted); required otherwise.
  const apiBaseUrl = args.apiBaseUrl ?? process.env.HOC_API_BASE_URL ?? (args.dryRun ? "https://unused.invalid" : undefined);
  if (!apiBaseUrl) printUsageAndExit(1);
  const hostId = args.hostId ?? process.env.HOC_HOST_ID;

  // --json keeps stdout clean for the result object, so progress lines move to stderr.
  const log = args.json ? (line: string) => console.error(line) : (line: string) => console.log(line);

  try {
    const result = await publish({ manifestPath: args.manifest, bundleDir: args.bundle, apiBaseUrl, apiKey, hostId, dryRun: args.dryRun }, log);
    if (args.json) console.log(JSON.stringify(result));
  } catch (error) {
    if (error instanceof PublishError) {
      console.error(`\nFAILED: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

await main();
