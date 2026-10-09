"""Django adapter::

    # urls.py
    from django.urls import include, path
    from handofclient.adapters.django import urls
    urlpatterns = [path("hoc/", include(urls(module)))]

Django's CSRF middleware applies to the non-GET calls like any other view: have your page script send the
CSRF header (``embed.js`` lets you replace ``fetch``), or pass ``csrf_exempt=True`` if the site's session cookie
is ``SameSite=Lax`` and you accept that.
"""
from __future__ import annotations

from typing import Any, List

from ..core import RESPONSE_HEADERS, HostModule


def urls(module: HostModule, csrf_exempt: bool = False) -> List[Any]:
    from django.http import HttpResponse
    from django.urls import re_path
    from django.views.decorators.csrf import csrf_exempt as exempt

    def hoc(request: Any, subpath: str) -> Any:
        res = module.handle(
            request.method,
            subpath,
            query={k: v for k, v in request.GET.lists()},
            headers={k.lower(): v for k, v in request.headers.items()},
            body=request.body,
            request=request,
        )
        out = HttpResponse(res.body(), status=res.status)
        for k, v in RESPONSE_HEADERS.items():
            out[k] = v
        return out

    return [
        re_path(r"^(?P<subpath>webhook)/?$", exempt(hoc)),
        re_path(r"^(?P<subpath>.*)$", exempt(hoc) if csrf_exempt else hoc),
    ]
