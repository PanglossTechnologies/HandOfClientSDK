// POST/GET requests, replying to NeedsInfo, and the build the module starts on the platform.
import { test } from "node:test";
import assert from "node:assert/strict";
import { as, platform } from "../lib/client.mjs";
import { profile, USERS } from "../lib/profile.mjs";
import { buildCallFor, createFeature, expectError, expectOk, setSettings, submit, uid } from "../lib/world.mjs";

const REF = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ids = (list) => list.map((r) => r.id);

test("submitting stores an InProgress request owned by the caller", async () => {
  const text = `Show overdue orders in red ${uid()}`;
  const r = await submit("alice", text);
  assert.match(r.id, REF, "request ids are sent to the platform as requestRef, so they must match its pattern");
  assert.ok(r.id.length <= 128);
  assert.equal(r.text, text);
  assert.equal(r.status, "InProgress");
  assert.equal(r.userId, USERS.alice.id);
  assert.ok(!Number.isNaN(Date.parse(r.createdAt)) && !Number.isNaN(Date.parse(r.updatedAt)));
  assert.ok(!r.message);
  assert.ok(!r.featureId, "no feature until the first version is published");
});

test("a build is started on the platform with the request, the user, the snapshot and the mode", async () => {
  const since = await platform.mark();
  const snapshot = { url: "https://site.example/orders", path: "/orders", title: "Orders", html: "<main>xxxx</main>", css: "main{}", redacted: true };
  const r = await submit("alice", "Add a Total column", { snapshot });
  const call = await buildCallFor(r.id, since);
  assert.equal(call.status, 200, "the platform accepted the build (the fake validates the documented limits and patterns)");
  assert.equal(call.apiKey, profile.apiKey(), "server-side calls carry the host API key");
  assert.equal(call.body.tenantId, profile.tenantId());
  assert.equal(call.body.requestRef, r.id);
  assert.equal(call.body.user.id, USERS.alice.id);
  assert.equal(call.body.text, "Add a Total column");
  assert.deepEqual(call.body.snapshot, snapshot, "the snapshot is forwarded unchanged");
  assert.ok(["inject", "iframe"].includes(String(call.body.mode).toLowerCase()));
  assert.ok(!call.body.feature, "a new request does not name a feature");
});

test("the build mode follows the renderingMode setting", async (t) => {
  t.after(() => setSettings());
  for (const mode of ["iframe", "inject"]) {
    await setSettings({ renderingMode: mode });
    const since = await platform.mark();
    const r = await submit("alice", `mode ${mode}`);
    assert.equal(String((await buildCallFor(r.id, since)).body.mode).toLowerCase(), mode);
  }
});

test("a platform outage does not fail the submit; the request is stored InProgress", async (t) => {
  t.after(() => platform.clearFailures());
  await platform.failNext("POST /host/v1/builds", 503, 1);
  const r = await submit("alice", "Platform is down right now");
  assert.equal(r.status, "InProgress");
  const mine = expectOk(await as("alice").get("api/requests", { limit: "5" })).requests;
  assert.ok(ids(mine).includes(r.id), "the request is stored even though the build could not be started");
});

test("invalid input is 400 invalid_request", async () => {
  const bob = as("bob");
  for (const body of [{}, { text: "" }, { text: "   " }, { text: 5 }, { text: "ok", snapshot: "not an object" }, { text: "ok", snapshot: [1] }, { text: "ok", featureId: 5 }]) {
    expectError(await bob.post("api/requests", body), 400, "invalid_request");
  }
  expectError(await bob.postRaw("api/requests", "{not json"), 400, "invalid_request");
});

test("oversized text or snapshot is 413 payload_too_large", async () => {
  const bob = as("bob");
  assert.equal((await bob.post("api/requests", { text: "x".repeat(20000) })).status, 201, "exactly 20000 characters is allowed");
  expectError(await bob.post("api/requests", { text: "x".repeat(20001) }), 413, "payload_too_large");
  const snapshot = { url: "https://site.example/", path: "/", html: "x".repeat(2 * 1024 * 1024 + 1024) };
  expectError(await bob.post("api/requests", { text: "big page", snapshot }), 413, "payload_too_large");
});

test("a request can target a feature the caller sees, and then the build names it", async () => {
  const f = await createFeature("alice");
  const since = await platform.mark();
  const r = await submit("alice", "Change it again", { featureId: f.id });
  const call = await buildCallFor(r.id, since);
  assert.equal(call.body.feature?.ref, f.id, "the build is a new version of that feature");
});

test("a request cannot target a feature the caller cannot see or that does not exist", async () => {
  const f = await createFeature("alice");
  expectError(await as("carol").post("api/requests", { text: "sneaky", featureId: f.id }), 404, "not_found");
  expectError(await as("carol").post("api/requests", { text: "sneaky", featureId: "no-such-feature" }), 404, "not_found");
});

test("scope=mine lists only my requests, newest first", async () => {
  const a = await submit("dave", "first");
  const b = await submit("dave", "second");
  const c = await submit("dave", "third");
  const other = await submit("carol", "not dave's");
  const list = expectOk(await as("dave").get("api/requests")).requests;
  const mine = ids(list);
  assert.deepEqual(mine.slice(0, 3), [c.id, b.id, a.id]);
  assert.ok(!mine.includes(other.id));
  assert.ok(list.every((r) => r.userId === USERS.dave.id));
});

