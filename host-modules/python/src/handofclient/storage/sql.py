"""SQL storage over any DB-API 2.0 driver: SQLite (``sqlite3``), PostgreSQL (``psycopg`` 3 / ``psycopg2``) and MySQL
(``pymysql`` / ``mysqlclient`` / ``mysql-connector``).

You give it a function that opens a connection; it opens one per transaction and closes it afterwards (hand it a
pool's checkout function if you have one - the returned object only needs ``cursor/commit/rollback/close``)::

    storage = SqlStorage.sqlite("hoc.db")
    storage = SqlStorage(lambda: psycopg.connect(DSN))        # dialect detected from the driver
    storage = SqlStorage(lambda: pymysql.connect(**MYSQL), dialect="mysql")

Tables are prefixed ``hoc_`` and created / upgraded by :meth:`SqlStorage.migrate`.
"""
from __future__ import annotations

import json
import logging
import sqlite3
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional, Sequence, Tuple

from ..timeutil import now_iso
from .base import Assignment, FeatureRec, RequestRec, Storage, StorageTx, UserState, VersionRec

log = logging.getLogger("handofclient.storage")


# --------------------------------------------------------------------------------------- dialects
@dataclass(frozen=True)
class Dialect:
    name: str
    key: str  # short indexed identifier column
    str_: str  # medium string
    text: str  # large text
    bigint: str
    smallint: str
    table_suffix: str = ""

    def sql(self, q: str) -> str:
        """Our SQL uses ``?`` placeholders; PostgreSQL and MySQL drivers want ``%s``."""
        return q if self.name == "sqlite" else q.replace("?", "%s")

    def ddl(self, q: str) -> str:
        return q.format(KEY=self.key, STR=self.str_, TEXT=self.text, BIGINT=self.bigint, SMALLINT=self.smallint) + self.table_suffix


SQLITE = Dialect("sqlite", key="TEXT", str_="TEXT", text="TEXT", bigint="INTEGER", smallint="INTEGER")
POSTGRES = Dialect("postgres", key="VARCHAR(190)", str_="VARCHAR(1024)", text="TEXT", bigint="BIGINT", smallint="SMALLINT")
# utf8mb4_bin: ids are case-sensitive, as they are in SQLite and PostgreSQL.
MYSQL = Dialect(
    "mysql",
    key="VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin",
    str_="VARCHAR(1024)",
    text="LONGTEXT",
    bigint="BIGINT",
    smallint="SMALLINT",
    table_suffix=" ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
)
DIALECTS = {"sqlite": SQLITE, "postgres": POSTGRES, "postgresql": POSTGRES, "mysql": MYSQL, "mariadb": MYSQL}


def detect_dialect(conn: Any) -> Dialect:
    module = type(conn).__module__.lower()
    if module.startswith("sqlite3"):
        return SQLITE
    if module.startswith(("psycopg", "pg8000")):
        return POSTGRES
    if module.startswith(("pymysql", "mysql", "mariadb", "mysqldb", "_mysql")):
        return MYSQL
    raise ValueError(
        f"Cannot tell which SQL dialect the {type(conn).__module__}.{type(conn).__name__} connection speaks; "
        "pass dialect='sqlite' | 'postgres' | 'mysql' to SqlStorage."
    )


def is_integrity_error(exc: BaseException) -> bool:
    return any(c.__name__ == "IntegrityError" for c in type(exc).__mro__)


# --------------------------------------------------------------------------------------- migrations
class MigrationContext:
    """What a migration step may do: run DDL (``{KEY}``-style type placeholders), create an index, run SQL."""

    def __init__(self, cur: Any, dialect: Dialect) -> None:
        self.cur = cur
        self.dialect = dialect

    def ddl(self, stmt: str) -> None:
        self.cur.execute(self.dialect.ddl(stmt))

    def execute(self, sql: str, params: Sequence[Any] = ()) -> None:
        self.cur.execute(self.dialect.sql(sql), tuple(params))

    def fetchone(self, sql: str, params: Sequence[Any] = ()) -> Optional[Tuple[Any, ...]]:
        self.execute(sql, params)
        return self.cur.fetchone()

    def index(self, table: str, name: str, cols: str) -> None:
        if self.dialect.name == "mysql":  # no CREATE INDEX IF NOT EXISTS
            row = self.fetchone(
                "SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?",
                (table, name),
            )
            if row and row[0]:
                return
            self.cur.execute(f"CREATE INDEX {name} ON {table} ({cols})")
        else:
            self.cur.execute(f"CREATE INDEX IF NOT EXISTS {name} ON {table} ({cols})")


