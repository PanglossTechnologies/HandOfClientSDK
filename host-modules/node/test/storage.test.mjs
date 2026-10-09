import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqlStorage, isUniqueViolation } from "../dist/esm/index.js";

const silent = { info() {}, warn() {}, error() {} };
const request = (id, seq, over = {}) => ({
  id, seq, userId: "alice", userName: "Alice", userEmail: null, text: "t", status: "InProgress", message: null, featureId: null, changeOf: null,
  mode: "inject", snapshot: null, buildId: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...over,
});
const feature = (id, over = {}) => ({
  id, title: "T", kind: "page-override", path: "/p", slotId: "main", mode: "inject", packageId: "pkg", currentVersion: "1", ownerUserId: "alice", requestId: null,
  createdAt: "2026-01-01T00:00:00.000Z", ...over,
});

async function fresh() {
  const s = SqlStorage.sqlite(":memory:");
  await s.migrate();
  return s;
}

test("migrate is idempotent and records the schema version once", async () => {
  const s = await fresh();
  await s.migrate();
  await s.migrate();
  const rows = await s.transaction(false, (tx) => tx.conn.query("SELECT version FROM hoc_migrations"));
  assert.deepEqual(rows.map((r) => Number(r.version)), [1]);
});

test("a transaction commits when it resolves and rolls back when it throws", async () => {
  const s = await fresh();
  await s.transaction(true, (tx) => tx.insertRequest(request("r1", 1)));
  await assert.rejects(
    s.transaction(true, async (tx) => {
      await tx.insertRequest(request("r2", 2));
      throw new Error("abort");
    }),
    /abort/,
  );
  assert.ok(await s.transaction(false, (tx) => tx.getRequest("r1")));
  assert.equal(await s.transaction(false, (tx) => tx.getRequest("r2")), null);
});

test("concurrent write transactions are serialised: every nextSeq is unique and gap-free", async () => {
  const s = await fresh();
  const seqs = await Promise.all(
    Array.from({ length: 25 }, () =>
      s.transaction(true, async (tx) => {
        const n = await tx.nextSeq();
        await new Promise((r) => setTimeout(r, 1)); // yields: an unserialised connection would interleave here
        return n;
      }),
    ),
  );
  assert.deepEqual([...seqs].sort((a, b) => a - b), Array.from({ length: 25 }, (_, i) => i + 1));
});

test("a failing transaction does not poison the queue", async () => {
  const s = await fresh();
  await assert.rejects(s.transaction(true, async () => { throw new Error("x"); }));
  assert.equal(await s.transaction(true, (tx) => tx.nextSeq()), 1);
});

test("data survives reopening a file database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hoc-sqlite-"));
  try {
    const path = join(dir, "hoc.db");
    const a = SqlStorage.sqlite(path);
    await a.migrate();
    await a.transaction(true, (tx) => tx.insertFeature(feature("f1")));
    const b = SqlStorage.sqlite(path);
    await b.migrate();
    assert.equal((await b.transaction(false, (tx) => tx.getFeature("f1"))).title, "T");
  } finally {
    // the open handles are released when the process exits; Windows cannot delete them yet
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
  }
});

test("events: the second record of an id is refused", async () => {
  const s = await fresh();
  assert.equal(await s.transaction(true, (tx) => tx.recordEvent("e1", "t")), true);
  assert.equal(await s.transaction(true, (tx) => tx.recordEvent("e1", "t")), false);
});

test("settings round-trip as JSON and saving replaces", async () => {
  const s = await fresh();
  assert.equal(await s.transaction(false, (tx) => tx.getSettings()), null);
  await s.transaction(true, (tx) => tx.saveSettings({ a: 1 }));
  await s.transaction(true, (tx) => tx.saveSettings({ b: [2] }));
  assert.deepEqual(await s.transaction(false, (tx) => tx.getSettings()), { b: [2] });
});

test("requests: update only whitelisted columns, page newest first, find unstarted builds", async () => {
  const s = await fresh();
  await s.transaction(true, async (tx) => {
    for (let i = 1; i <= 5; i++) await tx.insertRequest(request(`r${i}`, i, { userId: i % 2 ? "alice" : "bob" }));
    await tx.updateRequest("r5", { buildId: "b5", status: "Success" });
    await tx.updateRequest("r4", { message: "m", buildId: undefined }); // undefined fields are skipped
  });
  await s.transaction(false, async (tx) => {
    assert.deepEqual((await tx.listRequests(null, [], 2, 0)).rows.map((r) => r.id), ["r5", "r4"]);
    const p = await tx.listRequests("alice", [], 2, 0);
    assert.deepEqual(p.rows.map((r) => r.id), ["r5", "r3"]);
    assert.equal(p.more, true);
    assert.equal((await tx.listRequests("alice", [], 2, 2)).more, false);
    assert.deepEqual((await tx.listRequests(null, ["Success"], 10, 0)).rows.map((r) => r.id), ["r5"]);
    assert.deepEqual((await tx.listUnstartedBuilds(10)).map((r) => r.id), ["r1", "r2", "r3", "r4"]);
    assert.equal((await tx.getRequest("r4")).message, "m");
    assert.equal((await tx.getRequest("r5")).seq, 5);
  });
  await assert.rejects(s.transaction(true, (tx) => tx.updateRequest("r1", { text: "no" })), /cannot update/);
  await assert.rejects(s.transaction(true, (tx) => tx.updateRequest("r1", {})), /cannot update/);
  await assert.rejects(s.transaction(true, (tx) => tx.updateFeature("f", { ownerUserId: "x" })), /cannot update/);
});

