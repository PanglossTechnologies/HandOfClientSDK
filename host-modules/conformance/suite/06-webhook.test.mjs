// POST webhook: HMAC verification, replay/stale protection, and what each event does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { as, platform } from "../lib/client.mjs";
import { profile, USERS } from "../lib/profile.mjs";
import { signBody } from "../fake-platform/platform.mjs";
import { buildCallFor, createFeature, expectError, expectOk, featureFor, submit, uid, uniquePath } from "../lib/world.mjs";

const statusEvent = (requestRef, status, extra = {}) => ({
  type: "build.status", eventId: uid("evt-"), sentAt: new Date().toISOString(), buildId: "0".repeat(32), requestRef, status, message: null, ...extra,
});
const versionEvent = (requestRef, featureRef, version, extra = {}) => ({
  type: "build.version", eventId: uid("evt-"), sentAt: new Date().toISOString(), buildId: "0".repeat(32), requestRef, featureRef,
  packageId: `${profile.hostId()}/f-${featureRef}`, version, sha256: "a".repeat(64), entry: "index.js", kind: "page-override", path: uniquePath("wh"), slotId: "main", mode: "inject", ...extra,
});
const request = async (user, id) => expectOk(await as(user).get("api/requests", { limit: "200" })).requests.find((r) => r.id === id);

test("the signing helper reproduces the published test vector", () => {
  const body = '{"type":"build.status","eventId":"evt_01","sentAt":"2026-10-09T18:00:05Z","buildId":"3f2a9c1e5b7d4a8e9c0d1f2a3b4c5d6e","requestRef":"req-123","status":"NeedsInfo","message":"Which date range?"}';
  assert.equal(signBody("whsec_example_secret", body), "sha256=33ea1034e3f86ff21fcb3036c05139790b60080144bbea0115540e05ee72f052");
});

test("a correctly signed event is accepted and applied", async () => {
  const r = await submit("alice", "needs info");
  const res = await platform.deliver({ body: statusEvent(r.id, "NeedsInfo", { message: "Which date range?" }) });
  assert.equal(res.status, 200, res.text);
  const after = await request("alice", r.id);
  assert.equal(after.status, "NeedsInfo");
  assert.equal(after.message, "Which date range?");
});

test("missing or wrong signatures are 401 invalid_signature and change nothing", async () => {
  const r = await submit("alice", "signature checks");
  const event = statusEvent(r.id, "Success");
  const raw = JSON.stringify(event);
  const attempts = {
    "no signature header": { body: event, omitSignature: true },
    "zero signature": { body: event, signature: "sha256=" + "0".repeat(64) },
    "empty signature": { body: event, signature: "" },
    "wrong secret": { body: event, secret: "whsec_not_the_secret" },
    "missing sha256= prefix": { body: event, signature: signBody(profile.webhookSecret(), raw).slice("sha256=".length) },
    "signature over a different body": { rawBody: raw, signature: signBody(profile.webhookSecret(), JSON.stringify({ ...event, status: "Rejected" })) },
    "body tampered after signing": { rawBody: raw.replace("Success", "Rejected"), signature: signBody(profile.webhookSecret(), raw) },
  };
  for (const [name, a] of Object.entries(attempts)) {
    const res = await platform.deliver(a);
    assert.equal(res.status, 401, `${name}: expected 401, got ${res.status} ${res.text}`);
    assert.equal(res.body?.error, "invalid_signature", name);
  }
  assert.equal((await request("alice", r.id)).status, "InProgress", "no rejected event may have been applied");
});

test("the signature covers the raw bytes, not a re-serialisation", async () => {
  const r = await submit("alice", "raw bytes");
  const pretty = JSON.stringify(statusEvent(r.id, "NeedsInfo", { message: "pretty" }), null, 2);
  const compactSignature = signBody(profile.webhookSecret(), JSON.stringify(JSON.parse(pretty)));
  const wrong = await platform.deliver({ rawBody: pretty, signature: compactSignature });
  assert.equal(wrong.status, 401, "signed over the compact form but sent pretty-printed");
  assert.equal((await request("alice", r.id)).status, "InProgress");
  const right = await platform.deliver({ rawBody: pretty });
  assert.equal(right.status, 200, "signed over exactly the bytes sent");
  assert.equal((await request("alice", r.id)).status, "NeedsInfo");
});

test("the webhook needs no session and ignores one", async () => {
  const r = await submit("alice", "no cookie");
  const res = await platform.deliver({ body: statusEvent(r.id, "Rejected", { message: "No." }) });
  assert.equal(res.status, 200);
  assert.equal((await request("alice", r.id)).status, "Rejected");
});

test("malformed JSON with a valid signature is 400 invalid_request", async () => {
  const res = await platform.deliver({ rawBody: "{not json", event: "build.status" });
  expectError({ status: res.status, body: res.body }, 400, "invalid_request");
});

