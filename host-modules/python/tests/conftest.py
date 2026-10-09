import json
from typing import Any, Dict, List, Optional

import pytest

from handofclient import HostModule, SqlStorage
from handofclient.platform_client import PlatformResult
from handofclient.timeutil import now_iso
from handofclient.webhook import sign

SECRET = "whsec_test"
USERS = {
    "admin": {"id": "admin", "name": "Ada Admin"},
    "alice": {"id": "alice", "name": "Alice Owner", "email": "alice@example.com"},
    "bob": {"id": "bob", "name": "Bob Builder"},
}


class FakePlatform:
    """Records every call. ``answers[name]`` scripts the reply: a PlatformResult, or a list consumed in order."""

    def __init__(self) -> None:
        self.calls: List[tuple] = []
        self.answers: Dict[str, Any] = {}

    def _answer(self, name: str, default: PlatformResult) -> PlatformResult:
        a = self.answers.get(name, default)
        if isinstance(a, list):
            return a.pop(0) if len(a) > 1 else a[0]
        return a

    def start_build(self, request_ref, user, text, mode, snapshot=None, feature=None):
        self.calls.append(("start_build", request_ref, user, text, mode, snapshot, feature))
        return self._answer("start_build", PlatformResult(200, {"buildId": "b-" + request_ref}))

    def reply_to_build(self, build_id, text):
        self.calls.append(("reply_to_build", build_id, text))
        return self._answer("reply_to_build", PlatformResult(200, {}))

    def embed_token(self, user_id, package_id, slot_id, version):
        self.calls.append(("embed_token", user_id, package_id, slot_id, version))
        return self._answer("embed_token", PlatformResult(200, {"token": "jwt", "expiresAt": "2030-01-01T00:00:00Z"}))

    def put_secret(self, name, value, updated_by):
        self.calls.append(("put_secret", name, value, updated_by))
        return self._answer("put_secret", PlatformResult(200, {}))

    def put_data_sources(self, data_sources):
        self.calls.append(("put_data_sources", data_sources))
        return self._answer("put_data_sources", PlatformResult(200, {}))

    def named(self, name: str) -> List[tuple]:
        return [c for c in self.calls if c[0] == name]


class Host:
    """A HostModule over a temp SQLite file. The "request" handed to get_current_user is just the user key."""

    def __init__(self, tmp_path, **overrides) -> None:
        self.platform = FakePlatform()
        self.storage = SqlStorage.sqlite(str(tmp_path / "hoc.db"))
        kwargs = dict(
            storage=self.storage,
            platform=self.platform,
            webhook_secret=SECRET,
            get_current_user=lambda req: USERS.get(req) if isinstance(req, str) else None,
            is_admin=lambda u: u["id"] == "admin",
            find_users=lambda q: [u for u in USERS.values() if q.lower() in u["id"].lower() or q.lower() in u["name"].lower()],
            user_exists=lambda uid: uid in USERS,
            retry_builds=False,
        )
        kwargs.update(overrides)
        self.module = HostModule(**kwargs)
        self._n = 0

    def call(self, user: Optional[str], method: str, path: str, body: Any = None, query: Optional[dict] = None):
        raw = b"" if body is None else json.dumps(body).encode()
        return self.module.handle(method, path, query=query or {}, body=raw, request=user)

    def event(self, **fields):
        self._n += 1
        ev = {"eventId": f"evt_{self._n}", "sentAt": now_iso(), **fields}
        raw = json.dumps(ev).encode()
        return self.module.handle("POST", "webhook", headers={"x-handofclient-signature": sign(SECRET, raw)}, body=raw)

    def publish(self, request_id: str, version: str = "1.0.0", path: str = "/orders", **extra):
        res = self.event(
            type="build.version", buildId="b1", requestRef=request_id, featureRef=request_id, packageId=f"acme/f-{request_id}",
            version=version, sha256="ab" * 32, entry="index.js", kind="page-override", path=path, slotId="main", mode="inject", **extra,
        )
        assert res.status == 200, res.payload
        return res

    def submit(self, user: str = "alice", text: str = "Make it red", **extra) -> str:
        res = self.call(user, "POST", "api/requests", {"text": text, **extra})
        assert res.status == 201, res.payload
        return res.payload["id"]


@pytest.fixture
def host(tmp_path):
    return Host(tmp_path)
