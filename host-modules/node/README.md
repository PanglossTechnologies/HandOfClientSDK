# @handofclient/host - HandOfClient host module for Node.js

The part of your site that lets a signed-in user type "I want X", have it built, and see their site change
for them only. It serves the three endpoint groups `embed.js` and the browser components talk to
(`hoc/token`, `hoc/api/*`, `hoc/webhook`), keeps requests, features, versions and who-sees-what in **your**
database, and calls the HandOfClient platform for builds and embed tokens.

Contract: [`openapi/site-hoc-api.yaml`](../../openapi/site-hoc-api.yaml) (what this serves) and
[`openapi/platform-host-v1.yaml`](../../openapi/platform-host-v1.yaml) (what it calls). Works with Express,
Fastify and plain `node:http`; stores in SQLite, PostgreSQL or MySQL. No runtime dependencies. TypeScript types
included; ships ES modules and CommonJS. Node 18+ (SQLite storage needs Node 22.13+, the others do not).

```
npm install @handofclient/host      # plus your framework and, for PostgreSQL / MySQL, pg / mysql2
```

## What you write

Three small functions about **your** users, plus your host credentials:

```js
import { HostModule, PlatformClient, SqlStorage } from "@handofclient/host";

const hoc = new HostModule({
  storage: SqlStorage.sqlite("hoc.db"),                      // or Postgres / MySQL, below
  platform: new PlatformClient({ baseUrl: PLATFORM_URL, apiKey: HOST_API_KEY, tenantId: TENANT_ID }),
  webhookSecret: WEBHOOK_SECRET,                             // returned once when the host is registered
  getCurrentUser: (req) => req.session?.user ?? null,        // { id, name?, email? } or null
  isAdmin: (user) => user.isAdmin,                           // boolean; gets what getCurrentUser returned
  findUsers: (query) => db.searchUsers(query),               // [{ id, name }] for the share picker
});
```

* `getCurrentUser(req)` receives your framework's own request object and returns the signed-in user (an object
  with `id`, optionally `name` and `email`), or `null` when signed out (every call is then `401`). It may be
  `async`. It is the **only** source of identity: user ids in bodies, queries and headers are never trusted.
* `isAdmin(user)` decides who may change settings, roll features back for everyone and see everyone's requests
  (if you allow that).
* `findUsers(query)` returns users whose id or name matches (the module hides the caller and applies the
  limit). Optional `userExists(userId)` is used to reject unknown ids when sharing; without it the module asks
  `findUsers(userId)` for an exact id match.
* `PlatformClient`: the platform API origin, your host API key (server side only - the browser never sees it),
  and your tenant id.

## Mount it (one line)

```js
// Express
import { router } from "@handofclient/host/express";
app.use("/hoc", router(hoc));

// Fastify
import { plugin } from "@handofclient/host/fastify";
await app.register(plugin(hoc), { prefix: "/hoc" });

// plain node:http (and anything that hands you IncomingMessage / ServerResponse)
import { nodeHandler } from "@handofclient/host/node";
http.createServer(nodeHandler(hoc, { prefix: "/hoc" })).listen(3000);
```

Then point the platform's host webhook URL at `https://your-site/hoc/webhook`, and configure `embed.js` with
the relative paths `hoc/token` and `hoc/api` (see the integration docs in this repository).

For any other framework, call `await hoc.handle({ method, path, query, headers, body, request })` yourself and
send back `status`, the JSON `responseBody(res)` and the `RESPONSE_HEADERS`.

Framework notes:

* **Express**: mount the router **before** `express.json()` and friends, or keep the original bytes with
  `express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } })`. The webhook signature is an HMAC over
  the exact bytes the platform sent, so a body that was already parsed and re-serialised fails verification
  (everything else works either way). Apply your CSRF protection to the router if you use cookie sessions.
* **Fastify**: the plugin is encapsulated; the raw-body parser it installs affects only routes under its prefix.
  `getCurrentUser` receives the Fastify request.
* Mount under any prefix; the module only sees the part after it. Behind a reverse proxy make sure the
  framework sees the original path.
* Request bodies larger than 3 MiB are refused with `413` (`maxBodyBytes` changes it).

## Storage and migrations

`SqlStorage` creates and upgrades its own `hoc_*` tables (`migrate()` is idempotent and safe on every start;
`HostModule` calls it once on first use unless you pass `autoMigrate: false`). The schema is identical to the
Python host module's.

```js
SqlStorage.sqlite("hoc.db")                                  // node:sqlite, WAL mode, Node 22.13+
SqlStorage.postgres(new pg.Pool({ connectionString }))       // node-postgres
SqlStorage.mysql(mysql2.createPool({ uri }))                 // mysql2/promise; MySQL or MariaDB, utf8mb4
```

Hand it the pool you already have: each transaction checks out one connection and commits or rolls back before
returning it. SQLite uses a single connection and runs transactions one after another. To keep the data
somewhere else entirely, implement `Storage` / `StorageTx` (a small, rule-free record-keeping interface).

The module never deletes data. Webhook event ids are kept to deduplicate retries; prune old rows of
`hoc_events` (`received_at` older than a few days) if the table ever matters.

## Behaviour worth knowing

* A request is stored first, then the platform build is started. If the platform cannot be reached the request
  stays `InProgress` and the build is retried with timers (1 s, 2 s, 5 s, 15 s, 1 min, 5 min);
  `hoc.retryUnstartedBuilds()` does the same on demand (run it from a scheduler if you like - it also runs
  shortly after start-up). The platform deduplicates on the request id, so retrying is safe. Timers do not keep
  the process alive.
* Webhooks are verified (HMAC over the raw body, constant-time), rejected when `sentAt` is more than 300 s off,
  and deduplicated by `eventId` **in the same transaction as the change**, so a failed apply is retried by the
  platform instead of being swallowed as a duplicate.
* Pass `logger` (pino, winston and `console` all fit: `info`, `warn`, `error`) to `HostModule` and
  `PlatformClient` to see one info line per call with the user id; exceptions are logged with their causes.
  The default logger prints only warnings and errors. Unexpected errors answer `500 {"error":"internal"}` and
  never leak details.
* All responses are `Cache-Control: no-store`.

## Testing and conformance

```
npm ci
npm test                                                  # unit tests (builds first)
node conformance/run-conformance.mjs                      # the CL-16 suite under Express, Fastify and node:http
node conformance/run-conformance.mjs fastify --db env     # one framework against PostgreSQL / MySQL (HOC_CONFORMANCE_DATABASE_URL, empty database)
```

`conformance/` holds the tiny apps that run the language-neutral suite from
[`host-modules/conformance`](../conformance/README.md) against this package; they double as complete working
examples of each adapter. CI also runs the suite against real PostgreSQL and MySQL servers, and publishes to
npm from a `host-node-vX.Y.Z` tag.
