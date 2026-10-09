"""FastAPI / Starlette adapter::

    from handofclient.adapters.fastapi import router
    app.include_router(router(module), prefix="/hoc")

``get_current_user`` may be a plain or an ``async`` function (it runs in the event loop). ``is_admin``,
``find_users`` and ``user_exists`` run in a worker thread, so they must be plain functions.
"""

import inspect
import logging
from typing import Any

from ..core import RESPONSE_HEADERS, HostModule

log = logging.getLogger("handofclient")


def router(module: HostModule) -> Any:
    from fastapi import APIRouter, Request
    from fastapi.concurrency import run_in_threadpool
    from starlette.responses import Response

    api = APIRouter()

    @api.api_route("/{subpath:path}", methods=["GET", "POST", "PUT", "DELETE"], include_in_schema=False)
    async def hoc(subpath: str, request: Request) -> Response:
        kwargs = {}  # type: dict
        if module.requires_user(request.method, subpath):
            try:
                user = module.get_current_user(request)
                if inspect.isawaitable(user):
                    user = await user
            except Exception:  # noqa: BLE001
                log.exception("get_current_user failed")
                return Response(b'{"error":"internal","message":"Internal error."}', status_code=500, headers=RESPONSE_HEADERS)
            kwargs["user"] = user
        body = await request.body()
        res = await run_in_threadpool(
            module.handle,
            request.method,
            subpath,
            query={k: request.query_params.getlist(k) for k in request.query_params.keys()},
            headers={k.lower(): v for k, v in request.headers.items()},
            body=body,
            request=request,
            **kwargs,
        )
        return Response(res.body(), status_code=res.status, headers=RESPONSE_HEADERS)

    return api
