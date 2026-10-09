# Page lookup: `autoMount`, `hoc-head.js`, inject mode

For sites that implement the customization endpoints in [`openapi/site-hoc-api.yaml`](../openapi/site-hoc-api.yaml).
On every page load `embed.js` asks the site which features apply to the signed-in user on this path, then
loads them. If nothing applies, or anything goes wrong, the original page shows.

## Wiring a page

```html
<head>
  <script>/* contents of hoc-head.min.js (release asset or sdk/embed-js/dist) */</script>
</head>
<body>
  ...the page...
  <div data-hoc-slot="main-panel"></div>   <!-- optional: where `slot` features mount -->
  <script src="embed.global.js"></script>
  <script>
    HandOfClient.configure({ apiBaseUrl, embedOrigin, sitePrefix: "/hoc/" });
    HandOfClient.autoMount({ timeoutMs: 1500 });
  </script>
</body>
```

`sitePrefix` (default `hoc/`) is where the site mounts `token`, `api/*` and `webhook`. A relative prefix
resolves against the page's base URI, so give an absolute path (`/hoc/`) if pages live at several depths.

`new-page` features need one catch-all route on the site (for example `/ext/*`) that serves an empty page
loading `embed.js` as above. Unknown paths should show the site's own 404.

## What `autoMount` does

1. `GET <sitePrefix>api/resolve?path=<location.pathname>`, abandoned after `timeoutMs` (default 1500).
2. For each returned feature, `GET <sitePrefix>token?featureId=<id>` (the original no-parameter token URL
   still works for `mount()`), then:

| Mode | Kind | Result |
|---|---|---|
| `inject` | any | Loads `<embedOrigin>/embed/<packageIdB64>/<version>/<entry>` as `<script type="module" integrity="sha256-...">` (the hash comes from `resolve`). |
| `iframe` | `slot` | Sandboxed iframe in the element matching `[data-hoc-slot="<slotId>"]` (`slotSelector` overrides). |
| `iframe` | `page-override`, `new-page` | Full-window iframe; the original body content is hidden, and restored if the plugin fails. `hoc:navigate` moves the host page (same origin only). |

3. Everything must be ready within `loadTimeoutMs` (default 3000) of the resolve answer, otherwise the
   original page shows (full-window iframes are removed).
4. The body is revealed (`hoc-head.js` hid it). `autoMount` never throws: failures are in the returned
   `failed` list and passed to `onError` (reasons: `timeout`, `resolve-failed`, `token-fetch-failed`,
   `no-slot`, `inject-load-failed`, `csp-blocked`, `plugin-error`).

`hoc-head.js` is optional but is what prevents a flash of the original page. Its fail-safe reveals the
body after `window.hocHeadTimeoutMs` (default 5000, set it before the snippet) if `embed.js` never runs;
keep it above `timeoutMs + loadTimeoutMs`.

## Inject mode

The site's Content-Security-Policy must allow scripts from the embed origin (`script-src`), and the embed
origin must serve bundles with CORS headers (`Access-Control-Allow-Origin`), because `integrity` on a
cross-origin script requires `crossorigin="anonymous"`. A CSP block is reported as `csp-blocked` with the
origin to allow; a hash mismatch or network failure is `inject-load-failed`.

Handoff to the bundle: immediately before adding each script, embed.js sets
`window.HandOfClientInject.pending` to an `InjectContext`:

```ts
{
  featureId: string;
  init: InitPayload;              // same shape as the hoc:init payload (token, tenantContext, user, theme, locale, apiBaseUrl)
  slotElement: HTMLElement | null; // for `slot` features
  refreshToken(): Promise<{ token: string; expiresAt: string }>;
  navigate(path: string, replace: boolean): void;
  ui?(request: UiRequestPayload): Promise<UiReplyPayload>; // the host's onUi, if any
}
```

Plugin authors do not read this directly: `hoc.init` from `@handofclient/embed-js/plugin` takes it (see
`docs/plugin-author-tutorial.md`, "Inject mode").

Scripts are loaded one at a time, so `pending` always belongs to the script about to run. The bundle must
read it synchronously at module top level (before its first `await`) and keep its own reference; it is
cleared once the script has loaded.
