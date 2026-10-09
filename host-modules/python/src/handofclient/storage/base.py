"""Storage interface the host module talks to.

Implement :class:`Storage` / :class:`StorageTx` to keep the data anywhere; ``SqlStorage`` (SQLite, PostgreSQL,
MySQL) is the ready-made one. All the rules (visibility, sharing, precedence) live in the host module, not
here: a storage is a dumb, transactional record keeper.
"""
from __future__ import annotations

import abc
from contextlib import AbstractContextManager
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


@dataclass
class RequestRec:
    id: str
    seq: int
    user_id: str
    user_name: Optional[str]
    user_email: Optional[str]
    text: str
    status: str
    message: Optional[str]
    feature_id: Optional[str]
    change_of: Optional[str]
    mode: str
    snapshot: Optional[str]  # JSON text
    build_id: Optional[str]
    created_at: str
    updated_at: str


@dataclass
class FeatureRec:
    id: str
    title: str
    kind: str
    path: Optional[str]
    slot_id: str
    mode: str
    package_id: str
    current_version: str
    owner_user_id: str
    request_id: Optional[str]
    created_at: str


@dataclass
class VersionRec:
    feature_id: str
    version: str
    published_at: str
    request_id: Optional[str]
    sha256: str
    entry: str
    seq: int


@dataclass
class Assignment:
    user_id: Optional[str]  # None = everyone
    seq: int


@dataclass
class UserState:
    pinned_version: Optional[str] = None
    disabled: bool = False


class StorageTx(abc.ABC):
    """One transaction. Obtained from :meth:`Storage.transaction`; committed when the ``with`` block ends cleanly."""

    # ---- counters / events / settings
    @abc.abstractmethod
    def next_seq(self) -> int:
        """A strictly increasing number (orders requests, versions and assignments)."""

    @abc.abstractmethod
    def record_event(self, event_id: str, received_at: str) -> bool:
        """Remember a webhook event id. False if it was already recorded."""

    @abc.abstractmethod
    def get_settings(self) -> Optional[Dict[str, Any]]: ...

    @abc.abstractmethod
    def save_settings(self, settings: Dict[str, Any]) -> None: ...

    # ---- requests
    @abc.abstractmethod
    def insert_request(self, r: RequestRec) -> None: ...

    @abc.abstractmethod
    def get_request(self, request_id: str) -> Optional[RequestRec]: ...

    @abc.abstractmethod
    def update_request(self, request_id: str, **fields: Any) -> None:
        """Update the named columns (``status``, ``message``, ``feature_id``, ``build_id``, ``updated_at``)."""

    @abc.abstractmethod
    def list_requests(self, user_id: Optional[str], statuses: Sequence[str], limit: int, offset: int) -> Tuple[List[RequestRec], bool]:
        """Newest first (by ``seq``). ``user_id`` None = everyone's. Returns (page, has_more)."""

    @abc.abstractmethod
    def list_unstarted_builds(self, limit: int) -> List[RequestRec]:
        """InProgress requests that never got a ``build_id``."""

    # ---- features
    @abc.abstractmethod
    def get_feature(self, feature_id: str) -> Optional[FeatureRec]: ...

    @abc.abstractmethod
    def insert_feature(self, f: FeatureRec) -> None: ...

    @abc.abstractmethod
    def update_feature(self, feature_id: str, **fields: Any) -> None:
        """Update the named columns (``current_version``, ``slot_id``, ``mode``)."""

    @abc.abstractmethod
    def list_visible_features(self, user_id: str, path: Optional[str] = None) -> List[FeatureRec]:
        """Features assigned to ``user_id`` or to everyone, optionally only those whose path equals ``path``."""

    @abc.abstractmethod
    def get_assignments(self, feature_ids: Iterable[str]) -> Dict[str, List[Assignment]]: ...

    @abc.abstractmethod
    def get_user_state(self, feature_ids: Iterable[str], user_id: str) -> Dict[str, UserState]: ...

    @abc.abstractmethod
    def add_assignment(self, feature_id: str, user_id: Optional[str], seq: int) -> None:
        """Idempotent: an existing assignment is left untouched."""

    @abc.abstractmethod
    def remove_assignment(self, feature_id: str, user_id: Optional[str]) -> None: ...

    @abc.abstractmethod
    def set_pin(self, feature_id: str, user_id: str, version: Optional[str]) -> None: ...

    @abc.abstractmethod
    def set_disabled(self, feature_id: str, user_id: str, disabled: bool) -> None: ...

    # ---- versions
    @abc.abstractmethod
    def get_version(self, feature_id: str, version: str) -> Optional[VersionRec]: ...

    @abc.abstractmethod
    def list_versions(self, feature_id: str) -> List[VersionRec]:
        """Newest first (by ``seq``)."""

    @abc.abstractmethod
    def upsert_version(self, v: VersionRec) -> None:
        """Insert, or replace the version with the same (feature, version)."""


class Storage(abc.ABC):
    @abc.abstractmethod
    def migrate(self) -> None:
        """Create / upgrade the schema. Idempotent and safe to call on every start."""

    @abc.abstractmethod
    def transaction(self, write: bool = False) -> "AbstractContextManager[StorageTx]":
        """A unit of work. ``write=True`` when it will change data."""
