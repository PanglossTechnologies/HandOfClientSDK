#!/usr/bin/env node
// Self-test: run the whole suite against the in-memory reference host module. Passing means the suite and the
// fake platform agree with the contract as the reference host reads it; selftest/mutants.mjs proves the suite
// also fails when the contract is broken.
import { createReferenceHost } from "./reference-host.mjs";
import { runConformance } from "../run.mjs";
import { profile } from "../lib/profile.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };

const host = createReferenceHost({
  platformUrl: `http://127.0.0.1:${profile.platformPort()}`, apiKey: profile.apiKey(), tenantId: profile.tenantId(), webhookSecret: profile.webhookSecret(),
});
const baseUrl = await host.start();
const { code } = await runConformance({ baseUrl, freshDb: true, only: arg("only", null), reporter: arg("reporter", "spec") });
await host.stop();
process.exit(code);
