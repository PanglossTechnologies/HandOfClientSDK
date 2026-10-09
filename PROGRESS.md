# Progress log

## 2026-10-07 to 2026-10-09 (backfill)

Public SDK in place: proto contract, generated TS/C# clients, embed.js, publisher CLI, WordPress host adapter,
Flask and .NET host samples, no-source integration guide, npm packages (0.1.0), and the SDK declared the single
source of truth for the folders in the README layout table (CL-00).

## 2026-10-09 CL-11 OpenAPI contracts

Added `openapi/site-hoc-api.yaml` (the site's `hoc/token`, `hoc/api/*`, `hoc/webhook`) and
`openapi/platform-host-v1.yaml` (every `/host/v1` REST endpoint plus the gRPC-only host registration and egress
proxy), so a non-.NET implementer no longer has to read C# to learn error shapes, webhook signing, embed-token
claims/JWKS verification or the `{{secret:name}}` / `{{hoc:token}}` substitution rules. Both lint clean (OpenAPI
3.1, Redocly minimal and recommended: 0 errors). CI wiring is CL-27.

Contract decisions made while writing (platform and host modules must implement these):
- Webhook string-to-sign stays the raw body (as built); the staleness check uses a `sentAt` field in the body of
  the new `build.*` events (300 s tolerance) plus a stable `eventId` for dedupe, rather than a signed timestamp
  header, so existing `activation.changed` verification is unchanged.
- `build.version` carries `slotId` (needed to mint embed tokens); `GET hoc/api/users` added for the share picker;
  `PUT /host/v1/data-sources` takes `{tenantId, dataSources[]}` and only adds hostnames to the egress allowlist.
- `POST /builds/{id}/reply` and `PUT /data-sources` are marked `x-status: planned` (not yet served).

Known gaps: errors use two shapes on the platform today (`{error: text}` on older endpoints, `{error: code,
message}` on builds); activation webhooks use `event` while build webhooks use `type`.

## 2026-10-09 CL-12 embed.js page lookup

`sdk/embed-js/src/host/` split into config/token/mount/inject/autoMount modules. Added `sitePrefix` config, `featureId`
on the token URL (no-param `mount()` unchanged, `tokenUrl` now defaults to `<sitePrefix>token`), `HandOfClient.autoMount`
(resolve, then inject / full-window iframe / slot), the inject loader (module script with `integrity`, `csp-blocked`
and `inject-load-failed` errors) and `hoc-head.js` (+ minified, shipped as a release asset). Documented in
`docs/page-lookup.md`. Covered by a real-browser suite (`npm test -w @handofclient/embed-js`, playwright-core against two
local servers, desktop + iPhone emulation, includes a no-flash check with a control that proves the detector works).

Decisions: `hostId`/`tenantId` for the plugin context come from the unverified embed JWT claims (`hid`, `tid`), so
`resolve` needs no contract change; inject features load one at a time and take `window.HandOfClientInject.pending`
synchronously; `timeoutMs` bounds only the resolve lookup, `loadTimeoutMs` (default 3000) bounds loading what it returned.

Known gap: the plugin-side SDK (`hoc.init`) does not yet consume the inject handoff, so injected bundles must read
`HandOfClientInject.pending` themselves (follow-up task).

## 2026-10-09 CL-13 embed.js page snapshot capture

New `sdk/embed-js/src/host/snapshot.ts`: `HandOfClient.captureSnapshot({ redact })` (also exported from `/host`) builds the
snapshot node by node into an inert document (nothing is copied unless a rule copies it): inlined stylesheets (linked,
`<style>`, CSSOM-inserted rules, adopted, imports; unreadable cross-origin ones stay `<link href>`), and redaction on by
default (same-length `x` text, value/placeholder/title dropped, query strings stripped, `data-hoc-keep`/`data-hoc-skip`).
Documented in `docs/page-snapshot.md`; real-browser suite `test/snapshot.test.mjs` (desktop + iPhone, includes a render
fidelity check).

Decisions: `data-*` values, `alt`/`aria-*` text and non-viewport `meta` are redacted too; password/file values and scripts are
never captured even with `redact:false`; a skipped subtree leaves an empty same-size element so layout holds. Not captured:
iframe contents, shadow DOM, canvas pixels.

## 2026-10-09 CL-14 browser components

`<hoc-request-feature>`, `<hoc-my-features>`, `<hoc-feature-admin>` (plus `HandOfClient.requestFeature/myFeatures/featureAdmin`
and `HandOfClient.features.*`, `createFeaturesApi`, `defineComponents`) in `sdk/embed-js/src/host/{features.ts,components/}`;
shadow-DOM, `--hoc-*` themed, documented in `docs/components.md`. Tested against a new in-memory fake of `hoc/api/*`
(`test-support/fake-site.mjs`, every documented status/error) with real-browser suites at desktop + iPhone
(`test/components.test.mjs`) and a Node suite for the API client (`test/features-api.test.mjs`).

Decisions: elements wait for DOMContentLoaded before the first call so an inline `configure()` after the script tag is seen;
roll back for everyone has an inline confirm step; admin feature list is just `GET features` (contract has no "all features").

Known gaps: the fake lives in embed-js test-support, CL-16 may promote/replace it as the shared conformance fake; no
pagination for `GET features`/versions (contract has none); user names for already-shared ids show as ids until the picker has seen them.

## 2026-10-09 - CL-15 plugin SDK works in inject mode

`hoc.init` in `@handofclient/embed-js/plugin` now detects `window.HandOfClientInject.pending` (read synchronously, before any
await) and runs the same `hoc` surface in-page: no handshake, token refresh via `InjectContext.refreshToken`, navigate via
`InjectContext.navigate`, ui via the host's `onUi` (new optional `InjectContext.ui`) or the built-in renderer. Added `hoc.mode` and
`hoc.root` (slot element / body when injected, `#root` / body in an iframe); `resizeAuto` is a no-op and the host-event listeners never
fire when injected. `HostRelayTokenProvider` became `RefreshingTokenProvider` over a refresh function. The hello-world sample now renders
into `hoc.root` and scopes its theme variables to it, and the real built sample is tested unchanged in both modes at desktop + iPhone
(harness serves a minimal grpc-web TenantStorage). Inject-mode differences documented in `docs/plugin-author-tutorial.md`.

Known gaps: an exception from the callback in inject mode is only thrown, not reported back to embed.js (no error channel in `InjectContext`).

## 2026-10-09 - CL-16 host module conformance suite

New `host-modules/conformance/`: zero-dependency Node (node:test) HTTP suite (7 files, 97 tests) any host module can be run
against with `node host-modules/conformance/run.mjs --base-url <module>/hoc`. It covers every `hoc/api/*` call, token minting
(never for an invisible feature, always for the session user, pin/current version), resolve precedence, sharing policies,
webhook signature/replay/stale handling and settings/data sources. The fake platform (`fake-platform/`, also usable standalone
with `--auto-build` for local development) records builds/embed-token calls, validates builds like the real API, mints verifiable
ES256 tokens and sends signed webhooks; a control API under `/_fake/*` drives it. A conformance profile (cookie `hoc_user`
roster, fixed key/secret/tenant, documented in the README) is how a module under test is configured.

Proof: `npm run test:conformance` runs the suite against an in-memory reference host (`selftest/reference-host.mjs`, written
from the OpenAPI file); `selftest/mutants.mjs` breaks the reference host seven ways and requires the suite to fail each.

Decisions: suite never resets the module's DB (unique ids/paths per test); where the contract leaves a status open (non-requester
reply 403/404, token for a feature the user turned off) the suite accepts both. Known gaps: legacy token call without
`featureId`, CSRF, retry timing after a platform outage; CI wiring is CL-27; the embed-js fake-site could be replaced by this
fake later.

