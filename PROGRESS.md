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
