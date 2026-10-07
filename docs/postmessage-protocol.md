# HandOfClient postMessage Embed Protocol (v1)

Normative spec for task C1. Elaborates design doc "2. postMessage Embed Protocol + JS SDK" (iterdone
doc "HandOfClient - Platform Design v1") into wire-level detail precise enough to implement C2
(embed.js, host-side SDK) and C3 (plugin-side SDK) against without further judgment calls on the wire
format. Where this doc adds a decision the design doc left open, that is called out explicitly under
"Decisions made in this pass" at the end - nothing here contradicts the design doc, it only fills gaps.

## 1. Scope

This spec covers exactly one thing: the `window.postMessage` channel between a host page and the
cross-origin iframe serving one activated plugin slot. It does not cover the Platform API contract
(see `proto/handofclient/v1/*.proto` and design doc "3. Platform API Contract") except where a message
in this protocol directly triggers a Platform API call (token issuance, refresh).

## 2. Transport and envelope

Every message, both directions, is a single JSON-serializable object posted via
`window.postMessage(envelope, targetOrigin)` - never `"*"` as `targetOrigin` on either side.

```
Envelope {
  v: 1                    // literal, protocol version - see "8. Versioning"
  type: string             // "hoc:<name>", see message catalog
  msgId: string             // unique per message, this side's own id space
  replyTo?: string          // present on a reply; equals the msgId it answers
  payload: object           // type-specific, see catalog. {} if the type carries no data.
}
```

- `msgId` generation: `crypto.randomUUID()` in every environment this SDK targets (all evergreen
  browsers). No fallback needed.
- A request/reply pair correlates purely by `msgId`/`replyTo` - never by message order. Either side may
  have multiple requests in flight at once (e.g. two concurrent `hoc:token-refresh` calls should not
  happen in practice, but nothing here assumes single-flight).
- Messages that are pure notifications (no reply expected: `hoc:ready`, `hoc:error`, `hoc:resize`,
  `hoc:telemetry`, `hoc:context-changed`, and one direction of `hoc:navigate` - see 4.6) never set
  `replyTo` and never receive one.
- Any received object that fails to parse as a valid `Envelope` (wrong shape, missing `type`, `v` not
  `1`) is silently ignored, not thrown - postMessage is a shared channel; unrelated messages from
  browser extensions or other library code on the same page must not crash the SDK.

## 3. Origin validation (mandatory on both sides, not optional hardening)

