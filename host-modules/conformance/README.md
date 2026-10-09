# Host module conformance suite

Language-neutral HTTP tests for a **host module**: the part of a customer's site that serves `hoc/token`,
`hoc/api/*` and `hoc/webhook` (contract: [`openapi/site-hoc-api.yaml`](../../openapi/site-hoc-api.yaml)) and
calls the platform ([`openapi/platform-host-v1.yaml`](../../openapi/platform-host-v1.yaml)). The suite only
speaks HTTP, so it works against a module written in any language. It ships a **fake platform** that the
module talks to instead of the real one.

Needs Node 20+ (no npm install; zero dependencies).

```
# 1. start your module (conformance profile, below), pointed at the fake platform on :4010
# 2. run the suite against its hoc/ prefix
node host-modules/conformance/run.mjs --base-url http://127.0.0.1:5000/hoc
```

`run.mjs` starts the fake platform, runs the suite one file at a time and exits non-zero on any failure, so
it drops straight into CI. Options: `--platform-port` (default 4010), `--platform-bind` (default `127.0.0.1`;
`0.0.0.0` if the module runs in a container), `--fresh-db` (also run the default-settings test, see below),
`--only <file-name-part>`, `--reporter <spec|tap|dot|...>`.

## The conformance profile

The suite needs to sign in as different people and to know where the platform is, so the module under test
is started with a small **test configuration**. Nothing here is for production.

| What | Value |
|---|---|
| Platform base URL | `http://127.0.0.1:4010` (env `HOC_CONFORMANCE_PLATFORM_PORT` / `--platform-port` to change) |
| Host API key (`x-api-key`) | `conformance-host-api-key` (`HOC_CONFORMANCE_API_KEY`) |
| Webhook secret | `whsec_conformance` (`HOC_CONFORMANCE_WEBHOOK_SECRET`) |
| Tenant id | `conformance-tenant` (`HOC_CONFORMANCE_TENANT_ID`) |
| Host id (package ids are `{hostId}/f-{ref}`) | `conformance` (`HOC_CONFORMANCE_HOST_ID`) |
| Mount prefix | whatever you put in `--base-url` (normally `hoc`) |
| Storage | a database the suite may write to. It never resets it: every test uses its own ids and paths. A brand-new database is only needed for the default-settings test (`--fresh-db`) |

**Identity.** The module's three site callbacks are replaced by a fixed roster, with the user id in a cookie
named `hoc_user`:

| `get_current_user` | cookie `hoc_user=<id>` returns `{id, name}` for the ids below; any other value or no cookie returns nothing (401) |
|---|---|
| `is_admin(user)` | true only for `admin` |
| `find_users(query)` | case-insensitive substring match on id or name over the roster, never the caller |

| id | name |
|---|---|
| `admin` | Ada Admin |
| `alice` | Alice Owner |
| `bob` | Bob Builder |
| `carol` | Carol Customer |
| `dave` | Dave Dev |
| `erin+qa@example.com` | Erin Special (an id that needs percent-encoding in a URL) |

Unknown user ids in a share request must be rejected, so the module needs a user lookup that knows this
roster. The suite sends only `application/json` bodies and cookies, so the module's CSRF protection must let
those through in the test profile (the contract says the site applies its normal CSRF policy; turn that off
or allow the cookie-only test client).

`selftest/reference-host.mjs` is a complete working example of the profile, and so are the three apps in
[`../python/conformance`](../python/conformance) (Flask, Django, FastAPI over `handofclient`).

## What it covers

