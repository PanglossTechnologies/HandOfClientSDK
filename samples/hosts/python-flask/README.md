# Python (Flask) host sample

A complete HandOfClient host in about 250 lines of Flask: sign-in, a request box on every page, "My features",
an admin page, one page a feature can replace (`/orders`), one data source (`/api/orders`), `hoc-head.js`, a
Content-Security-Policy that works with all of it, and the catch-all route for new pages. The platform side
(`/hoc/token`, `/hoc/api/*`, `/hoc/webhook`, storage, builds) is the `handofclient` package; this app is the
part that is yours. Read [`docs/integration-guide.md`](../../../docs/integration-guide.md) for the why.

## Run it locally (no account needed)

Needs Python 3.9+ and Node 20+. From this folder:

```
# 1. browser files (once): build them in this repo, or use `python fetch_assets.py --release` when a release has them
(cd ../../.. && npm install && npm run build)
python fetch_assets.py

# 2. Python deps (from this checkout; `pip install handofclient` once it is on PyPI)
python -m venv .venv && . .venv/bin/activate          # Windows: .venv\Scripts\Activate.ps1
pip install ../../../host-modules/python -r requirements.txt

# 3. terminal 1: the local stand-in for the platform (prints the values terminal 2 uses)
node ../../../host-modules/conformance/fake-platform/cli.mjs --webhook-url http://127.0.0.1:5000/hoc/webhook --auto-build

# 4. terminal 2: the app
export HOC_API_BASE_URL=http://127.0.0.1:4010 HOC_TENANT_ID=conformance-tenant
export HOC_HOST_API_KEY=conformance-host-api-key HOC_WEBHOOK_SECRET=whsec_conformance
export FLASK_SECRET_KEY=dev-only
flask --app app run --port 5000
```

PowerShell: `$env:HOC_API_BASE_URL = "http://127.0.0.1:4010"` and so on for each variable.

Open http://127.0.0.1:5000 and walk the loop:

1. Sign in as `alice` / `demo` (also `bob` and `admin`, same password).
2. Click **Orders**, type a request into the box ("show overdue orders first") and send it.
3. A moment later **My features** lists the request as ready, with its version. Click **Orders** again: the feature
   applies to alice (the fake platform's placeholder bundle changes nothing visible; the guide shows how to publish
   a bundle that does).
4. Sign out, sign in as `bob`, open **Orders**: the original page. Alice's feature is visible only to alice until she
   shares it.
5. As `admin`, **Admin** has the settings, every request and feature, and the data sources editor.

## Against the real platform

Set the same variables to the values you were given (`apiBaseUrl`, `tenantId`, host API key, webhook
secret; see the guide, section 1), run the app where the platform can reach `https://your-host/hoc/webhook`
(registered as your webhook URL), and leave the fake platform out. Optional: `HOC_EMBED_ORIGIN` if feature bundles
are served from an origin other than `HOC_API_BASE_URL`, `HOC_DB` for the SQLite file (default `hoc.db` next to
`app.py`).

The data source: in **Admin -> Data sources** add `orders-api`, base URL `https://your-host`, bearer secret name
`orders-api-key` with a long random secret value (and set `HOC_DATA_TOKEN` to that same value so `/api/orders` accepts the
platform's proxy), and paste `orders-openapi.json` into the OpenAPI box.

## Tests

```
pip install pytest && python -m pytest tests -q                       # request -> built -> only the requester, against the fake platform
node --test tests/browser.test.mjs                                    # the same in Chrome at desktop and iPhone viewports, under the real CSP
```

(`HOC_PYTHON=/path/to/venv/python` tells the browser test which Python to use.)

## What is demo-only

Replace before production: the `USERS` table and password check, `ORDERS` (your data), the `Origin`-check CSRF
guard (use your framework's CSRF protection), and serve over HTTPS. Keep `HOC_HOST_API_KEY` and
`HOC_WEBHOOK_SECRET` in your secret store. `embed.global.js` and `hoc-head.min.js` are served by your own app
(`static/`); the platform does not host them.