## 2026-10-09 - CL-17 Python host module

New `host-modules/python/` (PyPI name `handofclient`, Python 3.9+, no required dependencies): `HostModule` serves `hoc/token`,
`hoc/api/*` and `hoc/webhook` framework-neutrally; Flask (`blueprint`), Django (`urls`) and FastAPI (`router`) adapters are one-liners.
`SqlStorage` (SQLite / PostgreSQL / MySQL via any DB-API connection factory) owns `hoc_*` tables with an idempotent migration runner
behind a small rule-free `Storage`/`StorageTx` interface; platform client is stdlib `urllib`. The site supplies `get_current_user`,
`is_admin`, `find_users` (+ optional `user_exists`).

Proof: the CL-16 suite passes 97/97 under all three frameworks (`conformance/run_conformance.py`, also run by `pytest`) on SQLite and
on PostgreSQL (embedded `pgserver`); 60 pytest unit tests (webhook test vector, storage, rollback, negative cases, adapters) also pass on
Python 3.9. CI (`.github/workflows/python-host-module.yml`) adds real PostgreSQL and MySQL services and a tag-triggered
`host-python-vX.Y.Z` PyPI Trusted Publishing job.

Decisions: webhook dedupe + apply share one transaction (a failed apply is retried, not swallowed); builds the platform could not take are
retried by background timers and `retry_unstarted_builds()`; the requester's email is stored so retried builds match the first attempt;
Django's webhook route is always CSRF-exempt, the browser routes follow the site's CSRF policy unless `csrf_exempt=True`.