**Host side:** the host SDK knows the platform embed origin outright, since it constructed the
iframe's `src` itself. On every `message` event, before dispatching to any handler, it MUST check
`event.source === iframe.contentWindow && event.origin === expectedEmbedOrigin`. Any mismatch is
dropped silently (not logged to the console the *host's* page uses, to avoid leaking protocol details
to a host page's own scripts - a debug-mode flag may enable logging).

**Plugin side:** unlike the host, the plugin bundle does not know its parent's origin in advance - one
host can register multiple `registered_origins` (dev/staging/prod domains), and the plugin has no
reliable, tamper-proof way to learn which one it's embedded in before the handshake completes. This
spec adopts **origin pinning (trust-on-first-`hoc:init`)**:

1. Before the first valid `hoc:init` is received, the plugin SDK accepts messages from any origin
   *for the sole purpose of completing the handshake* - it never dispatches `hoc:context-changed`,
   `hoc:navigate` (host to plugin), or any application-visible callback before init.
2. The origin of the frame that delivers the first valid `hoc:init` is pinned as `trustedHostOrigin`
   for the remaining lifetime of that iframe instance (a full page reload starts over).
3. Every subsequent message is checked against `event.origin === trustedHostOrigin` and dropped
   (silently) on mismatch.

This is safe because `frame-ancestors` (served per-bundle-response by the platform, scoped to the
owning host's `registered_origins` - see B7's `BundleEndpoints.cs` and design doc "7. Security Model
Summary" #3) already prevents the browser from ever framing this content under an unregistered origin
in the first place; origin pinning is the second, independent layer that stops a message from being
accepted from anything other than whichever registered origin actually did the embedding.

## 4. Handshake sequence

```
Host page                         Platform (Platform API)          Plugin iframe
    |                                       |                             |
    | 1. HandOfClient.mount(el, {slotId,    |                             |
    |    tokenUrl})                          |                             |
    |------- fetch(tokenUrl) ------->        |                             |
    | (host's own backend; validates its own session, calls                |
    |  TokenService.IssueEmbedToken server-to-server, returns the token)   |
    |<------ {token, expiresAt} ------       |                             |
    |                                       |                             |
    | 2. GetActiveVersion(scope, slotId) -> package/version/entryPoint     |
    |------------------------------->|                                     |
    |<-------------------------------|                                     |
    |                                       |                             |
    | 3. create <iframe src="https://embed.handofclient.com/               |
    |    embed/{pkgB64}/{version}/{entryPoint}">                            |
    |------------------------------------------------------------> loads  |
    |                                       |                             |
    |                                       |          4. hoc:hello {sdkVersion, nonce}
    |  <----------------------------------------------------------------- |
    | 5. hoc:init {token, tenantContext, user, theme, locale,               |
    |    launchParams} (replyTo = hello's msgId)                          |
    |  -----------------------------------------------------------------> |
    |                                       |     6. author init callback runs
    |                                       |     7a. hoc:ready  -or-  7b. hoc:error
    |  <----------------------------------------------------------------- |
```

Step-by-step requirements:

1. **`HandOfClient.mount(el, options)`** - `options: { slotId, tokenUrl, readyTimeoutMs?, onReady?,
   onError?, onNavigate?, onTelemetry?, onUi? }`. `tokenUrl` is fetched with `credentials: "same-origin"`
   (it is the host's own endpoint, on the host's own origin - normal same-origin fetch, no CORS
   involved). A non-2xx response or network error rejects `mount()`'s returned promise / fires
   `onError` synchronously; **no iframe is created** in this case (nothing to tear down, nothing
   partially rendered).
2. embed.js calls `PackageRegistry.GetActiveVersion` (cacheable, short TTL - see design doc "1. Package
   Manifest Schema" "Version pickup") to resolve which `{packageId, version, entryPoint}` to serve for
   `{host, tenant, slot}`. If no enabled activation exists, `mount()` rejects with a distinguishable
   error (`HocMountError` with `reason: "no-active-version"`) rather than creating a dead iframe.
3. The iframe is created with `src` built from the resolved package/version/entry point (see B7's
   base64url-encoded `packageIdB64` path segment - unchanged until D0/the per-package-subdomain scheme
   lands) and a `sandbox` attribute of at minimum
   `allow-scripts allow-same-origin allow-forms allow-popups` (no `allow-top-navigation*` - a plugin
   must never navigate the top-level page). The iframe's `title` is set from the manifest's slot
   `title` for accessibility.
4. The plugin-side SDK's bootstrap script sends `hoc:hello` as soon as its own script has loaded
   (`document.readyState` irrelevant - this fires before the author's own code runs at all). `nonce` is
   a fresh `crypto.randomUUID()` generated per load; its only purpose is letting the host SDK's debug
   logging correlate a `hello` with the matching `init`/`ready`/`error` across the possibility of a
   plugin bundle reloading itself (e.g. a manual `location.reload()` inside the iframe) - it carries no
   security weight (origin pinning is what actually matters; see 3).
5. The host SDK replies with `hoc:init`, `replyTo` set to the `hello` message's `msgId`, targeted with
   `postMessage(envelope, embedOrigin)` (never `"*"`). This is the message whose *origin* the plugin
   pins per section 3.
6. The plugin SDK invokes the author's registered init callback (see C3, `hoc.init(cb)`) with the
   parsed context. This is application code and may be synchronous or return a Promise.
7. On completion:
   - **Success** (callback returned / resolved without throwing): `hoc:ready`, payload `{}`.
   - **Failure** (callback threw / rejected, OR the callback was never registered at all - see below):
     `hoc:error`, payload `{ message: string, stack?: string, fatal: true }`.
   Only one of `hoc:ready`/`hoc:error` is ever sent for a given mount, and it is sent exactly once. If
   `hoc.init(cb)` is never called by the plugin bundle at all within `readyTimeoutMs` (default
   **15000ms**, generous by design - see design doc's false-positive-timeout lesson: since this is an
   explicit signal, not a rendering heuristic, a long timeout has no false-positive cost, and firing
   only means something is genuinely broken), the host SDK synthesizes its own timeout failure
   (`reason: "timeout"`) and shows the host's error UI - the watchdog fires unconditionally on missing
   signal, not on missing renders.

**Explicit non-heuristic rule** (ported verbatim from the `ExtensionBoundarySettled` lesson): the host
SDK MUST NOT infer readiness from `iframe.onload`, a render count, mutation observers, or any timer
short of `readyTimeoutMs`. `iframe.onload` fires when the *document* has loaded, which is long before
the plugin's own JS has run its init callback - treating it as "ready" is exactly the false-positive
this lesson exists to prevent.

## 5. Message catalog

All payload field names are `camelCase` (this is a JS/JSON protocol, unlike the proto contract's
`snake_case`).

### 5.1 `hoc:hello` (plugin -> host, notification)
```
{ sdkVersion: string, nonce: string }
```

### 5.2 `hoc:init` (host -> plugin, reply to `hoc:hello`)
```
{
  token: string,
  tokenExpiresAt: string,       // ISO 8601, matches IssueEmbedTokenResponse.expires_at
  tenantContext: { hostId: string, tenantId: string, packageId: string, slotId: string, version: string },
  user: { userId: string, displayName?: string },
  theme: ThemeTokens,           // see 5.2.1
  locale: string,               // BCP 47, e.g. "en-US"
  launchParams: Record<string, string>,
  apiBaseUrl: string,           // Platform API base URL for hoc.api/hoc.storage/hoc.http (see 9.1)
}
```

#### 5.2.1 `ThemeTokens`
A small, fixed set of CSS custom-property-shaped values, not an open bag - keeps the plugin's
theming surface reviewable and stable across host redesigns:
```
{
  colorScheme: "light" | "dark",
  accentColor: string,      // CSS color
  backgroundColor: string,
  textColor: string,
  fontFamily: string,
  borderRadius: string,     // CSS length, e.g. "8px"
}
```

### 5.3 `hoc:ready` (plugin -> host, notification)
```
{}
```

### 5.4 `hoc:error` (plugin -> host, notification)
```
{ message: string, stack?: string, fatal: boolean }
```
`fatal: true` for every case this spec defines today (init callback threw, or never called before
timeout). The field exists for a future non-fatal use (a plugin reporting a recoverable in-flight
error without tearing down its whole UI) that C3 does not need to implement yet - reserved, not dead.

### 5.5 `hoc:resize` (plugin -> host, notification)
```
{ height: number }   // CSS pixels, content height as measured by ResizeObserver on the plugin's root element
```
The plugin-side SDK's `hoc.resizeAuto()` helper (see C3) coalesces `ResizeObserver` callbacks to at
most one `hoc:resize` per animation frame (`requestAnimationFrame`), not one per observer callback -
`ResizeObserver` can fire many times per frame during a layout thrash, and flooding `postMessage` with
one call per intermediate value is naive and wasteful. The host SDK applies the height directly to the
iframe's `style.height` (no debouncing needed on the receiving side once the sender already coalesces).

### 5.6 `hoc:navigate` (bidirectional, notification each way - not a request/reply pair)
- Plugin -> host: `{ path: string, replace?: boolean }` - the plugin asks the host to change its own
  route (e.g. a plugin "Save and go to order list" action routing the *host's* page, not the iframe).
- Host -> plugin: `{ path: string, state?: object }` - informs the plugin of a URL/state change in the
  host's own routing, for the plugin's own deep-linking (e.g. the host's URL contains a sub-path the
  plugin should restore state from on next load).
These are two independent notification streams sharing one `type` name, distinguished only by
direction - never a request/reply pair, since neither side blocks on the other's routing.

### 5.7 `hoc:token-refresh` (plugin -> host, request/reply)
Request payload: `{}` (the plugin has nothing useful to add - the host already knows which token this
is per iframe instance).
Reply payload, success: `{ token: string, expiresAt: string }`.
Reply payload, failure (host's own session is dead - see design doc "8. Open Questions and Risks" #8):
`{ error: string }`. The plugin-side SDK surfaces this as a distinct "session expired" state (not a
generic error) so the author's UI can show a real "please reload" message instead of a raw exception.

Refresh is triggered two ways, both landing on this same message:
1. **Reactive**: the generated TS client's `authInterceptor` (clients/ts) already retries once on a
   `Code.Unauthenticated` response by calling the plugin-side `TokenProvider.refreshToken()` - which
   C3's plugin SDK implements by sending this message and awaiting the reply.
2. **Proactive**: the plugin-side SDK schedules a refresh timer at 80% of the token's remaining TTL
   (computed from `tokenExpiresAt`/`expiresAt`) so a long-lived plugin session refreshes ahead of
   expiry instead of always paying a failed-call round trip first. This is additive to the reactive
   path, not a replacement for it (the reactive path is still needed - e.g. a host-side revocation
   before natural expiry).

### 5.8 `hoc:context-changed` (host -> plugin, notification)
```
{ tenantContext?: {...}, user?: {...}, theme?: ThemeTokens, locale?: string }
```
Partial - only the fields that actually changed are present; a plugin that only cares about theme can
ignore a context-changed carrying only a `user` update, etc.

### 5.9 `hoc:telemetry` (plugin -> host, notification)
```
{ kind: "timing" | "error", name: string, value?: number, detail?: Record<string, unknown> }
```
**v1 scope note**: this message ends at the host. The design doc describes the flow as
"plugin -> host -> platform", but none of the six Platform API services expose a telemetry-ingestion
RPC today (AuditLog is query-only; writes are the automatic per-call `AuditInterceptor`, not a
client-submittable event stream - see B5). Forwarding to the platform is therefore a host-implementation
choice for now (a host may relay interesting telemetry into its own logging, or into
`EgressProxy.Send`-mediated calls to its own backend), not something embed.js does automatically. If a
real telemetry-ingestion RPC gets added later, this is where it plugs in without a wire-format change.

### 5.10 `hoc:ui` (plugin -> host, request/reply)
Request payload:
```
{ kind: "modal" | "toast" | "confirm", options: Record<string, unknown> }
```
Reply payload depends on `kind`:
- `modal`: `{ closed: true }` once the user dismisses it.
- `toast`: `{ shown: true }` (fire-and-forget from the plugin's perspective; reply just confirms receipt).
- `confirm`: `{ confirmed: boolean }`.

Rendered by the **host's** chrome so the UI can escape the iframe's clipped box (a modal must be able
to cover the whole viewport, which an iframe's own content cannot do). A host integration does not have
to implement anything to get a working default: embed.js ships a minimal built-in modal/toast/confirm
renderer, used unless the host passes `onUi` to override it. This keeps `hoc:ui` off the "mandatory
host integration cost" list the design doc calls out (mount + tokenUrl endpoint + optional webhooks) -
overriding it is optional polish, not a requirement to get a working embed.

## 6. Error catalog (host-side `HocMountError.reason`)

| reason | Meaning |
|---|---|
| `token-fetch-failed` | `tokenUrl` returned non-2xx or the fetch itself failed (network) |
| `no-active-version` | `GetActiveVersion` found no enabled activation for `{host,tenant,slot}` |
| `iframe-load-failed` | the iframe document itself failed to load (network/404) - never got the chance to send `hoc:hello` |
| `timeout` | `hoc:hello` was received (or not) but no `hoc:ready`/`hoc:error` arrived within `readyTimeoutMs` |
| `plugin-error` | the plugin sent `hoc:error` itself (see payload for `message`/`stack`) |

`iframe-load-failed` and `timeout` are distinguished because a plugin bundle that never loads at all
(bad URL, CDN outage - though v1 bundles are platform-hosted, not CDN, so this mainly means the
Platform API's embed endpoint itself is down) is a different failure mode than a bundle that loaded but
whose author code hung or never called `hoc.init(cb)` - worth different messaging/telemetry in a real
host integration even though both currently result in the same "show an error state" UI action.

## 7. CSP requirements (host page)

The host page's own CSP must include `frame-src https://embed.handofclient.com` (or the future
per-package-subdomain wildcard once D0/B7's subdomain gap resolves - see PROGRESS.md 2026-08-21). This
is the host's responsibility; embed.js cannot set the host page's own CSP header for it (that header is
set by the host's own server). The platform-served CSP on the bundle response itself
(`frame-ancestors`, `connect-src`, `script-src 'self'`, `object-src 'none'`) is unconditional and
already implemented (B7, `BundleEndpoints.cs`) - not something embed.js/the plugin SDK configure.

## 8. Versioning

`Envelope.v` is a literal `1` for this entire spec version. A future breaking change to the envelope
or handshake ships as `v: 2`, and the host SDK is the version negotiator: it inspects the plugin's
`hoc:hello.sdkVersion` (semver of the plugin-side SDK, not the envelope version) purely for diagnostics/
telemetry - the envelope's own `v` field is what future compatibility code branches on, not
`sdkVersion`. A host SDK build only ever needs to understand envelope versions it was shipped
supporting; there is no requirement to support every past version forever (unlike the Platform API's
proto contract, which is additive-only within v1 forever - this is a separate, lighter-weight
versioning axis, matching the design doc's framing of the JS SDK and the per-language API clients as
"two different layers").

## 9. Implementation notes (added while building C2/C3)

### 9.1 `apiBaseUrl` in `hoc:init`

The plugin needs the Platform API's base URL to construct `hoc.api`/`hoc.storage`/`hoc.http` (the
generated client, pre-authed with the current embed token). It cannot reliably hardcode or derive this
itself: the embed origin and the API origin are two conceptually separate things in the design doc
(`embed.handofclient.com` vs `api.handofclient.com`), even though today's single-service deployment
happens to serve both from the same origin. The host already knows its own `apiBaseUrl` (it used it for
the `GetActiveVersion` call during `mount()`), so `hoc:init` simply carries it forward - see section
5.2's `InitPayload.apiBaseUrl`.

### 9.2 Host's `tokenUrl` endpoint contract

Not specified by the design doc (which only says the host mints a token there); C2 needed a concrete
JSON shape to parse. A host's `tokenUrl` endpoint must return:
```
{ token: string, expiresAt: string, userId: string, displayName?: string }
```
`hostId`/`tenantId`/`packageId`/`slotId` are NOT part of this response - the host page already knows
all four (they're `mount()`'s own arguments, the same ones it used for `IssueEmbedToken`), so the
endpoint only needs to return what only the host's backend can know: the token itself and which user
it was issued for.

## Decisions made in this pass (beyond what the design doc specified)

- Origin pinning (trust-on-first-`hoc:init`) as the plugin side's origin-validation strategy - the
  design doc says "verifies `event.origin`" without saying what value it's checked against for a host
  with multiple `registered_origins`; see section 3.
- `readyTimeoutMs` default of 15000ms, configurable per `mount()` call.
- `hoc:resize` coalescing to one message per animation frame.
- Proactive token refresh at 80% of TTL, layered on top of (not replacing) the existing reactive
  refresh-on-401 already implemented in `clients/ts/src/authInterceptor.ts` / `AuthRetryInterceptor.cs`.
- `hoc:telemetry` v1 scope explicitly ends at the host - no platform ingestion RPC exists yet (see 5.9).
- embed.js ships a default `hoc:ui` renderer so host-side handling of that message is optional, keeping
  the "three things" host integration cost claim (mount + tokenUrl + optional webhooks) accurate.
- Distinct `iframe-load-failed` vs `timeout` error reasons, rather than collapsing both into one
  generic "failed to load" state.