test("assignments, pins, disabled flags and visibility", async () => {
  const s = await fresh();
  await s.transaction(true, async (tx) => {
    await tx.insertFeature(feature("f1"));
    await tx.insertFeature(feature("f2", { path: "/other", createdAt: "2026-01-02T00:00:00.000Z" }));
    await tx.addAssignment("f1", "alice", 1);
    await tx.addAssignment("f1", "alice", 99); // idempotent: the first seq stays
    await tx.addAssignment("f1", null, 2);
    await tx.addAssignment("f2", "bob", 3);
    await tx.setPin("f1", "alice", "1");
    await tx.setPin("f1", "alice", "2"); // replaces
    await tx.setDisabled("f1", "bob", true);
  });
  await s.transaction(false, async (tx) => {
    assert.deepEqual((await tx.getAssignments(["f1", "f2", "none"])).get("f1"), [{ userId: "alice", seq: 1 }, { userId: null, seq: 2 }]);
    assert.deepEqual((await tx.getAssignments(["none"])).get("none"), []);
    assert.equal((await tx.getUserState(["f1"], "alice")).get("f1").pinnedVersion, "2");
    assert.equal((await tx.getUserState(["f1"], "bob")).get("f1").disabled, true);
    assert.deepEqual((await tx.getUserState(["f1"], "carol")).get("f1"), { pinnedVersion: null, disabled: false });
    assert.deepEqual((await tx.listVisibleFeatures("alice")).map((f) => f.id), ["f1"]);
    assert.deepEqual((await tx.listVisibleFeatures("bob")).map((f) => f.id), ["f1", "f2"], "f1 via everyone");
    assert.deepEqual((await tx.listVisibleFeatures("bob", "/other")).map((f) => f.id), ["f2"]);
    assert.deepEqual((await tx.listVisibleFeatures("carol", "/other")).map((f) => f.id), []);
  });
  await s.transaction(true, (tx) => tx.removeAssignment("f1", "alice"));
  await s.transaction(false, async (tx) => {
    assert.equal((await tx.getUserState(["f1"], "alice")).get("f1").pinnedVersion, null, "removing a person removes their pin");
    assert.deepEqual((await tx.getAssignments(["f1"])).get("f1"), [{ userId: null, seq: 2 }]);
  });
});

test("a large id list is chunked", async () => {
  const s = await fresh();
  const ids = Array.from({ length: 1000 }, (_, i) => `f${i}`);
  await s.transaction(true, (tx) => tx.addAssignment("f999", "alice", 1));
  const got = await s.transaction(false, (tx) => tx.getAssignments(ids));
  assert.equal(got.size, 1000);
  assert.equal(got.get("f999").length, 1);
});

test("versions: upsert replaces, list is newest first", async () => {
  const s = await fresh();
  const v = (version, seq, sha256 = "s") => ({ featureId: "f1", version, publishedAt: "t", requestId: null, sha256, entry: "e", seq });
  await s.transaction(true, async (tx) => {
    await tx.upsertVersion(v("1", 1));
    await tx.upsertVersion(v("2", 2));
    await tx.upsertVersion(v("1", 3, "rebuilt"));
  });
  const list = await s.transaction(false, (tx) => tx.listVersions("f1"));
  assert.deepEqual(list.map((x) => [x.version, x.sha256]), [["1", "rebuilt"], ["2", "s"]]);
  assert.equal(await s.transaction(false, (tx) => tx.getVersion("f1", "9")), null);
});

test("isUniqueViolation recognises SQLite, PostgreSQL and MySQL duplicate-key errors", () => {
  assert.ok(isUniqueViolation({ message: "UNIQUE constraint failed: hoc_events.event_id" }));
  assert.ok(isUniqueViolation({ code: "23505" }));
  assert.ok(isUniqueViolation({ code: "ER_DUP_ENTRY" }));
  assert.ok(isUniqueViolation({ errno: 1062 }));
  assert.equal(isUniqueViolation(new Error("connection reset")), false);
  assert.equal(isUniqueViolation(null), false);
});

