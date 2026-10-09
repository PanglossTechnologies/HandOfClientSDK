// HandOfClient.features.* (createFeaturesApi) in plain Node against the fake site: URL building, encoding,
// error mapping. No browser needed.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createFeaturesApi, FeaturesApiError } from "../dist/host/index.js";
import { createFakeSite, feature } from "../test-support/fake-site.mjs";

let server, base;
const fake = createFakeSite();
const as = (user) => ({ sitePrefix: `${base}/hoc`, fetch: (url, init) => fetch(url, { ...init, headers: { ...init.headers, cookie: `hoc_user=${user}` } }) });

before(async () => {
  server = createServer(async (req, res) => {
    if (req.url === "/hoc/api/features" && req.headers["x-html-error"]) { res.writeHead(500, { "content-type": "text/html" }); return res.end("<h1>oops</h1>"); }
    if (!(await fake.handle(req, res))) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

describe("createFeaturesApi", () => {
  test("covers every endpoint; encodes ids and repeats status parameters", async () => {
    fake.reset({ features: [feature({ id: "f 1/x", ownerUserId: "alice" })] });
    const api = createFeaturesApi(as("alice"));
    const created = await api.createRequest({ text: "hi" });
    assert.equal(created.status, "InProgress");
    await api.listRequests({ scope: "mine", status: ["InProgress", "NeedsInfo"], limit: 5 });
    assert.equal(fake.log.at(-1).query, "?scope=mine&status=InProgress&status=NeedsInfo&limit=5");
    assert.equal((await api.listFeatures()).length, 1);
    assert.equal((await api.listFeatureVersions("f 1/x")).versions.length, 2);
    assert.equal((await api.pinFeatureVersion("f 1/x", "1.0.0")).pinnedVersion, "1.0.0");
    assert.equal((await api.setFeatureCurrentVersion("f 1/x", "1.0.0")).currentVersion, "1.0.0");
    assert.equal((await api.setFeatureEnabled("f 1/x", false)).enabled, false);
    assert.deepEqual((await api.shareFeature("f 1/x", { userIds: ["bob"] })).sharing.userIds, ["bob"]);
    assert.deepEqual((await api.unshareFeature("f 1/x", "bob")).sharing.userIds, []);
    assert.deepEqual((await api.findUsers("bo")).map((u) => u.id), ["bob"]);
    assert.equal(fake.log.find((l) => l.path.startsWith("features/f%201%2Fx/pin")).method, "POST");
  });

  test("settings round trip (admin) and the site's refusal for everyone else", async () => {
    fake.reset();
    const settings = await createFeaturesApi(as("admin")).getSettings();
    assert.equal(settings.renderingMode, "inject");
    assert.equal((await createFeaturesApi(as("admin")).putSettings({ ...settings, renderingMode: "iframe" })).renderingMode, "iframe");
    await assert.rejects(createFeaturesApi(as("alice")).getSettings(), (e) => e instanceof FeaturesApiError && e.code === "forbidden" && e.status === 403);
  });

  test("errors carry the site's code, status and message", async () => {
    fake.reset();
    await assert.rejects(createFeaturesApi(as("nobody")).listFeatures(), (e) => e.code === "unauthenticated" && e.status === 401 && e.message === "Please sign in first.");
    await assert.rejects(createFeaturesApi(as("alice")).pinFeatureVersion("missing", null), (e) => e.code === "not_found" && e.status === 404);
  });

  test("a non-JSON error and an unreachable site map to unexpected_response and network_error", async () => {
    const html = createFeaturesApi({ sitePrefix: `${base}/hoc`, fetch: (url, init) => fetch(url, { ...init, headers: { "x-html-error": "1" } }) });
    await assert.rejects(html.listFeatures(), (e) => e.code === "unexpected_response" && e.status === 500);
    const down = createFeaturesApi({ sitePrefix: "http://127.0.0.1:1/hoc" });
    await assert.rejects(down.listFeatures(), (e) => e.code === "network_error" && e.status === 0);
  });
});
