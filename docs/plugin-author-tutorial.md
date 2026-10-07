# Writing your first HandOfClient plugin (task E3)

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
  HandOfClient integration registers it via `RegisterHost` - see task E1/E2). Your manifest binds to
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
messages yourself (see `docs/postmessage-protocol.md` section 4, the `ExtensionBoundarySettled`-derived
watchdog rule: the host is waiting on this signal with a 15s timeout, so don't do slow work before
calling it, and don't forget to call it - an uncalled `hoc.init` is a hang, not a silent success).

```ts
import { hoc } from "@handofclient/embed-js/plugin";

await hoc.init(async (context) => {
  // context.hostId/tenantId/packageId/slotId/version, context.user, context.theme, context.locale,
  // context.launchParams - everything the host handed you at mount time.
  document.getElementById("root")!.textContent = `Hello, ${context.user.displayName}`;
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
- `hoc.resizeAuto(rootElement)` - call once your content exists; keeps the host's iframe sized to fit
  your content via `ResizeObserver`, coalesced to one message per animation frame.
- `hoc.navigate(path)` / `hoc.onHostNavigate(listener)` - ask the host to change its own route, or learn
  when it did.

One CSP consequence worth knowing up front: the platform serves every bundle with `script-src 'self'`
(no inline `<script>`, no `eval`) and no `style-src` restriction. Put your logic in an external `.js`
file loaded via `<script type="module" src="...">` (or a non-module IIFE if you don't need top-level
`await`); inline `onclick="..."` attributes and `<script>...</script>` blocks will be silently blocked by
the browser, not by anything in this SDK.

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
- `packageId` is globally unique and publisher-scoped (`acme/wms-labels` is the design doc's own
  example) - pick something that won't collide.
- `version` must be valid semver; versions are immutable once published (re-publishing the same
  `packageId@version` is rejected).
- Every `slots[].slotId` needs a matching `entryPoints` key, and every `entryPoints` value must be a real
  file that ends up in your packed bundle - `hoc-publish` validates both before it ever uploads anything.
- `slots[].kind`: `"panel"` (named region inside an existing host page, needs `hostPanelId`), `"page"`
  (new full-page route, needs `targetPath`), or `"override"` (replaces an existing host route, needs
  `matchPath`).
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
(service worker registration, `eval`, a handful of embedded-secret patterns - see
`docs/../PROGRESS.md`'s C4 entry and the design doc's "6. Relationship to DotNetShared.Extensibility" for
why this is explicitly hygiene, not a security boundary; the real boundary is the origin-sandboxed
iframe + served CSP + server-side scope enforcement on every RPC).

## 5. Publish for real

```
hoc-publish --manifest manifest.json --bundle bundle-dist \
  --api-base-url https://<platform-host>:<port> --api-key <your-host-api-key>
```

This uploads the bundle, then calls `PackageRegistry.PublishVersion`. **Publishing does not activate
anything** - nobody's tenant will see the new version until the host (or whoever administers it) calls
`Activate` for that `{host, tenant, slot}`. That's a deliberate separation: publish is "this version now
exists and its content is sealed," activate is "this tenant should be served it" - see the design doc's
"Version pickup" note on why this is strictly better than the old feed-sync model (nothing to
distribute, only a pointer to flip; instant rollback is just activating a different already-published
version).

## Troubleshooting

- **"entry point file ... was not found in the bundle"** - `entryPoints` paths are relative to your
  `--bundle` directory root, forward-slash, no leading `./`.
- **"is already registered to a different host"** (on `PublishVersion`) - `packageId` collided with
  someone else's package. Pick a more specific publisher-scoped slug.
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
