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

## 2026-10-09 - CL-21 Flask sample, integration guide, README

`samples/hosts/python-flask` is now a complete customization-loop host on the Python module: sign-in, request box on every page, My features, admin page, `hoc-head.js`, an overridable `/orders` page, a `/ext/*` catch-all that 404s unless a `new-page` feature claims the path, `/api/orders` as the one data source (with `orders-openapi.json`), and a CSP (hash for the inlined head snippet, embed origin in `script-src`/`frame-src`). New `docs/integration-guide.md` (access values, local dev against the fake platform, layout snippet, CSP table, CSRF, webhooks, data sources, production checklist, and a "write your own host module" path built on the OpenAPI files plus the conformance suite); root README leads with it. Proof: 4 pytest cases against the fake platform and 4 Playwright cases (desktop and iPhone, under the real CSP, no console errors) for request -> built -> visible only to the requester, My features, admin and the 404; the guide's inline Flask app was also run verbatim through the same loop.

Decisions: the sample reads `hoc-head.min.js` and `embed.global.js` from `static/` (copied by `fetch_assets.py`, gitignored) rather than vendoring them; a polling fallback is documented as status-only because `GET /builds/{id}` carries no version, so the module does not poll.

Known gaps: the latest GitHub release (v0.1.0) predates the components, `autoMount` and `hoc-head.min.js`, so the sample needs a source build until a new release is cut; `handofclient` is not on PyPI yet; the Python module README still names the (fixed).

## 2026-10-09 - CL-22 WordPress adapter on the new model

Plugin 0.2.0 serves the customization loop through the bundled PHP host module (`HOC_Site`): `hoc/token`, `hoc/api/*` and `hoc/webhook` answer from `init` under
`<home>/hoc/`, WordPress users map onto the module's callbacks (admin = `manage_options`, share picker = `WP_User_Query`), builds go to `POST /host/v1/builds` through the WP HTTP API,
and requests/features/assignments live in `hoc_*` tables in the WordPress database. Signed-in users get embed.js with `autoMount`, the `hoc-head` snippet and a "Request a feature" dock
(request box + my features; shortcodes `[hoc_request_feature]` / `[hoc_my_features]` as an alternative); wp-admin gets **Request a Feature** and **Feature admin** (`<hoc-feature-admin>`).
The old admin-only form and its `/customization-request` client calls are gone. `build.mjs` now bundles the module and psr/log into the zip (`lib/`), and the plugin finds them in
`host-modules/` in a source checkout.

Proof: the CL-16 suite passes 97/97 against a throwaway WordPress (`conformance/run-conformance.mjs`, which also checks the CSRF policy: cross-site and `Origin: null` writes 403, signed webhook exempt);
`conformance/browser.test.mjs` (real wp-login users, fake platform, Chrome) passes 6/6 at desktop and iPhone: request -> built -> only the requester sees it, wp-admin screens, signed-out and subscriber negatives;
29 standalone PHP tests (`tests/test-site.php`: DB_HOST -> DSN forms, cross-site check, prefix, identity filters).

Decisions: PDO rather than `$wpdb` (the module is PDO-based; `pdo_mysql` from the wp-config credentials, or the SQLite plugin's file), so hosts without `pdo_mysql` see a clear "not available" line in Settings
instead of a fatal; the loop is registered before the legacy safe-mode breaker so slot failures cannot switch it off; the file stays PHP 7.4-parseable (no named arguments) so older sites keep the slot features.
Dev harness: PHP is resolved from releases.json (the pinned 8.3.33 download 404ed), tar uses System32's bsdtar (Git's GNU tar read `Z:` as a host), and the wp-config accepts `HOC_WP_DB_PATH` / `HOC_WP_URL` for throwaway instances.

Known gaps: MySQL is covered by the DSN unit tests and the module's own MariaDB run (CL-19), not by a live WordPress-on-MySQL run; multisite shares one set of `hoc_*` tables; no CI job runs the WordPress checks (the harness is Windows PHP);
the production site's own migration (register the webhook URL, enter the secret, enable) needs the site owner's WordPress access (Needs Human).

## 2026-10-09 CL-26 Self-contained docs

Removed every pointer to private tooling, private source paths, task ids and private specs from shipped
files (proto + generated TS comments, clients, embed-js, publisher CLI, samples, WordPress adapter, docs,
OpenAPI); rewrote `PLUGIN-AUTHORING-RULES.md` as tool-neutral; the useful knowledge is now in plain terms in the
docs (hygiene checks are not the security boundary, bundle limits, withdraw/409, what `permissions.scopes` does and
does not enforce). Sample hostIds/domains made neutral (`my-host`, `my-wordpress-site`, `example.com`). Added
`docs/concepts-checklist.md` (each concept linked to where it is explained) and `tools/lint-public-repo.mjs`
(banned terms + broken relative links in README/docs; `npm run lint:public`, CI in `lint-public-repo.yml`). Removed
the "candidate follow-ups" proposal list from `no-source-integration.md`.

Known gap: `hoc-publish` uploads to a platform route that is not part of the public API surface, so `publish.ts` and its test are the
two allowlisted files. A public route (for example `/host/v1/bundles`) needs a platform change, then the CLI can
switch and the allowlist shrinks.

## 2026-10-09 CL-27 Root CI from a clean clone