test("events outside the 300 second tolerance are 400 stale_event; inside it they are accepted", async () => {
  const r = await submit("alice", "stale events");
  const at = (ms) => new Date(Date.now() + ms).toISOString();
  for (const ms of [-10 * 60 * 1000, 10 * 60 * 1000]) {
    const res = await platform.deliver({ body: statusEvent(r.id, "Success", { sentAt: at(ms) }) });
    expectError({ status: res.status, body: res.body }, 400, "stale_event");
  }
  assert.equal((await request("alice", r.id)).status, "InProgress");
  const ok = await platform.deliver({ body: statusEvent(r.id, "NeedsInfo", { message: "fresh enough", sentAt: at(-4 * 60 * 1000) }) });
  assert.equal(ok.status, 200);
});

test("a repeated eventId is acknowledged and ignored", async () => {
  const r = await submit("alice", "replays");
  const needs = statusEvent(r.id, "NeedsInfo", { message: "Which one?" });
  assert.equal((await platform.deliver({ body: needs })).status, 200);
  assert.equal((await platform.deliver({ body: statusEvent(r.id, "Success") })).status, 200);
  assert.equal((await request("alice", r.id)).status, "Success");
  const replay = await platform.deliver({ body: { ...needs, sentAt: new Date().toISOString() } });
  assert.equal(replay.status, 200, "a duplicate is a success, so the platform stops retrying");
  assert.equal((await request("alice", r.id)).status, "Success", "...and does not move the request backwards");
});

test("a repeated build.version does not duplicate the version", async () => {
  const r = await submit("alice", "version replay");
  const ev = versionEvent(r.id, r.id, "1.0.0");
  assert.equal((await platform.deliver({ body: ev })).status, 200);
  assert.equal((await platform.deliver({ body: { ...ev, sentAt: new Date().toISOString() } })).status, 200);
  const versions = expectOk(await as("alice").get(`api/features/${r.id}/versions`)).versions;
  assert.equal(versions.length, 1);
});

test("unknown event types and the legacy activation.changed are acknowledged with 200", async () => {
  const unknown = await platform.deliver({ body: { type: "something.new", eventId: uid("evt-"), sentAt: new Date().toISOString() }, event: "something.new" });
  assert.equal(unknown.status, 200);
  const legacy = await platform.deliver({
    body: { event: "activation.changed", reason: "activated", hostId: profile.hostId(), tenantId: profile.tenantId(), packageId: "p/x", slotId: "main", version: "1.0.0", enabled: true, pinned: false, activatedAt: new Date().toISOString() },
    event: "activation.changed",
  });
  assert.equal(legacy.status, 200);
});

test("build.status moves a request through NeedsInfo, Rejected and Success with the message where documented", async () => {
  const r = await submit("alice", "status walk");
  await buildCallFor(r.id);
  await platform.status({ requestRef: r.id, status: "NeedsInfo", message: "Which date range?" });
  let now = await request("alice", r.id);
  assert.deepEqual([now.status, now.message], ["NeedsInfo", "Which date range?"]);
  await platform.status({ requestRef: r.id, status: "InProgress" });
  now = await request("alice", r.id);
  assert.equal(now.status, "InProgress");
  assert.ok(!now.message, "the question is cleared once the build resumes");
  await platform.status({ requestRef: r.id, status: "Rejected", message: "Out of scope." });
  now = await request("alice", r.id);
  assert.deepEqual([now.status, now.message], ["Rejected", "Out of scope."]);
  assert.ok(Date.parse(now.updatedAt) >= Date.parse(now.createdAt));
});

test("build.version creates the feature, assigns it to the requester only, and Success follows", async () => {
  const r = await submit("alice", "a brand new feature");
  const path = uniquePath("first");
  const out = await platform.deliver({ body: versionEvent(r.id, r.id, "1.0.0", { path, kind: "new-page", mode: "iframe", slotId: "main" }) });
  assert.equal(out.status, 200);
  const f = await featureFor("alice", r.id);
  assert.ok(f, "the requester gets the feature");
  assert.deepEqual([f.kind, f.mode, f.path, f.currentVersion, f.ownerUserId, f.requestId], ["new-page", "iframe", path, "1.0.0", USERS.alice.id, r.id]);
  for (const who of ["bob", "carol", "admin"]) assert.equal(await featureFor(who, r.id), undefined);
  assert.equal((await request("alice", r.id)).featureId, r.id, "the request records the feature it built");
});

test("a later version of an existing feature becomes current without re-assigning or widening access", async () => {
  const f = await createFeature("alice", { versions: ["1.0.0"] });
  const since = await platform.mark();
  const change = await submit("alice", "change it again", { featureId: f.id });
  const call = await buildCallFor(change.id, since);
  assert.equal(call.body.feature.ref, f.id);
  const out = await platform.publish({ requestRef: change.id, featureRef: f.id, packageId: f.packageId, version: "2.0.0", path: f.path });
  assert.equal(out.versionResponse.status, 200);
  assert.equal(out.statusResponse.status, 200);
  const now = await featureFor("alice", f.id);
  assert.equal(now.currentVersion, "2.0.0");
  const versions = expectOk(await as("alice").get(`api/features/${f.id}/versions`)).versions.map((v) => v.version);
  assert.deepEqual(versions, ["2.0.0", "1.0.0"]);
  assert.equal(await featureFor("carol", f.id), undefined);
  const done = await request("alice", change.id);
  assert.equal(done.status, "Success");
  assert.equal(done.featureId, f.id);
});
