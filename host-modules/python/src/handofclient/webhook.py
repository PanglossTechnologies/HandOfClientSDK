"""Webhook signature check (see ``/webhook`` in openapi/site-hoc-api.yaml)."""
from __future__ import annotations

import hashlib
import hmac
import datetime as dt
from typing import Optional, Union

from .timeutil import parse_iso

SIGNATURE_HEADER = "x-handofclient-signature"
TOLERANCE_SECONDS = 300


def sign(secret: Union[str, bytes], raw_body: bytes) -> str:
    """``sha256=`` + lowercase hex HMAC-SHA256 of the raw body."""
    key = secret.encode("utf-8") if isinstance(secret, str) else secret
    return "sha256=" + hmac.new(key, raw_body, hashlib.sha256).hexdigest()


def verify_signature(secret: Union[str, bytes], raw_body: bytes, header: Optional[str]) -> bool:
    """Constant-time comparison of the ``X-HandOfClient-Signature`` header against the raw body."""
    if not header:
        return False
    return hmac.compare_digest(sign(secret, raw_body).encode("ascii"), header.encode("utf-8", "replace"))


def is_stale(sent_at: object, now: Optional[dt.datetime] = None) -> bool:
    """True when ``sentAt`` is unparsable or differs from now by more than the 300 s tolerance (either direction)."""
    t = parse_iso(sent_at)
    if t is None:
        return True
    now = now or dt.datetime.now(dt.timezone.utc)
    return abs((now - t).total_seconds()) > TOLERANCE_SECONDS
