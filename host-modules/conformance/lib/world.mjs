// Scenario helpers shared by the suite files. The suite never resets the module's database: every test makes
// its own uniquely-named requests, features and paths, and restores the global settings it touches.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { as, platform } from "./client.mjs";
import { USERS } from "./profile.mjs";

export const uid = (prefix = "t") => `${prefix}${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
export const uniquePath = (name = "page") => `/conf/${uid("p")}/${name}`;

export const DEFAULT_SETTINGS = Object.freeze({
  renderingMode: "inject", shareWithNamedUsers: "owner", shareWithEveryone: "admins", viewAllRequests: "admins", dataSources: [],
});

/** Assert an error response: status, stable code, and a human message. */
export function expectError(res, status, code) {
  assert.equal(res.status, status, `expected ${status} ${code}, got ${res.status}: ${res.text}`);
  assert.equal(res.body?.error, code, `expected error code ${code}, got ${res.text}`);
  assert.equal(typeof res.body?.message, "string", "error responses carry a human message");
}

export function expectOk(res, status = 200) {
  assert.equal(res.status, status, `expected ${status}, got ${res.status}: ${res.text}`);
  return res.body;
}

/** Replace the site settings (as admin) with the defaults plus `overrides`. */
export async function setSettings(overrides = {}) {
  return expectOk(await as("admin").put("api/settings", { ...DEFAULT_SETTINGS, ...overrides }));
}

export async function submit(user, text = "Please change this page.", extra = {}) {
  return expectOk(await as(user).post("api/requests", { text, ...extra }), 201);
}

/** Wait for the platform to receive POST /builds for this request and return the recorded call. */
export async function buildCallFor(requestId, since = 0) {
  const call = await platform.waitForCall((c) => c.method === "POST" && c.path === "/host/v1/builds" && c.body?.requestRef === requestId, { since });
  assert.ok(call, `the module never called POST /host/v1/builds for request ${requestId}`);
  return call;
}

/**
 * Make `owner` own a brand-new feature: submit a request, let the fake platform "build" it (build.version for
 * each of `versions`, then build.status Success), return what the owner sees.
 */
export async function createFeature(owner, { path = uniquePath(), kind = "page-override", mode = "inject", slotId = "main", versions = ["1.0.0"] } = {}) {
  const since = await platform.mark();
  const request = await submit(owner, `Build ${path}`, { snapshot: { url: `https://site.example${path}`, path, html: "<p>hi</p>" } });
  await buildCallFor(request.id, since);
  let packageId;
  for (const [i, version] of versions.entries()) {
    const out = await platform.publish({ requestRef: request.id, featureRef: request.id, version, path, kind, mode, slotId, success: i === versions.length - 1 });
    assert.equal(out.versionResponse.status, 200, `build.version delivery was rejected: ${out.versionResponse.text}`);
    packageId = out.versionEvent.packageId;
  }
  return { id: request.id, requestId: request.id, path, kind, mode, slotId, packageId, versions, owner };
}

/** The feature as `user` sees it in GET features, or undefined. */
export async function featureFor(user, featureId) {
  const body = expectOk(await as(user).get("api/features"));
  return body.features.find((f) => f.id === featureId);
}

/** What GET resolve returns for `user` on `path`. */
export async function resolveFor(user, path) {
  return expectOk(await as(user).get("api/resolve", { path })).features;
}

/** Share a feature with named users as its owner (default policy allows that). */
export async function shareWith(feature, ...userKeys) {
  return expectOk(await as(feature.owner).post(`api/features/${encodeURIComponent(feature.id)}/share`, { userIds: userKeys.map((k) => USERS[k]?.id ?? k) }));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
