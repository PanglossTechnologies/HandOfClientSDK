"""Timestamps: stored and sent as UTC ISO-8601 with milliseconds and a ``Z``, e.g. ``2026-10-09T18:00:05.123Z``."""
from __future__ import annotations

import datetime as dt
import re
from typing import Optional


def now_iso() -> str:
    t = dt.datetime.now(dt.timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (t.microsecond // 1000)


_ISO = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$",
    re.IGNORECASE,
)


def parse_iso(value: object) -> Optional[dt.datetime]:
    """Parse an ISO-8601 timestamp (any fraction length; no zone = UTC). None if it is not one."""
    if not isinstance(value, str):
        return None
    m = _ISO.match(value.strip())
    if not m:
        return None
    y, mo, d, h, mi, s, frac, zone = m.groups()
    micro = int((frac or "0")[:6].ljust(6, "0"))
    if zone and zone.upper() != "Z":
        sign = 1 if zone[0] == "+" else -1
        digits = zone[1:].replace(":", "")
        tz = dt.timezone(sign * dt.timedelta(hours=int(digits[:2]), minutes=int(digits[2:])))
    else:
        tz = dt.timezone.utc
    try:
        return dt.datetime(int(y), int(mo), int(d), int(h), int(mi), int(s), micro, tzinfo=tz)
    except ValueError:
        return None
