"""Behaviour the language-neutral conformance suite cannot see (host-module internals) plus negative cases."""
import json

import pytest

from conftest import Host
from handofclient.platform_client import PlatformResult
from handofclient.webhook import sign


def test_signed_out_is_401_before_routing_even_for_unknown_paths(host):
    assert host.call(None, "GET", "api/nope").status == 401
    assert host.call("alice", "GET", "api/nope").status == 404


def test_get_current_user_exception_is_a_500_not_a_leak(tmp_path):
    def boom(_req):
        raise RuntimeError("database down: secret details")

    h = Host(tmp_path, get_current_user=boom)
    res = h.call("alice", "GET", "api/features")
    assert res.status == 500 and res.payload == {"error": "internal", "message": "Internal error."}


def test_malformed_json_is_400(host):
    res = host.module.handle("POST", "api/requests", body=b"{nope", request="alice")
    assert res.status == 400 and res.payload["error"] == "invalid_request"


def test_requires_user_only_skips_the_webhook():
    from handofclient import HostModule

    assert not HostModule.requires_user("POST", "webhook")
    assert not HostModule.requires_user("post", "/webhook/")
    assert HostModule.requires_user("GET", "webhook")
    assert HostModule.requires_user("POST", "api/requests")


def test_pre_resolved_user_skips_get_current_user(tmp_path):
    h = Host(tmp_path, get_current_user=lambda r: pytest.fail("must not be called"))
    res = h.module.handle("GET", "api/features", user={"id": "alice"})
    assert res.status == 200
    assert h.module.handle("GET", "api/features", user=None).status == 401


def test_request_text_and_snapshot_limits(host):
    assert host.call("alice", "POST", "api/requests", {"text": "x" * 20001}).status == 413
    assert host.call("alice", "POST", "api/requests", {"text": "   "}).status == 400
    assert host.call("alice", "POST", "api/requests", {"text": "ok", "snapshot": "no"}).status == 400
    big = {"html": "x" * (2 * 1024 * 1024 + 1)}
    assert host.call("alice", "POST", "api/requests", {"text": "ok", "snapshot": big}).status == 413
    assert host.platform.named("start_build") == []


def test_build_carries_email_and_snapshot_and_change_target(host):
    rid = host.submit("alice", snapshot={"url": "u", "path": "/orders", "html": "<p/>"})
    host.publish(rid)
    name, ref, user, text, mode, snap, feat = host.platform.named("start_build")[0]
    assert user == {"id": "alice", "name": "Alice Owner", "email": "alice@example.com"} and snap["path"] == "/orders" and feat is None
    again = host.submit("alice", "change it", featureId=rid)
    assert host.platform.named("start_build")[1][6] == {"ref": rid, "packageId": f"acme/f-{rid}"}
    assert again != rid


def test_unstarted_build_is_retried_with_the_same_user_details(host):
    host.platform.answers["start_build"] = [PlatformResult(503), PlatformResult(200, {"buildId": "b9"})]
    rid = host.submit()
    assert host.call("alice", "GET", "api/requests").payload["requests"][0]["id"] == rid
    assert host.module.retry_unstarted_builds() == 1
    assert host.module.retry_unstarted_builds() == 0
    assert len(host.platform.named("start_build")) == 2
    assert host.platform.named("start_build")[0][2] == host.platform.named("start_build")[1][2]  # email survives the retry
    with host.storage.transaction() as tx:
        assert tx.get_request(rid).build_id == "b9"


def test_reply_flow_and_negative_cases(host):
    rid = host.submit()
    assert host.call("alice", "POST", f"api/requests/{rid}/reply", {"text": "x"}).payload["error"] == "not_awaiting_reply"
    assert host.event(type="build.status", requestRef=rid, status="NeedsInfo", message="Which?").status == 200
    assert host.call("bob", "POST", f"api/requests/{rid}/reply", {"text": "x"}).status == 404
    assert host.call("alice", "POST", f"api/requests/{rid}/reply", {"text": ""}).status == 400
    ok = host.call("alice", "POST", f"api/requests/{rid}/reply", {"text": "last week"})
    assert ok.status == 200 and ok.payload["status"] == "InProgress" and ok.payload["message"] is None
    assert host.platform.named("reply_to_build") == [("reply_to_build", "b-" + rid, "last week")]


