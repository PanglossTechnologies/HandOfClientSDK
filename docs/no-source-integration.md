# Integrating a host you do not have source for

For a customer site where you cannot change the application's code. Read `docs/wordpress-host.md` first:
WordPress is the case where the "adapter" is an installable package. This doc covers everything else.

STATUS: this guide is built from the host contract (`sdk/embed-js/src/host/index.ts`,
`openapi/platform-host-v1.yaml`). Nothing here except the WordPress path has a shipped adapter. Anything marked
UNBUILT needs code you would write yourself.

## 1. What a host must provide (the whole contract)

1. **A page that loads `embed.js`** and calls `HandOfClient.configure({apiBaseUrl, embedOrigin})`, then
   `HandOfClient.mount(container, {hostId, tenantId, packageId, slotId, tokenUrl, theme, locale, launchParams})`.
2. **A same-origin `tokenUrl`** that returns `{token, expiresAt, userId, displayName?}`. `embed.js` fetches it
   with `credentials: "same-origin"`, GET, no body. The backend mints the token by calling
   `POST {platform}/host/v1/embed-token` with `x-api-key`.
3. Optional: webhooks / `hook-event` (see wordpress-host.md 3.1).

Everything else (bundle serving, CSP, egress proxy, secrets vault, entitlements) is on the platform side.
So "no source" reduces to three problems: get a script onto their page, serve a token endpoint
same-origin, and know who the logged-in user is.

## 2. The three problems, and the options

### 2.1 Getting `embed.js` and a mount point onto their pages

| Option | Needs from customer | Notes |
|---|---|---|
| **A. CMS/platform plugin** (WordPress done; Shopify, Wix, etc. would each be a new adapter) | Admin rights to install | Best case; no source. |
| **B. Tag manager** (GTM etc.) | Ability to add a tag | Inject `embed.js` + a mount container by CSS selector. Works for any site that already has a tag manager. |
| **C. Reverse-proxy injection** (nginx `sub_filter`, Cloudflare Worker `HTMLRewriter`) | DNS/proxy control of their domain | Rewrites HTML to add the script and container. Strongest control, but you now sit in front of their production traffic. Gzip must be disabled upstream for `sub_filter`. |
| **D. Standalone page you host** | Nothing but a link/nav entry | Your own page at `portal.yourdomain` mounts the plugin. Weakest: not "inside" their app, and see 2.3 for identity. |

Mount points: with no source you cannot add slots to their templates. Options B/C pick an existing
element by CSS selector; the plugin renders into a container you append there. Anything needing their
markup to change is out of scope.

### 2.2 The same-origin token endpoint

`embed.js` fetches `tokenUrl` same-origin, so it must live on the customer's domain. Without app code:

- **Reverse proxy route** (`/hoc/token` on their domain, proxied to a small service you run). This is the
  only no-source way. Requires option C-level control of their domain's routing.
- The service holds the **host API key** (never in the browser), checks who the user is (2.3), and calls
  `/host/v1/embed-token`. UNBUILT: no generic "token service" exists today. It would be ~50 lines in any
  language; the platform side needs no change.

If you cannot proxy their domain, `tokenUrl` cannot be same-origin, and `embed.js` as written will not work
(it does a same-origin fetch with cookies). Cross-origin tokenUrl would be an `embed.js` change, with CORS
and CSRF consequences; do not do it casually.

### 2.3 Who is the user? (the hard part)

The embed token carries a `userId`. The token service must get that from somewhere trustworthy:

| Source | Without source code? |
|---|---|
| Their app already sits behind an SSO/forward-auth proxy (oauth2proxy, Cloudflare Access, Okta) that sets an identity header | Yes: token service reads the verified header. Easiest. |
| Their session cookie is a signed/standard format you can validate (JWT, known framework cookie) | Possible, needs their signing key or JWKS. Fragile; breaks when they rotate or change framework. |
| Their app has an "introspection" or "whoami" endpoint | Token service forwards the cookie to it and trusts the answer. Works if one exists. |
| None of the above | **Cannot do it safely.** Do not trust a userId from the browser. Fall back to option D with your own login, and treat the customer as external users of your portal. |

Never accept `userId` from a query string or body on the token endpoint. That lets any visitor mint a
token as any user.

## 3. Getting host data into plugins

Plugins have no direct line to the host's backend. Their only outbound door is `hoc.http.send` through
`EgressProxy` (allowlist, SSRF checks, rate limit, audit). Choices, cheapest first:

1. **`launchParams` snapshot.** The mount page passes values at mount time. With no source this means
   scraping from the DOM in option B/C, which is brittle. OK for a few values, not a data source.
2. **Customer API + stored credential.** If the customer has any API (REST, or a read-only DB view behind
   an API), put its host on the tenant's egress allowlist and store the key in the secrets vault
   (`PUT /host/v1/secrets`). The plugin sends `Authorization: Bearer {{secret:name}}`; the proxy
   substitutes it server-side so the plugin never sees it. This is the usual no-source answer.
   Limit: the credential is per tenant, not per end user, so the API sees a service account. Do user-level
   permission checks in the plugin's manifest/entitlements, not in their API.
3. **Customer API + user identity (`{{hoc:token}}`).** Only substituted for the host's *registered origins*.
   Their API would have to verify ES256 tokens against `/host/v1/jwks`: that is a code change on their
   side. If you control a gateway in front of their API, the gateway can do the verification (UNBUILT).
4. **Data push.** They (or a scheduled export) push data to you via a webhook or file drop; the plugin
   reads your copy. No live data, but no access to their systems at all. Often the right trade for a
   customer who will not open any API.

If none of 2-4 is possible, the plugin can only show data that is already on their pages (1) or your own.

## 4. Checklist for a new no-source host

1. Decide 2.1 (script placement) and 2.2 (can you route a path on their domain?). If both no, only
   option D is available.
2. Decide 2.3 (identity source). If none, stop and use option D.
3. `RegisterHost` with the customer's real page origins (these are also the origins `{{hoc:token}}` trusts).
   Keep the API key only on the token service.
4. Stand up the token service behind `/hoc/token`; confirm it returns 401 with no identity and the right
   `userId` with one. Test with two different users.
5. Put the customer API host on the egress allowlist; store credentials in the vault (section 3.2).
6. Add the script/container (2.1), activate a package for the tenant, mount, and check both viewports.
7. Get their written agreement on what you inject into their pages and the proxy you run in front of them:
   a proxy or tag-manager script on their site is production access, even though you hold no source.

## 5. What this means for scope

| Customer asks for | No-source feasible? |
|---|---|
| New widget/panel/dashboard fed by an API or exports | Yes |
| Extra page linked from their nav | Only via CMS adapter or 2.1 B/C injection |
| Change or replace an existing screen | Only for CMS "override" slots; otherwise no |
| Per-user permissions mirrored from their app | Only if 2.3 gives you roles; otherwise no |
| Writing back to their system | Only through a customer-provided write API (section 3.2) |
