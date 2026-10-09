"""Client for the platform calls a site makes (``/host/v1``, authenticated with the host API key).

Standard library only (``urllib``), so the package has no dependencies. Replace it by passing any object with
the same methods to :class:`handofclient.HostModule` (the tests do).
"""
from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

log = logging.getLogger("handofclient.platform")


@dataclass
class PlatformResult:
    """``status`` is 0 when the platform could not be reached at all."""

    status: int
    body: Any = None

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300


class PlatformClient:
    def __init__(self, base_url: str, api_key: str, tenant_id: str, timeout: float = 10.0) -> None:
        if not base_url or not api_key or not tenant_id:
            raise ValueError("PlatformClient needs base_url, api_key and tenant_id")
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.tenant_id = tenant_id
        self.timeout = timeout

    def _call(self, method: str, path: str, body: Optional[Dict[str, Any]] = None) -> PlatformResult:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(
            self.base_url + path,
            data=data,
            method=method,
            headers={"x-api-key": self.api_key, "content-type": "application/json", "accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:  # noqa: S310 - base_url is operator configuration
                status, raw = res.status, res.read()
        except urllib.error.HTTPError as e:
            status, raw = e.code, e.read()
        except Exception:  # noqa: BLE001 - connection refused, DNS, timeout...
            log.exception("platform call %s %s failed", method, path)
            return PlatformResult(0)
        try:
            parsed = json.loads(raw.decode("utf-8")) if raw else None
        except ValueError:
            parsed = None
        if status >= 400:
            log.warning("platform call %s %s answered %s", method, path, status)
        return PlatformResult(status, parsed)

    def start_build(
        self,
        request_ref: str,
        user: Dict[str, Any],
        text: str,
        mode: str,
        snapshot: Optional[Dict[str, Any]] = None,
        feature: Optional[Dict[str, str]] = None,
    ) -> PlatformResult:
        body: Dict[str, Any] = {"tenantId": self.tenant_id, "requestRef": request_ref, "user": user, "text": text, "mode": mode}
        if snapshot:
            body["snapshot"] = snapshot
        if feature:
            body["feature"] = feature
        return self._call("POST", "/host/v1/builds", body)

    def reply_to_build(self, build_id: str, text: str) -> PlatformResult:
        return self._call("POST", f"/host/v1/builds/{build_id}/reply", {"text": text})

    def embed_token(self, user_id: str, package_id: str, slot_id: str, version: Optional[str]) -> PlatformResult:
        body: Dict[str, Any] = {"tenantId": self.tenant_id, "userId": user_id, "packageId": package_id, "slotId": slot_id}
        if version is not None:
            body["version"] = version
        return self._call("POST", "/host/v1/embed-token", body)

    def put_secret(self, name: str, value: str, updated_by: str) -> PlatformResult:
        return self._call("PUT", "/host/v1/secrets", {"tenantId": self.tenant_id, "name": name, "value": value, "updatedBy": updated_by})

    def put_data_sources(self, data_sources: List[Dict[str, Any]]) -> PlatformResult:
        return self._call("PUT", "/host/v1/data-sources", {"tenantId": self.tenant_id, "dataSources": data_sources})
