// GET token: the site mints embed tokens only for features the signed-in user can see, always for that user,
// always for the version they should get, and re-checks on every call (tokens are refreshed every 8 minutes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { as, platform } from "../lib/client.mjs";
import { profile, USERS } from "../lib/profile.mjs";
import { createFeature, expectError, expectOk, setSettings, shareWith, sleep, uid } from "../lib/world.mjs";

const isEmbedCall = (packageId) => (c) => c.method === "POST" && c.path === "/host/v1/embed-token" && c.body?.packageId === packageId;
const token = (user, featureId, query = {}) => as(user).get("token", { featureId, ...query });
const claims = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));

/** Calls the module made to POST /embed-token for this package since `since`, after giving it a moment. */
async function embedCalls(packageId, since) {
  await sleep(150);
  return (await platform.calls(since)).filter(isEmbedCall(packageId));
}

test("a visible feature gets a token minted by the platform for the session user and the current version", async () => {
  const f = await createFeature("alice", { versions: ["1.0.0", "2.0.0"] });
  const since = await platform.mark();
  const body = expectOk(await token("alice", f.id));
  assert.equal(typeof body.token, "string");
  assert.equal(body.token.split(".").length, 3, "the platform's JWT is passed through");
  assert.ok(!Number.isNaN(Date.parse(body.expiresAt)));
  assert.equal(body.userId, USERS.alice.id);
  const [call] = await embedCalls(f.packageId, since);
  assert.ok(call, "the module asked the platform for the token");
  assert.equal(call.apiKey, profile.apiKey(), "the host API key is added server-side");
  assert.equal(call.status, 200);
  assert.deepEqual(call.body, { tenantId: profile.tenantId(), userId: USERS.alice.id, packageId: f.packageId, version: "2.0.0", slotId: "main" });
  const c = claims(body.token);
  assert.equal(c.sub, USERS.alice.id);
  assert.equal(c.pkg, f.packageId);
  assert.equal(c.ver, "2.0.0");
});

test("the token's user is the session user, never a value from the request", async () => {
  const f = await createFeature("alice");
  const since = await platform.mark();
  const res = await as("alice", { "x-user-id": USERS.bob.id, "x-forwarded-user": USERS.bob.id }).get("token", { featureId: f.id, userId: USERS.bob.id, user: USERS.bob.id, sub: USERS.bob.id });
  const body = expectOk(res);
  assert.equal(body.userId, USERS.alice.id);
  const calls = await embedCalls(f.packageId, since);
  assert.ok(calls.length >= 1 && calls.every((c) => c.body.userId === USERS.alice.id), "the platform is only ever asked for alice");
  assert.equal(claims(body.token).sub, USERS.alice.id);
});

test("a user can never get a token for a feature they cannot see", async () => {
  const f = await createFeature("alice");
  const since = await platform.mark();
  for (const who of ["bob", "carol", "dave", "erin", "admin"]) {
    expectError(await token(who, f.id), 404, "not_found");
  }
  assert.deepEqual(await embedCalls(f.packageId, since), [], "the platform was never asked to mint anything");
});

test("an invisible feature looks exactly like one that does not exist", async () => {
  const f = await createFeature("alice");
  const hidden = await token("carol", f.id);
  const missing = await token("carol", `no-such-${uid()}`);
  expectError(hidden, 404, "not_found");
  expectError(missing, 404, "not_found");
  assert.deepEqual(hidden.body, missing.body, "no way to probe which ids exist");
});

test("visibility is re-checked on every call: unsharing stops the next refresh", async () => {
  const f = await createFeature("alice");
  await shareWith(f, "bob");
  expectOk(await token("bob", f.id));
  expectOk(await as("alice").del(`api/features/${f.id}/share/${encodeURIComponent(USERS.bob.id)}`));
  const since = await platform.mark();
  expectError(await token("bob", f.id), 404, "not_found");
  assert.deepEqual(await embedCalls(f.packageId, since), []);
});

test("a feature shared with everyone is tokenable by anyone until the share is removed", async (t) => {
  t.after(() => setSettings());
  await setSettings({ shareWithEveryone: "owner" });
  const f = await createFeature("alice");
  expectError(await token("carol", f.id), 404, "not_found");
  expectOk(await as("alice").post(`api/features/${f.id}/share`, { everyone: true }));
  expectOk(await token("carol", f.id));
  expectOk(await as("alice").del(`api/features/${f.id}/share/everyone`));
  expectError(await token("carol", f.id), 404, "not_found");
});

test("a feature the user turned off gets no token", async () => {
  const f = await createFeature("alice");
  expectOk(await as("alice").post(`api/features/${f.id}/enabled`, { enabled: false }));
  const since = await platform.mark();
  const res = await token("alice", f.id);
  assert.ok([403, 404].includes(res.status), `expected 403/404, got ${res.status}`);
  assert.deepEqual(await embedCalls(f.packageId, since), []);
  expectOk(await as("alice").post(`api/features/${f.id}/enabled`, { enabled: true }));
  expectOk(await token("alice", f.id));
});

test("the version follows the user's pin, then the current version, per user", async () => {
  const f = await createFeature("alice", { versions: ["1.0.0", "2.0.0"] });
  await shareWith(f, "bob");
  const versionFor = async (who) => {
    const since = await platform.mark();
    expectOk(await token(who, f.id));
    const calls = await embedCalls(f.packageId, since);
    assert.equal(calls.length, 1);
    return calls[0].body.version;
  };
  assert.equal(await versionFor("bob"), "2.0.0");
  expectOk(await as("bob").post(`api/features/${f.id}/pin`, { version: "1.0.0" }));
  assert.equal(await versionFor("bob"), "1.0.0", "the pin is honoured");
  assert.equal(await versionFor("alice"), "2.0.0", "other users are unaffected");
  expectOk(await as("alice").post(`api/features/${f.id}/current`, { version: "1.0.0" }));
  expectOk(await as("bob").post(`api/features/${f.id}/pin`, { version: "2.0.0" }));
  assert.equal(await versionFor("alice"), "1.0.0", "rolling back changes everyone who has not pinned");
  assert.equal(await versionFor("bob"), "2.0.0", "...but not bob, who pinned");
  expectOk(await as("bob").post(`api/features/${f.id}/pin`, { version: null }));
  assert.equal(await versionFor("bob"), "1.0.0", "unpinning follows the current version again");
});

test("a version withdrawn on the platform is 409 version_unavailable", async () => {
  const f = await createFeature("alice", { versions: ["1.0.0"] });
  await platform.withdraw(f.packageId, "1.0.0");
  expectError(await token("alice", f.id), 409, "version_unavailable");
});

test("platform failures are 502 platform_unavailable", async (t) => {
  t.after(() => platform.clearFailures());
  const f = await createFeature("alice");
  await platform.failNext("POST /host/v1/embed-token", 500, 1);
  expectError(await token("alice", f.id), 502, "platform_unavailable");
  await platform.failNext("POST /host/v1/embed-token", 500, 1, true);
  expectError(await token("alice", f.id), 502, "platform_unavailable");
  expectOk(await token("alice", f.id));
});
