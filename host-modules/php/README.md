# handofclient/host - HandOfClient host module for PHP

The part of your site that lets a signed-in user type "I want X", have it built, and see their site change
for them only. It serves the three endpoint groups `embed.js` and the browser components talk to
(`hoc/token`, `hoc/api/*`, `hoc/webhook`), keeps requests, features, versions and who-sees-what in **your**
database, and calls the HandOfClient platform for builds and embed tokens.

Contract: [`openapi/site-hoc-api.yaml`](../../openapi/site-hoc-api.yaml) (what this serves) and
[`openapi/platform-host-v1.yaml`](../../openapi/platform-host-v1.yaml) (what it calls). Works in plain PHP and in
Laravel; stores in SQLite, PostgreSQL or MySQL / MariaDB through PDO. PHP 8.1+, `ext-json`, `ext-mbstring`,
`psr/log`; `ext-curl` is used when present (otherwise PHP streams, so `allow_url_fopen` must be on).

```
composer require handofclient/host
```

## What you write

Three small functions about **your** users, plus your host credentials:

```php
use HandOfClient\Host\HostModule;
use HandOfClient\Host\Platform\PlatformClient;
use HandOfClient\Host\Storage\SqlStorage;

$module = new HostModule(
    storage: SqlStorage::sqlite(__DIR__ . '/hoc.db'),                       // or Postgres / MySQL, below
    platform: new PlatformClient(PLATFORM_URL, HOST_API_KEY, TENANT_ID),
    webhookSecret: WEBHOOK_SECRET,                                         // returned once when the host is registered
    getCurrentUser: fn ($request) => ...,                                  // ['id' => ..., 'name' => ..., 'email' => ...] / object / null
    isAdmin: fn ($user) => ...,                                            // bool; gets what getCurrentUser returned
    findUsers: fn (string $query) => ...,                                  // [['id' => ..., 'name' => ...], ...] for the share picker
);
```

* `getCurrentUser($request)` receives your framework's own request object (`null` in plain PHP; read
  `$_SESSION` / `$_COOKIE` yourself) and returns the signed-in user - an array or an object with `id`, optionally
  `name` and `email` (public or magic properties, or `getId()` / `getName()` / `getEmail()`, so an Eloquent model
  works as is) - or `null` when signed out (every call is then `401`). It is the **only** source of identity:
  user ids in bodies, queries and headers are never trusted.
* `isAdmin($user)` decides who may change settings, roll features back for everyone and see everyone's requests
  (if you allow that).
* `findUsers($query)` returns users whose id or name matches (the module hides the caller and applies the
  limit). Optional `userExists: fn (string $id) => bool` is used to reject unknown ids when sharing; without it the
  module asks `findUsers($id)` for an exact id match.
* `PlatformClient($baseUrl, $apiKey, $tenantId)`: the platform API origin, your host API key (server side
  only - the browser never sees it), and your tenant id.

## Mount it (one line)

```php
// Plain PHP: in your front controller, before your own routing
use HandOfClient\Host\Adapter\PlainPhp;

if (PlainPhp::serve($module, '/hoc')) {
    exit;
}

// Laravel: routes/web.php
use HandOfClient\Host\Adapter\Laravel;

Laravel::routes($module, 'hoc');
```

Then point the platform's host webhook URL at `https://your-site/hoc/webhook`, and configure `embed.js` with
the relative paths `hoc/token` and `hoc/api` (see the integration docs in this repository).

Framework notes:

* **Laravel** runs the routes in the `web` group, so the session and `$request->user()` work in `getCurrentUser`:
  `getCurrentUser: fn ($request) => $request->user()`. CSRF protection applies to the browser routes like to any
  other route - send the CSRF header from your page script (`embed.js` lets you replace `fetch`), or pass
  `Laravel::routes($module, csrfExempt: true)` if you accept that. The webhook is always exempt (the platform has
  no CSRF token; its HMAC signature is the credential). Reuse the app's connection with
  `new SqlStorage(DB::connection()->getPdo())`.
* **Plain PHP**: start your session before `PlainPhp::serve()` if `getCurrentUser` needs it. Add your own CSRF
  check in front of it if your site has one. Any other framework: call `$module->handle($method, $pathAfterPrefix,
  $rawQueryString, $headers, $rawBody, $request)` and send the returned `HocResponse` (`status`, `headers()`,
  `body()`), then call `$module->runDeferred()` once the response is flushed. The two adapters are about 40 lines each.