Known gaps: MySQL has only been exercised by dialect unit tests locally (the CI MySQL job is its first live run); PyPI publishing needs a
trusted-publisher entry on pypi.org (Needs Human); `samples/hosts/python-flask` still shows only the legacy token endpoint.

## 2026-10-09 - CL-18 Node host module

New `host-modules/node/` (npm `@handofclient/host`, Node 18+, zero runtime dependencies, ESM + CommonJS + types): `HostModule` is a
direct port of the Python module's rules (same routes, validation, visibility/sharing/resolve precedence, webhook handling, build
retry timers) over an async `Storage`/`StorageTx` interface. `SqlStorage` owns the same `hoc_*` schema as the Python module (so both
can serve one database): SQLite via `node:sqlite` (single connection, transactions queued), PostgreSQL from a `pg` Pool, MySQL from a
`mysql2/promise` Pool, with a PostgreSQL advisory lock / MySQL `GET_LOCK` around migrations. Adapters: `@handofclient/host/express`
(`router`), `/fastify` (encapsulated `plugin` with its own raw-body parser) and `/node` (`nodeHandler`, what Express is built on).

Proof: the CL-16 suite passes under Express, Fastify and plain node:http on SQLite (`node conformance/run-conformance.mjs`) and under
Express on a live PostgreSQL (embedded pgserver); 60 `node:test` unit tests cover negative cases for every route, webhook replay and
failed-apply retry, storage, both SQL drivers against fake pools, raw-body handling in Express, Fastify encapsulation and the CJS build.
CI (`.github/workflows/node-host-module.yml`) adds typecheck, Node 22/24, real PostgreSQL and MySQL services, and a tag-triggered
`host-node-vX.Y.Z` npm Trusted Publishing job.

Decisions: webhook dedupe + apply share one transaction; the Express router must run before body parsers (or capture `req.rawBody`)
because the signature is over the raw bytes; the default logger only prints warnings/errors (info per call needs a `logger`).

Known gaps: MySQL has only been exercised by fake-pool unit tests locally (the CI MySQL job is its first live run); npm publishing
needs the `@handofclient` org and a trusted-publisher entry on npmjs.com (Needs Human); `samples/hosts/` has no Node example yet.

## 2026-10-09 - CL-19 PHP host module

