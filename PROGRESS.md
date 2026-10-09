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
