# Writing your first HandOfClient plugin

A walkthrough for a plugin author building and publishing a real package, using
`samples/plugins/hello-world/` as the worked example. If you just want to read finished code, that
directory *is* the answer; this doc explains why it's built that way.

A plugin is two things: a static web bundle (HTML/JS/CSS - no server of your own required, see
"Prerequisites" below for the one case where you'd want one) and a `manifest.json` describing it to the
registry. Nothing here talks to the Platform API directly except at publish time - at runtime, your
bundle runs inside a sandboxed iframe and talks to the platform only through the `hoc.*` SDK
(`@handofclient/embed-js/plugin`), which the host page's `embed.js` hands you an authenticated context
for. See `docs/postmessage-protocol.md` if you want the wire-level detail; this doc stays at the "what do
I actually write" level.

## Prerequisites

- A **host** you're building this for, and that host's `hostId` (whoever administers the host's
  HandOfClient integration registers it via `RegisterHost`; see `docs/integration-guide.md`). Your manifest binds to
  exactly one host; a package is not portable across hosts.
- A **host API key** to publish with (also from `RegisterHost`, or from whoever admins that host). Never
  commit this to source control.
- Node.js and this repo's npm workspaces installed (`npm install` at the repo root).

## 1. Scaffold

`samples/plugins/hello-world/` is a real npm workspace package - copy its shape for a new plugin:

```
your-plugin/
  package.json       -- depends on @handofclient/embed-js; hoc-publish as a devDependency
  tsconfig.json
  build.mjs           -- esbuild: bundles src/index.ts -> bundle-dist/plugin.js
  src/index.ts
  src/index.html       -- static shell; loads plugin.js
  manifest.json         -- the author-facing manifest (see step 3)
```

`bundle-dist/` is a build output (gitignored, like every other `dist/` in this repo) - `npm run build`
regenerates it from `src/`.

## 2. Write the plugin (`src/index.ts`)

The one thing every plugin must do is call `hoc.init(callback)` exactly once. The SDK sends
`hoc:ready`/`hoc:error` for you based on whether your callback resolves or throws - you never send those
messages yourself (see `docs/postmessage-protocol.md` section 4, the explicit-signal
watchdog rule: the host is waiting on this signal with a 15s timeout, so don't do slow work before
calling it, and don't forget to call it - an uncalled `hoc.init` is a hang, not a silent success).

```ts
import { hoc } from "@handofclient/embed-js/plugin";

await hoc.init(async (context) => {
  // context.hostId/tenantId/packageId/slotId/version, context.user, context.theme, context.locale,
  // context.launchParams - everything the host handed you at mount time.
  // hoc.root is where to render, in either mode (see "Inject mode" below).
  hoc.root.textContent = `Hello, ${context.user.displayName}`;
});
```

Inside (or after) that callback you have the rest of the SDK surface:

- `hoc.api` - the full generated `@handofclient/api` client, pre-authed with your embed token and
  auto-refreshing (both reactively on 401 and proactively before expiry - you never touch the token).
- `hoc.storage.get/set/delete/fileExists` - your own `{host,tenant,package}`-scoped KV+file store.
- `hoc.http.send` - server-mediated egress through `EgressProxy`, enforced against
  `manifest.permissions.egressHosts` intersected with the tenant's admin-approved allowlist (see step 3).
  There is no direct `fetch()` to the outside world available to you - the served CSP's `connect-src`
  blocks it at the browser level, so `hoc.http` is not a convenience, it's the only path.
- `hoc.ui.modal/toast/confirm` - rendered by the *host's* chrome (a modal needs to escape your iframe's
  clipped box). Works with zero host-side integration effort - `embed.js` ships a default renderer.
- `hoc.root` / `hoc.mode` - the element to render into, and `"iframe"` or `"inject"` (see "Inject mode").
- `hoc.resizeAuto(rootElement)` - call once your content exists; keeps the host's iframe sized to fit
  your content via `ResizeObserver`, coalesced to one message per animation frame.
- `hoc.navigate(path)` / `hoc.onHostNavigate(listener)` - ask the host to change its own route, or learn
  when it did.

One CSP consequence worth knowing up front: the platform serves every bundle with `script-src 'self'`
(no inline `<script>`, no `eval`) and no `style-src` restriction. Put your logic in an external `.js`
file loaded via `<script type="module" src="...">` (or a non-module IIFE if you don't need top-level
`await`); inline `onclick="..."` attributes and `<script>...</script>` blocks will be silently blocked by
the browser, not by anything in this SDK.

## Inject mode

A tenant's feature can run in one of two modes, chosen by the host's administrator and not by you: in an
**iframe** (everything above) or **injected** into the host page itself, as a `<script type="module"
integrity="...">` that embed.js loads (`docs/page-lookup.md`, "Inject mode"). You write one bundle. The same
`hoc` object works in both, with the same signatures:

| `hoc.*` | iframe | inject |
|---|---|---|
| `init(callback)` | handshake with the host over postMessage, then `hoc:ready` / `hoc:error` | takes the handoff embed.js left for this script; no postMessage. An exception from your callback is thrown out of `init` (and so out of your module), nothing is signalled |
| `context` (user, theme, locale, tenant, ...) | from the handshake | same values, from the handoff |
| `api`, `storage`, `http` | token relayed from the host, refreshed through it | same client; the token is refreshed by calling the site's token endpoint directly |
| `navigate(path)` | `hoc:navigate`; the host decides | same-origin navigation of the page (or the host's `onNavigate`); another origin is ignored |
| `ui.modal/toast/confirm` | host chrome | the host's `onUi` if it passed one, else the built-in renderer, in the page |
| `root` | `#root` in your HTML, else `<body>` | the `[data-hoc-slot]` element of a slot feature, else `<body>` |
| `resizeAuto(el)` | keeps the iframe sized to `el` | no-op: your element is already in the page and sizes with it |
| `onContextChanged`, `onHostNavigate` | fire | never fire (no host channel) |

Rules that only matter in inject mode:

- **Call `hoc.init` synchronously at the top level of your module, before your first `await`.** The handoff
  exists only for that first turn. Anything else (an `await fetch(...)` first, calling `init` from a click
  handler) throws "hoc.init found neither a parent window ... nor an inject handoff".
- **You share the page.** Your JS runs with the host page's privileges: it can read the DOM, cookies the
  page can see, and the host's globals. That is the point of the mode (it can edit the page in place), and
  the reason it is opt-in per tenant. What you must not assume: your own `<html>`/`<head>`/`#root`, your
  own viewport, or a clean global scope. Do not set CSS variables on `<html>` or add global styles; scope
  them to `hoc.root` (the hello-world sample applies its theme variables to `hoc.root` for this reason).
- **Page access** is plain DOM: `document`, `window`, `hoc.root`, and `document.querySelector` for any host
  element. There is no wrapper and no guarantee the host's markup stays the same, so look elements up
  defensively and handle a miss. In iframe mode `document` is your own page.
- **No `<script>` or HTML shell.** Only your entry JS is loaded; an `index.html` is used by iframe mode only.
  Keep per-element styling inline or injected with a scoped `<style>` from your JS, since your `<style>`
  block in `index.html` does not exist in the host page.
- The host's Content-Security-Policy must allow the embed origin in `script-src`, or the feature is reported
  as `csp-blocked`; a plugin cannot work around that.

`samples/plugins/hello-world/` runs unchanged in both modes: its `src/index.ts` is the same file, it renders
into `hoc.root` and puts its theme variables there. `sdk/embed-js/test/autoMount.test.mjs` runs the built
sample in both modes at desktop and iPhone viewports.

## 3. Write the manifest (`manifest.json`)

This is the **author-facing** schema (`AuthorManifest` in `tools/publisher-cli/src/authorManifest.ts`) -
friendlier than the wire `Manifest` proto message it gets translated into (plain lowercase `kind`
strings, no hand-computed hashes):

```json
{
  "packageId": "your-publisher-slug/your-plugin-slug",
  "publisher": "Your Name or Company",
  "name": "Human-Readable Name",
  "version": "0.1.0",
  "hostId": "<the host's hostId from RegisterHost>",
  "entryPoints": { "main-panel": "index.html" },
  "slots": [
    { "slotId": "main-panel", "kind": "panel", "title": "My Panel", "hostPanelId": "main-panel" }
  ],
  "permissions": { "scopes": ["storage.read", "storage.write"], "egressHosts": [] },
  "updatePolicy": { "kind": "pinned" }
}
```

Key fields:
- `packageId` is globally unique and publisher-scoped (for example `acme/wms-labels`) - pick something that won't collide.
- `version` must be valid semver; versions are immutable once published (re-publishing the same
  `packageId@version` is rejected).
- Every `slots[].slotId` needs a matching `entryPoints` key, and every `entryPoints` value must be a real
  file that ends up in your packed bundle - `hoc-publish` validates both before it ever uploads anything.
- `slots[].kind`: `"panel"` (named region inside an existing host page, needs `hostPanelId`), `"page"`
  (new full-page route, needs `targetPath`), or `"override"` (replaces an existing host route, needs
  `matchPath`).
- `permissions.scopes` is the list of capabilities the package declares it needs (for example `storage.read`,
  `storage.write`, `egress`, `tokens.userinfo`). The platform copies it, space-separated, into the `scope`
  claim of every embed token minted for that version; it is never taken from the request, so a plugin cannot
  grant itself more. Declare only what you use: the list is shown to administrators and is the contract for
  what the package may do. Today the platform's hard enforcement is the `{host, tenant, package}` binding and
  the egress rules, not a per-scope check on each call.
- `permissions.egressHosts` is **necessary but not sufficient** for `hoc.http` to reach a host - the
  tenant admin must also allowlist it (`SetTenantEgressAllowlist`, a host-admin action, not yours).
  Declaring a host here is a request, not a grant.

## 4. Build and validate

```
npm run build          # esbuild -> bundle-dist/
npm run publish:dry-run  # packs, hashes, validates manifest + bundle, runs hygiene checks - uploads nothing
```

`publish:dry-run` catches the two classes of mistake worth catching before you ever talk to a server:
manifest/bundle mismatches (missing entry point files, bad semver, undeclared slot) and hygiene issues
(service worker registration, `eval`, a handful of embedded-secret patterns; see "Hygiene checks" below).

### Hygiene checks

`hoc-publish` scans your bundle's text files (`.js`, `.mjs`, `.cjs`, `.map`, `.html`, `.json`) and refuses to
publish if it finds `eval(...)` / `new Function(...)`, a `navigator.serviceWorker.register(...)` call (or a
file that looks like a service worker), or strings that look like embedded secrets (private keys, API key
shapes). These are **hygiene checks, not a security boundary**: text pattern matching is trivially defeated
by minification or dynamic import by a determined author, so it exists to catch honest mistakes (a leaked key,
an accidental `eval` from a dependency) before they ship. The real boundary is enforced by the platform
regardless of what the CLI says:

- the bundle runs in an origin-sandboxed iframe (inject mode is an explicit per-tenant opt-in, see above);
- every bundle is served with a Content-Security-Policy (`script-src 'self'`, `connect-src` limited to the
  platform, `frame-ancestors` limited to the host's registered origins; `strictCsp` removes network access
  entirely);
- every `hoc.storage` / `hoc.http` / `hoc.api` call is authenticated with the embed token and bound
  server-side to the `{host, tenant, package}` in that token (a plugin cannot name another tenant's data),
  and `hoc.http` is checked against the manifest's `egressHosts` intersected with the tenant's approved
  allowlist.

### Limits

A bundle may contain at most 5,000 files and 50 MiB uncompressed. `hoc-publish` checks both locally so an
oversized bundle fails immediately instead of after the upload.

## 5. Publish for real

```
hoc-publish --manifest manifest.json --bundle bundle-dist \
  --api-base-url https://<platform-host>:<port> --api-key <your-host-api-key>
```

This uploads the bundle, then calls `PackageRegistry.PublishVersion`. **Publishing does not activate
anything** - nobody's tenant will see the new version until the host (or whoever administers it) calls
`Activate` for that `{host, tenant, slot}`. That's a deliberate separation: publish is "this version now
exists and its content is sealed," activate is "this tenant should be served it" - there is nothing
to distribute, only a pointer to flip, and instant rollback is just activating a different
already-published version.

`hoc-publish` uploads the bundle to the platform and then calls `PublishVersion` with the hash the platform
confirmed; you do not call the upload step yourself. Published versions are immutable and never edited
in place. To stop serving a bad version, `Activate` another published version, `Rollback` to a previously
active one, or `SetSlotEnabled` to switch the slot off. The platform operator can also *withdraw* a version
outright; asking for a withdrawn version is answered with HTTP `409` (`version_unavailable` on the site's
`hoc/token` and `hoc/api` endpoints, see `openapi/site-hoc-api.yaml`), and the host should show its normal
error state for that feature.

### Publishing an inject bundle

An inject version is one JS module the host page loads with `<script type="module" integrity="...">`, so the
manifest sets `"render": "inject"` (optionally `"kind": "page-override"` / `"new-page"` with a `"path"` such as
`"/orders"`) and `entryPoints` names a single `.js` / `.mjs` file (several slot ids may point at it). Bundle every
dependency into that file: only it is covered by the integrity hash, so `hoc-publish` rejects an entry that
imports another module. `render: "inject"` cannot be combined with `strictCsp`.

`hoc-publish` prints the `sha256-...` integrity of each entry file (also on `--dry-run`) and, after publishing,
checks it against the value the platform recorded. For build automation:

- `--json` prints one result object (`packageId`, `version`, `render`, `bundleHash`, `entries[]`, `published`) to
  stdout; progress goes to stderr. A failure exits 1.
- `--on-behalf-of-host <id>` (alias `--host-id`) publishes on behalf of that host when `--api-key` is an operator (super-admin) key; sent as `x-hoc-host`.
- `HOC_API_KEY`, `HOC_API_BASE_URL` and `HOC_HOST_ID` can replace the flags, keeping keys out of command lines.

## Troubleshooting

- **"entry point file ... was not found in the bundle"** - `entryPoints` paths are relative to your
  `--bundle` directory root, forward-slash, no leading `./`.
- **"is already registered to a different host"** (on `PublishVersion`) - `packageId` collided with
  someone else's package. Pick a more specific publisher-scoped slug.
- **Works in the iframe, nothing renders when injected** - you used `document.getElementById("root")` (it
  is your HTML's element, absent in the host page) or called `hoc.init` after an `await`. Use `hoc.root` and
  call `init` first.
- **Plugin loads but the host shows a timeout error** - you never called `hoc.init(callback)`, or the
  callback hung before resolving. Check the browser console inside the iframe (open devtools, select the
  iframe's context) - `hoc:error`/timeout only tells the *host* something went wrong, not why.
- **`hoc.storage`/`hoc.http`/`hoc.api` calls fail with a scope/permission error** - these only work
  after `hoc.init`'s callback has started running (they need the resolved token/context); calling them
  at module load time, before `hoc.init` is even called, will throw `"... accessed before hoc.init(callback) resolved"`.
- **Content looks cut off / the host shows an internal scrollbar inside your iframe, even though nothing
  errored** - `hoc.resizeAuto(rootElement)` measures exactly `rootElement.getBoundingClientRect()`, the
  border-box of the element you passed in, nothing more. If you put padding (or a header/footer) on an
  *ancestor* of that element - `<body>` is the classic case - that space is invisible to the resize
  calculation and the iframe ends up sized short of your real content. Put your padding/margins on the
  element you actually pass to `resizeAuto`, not on `<body>` or `<html>` (see
  `samples/plugins/hello-world/src/index.html`, which hit exactly this).