def _migration_1(ctx: MigrationContext) -> None:
    for stmt in (
        "CREATE TABLE IF NOT EXISTS hoc_settings (name {KEY} NOT NULL PRIMARY KEY, value {TEXT} NOT NULL)",
        "CREATE TABLE IF NOT EXISTS hoc_counters (name {KEY} NOT NULL PRIMARY KEY, value {BIGINT} NOT NULL)",
        "CREATE TABLE IF NOT EXISTS hoc_events (event_id {KEY} NOT NULL PRIMARY KEY, received_at {KEY} NOT NULL)",
        """CREATE TABLE IF NOT EXISTS hoc_requests (
            id {KEY} NOT NULL PRIMARY KEY, seq {BIGINT} NOT NULL, user_id {KEY} NOT NULL, user_name {STR} NULL, user_email {STR} NULL,
            text {TEXT} NOT NULL, status {KEY} NOT NULL, message {TEXT} NULL, feature_id {KEY} NULL, change_of {KEY} NULL,
            mode {KEY} NOT NULL, snapshot {TEXT} NULL, build_id {KEY} NULL, created_at {KEY} NOT NULL, updated_at {KEY} NOT NULL)""",
        """CREATE TABLE IF NOT EXISTS hoc_features (
            id {KEY} NOT NULL PRIMARY KEY, title {STR} NOT NULL, kind {KEY} NOT NULL, path {STR} NULL, slot_id {KEY} NOT NULL,
            mode {KEY} NOT NULL, package_id {STR} NOT NULL, current_version {KEY} NOT NULL, owner_user_id {KEY} NOT NULL,
            request_id {KEY} NULL, created_at {KEY} NOT NULL)""",
        """CREATE TABLE IF NOT EXISTS hoc_versions (
            feature_id {KEY} NOT NULL, version {KEY} NOT NULL, published_at {KEY} NOT NULL, request_id {KEY} NULL,
            sha256 {KEY} NOT NULL, entry {STR} NOT NULL, seq {BIGINT} NOT NULL, PRIMARY KEY (feature_id, version))""",
        """CREATE TABLE IF NOT EXISTS hoc_assignments (
            feature_id {KEY} NOT NULL, everyone {SMALLINT} NOT NULL, user_id {KEY} NOT NULL, seq {BIGINT} NOT NULL,
            PRIMARY KEY (feature_id, everyone, user_id))""",
        """CREATE TABLE IF NOT EXISTS hoc_pins (
            feature_id {KEY} NOT NULL, user_id {KEY} NOT NULL, version {KEY} NOT NULL, PRIMARY KEY (feature_id, user_id))""",
        """CREATE TABLE IF NOT EXISTS hoc_disabled (
            feature_id {KEY} NOT NULL, user_id {KEY} NOT NULL, PRIMARY KEY (feature_id, user_id))""",
    ):
        ctx.ddl(stmt)
    ctx.index("hoc_requests", "hoc_requests_user_seq", "user_id, seq")
    ctx.index("hoc_requests", "hoc_requests_seq", "seq")
    ctx.index("hoc_assignments", "hoc_assignments_user", "user_id, feature_id")
    ctx.index("hoc_pins", "hoc_pins_user", "user_id")
    if not ctx.fetchone("SELECT 1 FROM hoc_counters WHERE name = ?", ("seq",)):
        ctx.execute("INSERT INTO hoc_counters (name, value) VALUES (?, ?)", ("seq", 0))


# (version, description, function). Append only; never edit a shipped migration.
MIGRATIONS: List[Tuple[int, str, Callable[[MigrationContext], None]]] = [(1, "initial schema", _migration_1)]


