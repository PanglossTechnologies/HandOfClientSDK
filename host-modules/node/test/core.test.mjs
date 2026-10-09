import assert from "node:assert/strict";
import { test } from "node:test";
import { HostModule, SqlStorage } from "../dist/esm/index.js";
import { FakePlatform, call, down, makeHoc, publishFeatureFor, uid, webhook } from "./helpers.mjs";

const silent = { info() {}, warn() {}, error() {} };

// ------------------------------------------------------------------ identity and plumbing
test("every call without a session is 401, and an unknown route with one is 404", async () => {
  const { hoc } = makeHoc();
  for (const [m, p] of [["GET", "token"], ["GET", "api/features"], ["POST", "api/requests"], ["GET", "api/settings"], ["DELETE", "api/features/x/share/everyone"]]) {
    const res = await call(hoc, null, m, p);
    assert.equal(res.status, 401, `${m} ${p}`);
    assert.equal(res.payload.error, "unauthenticated");
  }
  assert.equal((await call(hoc, "alice", "GET", "api/nope")).status, 404);
  assert.equal((await call(hoc, "alice", "PATCH", "api/features")).status, 404);
});

test("a throwing getCurrentUser answers 500 without leaking the message; async callbacks are awaited", async () => {
  const { hoc } = makeHoc({
    logger: silent,
    getCurrentUser: async (req) => {
      if (req === "boom") throw new Error("secret detail");
      return { id: req };
    },
  });
  const res = await call(hoc, "boom", "GET", "api/features");
  assert.equal(res.status, 500);
  assert.equal(JSON.stringify(res.payload).includes("secret detail"), false);
  assert.equal((await call(hoc, "someone", "GET", "api/features")).status, 200);
});

test("a malformed JSON body is 400, a non-object body is 400", async () => {
  const { hoc } = makeHoc();
  assert.equal((await call(hoc, "alice", "POST", "api/requests", { body: "{not json" })).status, 400);
  assert.equal((await call(hoc, "alice", "POST", "api/requests", { body: "[1]" })).status, 400);
  assert.equal((await call(hoc, "alice", "POST", "api/requests")).status, 400); // no body at all
});

test("the constructor requires a webhook secret", () => {
  assert.throws(() => new HostModule({ storage: SqlStorage.sqlite(":memory:"), platform: new FakePlatform(), webhookSecret: "", getCurrentUser() {}, isAdmin() {}, findUsers() {} }), /webhookSecret/);
});

test("a failed first migration is retried on the next call instead of being cached", async () => {
  const inner = SqlStorage.sqlite(":memory:");
  let fail = true;
  const storage = {
    migrate: async () => {
      if (fail) throw new Error("db down");
      return inner.migrate();
    },
    transaction: (w, fn) => inner.transaction(w, fn),
  };
  const { hoc } = makeHoc({ storage, logger: silent });
  assert.equal((await call(hoc, "alice", "GET", "api/features")).status, 500);
  fail = false;
  assert.equal((await call(hoc, "alice", "GET", "api/features")).status, 200);
});

// ------------------------------------------------------------------ requests and builds
test("creating a request stores it, starts a build and returns the public view", async () => {
  const { hoc, platform } = makeHoc();
  const res = await call(hoc, "alice", "POST", "api/requests", { body: { text: "  Make it blue  ", snapshot: { url: "/home" } } });
  assert.equal(res.status, 201);
  assert.match(res.payload.id, /^req-[0-9a-f]{12}$/);
  assert.equal(res.payload.status, "InProgress");
  const [build] = platform.named("startBuild");
  const [ref, user, text, mode, snapshot, feature] = build.args;
  assert.equal(ref, res.payload.id);
  assert.deepEqual(user, { id: "alice", name: "Alice Owner", email: "alice@example.com" });
  assert.equal(text, "  Make it blue  ");
  assert.equal(mode, "inject");
  assert.deepEqual(snapshot, { url: "/home" });
  assert.equal(feature, null);
  assert.equal(res.payload.userEmail, undefined, "email is not part of the public request");
});

