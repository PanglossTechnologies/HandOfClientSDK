import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import express from "express";
import Fastify from "fastify";
import { sign } from "../dist/esm/index.js";
import { nodeHandler } from "../dist/esm/adapters/node.js";
import { router } from "../dist/esm/adapters/express.js";
import { plugin } from "../dist/esm/adapters/fastify.js";
import { ROSTER, SECRET, makeHoc, publishFeatureFor } from "./helpers.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const closers = [];
after(async () => {
  for (const c of closers) await c();
});

// a string is a direct in-process call (helpers.mjs); otherwise a real HTTP request carrying the hoc_user cookie
const cookieUser = (req) => (typeof req === "string" ? ROSTER[req] : ROSTER[/hoc_user=([^;]+)/.exec(req.headers.cookie ?? "")?.[1]]) ?? null;

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      closers.push(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

async function req(base, method, path, { user, body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(user ? { cookie: `hoc_user=${user}` } : {}), ...(body !== undefined && typeof body !== "string" ? { "content-type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : null, text };
}

function webhookBody(requestRef) {
  const raw = JSON.stringify({ type: "build.status", eventId: `evt-${Math.random()}`, sentAt: new Date().toISOString(), requestRef, status: "Rejected", message: "no" });
  return { raw, headers: { "x-handofclient-signature": sign(SECRET, Buffer.from(raw)), "content-type": "application/json" } };
}

// ------------------------------------------------------------------ Express
test("express: routes under the mount, JSON no-store responses, identity from the cookie", async () => {
  const { hoc } = makeHoc({ getCurrentUser: cookieUser });
  const app = express();
  app.get("/outside", (_req, res) => res.send("site"));
  app.use("/hoc", router(hoc));
  const base = await listen(http.createServer(app));
  assert.equal((await req(base, "GET", "/outside")).text, "site");
  const anon = await req(base, "GET", "/hoc/api/features");
  assert.equal(anon.status, 401);
  assert.equal(anon.headers.get("cache-control"), "no-store");
  assert.match(anon.headers.get("content-type"), /application\/json/);
  const created = await req(base, "POST", "/hoc/api/requests", { user: "alice", body: { text: "hello" } });
  assert.equal(created.status, 201);
  assert.equal((await req(base, "GET", "/hoc/api/requests?limit=1", { user: "alice" })).json.requests.length, 1);
  assert.equal((await req(base, "GET", "/hoc/nope", { user: "alice" })).status, 404);
});

test("express: a percent-encoded id in the path is decoded", async () => {
  const { hoc } = makeHoc({ getCurrentUser: cookieUser });
  const { featureId } = await publishFeatureFor(hoc, "alice");
  const app = express();
  app.use("/hoc", router(hoc));
  const base = await listen(http.createServer(app));
  await req(base, "POST", `/hoc/api/features/${featureId}/share`, { user: "alice", body: { userIds: ["bob"] } });
  assert.equal((await req(base, "DELETE", `/hoc/api/features/${featureId}/share/${encodeURIComponent("bob")}`, { user: "alice" })).status, 200);
  assert.equal((await req(base, "GET", "/hoc/api/features/%E0%A4%A/versions", { user: "alice" })).status, 400, "malformed percent-encoding");
});

test("express: a body parser that ran first still works for the API; the webhook needs the raw bytes (rawBody)", async () => {
  const { hoc } = makeHoc({ getCurrentUser: cookieUser, logger: { info() {}, warn() {}, error() {} } });
  const created = (await (async () => {
    const app = express();
    app.use(express.json({ verify: (r, _res, buf) => { r.rawBody = buf; } }));
    app.use("/hoc", router(hoc));
    const base = await listen(http.createServer(app));
    const c = await req(base, "POST", "/hoc/api/requests", { user: "alice", body: { text: "parsed first" } });
    assert.equal(c.status, 201);
    const w = webhookBody(c.json.id);
    assert.equal((await req(base, "POST", "/hoc/webhook", { body: w.raw, headers: w.headers })).status, 200, "rawBody captured by the verify hook");
    return c;
  })());
  assert.ok(created.json.id);
  // without the verify hook the original bytes are gone: the re-serialised JSON may not match the signature
  const app = express();
  app.use(express.json());
  app.use("/hoc", router(hoc));
  const base = await listen(http.createServer(app));
  const spaced = JSON.stringify({ type: "build.status", eventId: "evt-spaced", sentAt: new Date().toISOString(), requestRef: created.json.id, status: "Success" }, null, 2);
  const res = await req(base, "POST", "/hoc/webhook", { body: spaced, headers: { "x-handofclient-signature": sign(SECRET, Buffer.from(spaced)), "content-type": "application/json" } });
  assert.equal(res.status, 401);
});

test("express: an oversized body is 413", async () => {
  const { hoc } = makeHoc({ getCurrentUser: cookieUser });
  const app = express();
  app.use("/hoc", router(hoc, { maxBodyBytes: 1000 }));
  const base = await listen(http.createServer(app));
  const res = await req(base, "POST", "/hoc/api/requests", { user: "alice", body: { text: "x".repeat(5000) } });
  assert.equal(res.status, 413);
});

// ------------------------------------------------------------------ plain http
test("node http: prefix handling", async () => {
  const { hoc } = makeHoc({ getCurrentUser: cookieUser });
  const base = await listen(http.createServer(nodeHandler(hoc, { prefix: "/hoc" })));
  assert.equal((await req(base, "GET", "/hoc/api/features", { user: "alice" })).status, 200);
  assert.equal((await req(base, "GET", "/hocus/api/features", { user: "alice" })).status, 404);
  assert.equal((await req(base, "GET", "/api/features", { user: "alice" })).status, 404);
});

// ------------------------------------------------------------------ Fastify
test("fastify: routes under the prefix; the raw-body parser does not leak to the rest of the app", async () => {
  const { hoc } = makeHoc({ getCurrentUser: cookieUser });
  const app = Fastify();
  app.post("/echo", async (request) => ({ got: request.body }));
  await app.register(plugin(hoc), { prefix: "/hoc" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  closers.push(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const echo = await req(base, "POST", "/echo", { body: { a: 1 } });
  assert.deepEqual(echo.json, { got: { a: 1 } }, "the site's own JSON parsing is untouched");
  const created = await req(base, "POST", "/hoc/api/requests", { user: "alice", body: { text: "hi" } });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("cache-control"), "no-store");
  assert.equal((await req(base, "GET", "/hoc/api/features")).status, 401);
  assert.equal((await req(base, "GET", "/hoc/api/users?query=bo", { user: "alice" })).json.users[0].id, "bob");
  const w = webhookBody(created.json.id);
  assert.equal((await req(base, "POST", "/hoc/webhook", { body: w.raw, headers: w.headers })).status, 200);
  assert.equal((await req(base, "POST", "/hoc/webhook", { body: w.raw, headers: { ...w.headers, "x-handofclient-signature": "sha256=00" } })).status, 401);
  assert.equal((await req(base, "POST", "/hoc/api/requests", { user: "alice", body: "{broken", headers: { "content-type": "application/json" } })).status, 400);
  assert.equal((await req(base, "POST", "/hoc/api/requests", { user: "alice", body: "text", headers: { "content-type": "text/plain" } })).status, 400, "any content type reaches the module");
});

test("fastify: a percent-encoded id (plus sign, at sign) reaches the module decoded", async () => {
  const { hoc } = makeHoc({ getCurrentUser: cookieUser });
  const { featureId } = await publishFeatureFor(hoc, "alice");
  const app = Fastify();
  await app.register(plugin(hoc), { prefix: "/hoc" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  closers.push(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await req(base, "DELETE", `/hoc/api/features/${featureId}/share/${encodeURIComponent("erin+qa@example.com")}`, { user: "alice" })).status, 200);
});

// ------------------------------------------------------------------ packaging
test("the CommonJS build loads with require() and exposes the same API", () => {
  const out = execFileSync(process.execPath, ["-e", `
    const m = require("./dist/cjs/index.js");
    const e = require("./dist/cjs/adapters/express.js");
    const f = require("./dist/cjs/adapters/fastify.js");
    console.log(typeof m.HostModule, typeof m.SqlStorage.sqlite, typeof m.PlatformClient, typeof e.router, typeof f.plugin);
    m.SqlStorage.sqlite(":memory:").migrate().then(() => console.log("migrated"));
  `], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  assert.equal(out.trim(), "function function function function function\nmigrated");
});

test("package exports point at files that exist", async () => {
  const pkg = JSON.parse((await import("node:fs")).readFileSync(join(root, "package.json"), "utf8"));
  const { existsSync } = await import("node:fs");
  for (const [key, target] of Object.entries(pkg.exports)) {
    if (typeof target === "string") continue;
    for (const [cond, file] of Object.entries(target)) assert.ok(existsSync(join(root, file)), `${key} ${cond} -> ${file}`);
  }
});
