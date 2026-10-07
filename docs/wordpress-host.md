# The WordPress host adapter

A fourth host alongside `samples/hosts/{dotnet,java-spring,python-flask}`, but a real, shippable one:
`host-adapters/wordpress/handofclient/`. This doc covers what it is, the two design decisions that shaped it,
how to install it, and what is deliberately not built.

## 1. What ports and what does not

**HandOfClient's model ports cleanly.** The host contract is three things - `mount()`, a `tokenUrl`
endpoint, optional webhooks - and none of it is .NET-specific. `embed.js` is unchanged, origin
pinning is unchanged, the CSP the platform serves with each bundle is unchanged, ES256 embed tokens
are unchanged. The platform does not know WordPress exists.

**The DotNetShared.Extensibility model does not port, and should not be attempted.** That platform's
safety comes from the GuardTool: an MSBuild post-build IL scan plus an independent load-time re-scan
banning `System.IO`, `HttpClient`, reflection and EF. It works because C# compiles to inspectable IL.
PHP is dynamic - `$f = 'ex' . 'ec'; $f($cmd);` defeats any static scanner in one line - so there is no
trustworthy in-process PHP sandbox. Generated PHP holding `$wpdb` would be unsanctioned root on a
customer's site, with no rollback and one fatal between it and a white screen.

So: **the WordPress plugin is fixed code, and customer features arrive as data.** Everything below
follows from that.

## 2. Two decisions worth knowing before reading the code

### 2.1 A JSON gateway, because PHP cannot speak gRPC

The platform serves real gRPC and grpc-web. Neither is reachable from a WordPress plugin: the gRPC
PHP client is a PECL extension essentially no shared or managed host installs, and hand-rolling
grpc-web framing plus a pure-PHP protobuf runtime would be a large, fragile dependency for a host
that needs five calls.

`services/platform/HandOfClient.Platform/HostGateway/HostGatewayEndpoints.cs` adds `/host/v1`, a
narrow JSON projection of just the host-facing RPCs:

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /host/v1/jwks` | public | verify embed tokens locally |
| `GET /host/v1/whoami` | `x-api-key` | pairing check |
| `GET /host/v1/activations` | `x-api-key` | what is activated for this tenant |
| `GET /host/v1/active-version` | `x-api-key` | resolve version + slot + manifest |
| `POST /host/v1/embed-token` | `x-api-key` | mint an embed token |
| `GET`/`PUT /host/v1/egress-allowlist` | `x-api-key` | tenant's outbound allowlist |
| `GET`/`PUT`/`DELETE /host/v1/secrets` | `x-api-key` | credential vault (names only on read) |

Responses are the proto messages themselves, serialised with `JsonFormatter`, so this surface cannot
drift from the contract's shape. Publishing, storage, entitlement writes and the whole embed-JWT
surface stay gRPC-only - those belong to the publisher CLI and the plugin, which have real clients.

### 2.2 How a plugin reads host data - the part that is not obvious

A plugin bundle **cannot fetch the WordPress site directly.** `BundleEndpoints.cs` serves every
bundle with `connect-src 'self' {apiOrigin}`, deliberately, because that is what forces plugin egress
through `EgressProxy` rather than a direct `fetch()`. That constraint is load-bearing and was not
relaxed.

The path is therefore:

```
plugin bundle
  -> hoc.http.send(...)                       (the only outbound door a bundle has)
    -> EgressProxy                            allowlist + SSRF checks + rate limit + audit
      -> https://<site>/wp-json/hoc/v1/q/...  the WordPress adapter
        -> HOC_JWT::verify()                  ES256 against the platform's JWKS
        -> wp_set_current_user()              become the real logged-in user
        -> named query, capability-checked