test("request validation", async () => {
  const { hoc } = makeHoc();
  const post = (body) => call(hoc, "alice", "POST", "api/requests", { body });
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ text: "   " })).status, 400);
  assert.equal((await post({ text: 5 })).status, 400);
  assert.equal((await post({ text: "x".repeat(20001) })).status, 413);
  assert.equal((await post({ text: "ok", snapshot: "nope" })).status, 400);
  assert.equal((await post({ text: "ok", snapshot: { blob: "x".repeat(2 * 1024 * 1024 + 1) } })).status, 413);
  assert.equal((await post({ text: "ok", featureId: 5 })).status, 400);
  assert.equal((await post({ text: "ok", featureId: "feat-missing" })).status, 404);
});

test("a change request for a feature nobody shared with you is 404 and starts no build", async () => {
  const { hoc, platform } = makeHoc();
  const { featureId } = await publishFeatureFor(hoc, "alice");
  platform.calls.length = 0;
  assert.equal((await call(hoc, "bob", "POST", "api/requests", { body: { text: "tweak it", featureId } })).status, 404);
  assert.equal(platform.named("startBuild").length, 0);
  const ok = await call(hoc, "alice", "POST", "api/requests", { body: { text: "tweak it", featureId } });
  assert.equal(ok.status, 201);
  assert.deepEqual(platform.named("startBuild")[0].args[5], { ref: featureId, packageId: `pkg/${featureId}` });
});

test("a platform outage keeps the request InProgress; retryUnstartedBuilds starts it exactly once", async () => {
  const platform = new FakePlatform();
  platform.answers.startBuild = down;
  const { hoc } = makeHoc({ platform, logger: silent });
  const res = await call(hoc, "alice", "POST", "api/requests", { body: { text: "later" } });
  assert.equal(res.status, 201);
  platform.answers.startBuild = undefined;
  assert.equal(await hoc.retryUnstartedBuilds(), 1);
  assert.equal(await hoc.retryUnstartedBuilds(), 0, "already started");
  assert.equal(platform.named("startBuild").length, 2);
  assert.equal(platform.named("startBuild")[1].args[0], res.payload.id);
});

