# Integration guide: let your users request features and see them built

A signed-in user of your site types "I want X" into a box on a page. The request is built automatically.
When it is ready, your site looks changed for that user only, without you shipping a release. They can keep an
older version for themselves, share the feature with others (as your rules allow) and ask for changes.

You do this in your own backend language. Your site keeps the data; HandOfClient builds the feature, stores its
versions and signs the tokens that let a page load them.

```
browser                       your site (host module)                   HandOfClient platform
-------                       -----------------------                   ---------------------
<hoc-request-feature> ------> POST hoc/api/requests  (stored here) ---> POST /host/v1/builds
                                                                        ... the feature is built ...
                              POST hoc/webhook  <------ signed events -- build.status, build.version
                              (records the version, assigns it to the requester)
every page load:
embed.js -------------------> GET hoc/api/resolve?path=...   what applies to me here?
         -------------------> GET hoc/token?featureId=...  ----------> POST /host/v1/embed-token
         <-- loads the feature (inject: a script from the platform; iframe: a sandboxed frame) --
```

The browser only ever talks to your site (`hoc/*`) and to the feature it loads. The host API key never leaves your
server.

## 1. What you need from us

Access is by request: email support@panglosstechnologies.com with your company, site URL(s), backend language,
and the public URL of your webhook endpoint (`https://your-site/hoc/webhook`). You get back, per environment:

| Value | Used for |
|---|---|
| `apiBaseUrl` | Platform API base. Also the default `embedOrigin` (where feature bundles are served from). |
| `hostId`, `tenantId` | Identify your site and your tenant. Public. |
| host API key | Secret. Server side only; sent as `x-api-key` on every platform call. |
| webhook secret | Secret. Returned once, when your webhook URL is registered. Verifies the events we send you. |

Tell us every origin your pages are served from (for example `https://www.example.com` and
`https://app.example.com`): feature bundles in inject mode are served with CORS for those origins only. Adding an
origin later is a request to us, so list staging as well.

You do not need any of this to start: section 2 runs the whole loop locally against a stand-in platform.

## 2. Try it locally (no account, no platform)

`host-modules/conformance/fake-platform` is a local stand-in for the platform. It validates builds like the real
one, mints real embed tokens, sends signed webhooks to your site, and with `--auto-build` answers every request
with a placeholder version a moment later, so request -> build -> visible works end to end. Needs Node 20+.

```
node host-modules/conformance/fake-platform/cli.mjs --webhook-url http://127.0.0.1:5000/hoc/webhook --auto-build
```

It prints the values to give your site: the API base URL (`http://127.0.0.1:4010` by default), host API key
(`conformance-host-api-key`), tenant id (`conformance-tenant`) and webhook secret (`whsec_conformance`). Use
`--port`, `--api-key`, `--webhook-secret`, `--tenant-id` and `--host-id` to change them.

What it does not do: persist anything, run a real build (the placeholder bundle changes nothing on the page; see
"Publish a visible change" below), or require tenant activation. Its control API (`/_fake/*`) lists the calls it
received and publishes versions or withdraws them on demand; see
[`host-modules/conformance/README.md`](../host-modules/conformance/README.md).

### The Flask walkthrough

[`samples/hosts/python-flask`](../samples/hosts/python-flask) is a complete host: sign-in, request box, "my
features", an admin page, an overridable page and a data source. Its README has the commands. To start from your own
app instead, here is the whole integration in Flask; the rest of this guide explains each piece.

```
pip install handofclient flask        # from a checkout of this repo: pip install ./host-modules/python flask
```

```python
# app.py
import os
from flask import Flask, session
from handofclient import HostModule, PlatformClient, SqlStorage
from handofclient.adapters.flask import blueprint

app = Flask(__name__)
app.secret_key = os.environ["FLASK_SECRET_KEY"]

USERS = {"alice": "Alice", "bob": "Bob", "admin": "Ada"}          # your user store goes here


def current_user(request):
    uid = session.get("user_id")                                  # from YOUR session; never from the request
    return {"id": uid, "name": USERS[uid]} if uid in USERS else None


module = HostModule(
    storage=SqlStorage.sqlite("hoc.db"),                          # your database; creates its own hoc_* tables
    platform=PlatformClient(os.environ["HOC_API_BASE_URL"], os.environ["HOC_HOST_API_KEY"], os.environ["HOC_TENANT_ID"]),
    webhook_secret=os.environ["HOC_WEBHOOK_SECRET"],
    get_current_user=current_user,
    is_admin=lambda user: user["id"] == "admin",
    find_users=lambda q: [{"id": i, "name": n} for i, n in USERS.items() if q.lower() in (i + n).lower()],
)
app.register_blueprint(blueprint(module), url_prefix="/hoc")      # hoc/token, hoc/api/*, hoc/webhook


@app.get("/dev-login/<user_id>")                                  # walkthrough only: delete it, use your real sign-in
def dev_login(user_id):
    session["user_id"] = user_id
    return "ok"


@app.get("/orders")                                               # any page of yours
def orders():
    return PAGE   # the layout of section 4, with <hoc-request-feature></hoc-request-feature> somewhere in the body
```

