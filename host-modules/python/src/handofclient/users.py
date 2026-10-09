"""The site's user, as the host module sees it."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional


@dataclass
class HocUser:
    """Normalised view of whatever ``get_current_user`` returned. ``raw`` is the site's own object."""

    id: str
    name: Optional[str] = None
    email: Optional[str] = None
    raw: Any = None


def _field(obj: Any, name: str) -> Any:
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def to_user(obj: Any) -> Optional[HocUser]:
    """Accept a dict or an object with ``id`` (and optionally ``name`` / ``email``). None / no id means signed out."""
    if obj is None or obj is False:
        return None
    uid = _field(obj, "id")
    if uid is None or str(uid) == "":
        return None
    name = _field(obj, "name")
    email = _field(obj, "email")
    return HocUser(
        id=str(uid),
        name=str(name) if name not in (None, "") else None,
        email=str(email) if email not in (None, "") else None,
        raw=obj,
    )
