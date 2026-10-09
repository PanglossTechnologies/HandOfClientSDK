/**
 * SQL storage for SQLite (`node:sqlite`, Node 22.13+), PostgreSQL (a `pg` Pool) and MySQL / MariaDB (a `mysql2/promise` Pool).
 * No driver is a dependency of this package: you hand over the pool you already have.
 *
 *     SqlStorage.sqlite("hoc.db")
 *     SqlStorage.postgres(new pg.Pool({ connectionString }))
 *     SqlStorage.mysql(mysql2.createPool({ uri }))        // from "mysql2/promise"
 *
 * Tables are prefixed `hoc_` and created / upgraded by {@link SqlStorage.migrate}. The schema is the same as the
 * Python host module's, so both can serve the same database.
 */
import { nowIso } from "../timeutil.js";
import { defaultLogger, describeError, type Logger } from "../logger.js";
import type { Assignment, FeatureRec, FeatureUpdate, RequestRec, RequestUpdate, Storage, StorageTx, UserState, VersionRec } from "./base.js";

export type Row = Record<string, any>;

// --------------------------------------------------------------------------------------- dialects
export interface Dialect {
  name: "sqlite" | "postgres" | "mysql";
  /** short indexed identifier column */
  key: string;
  /** medium string */
  str: string;
  /** large text */
  text: string;
  bigint: string;
  smallint: string;
  tableSuffix: string;
}

export const SQLITE: Dialect = { name: "sqlite", key: "TEXT", str: "TEXT", text: "TEXT", bigint: "INTEGER", smallint: "INTEGER", tableSuffix: "" };
export const POSTGRES: Dialect = { name: "postgres", key: "VARCHAR(190)", str: "VARCHAR(1024)", text: "TEXT", bigint: "BIGINT", smallint: "SMALLINT", tableSuffix: "" };
// utf8mb4_bin: ids are case-sensitive, as they are in SQLite and PostgreSQL.
export const MYSQL: Dialect = {
  name: "mysql",
  key: "VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin",
  str: "VARCHAR(1024)",
  text: "LONGTEXT",
  bigint: "BIGINT",
  smallint: "SMALLINT",
  tableSuffix: " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
};

function ddl(d: Dialect, stmt: string): string {
  const types: Record<string, string> = { KEY: d.key, STR: d.str, TEXT: d.text, BIGINT: d.bigint, SMALLINT: d.smallint };
  return stmt.replace(/\{(KEY|STR|TEXT|BIGINT|SMALLINT)\}/g, (_, k: string) => types[k]) + d.tableSuffix;
}

/** Our SQL uses `?` placeholders; node-postgres wants `$1, $2...` (the SQL never contains a literal `?`). */
function toPg(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

const nullify = (params: readonly unknown[]): unknown[] => params.map((p) => (p === undefined ? null : p));

/** True for a duplicate-key error from any of the three databases. */
export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: unknown; errno?: unknown; message?: unknown } | null;
  return err?.code === "23505" || err?.code === "ER_DUP_ENTRY" || err?.errno === 1062 || /constraint failed/i.test(String(err?.message ?? ""));
}

// --------------------------------------------------------------------------------------- drivers
/** Runs SQL (with `?` placeholders) on one connection inside one transaction. */
export interface SqlConnection {
  query(sql: string, params?: readonly unknown[]): Promise<Row[]>;
}

/** Opens, commits and rolls back transactions on one kind of database. */
export interface SqlDriver {
  readonly dialect: Dialect;
  /** Run `fn` in a transaction: committed when it resolves, rolled back when it throws. Never nest calls. */
  transaction<T>(write: boolean, fn: (conn: SqlConnection) => Promise<T>): Promise<T>;
}

export interface SqliteOptions {
  /** How long a writer waits for another process's lock (default 30000). */
  busyTimeoutMs?: number;
  logger?: Logger;
}