test("limit and cursor page through requests", async () => {
  const [a, b, c] = [await submit("erin", "one"), await submit("erin", "two"), await submit("erin", "three")];
  const page1 = expectOk(await as("erin").get("api/requests", { limit: "2" }));
  assert.deepEqual(ids(page1.requests), [c.id, b.id]);
  assert.equal(typeof page1.nextCursor, "string");
  const page2 = expectOk(await as("erin").get("api/requests", { limit: "2", cursor: page1.nextCursor }));
  assert.equal(page2.requests[0].id, a.id);
  const all = expectOk(await as("erin").get("api/requests", { limit: "200" }));
  assert.ok(all.requests.length <= 200);
  if (all.requests.length < 200) assert.equal(all.nextCursor, null, "nextCursor is null when there is nothing more");
});

test("bad query parameters are 400", async () => {
  const a = as("alice");
  for (const q of [{ scope: "everything" }, { limit: "0" }, { limit: "201" }, { limit: "abc" }, { status: "Done" }]) {
    expectError(await a.get("api/requests", q), 400, "invalid_request");
  }
});

test("status filters narrow the list (the parameter repeats)", async () => {
  const waiting = await submit("alice", "needs an answer");
  const rejected = await submit("alice", "will be rejected");
  const plain = await submit("alice", "still building");
  await buildCallFor(waiting.id);
  await buildCallFor(rejected.id);
  await platform.status({ requestRef: waiting.id, status: "NeedsInfo", message: "Which date range?" });
  await platform.status({ requestRef: rejected.id, status: "Rejected", message: "Out of scope." });
  const needs = expectOk(await as("alice").get("api/requests", { status: "NeedsInfo", limit: "200" })).requests;
  assert.ok(ids(needs).includes(waiting.id) && !ids(needs).includes(plain.id) && !ids(needs).includes(rejected.id));
  assert.ok(needs.every((r) => r.status === "NeedsInfo"));
  const both = ids(expectOk(await as("alice").get("api/requests", { status: ["NeedsInfo", "Rejected"], limit: "200" })).requests);
  assert.ok(both.includes(waiting.id) && both.includes(rejected.id) && !both.includes(plain.id));
});

test("scope=all follows the viewAllRequests setting", async (t) => {
  t.after(() => setSettings());
  const r = await submit("alice", "visible to admins");
  await setSettings({ viewAllRequests: "admins" });
  expectError(await as("carol").get("api/requests", { scope: "all" }), 403, "forbidden");
  const asAdmin = expectOk(await as("admin").get("api/requests", { scope: "all", limit: "200" })).requests;
  assert.ok(ids(asAdmin).includes(r.id), "admins see everyone's requests");
  await setSettings({ viewAllRequests: "everyone" });
  const asCarol = expectOk(await as("carol").get("api/requests", { scope: "all", limit: "200" })).requests;
  assert.ok(ids(asCarol).includes(r.id), "with 'everyone', any signed-in user does");
  const mineOnly = expectOk(await as("carol").get("api/requests", { limit: "200" })).requests;
  assert.ok(!ids(mineOnly).includes(r.id), "the default scope stays 'mine'");
});

test("a NeedsInfo question can be answered by the requester and is forwarded to the platform", async () => {
  const r = await submit("alice", "Add a chart");
  await buildCallFor(r.id);
  await platform.status({ requestRef: r.id, status: "NeedsInfo", message: "Which date range?" });
  const waiting = expectOk(await as("alice").get("api/requests", { status: "NeedsInfo", limit: "200" })).requests.find((x) => x.id === r.id);
  assert.equal(waiting.message, "Which date range?");

  expectError(await as("alice").post(`api/requests/${r.id}/reply`, { text: "" }), 400, "invalid_request");
  expectError(await as("alice").post(`api/requests/${r.id}/reply`, {}), 400, "invalid_request");
  const intruder = await as("bob").post(`api/requests/${r.id}/reply`, { text: "Last week" });
  assert.ok([403, 404].includes(intruder.status), `only the requester may reply (got ${intruder.status})`);

  const since = await platform.mark();
  const done = expectOk(await as("alice").post(`api/requests/${r.id}/reply`, { text: "Last 30 days" }));
  assert.equal(done.id, r.id);
  assert.equal(done.status, "InProgress");
  const build = (await platform.builds()).find((b) => b.requestRef === r.id);
  const call = await platform.waitForCall((c) => c.method === "POST" && c.path === `/host/v1/builds/${build.buildId}/reply`, { since });
  assert.ok(call, "the answer reaches the platform");
  assert.equal(call.body.text, "Last 30 days");
  assert.equal(call.apiKey, profile.apiKey());
  assert.equal(call.status, 200);

  expectError(await as("alice").post(`api/requests/${r.id}/reply`, { text: "again" }), 409, "not_awaiting_reply");
});

test("replying to an unknown request is 404 and to a request that is not waiting is 409", async () => {
  expectError(await as("alice").post("api/requests/no-such-request/reply", { text: "hi" }), 404, "not_found");
  const r = await submit("alice", "still working");
  expectError(await as("alice").post(`api/requests/${r.id}/reply`, { text: "hi" }), 409, "not_awaiting_reply");
});

test("a failing platform reply is 502 platform_unavailable", async (t) => {
  t.after(() => platform.clearFailures());
  const r = await submit("alice", "reply will fail");
  await buildCallFor(r.id);
  await platform.status({ requestRef: r.id, status: "NeedsInfo", message: "Which one?" });
  await platform.failNext("POST /host/v1/builds/.+/reply", 500, 1);
  expectError(await as("alice").post(`api/requests/${r.id}/reply`, { text: "that one" }), 502, "platform_unavailable");
});
