"""Each framework adapter, driven through the framework's own test client (the full suite is test_conformance.py)."""
import json

import pytest

from conftest import SECRET, USERS, FakePlatform
from handofclient import HostModule, SqlStorage
from handofclient.timeutil import now_iso
from handofclient.webhook import sign


def make_module(tmp_path, current_user=None):
    platform = FakePlatform()
    module = HostModule(
        storage=SqlStorage.sqlite(str(tmp_path / "a.db")),
        platform=platform,
        webhook_secret=SECRET,
        get_current_user=current_user or (lambda req: USERS["alice"] if "signed-in" in req.headers.get("cookie", "") else None),
        is_admin=lambda u: False,
        find_users=lambda q: [],
        retry_builds=False,
    )
    return module, platform


def webhook_body():
    return json.dumps({"type": "build.status", "eventId": "e1", "sentAt": now_iso(), "requestRef": "nope", "status": "Success"}).encode()


def test_flask(tmp_path):
    flask = pytest.importorskip("flask")
    from handofclient.adapters.flask import blueprint

    module, platform = make_module(tmp_path)
    app = flask.Flask(__name__)
    app.register_blueprint(blueprint(module), url_prefix="/site/hoc")
    c = app.test_client()
    assert c.get("/site/hoc/api/features").status_code == 401
    c.set_cookie("signed-in", "1")
    r = c.post("/site/hoc/api/requests", json={"text": "hello"})
    assert r.status_code == 201 and r.headers["Cache-Control"] == "no-store" and r.get_json()["userId"] == "alice"
    assert c.get("/site/hoc/api/requests?status=InProgress&status=Success").get_json()["requests"][0]["text"] == "hello"
    body = webhook_body()
    assert c.post("/site/hoc/webhook", data=body, headers={"X-HandOfClient-Signature": sign(SECRET, body)}).status_code == 200
    assert c.post("/site/hoc/webhook", data=body, headers={"X-HandOfClient-Signature": "sha256=" + "0" * 64}).status_code == 401
    assert platform.named("start_build")


def test_django(tmp_path):
    django = pytest.importorskip("django")
    from django.conf import settings

    if not settings.configured:
        settings.configure(DEBUG=False, SECRET_KEY="t", ALLOWED_HOSTS=["*"], ROOT_URLCONF="test_adapters", MIDDLEWARE=["django.middleware.csrf.CsrfViewMiddleware"])
        django.setup()
    from django.test import Client
    from django.urls import include, path

    from handofclient.adapters.django import urls

    global urlpatterns
    module, _ = make_module(tmp_path)
    urlpatterns = [path("hoc/", include(urls(module))), path("open/", include(urls(module, csrf_exempt=True)))]
    c = Client(enforce_csrf_checks=True, HTTP_COOKIE="signed-in=1")
    assert c.get("/hoc/api/features").status_code == 200
    # the site's own CSRF policy applies by default: a cross-site POST without the token is refused...
    assert c.post("/hoc/api/requests", data=json.dumps({"text": "x"}), content_type="application/json").status_code == 403
    # ...unless the site opted out
    r = c.post("/open/api/requests", data=json.dumps({"text": "x"}), content_type="application/json")
    assert r.status_code == 201 and r["Cache-Control"] == "no-store"
    body = webhook_body()
    # the webhook has no CSRF token by nature: it is exempt even when everything else is protected
    sig = sign(SECRET, body)
    assert c.post("/hoc/webhook", data=body, content_type="application/json", HTTP_X_HANDOFCLIENT_SIGNATURE=sig).status_code == 200
    assert c.post("/hoc/webhook/", data=body, content_type="application/json", HTTP_X_HANDOFCLIENT_SIGNATURE="sha256=" + "0" * 64).status_code == 401


def test_fastapi_sync_and_async_user_resolvers(tmp_path):
    pytest.importorskip("fastapi")
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from handofclient.adapters.fastapi import router

    async def current(req):
        return USERS["alice"] if req.cookies.get("signed-in") else None

    for resolver in (current, lambda req: USERS["alice"] if req.cookies.get("signed-in") else None):
        module, _ = make_module(tmp_path, resolver)
        app = FastAPI()
        app.include_router(router(module), prefix="/hoc")
        c = TestClient(app)
        assert c.get("/hoc/api/features").status_code == 401
        c.cookies.set("signed-in", "1")
        assert c.get("/hoc/api/features").json() == {"features": []}
        assert c.delete("/hoc/api/features/x/share/erin%2Bqa%40example.com").status_code == 404  # reaches the module, id decoded
        body = webhook_body()
        assert c.post("/hoc/webhook", content=body, headers={"x-handofclient-signature": sign(SECRET, body)}).status_code == 200


def test_fastapi_user_resolver_failure_is_500(tmp_path):
    pytest.importorskip("fastapi")
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from handofclient.adapters.fastapi import router

    def boom(req):
        raise RuntimeError("nope")

    module, _ = make_module(tmp_path, boom)
    app = FastAPI()
    app.include_router(router(module), prefix="/hoc")
    assert TestClient(app).get("/hoc/api/features").status_code == 500
