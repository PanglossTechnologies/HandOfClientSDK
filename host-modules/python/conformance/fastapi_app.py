"""FastAPI conformance app: python conformance/fastapi_app.py --port 5000 (async get_current_user, no user_exists)."""
import argparse

import uvicorn
from fastapi import FastAPI

from handofclient.adapters.fastapi import router
from conformance_profile import COOKIE, build_module, user_from_cookie


def create_app() -> FastAPI:
    app = FastAPI()

    async def current_user(req):  # async on purpose: the adapter must accept it
        return user_from_cookie(req.cookies.get(COOKIE))

    # No user_exists here: sharing falls back to asking find_users for the exact id.
    app.include_router(router(build_module(current_user, explicit_user_exists=False)), prefix="/hoc")
    return app


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5000)
    uvicorn.run(create_app(), host="127.0.0.1", port=ap.parse_args().port, log_level="warning")
