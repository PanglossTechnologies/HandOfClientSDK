"""The host module proper: every ``hoc/token``, ``hoc/api/*`` and ``hoc/webhook`` call, independent of web framework.

Adapters (``handofclient.adapters.flask`` / ``.django`` / ``.fastapi``) translate their framework's request into
:meth:`HostModule.handle` and its :class:`HocResponse` back. Contract: ``openapi/site-hoc-api.yaml``.
"""
from __future__ import annotations

import base64
import json
import logging
import re
import secrets
import threading
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from .errors import HocError, forbidden, invalid, not_found, platform_unavailable, unauthenticated
from .platform_client import PlatformClient
from .storage import Assignment, FeatureRec, RequestRec, Storage, StorageTx, UserState, VersionRec
from .timeutil import now_iso
from .users import HocUser, to_user
from .webhook import SIGNATURE_HEADER, is_stale, verify_signature

log = logging.getLogger("handofclient")

POLICIES = ("owner", "admins", "nobody")
STATUSES = ("InProgress", "NeedsInfo", "Rejected", "Success")
KINDS = ("slot", "page-override", "new-page")
MODES = ("inject", "iframe")
TEXT_MAX = 20000
SNAPSHOT_MAX = 2 * 1024 * 1024
DEFAULT_SETTINGS: Dict[str, Any] = {
    "renderingMode": "inject",
    "shareWithNamedUsers": "owner",
    "shareWithEveryone": "admins",
    "viewAllRequests": "admins",
    "dataSources": [],
}
_SECRET_NAME = re.compile(r"^[a-z0-9_-]{1,64}$")
_UNSET: Any = object()
BUILD_RETRY_DELAYS = (1.0, 2.0, 5.0, 15.0, 60.0, 300.0)