New `.github/workflows/ci.yml` (push to main, PRs, manual): `contracts` (buf lint, regenerated `gen/` must equal committed, Redocly lint of both OpenAPI files), `node` (npm ci, build all packages incl. wp-site-snapshot, typecheck, embed-js + publisher-cli tests, conformance self-test and mutants, publish dry run of all three plugin samples), `dotnet` (C# client, bootstrap tool, .NET host sample built; sample started and smoke-tested over HTTP and in headless Chrome by `tools/ci/smoke-dotnet-sample.mjs`), `flask` (pytest + the desktop/iPhone Chrome test), `wordpress` (plugin PHP tests, distributable zip contents). Host-module unit tests, conformance across every adapter on SQLite/PostgreSQL/MySQL, banned-terms lint and the publish jobs stay in their existing per-module workflows. Every step was run from a fresh clone before committing (Windows; the Linux runner is unproven until the first Actions run).

Fixes found by the clean-clone run: `hoc-publish` bin was not linked after `npm ci` (CLI is built later) so the samples' `publish:dry-run` failed until `npm rebuild`; root `build` skipped wp-site-snapshot; WordPress `build.mjs` used GNU tar `-a` for the zip, which cannot write zip on Linux (now `zip`); added `.gitattributes` so protos and `gen/` stay LF and the regenerate-and-diff check is stable on Windows checkouts. Root scripts added: `typecheck`, `test`, `test:conformance-mutants`, `lint:openapi` (`@redocly/cli` dev dependency), `check:generated`, `publish:dry-run:samples`, `smoke:dotnet-sample`.

Findings: `HocClient` rejects an `http://` base address (secure gRPC channel credentials), so the .NET sample cannot talk to the plain-HTTP fake platform; its smoke test therefore proves the host side and the embed.js error path, not the full loop. Known gaps: the WordPress live conformance and browser tests need the Windows-only dev harness (`php.exe`, `mklink`), so CI covers only its PHP tests and zip; no end-to-end Python/PHP/Node host module run is part of ci.yml (own workflows); publish jobs need Gary to add tokens/trusted publishers as documented in each workflow header.

## 2026-10-09 HOCSDK-6 on-behalf-of-host

TS client `createHocClient` gained `onBehalfOfHost` (sends `x-hoc-host` on every call, mirrors the C# client); `hoc-publish` uses it and also sends the header on the bundle upload, with `--on-behalf-of-host` as the flag name (`--host-id` kept as an alias). Two new CLI tests (35 total). HOCSDK-4 (inject handoff in `hoc.init`) and HOCSDK-5 (Flask sample on the Python module) were already delivered by CL-15 and CL-21 and are closed.

## 2026-10-09 HOCSDK-10 WordPress harness off Windows, CI job

`devharness/php-path.mjs` picks the PHP: the downloaded `.wp-local/php` build on Windows, otherwise `php` from PATH (or `HOC_PHP`); setup.mjs skips the PHP/cacert download, php.ini and openssl.cnf in that case and symlinks the plugin instead of `mklink /J`; wp-instance.mjs uses the same resolver. New `wordpress-conformance` job in ci.yml runs setup, run-conformance and browser.test. Windows re-verified (29 PHP tests, conformance PASS, browser 6/6). Known gap: the Linux run is unproven until the first Actions run.

## 2026-10-09
First Linux Actions run: WordPress harness now unzips with `unzip` off Windows (GNU tar cannot read zip); Laravel 11 dropped from the PHP matrix because composer blocks every installable 11.x on security advisories (supported: 12, 13).

## 2026-10-09 HOCSDK-3 unified error + webhook shapes
Every /host/v1 error is now `{error: "<code>"}` only (no message, no human text; LegacyError removed). All webhook/relay bodies use `type` (activation.changed, hook.fired); `event` is gone. Breaking, pre-release, no compat shim. Platform changed in HandOfClient repo; OpenAPI, fake platform and tests updated here. Site-side hoc/api errors still carry `message` (separate surface, unchanged).

## 2026-10-09 HOCSDK-3 follow-up: structured error detail
Debugging detail came back as machine-readable fields, not text: hoc/api errors (node, python, php host modules, fake platform, reference host, embed-js FeaturesApiError.detail) keep `error`+`message` and add optional `field`/`reason`/`values`/`limit`, plus a `platform` block ({status, error, field, reason...}; status 0 = unreachable) when a platform call failed. /host/v1 errors carry the same field/reason/values/limit. Reason vocabulary is a closed snake_case set documented in both OpenAPI files; conformance suite file 08-error-detail pins it. PHP not run locally (no php here), CI covers it.

## 2026-10-09 HOCSDK-9 hoc-publish uses the public bundle route
hoc-publish uploads to POST {apiBaseUrl}/host/v1/bundles (documented in platform-host-v1.yaml); the two lint allowlist entries are gone. Needs a new hoc-publish release to reach users (HOCSDK-7).

## 2026-10-09 HOCSDK-2 NuGet job in the SDK release workflow
release.yml gains a `nuget` job (pack HandOfClient.Client at the tag version, push with secret NUGET_API_KEY). The HOC repo release.yml still publishes the same packages and is not removed yet: delete it only after NUGET_API_KEY is set and a tag run succeeds here.
