"""Flask conformance app: python conformance/flask_app.py --port 5000 (db: HOC_CONFORMANCE_DB)."""
import argparse

import waitress
from flask import Flask, request

from handofclient.adapters.flask import blueprint
from conformance_profile import COOKIE, build_module, user_from_cookie


def create_app() -> Flask:
    app = Flask(__name__)
    module = build_module(lambda req: user_from_cookie(req.cookies.get(COOKIE)))
    app.register_blueprint(blueprint(module), url_prefix="/hoc")
    return app


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5000)
    waitress.serve(create_app(), host="127.0.0.1", port=ap.parse_args().port, threads=8)