test("list requests: scope, status filter, paging, bad input", async () => {
  const { hoc } = makeHoc();
  for (let i = 0; i < 3; i++) await call(hoc, "alice", "POST", "api/requests", { body: { text: `a${i}` } });
  await call(hoc, "bob", "POST", "api/requests", { body: { text: "b0" } });
  const list = (user, query) => call(hoc, user, "GET", "api/requests", { query });
  const p1 = (await list("alice", { limit: ["2"] })).payload;
  assert.deepEqual(p1.requests.map((r) => r.text), ["a2", "a1"]);
  assert.ok(p1.nextCursor);
  const p2 = (await list("alice", { limit: ["2"], cursor: [p1.nextCursor] })).payload;
  assert.deepEqual(p2.requests.map((r) => r.text), ["a0"]);
  assert.equal(p2.nextCursor, null);
  assert.equal((await list("alice", { status: ["Success"] })).payload.requests.length, 0);
  for (const bad of [{ limit: ["0"] }, { limit: ["201"] }, { limit: ["x"] }, { limit: ["-1"] }, { cursor: ["!!"] }, { cursor: ["YWJj"] }, { status: ["Bogus"] }, { scope: ["everyone"] }]) {
    assert.equal((await list("alice", bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await list("alice", { scope: ["all"] })).status, 403);
  assert.equal((await list("admin", { scope: ["all"] })).payload.requests.length, 4);
});

test("reply: only the requester, only while NeedsInfo, platform failure is 502 and changes nothing", async () => {
  const { hoc, platform } = makeHoc();
  const { id } = (await call(hoc, "alice", "POST", "api/requests", { body: { text: "need info" } })).payload;
  const reply = (user, body) => call(hoc, user, "POST", `api/requests/${id}/reply`, { body });
  assert.equal((await reply("alice", { text: "answer" })).status, 409, "still InProgress");
  await webhook(hoc, { type: "build.status", eventId: uid(), requestRef: id, status: "NeedsInfo", message: "Which page?" });
  assert.equal((await reply("bob", { text: "answer" })).status, 404, "not the requester");
  assert.equal((await reply("alice", { text: "  " })).status, 400);
  platform.answers.replyToBuild = down;
  assert.equal((await reply("alice", { text: "the home page" })).status, 502);
  const list = async () => (await call(hoc, "alice", "GET", "api/requests")).payload.requests[0];
  assert.equal((await list()).status, "NeedsInfo");
  platform.answers.replyToBuild = undefined;
  const ok = await reply("alice", { text: "the home page" });
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.status, "InProgress");
  assert.equal(ok.payload.message, null);
  assert.deepEqual(platform.named("replyToBuild")[1].args.slice(1), ["the home page"]);
});

// ------------------------------------------------------------------ webhook
test("webhook: bad signature 401, malformed 400, stale 400, unknown event ignored", async () => {
  const { hoc } = makeHoc();
  const evt = { type: "build.status", eventId: uid(), requestRef: "nope", status: "Success" };
  assert.equal((await webhook(hoc, evt, { secret: "wrong" })).status, 401);
  assert.equal((await hoc.handle({ method: "POST", path: "webhook", body: Buffer.from("{}") })).status, 401);
  assert.equal((await webhook(hoc, evt, { sentAt: new Date(Date.now() - 301_000).toISOString() })).payload.error, "stale_event");
  assert.equal((await webhook(hoc, evt, { sentAt: "garbage" })).status, 400);
  assert.equal((await webhook(hoc, { type: "activation.changed", eventId: uid() })).status, 200);
  assert.equal((await webhook(hoc, { type: "totally.new", eventId: uid() })).status, 200);
});

test("webhook: duplicate eventId is applied once", async () => {
  const { hoc } = makeHoc();
  const { id } = (await call(hoc, "alice", "POST", "api/requests", { body: { text: "x" } })).payload;
  const eventId = uid();
  await webhook(hoc, { type: "build.status", eventId, requestRef: id, status: "Rejected", message: "no" });
  await webhook(hoc, { type: "build.status", eventId: uid(), requestRef: id, status: "InProgress" });
  await webhook(hoc, { type: "build.status", eventId, requestRef: id, status: "Rejected", message: "no" }); // replay of the first
  const r = (await call(hoc, "alice", "GET", "api/requests")).payload.requests[0];
  assert.equal(r.status, "InProgress", "the replay must not re-apply Rejected");
  assert.equal(r.message, null);
});

test("webhook: a failed apply is not recorded as seen, so the platform's retry succeeds", async () => {
  const inner = SqlStorage.sqlite(":memory:");
  let failOnce = true;
  const storage = {
    migrate: () => inner.migrate(),
    transaction: (w, fn) =>
      inner.transaction(w, (tx) =>
        fn(
          new Proxy(tx, {
            get: (t, p) =>
              p === "upsertVersion" && failOnce
                ? async () => {
                    failOnce = false;
                    throw new Error("disk full");
                  }
                : t[p].bind(t),
          }),
        ),
      ),
  };
  const { hoc } = makeHoc({ storage, logger: silent });
  const { id } = (await call(hoc, "alice", "POST", "api/requests", { body: { text: "x" } })).payload;
  const ev = { type: "build.version", eventId: "evt-retry", requestRef: id, featureRef: "feat-1", version: "1.0.0", path: "/p", packageId: "pkg/x", sha256: "s", entry: "e" };
  assert.equal((await webhook(hoc, ev)).status, 500);
  assert.equal((await call(hoc, "alice", "GET", "api/features")).payload.features.length, 0, "nothing half-applied");
  assert.equal((await webhook(hoc, ev)).status, 200);
  assert.equal((await call(hoc, "alice", "GET", "api/features")).payload.features.length, 1);
});

test("webhook: build.version creates the feature for the requester; a later one moves currentVersion", async () => {
  const { hoc } = makeHoc();
  const { featureId, requestId } = await publishFeatureFor(hoc, "alice", { path: "/home" });
  const f = (await call(hoc, "alice", "GET", "api/features")).payload.features[0];
  assert.equal(f.id, featureId);
  assert.equal(f.ownerUserId, "alice");
  assert.equal(f.requestId, requestId);
  assert.equal(f.title, "Make the home page blue");
  assert.equal(f.currentVersion, "1.0.0");
  assert.deepEqual(f.sharing, { everyone: false, userIds: ["alice"] });
  await webhook(hoc, { type: "build.version", eventId: uid(), requestRef: requestId, featureRef: featureId, version: "1.1.0", sha256: "s2", entry: "e2" });
  const v = (await call(hoc, "alice", "GET", `api/features/${featureId}/versions`)).payload;
  assert.equal(v.currentVersion, "1.1.0");
  assert.deepEqual(v.versions.map((x) => x.version), ["1.1.0", "1.0.0"]);
  assert.equal((await call(hoc, "alice", "GET", "api/requests")).payload.requests[0].featureId, featureId);
});

test("webhook: build.version without featureRef/version, or for nothing known, changes nothing", async () => {
  const { hoc } = makeHoc();
  const { id } = (await call(hoc, "alice", "POST", "api/requests", { body: { text: "x" } })).payload;
  for (const ev of [{ requestRef: id, version: "1" }, { requestRef: id, featureRef: "f" }, { featureRef: "f", version: "1" }, { requestRef: "ghost", featureRef: "f", version: "1" }]) {
    assert.equal((await webhook(hoc, { type: "build.version", eventId: uid(), ...ev })).status, 200);
  }
  assert.equal((await call(hoc, "alice", "GET", "api/features")).payload.features.length, 0);
});

// ------------------------------------------------------------------ features, sharing, versions
test("visibility: a feature is invisible (404) to people it is not shared with, on every route", async () => {
  const { hoc } = makeHoc();
  const { featureId } = await publishFeatureFor(hoc, "alice");
  for (const [m, p, body] of [
    ["GET", `api/features/${featureId}/versions`], ["POST", `api/features/${featureId}/pin`, { version: null }],
    ["POST", `api/features/${featureId}/current`, { version: "1.0.0" }], ["POST", `api/features/${featureId}/share`, { everyone: true }],
    ["DELETE", `api/features/${featureId}/share/everyone`], ["POST", `api/features/${featureId}/enabled`, { enabled: false }],
  ]) {
    assert.equal((await call(hoc, "bob", m, p, { body })).status, 404, `${m} ${p}`);
  }
  assert.equal((await call(hoc, "bob", "GET", `token`, { query: { featureId: [featureId] } })).status, 404);
  assert.equal((await call(hoc, "bob", "GET", "api/features")).payload.features.length, 0);
});

test("sharing: named users, everyone, policies, unknown ids, invalid bodies", async () => {
  const { hoc } = makeHoc();
  const { featureId } = await publishFeatureFor(hoc, "alice");
  const share = (user, body) => call(hoc, user, "POST", `api/features/${featureId}/share`, { body });
  for (const bad of [{}, { userIds: [] }, { userIds: [1] }, { everyone: false }, { userIds: ["bob"], everyone: true }, { userIds: ["bob"], extra: 1 }, "x"]) {
    assert.equal((await share("alice", bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await share("alice", { userIds: ["ghost"] })).status, 400);
  assert.equal((await share("alice", { everyone: true })).status, 403, "default: only admins share with everyone");
  const named = await share("alice", { userIds: ["bob", "bob"] });
  assert.equal(named.status, 200);
  assert.deepEqual(named.payload.sharing.userIds, ["alice", "bob"]);
  assert.equal((await call(hoc, "bob", "GET", "api/features")).payload.features.length, 1);
  assert.equal((await call(hoc, "bob", "GET", "api/features")).payload.features[0].sharing, undefined, "bob is neither owner nor admin");
  assert.equal((await share("bob", { userIds: ["carol"] })).status, 403, "default: only the owner shares");
  assert.equal((await call(hoc, "bob", "DELETE", `api/features/${featureId}/share/alice`)).status, 403);
  const every = await share("admin", { everyone: true });
  assert.equal(every.status, 404, "admin is not an assignee, so the feature is invisible even to admin");
  const un = await call(hoc, "alice", "DELETE", `api/features/${featureId}/share/bob`);
  assert.equal(un.status, 200);
  assert.equal((await call(hoc, "bob", "GET", "api/features")).payload.features.length, 0);
});

test("sharing with nobody-policy is 403 and the user picker follows the policy", async () => {
  const { hoc } = makeHoc();
  const { featureId } = await publishFeatureFor(hoc, "alice");
  const put = (body) => call(hoc, "admin", "PUT", "api/settings", { body });
  const base = { renderingMode: "inject", shareWithNamedUsers: "nobody", shareWithEveryone: "nobody", viewAllRequests: "admins", dataSources: [] };
  assert.equal((await put(base)).status, 200);
  assert.equal((await call(hoc, "alice", "POST", `api/features/${featureId}/share`, { body: { userIds: ["bob"] } })).status, 403);
  assert.equal((await call(hoc, "alice", "GET", "api/users", { query: { query: ["bo"] } })).status, 403);
  assert.equal((await put({ ...base, shareWithNamedUsers: "admins" })).status, 200);
  assert.equal((await call(hoc, "alice", "GET", "api/users", { query: { query: ["bo"] } })).status, 403);
  assert.equal((await call(hoc, "admin", "GET", "api/users", { query: { query: ["bo"] } })).status, 200);
  assert.equal((await put({ ...base, shareWithNamedUsers: "owner" })).status, 200);
  const users = await call(hoc, "alice", "GET", "api/users", { query: { query: ["a"], limit: ["2"] } });
  assert.equal(users.status, 200);
  assert.ok(users.payload.users.length <= 2);
  assert.ok(users.payload.users.every((u) => u.id !== "alice"), "never the caller");
  for (const q of [{}, { query: [""] }, { query: ["x".repeat(101)] }, { query: ["a"], limit: ["51"] }]) {
    assert.equal((await call(hoc, "alice", "GET", "api/users", { query: q })).status, 400, JSON.stringify(q));
  }
});

test("without userExists, sharing wants an exact id match from findUsers", async () => {
  const { hoc } = makeHoc({ userExists: false });
  const { featureId } = await publishFeatureFor(hoc, "alice");
  const share = (id) => call(hoc, "alice", "POST", `api/features/${featureId}/share`, { body: { userIds: [id] } });
  assert.equal((await share("bo")).status, 400, "a substring is not an id");
  assert.equal((await share("bob")).status, 200);
});

test("pin, current, enabled: validation and permissions", async () => {
  const { hoc } = makeHoc();
  const { featureId, requestId } = await publishFeatureFor(hoc, "alice");
  await webhook(hoc, { type: "build.version", eventId: uid(), requestRef: requestId, featureRef: featureId, version: "2.0.0", sha256: "s", entry: "e" });
  await call(hoc, "alice", "POST", `api/features/${featureId}/share`, { body: { userIds: ["bob"] } });
  const f = (user, action, body) => call(hoc, user, "POST", `api/features/${featureId}/${action}`, { body });
  assert.equal((await f("bob", "pin", {})).status, 400);
  assert.equal((await f("bob", "pin", { version: 3 })).status, 400);
  assert.equal((await f("bob", "pin", { version: "9.9.9" })).status, 404);
  assert.equal((await f("bob", "pin", { version: "1.0.0" })).payload.pinnedVersion, "1.0.0");
  assert.equal((await f("alice", "pin", { version: null })).payload.pinnedVersion, null, "bob's pin is bob's only");
  assert.equal((await f("bob", "pin", { version: null })).payload.pinnedVersion, null);
  assert.equal((await f("bob", "current", { version: "1.0.0" })).status, 403);
  assert.equal((await f("alice", "current", {})).status, 400);
  assert.equal((await f("alice", "current", { version: "9.9.9" })).status, 404);
  assert.equal((await f("alice", "current", { version: "1.0.0" })).payload.currentVersion, "1.0.0");
  assert.equal((await f("bob", "enabled", { enabled: "no" })).status, 400);
  assert.equal((await f("bob", "enabled", { enabled: false })).payload.enabled, false);
  assert.equal((await f("alice", "enabled", {})).status, 400);
});

test("resolve: a disabled feature drops out, a pin selects its version, one page per path, bad path is 400", async () => {
  const { hoc } = makeHoc();
  const a = await publishFeatureFor(hoc, "alice", { path: "/home" });
  await webhook(hoc, { type: "build.version", eventId: uid(), requestRef: a.requestId, featureRef: a.featureId, version: "2.0.0", sha256: "s2", entry: "e2" });
  const resolve = (user, path) => call(hoc, user, "GET", "api/resolve", { query: { path: [path] } });
  assert.equal((await resolve("alice", "home")).status, 400);
  assert.equal((await resolve("alice", "")).status, 400);
  assert.equal((await resolve("alice", "/home")).payload.features[0].version, "2.0.0");
  await call(hoc, "alice", "POST", `api/features/${a.featureId}/pin`, { body: { version: "1.0.0" } });
  const pinned = (await resolve("alice", "/home")).payload.features[0];
  assert.equal(pinned.version, "1.0.0");
  assert.equal(pinned.sha256, "sha256-abc");
  assert.equal((await resolve("alice", "/other")).payload.features.length, 0);
  await call(hoc, "alice", "POST", `api/features/${a.featureId}/enabled`, { body: { enabled: false } });
  assert.equal((await resolve("alice", "/home")).payload.features.length, 0);
});

test("resolve: a user-specific assignment beats everyone; the newest wins among equals", async () => {
  const { hoc } = makeHoc();
  const settings = { renderingMode: "inject", shareWithNamedUsers: "owner", shareWithEveryone: "owner", viewAllRequests: "admins", dataSources: [] };
  assert.equal((await call(hoc, "admin", "PUT", "api/settings", { body: settings })).status, 200);
  const first = (await publishFeatureFor(hoc, "alice", { path: "/dash" })).featureId;
  const second = (await publishFeatureFor(hoc, "alice", { path: "/dash" })).featureId;
  const resolve = async (user) => (await call(hoc, user, "GET", "api/resolve", { query: { path: ["/dash"] } })).payload.features.map((x) => x.featureId);
  assert.deepEqual(await resolve("alice"), [second], "newest assignment wins");
  // bob is named on the older feature, then everyone gets the newer one: bob's own assignment still beats the newer everyone-assignment
  assert.equal((await call(hoc, "alice", "POST", `api/features/${first}/share`, { body: { userIds: ["bob"] } })).status, 200);
  assert.equal((await call(hoc, "alice", "POST", `api/features/${second}/share`, { body: { everyone: true } })).status, 200);
  assert.deepEqual(await resolve("bob"), [first]);
  assert.deepEqual(await resolve("carol"), [second], "carol only has the everyone assignment");
});

// ------------------------------------------------------------------ token
test("token: only for visible, enabled features; pinned version wins; 409 and outage are mapped", async () => {
  const { hoc, platform } = makeHoc();
  const { featureId, requestId } = await publishFeatureFor(hoc, "alice");
  await webhook(hoc, { type: "build.version", eventId: uid(), requestRef: requestId, featureRef: featureId, version: "2.0.0", sha256: "s", entry: "e" });
  const token = (user) => call(hoc, user, "GET", "token", { query: { featureId: [featureId] } });
  const ok = await token("alice");
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.payload, { token: "tok", expiresAt: "2030-01-01T00:00:00Z", userId: "alice", displayName: "Alice Owner" });
  assert.deepEqual(platform.named("embedToken").at(-1).args, ["alice", `pkg/${featureId}`, "main", "2.0.0"]);
  await call(hoc, "alice", "POST", `api/features/${featureId}/pin`, { body: { version: "1.0.0" } });
  await token("alice");
  assert.equal(platform.named("embedToken").at(-1).args[3], "1.0.0");
  platform.answers.embedToken = { status: 409, ok: false, body: null };
  assert.equal((await token("alice")).payload.error, "version_unavailable");
  platform.answers.embedToken = down;
  assert.equal((await token("alice")).status, 502);
  platform.answers.embedToken = { status: 200, ok: true, body: {} };
  assert.equal((await token("alice")).status, 502, "no token in the platform's answer");
  platform.answers.embedToken = undefined;
  const before = platform.named("embedToken").length;
  await call(hoc, "alice", "POST", `api/features/${featureId}/enabled`, { body: { enabled: false } });
  assert.equal((await token("alice")).status, 404, "a disabled feature gets no token");
  assert.equal((await token("bob")).status, 404);
  assert.equal(platform.named("embedToken").length, before, "no token was ever minted for them");
});

test("token without featureId: 400 unless a legacy package/slot is configured", async () => {
  assert.equal((await call(makeHoc().hoc, "alice", "GET", "token")).status, 400);
  const { hoc, platform } = makeHoc({ legacyPackageId: "pkg/legacy", legacySlotId: "main" });
  assert.equal((await call(hoc, "alice", "GET", "token")).status, 200);
  assert.deepEqual(platform.named("embedToken")[0].args, ["alice", "pkg/legacy", "main", null]);
});

// ------------------------------------------------------------------ settings
test("settings: admin only, validated, secrets forwarded and never returned", async () => {
  const { hoc, platform } = makeHoc();
  assert.equal((await call(hoc, "alice", "GET", "api/settings")).status, 403);
  assert.equal((await call(hoc, "alice", "PUT", "api/settings", { body: {} })).status, 403);
  const defaults = (await call(hoc, "admin", "GET", "api/settings")).payload;
  assert.deepEqual(defaults, { renderingMode: "inject", shareWithNamedUsers: "owner", shareWithEveryone: "admins", viewAllRequests: "admins", dataSources: [] });
  const ok = { ...defaults, dataSources: [{ name: "crm", baseUrl: "https://crm.example.com", auth: { type: "bearer", secret: "crm-token", secretValue: "s3cret" } }] };
  const put = (body) => call(hoc, "admin", "PUT", "api/settings", { body });
  for (const bad of [
    "x", {}, { ...ok, renderingMode: "popup" }, { ...ok, shareWithNamedUsers: "all" }, { ...ok, viewAllRequests: "owner" }, { ...ok, dataSources: {} },
    { ...ok, dataSources: [{ name: "", baseUrl: "https://x.test" }] }, { ...ok, dataSources: [{ name: "n", baseUrl: "not a url" }] },
    { ...ok, dataSources: [{ name: "n", baseUrl: "https://x.test", auth: { type: "basic", secret: "s" } }] },
    { ...ok, dataSources: [{ name: "n", baseUrl: "https://x.test", auth: { type: "bearer", secret: "Bad Name" } }] },
    { ...ok, dataSources: [{ name: "n", baseUrl: "https://x.test", auth: { type: "bearer", secret: "s", secretValue: 5 } }] },
  ]) {
    assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(platform.named("putDataSources").length, 0, "nothing reached the platform for invalid input");
  const saved = await put(ok);
  assert.equal(saved.status, 200);
  assert.equal(JSON.stringify(saved.payload).includes("s3cret"), false);
  assert.deepEqual(platform.named("putSecret")[0].args, ["crm-token", "s3cret", "admin"]);
  assert.deepEqual(platform.named("putDataSources")[0].args[0], [{ name: "crm", baseUrl: "https://crm.example.com", auth: { type: "bearer", secret: "crm-token" } }]);
  assert.equal(JSON.stringify((await call(hoc, "admin", "GET", "api/settings")).payload).includes("s3cret"), false);
  // unchanged data sources and no new secret: the platform is not called again
  await put({ ...ok, dataSources: [{ name: "crm", baseUrl: "https://crm.example.com", auth: { type: "bearer", secret: "crm-token" } }], shareWithEveryone: "owner" });
  assert.equal(platform.named("putDataSources").length, 1);
  // platform failure: 502 and the settings are not saved
  platform.answers.putDataSources = down;
  assert.equal((await put({ ...ok, dataSources: [], renderingMode: "iframe" })).status, 502);
  assert.equal((await call(hoc, "admin", "GET", "api/settings")).payload.renderingMode, "inject");
});

test("the rendering mode setting is used for new requests", async () => {
  const { hoc, platform } = makeHoc();
  await call(hoc, "admin", "PUT", "api/settings", { body: { renderingMode: "iframe", shareWithNamedUsers: "owner", shareWithEveryone: "admins", viewAllRequests: "admins", dataSources: [] } });
  await call(hoc, "alice", "POST", "api/requests", { body: { text: "x" } });
  assert.equal(platform.named("startBuild")[0].args[3], "iframe");
});
