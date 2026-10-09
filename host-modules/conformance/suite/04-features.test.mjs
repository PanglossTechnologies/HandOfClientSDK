// GET features, versions, pin, current, share, unshare, enabled, users.
import { test } from "node:test";
import assert from "node:assert/strict";
import { as } from "../lib/client.mjs";
import { USERS } from "../lib/profile.mjs";
import { createFeature, expectError, expectOk, featureFor, resolveFor, setSettings, shareWith, uid } from "../lib/world.mjs";

const url = (f, tail = "") => `api/features/${encodeURIComponent(f.id)}${tail}`;

test("the owner sees a new feature with every documented field; nobody else does", async () => {
  const f = await createFeature("alice", { kind: "page-override", mode: "inject", versions: ["1.0.0"] });
  const mine = await featureFor("alice", f.id);
  assert.ok(mine, "the requester is assigned the feature when its first version is published");
  assert.equal(mine.kind, "page-override");
  assert.equal(mine.path, f.path);
  assert.equal(mine.slotId, "main");
  assert.equal(mine.mode, "inject");
  assert.equal(mine.packageId, f.packageId);
  assert.equal(mine.currentVersion, "1.0.0");
  assert.equal(mine.pinnedVersion ?? null, null);
  assert.equal(mine.enabled, true);
  assert.equal(mine.ownerUserId, USERS.alice.id);
  assert.equal(mine.requestId, f.requestId);
  assert.ok(typeof mine.title === "string" && mine.title.length > 0);
  for (const who of ["bob", "carol", "admin"]) assert.equal(await featureFor(who, f.id), undefined, `${who} must not see it`);
});

test("the request that built a feature points at it", async () => {
  const f = await createFeature("alice");
  const mine = expectOk(await as("alice").get("api/requests", { limit: "10" })).requests.find((r) => r.id === f.requestId);
  assert.equal(mine.status, "Success");
  assert.equal(mine.featureId, f.id);
});

test("sharing details are visible to the owner and to admins, not to other viewers", async () => {
  const f = await createFeature("alice");
  await shareWith(f, "bob", "admin");
  const asOwner = await featureFor("alice", f.id);
  assert.equal(asOwner.sharing.everyone, false);
  assert.ok(asOwner.sharing.userIds.includes(USERS.bob.id));
  assert.ok((await featureFor("admin", f.id)).sharing, "admins see sharing");
  assert.equal((await featureFor("bob", f.id)).sharing, undefined, "a plain viewer does not");
});

test("versions are listed newest first for anyone who can see the feature", async () => {
  const f = await createFeature("alice", { versions: ["1.0.0", "1.1.0", "2.0.0"] });
  const body = expectOk(await as("alice").get(url(f, "/versions")));
  assert.equal(body.featureId, f.id);
  assert.equal(body.currentVersion, "2.0.0");
  assert.equal(body.pinnedVersion ?? null, null);
  assert.deepEqual(body.versions.map((v) => v.version), ["2.0.0", "1.1.0", "1.0.0"]);
  for (const v of body.versions) {
    assert.match(v.sha256, /^[0-9a-f]{64}$/);
    assert.ok(!Number.isNaN(Date.parse(v.publishedAt)));
    assert.equal(v.requestId, f.requestId);
  }
  expectError(await as("carol").get(url(f, "/versions")), 404, "not_found");
  expectError(await as("alice").get(`api/features/no-such-${uid()}/versions`), 404, "not_found");
  await shareWith(f, "bob");
  expectOk(await as("bob").get(url(f, "/versions")));
});

test("pin keeps an older version for the caller only, and null follows the current version again", async () => {
  const f = await createFeature("alice", { versions: ["1.0.0", "2.0.0"] });
  await shareWith(f, "bob");
  const pinned = expectOk(await as("bob").post(url(f, "/pin"), { version: "1.0.0" }));
  assert.equal(pinned.pinnedVersion, "1.0.0");
  assert.equal(pinned.currentVersion, "2.0.0", "the current version is untouched");
  assert.equal((await featureFor("alice", f.id)).pinnedVersion ?? null, null);
  assert.equal(expectOk(await as("bob").get(url(f, "/versions"))).pinnedVersion, "1.0.0");
  assert.equal(expectOk(await as("alice").get(url(f, "/versions"))).pinnedVersion ?? null, null);
  const unpinned = expectOk(await as("bob").post(url(f, "/pin"), { version: null }));
  assert.equal(unpinned.pinnedVersion ?? null, null);
});

test("pin validation: unknown version, bad body, invisible feature", async () => {
  const f = await createFeature("alice", { versions: ["1.0.0"] });
  expectError(await as("alice").post(url(f, "/pin"), { version: "9.9.9" }), 404, "version_not_found");
  expectError(await as("alice").post(url(f, "/pin"), {}), 400, "invalid_request");
  expectError(await as("alice").post(url(f, "/pin"), { version: 1 }), 400, "invalid_request");
  expectError(await as("carol").post(url(f, "/pin"), { version: "1.0.0" }), 404, "not_found");
});