/** A single `node:sqlite` connection; transactions are queued so they never interleave. */
export function sqliteDriver(path: string, opts: SqliteOptions = {}): SqlDriver {
  const log = opts.logger ?? defaultLogger;
  let db: any;
  let queue: Promise<unknown> = Promise.resolve();

  const open = async (): Promise<any> => {
    if (db) return db;
    let mod: any;
    try {
      mod = await import("node:sqlite");
    } catch (e) {
      throw new Error("SqlStorage.sqlite needs the node:sqlite module (Node 22.13 or newer).", { cause: e });
    }
    const d = new mod.DatabaseSync(path);
    d.exec(`PRAGMA busy_timeout = ${Math.trunc(opts.busyTimeoutMs ?? 30_000)}`);
    d.exec("PRAGMA journal_mode = WAL");
    db = d;
    return d;
  };

  return {
    dialect: SQLITE,
    transaction<T>(write: boolean, fn: (conn: SqlConnection) => Promise<T>): Promise<T> {
      const run = queue.then(async () => {
        const d = await open();
        const conn: SqlConnection = { query: async (sql, params = []) => d.prepare(sql).all(...nullify(params)) as Row[] };
        // BEGIN IMMEDIATE for writers: they queue on the file lock instead of deadlocking on upgrade.
        d.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
        try {
          const result = await fn(conn);
          d.exec("COMMIT");
          return result;
        } catch (e) {
          try {
            d.exec("ROLLBACK");
          } catch (re) {
            log.error(`sqlite rollback failed\n${describeError(re)}`); // the original error is the one worth reporting
          }
          throw e;
        }
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

/** The parts of a `pg` Pool that are used. */
export interface PgPoolLike {
  connect(): Promise<{ query(text: string, values?: unknown[]): Promise<{ rows: Row[] }>; release(destroy?: unknown): void }>;
}

export function postgresDriver(pool: PgPoolLike, logger: Logger = defaultLogger): SqlDriver {
  return {
    dialect: POSTGRES,
    async transaction<T>(_write: boolean, fn: (conn: SqlConnection) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let destroy: unknown;
      try {
        await client.query("BEGIN");
        const result = await fn({ query: async (sql, params = []) => (await client.query(toPg(sql), nullify(params))).rows });
        await client.query("COMMIT");
        return result;
      } catch (e) {
        try {
          await client.query("ROLLBACK");
        } catch (re) {
          destroy = re; // the connection is unusable; the pool must not hand it out again
          logger.error(`postgres rollback failed\n${describeError(re)}`);
        }
        throw e;
      } finally {
        client.release(destroy);
      }
    },
  };
}

/** The parts of a `mysql2/promise` Pool that are used. */
export interface MysqlPoolLike {
  getConnection(): Promise<{
    query(sql: string, values?: unknown[]): Promise<any>;
    beginTransaction(): Promise<void>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    release(): void;
    destroy?(): void;
  }>;
}

export function mysqlDriver(pool: MysqlPoolLike, logger: Logger = defaultLogger): SqlDriver {
  return {
    dialect: MYSQL,
    async transaction<T>(_write: boolean, fn: (conn: SqlConnection) => Promise<T>): Promise<T> {
      const c = await pool.getConnection();
      let broken = false;
      try {
        await c.beginTransaction();
        const result = await fn({
          query: async (sql, params = []) => {
            const [rows] = await c.query(sql, nullify(params));
            return Array.isArray(rows) ? (rows as Row[]) : [];
          },
        });
        await c.commit();
        return result;
      } catch (e) {
        try {
          await c.rollback();
        } catch (re) {
          broken = true;
          logger.error(`mysql rollback failed\n${describeError(re)}`);
        }
        throw e;
      } finally {
        if (broken && c.destroy) c.destroy();
        else c.release();
      }
    },
  };
}

// --------------------------------------------------------------------------------------- migrations
/** What a migration step may do: run DDL (`{KEY}`-style type placeholders), create an index, run SQL. */
export class MigrationContext {
  constructor(
    readonly conn: SqlConnection,
    readonly dialect: Dialect,
  ) {}

  ddl(stmt: string): Promise<Row[]> {
    return this.conn.query(ddl(this.dialect, stmt));
  }

  execute(sql: string, params: readonly unknown[] = []): Promise<Row[]> {
    return this.conn.query(sql, params);
  }

  async index(table: string, name: string, cols: string): Promise<void> {
    if (this.dialect.name === "mysql") {
      // no CREATE INDEX IF NOT EXISTS
      const rows = await this.conn.query(
        "SELECT COUNT(*) AS n FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?",
        [table, name],
      );
      if (Number(rows[0]?.n ?? 0) > 0) return;
      await this.conn.query(`CREATE INDEX ${name} ON ${table} (${cols})`);
    } else {
      await this.conn.query(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${cols})`);
    }
  }
}

async function migration1(ctx: MigrationContext): Promise<void> {
  for (const stmt of [
    "CREATE TABLE IF NOT EXISTS hoc_settings (name {KEY} NOT NULL PRIMARY KEY, value {TEXT} NOT NULL)",
    "CREATE TABLE IF NOT EXISTS hoc_counters (name {KEY} NOT NULL PRIMARY KEY, value {BIGINT} NOT NULL)",
    "CREATE TABLE IF NOT EXISTS hoc_events (event_id {KEY} NOT NULL PRIMARY KEY, received_at {KEY} NOT NULL)",
    `CREATE TABLE IF NOT EXISTS hoc_requests (
      id {KEY} NOT NULL PRIMARY KEY, seq {BIGINT} NOT NULL, user_id {KEY} NOT NULL, user_name {STR} NULL, user_email {STR} NULL,
      text {TEXT} NOT NULL, status {KEY} NOT NULL, message {TEXT} NULL, feature_id {KEY} NULL, change_of {KEY} NULL,
      mode {KEY} NOT NULL, snapshot {TEXT} NULL, build_id {KEY} NULL, created_at {KEY} NOT NULL, updated_at {KEY} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS hoc_features (
      id {KEY} NOT NULL PRIMARY KEY, title {STR} NOT NULL, kind {KEY} NOT NULL, path {STR} NULL, slot_id {KEY} NOT NULL,
      mode {KEY} NOT NULL, package_id {STR} NOT NULL, current_version {KEY} NOT NULL, owner_user_id {KEY} NOT NULL,
      request_id {KEY} NULL, created_at {KEY} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS hoc_versions (
      feature_id {KEY} NOT NULL, version {KEY} NOT NULL, published_at {KEY} NOT NULL, request_id {KEY} NULL,
      sha256 {KEY} NOT NULL, entry {STR} NOT NULL, seq {BIGINT} NOT NULL, PRIMARY KEY (feature_id, version))`,
    `CREATE TABLE IF NOT EXISTS hoc_assignments (
      feature_id {KEY} NOT NULL, everyone {SMALLINT} NOT NULL, user_id {KEY} NOT NULL, seq {BIGINT} NOT NULL,
      PRIMARY KEY (feature_id, everyone, user_id))`,
    `CREATE TABLE IF NOT EXISTS hoc_pins (
      feature_id {KEY} NOT NULL, user_id {KEY} NOT NULL, version {KEY} NOT NULL, PRIMARY KEY (feature_id, user_id))`,
    `CREATE TABLE IF NOT EXISTS hoc_disabled (
      feature_id {KEY} NOT NULL, user_id {KEY} NOT NULL, PRIMARY KEY (feature_id, user_id))`,
  ]) {
    await ctx.ddl(stmt);
  }
  await ctx.index("hoc_requests", "hoc_requests_user_seq", "user_id, seq");
  await ctx.index("hoc_requests", "hoc_requests_seq", "seq");
  await ctx.index("hoc_assignments", "hoc_assignments_user", "user_id, feature_id");
  await ctx.index("hoc_pins", "hoc_pins_user", "user_id");
  if ((await ctx.execute("SELECT 1 AS x FROM hoc_counters WHERE name = ?", ["seq"])).length === 0) {
    await ctx.execute("INSERT INTO hoc_counters (name, value) VALUES (?, ?)", ["seq", 0]);
  }
}

/** (version, description, function). Append only; never edit a shipped migration. */
export const MIGRATIONS: ReadonlyArray<readonly [number, string, (ctx: MigrationContext) => Promise<void>]> = [[1, "initial schema", migration1]];

// --------------------------------------------------------------------------------------- storage
export class SqlStorage implements Storage {
  constructor(
    private readonly driver: SqlDriver,
    private readonly logger: Logger = defaultLogger,
  ) {}

  /** `node:sqlite` file (WAL mode, one connection, writers take `BEGIN IMMEDIATE`). Needs Node 22.13+. */
  static sqlite(path: string, opts: SqliteOptions = {}): SqlStorage {
    return new SqlStorage(sqliteDriver(path, opts), opts.logger);
  }

  /** A `pg` Pool (node-postgres). */
  static postgres(pool: PgPoolLike, logger?: Logger): SqlStorage {
    return new SqlStorage(postgresDriver(pool, logger), logger);
  }

  /** A `mysql2/promise` Pool (MySQL or MariaDB; tables are utf8mb4). */
  static mysql(pool: MysqlPoolLike, logger?: Logger): SqlStorage {
    return new SqlStorage(mysqlDriver(pool, logger), logger);
  }

  transaction<T>(write: boolean, fn: (tx: StorageTx) => Promise<T>): Promise<T> {
    return this.driver.transaction(write, (conn) => fn(new SqlTx(conn)));
  }

  async migrate(): Promise<void> {
    const dialect = this.driver.dialect;
    await this.driver.transaction(true, async (conn) => {
      const ctx = new MigrationContext(conn, dialect);
      // Two processes starting at once must not both create tables: PostgreSQL and MySQL take a lock first
      // (SQLite's BEGIN IMMEDIATE already serialises writers). Every step is idempotent anyway.
      if (dialect.name === "postgres") await conn.query("SELECT pg_advisory_xact_lock(727274)");
      if (dialect.name === "mysql") await conn.query("SELECT GET_LOCK('hoc_migrate', 60) AS got");
      try {
        await ctx.ddl("CREATE TABLE IF NOT EXISTS hoc_migrations (version {BIGINT} NOT NULL PRIMARY KEY, name {STR} NOT NULL, applied_at {KEY} NOT NULL)");
        const applied = new Set((await conn.query("SELECT version FROM hoc_migrations")).map((r) => Number(r.version)));
        for (const [version, name, fn] of MIGRATIONS) {
          if (applied.has(version)) continue;
          this.logger.info(`handofclient: applying migration ${version} (${name})`);
          await fn(ctx);
          await conn.query("INSERT INTO hoc_migrations (version, name, applied_at) VALUES (?, ?, ?)", [version, name, nowIso()]);
        }
      } finally {
        if (dialect.name === "mysql") await conn.query("SELECT RELEASE_LOCK('hoc_migrate') AS released");
      }
    });
  }
}

const REQ_COLS = "id, seq, user_id, user_name, user_email, text, status, message, feature_id, change_of, mode, snapshot, build_id, created_at, updated_at";
const FEAT_COLS = "id, title, kind, path, slot_id, mode, package_id, current_version, owner_user_id, request_id, created_at";
const VER_COLS = "feature_id, version, published_at, request_id, sha256, entry, seq";
const REQ_UPDATABLE: Record<keyof RequestUpdate, string> = { status: "status", message: "message", featureId: "feature_id", buildId: "build_id", updatedAt: "updated_at" };
const FEAT_UPDATABLE: Record<keyof FeatureUpdate, string> = { currentVersion: "current_version", slotId: "slot_id", mode: "mode" };
const CHUNK = 400;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

function setClause(fields: Record<string, unknown>, allowed: Record<string, string>): { sql: string; values: unknown[] } {
  const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
  const bad = keys.filter((k) => !(k in allowed));
  if (bad.length > 0 || keys.length === 0) throw new Error(`cannot update columns ${bad.length > 0 ? JSON.stringify(bad) : "(none given)"}`);
  return { sql: keys.map((k) => `${allowed[k]} = ?`).join(", "), values: keys.map((k) => fields[k]) };
}

const toRequest = (r: Row): RequestRec => ({
  id: r.id,
  seq: Number(r.seq),
  userId: r.user_id,
  userName: r.user_name ?? null,
  userEmail: r.user_email ?? null,
  text: r.text,
  status: r.status,
  message: r.message ?? null,
  featureId: r.feature_id ?? null,
  changeOf: r.change_of ?? null,
  mode: r.mode,
  snapshot: r.snapshot ?? null,
  buildId: r.build_id ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toFeature = (r: Row): FeatureRec => ({
  id: r.id,
  title: r.title,
  kind: r.kind,
  path: r.path ?? null,
  slotId: r.slot_id,
  mode: r.mode,
  packageId: r.package_id,
  currentVersion: r.current_version,
  ownerUserId: r.owner_user_id,
  requestId: r.request_id ?? null,
  createdAt: r.created_at,
});

const toVersion = (r: Row): VersionRec => ({
  featureId: r.feature_id,
  version: r.version,
  publishedAt: r.published_at,
  requestId: r.request_id ?? null,
  sha256: r.sha256,
  entry: r.entry,
  seq: Number(r.seq),
});

export class SqlTx implements StorageTx {
  constructor(private readonly conn: SqlConnection) {}

  private all(sql: string, params: readonly unknown[] = []): Promise<Row[]> {
    return this.conn.query(sql, params);
  }

  private async one(sql: string, params: readonly unknown[] = []): Promise<Row | null> {
    return (await this.conn.query(sql, params))[0] ?? null;
  }

  // ---- counters / events / settings
  async nextSeq(): Promise<number> {
    await this.all("UPDATE hoc_counters SET value = value + 1 WHERE name = ?", ["seq"]);
    const row = await this.one("SELECT value FROM hoc_counters WHERE name = ?", ["seq"]);
    if (!row) throw new Error("hoc_counters is missing its 'seq' row; run SqlStorage.migrate()");
    return Number(row.value);
  }

  async recordEvent(eventId: string, receivedAt: string): Promise<boolean> {
    if (await this.one("SELECT 1 AS x FROM hoc_events WHERE event_id = ?", [eventId])) return false;
    try {
      await this.all("INSERT INTO hoc_events (event_id, received_at) VALUES (?, ?)", [eventId, receivedAt]);
    } catch (e) {
      if (isUniqueViolation(e)) return false; // concurrent duplicate; the caller abandons this transaction
      throw e;
    }
    return true;
  }

  async getSettings(): Promise<Record<string, any> | null> {
    const row = await this.one("SELECT value FROM hoc_settings WHERE name = ?", ["settings"]);
    return row ? JSON.parse(row.value) : null;
  }

  async saveSettings(settings: Record<string, any>): Promise<void> {
    await this.all("DELETE FROM hoc_settings WHERE name = ?", ["settings"]);
    await this.all("INSERT INTO hoc_settings (name, value) VALUES (?, ?)", ["settings", JSON.stringify(settings)]);
  }

  // ---- requests
  async insertRequest(r: RequestRec): Promise<void> {
    await this.all(`INSERT INTO hoc_requests (${REQ_COLS}) VALUES (${marks(15)})`, [
      r.id, r.seq, r.userId, r.userName, r.userEmail, r.text, r.status, r.message, r.featureId, r.changeOf, r.mode, r.snapshot, r.buildId, r.createdAt, r.updatedAt,
    ]);
  }

  async getRequest(requestId: string): Promise<RequestRec | null> {
    const row = await this.one(`SELECT ${REQ_COLS} FROM hoc_requests WHERE id = ?`, [requestId]);
    return row ? toRequest(row) : null;
  }

  async updateRequest(requestId: string, fields: RequestUpdate): Promise<void> {
    const { sql, values } = setClause(fields, REQ_UPDATABLE);
    await this.all(`UPDATE hoc_requests SET ${sql} WHERE id = ?`, [...values, requestId]);
  }

  async listRequests(userId: string | null, statuses: readonly string[], limit: number, offset: number): Promise<{ rows: RequestRec[]; more: boolean }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (userId !== null) {
      where.push("user_id = ?");
      params.push(userId);
    }
    if (statuses.length > 0) {
      where.push(`status IN (${marks(statuses.length)})`);
      params.push(...statuses);
    }
    const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    const rows = await this.all(`SELECT ${REQ_COLS} FROM hoc_requests${clause} ORDER BY seq DESC LIMIT ? OFFSET ?`, [...params, limit + 1, offset]);
    return { rows: rows.slice(0, limit).map(toRequest), more: rows.length > limit };
  }

  async listUnstartedBuilds(limit: number): Promise<RequestRec[]> {
    const rows = await this.all(`SELECT ${REQ_COLS} FROM hoc_requests WHERE build_id IS NULL AND status = ? ORDER BY seq LIMIT ?`, ["InProgress", limit]);
    return rows.map(toRequest);
  }

  // ---- features
  async getFeature(featureId: string): Promise<FeatureRec | null> {
    const row = await this.one(`SELECT ${FEAT_COLS} FROM hoc_features WHERE id = ?`, [featureId]);
    return row ? toFeature(row) : null;
  }

  async insertFeature(f: FeatureRec): Promise<void> {
    await this.all(`INSERT INTO hoc_features (${FEAT_COLS}) VALUES (${marks(11)})`, [
      f.id, f.title, f.kind, f.path, f.slotId, f.mode, f.packageId, f.currentVersion, f.ownerUserId, f.requestId, f.createdAt,
    ]);
  }

  async updateFeature(featureId: string, fields: FeatureUpdate): Promise<void> {
    const { sql, values } = setClause(fields, FEAT_UPDATABLE);
    await this.all(`UPDATE hoc_features SET ${sql} WHERE id = ?`, [...values, featureId]);
  }

  async listVisibleFeatures(userId: string, path?: string | null): Promise<FeatureRec[]> {
    const cols = FEAT_COLS.split(",").map((c) => "f." + c.trim()).join(", ");
    let sql =
      `SELECT ${cols} FROM hoc_features f WHERE EXISTS ` +
      "(SELECT 1 FROM hoc_assignments a WHERE a.feature_id = f.id AND (a.everyone = 1 OR (a.everyone = 0 AND a.user_id = ?)))";
    const params: unknown[] = [userId];
    if (path !== undefined && path !== null) {
      sql += " AND f.path = ?";
      params.push(path);
    }
    sql += " ORDER BY f.created_at, f.id";
    return (await this.all(sql, params)).map(toFeature);
  }

  async getAssignments(featureIds: readonly string[]): Promise<Map<string, Assignment[]>> {
    const out = new Map<string, Assignment[]>(featureIds.map((id) => [id, []]));
    for (const chunk of chunks(featureIds)) {
      const rows = await this.all(`SELECT feature_id, everyone, user_id, seq FROM hoc_assignments WHERE feature_id IN (${marks(chunk.length)}) ORDER BY seq`, chunk);
      for (const r of rows) out.get(r.feature_id)?.push({ userId: Number(r.everyone) ? null : r.user_id, seq: Number(r.seq) });
    }
    return out;
  }

  async getUserState(featureIds: readonly string[], userId: string): Promise<Map<string, UserState>> {
    const out = new Map<string, UserState>(featureIds.map((id) => [id, { pinnedVersion: null, disabled: false }]));
    for (const chunk of chunks(featureIds)) {
      for (const r of await this.all(`SELECT feature_id, version FROM hoc_pins WHERE user_id = ? AND feature_id IN (${marks(chunk.length)})`, [userId, ...chunk])) {
        out.get(r.feature_id)!.pinnedVersion = r.version;
      }
      for (const r of await this.all(`SELECT feature_id FROM hoc_disabled WHERE user_id = ? AND feature_id IN (${marks(chunk.length)})`, [userId, ...chunk])) {
        out.get(r.feature_id)!.disabled = true;
      }
    }
    return out;
  }

  async addAssignment(featureId: string, userId: string | null, seq: number): Promise<void> {
    const [everyone, uid] = userId === null ? [1, ""] : [0, userId];
    if (await this.one("SELECT 1 AS x FROM hoc_assignments WHERE feature_id = ? AND everyone = ? AND user_id = ?", [featureId, everyone, uid])) return;
    await this.all("INSERT INTO hoc_assignments (feature_id, everyone, user_id, seq) VALUES (?, ?, ?, ?)", [featureId, everyone, uid, seq]);
  }

  async removeAssignment(featureId: string, userId: string | null): Promise<void> {
    const [everyone, uid] = userId === null ? [1, ""] : [0, userId];
    await this.all("DELETE FROM hoc_assignments WHERE feature_id = ? AND everyone = ? AND user_id = ?", [featureId, everyone, uid]);
    if (userId !== null) await this.setPin(featureId, userId, null);
  }

  async setPin(featureId: string, userId: string, version: string | null): Promise<void> {
    await this.all("DELETE FROM hoc_pins WHERE feature_id = ? AND user_id = ?", [featureId, userId]);
    if (version !== null) await this.all("INSERT INTO hoc_pins (feature_id, user_id, version) VALUES (?, ?, ?)", [featureId, userId, version]);
  }

  async setDisabled(featureId: string, userId: string, disabled: boolean): Promise<void> {
    await this.all("DELETE FROM hoc_disabled WHERE feature_id = ? AND user_id = ?", [featureId, userId]);
    if (disabled) await this.all("INSERT INTO hoc_disabled (feature_id, user_id) VALUES (?, ?)", [featureId, userId]);
  }

  // ---- versions
  async getVersion(featureId: string, version: string): Promise<VersionRec | null> {
    const row = await this.one(`SELECT ${VER_COLS} FROM hoc_versions WHERE feature_id = ? AND version = ?`, [featureId, version]);
    return row ? toVersion(row) : null;
  }

  async listVersions(featureId: string): Promise<VersionRec[]> {
    return (await this.all(`SELECT ${VER_COLS} FROM hoc_versions WHERE feature_id = ? ORDER BY seq DESC`, [featureId])).map(toVersion);
  }

  async upsertVersion(v: VersionRec): Promise<void> {
    await this.all("DELETE FROM hoc_versions WHERE feature_id = ? AND version = ?", [v.featureId, v.version]);
    await this.all(`INSERT INTO hoc_versions (${VER_COLS}) VALUES (${marks(7)})`, [v.featureId, v.version, v.publishedAt, v.requestId, v.sha256, v.entry, v.seq]);
  }
}
