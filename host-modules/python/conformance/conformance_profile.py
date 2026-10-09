"""The conformance profile (see host-modules/conformance/README.md): fixed roster, cookie identity, fixed keys.
Test configuration only - nothing here is for production."""
from __future__ import annotations

import os
from typing import Any, Dict, Iterable, Optional

from handofclient import HostModule, PlatformClient, SqlStorage

COOKIE = "hoc_user"
ROSTER: Dict[str, Dict[str, Any]] = {
    "admin": {"id": "admin", "name": "Ada Admin"},
    "alice": {"id": "alice", "name": "Alice Owner"},
    "bob": {"id": "bob", "name": "Bob Builder"},
    "carol": {"id": "carol", "name": "Carol Customer"},
    "dave": {"id": "dave", "name": "Dave Dev"},
    "erin+qa@example.com": {"id": "erin+qa@example.com", "name": "Erin Special"},
}


def user_from_cookie(value: Optional[str]) -> Optional[Dict[str, Any]]:
    return ROSTER.get(value) if value else None


def is_admin(user: Dict[str, Any]) -> bool:
    return user["id"] == "admin"


def find_users(query: str) -> Iterable[Dict[str, Any]]:
    q = query.lower()
    return [u for u in ROSTER.values() if q in u["id"].lower() or q in u["name"].lower()]


def user_exists(user_id: str) -> bool:
    return user_id in ROSTER


def env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def make_storage() -> SqlStorage:
    """SQLite file by default; ``HOC_CONFORMANCE_DATABASE_URL=postgresql://...`` or ``mysql://...`` for the others."""
    url = os.environ.get("HOC_CONFORMANCE_DATABASE_URL")
    if not url:
        return SqlStorage.sqlite(env("HOC_CONFORMANCE_DB", "conformance.db"))
    from urllib.parse import unquote, urlparse

    u = urlparse(url)
    if u.scheme.startswith("postgres"):
        import psycopg

        return SqlStorage(lambda: psycopg.connect(url))
    if u.scheme.startswith("mysql"):
        import pymysql

        return SqlStorage(
            lambda: pymysql.connect(host=u.hostname, port=u.port or 3306, user=unquote(u.username or ""), password=unquote(u.password or ""), database=u.path.lstrip("/"), charset="utf8mb4"),
            "mysql",
        )
    raise ValueError(f"unsupported HOC_CONFORMANCE_DATABASE_URL scheme {u.scheme}")


def build_module(get_current_user: Any, *, explicit_user_exists: bool = True, storage: Optional[SqlStorage] = None) -> HostModule:
    storage = storage or make_storage()
    return HostModule(
        storage=storage,
        platform=PlatformClient(
            f"http://127.0.0.1:{env('HOC_CONFORMANCE_PLATFORM_PORT', '4010')}",
            env("HOC_CONFORMANCE_API_KEY", "conformance-host-api-key"),
            env("HOC_CONFORMANCE_TENANT_ID", "conformance-tenant"),
        ),
        webhook_secret=env("HOC_CONFORMANCE_WEBHOOK_SECRET", "whsec_conformance"),
        get_current_user=get_current_user,
        is_admin=is_admin,
        find_users=find_users,
        user_exists=user_exists if explicit_user_exists else None,
    )
