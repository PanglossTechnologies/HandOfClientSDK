import assert from "node:assert/strict";
import { test } from "node:test";
import { isStale, sign, verifySignature } from "../dist/esm/index.js";
import { parseIso } from "../dist/esm/timeutil.js";
import { toUser } from "../dist/esm/users.js";

// Test vector from openapi/site-hoc-api.yaml (/webhook)
const SECRET = "whsec_example_secret";
const BODY = Buffer.from('{"type":"build.status","eventId":"evt_01","sentAt":"2026-10-09T18:00:05Z","buildId":"3f2a9c1e5b7d4a8e9c0d1f2a3b4c5d6e","requestRef":"req-123","status":"NeedsInfo","message":"Which date range?"}');
const SIG = "sha256=33ea1034e3f86ff21fcb3036c05139790b60080144bbea0115540e05ee72f052";

test("signature matches the published test vector", () => {
  assert.equal(sign(SECRET, BODY), SIG);
  assert.ok(verifySignature(SECRET, BODY, SIG));
});

test("wrong or missing signatures are rejected", () => {
  for (const header of [undefined, null, "", "sha256=", "sha256=00", SIG.toUpperCase(), SIG.slice(7), SIG + "0", "sha1=" + SIG.slice(7)]) {
    assert.equal(verifySignature(SECRET, BODY, header), false, String(header));
  }
});

test("the signature covers every byte and the secret", () => {
  assert.equal(verifySignature(SECRET, Buffer.concat([BODY, Buffer.from(" ")]), SIG), false);
  assert.equal(verifySignature("whsec_other", BODY, SIG), false);
});

test("staleness window is 300 seconds either way", () => {
  const now = Date.parse("2026-10-09T18:00:00Z");
  assert.equal(isStale("2026-10-09T18:00:00Z", now), false);
  assert.equal(isStale("2026-10-09T17:55:01Z", now), false);
  assert.equal(isStale("2026-10-09T17:54:59Z", now), true);
  assert.equal(isStale("2026-10-09T18:04:59Z", now), false);
  assert.equal(isStale("2026-10-09T18:05:01Z", now), true);
});

test("an unparsable sentAt counts as stale", () => {
  for (const v of [undefined, null, 5, "", "yesterday", "2026-13-01T00:00:00Z", "2026-02-30T00:00:00Z", "2026-10-09", "2026-10-09T25:00:00Z"]) {
    assert.equal(isStale(v), true, String(v));
  }
});

test("parseIso handles fractions, zones and a missing zone", () => {
  const t = Date.parse("2026-10-09T18:00:05Z");
  assert.equal(parseIso("2026-10-09T18:00:05Z"), t);
  assert.equal(parseIso("2026-10-09T18:00:05.123Z"), t + 123);
  assert.equal(parseIso("2026-10-09T18:00:05.1234567Z"), t + 123); // 7 digits, as .NET writes
  assert.equal(parseIso("2026-10-09T20:00:05+02:00"), t);
  assert.equal(parseIso("2026-10-09T13:00:05-0500"), t);
  assert.equal(parseIso("2026-10-09 18:00:05"), t);
  assert.equal(parseIso("nope"), null);
});

test("toUser accepts objects with an id and treats anything else as signed out", () => {
  assert.deepEqual({ ...toUser({ id: 7, name: "Seven", email: "" }), raw: undefined }, { id: "7", name: "Seven", email: null, raw: undefined });
  for (const v of [null, undefined, false, "", "alice", 5, {}, { id: "" }, { id: null }, []]) assert.equal(toUser(v), null, JSON.stringify(v));
});
