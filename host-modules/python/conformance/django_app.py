"""Django conformance app (single file, no project scaffolding): python conformance/django_app.py --port 5000."""
import argparse
import sys

import django
import waitress
from django.conf import settings

from conformance_profile import COOKIE, build_module, user_from_cookie

if not settings.configured:
    settings.configure(
        DEBUG=False,
        SECRET_KEY="conformance-only",
        ALLOWED_HOSTS=["*"],
        ROOT_URLCONF="django_app",
        MIDDLEWARE=["django.middleware.csrf.CsrfViewMiddleware"],  # on, to prove the adapter's csrf_exempt option
        USE_TZ=True,
    )
    django.setup()

from django.core.wsgi import get_wsgi_application  # noqa: E402
from django.urls import include, path  # noqa: E402

from handofclient.adapters.django import urls  # noqa: E402

module = build_module(lambda req: user_from_cookie(req.COOKIES.get(COOKIE)))
urlpatterns = [path("hoc/", include(urls(module, csrf_exempt=True)))]

if __name__ == "__main__":
    sys.modules["django_app"] = sys.modules["__main__"]
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5000)
    waitress.serve(get_wsgi_application(), host="127.0.0.1", port=ap.parse_args().port, threads=8)
