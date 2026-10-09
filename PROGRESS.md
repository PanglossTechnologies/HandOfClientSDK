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