#: Sent with every response: JSON, and never cached (answers depend on the signed-in user).
RESPONSE_HEADERS = {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"}


@dataclass
class HocResponse:
    status: int
    payload: Any = None

    def body(self) -> bytes:
        return b"" if self.payload is None else json.dumps(self.payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


@dataclass
class _Call:
    user: HocUser
    query: Mapping[str, Sequence[str]]
    body: Any
    params: Tuple[str, ...]
    admin: Optional[bool] = None


@dataclass
class _Loaded:
    feature: FeatureRec
    assignments: List[Assignment]
    state: UserState


def _field(obj: Any, name: str) -> Any:
    return obj.get(name) if isinstance(obj, dict) else getattr(obj, name, None)


class HostModule:
    """Framework-neutral host module.

    :param storage: where requests, features, versions and settings live (e.g. ``SqlStorage.sqlite("hoc.db")``).
    :param platform: the :class:`PlatformClient` for your tenant.
    :param webhook_secret: the host's webhook secret (verifies ``hoc/webhook``).
    :param get_current_user: ``f(request) -> user | None``. ``user`` is a dict or object with ``id`` and optionally
        ``name`` / ``email``; None means signed out. ``request`` is the web framework's own request object.
    :param is_admin: ``f(user) -> bool``, given what ``get_current_user`` returned.
    :param find_users: ``f(query: str) -> iterable of {id, name?}``; backs the share picker.
    :param user_exists: optional ``f(user_id) -> bool`` used to reject unknown ids when sharing. Without it the
        module asks ``find_users`` for the id and wants an exact match.
    :param legacy_package_id, legacy_slot_id: only for ``GET token`` without ``featureId`` (the original
        single-plugin endpoint): the package and slot to mint for, with the tenant's activated version.
    :param auto_migrate: run ``storage.migrate()`` once, on first use.
    :param retry_builds: retry (in background threads) builds the platform could not take at submit time.
    """

    def __init__(
        self,
        *,
        storage: Storage,
        platform: PlatformClient,
        webhook_secret: str,
        get_current_user: Callable[[Any], Any],
        is_admin: Callable[[Any], Any],
        find_users: Callable[[str], Optional[Iterable[Any]]],
        user_exists: Optional[Callable[[str], Any]] = None,
        legacy_package_id: Optional[str] = None,
        legacy_slot_id: Optional[str] = None,
        auto_migrate: bool = True,
        retry_builds: bool = True,
    ) -> None:
        if not webhook_secret:
            raise ValueError("webhook_secret is required")
        self.storage = storage
        self.platform = platform
        self._secret = webhook_secret
        self._get_current_user = self.get_current_user = get_current_user
        self._is_admin = is_admin
        self._find_users = find_users
        self._user_exists = user_exists
        self._legacy = (legacy_package_id, legacy_slot_id)
        self._auto_migrate = auto_migrate
        self._retry_builds = retry_builds
        self._migrated = False
        self._migrate_lock = threading.Lock()
        self._routes: List[Tuple[str, "re.Pattern[str]", Callable[[_Call], HocResponse], bool]] = []
        self._build_routes()

    # ------------------------------------------------------------------ entry point
    def handle(
        self,
        method: str,
        path: str,
        *,
        query: Optional[Mapping[str, Sequence[str]]] = None,
        headers: Optional[Mapping[str, str]] = None,
        body: bytes = b"",
        request: Any = None,
        user: Any = _UNSET,
    ) -> HocResponse:
        """Serve one call.

        :param path: relative to the mount prefix and already percent-decoded, e.g. ``api/features/abc/pin``.
        :param query: parsed query string, name -> list of values.
        :param headers: request headers with lower-case names (only the webhook signature is read).
        :param body: the raw request body bytes.
        :param request: handed to ``get_current_user``.
        :param user: an already-resolved ``get_current_user`` result (async frameworks resolve it themselves).
        """
        method = method.upper()
        path = path.strip("/")
        try:
            self._ensure_ready()
            if path == "webhook" and method == "POST":
                return self._webhook(headers or {}, body)
            u = to_user(self._get_current_user(request) if user is _UNSET else user)
            if u is None:
                raise unauthenticated()
            for m, pattern, handler, wants_body in self._routes:
                match = pattern.match(path)
                if m == method and match:
                    parsed = self._parse_json(body) if (wants_body and body) else None
                    log.info("hoc %s %s user=%s", method, path, u.id)
                    return handler(_Call(u, query or {}, parsed, match.groups()))
            raise HocError(404, "not_found", "Not found.")
        except HocError as e:
            return HocResponse(e.status, {"error": e.code, "message": e.message})
        except Exception:  # noqa: BLE001 - logged with its inner exceptions by log.exception
            log.exception("hoc %s %s failed", method, path)
            return HocResponse(500, {"error": "internal", "message": "Internal error."})

    @staticmethod
    def requires_user(method: str, path: str) -> bool:
        """False only for ``POST webhook`` (signature-authenticated); async adapters skip resolving the user then."""
        return not (method.upper() == "POST" and path.strip("/") == "webhook")

    def retry_unstarted_builds(self, limit: int = 100) -> int:
        """Start platform builds for requests that were stored but never reached the platform. Returns how many started."""
        with self.storage.transaction() as tx:
            pending = tx.list_unstarted_builds(limit)
        return sum(1 for r in pending if self._start_build(r.id))

    # ------------------------------------------------------------------ plumbing
    def _ensure_ready(self) -> None:
        if self._migrated:
            return
        with self._migrate_lock:
            if self._migrated:
                return
            if self._auto_migrate:
                self.storage.migrate()
            self._migrated = True
        if self._retry_builds:
            t = threading.Timer(2.0, self._safe_retry_unstarted)
            t.daemon = True
            t.start()

    def _safe_retry_unstarted(self) -> None:
        try:
            self.retry_unstarted_builds()
        except Exception:  # noqa: BLE001
            log.exception("retrying unstarted builds failed")

    @staticmethod
    def _parse_json(raw: bytes) -> Any:
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise invalid("Malformed JSON.")

    def _route(self, method: str, pattern: str, handler: Callable[[_Call], HocResponse], body: bool = False) -> None:
        self._routes.append((method, re.compile("^" + pattern + "$"), handler, body))

    def _admin(self, c: _Call) -> bool:
        if c.admin is None:
            c.admin = bool(self._is_admin(c.user.raw))
        return c.admin

    @staticmethod
    def _q1(query: Mapping[str, Sequence[str]], name: str) -> Optional[str]:
        v = query.get(name)
        return v[0] if v else None

    @staticmethod
    def _int_param(query: Mapping[str, Sequence[str]], name: str, default: int, lo: int, hi: int) -> int:
        raw = HostModule._q1(query, name)
        if raw is None:
            return default
        if not re.fullmatch(r"[0-9]+", raw) or not lo <= int(raw) <= hi:
            raise invalid(f"{name} must be {lo}-{hi}.")
        return int(raw)

    def _settings(self, tx: StorageTx) -> Dict[str, Any]:
        stored = tx.get_settings() or {}
        merged = {**DEFAULT_SETTINGS, **stored}
        merged["dataSources"] = list(merged.get("dataSources") or [])
        return merged

    @staticmethod
    def _allowed_by(policy: str, admin: bool, owner: bool) -> bool:
        if policy == "nobody":
            return False
        if policy == "admins":
            return admin
        return owner or admin

    def _load_visible(self, tx: StorageTx, feature_id: str, user: HocUser) -> _Loaded:
        f = tx.get_feature(feature_id)
        if f is None:
            raise not_found()
        assignments = tx.get_assignments([f.id])[f.id]
        if not any(a.user_id is None or a.user_id == user.id for a in assignments):
            raise not_found()
        return _Loaded(f, assignments, tx.get_user_state([f.id], user.id)[f.id])

    def _view(self, c: _Call, ld: _Loaded) -> Dict[str, Any]:
        f = ld.feature
        out: Dict[str, Any] = {
            "id": f.id,
            "title": f.title,
            "kind": f.kind,
            "path": f.path,
            "slotId": f.slot_id,
            "mode": f.mode,
            "packageId": f.package_id,
            "currentVersion": f.current_version,
            "pinnedVersion": ld.state.pinned_version,
            "enabled": not ld.state.disabled,
            "ownerUserId": f.owner_user_id,
            "requestId": f.request_id,
        }
        if f.owner_user_id == c.user.id or self._admin(c):
            out["sharing"] = {
                "everyone": any(a.user_id is None for a in ld.assignments),
                "userIds": [a.user_id for a in ld.assignments if a.user_id is not None],
            }
        return out

    def _reload_view(self, tx: StorageTx, c: _Call, feature_id: str) -> HocResponse:
        return HocResponse(200, self._view(c, self._load_visible(tx, feature_id, c.user)))

    @staticmethod
    def _public_request(r: RequestRec) -> Dict[str, Any]:
        return {
            "id": r.id,
            "text": r.text,
            "status": r.status,
            "message": r.message,
            "featureId": r.feature_id,
            "userId": r.user_id,
            "userName": r.user_name,
            "createdAt": r.created_at,
            "updatedAt": r.updated_at,
        }

    # ------------------------------------------------------------------ routes
    def _build_routes(self) -> None:
        r = self._route
        r("GET", r"token", self._token)
        r("POST", r"api/requests", self._create_request, True)
        r("GET", r"api/requests", self._list_requests)
        r("POST", r"api/requests/([^/]+)/reply", self._reply, True)
        r("GET", r"api/features", self._list_features)
        r("GET", r"api/resolve", self._resolve)
        r("GET", r"api/features/([^/]+)/versions", self._versions)
        r("POST", r"api/features/([^/]+)/pin", self._pin, True)
        r("POST", r"api/features/([^/]+)/current", self._set_current, True)
        r("POST", r"api/features/([^/]+)/share", self._share, True)
        r("DELETE", r"api/features/([^/]+)/share/(.+)", self._unshare)
        r("POST", r"api/features/([^/]+)/enabled", self._enabled, True)
        r("GET", r"api/users", self._users)
        r("GET", r"api/settings", self._get_settings)
        r("PUT", r"api/settings", self._put_settings, True)

    # ---- token
    def _token(self, c: _Call) -> HocResponse:
        feature_id = self._q1(c.query, "featureId")
        if not feature_id:
            package_id, slot_id = self._legacy
            if not package_id or not slot_id:
                raise invalid("featureId is required.")
            version: Optional[str] = None
        else:
            with self.storage.transaction() as tx:
                ld = self._load_visible(tx, feature_id, c.user)
            if ld.state.disabled:
                raise not_found()
            package_id, slot_id = ld.feature.package_id, ld.feature.slot_id
            version = ld.state.pinned_version or ld.feature.current_version
        res = self.platform.embed_token(c.user.id, package_id, slot_id, version)
        if res.status == 409:
            raise HocError(409, "version_unavailable", "That version is no longer available.")
        if not res.ok or not isinstance(res.body, dict) or not res.body.get("token"):
            raise platform_unavailable()
        return HocResponse(200, {"token": res.body["token"], "expiresAt": res.body.get("expiresAt"), "userId": c.user.id, "displayName": c.user.name})

    # ---- requests
    def _create_request(self, c: _Call) -> HocResponse:
        body = c.body
        if not isinstance(body, dict):
            raise invalid("Body must be an object.")
        text = body.get("text")
        if not isinstance(text, str) or not text.strip():
            raise invalid("text is required.")
        if len(text) > TEXT_MAX:
            raise HocError(413, "payload_too_large", "The request text is too long.")
        snapshot = body.get("snapshot")
        snapshot_json: Optional[str] = None
        if snapshot is not None:
            if not isinstance(snapshot, dict):
                raise invalid("snapshot must be an object.")
            snapshot_json = json.dumps(snapshot, separators=(",", ":"), ensure_ascii=False)
            if len(snapshot_json.encode("utf-8")) > SNAPSHOT_MAX:
                raise HocError(413, "payload_too_large", "The page snapshot is too large.")
        feature_id = body.get("featureId")
        if feature_id is not None and not isinstance(feature_id, str):
            raise invalid("featureId must be a string.")
        with self.storage.transaction(write=True) as tx:
            if feature_id is not None:
                self._load_visible(tx, feature_id, c.user)
            now = now_iso()
            rec = RequestRec(
                id="req-" + secrets.token_hex(6),
                seq=tx.next_seq(),
                user_id=c.user.id,
                user_name=c.user.name,
                user_email=c.user.email,
                text=text,
                status="InProgress",
                message=None,
                feature_id=feature_id,
                change_of=feature_id,
                mode=self._settings(tx)["renderingMode"],
                snapshot=snapshot_json,
                build_id=None,
                created_at=now,
                updated_at=now,
            )
            tx.insert_request(rec)
        if not self._start_build(rec.id):
            self._schedule_build_retry(rec.id, 0)
        return HocResponse(201, self._public_request(rec))

    def _start_build(self, request_id: str) -> bool:
        """Tell the platform about a stored request. Idempotent on the platform side (keyed by the request id)."""
        with self.storage.transaction() as tx:
            r = tx.get_request(request_id)
            if r is None or r.build_id:
                return r is not None
            feature = tx.get_feature(r.change_of) if r.change_of else None
        user: Dict[str, Any] = {"id": r.user_id}
        if r.user_name:
            user["name"] = r.user_name
        if r.user_email:
            user["email"] = r.user_email
        res = self.platform.start_build(
            r.id,
            user,
            r.text,
            r.mode,
            snapshot=json.loads(r.snapshot) if r.snapshot else None,
            feature={"ref": feature.id, "packageId": feature.package_id} if feature else None,
        )
        build_id = res.body.get("buildId") if res.ok and isinstance(res.body, dict) else None
        if not build_id:
            log.warning("platform did not take the build for request %s (status %s)", r.id, res.status)
            return False
        with self.storage.transaction(write=True) as tx:
            tx.update_request(r.id, build_id=str(build_id))
        return True

    def _schedule_build_retry(self, request_id: str, attempt: int) -> None:
        if not self._retry_builds or attempt >= len(BUILD_RETRY_DELAYS):
            return

        def run() -> None:
            try:
                if not self._start_build(request_id):
                    self._schedule_build_retry(request_id, attempt + 1)
            except Exception:  # noqa: BLE001
                log.exception("retrying the build for request %s failed", request_id)
                self._schedule_build_retry(request_id, attempt + 1)

        t = threading.Timer(BUILD_RETRY_DELAYS[attempt], run)
        t.daemon = True
        t.start()

    def _list_requests(self, c: _Call) -> HocResponse:
        scope = self._q1(c.query, "scope") or "mine"
        if scope not in ("mine", "all"):
            raise invalid("scope must be mine or all.")
        statuses = list(c.query.get("status") or [])
        if any(s not in STATUSES for s in statuses):
            raise invalid("Unknown status.")
        limit = self._int_param(c.query, "limit", 50, 1, 200)
        offset = 0
        cursor = self._q1(c.query, "cursor")
        if cursor is not None:
            try:
                offset = int(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode("ascii"))
                if offset < 0:
                    raise ValueError
            except (ValueError, UnicodeDecodeError):
                raise invalid("Bad cursor.")
        with self.storage.transaction() as tx:
            if scope == "all":
                policy = self._settings(tx)["viewAllRequests"]
                if not (policy == "everyone" or (policy == "admins" and self._admin(c))):
                    raise forbidden("You may not see everyone's requests.")
            rows, more = tx.list_requests(None if scope == "all" else c.user.id, statuses, limit, offset)
        next_cursor = base64.urlsafe_b64encode(str(offset + limit).encode("ascii")).decode("ascii").rstrip("=") if more else None
        return HocResponse(200, {"requests": [self._public_request(x) for x in rows], "nextCursor": next_cursor})

    def _reply(self, c: _Call) -> HocResponse:
        with self.storage.transaction() as tx:
            r = tx.get_request(c.params[0])
        if r is None or r.user_id != c.user.id:
            raise not_found("No such request.")
        text = c.body.get("text") if isinstance(c.body, dict) else None
        if not isinstance(text, str) or not text.strip() or len(text) > TEXT_MAX:
            raise invalid("text is required (max 20000 characters).")
        if r.status != "NeedsInfo" or not r.build_id:
            raise HocError(409, "not_awaiting_reply", "This request is not waiting for an answer.")
        if not self.platform.reply_to_build(r.build_id, text).ok:
            raise platform_unavailable()
        with self.storage.transaction(write=True) as tx:
            tx.update_request(r.id, status="InProgress", message=None, updated_at=now_iso())
            r = tx.get_request(r.id)
        return HocResponse(200, self._public_request(r))  # type: ignore[arg-type]

    # ---- features
    def _visible_with_state(self, tx: StorageTx, user: HocUser, path: Optional[str] = None) -> List[_Loaded]:
        feats = tx.list_visible_features(user.id, path)
        ids = [f.id for f in feats]
        assigns = tx.get_assignments(ids)
        states = tx.get_user_state(ids, user.id)
        return [_Loaded(f, assigns[f.id], states[f.id]) for f in feats]

    def _list_features(self, c: _Call) -> HocResponse:
        with self.storage.transaction() as tx:
            loaded = self._visible_with_state(tx, c.user)
        return HocResponse(200, {"features": [self._view(c, ld) for ld in loaded]})

    def _resolve(self, c: _Call) -> HocResponse:
        path = self._q1(c.query, "path")
        if not path or not path.startswith("/"):
            raise invalid("path must start with /.")
        with self.storage.transaction() as tx:
            cands = [ld for ld in self._visible_with_state(tx, c.user, path) if not ld.state.disabled]

            def rank(ld: _Loaded) -> Tuple[int, int]:
                mine = [a for a in ld.assignments if a.user_id == c.user.id]
                every = [a for a in ld.assignments if a.user_id is None]
                a = mine[0] if mine else every[0]
                return (1 if mine else 0, a.seq)

            pages = sorted((ld for ld in cands if ld.feature.kind != "slot"), key=rank, reverse=True)[:1]
            chosen = pages + [ld for ld in cands if ld.feature.kind == "slot"]
            out = []
            for ld in chosen:
                f = ld.feature
                v = tx.get_version(f.id, ld.state.pinned_version or f.current_version)
                if v is None:
                    log.warning("feature %s has no record of version %s", f.id, ld.state.pinned_version or f.current_version)
                    continue
                out.append(
                    {
                        "featureId": f.id,
                        "kind": f.kind,
                        "mode": f.mode,
                        "slotId": f.slot_id,
                        "path": f.path,
                        "packageId": f.package_id,
                        "version": v.version,
                        "sha256": v.sha256,
                        "entry": v.entry,
                    }
                )
        return HocResponse(200, {"path": path, "features": out})

    def _versions(self, c: _Call) -> HocResponse:
        with self.storage.transaction() as tx:
            ld = self._load_visible(tx, c.params[0], c.user)
            versions = tx.list_versions(ld.feature.id)
        return HocResponse(
            200,
            {
                "featureId": ld.feature.id,
                "currentVersion": ld.feature.current_version,
                "pinnedVersion": ld.state.pinned_version,
                "versions": [{"version": v.version, "publishedAt": v.published_at, "requestId": v.request_id, "sha256": v.sha256} for v in versions],
            },
        )

    def _pin(self, c: _Call) -> HocResponse:
        with self.storage.transaction(write=True) as tx:
            ld = self._load_visible(tx, c.params[0], c.user)
            body = c.body
            if not isinstance(body, dict) or "version" not in body or (body["version"] is not None and not isinstance(body["version"], str)):
                raise invalid("version is required (a version string or null).")
            version = body["version"]
            if version is not None and tx.get_version(ld.feature.id, version) is None:
                raise HocError(404, "version_not_found", "No such version.")
            tx.set_pin(ld.feature.id, c.user.id, version)
            return self._reload_view(tx, c, ld.feature.id)

    def _set_current(self, c: _Call) -> HocResponse:
        with self.storage.transaction(write=True) as tx:
            ld = self._load_visible(tx, c.params[0], c.user)
            version = c.body.get("version") if isinstance(c.body, dict) else None
            if not isinstance(version, str) or not version:
                raise invalid("version is required.")
            if ld.feature.owner_user_id != c.user.id and not self._admin(c):
                raise forbidden("Only the owner or an admin may do this.")
            if tx.get_version(ld.feature.id, version) is None:
                raise HocError(404, "version_not_found", "No such version.")
            tx.update_feature(ld.feature.id, current_version=version)
            return self._reload_view(tx, c, ld.feature.id)

    def _share(self, c: _Call) -> HocResponse:
        with self.storage.transaction() as tx:
            ld = self._load_visible(tx, c.params[0], c.user)
            policies = self._settings(tx)
        body = c.body
        keys = list(body) if isinstance(body, dict) else []
        named = keys == ["userIds"] and isinstance(body["userIds"], list) and len(body["userIds"]) > 0 and all(isinstance(x, str) for x in body["userIds"])
        everyone = keys == ["everyone"] and body["everyone"] is True
        if not named and not everyone:
            raise invalid("Send either userIds (non-empty) or everyone: true.")
        policy = policies["shareWithEveryone"] if everyone else policies["shareWithNamedUsers"]
        if not self._allowed_by(policy, self._admin(c), ld.feature.owner_user_id == c.user.id):
            raise HocError(403, "sharing_not_allowed", "Sharing is not allowed for you.")
        targets: List[Optional[str]] = [None] if everyone else list(dict.fromkeys(body["userIds"]))
        if named:
            for uid in targets:
                if uid != c.user.id and not self._user_known(str(uid)):
                    raise invalid("Unknown user id.")
        with self.storage.transaction(write=True) as tx:
            self._load_visible(tx, ld.feature.id, c.user)
            for t in targets:
                tx.add_assignment(ld.feature.id, t, tx.next_seq())
            return self._reload_view(tx, c, ld.feature.id)

    def _user_known(self, user_id: str) -> bool:
        if self._user_exists is not None:
            return bool(self._user_exists(user_id))
        return any(str(_field(m, "id")) == user_id for m in (self._find_users(user_id) or []))

    def _unshare(self, c: _Call) -> HocResponse:
        with self.storage.transaction(write=True) as tx:
            ld = self._load_visible(tx, c.params[0], c.user)
            if ld.feature.owner_user_id != c.user.id and not self._admin(c):
                raise forbidden("Only the owner or an admin may do this.")
            target = c.params[1]
            tx.remove_assignment(ld.feature.id, None if target == "everyone" else target)
            return self._reload_view(tx, c, ld.feature.id)

    def _enabled(self, c: _Call) -> HocResponse:
        with self.storage.transaction(write=True) as tx:
            ld = self._load_visible(tx, c.params[0], c.user)
            enabled = c.body.get("enabled") if isinstance(c.body, dict) else None
            if not isinstance(enabled, bool):
                raise invalid("enabled must be a boolean.")
            tx.set_disabled(ld.feature.id, c.user.id, not enabled)
            return self._reload_view(tx, c, ld.feature.id)

    def _users(self, c: _Call) -> HocResponse:
        q = self._q1(c.query, "query")
        if not q or len(q) > 100:
            raise invalid("query is required (max 100 characters).")
        limit = self._int_param(c.query, "limit", 20, 1, 50)
        with self.storage.transaction() as tx:
            policy = self._settings(tx)["shareWithNamedUsers"]
        if policy == "nobody" or (policy == "admins" and not self._admin(c)):
            raise HocError(403, "sharing_not_allowed", "Sharing with named users is not allowed for you.")
        found = []
        for m in self._find_users(q) or []:
            uid = _field(m, "id")
            if uid is None or str(uid) == c.user.id:
                continue
            name = _field(m, "name")
            found.append({"id": str(uid), "name": str(name) if name not in (None, "") else None})
            if len(found) >= limit:
                break
        return HocResponse(200, {"users": found})

    # ---- settings
    @staticmethod
    def _public_settings(s: Dict[str, Any]) -> Dict[str, Any]:
        out = dict(s)
        sources = []
        for d in s.get("dataSources") or []:
            d = dict(d)
            if isinstance(d.get("auth"), dict):
                d["auth"] = {k: v for k, v in d["auth"].items() if k != "secretValue"}
            sources.append(d)
        out["dataSources"] = sources
        return out

    def _get_settings(self, c: _Call) -> HocResponse:
        if not self._admin(c):
            raise forbidden("Admins only.")
        with self.storage.transaction() as tx:
            return HocResponse(200, self._public_settings(self._settings(tx)))

    def _put_settings(self, c: _Call) -> HocResponse:
        if not self._admin(c):
            raise forbidden("Admins only.")
        body = c.body
        if not isinstance(body, dict):
            raise invalid("Body must be an object.")
        if body.get("renderingMode") not in MODES:
            raise invalid("renderingMode must be inject or iframe.")
        if body.get("shareWithNamedUsers") not in POLICIES or body.get("shareWithEveryone") not in POLICIES:
            raise invalid("Sharing policies must be owner, admins or nobody.")
        if body.get("viewAllRequests") not in ("admins", "everyone"):
            raise invalid("viewAllRequests must be admins or everyone.")
        sources = body.get("dataSources")
        if not isinstance(sources, list):
            raise invalid("dataSources must be an array.")
        for d in sources:
            if not isinstance(d, dict) or not isinstance(d.get("name"), str) or not d["name"] or not isinstance(d.get("baseUrl"), str):
                raise invalid("Each data source needs a name and baseUrl.")
            if not re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://[^\s/]+", d["baseUrl"]):
                raise invalid("baseUrl must be a URL.")
            auth = d.get("auth")
            if auth is not None and (
                not isinstance(auth, dict)
                or auth.get("type") != "bearer"
                or not isinstance(auth.get("secret"), str)
                or not _SECRET_NAME.match(auth["secret"])
                or ("secretValue" in auth and not isinstance(auth["secretValue"], str))
            ):
                raise invalid("auth must be bearer with a secret name [a-z0-9_-]{1,64}.")
        new = {
            "renderingMode": body["renderingMode"],
            "shareWithNamedUsers": body["shareWithNamedUsers"],
            "shareWithEveryone": body["shareWithEveryone"],
            "viewAllRequests": body["viewAllRequests"],
            "dataSources": self._public_settings({"dataSources": sources})["dataSources"],
        }
        with self.storage.transaction() as tx:
            old = self._settings(tx)

        def canon(x: Any) -> str:
            return json.dumps(x, sort_keys=True, separators=(",", ":"))

        if canon(new["dataSources"]) != canon(old["dataSources"]) or any((d.get("auth") or {}).get("secretValue") for d in sources):
            for d in sources:
                value = (d.get("auth") or {}).get("secretValue")
                if value and not self.platform.put_secret(d["auth"]["secret"], value, c.user.id).ok:
                    raise platform_unavailable()
            if not self.platform.put_data_sources(new["dataSources"]).ok:
                raise platform_unavailable()
        with self.storage.transaction(write=True) as tx:
            tx.save_settings(new)
        return HocResponse(200, self._public_settings(new))

    # ------------------------------------------------------------------ webhook
    def _webhook(self, headers: Mapping[str, str], raw: bytes) -> HocResponse:
        if not verify_signature(self._secret, raw, headers.get(SIGNATURE_HEADER)):
            return HocResponse(401, {"error": "invalid_signature", "message": "Signature missing or wrong."})
        try:
            ev = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return HocResponse(400, {"error": "invalid_request", "message": "Malformed JSON."})
        if not isinstance(ev, dict):
            return HocResponse(400, {"error": "invalid_request", "message": "Body must be an object."})
        if "sentAt" in ev and is_stale(ev["sentAt"]):
            return HocResponse(400, {"error": "stale_event", "message": "sentAt is outside the tolerance."})
        event_id = ev.get("eventId")
        with self.storage.transaction(write=True) as tx:
            if isinstance(event_id, str) and event_id and not tx.record_event(event_id, now_iso()):
                return HocResponse(200, {})  # a repeat; nothing was changed in this transaction
            self._apply_event(tx, ev)
        return HocResponse(200, {})

    def _apply_event(self, tx: StorageTx, ev: Dict[str, Any]) -> None:
        etype = ev.get("type")
        if etype not in ("build.status", "build.version"):
            return  # activation.changed (legacy) and anything new: acknowledged, ignored
        ref = ev.get("requestRef")
        r = tx.get_request(ref) if isinstance(ref, str) else None
        now = now_iso()
        build_id = ev.get("buildId")
        if etype == "build.status":
            status = ev.get("status")
            if r is None or status not in STATUSES:
                return
            message = ev.get("message") if status in ("NeedsInfo", "Rejected") and isinstance(ev.get("message"), str) else None
            fields: Dict[str, Any] = {"status": status, "message": message, "updated_at": now}
            if not r.build_id and isinstance(build_id, str) and build_id:
                fields["build_id"] = build_id
            tx.update_request(r.id, **fields)
            return
        feature_ref, version = ev.get("featureRef"), ev.get("version")
        if not isinstance(feature_ref, str) or not feature_ref or not isinstance(version, str) or not version:
            log.warning("ignoring build.version without featureRef/version: %s", ev.get("eventId"))
            return
        kind = ev.get("kind") if ev.get("kind") in KINDS else "page-override"
        slot_id = ev.get("slotId") if isinstance(ev.get("slotId"), str) and ev.get("slotId") else "main"
        mode = ev.get("mode") if ev.get("mode") in MODES else (r.mode if r else "inject")
        f = tx.get_feature(feature_ref)
        if f is None:
            if r is None:
                log.warning("build.version for unknown feature %s and unknown request %s", feature_ref, ref)
                return
            f = FeatureRec(
                id=feature_ref,
                title=_title(r.text),
                kind=str(kind),
                path=ev.get("path") if isinstance(ev.get("path"), str) else None,
                slot_id=str(slot_id),
                mode=str(mode),
                package_id=str(ev.get("packageId") or ""),
                current_version=version,
                owner_user_id=r.user_id,
                request_id=r.id,
                created_at=now,
            )
            tx.insert_feature(f)
            tx.add_assignment(f.id, r.user_id, tx.next_seq())
        else:
            tx.update_feature(f.id, current_version=version, slot_id=str(slot_id), mode=str(mode))
        tx.upsert_version(
            VersionRec(
                feature_id=f.id,
                version=version,
                published_at=now,
                request_id=r.id if r else None,
                sha256=str(ev.get("sha256") or ""),
                entry=str(ev.get("entry") or ""),
                seq=tx.next_seq(),
            )
        )
        if r is not None:
            fields = {"feature_id": f.id, "updated_at": now}
            if not r.build_id and isinstance(build_id, str) and build_id:
                fields["build_id"] = build_id
            tx.update_request(r.id, **fields)


def _title(text: str) -> str:
    line = next((ln.strip() for ln in text.splitlines() if ln.strip()), "Feature")
    line = re.sub(r"\s+", " ", line)
    return line if len(line) <= 60 else line[:59].rstrip() + "..."
