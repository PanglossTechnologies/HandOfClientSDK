# HandOfClient SDK

Embed sandboxed plugins (dashboards, panels, widgets) into your web app. Your page loads `embed.js`,
which mounts a plugin in a cross-origin iframe; the two talk over a strict, origin-checked postMessage
protocol. Plugins reach your data only through the platform's egress proxy (allowlist, SSRF checks, rate
limit, audit), and credentials stay in a server-side vault - the plugin never sees them.

```
 your page --embed.js--> [ plugin iframe ] --hoc.http.send--> platform egress proxy --> your API
      |                                                              ^
      +-- /hoc/token (your server, your API key) --> platform /host/v1/embed-token
```

The platform itself is hosted; this repo is everything you need to integrate with it.

## Get access

Access is by request. Email support@panglosstechnologies.com with your company, site URL(s) and backend language
(plus your webhook URL if you want users to request features, see below). You get back, per environment:

| Value | Used for |
|---|---|
| `apiBaseUrl` | Platform API base, e.g. `https://hocapi.panglosstechnologies.com`. Also the default `embedOrigin`. |
| `hostId` | Identifies your site. Public; goes in the page. |
| `tenantId` | Your tenant. Public; goes in the page and the token call. |
| host API key | Secret. Server-side only, sent as `x-api-key` by your token endpoint. |
| webhook secret | Secret, returned once when your webhook URL is registered. Verifies the events the platform sends you. |

`packageId` / `slotId` pick the plugin and where it mounts. Try `handofclient/hello-world` / `main-panel`
(the sample plugin), then use your own once published (see "Write a plugin").

## Let your users request features (the customization loop)

A signed-in user types "I want X" into a box on your site, it is built, and the site looks changed for that user
only; they can keep an older version, share it, or ask for changes. Your site stores the data; you add a host
module (Python, Node, PHP; or your own language from the contract), a few lines in your page layout, and a webhook.

* **Start here: [`docs/integration-guide.md`](docs/integration-guide.md).** It covers getting your API key and host
  registration, running the whole loop locally against a stand-in platform (no account needed), the layout snippet,
  Content-Security-Policy requirements, webhooks (and why polling is not a replacement), data for features, a
  production checklist, and how to implement a host module in a language that has none.
* **Runnable example: [`samples/hosts/python-flask`](samples/hosts/python-flask).** Sign-in, request box, My
  features, admin page, one overridable page and one data source; its README gets to "request submitted -> built ->
  visible only to me" in a few commands.
* Host modules: [`host-modules/python`](host-modules/python), [`host-modules/node`](host-modules/node),
  [`host-modules/php`](host-modules/php). Contracts: [`openapi/`](openapi).

## Embed a plugin (any backend language)

The rest of this section is the lower-level path: mount one specific plugin into a slot with a token endpoint you
write yourself. The customization loop above uses the same `embed.js` and does not need it.