```

Two consequences that make the design work:

- **The site's own domain must be on its own egress allowlist.** A plugin calling the site it is
  embedded in is, from the platform's point of view, an outbound call like any other. The admin
  screen has a one-click "Also allow this site itself" for exactly this, because it is otherwise a
  baffling first-run failure.
- **Authentication uses a new reserved placeholder, `{{hoc:token}}`.** The plugin SDK deliberately
  does not expose the raw token (`HostRelayTokenProvider` keeps it private), so without this a plugin
  could not authenticate to its own host at all. `EgressProxy` substitutes the caller's own,
  already-validated token - and only when the target is one of the host's **registered origins**, not
  merely an allowlisted host. Forwarding a Platform API credential to an arbitrary allowlisted third
  party would hand them the ability to act as that tenant.

Because these calls are server-to-server from the platform, **no CORS handling exists anywhere in the
plugin**. If the bundle CSP is ever relaxed to allow direct browser calls, CORS becomes necessary.

## 3. Manifest mapping - no proto changes

Slot kinds map onto WordPress surfaces with no change to the contract:

| Manifest | WordPress |
|---|---|
| `kind: page` + `showInNav` | submenu under the HandOfClient admin menu |
| `kind: panel` | `[handofclient slot="..."]` shortcode and the `handofclient/panel` block |
| `kind: override` + `matchPath` | replaces the content of the matching singular view |

The manifest says *what* a slot is; the site's own settings say *where* it goes (which capability
gates it, whether it is on). Keeping those apart means a package never hardcodes another site's admin
menu structure - and it is why no `host_options` field was added to `Manifest`.

One shortcode and one block serve every panel slot, with the slot id as an attribute. N features need
no new registrations and no new plugin release.

### 3.1 The hook bridge - and why actions and filters cannot work the same way

A package can react to WordPress events by declaring them, without shipping any PHP:

```jsonc
"hooks": [
  { "hook": "the_title", "kind": "filter", "priority": 99,
    "transform": { "kind": "append", "text": " [via HandOfClient]" } },
  { "hook": "save_post", "kind": "action", "acceptedArgs": 3, "argIndexes": [0],
    "webhookUrl": "https://hooks.example.com/wp/save-post" }
]
```

The two kinds are implemented completely differently, and that asymmetry is a property of WordPress
rather than a v1 shortcut:

**Actions are fire-and-forget.** WordPress discards an action callback's return value, so the bridge
hands the event off without waiting - `wp_remote_post( ..., 'blocking' => false )`. Nothing a visitor
is waiting on blocks on a third party. The honest cost is that delivery is at-most-once and
unverified from the site's end, which is acceptable *precisely because* nothing was ever going to
branch on the result.

**Filters cannot be webhooks, at all.** A filter must return a value synchronously while WordPress is
blocked mid-computation. An HTTP round trip either stalls every affected page load on a remote
server, or - worse - has to invent a return value on timeout, silently corrupting the very content
the filter exists to shape. So a filter carries a small **declarative transform** (`append`,
`prepend`, `replace`, `const`) that `HOC_Hooks::apply_transform()` evaluates in-process, with no
network, no user code, and no regular expressions (a manifest-supplied pattern is a denial-of-service
primitive against a value the host is blocked on producing). Every branch is total: a non-string
value passes through untouched rather than being coerced, because `the_posts` hands over an array and
stringifying it to satisfy an "append" would destroy the page instead of decorating it.

A filter that declares a `webhookUrl` is **rejected at publish time** with that reason spelled out.
That refusal is the feature - the alternative is a filter that works in testing and truncates a
customer's content the first time the network is slow.

Three more things the bridge does that are not obvious:

- **The site never learns the destination.** It posts to `/host/v1/hook-event` naming a *hook*; the
  platform reads `webhookUrl` out of the published manifest and relays it. If the site could name the
  URL, that endpoint would be an open relay authenticated with a host API key. The hostname must be
  in both the manifest's `egressHosts` and the tenant's allowlist, exactly like plugin egress, and
  `EgressGuard` still runs after that - a denied relay is audited, since the site never sees the reply
  and would otherwise have no record that the hook fired and went nowhere.
- **Non-scalar hook arguments never leave the site.** WordPress routinely hands actions a whole
  `WP_Post`, `WP_User` or `WP_Comment`, carrying content, email addresses and password hashes.
  Anything that is not a scalar is reduced to `[object WP_Post]` and nothing else, so an innocuous
  `save_post` declaration cannot become a content exfiltration channel.
- **Some hooks are refused outright** (`plugins_loaded`, `init`, `all`, `shutdown`, ...). They fire on
  every request during bootstrap; attaching an outbound call to one is a way to make a site
  unbootable, and a package should not be able to do that to a customer by typo.

## 4. The data API

**Reads** - `HOC_Query_Catalog`. Named, parameterised, capability-checked. There is no endpoint that
accepts SQL, a `meta_query`, or a `WP_Query` argument array. Shipping catalogue:

`site.summary`, `posts.recent`, `posts.count-by-status`, `posts.count-by-month`, `terms.list`,
`comments.recent`, `comments.count-by-status`, `users.count-by-role`, `media.recent`, plus
`woo.orders.recent` and `woo.sales-by-day` when WooCommerce is present.

Only `posts.count-by-month` touches `$wpdb`, because WordPress has no API for a `GROUP BY` over
`post_date`; it is still fully parameterised through `prepare()` with a clamped range.

**Writes** - `HOC_Command_Catalog`. Deliberately tiny: `posts.create-draft` (never publishes),
`posts.set-meta` (allowlisted keys only), `comments.set-status` (no delete). Everything goes through
WordPress functions so hooks fire and caches invalidate. Idempotency via `X-HOC-Idempotency-Key`.

Both catalogues are filterable (`hoc_query_catalog`, `hoc_command_catalog`) so a site can add its own
named queries without forking the plugin.

## 5. Third-party data sources

`EgressProxy` already did the hard part. What was added is **secret injection**, without a contract
change: a plugin writes `{{secret:name}}` in a header or URL, and the proxy substitutes the tenant's
stored value server-side.

This closes a real hole that applies to every host, not just WordPress: without it, "let a plugin pull
from the customer's data source" means shipping the customer's API key into browser JavaScript.

- Values are stored per-tenant on the platform (`TenantSecretEntity`), never in the WordPress
  database, and there is no read-back endpoint - the admin screen lists names and timestamps only.
- Substitution happens **before** the URL is parsed, so the allowlist and SSRF checks always run
  against the final target.
- An unset secret fails the call with a message naming it, rather than sending a literal
  `{{secret:x}}` to a third party.

OAuth-based sources (Google Analytics, QuickBooks, Shopify) still need a platform-side OAuth broker -
see "Not built" below.

## 6. Install and pair

```
npm run build --workspace=@handofclient/embed-js   # produces embed.global.js
node host-adapters/wordpress/build.mjs                      # -> host-adapters/wordpress/dist/handofclient-<v>.zip
```

Then, on the platform:

```
dotnet run --project tools/sample-bootstrap/HandOfClient.SampleBootstrap -- register-host \
  --api-base-url https://<platform> --super-admin-key <key> \
  --host-id <hostid> --display-name "<name>" --origins "https://<site>"
