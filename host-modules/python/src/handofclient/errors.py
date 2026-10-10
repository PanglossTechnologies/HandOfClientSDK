"""Error type carrying the contract's stable error code and HTTP status (see openapi/site-hoc-api.yaml)."""
from __future__ import annotations

from typing import Any, Dict, List, Optional


class HocError(Exception):
    """Raised anywhere inside request handling; becomes ``{"error": code, "message": message}`` with ``status``.

    ``field``/``reason`` (plus ``values``/``limit``) are machine-readable debugging detail, no human text:
    which input was wrong and why. ``platform`` is what the platform answered when a platform call failed
    (``{"status": 0}`` means it could not be reached).
    """

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        field: Optional[str] = None,
        reason: Optional[str] = None,
        values: Optional[List[str]] = None,
        limit: Optional[int] = None,
        platform: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.field = field
        self.reason = reason
        self.values = values
        self.limit = limit
        self.platform = platform

    def to_payload(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"error": self.code, "message": self.message}
        if self.field is not None:
            out["field"] = self.field
            out["reason"] = self.reason
            if self.values:
                out["values"] = self.values
            if self.limit is not None:
                out["limit"] = self.limit
        if self.platform is not None:
            out["platform"] = self.platform
        return out


def platform_failure(res: Any) -> Dict[str, Any]:
    """Distil a failed platform call (``.status``/``.body``) into the ``platform`` block of an error."""
    out: Dict[str, Any] = {"status": res.status}
    b = res.body
    if isinstance(b, dict):
        if isinstance(b.get("error"), str):
            out["error"] = b["error"]
        if isinstance(b.get("field"), str):
            out["field"] = b["field"]
        if isinstance(b.get("reason"), str):
            out["reason"] = b["reason"]
        if isinstance(b.get("values"), list):
            out["values"] = [str(v) for v in b["values"]]
        if isinstance(b.get("limit"), int) and not isinstance(b["limit"], bool):
            out["limit"] = b["limit"]
    return out


def unauthenticated() -> HocError:
    return HocError(401, "unauthenticated", "Please sign in.")


def invalid(message: str, field: str, reason: str, values: Optional[List[str]] = None, limit: Optional[int] = None) -> HocError:
    return HocError(400, "invalid_request", message, field, reason, values, limit)


def not_found(message: str = "No such feature.") -> HocError:
    return HocError(404, "not_found", message)


def forbidden(message: str = "You are not allowed to do this.") -> HocError:
    return HocError(403, "forbidden", message)


def platform_unavailable(res: Any = None) -> HocError:
    return HocError(
        502, "platform_unavailable", "The HandOfClient platform could not be reached.",
        platform=platform_failure(res) if res is not None else None,
    )