# --------------------------------------------------------------------------------------- storage
class SqlStorage(Storage):
    def __init__(self, connect: Callable[[], Any], dialect: Optional[str] = None) -> None:
        self._connect = connect
        self._dialect: Optional[Dialect] = DIALECTS[dialect.lower()] if dialect else None
        self._lock = threading.Lock()

    @classmethod
    def sqlite(cls, path: str, timeout: float = 30.0) -> "SqlStorage":
        def connect() -> sqlite3.Connection:
            # isolation_level=None: we issue BEGIN ourselves (IMMEDIATE for writers, so they queue instead of deadlocking).
            c = sqlite3.connect(path, timeout=timeout, isolation_level=None)
            c.execute("PRAGMA busy_timeout = %d" % int(timeout * 1000))
            return c

        return cls(connect, "sqlite")

    def _open(self) -> Tuple[Any, Dialect]:
        conn = self._connect()
        if self._dialect is None:
            with self._lock:
                if self._dialect is None:
                    self._dialect = detect_dialect(conn)
        return conn, self._dialect

    @contextmanager
    def transaction(self, write: bool = False) -> Iterator["SqlTx"]:
        conn, dialect = self._open()
        cur = conn.cursor()
        sqlite_mode = dialect.name == "sqlite"
        try:
            if sqlite_mode:
                cur.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            yield SqlTx(cur, dialect)
            if sqlite_mode:
                cur.execute("COMMIT")
            else:
                conn.commit()
        except BaseException:
            try:
                if sqlite_mode:
                    cur.execute("ROLLBACK")
                else:
                    conn.rollback()
            except Exception:  # noqa: BLE001 - the original error is the one worth reporting
                log.exception("rollback failed")
            raise
        finally:
            try:
                cur.close()
            finally:
                conn.close()

    def migrate(self) -> None:
        conn, dialect = self._open()
        cur = conn.cursor()
        sqlite_mode = dialect.name == "sqlite"
        ctx = MigrationContext(cur, dialect)

        def commit() -> None:
            if not sqlite_mode:
                conn.commit()

        try:
            if sqlite_mode:
                cur.execute("PRAGMA journal_mode = WAL")
            ctx.ddl("CREATE TABLE IF NOT EXISTS hoc_migrations (version {BIGINT} NOT NULL PRIMARY KEY, name {STR} NOT NULL, applied_at {KEY} NOT NULL)")
            commit()
            cur.execute("SELECT version FROM hoc_migrations")
            applied = {int(r[0]) for r in cur.fetchall()}
            commit()
            for version, name, fn in MIGRATIONS:
                if version in applied:
                    continue
                log.info("handofclient: applying migration %s (%s)", version, name)
                fn(ctx)  # every step is idempotent, so two processes migrating at once cannot hurt
                try:
                    ctx.execute("INSERT INTO hoc_migrations (version, name, applied_at) VALUES (?, ?, ?)", (version, name, now_iso()))
                except Exception as e:  # noqa: BLE001
                    if not is_integrity_error(e):
                        raise
                    if not sqlite_mode:
                        conn.rollback()
                commit()
        except BaseException:
            try:
                if not sqlite_mode:
                    conn.rollback()
            except Exception:  # noqa: BLE001
                log.exception("rollback failed")
            raise
        finally:
            try:
                cur.close()
            finally:
                conn.close()


_REQ_COLS = "id, seq, user_id, user_name, user_email, text, status, message, feature_id, change_of, mode, snapshot, build_id, created_at, updated_at"
_FEAT_COLS = "id, title, kind, path, slot_id, mode, package_id, current_version, owner_user_id, request_id, created_at"
_VER_COLS = "feature_id, version, published_at, request_id, sha256, entry, seq"
_REQ_UPDATABLE = {"status", "message", "feature_id", "build_id", "updated_at"}
_FEAT_UPDATABLE = {"current_version", "slot_id", "mode"}
_CHUNK = 400


def _chunks(items: Sequence[str]) -> Iterator[Sequence[str]]:
    for i in range(0, len(items), _CHUNK):
        yield items[i : i + _CHUNK]


