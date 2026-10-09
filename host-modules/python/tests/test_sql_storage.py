import sqlite3
import threading

import pytest

from handofclient.storage import FeatureRec, RequestRec, SqlStorage, VersionRec
from handofclient.storage.sql import MYSQL, POSTGRES, SQLITE, detect_dialect


def rec(i="r1", user="alice", seq=1, status="InProgress"):
    return RequestRec(i, seq, user, "Alice", None, "text", status, None, None, None, "inject", None, None, "t", "t")


@pytest.fixture
def storage(tmp_path):
    s = SqlStorage.sqlite(str(tmp_path / "s.db"))
    s.migrate()
    return s


def test_migrate_is_idempotent_and_records_versions(storage):
    storage.migrate()
    storage.migrate()
    with storage.transaction() as tx:
        assert [r[0] for r in tx._all("SELECT version FROM hoc_migrations")] == [1]


def test_transaction_rolls_back_on_error(storage):
    with pytest.raises(RuntimeError):
        with storage.transaction(write=True) as tx:
            tx.insert_request(rec())
            raise RuntimeError("boom")
    with storage.transaction() as tx:
        assert tx.get_request("r1") is None


def test_sequence_is_strictly_increasing_across_transactions(storage):
    seen = []
    for _ in range(3):
        with storage.transaction(write=True) as tx:
            seen.append(tx.next_seq())
    assert seen == sorted(set(seen)) and len(seen) == 3


def test_record_event_deduplicates(storage):
    with storage.transaction(write=True) as tx:
        assert tx.record_event("e1", "t") is True
        assert tx.record_event("e1", "t") is False
    with storage.transaction(write=True) as tx:
        assert tx.record_event("e1", "t") is False
        assert tx.record_event("e2", "t") is True


def test_concurrent_duplicate_events_apply_once(storage):
    wins = []

    def go():
        with storage.transaction(write=True) as tx:
            wins.append(tx.record_event("same", "t"))

    threads = [threading.Thread(target=go) for _ in range(6)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert wins.count(True) == 1


def test_requests_paging_and_filters(storage):
    with storage.transaction(write=True) as tx:
        for i in range(5):
            tx.insert_request(rec(f"r{i}", "alice" if i % 2 == 0 else "bob", i, "Success" if i == 0 else "InProgress"))
    with storage.transaction() as tx:
        rows, more = tx.list_requests("alice", [], 2, 0)
        assert [r.id for r in rows] == ["r4", "r2"] and more
        rows, more = tx.list_requests("alice", [], 2, 2)
        assert [r.id for r in rows] == ["r0"] and not more
        assert [r.id for r in tx.list_requests(None, ["Success"], 10, 0)[0]] == ["r0"]
        assert [r.id for r in tx.list_unstarted_builds(10)] == ["r1", "r2", "r3", "r4"]


def test_update_rejects_unknown_columns(storage):
    with storage.transaction(write=True) as tx:
        tx.insert_request(rec())
        with pytest.raises(ValueError):
            tx.update_request("r1", **{"status = 'x', user_id": "evil"})
        with pytest.raises(ValueError):
            tx.update_request("r1")
        with pytest.raises(ValueError):
            tx.update_feature("f", owner_user_id="x")


def test_hostile_values_are_data_not_sql(storage):
    nasty = "x'); DROP TABLE hoc_requests; --"
    with storage.transaction(write=True) as tx:
        tx.insert_request(rec(nasty, nasty))
    with storage.transaction() as tx:
        assert tx.get_request(nasty).user_id == nasty


def test_feature_visibility_pins_and_disabled(storage):
    f = FeatureRec("f1", "t", "page-override", "/p", "main", "inject", "acme/f-f1", "1.0.0", "alice", "r1", "t")
    with storage.transaction(write=True) as tx:
        tx.insert_feature(f)
        tx.add_assignment("f1", "alice", tx.next_seq())
        tx.add_assignment("f1", "alice", tx.next_seq())  # idempotent
        tx.upsert_version(VersionRec("f1", "1.0.0", "t", "r1", "aa", "index.js", 1))
        tx.upsert_version(VersionRec("f1", "1.0.0", "t", "r1", "bb", "index.js", 2))  # replaces
        tx.set_pin("f1", "alice", "1.0.0")
        tx.set_disabled("f1", "alice", True)
    with storage.transaction(write=True) as tx:
        assert [x.id for x in tx.list_visible_features("alice")] == ["f1"]
        assert tx.list_visible_features("bob") == []
        assert tx.list_visible_features("alice", "/other") == []
        assert len(tx.get_assignments(["f1"])["f1"]) == 1
        assert tx.get_version("f1", "1.0.0").sha256 == "bb"
        st = tx.get_user_state(["f1"], "alice")["f1"]
        assert st.pinned_version == "1.0.0" and st.disabled
        assert tx.get_user_state(["f1"], "bob")["f1"].pinned_version is None
        tx.add_assignment("f1", None, tx.next_seq())
        assert [x.id for x in tx.list_visible_features("bob")] == ["f1"]
        tx.remove_assignment("f1", "alice")  # also clears alice's pin
        assert tx.get_user_state(["f1"], "alice")["f1"].pinned_version is None
        tx.remove_assignment("f1", None)
        assert tx.list_visible_features("bob") == []


def test_settings_round_trip(storage):
    with storage.transaction(write=True) as tx:
        assert tx.get_settings() is None
        tx.save_settings({"a": 1})
        tx.save_settings({"a": 2, "b": [1]})
    with storage.transaction() as tx:
        assert tx.get_settings() == {"a": 2, "b": [1]}


def test_dialect_translation_and_ddl():
    assert SQLITE.sql("SELECT ? , ?") == "SELECT ? , ?"
    assert POSTGRES.sql("SELECT ? , ?") == "SELECT %s , %s"
    assert MYSQL.sql("WHERE a = ?") == "WHERE a = %s"
    ddl = MYSQL.ddl("CREATE TABLE t (id {KEY} NOT NULL PRIMARY KEY, body {TEXT})")
    assert "utf8mb4_bin" in ddl and "LONGTEXT" in ddl and ddl.endswith("ENGINE=InnoDB DEFAULT CHARSET=utf8mb4")
    assert "VARCHAR(190)" in POSTGRES.ddl("CREATE TABLE t (id {KEY})")
    assert "{" not in MYSQL.ddl("CREATE TABLE t (a {KEY}, b {STR}, c {TEXT}, d {BIGINT}, e {SMALLINT})")


def test_dialect_detection():
    assert detect_dialect(sqlite3.connect(":memory:")) is SQLITE

    class Fake:
        pass

    with pytest.raises(ValueError):
        detect_dialect(Fake())
    Fake.__module__ = "psycopg.connection"
    assert detect_dialect(Fake()) is POSTGRES
    Fake.__module__ = "pymysql.connections"
    assert detect_dialect(Fake()) is MYSQL


def test_unknown_dialect_name_is_rejected():
    with pytest.raises(KeyError):
        SqlStorage(lambda: None, dialect="oracle")
