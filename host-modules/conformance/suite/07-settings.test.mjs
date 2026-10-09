// GET/PUT settings (admins only) and the data sources / secrets pushed to the platform.
import { test } from "node:test";
import assert from "node:assert/strict";
import { as, platform } from "../lib/client.mjs";
import { profile } from "../lib/profile.mjs";
import { DEFAULT_SETTINGS, expectError, expectOk, setSettings } from "../lib/world.mjs";

const SOURCE = { name: "orders-api", baseUrl: "https://api.site.example", openapi: { openapi: "3.0.3", info: { title: "Orders", version: "1" }, paths: {} }, auth: { type: "bearer", secret: "orders-api-key" } };

test("only admins can read or write settings", async () => {
  for (const who of ["alice", "bob", "carol"]) {
    expectError(await as(who).get("api/settings"), 403, "forbidden");
    expectError(await as(who).put("api/settings", DEFAULT_SETTINGS), 403, "forbidden");
  }
});

test("defaults on a fresh database: inject, owner, admins, admins, no data sources", { skip: !profile.freshDb() && "needs a brand-new database (run.mjs --fresh-db)" }, async () => {
  assert.deepEqual(expectOk(await as("admin").get("api/settings")), DEFAULT_SETTINGS);
});

test("settings round-trip and PUT replaces the whole document", async (t) => {
  t.after(() => setSettings());
  const custom = { renderingMode: "iframe", shareWithNamedUsers: "admins", shareWithEveryone: "owner", viewAllRequests: "everyone", dataSources: [] };
  assert.deepEqual(expectOk(await as("admin").put("api/settings", custom)), custom);
  assert.deepEqual(expectOk(await as("admin").get("api/settings")), custom);
  assert.deepEqual(expectOk(await as("admin").put("api/settings", DEFAULT_SETTINGS)), DEFAULT_SETTINGS);
  assert.deepEqual(expectOk(await as("admin").get("api/settings")), DEFAULT_SETTINGS);
});

test("invalid settings are 400 invalid_request and are not saved", async (t) => {
  t.after(() => setSettings());
  const custom = await setSettings({ viewAllRequests: "everyone" });
  const bad = [
    { ...custom, renderingMode: "popup" },
    { ...custom, shareWithNamedUsers: "everyone" },
    { ...custom, shareWithEveryone: "sometimes" },
    { ...custom, viewAllRequests: "nobody" },
    { ...custom, dataSources: "none" },
    { ...custom, dataSources: [{ name: "no-url" }] },
    { renderingMode: "inject" },
    {},
  ];
  for (const body of bad) expectError(await as("admin").put("api/settings", body), 400, "invalid_request");
  assert.deepEqual(expectOk(await as("admin").get("api/settings")), custom, "a rejected PUT changes nothing");
});

test("data sources are pushed to the platform and the secret value is stored there, never returned", async (t) => {
  t.after(() => setSettings());
  const since = await platform.mark();
  const withValue = { ...SOURCE, auth: { ...SOURCE.auth, secretValue: "s3cr3t-value-123" } };
  const saved = await as("admin").put("api/settings", { ...DEFAULT_SETTINGS, dataSources: [withValue] });
  expectOk(saved);
  assert.ok(!saved.text.includes("s3cr3t-value-123"), "PUT response must not echo the secret");
  const read = await as("admin").get("api/settings");
  assert.ok(!read.text.includes("s3cr3t-value-123"), "GET must not return the secret");
  assert.equal(read.body.dataSources[0].name, "orders-api");
  assert.equal(read.body.dataSources[0].auth.secret, "orders-api-key");

  const secretCall = await platform.waitForCall((c) => c.method === "PUT" && c.path === "/host/v1/secrets", { since });
  assert.ok(secretCall, "the secret value is stored in the platform vault");
  assert.equal(secretCall.apiKey, profile.apiKey());
  assert.equal(secretCall.body.tenantId, profile.tenantId());
  assert.equal(secretCall.body.name, "orders-api-key");
  assert.equal(secretCall.body.value, "s3cr3t-value-123");

  const dsCall = await platform.waitForCall((c) => c.method === "PUT" && c.path === "/host/v1/data-sources", { since });
  assert.ok(dsCall, "the data sources are pushed to the platform");
  assert.equal(dsCall.status, 200);
  assert.equal(dsCall.body.tenantId, profile.tenantId());
  assert.deepEqual(dsCall.body.dataSources.map((d) => d.name), ["orders-api"]);
  assert.ok(!JSON.stringify(dsCall.body).includes("s3cr3t-value-123"), "the data-sources call names the secret but never carries its value");
});

test("a platform failure while saving data sources is 502 and the settings are not saved", async (t) => {
  t.after(async () => { await platform.clearFailures(); await setSettings(); });
  await setSettings();
  await platform.failNext("PUT /host/v1/data-sources", 500, 1);
  expectError(await as("admin").put("api/settings", { ...DEFAULT_SETTINGS, renderingMode: "iframe", dataSources: [SOURCE] }), 502, "platform_unavailable");
  assert.deepEqual(expectOk(await as("admin").get("api/settings")), DEFAULT_SETTINGS, "nothing was saved");
});