1. **Load `embed.js`**: download `embed.global.js` from the
   [latest release](https://github.com/PanglossTechnologies/HandOfClientSDK/releases/latest/download/embed.global.js)
   (or build it: `npm install && npm run build`, output `sdk/embed-js/dist/embed.global.js`), put it in
   your static files and load it with a `<script>` tag.
   Bundler-based apps can instead `npm install @handofclient/embed-js` and `import` from
   `@handofclient/embed-js/host` (plugin authors: `/plugin`). Add a container with a height, then:
   ```js
   HandOfClient.configure({ apiBaseUrl, embedOrigin });
   HandOfClient.mount(container, { hostId, tenantId, packageId, slotId, tokenUrl: "hoc/token" });
   ```
   `tokenUrl` is passed to `fetch` (with cookies), so a relative value resolves against the page URL:
   `"hoc/token"` works under a sub-path, `"/hoc/token"` only when the app is at the site root.
2. **Add a same-origin token endpoint** (`tokenUrl`). It identifies the signed-in user from *your own*
   session, then calls `POST {platform}/host/v1/embed-token` with header `x-api-key: <host API key>` and
   JSON `{tenantId, userId, packageId, slotId}`, and returns `{token, expiresAt, userId, displayName?}`.
   - Keep the API key server-side only.
   - Never take `userId` from the browser - that lets any visitor mint a token as anyone.
   - Return 401 when there is no session.
3. **Give plugins your data.** Put your API host on the tenant's egress allowlist and store its
   credential in the vault (`PUT /host/v1/secrets`). Plugins send `Authorization: Bearer {{secret:name}}`;
   the proxy substitutes it server-side.
4. **Activate the package for your tenant** - a platform-side step, not something `mount()` can do. Your
   page's origin must also be a *registered origin* for your `hostId`. Both are normally done for you when
   support provisions access (step "Get access" above collects your site URL for this), or you can run it
   yourself:
   ```
   dotnet run --project tools/sample-bootstrap/HandOfClient.SampleBootstrap -- register-host \
     --api-base-url <platform> --super-admin-key <key> --host-id <hostId> --display-name "<name>" \
     --origins "https://<your-site>"

   dotnet run --project tools/sample-bootstrap/HandOfClient.SampleBootstrap -- activate \
     --api-base-url <platform> --host-api-key <key> --host-id <hostId> --tenant-id <tenantId> \
     --package-id handofclient/hello-world --slot-id main-panel --version <version>
   ```
   Symptoms if you skip this: your token endpoint's call to `/host/v1/embed-token` returns 412 if the
   package isn't activated for the tenant, and if the page's own origin isn't registered the browser
   refuses to frame the bundle - the mount point just stays an empty box with no error. This is the single
   most common first-run failure.

Minimal host page (replace the `<...>` values with what you received; serve it with your token endpoint
at `hoc/token`):
```html
<!doctype html>
<div id="plugin" style="height:400px"></div>
<script src="embed.global.js"></script>
<script>
  HandOfClient.configure({ apiBaseUrl: "<apiBaseUrl>", embedOrigin: "<apiBaseUrl>" });
  HandOfClient.mount(document.getElementById("plugin"), {
    hostId: "<hostId>", tenantId: "<tenantId>",
    packageId: "handofclient/hello-world", slotId: "main-panel",
    tokenUrl: "hoc/token"
  });
</script>
```

Working examples: [`samples/hosts/dotnet`](samples/hosts/dotnet) (a hand-written token endpoint);
[`samples/hosts/python-flask`](samples/hosts/python-flask) is the customization-loop host. WordPress: [`host-adapters/wordpress`](host-adapters/wordpress)
and [`docs/wordpress-host.md`](docs/wordpress-host.md).
No-source (non-.NET) hosts: [`docs/no-source-integration.md`](docs/no-source-integration.md).
Sites running the customization loop (per-feature tokens, `HandOfClient.autoMount`, `hoc-head.js`, inject
mode): [`docs/page-lookup.md`](docs/page-lookup.md). Redacted page snapshots
(`HandOfClient.captureSnapshot`): [`docs/page-snapshot.md`](docs/page-snapshot.md).

## Write a plugin

Start from [`samples/plugins/hello-world`](samples/plugins/hello-world); see
[`docs/plugin-author-tutorial.md`](docs/plugin-author-tutorial.md). Publish with `tools/publisher-cli`.

## Layout

| Path | What |
|---|---|
| `proto/` | The API contract (source of truth) |
| `gen/ts`, `clients/ts`, `clients/csharp` | Generated and hand-written API clients |
| `sdk/embed-js` | Host-side `embed.js` and the plugin-side SDK |
| `tools/publisher-cli` | Bundle and publish plugins |
| `host-adapters/wordpress` | Installable WordPress host plugin |
| `host-modules/conformance` | Language-neutral conformance suite for host modules, and a fake platform for local development |
| `host-modules/python` | `handofclient` for Python: the host module (Flask, Django, FastAPI; SQLite, PostgreSQL, MySQL) |
| `host-modules/node` | `@handofclient/host` for Node.js: the host module (Express, Fastify, node:http; SQLite, PostgreSQL, MySQL) |
| `host-modules/php` | `handofclient/host` for PHP: the host module (plain PHP, Laravel; SQLite, PostgreSQL, MySQL) |
| `samples/` | Host and plugin examples |
| `docs/` | Integration guide, protocol spec and component guides |

`openapi/` holds the REST contracts for non-.NET implementers: `site-hoc-api.yaml` (the endpoints your site
serves: `hoc/token`, `hoc/api/*`, `hoc/webhook`, including webhook signing) and `platform-host-v1.yaml`
(the platform's `/host/v1` API, embed-token JWT claims, and the `{{secret:name}}` / `{{hoc:token}}` proxy
substitutions).

**This repo is the single source of truth** for everything in that table (`proto/`, `gen/`, `clients/`,
`sdk/`, `host-adapters/`, `host-modules/`, `samples/`, `tools/`, `docs/`, and `buf.gen.yaml`). The platform maintainers
consume it by mirroring these folders from here with a sync script; changes always land in this repo
first and are never made in a copy.

## Security model

Every postMessage is origin- and source-checked on both sides (never `"*"`). Embed tokens are ES256 JWTs
verifiable against `/host/v1/jwks`. Plugin bundles are served with `connect-src` limited to the platform,
forcing all outbound traffic through the audited egress proxy. Full details:
[`docs/postmessage-protocol.md`](docs/postmessage-protocol.md). Report vulnerabilities privately to the
maintainers rather than opening a public issue.

## Build

```
npm install && npm run build
```

## License

Apache-2.0, see `LICENSE`.