def test_token_never_minted_for_invisible_or_disabled_feature(host):
    rid = host.submit("alice")
    host.publish(rid)
    assert host.call("bob", "GET", "token", query={"featureId": [rid]}).status == 404
    assert host.call("alice", "GET", "token", query={"featureId": [rid]}).status == 200
    assert host.call("alice", "POST", f"api/features/{rid}/enabled", {"enabled": False}).status == 200
    assert host.call("alice", "GET", "token", query={"featureId": [rid]}).status == 404
    assert len(host.platform.named("embed_token")) == 1
    assert host.platform.named("embed_token")[0][1:] == ("alice", f"acme/f-{rid}", "main", "1.0.0")


def test_token_without_feature_id(tmp_path):
    plain = Host(tmp_path)
    assert plain.call("alice", "GET", "token").status == 400
    (tmp_path / "x").mkdir()
    legacy = Host(tmp_path / "x", legacy_package_id="acme/p", legacy_slot_id="main")
    res = legacy.call("alice", "GET", "token")
    assert res.status == 200 and res.payload["userId"] == "alice"
    assert legacy.platform.named("embed_token")[0][1:] == ("alice", "acme/p", "main", None)  # no version: tenant activation


def test_token_platform_failures(host):
    rid = host.submit()
    host.publish(rid)
    host.platform.answers["embed_token"] = PlatformResult(409)
    assert host.call("alice", "GET", "token", query={"featureId": [rid]}).payload["error"] == "version_unavailable"
    host.platform.answers["embed_token"] = PlatformResult(0)
    assert host.call("alice", "GET", "token", query={"featureId": [rid]}).status == 502
    host.platform.answers["embed_token"] = PlatformResult(200, {"nothing": 1})
    assert host.call("alice", "GET", "token", query={"featureId": [rid]}).status == 502


def test_duplicate_event_is_applied_once_and_failed_apply_can_be_retried(host, monkeypatch):
    rid = host.submit()
    ev = {"type": "build.version", "eventId": "evt_dup", "buildId": "b1", "requestRef": rid, "featureRef": rid, "packageId": "p/f", "version": "1.0.0",
          "sha256": "aa", "entry": "index.js", "kind": "page-override", "path": "/p", "slotId": "main", "mode": "inject"}

    def deliver():
        from handofclient.timeutil import now_iso

        raw = json.dumps({**ev, "sentAt": now_iso()}).encode()
        return host.module.handle("POST", "webhook", headers={"x-handofclient-signature": sign("whsec_test", raw)}, body=raw)

    from handofclient.storage.sql import SqlTx

    original = SqlTx.upsert_version
    monkeypatch.setattr(SqlTx, "upsert_version", lambda self, v: (_ for _ in ()).throw(RuntimeError("disk full")))
    assert deliver().status == 500  # the platform will retry...
    monkeypatch.setattr(SqlTx, "upsert_version", original)
    assert deliver().status == 200  # ...and the retry must not be swallowed as a duplicate
    assert deliver().status == 200  # a real duplicate is acknowledged
    assert len(host.call("alice", "GET", f"api/features/{rid}/versions").payload["versions"]) == 1


def test_webhook_rejections_change_nothing(host):
    rid = host.submit()
    raw = json.dumps({"type": "build.status", "requestRef": rid, "status": "Success"}).encode()
    for headers in ({}, {"x-handofclient-signature": "sha256=" + "0" * 64}):
        assert host.module.handle("POST", "webhook", headers=headers, body=raw).status == 401
    assert host.call("alice", "GET", "api/requests").payload["requests"][0]["status"] == "InProgress"


def test_webhook_unknown_and_malformed_events_are_acknowledged_or_400(host):
    for ev in ({"type": "something.new"}, {"type": "activation.changed"}, {"type": "build.status", "requestRef": "nope", "status": "Success"},
               {"type": "build.version", "requestRef": "nope", "featureRef": "f", "version": "1"}, {"type": "build.version"}):
        assert host.event(**ev).status == 200
    raw = b"[1,2]"
    assert host.module.handle("POST", "webhook", headers={"x-handofclient-signature": sign("whsec_test", raw)}, body=raw).status == 400


