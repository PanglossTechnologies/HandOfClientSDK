// GET resolve: what applies to me on this path. Used by embed.js on every page view.
import { test } from "node:test";
import assert from "node:assert/strict";
import { as } from "../lib/client.mjs";
import { USERS } from "../lib/profile.mjs";
import { createFeature, expectError, expectOk, resolveFor, setSettings, shareWith, uniquePath } from "../lib/world.mjs";

const featureIds = (list) => list.map((x) => x.featureId);

test("an empty answer means 'show the original page'", async () => {
  const body = expectOk(await as("alice").get("api/resolve", { path: uniquePath("nothing") }));
  assert.deepEqual(body.features, []);
  assert.ok(body.path.startsWith("/conf/"));
});

test("path is required and must start with /", async () => {
  for (const q of [{}, { path: "" }, { path: "orders" }]) expectError(await as("alice").get("api/resolve", q), 400, "invalid_request");
});

test("a resolved feature carries everything embed.js needs, for the exact path only", async () => {
  const path = uniquePath("orders");
  const f = await createFeature("alice", { path, kind: "page-override", mode: "inject", versions: ["1.0.0", "1.2.0"] });
  const [r] = await resolveFor("alice", path);
  assert.equal(r.featureId, f.id);
  assert.equal(r.kind, "page-override");
  assert.equal(r.mode, "inject");
  assert.equal(r.slotId, "main");
  assert.equal(r.path, path);
  assert.equal(r.packageId, f.packageId);
  assert.equal(r.version, "1.2.0");
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
  assert.equal(r.entry, "index.js");
  assert.deepEqual(await resolveFor("alice", `${path}/1`), [], "paths match exactly");
  assert.deepEqual(await resolveFor("alice", `${path}x`), []);
});

test("features the caller cannot see are not resolved", async () => {
  const path = uniquePath("private");
  await createFeature("alice", { path });
  assert.deepEqual(await resolveFor("carol", path), []);
  assert.deepEqual(await resolveFor("admin", path), []);
});

test("new-page and slot features resolve at their own path too", async () => {
  const path = uniquePath("page");
  const page = await createFeature("alice", { path, kind: "new-page" });
  const slot = await createFeature("alice", { path, kind: "slot", slotId: "sidebar" });
  const got = await resolveFor("alice", path);
  assert.deepEqual(new Set(featureIds(got)), new Set([page.id, slot.id]));
  assert.equal(got.find((x) => x.featureId === slot.id).slotId, "sidebar");
  assert.equal(got.find((x) => x.featureId === page.id).kind, "new-page");
});

test("the caller's pin decides the version and sha256 returned, for them only", async () => {
  const path = uniquePath("pinned");
  const f = await createFeature("alice", { path, versions: ["1.0.0", "2.0.0"] });
  await shareWith(f, "bob");
  const before = (await resolveFor("bob", path))[0];
  assert.equal(before.version, "2.0.0");
  expectOk(await as("bob").post(`api/features/${f.id}/pin`, { version: "1.0.0" }));
  const pinned = (await resolveFor("bob", path))[0];
  assert.equal(pinned.version, "1.0.0");
  assert.notEqual(pinned.sha256, before.sha256, "the pinned version's own hash is returned");
  assert.equal((await resolveFor("alice", path))[0].version, "2.0.0");
});

test("an assignment to the specific user beats an assignment to everyone", async (t) => {
  t.after(() => setSettings());
  await setSettings({ shareWithEveryone: "owner" });
  const path = uniquePath("precedence");
  const forBob = await createFeature("bob", { path });
  const forEveryone = await createFeature("alice", { path });
  expectOk(await as("alice").post(`api/features/${forEveryone.id}/share`, { everyone: true }));
  assert.deepEqual(featureIds(await resolveFor("bob", path)), [forBob.id], "bob's own feature wins even though the shared one was assigned later");
  assert.deepEqual(featureIds(await resolveFor("carol", path)), [forEveryone.id], "everyone else gets the shared one");
  assert.deepEqual(featureIds(await resolveFor("alice", path)), [forEveryone.id]);
});

test("the user-specific assignment wins whichever of the two was assigned first", async (t) => {
  t.after(() => setSettings());
  await setSettings({ shareWithEveryone: "owner" });
  const path = uniquePath("precedence2");
  const shared = await createFeature("alice", { path });
  expectOk(await as("alice").post(`api/features/${shared.id}/share`, { everyone: true }));
  const named = await createFeature("dave", { path });
  assert.deepEqual(featureIds(await resolveFor("dave", path)), [named.id]);
  assert.deepEqual(featureIds(await resolveFor("erin", path)), [shared.id]);
});

test("two page overrides assigned the same way: the most recently assigned wins, one per path", async () => {
  const path = uniquePath("collision");
  const older = await createFeature("bob", { path });
  const newer = await createFeature("bob", { path });
  const got = await resolveFor("bob", path);
  assert.deepEqual(featureIds(got), [newer.id]);
  assert.notEqual(newer.id, older.id);
});

test("when two everyone features collide, the most recently assigned wins", async (t) => {
  t.after(() => setSettings());
  await setSettings({ shareWithEveryone: "owner" });
  const path = uniquePath("everyone-collision");
  const first = await createFeature("alice", { path });
  const second = await createFeature("alice", { path });
  expectOk(await as("alice").post(`api/features/${first.id}/share`, { everyone: true }));
  expectOk(await as("alice").post(`api/features/${second.id}/share`, { everyone: true }));
  assert.deepEqual(featureIds(await resolveFor("carol", path)), [second.id]);
});

test("turning off the user's own feature lets the everyone feature apply", async (t) => {
  t.after(() => setSettings());
  await setSettings({ shareWithEveryone: "owner" });
  const path = uniquePath("fallback");
  const shared = await createFeature("alice", { path });
  expectOk(await as("alice").post(`api/features/${shared.id}/share`, { everyone: true }));
  const mine = await createFeature("carol", { path });
  assert.deepEqual(featureIds(await resolveFor("carol", path)), [mine.id]);
  expectOk(await as("carol").post(`api/features/${mine.id}/enabled`, { enabled: false }));
  assert.deepEqual(featureIds(await resolveFor("carol", path)), [shared.id], "a feature turned off is skipped, not blocking");
});

test("resolve answers for the signed-in user only", async () => {
  const path = uniquePath("who");
  const f = await createFeature("alice", { path });
  const res = await as("alice").get("api/resolve", { path, userId: USERS.carol.id });
  assert.deepEqual(featureIds(expectOk(res).features), [f.id]);
  assert.deepEqual(featureIds(expectOk(await as("carol").get("api/resolve", { path, userId: USERS.alice.id })).features), []);
});