New `host-modules/php/` (Composer `handofclient/host`, PHP 8.1+, requires only `psr/log`, `ext-json`, `ext-mbstring`): `HostModule` is a port of
the Python/Node rules (same routes, validation, visibility/sharing/resolve precedence, webhook handling) over a `Storage`/`StorageTx`
interface. `SqlStorage` runs on PDO (SQLite via BEGIN IMMEDIATE, PostgreSQL, MySQL/MariaDB) with the same `hoc_*` schema as the other modules and an
advisory lock around migrations; platform client uses curl or falls back to PHP streams. Adapters: `PlainPhp::serve($module, '/hoc')` and
`Laravel::routes($module)` (web middleware group, webhook always CSRF-exempt, browser routes follow the app's CSRF policy unless `csrfExempt: true`).

Proof: the CL-16 suite passes 97/97 under plain PHP (SQLite, PostgreSQL, MariaDB, and with the stream transport) and under Laravel 12 and 13 (SQLite, PostgreSQL,
MariaDB; Laravel's own PDO), plus a `laravel-csrf` run (browser POST 419, GET and signed webhook fine); 110 PHPUnit tests pass on PHP 8.3 (PHPUnit 12)
and PHP 8.1 (PHPUnit 10). CI (`.github/workflows/php-host-module.yml`) adds PHP 8.1-8.4, Laravel 11-13, real PostgreSQL/MySQL services, and a tag-triggered
`host-php-vX.Y.Z` job that splits the subtree to the mirror repo Packagist reads.

Decisions: PHP has no background threads, so unstarted builds are retried by `runDeferred()` after a later response (at most every 15 s across processes,
throttled through a `build_retry_at` row in `hoc_counters`) and by `retryUnstartedBuilds()` from cron; pdo_sqlite's `inTransaction()` ignores transactions
started by statement, so SQLite transactions are driven by plain BEGIN/COMMIT/ROLLBACK and a caller-owned transaction is detected from the BEGIN error;
empty `[]` vs `{}` is lost by `json_decode(..., true)`, so snapshot and dataSources are validated on an object-decoded copy.

Known gaps: Laravel 11 and PHP 8.2/8.4 are first exercised by CI (local runs: PHP 8.1 and 8.3, Laravel 12 and 13); MySQL was verified on MariaDB 11.4 only;
Packagist publishing needs the mirror repo `PanglossTechnologies/handofclient-php`, a write deploy key stored as secret `PHP_SPLIT_DEPLOY_KEY` in the `packagist`
environment, and the package submitted on packagist.org (Needs Human); `samples/hosts/` has no PHP example yet.

## 2026-10-09 - CL-20 publisher-cli: inject bundles

`hoc-publish` now validates inject versions locally (one `.js`/`.mjs` entry file, no strictCsp, entry must not import other modules since only it is covered by the SRI; page-override/new-page `path` rules mirror the platform's), prints the `sha256-<base64>` integrity of each entry (also on `--dry-run`) and, after publishing, fails if the platform recorded a different value. For build automation it gained `--json` (single result object on stdout), `--host-id` (x-hoc-host, for the super-admin key) and `HOC_API_KEY` / `HOC_API_BASE_URL` / `HOC_HOST_ID`; manifest-read and PublishVersion errors are clean `FAILED:` lines. New `npm test` in `tools/publisher-cli` (33 node:test cases: validation negatives, import scan, iframe and inject publish against a grpc-web stub platform).

Proof against a real dev platform (HandOfClient Platform built from dev, isolated data dir): an iframe bundle and an inject bundle both published with a host key, an inject version published with the super-admin key + `--host-id`, the served `/embed/.../feature.js` bytes hash to the printed integrity, republish gives `already_exists`, and a super-admin key without `--host-id` is rejected.

Known gaps: the import check is a regex over source (an import hidden in a string or built dynamically is not seen); no CI job runs the publisher-cli tests yet.