def test_second_build_version_updates_the_same_feature_without_reassigning(host):
    rid = host.submit("alice")
    host.publish(rid, "1.0.0")
    assert host.call("alice", "POST", f"api/features/{rid}/share", {"userIds": ["bob"]}).status == 200
    host.publish(rid, "1.1.0")
    f = host.call("alice", "GET", "api/features").payload["features"][0]
    assert f["currentVersion"] == "1.1.0" and f["sharing"]["userIds"] == ["alice", "bob"]
    assert host.call("bob", "POST", f"api/features/{rid}/pin", {"version": "1.0.0"}).payload["pinnedVersion"] == "1.0.0"
    assert host.call("bob", "POST", f"api/features/{rid}/pin", {"version": "9.9.9"}).payload["error"] == "version_not_found"


def test_sharing_policies_and_unknown_users(host):
    rid = host.submit("alice")
    host.publish(rid)
    share = lambda who, body: host.call(who, "POST", f"api/features/{rid}/share", body)  # noqa: E731
    assert share("alice", {"userIds": ["nobody-here"]}).status == 400
    assert share("alice", {"everyone": True}).payload["error"] == "sharing_not_allowed"  # default: admins only
    assert share("bob", {"userIds": ["bob"]}).status == 404  # cannot even see it
    assert share("alice", {"userIds": ["bob"], "everyone": True}).status == 400
    assert share("alice", {"userIds": []}).status == 400
    assert share("admin", {"everyone": True}).status == 404  # admins see only what is assigned to them, like anyone
    assert share("alice", {"userIds": ["bob", "bob"]}).payload["sharing"]["userIds"] == ["alice", "bob"]
    assert host.call("bob", "DELETE", f"api/features/{rid}/share/alice").status == 403
    assert host.call("alice", "DELETE", f"api/features/{rid}/share/bob").payload["sharing"]["userIds"] == ["alice"]


def test_user_exists_falls_back_to_find_users_exact_match(tmp_path):
    h = Host(tmp_path, user_exists=None)
    rid = h.submit("alice")
    h.publish(rid)
    share = lambda ids: h.call("alice", "POST", f"api/features/{rid}/share", {"userIds": ids})  # noqa: E731
    assert share(["bo"]).status == 400  # a substring match is not an exact id
    assert share(["bob"]).status == 200


def test_settings_validation_and_secrets_never_returned(host):
    base = {"renderingMode": "iframe", "shareWithNamedUsers": "owner", "shareWithEveryone": "admins", "viewAllRequests": "admins", "dataSources": []}
    put = lambda body, who="admin": host.call(who, "PUT", "api/settings", body)  # noqa: E731
    assert put(base, "alice").status == 403
    assert put({**base, "renderingMode": "weird"}).status == 400
    assert put({**base, "dataSources": [{"name": "a", "baseUrl": "not a url"}]}).status == 400
    assert put({**base, "dataSources": [{"name": "a", "baseUrl": "https://x.example", "auth": {"type": "bearer", "secret": "Bad Name"}}]}).status == 400
    ds = [{"name": "orders", "baseUrl": "https://api.example", "auth": {"type": "bearer", "secret": "orders-key", "secretValue": "s3cr3t"}}]
    res = put({**base, "dataSources": ds})
    assert res.status == 200 and "s3cr3t" not in json.dumps(res.payload) and "s3cr3t" not in json.dumps(host.call("admin", "GET", "api/settings").payload)
    assert host.platform.named("put_secret") == [("put_secret", "orders-key", "s3cr3t", "admin")]
    with host.storage.transaction() as tx:
        assert "s3cr3t" not in json.dumps(tx.get_settings())  # not stored locally either
    host.platform.calls.clear()
    same = [{"name": "orders", "baseUrl": "https://api.example", "auth": {"type": "bearer", "secret": "orders-key"}}]
    assert put({**base, "dataSources": same}).status == 200
    assert host.platform.named("put_data_sources") == []  # unchanged descriptions are not re-pushed
    host.platform.answers["put_data_sources"] = PlatformResult(500)
    assert put({**base, "dataSources": []}).status == 502
    assert host.call("admin", "GET", "api/settings").payload["dataSources"] != []  # not saved
