"""End to end: the sample app against the fake platform (host-modules/conformance/fake-platform, needs Node 20+).

    pip install pytest && python fetch_assets.py && python -m pytest tests -q

Proves the loop from the README: request submitted -> built -> visible only to the requester.
"""
from __future__ import annotations

import http.cookiejar
import json
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import pytest
from werkzeug.serving import make_server

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
FAKE_CLI = HERE.parents[2] / "host-modules" / "conformance" / "fake-platform" / "cli.mjs"

API_KEY, WEBHOOK_SECRET, TENANT, HOST = "sample-api-key", "whsec_sample", "sample-tenant", "sample-host"
DATA_TOKEN = "orders-data-token"

pytestmark = pytest.mark.skipif(
    not shutil.which("node") or not (HERE / "static" / "embed.global.js").exists() or not (HERE / "static" / "hoc-head.min.js").exists(),
    reason="needs node and static/embed.global.js + static/hoc-head.min.js (python fetch_assets.py)",
)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):  # noqa: ANN002, ANN003
        return None


class Browser:
    """A cookie-keeping client. Never follows redirects, so tests see them."""

    def __init__(self, base: str) -> None:
        self.base = base
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()), NoRedirect)

    def call(self, method: str, path: str, body=None, headers=None, form=None):  # noqa: ANN001
        data, h = None, dict(headers or {})
        if body is not None:
            data, h["Content-Type"] = json.dumps(body).encode(), "application/json"
        if form is not None:
            data, h["Content-Type"] = urllib.parse.urlencode(form).encode(), "application/x-www-form-urlencoded"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with self.opener.open(req, timeout=10) as res:
                return res.status, res.read().decode(), res.headers
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode(), e.headers

    def json(self, method: str, path: str, body=None, headers=None):  # noqa: ANN001
        status, text, _ = self.call(method, path, body, headers)
        return status, (json.loads(text) if text else None)

    def sign_in(self, user: str) -> None:
        status, _, _ = self.call("POST", "/login", form={"username": user, "password": "demo"})
        assert status == 302


@pytest.fixture(scope="module")
def site(tmp_path_factory):  # noqa: ANN001
    from app import create_app

    site_port, platform_port = free_port(), free_port()
    base = f"http://127.0.0.1:{site_port}"
    platform = subprocess.Popen(
        ["node", str(FAKE_CLI), "--port", str(platform_port), "--api-key", API_KEY, "--webhook-secret", WEBHOOK_SECRET,
         "--webhook-url", f"{base}/hoc/webhook", "--host-id", HOST, "--tenant-id", TENANT, "--auto-build"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    app = create_app({
        "HOC_API_BASE_URL": f"http://127.0.0.1:{platform_port}", "HOC_HOST_ID": HOST, "HOC_TENANT_ID": TENANT,
        "HOC_HOST_API_KEY": API_KEY, "HOC_WEBHOOK_SECRET": WEBHOOK_SECRET, "FLASK_SECRET_KEY": "test-secret",
        "HOC_DB": str(tmp_path_factory.mktemp("db") / "hoc.db"), "HOC_DATA_TOKEN": DATA_TOKEN,
    })
    server = make_server("127.0.0.1", site_port, app, threaded=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    deadline = time.time() + 15
    while time.time() < deadline:  # wait for the fake platform to listen
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{platform_port}/host/v1/jwks", timeout=1)
            break
        except urllib.error.HTTPError:
            break
        except Exception:  # noqa: BLE001 - not up yet
            time.sleep(0.2)
    yield base
    server.shutdown()
    platform.terminate()
    platform.wait(timeout=10)


def test_request_built_and_visible_only_to_requester(site):  # noqa: ANN001
    alice, bob, anon = Browser(site), Browser(site), Browser(site)
    alice.sign_in("alice")
    bob.sign_in("bob")

    assert anon.json("GET", "/hoc/api/features")[0] == 401  # no session, no access
    assert alice.json("GET", "/hoc/api/features") == (200, {"features": []})

    status, created = alice.json("POST", "/hoc/api/requests", {
        "text": "Show overdue orders first",
        "snapshot": {"url": f"{site}/orders", "path": "/orders", "title": "Orders", "html": "<body></body>", "css": "", "redacted": True},
    })
    assert status == 201, created

    deadline, feature = time.time() + 15, None
    while time.time() < deadline and feature is None:  # fake platform answers a moment later via a signed webhook
        _, body = alice.json("GET", "/hoc/api/features")
        feature = body["features"][0] if body["features"] else None
        time.sleep(0.2)
    assert feature is not None, "the build never produced a feature (webhook not delivered?)"
    assert feature["path"] == "/orders"

    # alice: resolve applies it on /orders and she can get a token for it
    _, resolved = alice.json("GET", "/hoc/api/resolve?path=/orders")
    assert [f["featureId"] for f in resolved["features"]] == [feature["id"]]
    status, token = alice.json("GET", f"/hoc/token?featureId={feature['id']}")
    assert status == 200 and token["token"] and token["userId"] == "alice"

    # bob: sees nothing, cannot get a token for alice's feature
    assert bob.json("GET", "/hoc/api/features") == (200, {"features": []})
    assert bob.json("GET", "/hoc/api/resolve?path=/orders")[1]["features"] == []
    assert bob.json("GET", f"/hoc/token?featureId={feature['id']}")[0] in (403, 404)


def test_pages_csp_and_access(site):  # noqa: ANN001
    alice, bob, admin, anon = Browser(site), Browser(site), Browser(site), Browser(site)
    alice.sign_in("alice")
    bob.sign_in("bob")
    admin.sign_in("admin")

    assert anon.call("GET", "/orders")[0] == 302  # to the sign-in page
    status, html, headers = alice.call("GET", "/orders")
    assert status == 200
    assert "<hoc-request-feature>" in html and "hoc-hide" in html  # request box + inlined hoc-head.js
    assert "Northwind" in html and "Fabrikam" not in html  # alice sees her own orders only
    csp = headers["Content-Security-Policy"]
    assert "'sha256-" in csp and "frame-src http://127.0.0.1" in csp

    assert alice.call("GET", "/admin")[0] == 403
    assert admin.call("GET", "/admin")[0] == 200
    assert "<hoc-my-features>" in alice.call("GET", "/my-features")[1]
    assert alice.call("GET", "/ext/nothing-here")[0] == 404  # unknown paths get the site's own 404
    assert alice.call("POST", "/login", form={"username": "alice", "password": "wrong"})[0] == 401


def test_security(site):  # noqa: ANN001
    alice = Browser(site)
    alice.sign_in("alice")
    # cross-site POST to the API is refused; the unsigned webhook is refused
    assert alice.json("POST", "/hoc/api/requests", {"text": "x"}, {"Origin": "http://evil.example"})[0] == 403
    assert alice.json("POST", "/hoc/webhook", {"type": "build.status"})[0] == 401


def test_data_source(site):  # noqa: ANN001
    alice, bob, anon = Browser(site), Browser(site), Browser(site)
    alice.sign_in("alice")
    bob.sign_in("bob")
    assert anon.json("GET", "/api/orders")[0] == 401
    assert [o["id"] for o in bob.json("GET", "/api/orders")[1]] == [1003]
    assert len(alice.json("GET", "/api/orders")[1]) == 2
    assert len(anon.json("GET", "/api/orders", headers={"Authorization": f"Bearer {DATA_TOKEN}"})[1]) == 3  # the egress proxy's credential
    assert anon.json("GET", "/api/orders", headers={"Authorization": "Bearer wrong"})[0] == 401
