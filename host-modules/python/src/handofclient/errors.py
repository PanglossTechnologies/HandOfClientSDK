"""Error type carrying the contract's stable error code and HTTP status (see openapi/site-hoc-api.yaml)."""
from __future__ import annotations


class HocError(Exception):
    """Raised anywhere inside request handling; becomes ``{"error": code, "message": message}`` with ``status``."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def unauthenticated() -> HocError:
    return HocError(401, "unauthenticated", "Please sign in.")


def invalid(message: str) -> HocError:
    return HocError(400, "invalid_request", message)


def not_found(message: str = "No such feature.") -> HocError:
    return HocError(404, "not_found", message)


def forbidden(message: str = "You are not allowed to do this.") -> HocError:
    return HocError(403, "forbidden", message)


def platform_unavailable() -> HocError:
    return HocError(502, "platform_unavailable", "The HandOfClient platform could not be reached.")
