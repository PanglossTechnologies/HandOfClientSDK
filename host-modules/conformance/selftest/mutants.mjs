#!/usr/bin/env node
// Mutation check: start the reference host with one deliberate contract violation at a time and require the
// suite to fail, naming the test that caught it. A mutant that survives means a hole in the suite.
import { createReferenceHost } from "./reference-host.mjs";
import { runConformance } from "../run.mjs";
import { profile } from "../lib/profile.mjs";

// bug flag -> a fragment of the test title that must fail because of it
const MUTANTS = {
  "token-no-visibility": "can never get a token for a feature they cannot see",
  "user-from-query": "session user, never a value from the request",
  "webhook-no-signature": "missing or wrong signatures are 401",
  "webhook-no-stale-check": "outside the 300 second tolerance",
  "everyone-beats-user": "specific user beats an assignment to everyone",
  "pin-leaks": "pin keeps an older version for the caller only",
  "share-ignore-policy": "follows the shareWithNamedUsers setting",
};

let survivors = 0;
for (const [bug, expected] of Object.entries(MUTANTS)) {
  const host = createReferenceHost({ platformUrl: `http://127.0.0.1:${profile.platformPort()}`, apiKey: profile.apiKey(), tenantId: profile.tenantId(), webhookSecret: profile.webhookSecret(), bugs: [bug] });
  const baseUrl = await host.start();
  const { code, output } = await runConformance({ baseUrl, quiet: true });
  await host.stop();
  const caught = code !== 0 && output.split("\n").some((l) => l.includes("✖") && l.includes(expected));
  if (!caught) survivors++;
  console.log(`${caught ? "KILLED  " : "SURVIVED"} ${bug}${caught ? "" : `  (exit ${code}, expected a failure in "${expected}")`}`);
}
if (survivors) { console.error(`${survivors} mutant(s) survived`); process.exit(1); }
console.log("all mutants killed");
