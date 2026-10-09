"""A complete HandOfClient host in Flask: sign-in, a request box, "my features", an admin page, one page a
feature can replace (/orders) and one data source (/api/orders).

What the SDK does for you: ``handofclient`` serves ``/hoc/token``, ``/hoc/api/*`` and ``/hoc/webhook`` from your
database and calls the platform. What this file is: your side of the contract.

  1. who is signed in            -> get_current_user / is_admin / find_users (the three functions below)
  2. pages that load embed.js    -> templates/ (the layout loads hoc-head.js, embed.js and static/site.js)
  3. a Content-Security-Policy   -> csp() below; inject mode needs the embed origin in script-src
  4. one catch-all for new pages -> /ext/<path>
  5. (optional) a data source    -> /api/orders, described in orders-openapi.json

Everything marked DEMO is there so the sample runs on its own: replace it with your real auth and data.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

from flask import Flask, Response, abort, jsonify, redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

from handofclient import HostModule, PlatformClient, SqlStorage
from handofclient.adapters.flask import blueprint

HERE = Path(__file__).resolve().parent
log = logging.getLogger("sample")

# --- DEMO: users and data. Replace with your user store and your database. -------------------------------------
USERS: Dict[str, Dict[str, Any]] = {
    "alice": {"name": "Alice Owner", "password_hash": generate_password_hash("demo")},
    "bob": {"name": "Bob Builder", "password_hash": generate_password_hash("demo")},
    "admin": {"name": "Ada Admin", "password_hash": generate_password_hash("demo")},
}
ADMINS = {"admin"}
ORDERS: List[Dict[str, Any]] = [
    {"id": 1001, "owner": "alice", "customer": "Northwind", "total": 120.50, "status": "open"},
    {"id": 1002, "owner": "alice", "customer": "Contoso", "total": 89.00, "status": "shipped"},
    {"id": 1003, "owner": "bob", "customer": "Fabrikam", "total": 410.25, "status": "open"},
]


def orders_for(user_id: str) -> List[Dict[str, Any]]:
    return [o for o in ORDERS if user_id in ADMINS or o["owner"] == user_id]


# --- configuration ---------------------------------------------------------------------------------------------
REQUIRED = ("HOC_API_BASE_URL", "HOC_TENANT_ID", "HOC_HOST_API_KEY", "HOC_WEBHOOK_SECRET", "FLASK_SECRET_KEY")


def load_config(overrides: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """Settings come from the environment (see README). The host API key and webhook secret are secrets."""
    src = {**os.environ, **(overrides or {})}
    missing = [k for k in REQUIRED if not src.get(k)]
    if missing:
        raise RuntimeError("Set these environment variables (see README.md): " + ", ".join(missing))
    cfg = {k: src[k] for k in REQUIRED}
    cfg["HOC_API_BASE_URL"] = cfg["HOC_API_BASE_URL"].rstrip("/")
    cfg["HOC_EMBED_ORIGIN"] = src.get("HOC_EMBED_ORIGIN", cfg["HOC_API_BASE_URL"]).rstrip("/")
    cfg["HOC_DB"] = src.get("HOC_DB", str(HERE / "hoc.db"))
    cfg["HOC_DATA_TOKEN"] = src.get("HOC_DATA_TOKEN", "")  # bearer token the platform's egress proxy sends to /api/orders
    return cfg


def read_asset(name: str) -> str:
    path = HERE / "static" / name
    if not path.exists():
        raise RuntimeError(f"static/{name} is missing. Run: python fetch_assets.py")
    return path.read_text(encoding="utf-8")


def create_app(overrides: Optional[Dict[str, str]] = None) -> Flask:
    cfg = load_config(overrides)
    read_asset("embed.global.js")  # fail at start-up, not on the first page
    hoc_head = read_asset("hoc-head.min.js").strip()
    hoc_head_hash = "sha256-" + base64.b64encode(hashlib.sha256(hoc_head.encode("utf-8")).digest()).decode()

    app = Flask(__name__)
    app.secret_key = cfg["FLASK_SECRET_KEY"]
    app.config.update(SESSION_COOKIE_SAMESITE="Lax", SESSION_COOKIE_HTTPONLY=True)

    # --- 1. who is signed in --------------------------------------------------------------------------------
    def get_current_user(req: Any) -> Optional[Dict[str, Any]]:
        """The ONLY source of identity. Must come from something the browser cannot forge (a signed session)."""
        uid = session.get("user_id")
        user = USERS.get(uid) if uid else None
        return {"id": uid, "name": user["name"]} if user else None

    def is_admin(user: Dict[str, Any]) -> bool:
        return user["id"] in ADMINS

    def find_users(query: str) -> List[Dict[str, Any]]:
        q = query.lower()
        return [{"id": uid, "name": u["name"]} for uid, u in USERS.items() if q in uid.lower() or q in u["name"].lower()]

    module = HostModule(
        storage=SqlStorage.sqlite(cfg["HOC_DB"]),
        platform=PlatformClient(cfg["HOC_API_BASE_URL"], cfg["HOC_HOST_API_KEY"], cfg["HOC_TENANT_ID"]),
        webhook_secret=cfg["HOC_WEBHOOK_SECRET"],
        get_current_user=get_current_user,
        is_admin=is_admin,
        find_users=find_users,
        user_exists=lambda uid: uid in USERS,
    )

    # Mount token + api + webhook under /hoc. Flask has no CSRF protection of its own: SameSite=Lax cookies plus this
    # Origin check stop other sites from posting as the signed-in user. The webhook is signed by the platform instead.
    hoc = blueprint(module)

    @hoc.before_request
    def same_origin_only() -> Any:
        if request.method in ("GET", "HEAD", "OPTIONS") or request.path.endswith("/webhook"):
            return None
        origin = request.headers.get("Origin")
        if origin is not None and origin != request.host_url.rstrip("/"):
            return jsonify(error="forbidden", message="Cross-origin request refused."), 403
        return None

    app.register_blueprint(hoc, url_prefix="/hoc")

    # --- 3. Content-Security-Policy -------------------------------------------------------------------------
    embed_origin = cfg["HOC_EMBED_ORIGIN"]
    parsed = urlparse(embed_origin)
    embed_origin = f"{parsed.scheme}://{parsed.netloc}"
    csp_value = "; ".join(
        [
            "default-src 'self'",
            # 'self' = embed.js and site.js. The hash = the inline hoc-head.js snippet. embed_origin = inject-mode bundles.
            f"script-src 'self' '{hoc_head_hash}' {embed_origin}",
            "style-src 'self' 'unsafe-inline'",  # hoc-head.js and the browser components insert <style> elements
            f"frame-src {embed_origin}",  # iframe-mode features
            "connect-src 'self'",  # every browser call goes to this site's /hoc/*
            "img-src 'self' data:",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'self'",
        ]
    )

    @app.after_request
    def add_security_headers(resp: Response) -> Response:
        resp.headers["Content-Security-Policy"] = csp_value
        resp.headers["X-Content-Type-Options"] = "nosniff"
        return resp

    @app.context_processor
    def layout_values() -> Dict[str, Any]:
        uid = session.get("user_id")
        user = USERS.get(uid) if uid else None
        return {
            "user": {"id": uid, "name": user["name"], "admin": uid in ADMINS} if user else None,
            "hoc_head": hoc_head,
            "api_base_url": cfg["HOC_API_BASE_URL"],
            "embed_origin": embed_origin,
        }

    def signed_in() -> Optional[str]:
        uid = session.get("user_id")
        return uid if uid in USERS else None

    # --- 2. pages --------------------------------------------------------------------------------------------
    @app.get("/")
    def home() -> Any:
        return render_template("home.html")

    @app.route("/login", methods=["GET", "POST"])
    def login() -> Any:
        error = None
        if request.method == "POST":
            uid = request.form.get("username", "").strip().lower()
            user = USERS.get(uid)
            if user and check_password_hash(user["password_hash"], request.form.get("password", "")):
                session.clear()
                session["user_id"] = uid
                return redirect(url_for("home"))
            error = "Wrong username or password."
        return render_template("login.html", error=error), (401 if error else 200)

    @app.post("/logout")
    def logout() -> Any:
        if request.headers.get("Origin") not in (None, request.host_url.rstrip("/")):
            abort(403)
        session.clear()
        return redirect(url_for("home"))

    @app.get("/orders")
    def orders() -> Any:
        """The page a feature can replace. Its original content is what users see until a feature applies."""
        uid = signed_in()
        if not uid:
            return redirect(url_for("login"))
        return render_template("orders.html", orders=orders_for(uid))

    @app.get("/my-features")
    def my_features() -> Any:
        return render_template("my_features.html") if signed_in() else redirect(url_for("login"))

    @app.get("/admin")
    def admin() -> Any:
        uid = signed_in()
        if not uid:
            return redirect(url_for("login"))
        if uid not in ADMINS:
            abort(403)  # the API answers 403 to non-admins as well; this just keeps the page away from them
        return render_template("admin.html")

    @app.get("/ext/<path:rest>")
    def ext(rest: str) -> Any:
        """Catch-all for `new-page` features: an empty page that loads embed.js. Unknown paths get the site's own 404."""
        uid = signed_in()
        if not uid:
            return redirect(url_for("login"))
        res = module.handle("GET", "api/resolve", query={"path": ["/ext/" + rest]}, request=request)
        found = res.status == 200 and any(f.get("kind") == "new-page" for f in (res.payload or {}).get("features", []))
        if not found:
            abort(404)
        return render_template("ext.html")

    # --- 5. a data source ------------------------------------------------------------------------------------
    @app.get("/api/orders")
    def api_orders() -> Any:
        """Signed-in users get their own orders. The platform's egress proxy (iframe mode) calls this with
        `Authorization: Bearer <HOC_DATA_TOKEN>`, the credential stored under the data source's vault secret."""
        auth = request.headers.get("Authorization", "")
        token = cfg["HOC_DATA_TOKEN"]
        if token and hmac.compare_digest(auth, f"Bearer {token}"):
            return jsonify(ORDERS)
        uid = signed_in()
        if not uid:
            return jsonify(error="not signed in"), 401
        return jsonify(orders_for(uid))

    log.info("host module ready: platform %s, tenant %s", cfg["HOC_API_BASE_URL"], cfg["HOC_TENANT_ID"])
    return app


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    create_app().run(port=int(os.environ.get("PORT", "5000")))
