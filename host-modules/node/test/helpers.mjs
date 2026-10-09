// Shared test fixtures: a fake platform, a roster, an in-memory SQLite host module and a signed-webhook sender.
import { HostModule, SqlStorage, sign } from "../dist/esm/index.js";

export const SECRET = "whsec_unit_tests";
export const ROSTER = {
  admin: { id: "admin", name: "Ada Admin" },
  alice: { id: "alice", name: "Alice Owner", email: "alice@example.com" },
  bob: { id: "bob", name: "Bob Builder" },
  carol: { id: "carol", name: "Carol Customer" },
};

const ok = (body) => ({ status: 200, ok: true, body });

/** Records every call; each method answers from `answers` (a function, or a result) or with a success. */
export class FakePlatform {
  constructor() {
    this.calls = [];
    this.answers = {};
    this.builds = 0;
  }

  async record(name, args, dflt) {
    this.calls.push({ name, args });
    const a = this.answers[name];
    return typeof a === "function" ? a(...args) : a ?? dflt();
  }

  startBuild(...args) {
    return this.record("startBuild", args, () => ok({ buildId: `build-${++this.builds}` }));
  }
  replyToBuild(...args) {
    return this.record("replyToBuild", args, () => ok({}));
  }
  embedToken(...args) {
    return this.record("embedToken", args, () => ok({ token: "tok", expiresAt: "2030-01-01T00:00:00Z" }));
  }
  putSecret(...args) {
    return this.record("putSecret", args, () => ok({}));
  }
  putDataSources(...args) {
    return this.record("putDataSources", args, () => ok({}));
  }
  named(name) {
    return this.calls.filter((c) => c.name === name);
  }
}

export const down = { status: 0, ok: false, body: null };

export function makeHoc({ storage, platform = new FakePlatform(), userExists = true, ...rest } = {}) {
  const store = storage ?? SqlStorage.sqlite(":memory:");
  const hoc = new HostModule({
    storage: store,
    platform,
    webhookSecret: SECRET,
    getCurrentUser: (req) => ROSTER[req] ?? null,
    isAdmin: (u) => u.id === "admin",
    findUsers: (q) => Object.values(ROSTER).filter((u) => u.id.includes(q) || u.name.toLowerCase().includes(q.toLowerCase())),
    userExists: userExists ? (id) => id in ROSTER : undefined,
    retryBuilds: false,
    ...rest,
  });
  return { hoc, platform, storage: store };
}

/** Call the module as `user` (a key of ROSTER, or null for signed out). */
export function call(hoc, user, method, path, { body, query } = {}) {
  return hoc.handle({
    method,
    path,
    query,
    request: user,
    body: body === undefined ? undefined : Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
  });
}

export function webhook(hoc, event, { secret = SECRET, sentAt = new Date().toISOString() } = {}) {
  const raw = Buffer.from(JSON.stringify({ sentAt, ...event }));
  return hoc.handle({ method: "POST", path: "webhook", headers: { "x-handofclient-signature": sign(secret, raw) }, body: raw });
}

let counter = 0;
export const uid = (p = "e") => `${p}-${Date.now()}-${++counter}`;

/** alice asks for a feature; the platform publishes version 1.0.0 for it. Returns { requestId, featureId }. */
export async function publishFeatureFor(hoc, user = "alice", { path = "/home", kind = "page-override", version = "1.0.0" } = {}) {
  const created = await call(hoc, user, "POST", "api/requests", { body: { text: "Make the home page blue" } });
  const requestId = created.payload.id;
  const featureId = uid("feat");
  const res = await webhook(hoc, {
    type: "build.version", eventId: uid(), requestRef: requestId, featureRef: featureId, version, kind, path, slotId: "main", packageId: `pkg/${featureId}`, sha256: "sha256-abc", entry: "index.js",
  });
  if (res.status !== 200) throw new Error(`webhook failed: ${JSON.stringify(res)}`);
  return { requestId, featureId };
}
