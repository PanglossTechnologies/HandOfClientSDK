"""Minimal HandOfClient host in Flask: the same-origin token endpoint plus a page that mounts a plugin.

The platform needs three things from a host (see docs/postmessage-protocol.md):
  1. a page that loads embed.js and mounts a plugin,
  2. a same-origin token endpoint (this file, /hoc/token),
  3. optionally, webhooks.

The host API key lives only here, on the server. Never send it to the browser, and never take the
user id from the request - derive it from your own login session (current_user() below).
"""
import os

import requests
from flask import Flask, jsonify, session

PLATFORM = os.environ["HOC_API_BASE_URL"].rstrip("/")  # e.g. https://hocapi.panglosstechnologies.com
HOST_API_KEY = os.environ["HOC_HOST_API_KEY"]
EMBED_ORIGIN = os.environ.get("HOC_EMBED_ORIGIN", PLATFORM)
HOST_ID = os.environ["HOC_HOST_ID"]
TENANT_ID = os.environ["HOC_TENANT_ID"]
PACKAGE_ID = os.environ.get("HOC_PACKAGE_ID", "handofclient/hello-world")
SLOT_ID = os.environ.get("HOC_SLOT_ID", "main-panel")

app = Flask(__name__)
app.secret_key = os.environ["FLASK_SECRET_KEY"]


def current_user():
    """REPLACE THIS with your app's real auth. Return (user_id, display_name) or None.

    Whatever you use (Flask-Login, JWT cookie, SSO header from a trusted proxy), the id must come from
    something the browser cannot forge.
    """
    uid = session.get("user_id")
    return (uid, session.get("display_name", uid)) if uid else None


@app.get("/hoc/token")
def token():
    user = current_user()
    if user is None:
        return jsonify(error="not signed in"), 401
    user_id, display_name = user

    resp = requests.post(
        f"{PLATFORM}/host/v1/embed-token",
        headers={"x-api-key": HOST_API_KEY},
        json={"tenantId": TENANT_ID, "userId": str(user_id), "packageId": PACKAGE_ID, "slotId": SLOT_ID},
        timeout=10,
    )
    if resp.status_code == 412:
        return jsonify(error="plugin is not activated for this tenant"), 412
    if not resp.ok:
        app.logger.error("embed-token failed: %s %s", resp.status_code, resp.text[:300])
        return jsonify(error="token service unavailable"), 502
    body = resp.json()
    return jsonify(token=body["token"], expiresAt=body["expiresAt"], userId=str(user_id), displayName=display_name)


@app.get("/dashboard")
def dashboard():
    if current_user() is None:
        return "Sign in first", 401
    return f"""<!doctype html>
<html><body>
<div id="hoc-panel" style="height:600px"></div>
<script src="static/embed.global.js"></script>
<script>
  HandOfClient.configure({{ apiBaseUrl: "{PLATFORM}", embedOrigin: "{EMBED_ORIGIN}" }});
  HandOfClient.mount(document.getElementById("hoc-panel"), {{
    hostId: "{HOST_ID}", tenantId: "{TENANT_ID}", packageId: "{PACKAGE_ID}", slotId: "{SLOT_ID}",
    tokenUrl: "hoc/token"
  }});
</script>
</body></html>"""


@app.get("/dev-login/<user_id>")
def dev_login(user_id):
    """Demo only - delete this. Lets you try the sample without an auth system."""
    if os.environ.get("FLASK_DEBUG") != "1":
        return "disabled", 404
    session["user_id"] = user_id
    return "ok"


if __name__ == "__main__":
    app.run(port=5000)
