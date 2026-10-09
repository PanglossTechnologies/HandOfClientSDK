// Every browser-facing call is authenticated by the site session and nothing else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { as } from "../lib/client.mjs";
import { expectError } from "../lib/world.mjs";

const CALLS = [
  ["GET", "token?featureId=x"],
  ["POST", "api/requests", { text: "hi" }],
  ["GET", "api/requests"],
  ["POST", "api/requests/x/reply", { text: "hi" }],
  ["GET", "api/features"],
  ["GET", "api/resolve?path=/x"],
  ["GET", "api/features/x/versions"],
  ["POST", "api/features/x/pin", { version: null }],
  ["POST", "api/features/x/current", { version: "1.0.0" }],
  ["POST", "api/features/x/share", { everyone: true }],
  ["DELETE", "api/features/x/share/everyone"],
  ["POST", "api/features/x/enabled", { enabled: false }],
  ["GET", "api/users?query=a"],
  ["GET", "api/settings"],
  ["PUT", "api/settings", {}],
];

const call = (who, [method, path, body], headers) => {
  const c = as(who, headers);
  return method === "GET" ? c.get(path) : method === "POST" ? c.post(path, body) : method === "PUT" ? c.put(path, body) : c.del(path);
};

for (const c of CALLS) {
  test(`${c[0]} ${c[1]} without a session answers 401 unauthenticated`, async () => {
    expectError(await call(null, c), 401, "unauthenticated");
  });
}

test("a session for a user the site does not know is not a session", async () => {
  expectError(await as("nobody-by-that-name").get("api/features"), 401, "unauthenticated");
});

test("identity is never taken from headers or the query string", async () => {
  const headers = { "x-user-id": "alice", "x-forwarded-user": "alice", "x-hoc-user": "alice", authorization: "Bearer alice" };
  expectError(await as(null, headers).get("api/features"), 401, "unauthenticated");
  expectError(await as(null, headers).get("api/features", { userId: "alice", user: "alice", user_id: "alice" }), 401, "unauthenticated");
  expectError(await as(null, headers).post("api/requests", { text: "hi", userId: "alice" }), 401, "unauthenticated");
});

test("a request body cannot name the requester", async () => {
  const res = await as("bob").post("api/requests", { text: "I am not alice", userId: "alice", userName: "Alice" });
  assert.equal(res.status, 201);
  assert.equal(res.body.userId, "bob", "the requester is whoever the session says");
});

test("the three endpoint groups exist (signed-in calls do not 404)", async () => {
  const res = await as("alice").get("api/features");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.features));
});
