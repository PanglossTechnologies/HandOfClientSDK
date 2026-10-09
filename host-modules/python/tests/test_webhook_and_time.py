import datetime as dt

import pytest

from handofclient.timeutil import now_iso, parse_iso
from handofclient.users import to_user
from handofclient.webhook import is_stale, sign, verify_signature

# Test vector from openapi/site-hoc-api.yaml (/webhook)
VECTOR_SECRET = "whsec_example_secret"
VECTOR_BODY = b'{"type":"build.status","eventId":"evt_01","sentAt":"2026-10-09T18:00:05Z","buildId":"3f2a9c1e5b7d4a8e9c0d1f2a3b4c5d6e","requestRef":"req-123","status":"NeedsInfo","message":"Which date range?"}'
VECTOR_SIG = "sha256=33ea1034e3f86ff21fcb3036c05139790b60080144bbea0115540e05ee72f052"


def test_signature_matches_published_test_vector():
    assert sign(VECTOR_SECRET, VECTOR_BODY) == VECTOR_SIG
    assert verify_signature(VECTOR_SECRET, VECTOR_BODY, VECTOR_SIG)


@pytest.mark.parametrize("header", [None, "", "sha256=", "sha256=00", VECTOR_SIG.upper(), VECTOR_SIG[7:], VECTOR_SIG + "0", "sha1=" + VECTOR_SIG[7:]])
def test_wrong_or_missing_signature_is_rejected(header):
    assert not verify_signature(VECTOR_SECRET, VECTOR_BODY, header)


def test_signature_covers_every_byte_and_the_secret():
    assert not verify_signature(VECTOR_SECRET, VECTOR_BODY + b" ", VECTOR_SIG)
    assert not verify_signature("whsec_other", VECTOR_BODY, VECTOR_SIG)


def test_staleness_window_is_300_seconds_either_way():
    now = dt.datetime(2026, 10, 9, 18, 0, 0, tzinfo=dt.timezone.utc)
    assert not is_stale("2026-10-09T18:00:00Z", now)
    assert not is_stale("2026-10-09T17:55:01Z", now)
    assert is_stale("2026-10-09T17:54:59Z", now)
    assert not is_stale("2026-10-09T18:04:59Z", now)
    assert is_stale("2026-10-09T18:05:01Z", now)


@pytest.mark.parametrize("value", [None, 5, "", "yesterday", "2026-13-01T00:00:00Z", "2026-10-09"])
def test_unparsable_sent_at_counts_as_stale(value):
    assert is_stale(value)


@pytest.mark.parametrize(
    "value,expected",
    [
        ("2026-10-09T18:00:05Z", dt.datetime(2026, 10, 9, 18, 0, 5, tzinfo=dt.timezone.utc)),
        ("2026-10-09T18:00:05.123Z", dt.datetime(2026, 10, 9, 18, 0, 5, 123000, tzinfo=dt.timezone.utc)),
        ("2026-10-09T18:00:05.1234567Z", dt.datetime(2026, 10, 9, 18, 0, 5, 123456, tzinfo=dt.timezone.utc)),  # 7 digits, as .NET writes
        ("2026-10-09T20:00:05+02:00", dt.datetime(2026, 10, 9, 18, 0, 5, tzinfo=dt.timezone.utc)),
        ("2026-10-09T18:00:05", dt.datetime(2026, 10, 9, 18, 0, 5, tzinfo=dt.timezone.utc)),
    ],
)
def test_parse_iso_variants(value, expected):
    assert parse_iso(value) == expected


def test_now_iso_round_trips():
    assert parse_iso(now_iso()) is not None
    assert now_iso().endswith("Z")


def test_user_normalisation():
    class U:
        id = 42
        name = "Pat"
        email = None

    u = to_user(U())
    assert (u.id, u.name, u.email) == ("42", "Pat", None)
    assert to_user({"id": "x", "name": ""}).name is None
    assert to_user(None) is None and to_user({}) is None and to_user({"id": ""}) is None and to_user(False) is None
