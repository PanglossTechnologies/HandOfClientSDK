"""Flask adapter::

    from handofclient.adapters.flask import blueprint
    app.register_blueprint(blueprint(module), url_prefix="/hoc")
"""
from __future__ import annotations

from typing import Any

from ..core import RESPONSE_HEADERS, HostModule

_METHODS = ["GET", "POST", "PUT", "DELETE"]


def blueprint(module: HostModule, name: str = "handofclient") -> Any:
    from flask import Blueprint, Response, request  # imported here so the package works without Flask installed

    bp = Blueprint(name, __name__)

    @bp.route("/<path:subpath>", methods=_METHODS)
    def hoc(subpath: str) -> Any:
        res = module.handle(
            request.method,
            subpath,
            query=dict(request.args.lists()),
            headers={k.lower(): v for k, v in request.headers.items()},
            body=request.get_data(),
            request=request,
        )
        return Response(res.body(), status=res.status, headers=RESPONSE_HEADERS)

    return bp