test("current: owner or admin may roll back; a plain viewer may not; pinned users keep their pin", async () => {
  const f = await createFeature("alice", { versions: ["1.0.0", "2.0.0"] });
  await shareWith(f, "bob", "dave", "admin");
  expectOk(await as("dave").post(url(f, "/pin"), { version: "2.0.0" }));
  expectError(await as("bob").post(url(f, "/current"), { version: "1.0.0" }), 403, "forbidden");
  assert.equal((await featureFor("alice", f.id)).currentVersion, "2.0.0", "the refused call changed nothing");
  assert.equal(expectOk(await as("alice").post(url(f, "/current"), { version: "1.0.0" })).currentVersion, "1.0.0");
  assert.equal((await featureFor("bob", f.id)).currentVersion, "1.0.0", "everyone follows the new current version");
  assert.equal((await featureFor("dave", f.id)).pinnedVersion, "2.0.0", "...except those who pinned");
  assert.equal(expectOk(await as("admin").post(url(f, "/current"), { version: "2.0.0" })).currentVersion, "2.0.0", "an admin may roll forward");
});

test("current validation: unknown version, bad body, invisible feature", async () => {
  const f = await createFeature("alice", { versions: ["1.0.0"] });
  expectError(await as("alice").post(url(f, "/current"), { version: "9.9.9" }), 404, "version_not_found");
  expectError(await as("alice").post(url(f, "/current"), {}), 400, "invalid_request");
  expectError(await as("alice").post(url(f, "/current"), { version: "" }), 400, "invalid_request");
  expectError(await as("carol").post(url(f, "/current"), { version: "1.0.0" }), 404, "not_found");
});

test("share with named users: viewers appear, repeats are harmless, bad ids fail the whole call", async () => {
  const f = await createFeature("alice");
  const shared = expectOk(await as("alice").post(url(f, "/share"), { userIds: [USERS.bob.id] }));
  assert.ok(shared.sharing.userIds.includes(USERS.bob.id));
  assert.ok(await featureFor("bob", f.id));
  expectOk(await as("alice").post(url(f, "/share"), { userIds: [USERS.bob.id] }));
  expectError(await as("alice").post(url(f, "/share"), { userIds: [USERS.carol.id, `no-such-user-${uid()}`] }), 400, "invalid_request");
  assert.equal(await featureFor("carol", f.id), undefined, "nothing was shared by the failed call");
});

test("share body must be exactly userIds or everyone:true", async () => {
  const f = await createFeature("alice");
  for (const body of [{}, { userIds: [] }, { userIds: "bob" }, { everyone: false }, { userIds: [USERS.bob.id], everyone: true }, { everyone: "yes" }]) {
    expectError(await as("alice").post(url(f, "/share"), body), 400, "invalid_request");
  }
});

test("sharing with named users follows the shareWithNamedUsers setting", async (t) => {
  t.after(() => setSettings());
  const f = await createFeature("alice");
  await shareWith(f, "bob");
  await setSettings({ shareWithNamedUsers: "nobody" });
  expectError(await as("alice").post(url(f, "/share"), { userIds: [USERS.carol.id] }), 403, "sharing_not_allowed");
  await setSettings({ shareWithNamedUsers: "admins" });
  expectError(await as("alice").post(url(f, "/share"), { userIds: [USERS.carol.id] }), 403, "sharing_not_allowed");
  const adminsFeature = await createFeature("admin");
  expectOk(await as("admin").post(url(adminsFeature, "/share"), { userIds: [USERS.carol.id] }));
  await setSettings({ shareWithNamedUsers: "owner" });
  expectError(await as("bob").post(url(f, "/share"), { userIds: [USERS.carol.id] }), 403, "sharing_not_allowed");
  expectOk(await as("alice").post(url(f, "/share"), { userIds: [USERS.carol.id] }));
  assert.equal(await featureFor("carol", f.id) !== undefined, true);
});

test("sharing with everyone follows the shareWithEveryone setting (default: admins)", async (t) => {
  t.after(() => setSettings());
  const f = await createFeature("alice");
  await setSettings({ shareWithEveryone: "admins" });
  expectError(await as("alice").post(url(f, "/share"), { everyone: true }), 403, "sharing_not_allowed");
  const adminsFeature = await createFeature("admin");
  const out = expectOk(await as("admin").post(url(adminsFeature, "/share"), { everyone: true }));
  assert.equal(out.sharing.everyone, true);
  assert.ok(await featureFor("carol", adminsFeature.id), "everyone now sees it");
  await setSettings({ shareWithEveryone: "nobody" });
  expectError(await as("alice").post(url(f, "/share"), { everyone: true }), 403, "sharing_not_allowed");
  await setSettings({ shareWithEveryone: "owner" });
  expectOk(await as("alice").post(url(f, "/share"), { everyone: true }));
  assert.ok(await featureFor("dave", f.id));
});