| File | Contract area |
|---|---|
| `01-identity` | every call is 401 without a session; identity is never read from headers, query or body |
| `02-requests` | `POST/GET requests` (validation, limits, filters, paging, `scope=all` vs `viewAllRequests`), `reply`, and the build the module starts on the platform (tenant, requestRef, user, snapshot, mode, API key, outage tolerance) |
| `03-token` | `GET token`: only visible features, only the session user, pin / current version, re-check on every call, withdrawn version (409), platform failure (502), no token ever minted for an invisible feature |
| `04-features` | `GET features`, versions, `pin`, `current`, `share`, `unshare`, `enabled`, `users`, and the sharing settings |
| `05-resolve` | `GET resolve`: fields, exact path match, pins, user-specific assignment beats everyone, most-recently-assigned wins, one page-override/new-page per path |
| `06-webhook` | HMAC over the raw bytes, missing/wrong/tampered signatures, `stale_event` (300 s), duplicate `eventId`, malformed JSON, unknown and legacy events, `build.status` and `build.version` effects |
| `07-settings` | admin-only settings, validation, data sources and secrets pushed to the platform without ever being returned |

Not covered (needs a module-specific harness): the legacy token call with no `featureId`, CSRF policy,
the module's own database migrations, retry timing after a platform outage, and rendering in a browser
(that is `sdk/embed-js`'s test suite).

Where the contract leaves a status open, the suite accepts the documented alternatives (for example
403 or 404 when a non-requester replies to a request) rather than guessing.

## The fake platform (local development without a real platform)

`fake-platform/platform.mjs` implements the part of `/host/v1` a site calls: `POST /builds` (validated and
idempotent like the real one), `GET /builds/{id}`, `POST /builds/{id}/reply`, `POST /embed-token` (a real
ES256 JWT with the documented claims, verifiable against `GET /jwks`), `PUT /data-sources`, `PUT /secrets`,
and the public bundle route `GET /embed/{packageIdB64}/{version}/{path}`. It records every call and sends
HMAC-signed webhooks with the documented headers, `eventId` and `sentAt`.

To develop a site against it with no platform at all:

```
node host-modules/conformance/fake-platform/cli.mjs \
  --webhook-url http://127.0.0.1:5000/hoc/webhook --auto-build
```

Configure your site with the printed API base URL, host API key and webhook secret. `--auto-build` answers
every build with a placeholder version `1.0.0` a moment later (`build.version`, then `build.status`
`Success`), so the whole loop - request, build, version, token, resolve - works end to end. Without it you
drive the loop yourself through the control API. The placeholder bundle is a trivial module, not a real
plugin; use the real platform for anything that depends on bundle contents.

Differences from the real platform: nothing is persisted; there is no tenant activation (an embed token
without `version` answers `412`); there is no build automation and no webhook retry or outbox; the signing
key is generated at start-up.

### Control API (`/_fake/*`, no key)

| Call | Does |
|---|---|
| `GET /_fake/calls?since=<seq>` | every recorded `/host/v1` call: `seq, method, path, query, apiKey, body, status` |
| `GET /_fake/builds` | the builds the site started |
| `POST /_fake/publish` `{requestRef, featureRef?, version, path?, kind?, mode?, slotId?, success?}` | publish a version and send `build.version` (then `build.status` `Success` unless `success:false`) |
| `POST /_fake/status` `{requestRef, status, message?}` | send `build.status` |
| `POST /_fake/deliver` `{body \| rawBody, secret?, signature?, omitSignature?, event?}` | send any webhook, signed or deliberately not |
| `POST /_fake/withdraw` `{packageId, version}` | make the platform answer 409 for that version |
| `POST /_fake/failures` `{match, status?, times?, drop?}` | make the next calls whose `"METHOD /path"` matches the regex fail (or drop the connection) |
| `DELETE /_fake/failures`, `POST /_fake/reset` | clear injected failures / everything |

`lib/client.mjs` wraps all of these for JavaScript tests.

## Proving the suite itself

```
npm run test:conformance            # from the repo root: suite vs the in-memory reference hostnode host-modules/conformance/selftest/mutants.mjs   # reference host with one deliberate bug at a time; the suite must fail each
```

`selftest/reference-host.mjs` is a small in-memory host module written straight from the OpenAPI file; it is
also a readable executable form of the contract. If you find a behaviour the suite or the reference host gets
wrong, fix the OpenAPI file first, then both.
