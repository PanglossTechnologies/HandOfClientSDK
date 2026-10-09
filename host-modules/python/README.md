# handofclient - HandOfClient host module for Python

The part of your site that lets a signed-in user type "I want X", have it built, and see their site change
for them only. It serves the three endpoint groups `embed.js` and the browser components talk to
(`hoc/token`, `hoc/api/*`, `hoc/webhook`), keeps requests, features, versions and who-sees-what in **your**
database, and calls the HandOfClient platform for builds and embed tokens.

Contract: [`openapi/site-hoc-api.yaml`](../../openapi/site-hoc-api.yaml) (what this serves) and
[`openapi/platform-host-v1.yaml`](../../openapi/platform-host-v1.yaml) (what it calls). Works with Flask,
Django and FastAPI; stores in SQLite, PostgreSQL or MySQL. No required dependencies beyond your web framework.
Python 3.9+.

```
pip install handofclient            # plus your framework and, for PostgreSQL / MySQL, psycopg / pymysql
```

## What you write

Three small functions about **your** users, plus your host credentials:

```python
from handofclient import HostModule, PlatformClient, SqlStorage

module = HostModule(
    storage=SqlStorage.sqlite("hoc.db"),                       # or Postgres / MySQL, below
    platform=PlatformClient(PLATFORM_URL, HOST_API_KEY, TENANT_ID),
    webhook_secret=WEBHOOK_SECRET,                             # returned once when the host is registered
    get_current_user=lambda request: ...,                      # {"id", "name"?, "email"?} / object / None
    is_admin=lambda user: ...,                                 # bool; gets what get_current_user returned
    find_users=lambda query: ...,                              # [{"id", "name"}...] for the share picker
)
```

* `get_current_user(request)` receives your framework's own request object and returns the signed-in user
  (a dict or an object with `id`, optionally `name` and `email`), or `None` when signed out (every call is then
  `401`). It is the **only** source of identity: user ids in bodies, queries and headers are never trusted.
* `is_admin(user)` decides who may change settings, roll features back for everyone and see everyone's requests
  (if you allow that).
* `find_users(query)` returns users whose id or name matches (the module hides the caller and applies the
  limit). Optional `user_exists(user_id)` is used to reject unknown ids when sharing; without it the module
  asks `find_users(user_id)` for an exact id match.
* `PlatformClient(base_url, api_key, tenant_id)`: the platform API origin, your host API key (server side
  only - the browser never sees it), and your tenant id.

## Mount it (one line)

```python
# Flask
from handofclient.adapters.flask import blueprint
app.register_blueprint(blueprint(module), url_prefix="/hoc")

# Django (urls.py)
from handofclient.adapters.django import urls
urlpatterns = [path("hoc/", include(urls(module)))]

# FastAPI
from handofclient.adapters.fastapi import router
app.include_router(router(module), prefix="/hoc")
```

Then point the platform's host webhook URL at `https://your-site/hoc/webhook`, and configure `embed.js` with
the relative paths `hoc/token` and `hoc/api` (see the integration docs in this repository).

Framework notes:

* **Django** applies its CSRF middleware to the non-GET calls like to any view. Have your page script send the
  CSRF header (`embed.js` lets you replace `fetch`), or pass `urls(module, csrf_exempt=True)` if you accept
  that. The webhook is always exempt (the platform has no CSRF token; its HMAC signature is the credential).
* **FastAPI**: `get_current_user` may be `async`. `is_admin`, `find_users` and `user_exists` run in a worker
  thread and must be plain functions.
* **Flask**: nothing special; Flask has no built-in CSRF. Apply yours (for example Flask-WTF) to the blueprint.
* Mount under any prefix; the module only sees the part after it. Behind a reverse proxy make sure the
  framework sees the original path.

## Storage and migrations

`SqlStorage` creates and upgrades its own `hoc_*` tables (`migrate()` is idempotent and safe on every start;
`HostModule` calls it once on first use unless you pass `auto_migrate=False`).

```python
SqlStorage.sqlite("hoc.db")                                        # WAL mode, one connection per transaction
SqlStorage(lambda: psycopg.connect(DSN))                           # PostgreSQL (psycopg 3 or psycopg2)
SqlStorage(lambda: pymysql.connect(host=..., database=...), "mysql")   # MySQL / MariaDB (utf8mb4)
```

Pass any function that returns a DB-API 2.0 connection (a pool's checkout works; the module commits or rolls
back and then calls `close()`). The database dialect is detected from the driver; pass `"sqlite"`,
`"postgres"` or `"mysql"` as the second argument to force it. To keep the data somewhere else entirely,
implement `handofclient.Storage` / `StorageTx` (a small, rule-free record-keeping interface).

The module never deletes data. Webhook event ids are kept to deduplicate retries; prune old rows of
`hoc_events` (`received_at` older than a few days) if the table ever matters.

## Behaviour worth knowing

* A request is stored first, then the platform build is started. If the platform cannot be reached the
  request stays `InProgress` and the build is retried in background threads (1 s, 2 s, 5 s, 15 s, 1 min,
  5 min); `module.retry_unstarted_builds()` does the same on demand (run it from a scheduler if you like - it
  also runs shortly after start-up). The platform deduplicates on the request id, so retrying is safe.
* Webhooks are verified (HMAC over the raw body, constant-time), rejected when `sentAt` is more than 300 s off,
  and deduplicated by `eventId` **in the same transaction as the change**, so a failed apply is retried by
  the platform instead of being swallowed as a duplicate.
* Every handler logs through the standard `logging` logger `handofclient` (info per call with the user id;
  exceptions with traceback). Unexpected errors answer `500 {"error":"internal"}` and never leak details.
* All responses are `Cache-Control: no-store`.

## Testing and conformance

```
pip install -e ".[test]"
pytest                                           # unit tests + the CL-16 suite under Flask, Django and FastAPI (needs Node 20+)
python conformance/run_conformance.py flask --db postgres   # one framework against embedded PostgreSQL (pip install pgserver psycopg[binary])
```

`conformance/` holds the three tiny apps that run the language-neutral suite from
[`host-modules/conformance`](../conformance/README.md) against this package; they double as complete working
examples of each adapter. CI also runs the suite against real PostgreSQL and MySQL servers.