test("sharing a feature the caller cannot see is 404", async () => {
  const f = await createFeature("alice");
  expectError(await as("carol").post(url(f, "/share"), { userIds: [USERS.bob.id] }), 404, "not_found");
});

test("unshare removes viewers and clears their pin", async () => {
  const f = await createFeature("alice", { versions: ["1.0.0", "2.0.0"] });
  await shareWith(f, "bob");
  expectOk(await as("bob").post(url(f, "/pin"), { version: "1.0.0" }));
  const out = expectOk(await as("alice").del(url(f, `/share/${encodeURIComponent(USERS.bob.id)}`)));
  assert.ok(!out.sharing.userIds.includes(USERS.bob.id));
  expectError(await as("bob").get(url(f, "/versions")), 404, "not_found");
  await shareWith(f, "bob");
  assert.equal((await featureFor("bob", f.id)).pinnedVersion ?? null, null, "removing a user also cleared their pin");
});

test("unshare with a percent-encoded user id, and with the reserved target 'everyone'", async (t) => {
  t.after(() => setSettings());
  await setSettings({ shareWithEveryone: "owner" });
  const f = await createFeature("alice");
  await shareWith(f, "erin");
  assert.ok(await featureFor("erin", f.id));
  expectOk(await as("alice").del(url(f, `/share/${encodeURIComponent(USERS.erin.id)}`)));
  assert.equal(await featureFor("erin", f.id), undefined, "ids with + and @ survive the round trip");
  expectOk(await as("alice").post(url(f, "/share"), { everyone: true }));
  assert.ok(await featureFor("carol", f.id));
  expectOk(await as("alice").del(url(f, "/share/everyone")));
  assert.equal(await featureFor("carol", f.id), undefined);
  assert.ok(await featureFor("alice", f.id), "the owner keeps it");
});

test("unshare is owner-or-admin only and 404 for invisible features", async () => {
  const f = await createFeature("alice");
  await shareWith(f, "bob", "carol");
  expectError(await as("bob").del(url(f, `/share/${encodeURIComponent(USERS.carol.id)}`)), 403, "forbidden");
  assert.ok(await featureFor("carol", f.id), "the refused call changed nothing");
  expectError(await as("dave").del(url(f, `/share/${encodeURIComponent(USERS.carol.id)}`)), 404, "not_found");
});

test("enabled turns a feature off for the caller only", async () => {
  const f = await createFeature("alice", { path: `/conf/${uid("p")}/toggle` });
  await shareWith(f, "bob");
  const off = expectOk(await as("bob").post(url(f, "/enabled"), { enabled: false }));
  assert.equal(off.enabled, false);
  assert.equal((await featureFor("alice", f.id)).enabled, true);
  assert.deepEqual(await resolveFor("bob", f.path), [], "a feature that is off is not resolved");
  assert.equal((await resolveFor("alice", f.path)).length, 1);
  assert.equal(expectOk(await as("bob").post(url(f, "/enabled"), { enabled: true })).enabled, true);
  assert.equal((await resolveFor("bob", f.path)).length, 1);
});

test("enabled validation", async () => {
  const f = await createFeature("alice");
  expectError(await as("alice").post(url(f, "/enabled"), { enabled: "no" }), 400, "invalid_request");
  expectError(await as("alice").post(url(f, "/enabled"), {}), 400, "invalid_request");
  expectError(await as("carol").post(url(f, "/enabled"), { enabled: false }), 404, "not_found");
});

test("users: search for people to share with, never the caller", async () => {
  const found = expectOk(await as("alice").get("api/users", { query: "bob" })).users;
  assert.ok(found.some((u) => u.id === USERS.bob.id));
  assert.ok(found.every((u) => typeof u.id === "string"));
  const self = expectOk(await as("alice").get("api/users", { query: "alice" })).users;
  assert.ok(!self.some((u) => u.id === USERS.alice.id), "the caller is never in the results");
  const capped = expectOk(await as("alice").get("api/users", { query: "e", limit: "1" })).users;
  assert.ok(capped.length <= 1);
});

test("users: validation and the sharing policy", async (t) => {
  t.after(() => setSettings());
  for (const q of [{}, { query: "" }, { query: "x".repeat(101) }, { query: "b", limit: "0" }, { query: "b", limit: "51" }]) {
    expectError(await as("alice").get("api/users", q), 400, "invalid_request");
  }
  await setSettings({ shareWithNamedUsers: "nobody" });
  expectError(await as("alice").get("api/users", { query: "bob" }), 403, "sharing_not_allowed");
});

test("features lists only what the caller can see", async () => {
  const f = await createFeature("alice");
  const g = await createFeature("bob");
  const listed = expectOk(await as("alice").get("api/features")).features.map((x) => x.id);
  assert.ok(listed.includes(f.id) && !listed.includes(g.id));
});
