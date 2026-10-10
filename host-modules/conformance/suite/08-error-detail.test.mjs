// Structured debugging detail on hoc/api errors: `field`/`reason` (+ `values`/`limit`) say which input was
// wrong and why, and `platform` says what the platform answered when a platform call failed. Additive to
// `error` + `message`; no human text in the detail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { as, platform } from "../lib/client.mjs";
import { DEFAULT_SETTINGS, createFeature, expectError, expectOk, expectPlatform, setSettings, submit } from "../lib/world.mjs";

test("a missing field names the field and says required", async () => {
  expectError(await as("alice").post("api/requests", {}), 400, "invalid_request", { field: "text", reason: "required" });
  expectError(await as("alice").post("api/requests", { text: "   " }), 400, "invalid_request", { field: "text", reason: "required" });
});

test("a wrong type names the field and says wrong_type", async () => {
  expectError(await as("alice").post("api/requests", { text: "hi", snapshot: "nope" }), 400, "invalid_request", { field: "snapshot", reason: "wrong_type" });
  expectError(await as("alice").post("api/requests", { text: "hi", featureId: 7 }), 400, "invalid_request", { field: "featureId", reason: "wrong_type" });
});

test("an over-long text is 413 with the limit", async () => {
  expectError(await as("alice").post("api/requests", { text: "x".repeat(20001) }), 413, "payload_too_large", { field: "text", reason: "too_long", limit: 20000 });
});

test("a bad query parameter names it, and lists the allowed values or the bound", async () => {
  expectError(await as("alice").get("api/requests?scope=bogus"), 400, "invalid_request", { field: "scope", reason: "invalid_value", values: ["mine", "all"] });
  expectError(await as("alice").get("api/requests?limit=0"), 400, "invalid_request", { field: "limit", reason: "out_of_range", limit: 200 });
  expectError(await as("alice").get("api/requests?cursor=bm90YW51bWJlcg"), 400, "invalid_request", { field: "cursor", reason: "invalid_format" });
  const res = await as("alice").get("api/requests?status=Nope");
  expectError(res, 400, "invalid_request", { field: "status", reason: "invalid_value" });
  assert.ok(res.body.values.includes("NeedsInfo"), "the allowed statuses are listed");
});

test("an unknown version names the version", async () => {
  const f = await createFeature("alice");
  const res = await as("alice").post(`api/features/${encodeURIComponent(f.id)}/pin`, { version: "9.9.9" });
  expectError(res, 404, "version_not_found", { field: "version", reason: "not_found", values: ["9.9.9"] });
});

test("an invalid data source names the exact path in the settings document", async (t) => {
  t.after(() => setSettings());
  const body = { ...DEFAULT_SETTINGS, dataSources: [{ name: "ok", baseUrl: "https://api.site.example" }, { name: "bad", baseUrl: "not a url" }] };
  expectError(await as("admin").put("api/settings", body), 400, "invalid_request", { field: "dataSources[1].baseUrl", reason: "invalid_format" });
  const noName = { ...DEFAULT_SETTINGS, dataSources: [{ baseUrl: "https://api.site.example" }] };
  expectError(await as("admin").put("api/settings", noName), 400, "invalid_request", { field: "dataSources[0].name", reason: "required" });
});

test("a platform failure carries what the platform answered", async (t) => {
  t.after(() => platform.clearFailures());
  const f = await createFeature("alice");
  await platform.failNext("POST /host/v1/embed-token", 500, 1);
  const res = await as("alice").get("token", { featureId: f.id });
  expectError(res, 502, "platform_unavailable");
  expectPlatform(res, { status: 500, error: "injected_failure" });
});

test("an unreachable platform is platform.status 0", async (t) => {
  t.after(() => platform.clearFailures());
  const f = await createFeature("alice");
  await platform.failNext("POST /host/v1/embed-token", 500, 1, true);
  const res = await as("alice").get("token", { featureId: f.id });
  expectError(res, 502, "platform_unavailable");
  expectPlatform(res, { status: 0 });
  expectOk(await as("alice").get("token", { featureId: f.id }));
});

test("the tests above left no stray request behind", async () => {
  const r = await submit("alice", "detail suite sanity");
  assert.equal(r.status, "InProgress");
});