```

Keep the API key it prints - it is shown exactly once. In WordPress: upload the zip, activate, go to
**HandOfClient > Settings**, fill in the platform URL / host id / API key, tick Enabled, and read the
Status table. It performs a live `whoami` and explicitly checks whether the site's own URL is a
registered origin, which is the single most common first-run failure (without it the browser refuses
to frame the bundle and all you see is an empty box).

Prefer `define( 'HOC_API_KEY', 'hoc_...' );` in `wp-config.php` over the database field.

To publish and activate the reference plugin:

```
npm run build --workspace=@handofclient/wp-site-snapshot-plugin
cd samples/plugins/wp-site-snapshot
npx hoc-publish --manifest manifest.json --bundle bundle-dist --api-base-url <url> --api-key <key>
dotnet run --project tools/sample-bootstrap/HandOfClient.SampleBootstrap -- activate \
  --api-base-url <url> --host-api-key <key> --host-id <hostid> --tenant-id <site-host> \
  --package-id handofclient/wp-site-snapshot --slot-id site-snapshot --version 0.1.0
```

The tenant id defaults to the site's own host name (e.g. `yayatea.com`). That is deliberate: a staging
clone gets a different tenant id automatically and does not inherit production's activations.

## 7. Deployment prerequisite that is easy to miss

**The platform must be reachable from visitors' browsers, not just from the web server.** The browser
loads the plugin bundle from the embed origin and calls `GetActiveVersion` over grpc-web directly.
A platform reachable only on a private network or over Tailscale will pair successfully (the server
side works) and then fail to render anything, which looks like a plugin bug and is not.

## 8. The local dev harness

```
node host-adapters/wordpress/devharness/setup.mjs --start
```

Builds a genuine WordPress at `.wp-local/` (gitignored) and junctions this repo's plugin into its
`wp-content/plugins`, so edits are live. It uses a portable **native** PHP plus the official SQLite
integration drop-in - no Docker, no MySQL, no WASM - because ext/openssl, curl and the network stack
must behave exactly as they will on a customer's host. That is the whole reason for testing here
rather than in unit tests. `wp-env` was not used: it requires Docker, which is unavailable on the
Windows Server build machine.

Two things about it worth knowing before debugging something that is not a bug:

- **PHP's built-in server is single-threaded.** wp-admin feels slow. That is the server, not the
  plugin. `PHP_CLI_SERVER_WORKERS` needs `fork()` and does nothing on Windows.
- **`.wp-local/php/openssl.cnf` is load-bearing for the tests, not for the plugin.** Windows PHP
  ships without an openssl config, and without one `openssl_pkey_new()` fails - which breaks
  `test-jwt.php` (it generates a throwaway P-256 key) while the plugin itself, which only ever
  verifies, works fine. A missing cnf therefore fails only in testing, which is a confusing way round.

## 9. Verified

Run live against the dev platform on 2026-08-26, the second half inside a real WordPress install:

- Host gateway: auth enforced (401 on missing/bad key), `whoami`, `activations`, `active-version`,
  `embed-token`, `jwks`, plus secrets and egress-allowlist CRUD including rejection of malformed
  names and hostnames, and confirmation that a secret's value is never returned by any read.
- **A real platform-issued ES256 token verifies in PHP** against the live JWKS, and the verifier
  rejects both a tampered payload and a flipped signature. This is the riskiest integration point,
  because the unit tests sign with a PHP-generated key while production tokens are signed by .NET.
- `tests/test-jwt.php` - 30 assertions. `tests/test-hooks.php` - 21 assertions covering every filter
  transform branch, the non-string passthrough cases, and the hook-argument reducer's refusal to
  serialise an object's properties.

Inside a real WordPress (SQLite, WP 7.1, PHP 8.3.33):

- The plugin activates with no fatal, registers all four REST routes, and renders its admin screen
  with a live "Connection OK" and "this site is a registered origin: Yes" against the platform.
- A slot activated on the platform appears as an admin submenu on its own, and its **bundle loads and
  runs in the browser** - proving `embed.js`, the `_wpnonce` token path and the mount pipeline.
- **All eight named queries return real site data** driven by a real ES256 token, including the one
  `$wpdb` `GROUP BY` (`posts.count-by-month`).
- **Capability enforcement is real.** A token minted for a subscriber gets `200` on `site.summary` and
  `403` on `posts.recent`, `posts.count-by-status`, `comments.recent` and `users.count-by-role`, each
  naming the capability it lacked. This is WordPress's own capability system doing the work via
  `wp_set_current_user`, not the plugin being careful.
- Writes land in the database, are capability-gated the same way, and are genuinely idempotent - the
  same `X-HOC-Idempotency-Key` returns the same `postId` with `idempotentReplay: true`.
- Negative cases: tampered payload, flipped signature, **`alg: none`**, unknown query and unknown
  command are all rejected with distinct codes. The `X-HOC-Token` header fallback works.
- **Hook bridge, end to end.** A declared `the_title` filter changes the rendered homepage with no
  network call. A declared `save_post` action fires on a real web request, dispatches non-blocking to
  the platform, and is refused at the right layer with an audit row - the platform resolves the
  destination from the published manifest, checks the allowlist, then runs `EgressGuard`. Posting a
  *filter's* hook name as an action is rejected, as is a filter declaring a `webhookUrl` at publish
  time.

Not yet verified live, and honestly flagged:

- **The final HTTP delivery of an action webhook to a real receiver.** Every layer up to and including
  the SSRF guard is exercised; the last hop needs a public endpoint to deliver to.
- **The full egress round trip** (`{{secret:...}}` and `{{hoc:token}}` substitution through a real
  `EgressProxy.Send`). `SecretResolver` has 25 unit tests; the wiring into the proxy is compile-checked
  only. `EgressGuard` blocks private IPs and the manifest validator rejects `localhost` as an egress
  host - both correct - so this needs the harness reachable at a public hostname, not just a public
  platform.
- **Mobile viewport.** Blocked by a Chrome-extension automation limitation on this machine, now seen
  three times across separate sessions: `resize_window` reports success and the rendering does not
  change. Needs a manual check or an automation-side fix, not another retry.

## 10. Not built, deliberately

- **OAuth broker.** Third-party sources needing OAuth (Analytics, QuickBooks, Shopify) require the
  platform to own the OAuth app and store per-tenant refresh tokens, since a redirect URI cannot be
  registered per customer domain.
- **Scheduled pulls.** Do not use WP-Cron: it fires on page loads, so a low-traffic site never syncs,
  and many hosts set `DISABLE_WP_CRON`. Schedules belong on the platform, pushing into the site.
- **SSR fragment mode.** Public-facing output is an iframe today, which is wrong for SEO and cannot
  inherit theme CSS. The fix is an embed mode where the platform returns sanitised HTML that the
  plugin fetches server-side and runs through `wp_kses` - real platform work, not a plugin tweak.
- **Per-user preview activations.** Most WordPress sites have no staging. An activation visible only
  to the admin who requested it would be a small platform change and a large trust difference.
- **Encryption at rest for secrets.** Stored plaintext, matching `SigningKeyEntity`'s own PKCS8 bytes.
  Encrypting only this table would add key-management surface without changing what an attacker with
  database access can do. If that changes, both move together.
