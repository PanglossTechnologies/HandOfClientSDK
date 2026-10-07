#!/usr/bin/env node
import { PublishError, publish } from "./publish.js";

function printUsageAndExit(code: number): never {
  console.error(`Usage: hoc-publish --manifest <manifest.json> --bundle <bundle-dir> --api-base-url <url> --api-key <key> [--dry-run]

  --manifest       Path to the author manifest.json (see src/authorManifest.ts for the schema)
  --bundle         Path to the directory containing the plugin's static bundle files
  --api-base-url   Platform API base URL, e.g. https://api.handofclient.com
  --api-key        Host API key (from RegisterHost) - never commit this to source control
  --dry-run        Validate and pack, but do not upload or publish anything
`);
  process.exit(code);
}

function parseArgs(argv: string[]): { manifest?: string; bundle?: string; apiBaseUrl?: string; apiKey?: string; dryRun: boolean } {
  const result: { manifest?: string; bundle?: string; apiBaseUrl?: string; apiKey?: string; dryRun: boolean } = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--manifest": result.manifest = argv[++i]; break;
      case "--bundle": result.bundle = argv[++i]; break;
      case "--api-base-url": result.apiBaseUrl = argv[++i]; break;
      case "--api-key": result.apiKey = argv[++i]; break;
      case "--dry-run": result.dryRun = true; break;
      case "--help": case "-h": printUsageAndExit(0);
      default: console.error(`Unknown argument: ${argv[i]}`); printUsageAndExit(1);
    }
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.manifest || !args.bundle || !args.apiKey) printUsageAndExit(1);
  // apiBaseUrl has a narrow, safe default for dry runs (never actually contacted); required otherwise.
  const apiBaseUrl = args.apiBaseUrl ?? (args.dryRun ? "https://unused.invalid" : undefined);
  if (!apiBaseUrl) printUsageAndExit(1);

  try {
    await publish({ manifestPath: args.manifest, bundleDir: args.bundle, apiBaseUrl, apiKey: args.apiKey, dryRun: args.dryRun });
  } catch (error) {
    if (error instanceof PublishError) {
      console.error(`\nFAILED: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

await main();