Get `embed.global.js` and `hoc-head.min.js` into your static folder (section 4 says where they come from), run
the fake platform as above with `--webhook-url http://127.0.0.1:5000/hoc/webhook`, then:

```
export HOC_API_BASE_URL=http://127.0.0.1:4010 HOC_HOST_API_KEY=conformance-host-api-key
export HOC_TENANT_ID=conformance-tenant HOC_WEBHOOK_SECRET=whsec_conformance
export FLASK_SECRET_KEY=dev-only
flask --app app run --port 5000
```

1. Visit `/dev-login/alice`, then `/orders`. Type a request into the box and send it.
2. A moment later `GET /hoc/api/features` (as alice) lists the new feature, and reloading `/orders` applies it.
3. `/dev-login/bob`, then `/orders`: bob sees the original page, and `GET /hoc/api/features` is empty. Only the
   requester sees it, until the feature is shared.

### Publish a visible change

The placeholder bundle does nothing visible. To see a page change, publish a bundle that edits the page. In inject
mode the bundle is a plain script that reads `window.HandOfClientInject.pending` synchronously (see
[`page-lookup.md`](page-lookup.md)); use the request's id (`requestRef`) from `GET /_fake/builds`:

```
curl -X POST http://127.0.0.1:4010/_fake/publish -H "content-type: application/json" -d '{
  "requestRef": "<request id>", "version": "1.0.0", "path": "/orders", "kind": "page-override", "mode": "inject",
  "content": "const ctx = window.HandOfClientInject.pending; document.querySelector(\"h1\").textContent += \" (changed)\";"
}'
```

(Start the fake platform without `--auto-build` if you want to publish your own versions.)

## 3. The three functions you write

| Function | Gets | Returns |
|---|---|---|
| `get_current_user(request)` | your framework's request | `{id, name?, email?}` for the signed-in user, or nothing (every call is then `401`) |
| `is_admin(user)` | what `get_current_user` returned | whether this user may change settings, roll features back for everyone and see everyone's requests |
| `find_users(query)` | text typed in the share picker | `[{id, name}]` of matching users (the module hides the caller) |

`get_current_user` is the **only** source of identity. User ids in bodies, queries and headers are never trusted.
Whatever you use (Flask-Login, a JWT cookie, an SSO header from a proxy you control), the id must come from
something the browser cannot forge. Optional `user_exists(user_id)` rejects unknown ids when sharing.

Storage: SQLite (WAL), PostgreSQL or MySQL/MariaDB, in your database, in tables prefixed `hoc_`; the module creates
and upgrades them itself. Frameworks: Flask, Django and FastAPI for Python; the Node (Express, Fastify, `node:http`)
and PHP (plain PHP, Laravel) modules in `host-modules/` follow the same shape. Per-language details are in each
module's README.

## 4. Pages: what goes in your layout

Get the two browser files, once, into your static folder (your app serves them; the platform does not):

