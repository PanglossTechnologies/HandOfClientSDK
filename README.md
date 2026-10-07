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

The platform itself is hosted; this repo is everything you need to integrate with it. Access is by
request: contact the maintainers for a tenant, a `hostId` and a host API key.

## Integrate your app (any backend language)

1. **Load `embed.js`** (`sdk/embed-js`, build with `npm run build`, serve `dist/embed.global.js` yourself),
   add a container, then:
   ```js
   HandOfClient.configure({ apiBaseUrl, embedOrigin });
   HandOfClient.mount(container, { hostId, tenantId, packageId, slotId, tokenUrl: "hoc/token" });
   ```
2. **Add a same-origin token endpoint** (`tokenUrl`). It identifies the signed-in user from *your own*
   session, then calls `POST {platform}/host/v1/embed-token` with header `x-api-key: <host API key>` and
   JSON `{tenantId, userId, packageId, slotId}`, and returns `{token, expiresAt, userId, displayName?}`.
   - Keep the API key server-side only.
   - Never take `userId` from the browser - that lets any visitor mint a token as anyone.
   - Return 401 when there is no session.
3. **Give plugins your data.** Put your API host on the tenant's egress allowlist and store its
   credential in the vault (`PUT /host/v1/secrets`). Plugins send `Authorization: Bearer {{secret:name}}`;
   the proxy substitutes it server-side.

Working examples: [`samples/hosts/python-flask`](samples/hosts/python-flask) (~70 lines),
[`samples/hosts/dotnet`](samples/hosts/dotnet). WordPress: [`host-adapters/wordpress`](host-adapters/wordpress)
and [`docs/wordpress-host.md`](docs/wordpress-host.md).

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
| `samples/` | Host and plugin examples |
| `docs/` | Protocol spec and guides |

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