* Mount under any prefix; the module only sees the part after it. Behind a reverse proxy make sure PHP sees the
  original path (`REQUEST_URI`).

## Storage and migrations

`SqlStorage` creates and upgrades its own `hoc_*` tables (`migrate()` is idempotent, serialised with an advisory
lock on PostgreSQL / MySQL, and costs one `SELECT` per request once everything is applied; `HostModule` calls it on
first use unless you pass `autoMigrate: false` - then call `$module->storage->migrate()` from your deploy step).
The schema is the same as the Python and Node host modules', so they can serve one database.

```php
SqlStorage::sqlite('hoc.db');                                              // WAL mode; writers queue on a 30 s busy timeout
new SqlStorage(new PDO('pgsql:host=...;dbname=...', $user, $pass));        // PostgreSQL
new SqlStorage(fn () => new PDO('mysql:host=...;dbname=...;charset=utf8mb4', $user, $pass));  // MySQL / MariaDB
```

Pass a `PDO` or a function that returns one (it is called per transaction). The dialect is detected from the
driver; pass `'sqlite'`, `'postgres'` or `'mysql'` as the second argument to force it. A `PDO` that is already inside
a transaction is joined: the module leaves commit and rollback to you. To keep the data somewhere else entirely,
implement `HandOfClient\Host\Storage\Storage` / `StorageTx` (a small, rule-free record-keeping interface).

The module never deletes data. Webhook event ids are kept to deduplicate retries; prune old rows of
`hoc_events` (`received_at` older than a few days) if the table ever matters.

## Behaviour worth knowing

* A request is stored first, then the platform build is started. If the platform cannot be reached the request
  stays `InProgress`. PHP has no background threads, so the retry runs **after a later response** - at most every
  15 seconds across all processes (`runDeferred()`, which both adapters call once the response is flushed). On a
  quiet site also call `$module->retryUnstartedBuilds()` from a scheduler (cron; Laravel's `Schedule`). The platform
  deduplicates on the request id, so retrying is safe.
* Webhooks are verified (HMAC over the raw body, constant-time), rejected when `sentAt` is more than 300 s off,
  and deduplicated by `eventId` **in the same transaction as the change**, so a failed apply is retried by
  the platform instead of being swallowed as a duplicate.
* Every handler logs through a PSR-3 logger (`logger:` argument; Laravel's logger is a fine choice): info per call
  with the user id, exceptions with every inner exception. Without one, warnings and errors go to `error_log()`.
  Unexpected errors answer `500 {"error":"internal"}` and never leak details.
* All responses are `Cache-Control: no-store`.
* JSON arrays and objects: PHP cannot tell an empty `[]` from `{}` once decoded, so the page snapshot and the
  `dataSources` are validated on an object-decoded copy (an empty `{}` inside a snapshot stays `{}`). Everywhere
  else an empty `[]` body is read as `{}` and fails validation like any other missing field.

## Testing and conformance

```
composer install
vendor/bin/phpunit                                   # unit tests, plain-PHP adapter, real HTTP to a local server (curl and streams)
node conformance/run-conformance.mjs plain           # the CL-16 suite against conformance/plain_app.php on PHP's built-in server (needs Node 20+)
node conformance/setup-laravel.mjs [--laravel 12]    # once: builds a stock Laravel app around this checkout (.laravel-conformance at the repository root, gitignored)
node conformance/run-conformance.mjs laravel         # the suite through Laravel, on Laravel's own PDO
node conformance/run-conformance.mjs laravel-csrf    # CSRF protection on: browser POSTs refused (419), GET and the signed webhook work
```

Options: `--db env` (with `HOC_CONFORMANCE_DATABASE_URL=postgresql://...` or `mysql://...`, an empty database) runs
the suite on PostgreSQL / MySQL; `--transport stream` forces the stream-based platform client. Set `PHP` to the php
binary if it is not `php` on the path, `COMPOSER_BIN` for the Laravel setup.

`conformance/` holds the tiny apps that run the language-neutral suite from
[`host-modules/conformance`](../conformance/README.md) against this package; they double as complete working
examples of each adapter. CI also runs the suite against real PostgreSQL and MySQL servers and Laravel 12 and 13.