* `embed.global.js`: the [latest release](https://github.com/PanglossTechnologies/HandOfClientSDK/releases/latest),
  or build it: `npm install && npm run build`, output `sdk/embed-js/dist/embed.global.js`. Bundler-based apps can
  `npm install @handofclient/embed-js` and import from `@handofclient/embed-js/host` instead.
* `hoc-head.min.js` (`sdk/embed-js/dist/hoc-head.min.js` after the build): a few-line snippet you inline in `<head>`.

The components and page lookup described below ship in the release after v0.1.0; until then build from this repo.

```html
<head>
  <script>/* contents of hoc-head.min.js: hides the page until embed.js knows what applies */</script>
</head>
<body>
  ...your page...
  <hoc-request-feature></hoc-request-feature>      <!-- the request box -->
  <div data-hoc-slot="main"></div>                 <!-- optional: where "slot" features mount -->
  <script src="/static/embed.global.js"></script>
  <script>
    HandOfClient.configure({ apiBaseUrl: "<apiBaseUrl>", embedOrigin: "<apiBaseUrl>", sitePrefix: "/hoc/" });
    HandOfClient.autoMount({ timeoutMs: 1500 });
  </script>
</body>
```

Only signed-in pages need it. `sitePrefix` is where you mounted the module; make it absolute if pages live at
several depths. `autoMount` asks your site `GET hoc/api/resolve?path=<this page>` and loads what applies. It never
throws: if nothing applies, or anything fails or takes too long, the original page shows. `hoc-head.js` is optional,
but without it users may see the original page flash before a feature loads.

Elements you can put on any page (all talk only to your `hoc/api/*`; details in [`components.md`](components.md)):

| Element | For |
|---|---|
| `<hoc-request-feature>` | The request box. Captures the current page (redacted) so the build can match its look. |
| `<hoc-my-features>` | The user's requests with status, a reply box when the build asks a question, and their features (versions, keep an older version, share, turn off). |
| `<hoc-feature-admin>` | Admin page: settings, every request and feature, roll back for everyone, data sources. Show it only to admins; the API answers `403` to everyone else. |

**Redaction.** The captured page has text blanked and form values dropped by default. Mark public parts with
`data-hoc-keep` (headings, menu labels) and private parts with `data-hoc-skip`
([`page-snapshot.md`](page-snapshot.md)).

**New pages.** A feature of kind `new-page` adds a page at a path your site does not have. Add one catch-all route
(for example `/ext/*`) that serves an empty page with the layout above, and return your own 404 for paths no feature
claims (the sample calls `module.handle("GET", "api/resolve", ...)` to decide).

**Rendering mode.** Admins choose per site: *inject* (default) runs the feature's JavaScript directly in your page,
so it looks like the rest of your site and can call your own API with the user's login; *iframe* runs it in a
sandboxed frame that reaches your data only through the platform's audited proxy. Inject needs the CSP change below.

### Content-Security-Policy

If your site sends a CSP, allow what the SDK needs (`E` = your `embedOrigin`, normally the `apiBaseUrl` origin):

| Directive | Needs | Why |
|---|---|---|
| `script-src` | `'self'` (or wherever you serve `embed.global.js` from), `E`, and a hash or nonce for the inline `hoc-head` snippet | `E` is required for inject mode; a block is reported as `csp-blocked` with the origin to allow |
| `style-src` | `'unsafe-inline'` | `hoc-head.js` and the browser components insert `<style>` elements |
| `frame-src` | `E` | iframe-mode features |
| `connect-src` | `'self'` | every browser call goes to your own `hoc/*` |

The sample computes the `sha256-...` of the `hoc-head` snippet at start-up and puts it in `script-src`; see the
Content-Security-Policy section of [`samples/hosts/python-flask/app.py`](../samples/hosts/python-flask/app.py). Keep the mount
snippet in a static file (the sample's `site.js`) so it needs no hash.

### CSRF

The browser components authenticate with your session cookie, so apply your normal CSRF policy to every non-GET
`hoc/api/*` call (all bodies are `application/json`). The webhook is exempt: its signature is the credential.
Django applies its CSRF middleware like to any view; Flask has none built in (the sample uses `SameSite=Lax`
cookies plus an `Origin` check).

## 5. Webhooks

The platform tells your site what happened to each request by `POST`ing signed events to the URL you registered.
The module handles it for you at `hoc/webhook`; for the record:

* `build.status`: `InProgress`, `NeedsInfo` (the question is in `message`; the user answers from `<hoc-my-features>`),
  `Rejected` (with the reason) or `Success`.
* `build.version`: a new version of a feature was published; the module records it and, for a first version,
  assigns the feature to the requester.
* Signature: `X-HandOfClient-Signature: sha256=` + hex HMAC-SHA256 of the **raw body** with your webhook secret.
  Events older or newer than 300 s from your clock are rejected; every event has an `eventId` and repeats are
  ignored. Non-2xx answers are retried for 24 hours with backoff, so a site that was briefly down catches up.

The webhook URL must be reachable from the internet. `GET /host/v1/webhook-deliveries` (with your host API key) shows
what was sent and what your site answered. Full contract: [`openapi/site-hoc-api.yaml`](../openapi/site-hoc-api.yaml).

**No webhook (polling).** `GET /host/v1/builds/{id}` returns a build's status and any `NeedsInfo` question, which is
enough to show progress while developing on a machine the platform cannot reach. It does **not** carry the published
version, so a feature only becomes visible when the `build.version` event arrives. For local development use the fake
platform (section 2), which delivers to `127.0.0.1`; against the real platform use a tunnel or a staging host.

## 6. Data for features

A feature needs your data to be useful ("show overdue orders"). Describe your API once, in the admin page's *Data
sources* editor: a name, a base URL, optionally an OpenAPI description, and a bearer credential. The platform adds
the base URL to your tenant's egress allowlist and stores the credential in its vault; the build is told what the API
offers and uses only what is described.

* **Inject mode**: the feature runs in your page and calls your API same-origin with the user's session.
* **Iframe mode**: the feature sends `Authorization: Bearer {{secret:name}}` through the platform's proxy, which
  substitutes the credential server-side; the feature never sees it. Your API must accept that credential, and
  returns service-account data (check per-user permissions yourself).
* `{{hoc:token}}` lets your API verify which user is calling, against the platform's `/host/v1/jwks`.

The sample's `/api/orders` is a one-endpoint example with an OpenAPI file to paste into the editor.

## 7. Before production

1. Replace the demo sign-in; `get_current_user` must read a signed session.
2. Keep the host API key and webhook secret in your secret store, never in the browser or source control.
3. HTTPS everywhere; the CSP of section 4; your CSRF policy on `hoc/api/*`.
4. Register every real origin of your pages with us, and your production webhook URL.
5. Decide who may share (settings on the admin page) and give admins a way to reach `<hoc-feature-admin>`.
6. Test with two users: the requester sees the feature, the other does not; and an admin.

## 8. Your language has no host module

The module is the part of your site that serves three groups of endpoints and keeps the data. Implement it in any
language from the contract, and prove it with the language-neutral conformance suite.

1. **Read the contracts.** [`openapi/site-hoc-api.yaml`](../openapi/site-hoc-api.yaml) is what your site serves
   (`hoc/token`, `hoc/api/*`, `hoc/webhook`, including webhook signing and a test vector);
   [`openapi/platform-host-v1.yaml`](../openapi/platform-host-v1.yaml) is what it calls (`POST /builds`,
   `POST /embed-token`, `PUT /data-sources`, `PUT /secrets`, `GET /builds/{id}`).
2. **Store** (any database): requests (text, optional page snapshot, status, message, build id, mode), features
   (kind, path or slot, package id, current version, owner), versions (version, sha256, entry), assignments (a
   user or everyone), per-user state (pinned version, turned off), settings, and processed webhook event ids.
3. **Serve** the endpoints. The rules that matter most: identity only from your session; a feature the caller may
   not see is `404`, identical to one that does not exist; `hoc/token` re-checks visibility on every call and mints
   an embed token for the pinned version, else the current one; `resolve` returns at most one page-level feature per
   path, with a user-specific assignment beating "everyone"; sharing follows your settings.
4. **Start builds** when a request is stored (store first, then call `POST /builds`; keep unstarted requests and
   retry, the platform deduplicates on the request id).
5. **Verify webhooks** exactly as in section 5, and apply the event and the dedupe in one transaction.
6. **Run the conformance suite** against your module with the fake platform as its backend:
   [`host-modules/conformance/README.md`](../host-modules/conformance/README.md) lists the test profile (a fixed
   user roster and keys) your module is started with, then
   `node host-modules/conformance/run.mjs --base-url http://127.0.0.1:5000/hoc`.

`host-modules/conformance/selftest/reference-host.mjs` is a small in-memory host written straight from the OpenAPI
file, and the Python, Node and PHP modules are complete implementations; read whichever is closest to your language.
The browser side (`embed.js`) is the same for every language.

## 9. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Nothing happens after a request is built | The webhook did not arrive or was rejected (`GET /host/v1/webhook-deliveries`, your site's logs; wrong secret gives `401`, clock drift over 300 s gives `400 stale_event`). |
| The page flashes, or stays blank for 5 s | `hoc-head.js` is inlined but `embed.js` failed to load or `autoMount` is not called on that page. |
| Console: `csp-blocked` | Add the origin named in the message to `script-src` (section 4). |
| `inject-load-failed` | Network failure or a hash mismatch; the page's origin is not registered with us (CORS). |
| `token-fetch-failed` | `hoc/token` answered an error: not signed in (`401`), or the platform could not be reached (`502`). |
| Every `hoc/*` call is `401` | `get_current_user` returned nothing for that request (cookie not sent, wrong path prefix behind your proxy). |
| Requests stay `InProgress` forever on a dev machine | The platform cannot reach your webhook URL. Use the fake platform or a tunnel. |