// ------------------------------------------------------------------ PostgreSQL / MySQL drivers against fake pools
function fakePg({ failRollback = false, failOn = null } = {}) {
  const log = [];
  const released = [];
  const client = {
    async query(text, values = []) {
      log.push({ text, values });
      if (failOn && text.includes(failOn)) throw new Error("query failed");
      if (text === "ROLLBACK" && failRollback) throw new Error("rollback failed");
      if (/FROM hoc_migrations/.test(text)) return { rows: [] };
      if (/FROM hoc_counters/.test(text)) return { rows: [{ value: "7" }] }; // PostgreSQL returns BIGINT as a string
      return { rows: [] };
    },
    release(arg) { released.push(arg); },
  };
  return { pool: { connect: async () => client }, log, released };
}

test("postgres driver: BEGIN/COMMIT, $n placeholders, string bigints become numbers", async () => {
  const { pool, log, released } = fakePg();
  const s = SqlStorage.postgres(pool, silent);
  assert.equal(await s.transaction(true, (tx) => tx.nextSeq()), 7);
  assert.deepEqual(log.map((l) => l.text), ["BEGIN", "UPDATE hoc_counters SET value = value + 1 WHERE name = $1", "SELECT value FROM hoc_counters WHERE name = $1", "COMMIT"]);
  assert.deepEqual(released, [undefined]);
  await s.transaction(false, (tx) => tx.listRequests("alice", ["Success", "Rejected"], 5, 10));
  assert.match(log.at(-2).text, /WHERE user_id = \$1 AND status IN \(\$2, \$3\) ORDER BY seq DESC LIMIT \$4 OFFSET \$5/);
  assert.deepEqual(log.at(-2).values, ["alice", "Success", "Rejected", 6, 10]);
});

test("postgres driver: an error rolls back and releases; a failed rollback destroys the connection", async () => {
  const a = fakePg({ failOn: "hoc_counters" });
  await assert.rejects(SqlStorage.postgres(a.pool, silent).transaction(true, (tx) => tx.nextSeq()), /query failed/);
  assert.deepEqual(a.log.map((l) => l.text).filter((t) => t === "ROLLBACK" || t === "COMMIT"), ["ROLLBACK"]);
  assert.deepEqual(a.released, [undefined]);
  const b = fakePg({ failOn: "hoc_counters", failRollback: true });
  await assert.rejects(SqlStorage.postgres(b.pool, silent).transaction(true, (tx) => tx.nextSeq()), /query failed/, "the original error is the one thrown");
  assert.equal(b.released.length, 1);
  assert.ok(b.released[0] instanceof Error, "release(err) tells the pool to discard the connection");
});

test("postgres migrate takes an advisory lock first and uses PostgreSQL types", async () => {
  const { pool, log } = fakePg();
  const s = SqlStorage.postgres(pool, silent);
  await s.migrate();
  const texts = log.map((l) => l.text);
  assert.match(texts[1], /pg_advisory_xact_lock/);
  assert.ok(texts.some((t) => /CREATE TABLE IF NOT EXISTS hoc_requests .*VARCHAR\(190\)/s.test(t)));
  assert.ok(texts.some((t) => /CREATE INDEX IF NOT EXISTS hoc_requests_seq/.test(t)));
  assert.equal(texts.some((t) => t.includes("{KEY}")), false, "no unexpanded placeholders");
});

function fakeMysql() {
  const log = [];
  const conn = {
    async query(sql, values = []) {
      log.push({ sql, values });
      if (/FROM hoc_counters/.test(sql)) return [[{ value: 3 }], []];
      if (/information_schema/.test(sql)) return [[{ n: 0 }], []];
      if (/FROM hoc_migrations/.test(sql)) return [[], []];
      return [{ affectedRows: 1 }, undefined]; // a ResultSetHeader, not rows
    },
    async beginTransaction() { log.push({ sql: "BEGIN" }); },
    async commit() { log.push({ sql: "COMMIT" }); },
    async rollback() { log.push({ sql: "ROLLBACK" }); },
    release() { log.push({ sql: "RELEASE" }); },
  };
  return { pool: { getConnection: async () => conn }, log };
}

test("mysql driver: begin/commit/release, ? placeholders untouched, non-row results are empty", async () => {
  const { pool, log } = fakeMysql();
  const s = SqlStorage.mysql(pool, silent);
  assert.equal(await s.transaction(true, (tx) => tx.nextSeq()), 3);
  assert.deepEqual(log.map((l) => l.sql), ["BEGIN", "UPDATE hoc_counters SET value = value + 1 WHERE name = ?", "SELECT value FROM hoc_counters WHERE name = ?", "COMMIT", "RELEASE"]);
});

test("mysql migrate takes a named lock, releases it, and uses utf8mb4_bin keys", async () => {
  const { pool, log } = fakeMysql();
  await SqlStorage.mysql(pool, silent).migrate();
  const sqls = log.map((l) => l.sql);
  assert.match(sqls[1], /GET_LOCK/);
  assert.match(sqls.at(-3), /RELEASE_LOCK/);
  assert.ok(sqls.some((q) => /utf8mb4_bin/.test(q) && /ENGINE=InnoDB/.test(q)));
  assert.ok(sqls.some((q) => /CREATE INDEX hoc_requests_seq ON hoc_requests/.test(q)), "no IF NOT EXISTS: the index is checked in information_schema first");
});