class SqlTx(StorageTx):
    def __init__(self, cur: Any, dialect: Dialect) -> None:
        self._cur = cur
        self._d = dialect

    def _exec(self, sql: str, params: Sequence[Any] = ()) -> Any:
        self._cur.execute(self._d.sql(sql), tuple(params))
        return self._cur

    def _all(self, sql: str, params: Sequence[Any] = ()) -> List[Tuple[Any, ...]]:
        return list(self._exec(sql, params).fetchall())

    def _one(self, sql: str, params: Sequence[Any] = ()) -> Optional[Tuple[Any, ...]]:
        return self._exec(sql, params).fetchone()

    # ---- counters / events / settings
    def next_seq(self) -> int:
        self._exec("UPDATE hoc_counters SET value = value + 1 WHERE name = ?", ("seq",))
        row = self._one("SELECT value FROM hoc_counters WHERE name = ?", ("seq",))
        if row is None:
            raise RuntimeError("hoc_counters is missing its 'seq' row; run SqlStorage.migrate()")
        return int(row[0])

    def record_event(self, event_id: str, received_at: str) -> bool:
        if self._one("SELECT 1 FROM hoc_events WHERE event_id = ?", (event_id,)):
            return False
        try:
            self._exec("INSERT INTO hoc_events (event_id, received_at) VALUES (?, ?)", (event_id, received_at))
        except Exception as e:  # noqa: BLE001
            if is_integrity_error(e):
                return False  # concurrent duplicate; the caller abandons this transaction
            raise
        return True

    def get_settings(self) -> Optional[Dict[str, Any]]:
        row = self._one("SELECT value FROM hoc_settings WHERE name = ?", ("settings",))
        return json.loads(row[0]) if row else None

    def save_settings(self, settings: Dict[str, Any]) -> None:
        self._exec("DELETE FROM hoc_settings WHERE name = ?", ("settings",))
        self._exec("INSERT INTO hoc_settings (name, value) VALUES (?, ?)", ("settings", json.dumps(settings, separators=(",", ":"))))

    # ---- requests
    @staticmethod
    def _req(r: Tuple[Any, ...]) -> RequestRec:
        return RequestRec(r[0], int(r[1]), *r[2:])

    def insert_request(self, r: RequestRec) -> None:
        self._exec(
            f"INSERT INTO hoc_requests ({_REQ_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (r.id, r.seq, r.user_id, r.user_name, r.user_email, r.text, r.status, r.message, r.feature_id, r.change_of, r.mode, r.snapshot, r.build_id, r.created_at, r.updated_at),
        )

    def get_request(self, request_id: str) -> Optional[RequestRec]:
        row = self._one(f"SELECT {_REQ_COLS} FROM hoc_requests WHERE id = ?", (request_id,))
        return self._req(row) if row else None

    def update_request(self, request_id: str, **fields: Any) -> None:
        bad = set(fields) - _REQ_UPDATABLE
        if bad or not fields:
            raise ValueError(f"cannot update request columns {sorted(bad) or '(none given)'}")
        sets = ", ".join(f"{k} = ?" for k in fields)
        self._exec(f"UPDATE hoc_requests SET {sets} WHERE id = ?", (*fields.values(), request_id))

    def list_requests(self, user_id: Optional[str], statuses: Sequence[str], limit: int, offset: int) -> Tuple[List[RequestRec], bool]:
        where: List[str] = []
        params: List[Any] = []
        if user_id is not None:
            where.append("user_id = ?")
            params.append(user_id)
        if statuses:
            where.append("status IN (%s)" % ", ".join("?" * len(statuses)))
            params.extend(statuses)
        clause = (" WHERE " + " AND ".join(where)) if where else ""
        rows = self._all(f"SELECT {_REQ_COLS} FROM hoc_requests{clause} ORDER BY seq DESC LIMIT ? OFFSET ?", (*params, limit + 1, offset))
        return [self._req(r) for r in rows[:limit]], len(rows) > limit

    def list_unstarted_builds(self, limit: int) -> List[RequestRec]:
        rows = self._all(f"SELECT {_REQ_COLS} FROM hoc_requests WHERE build_id IS NULL AND status = ? ORDER BY seq LIMIT ?", ("InProgress", limit))
        return [self._req(r) for r in rows]

    # ---- features
    @staticmethod
    def _feat(r: Tuple[Any, ...]) -> FeatureRec:
        return FeatureRec(*r)

    def get_feature(self, feature_id: str) -> Optional[FeatureRec]:
        row = self._one(f"SELECT {_FEAT_COLS} FROM hoc_features WHERE id = ?", (feature_id,))
        return self._feat(row) if row else None

    def insert_feature(self, f: FeatureRec) -> None:
        self._exec(
            f"INSERT INTO hoc_features ({_FEAT_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (f.id, f.title, f.kind, f.path, f.slot_id, f.mode, f.package_id, f.current_version, f.owner_user_id, f.request_id, f.created_at),
        )

    def update_feature(self, feature_id: str, **fields: Any) -> None:
        bad = set(fields) - _FEAT_UPDATABLE
        if bad or not fields:
            raise ValueError(f"cannot update feature columns {sorted(bad) or '(none given)'}")
        sets = ", ".join(f"{k} = ?" for k in fields)
        self._exec(f"UPDATE hoc_features SET {sets} WHERE id = ?", (*fields.values(), feature_id))

    def list_visible_features(self, user_id: str, path: Optional[str] = None) -> List[FeatureRec]:
        cols = ", ".join("f." + c.strip() for c in _FEAT_COLS.split(","))
        sql = (
            f"SELECT {cols} FROM hoc_features f WHERE EXISTS "
            "(SELECT 1 FROM hoc_assignments a WHERE a.feature_id = f.id AND (a.everyone = 1 OR (a.everyone = 0 AND a.user_id = ?)))"
        )
        params: List[Any] = [user_id]
        if path is not None:
            sql += " AND f.path = ?"
            params.append(path)
        sql += " ORDER BY f.created_at, f.id"
        return [self._feat(r) for r in self._all(sql, params)]

    def get_assignments(self, feature_ids: Iterable[str]) -> Dict[str, List[Assignment]]:
        ids = list(feature_ids)
        out: Dict[str, List[Assignment]] = {i: [] for i in ids}
        for chunk in _chunks(ids):
            marks = ", ".join("?" * len(chunk))
            for fid, everyone, uid, seq in self._all(f"SELECT feature_id, everyone, user_id, seq FROM hoc_assignments WHERE feature_id IN ({marks}) ORDER BY seq", chunk):
                out[fid].append(Assignment(None if everyone else uid, int(seq)))
        return out

    def get_user_state(self, feature_ids: Iterable[str], user_id: str) -> Dict[str, UserState]:
        ids = list(feature_ids)
        out: Dict[str, UserState] = {i: UserState() for i in ids}
        for chunk in _chunks(ids):
            marks = ", ".join("?" * len(chunk))
            for fid, version in self._all(f"SELECT feature_id, version FROM hoc_pins WHERE user_id = ? AND feature_id IN ({marks})", (user_id, *chunk)):
                out[fid].pinned_version = version
            for (fid,) in self._all(f"SELECT feature_id FROM hoc_disabled WHERE user_id = ? AND feature_id IN ({marks})", (user_id, *chunk)):
                out[fid].disabled = True
        return out

    def add_assignment(self, feature_id: str, user_id: Optional[str], seq: int) -> None:
        everyone, uid = (1, "") if user_id is None else (0, user_id)
        if self._one("SELECT 1 FROM hoc_assignments WHERE feature_id = ? AND everyone = ? AND user_id = ?", (feature_id, everyone, uid)):
            return
        self._exec("INSERT INTO hoc_assignments (feature_id, everyone, user_id, seq) VALUES (?, ?, ?, ?)", (feature_id, everyone, uid, seq))

    def remove_assignment(self, feature_id: str, user_id: Optional[str]) -> None:
        everyone, uid = (1, "") if user_id is None else (0, user_id)
        self._exec("DELETE FROM hoc_assignments WHERE feature_id = ? AND everyone = ? AND user_id = ?", (feature_id, everyone, uid))
        if user_id is not None:
            self.set_pin(feature_id, user_id, None)

    def set_pin(self, feature_id: str, user_id: str, version: Optional[str]) -> None:
        self._exec("DELETE FROM hoc_pins WHERE feature_id = ? AND user_id = ?", (feature_id, user_id))
        if version is not None:
            self._exec("INSERT INTO hoc_pins (feature_id, user_id, version) VALUES (?, ?, ?)", (feature_id, user_id, version))

    def set_disabled(self, feature_id: str, user_id: str, disabled: bool) -> None:
        self._exec("DELETE FROM hoc_disabled WHERE feature_id = ? AND user_id = ?", (feature_id, user_id))
        if disabled:
            self._exec("INSERT INTO hoc_disabled (feature_id, user_id) VALUES (?, ?)", (feature_id, user_id))

    # ---- versions
    @staticmethod
    def _ver(r: Tuple[Any, ...]) -> VersionRec:
        return VersionRec(r[0], r[1], r[2], r[3], r[4], r[5], int(r[6]))

    def get_version(self, feature_id: str, version: str) -> Optional[VersionRec]:
        row = self._one(f"SELECT {_VER_COLS} FROM hoc_versions WHERE feature_id = ? AND version = ?", (feature_id, version))
        return self._ver(row) if row else None

    def list_versions(self, feature_id: str) -> List[VersionRec]:
        return [self._ver(r) for r in self._all(f"SELECT {_VER_COLS} FROM hoc_versions WHERE feature_id = ? ORDER BY seq DESC", (feature_id,))]

    def upsert_version(self, v: VersionRec) -> None:
        self._exec("DELETE FROM hoc_versions WHERE feature_id = ? AND version = ?", (v.feature_id, v.version))
        self._exec(
            f"INSERT INTO hoc_versions ({_VER_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (v.feature_id, v.version, v.published_at, v.request_id, v.sha256, v.entry, v.seq),
        )
