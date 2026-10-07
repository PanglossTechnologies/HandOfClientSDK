# WordPress plugin authoring rules (for `/createpluginforcustomer`'s HandOfClient branch)

Parallel in role to `DotNetShared.Extensibility\PackageTemplate\AUTHORING-RULES.md` - this is what
`/createpluginforcustomer` reads before authoring a HandOfClient plugin targeting a WordPress host. Written
for the automation, not (only) a human - see `docs/plugin-author-tutorial.md` for the human-facing walkthrough
this doc assumes you've skimmed.

## Scaffold from a real sample, not a placeholder template

There is no separate inert `PackageTemplate/` folder here. Copy `samples/plugins/wp-site-snapshot/` (this
repo) as the starting point - it is a real, working, minimal reference plugin using every convention below,
kept live-verified against `wp-local` (see PROGRESS.md). Copying a real sample instead of a placeholder means
the copy can never silently drift out of date with what the platform actually requires.

## Package identity - read this before anything else

`packageId = "{publisherSlug}/{routeSlug}"` - the publisher segment is a slug for the CUSTOMER/COMPANY, **not**
the platform `hostId`. Confirmed from the real production example: publisher `"Yaya"`, `packageId
"yaya/site-snapshot"`, `hostId "yayatea"`. Deriving `publisherSlug`/`routeSlug` from the request text follows
the exact same slugging rule Step 5 of `/createpluginforcustomer` already uses for DotNetShared's `CompanyKey`
(lowercase, strip non-alphanumerics).

**A `packageId` is permanently bound to whichever `hostId` first successfully publishes it - there is no
transfer RPC (`PackageRegistryGrpcService.RequireOwnedPackageAsync` enforces this on every `PublishVersion`/
`Activate` call).** The consequence that matters here: **never publish a real customer's target `packageId` to
`wp-local` even once**, not even for a smoke test - doing so strands it on `wp-local` forever and makes it
impossible to ever publish that same `packageId` under the customer's real `hostId`. wp-local verification
(see "Verify before you ship" below) must use a throwaway, disposable `packageId` that is never reused for the
real publish.

Check whether `<Project>\wordpress-plugin\{routeSlug}\` already exists on disk before authoring, same
existing-vs-new-package branch Step 5 already documents for DotNetShared.

## Manifest slot kind -> WordPress surface (no proto/plugin-code change needed for any of these)

| `kind` | WordPress surface | Notes |
|---|---|---|
| `page` | Admin submenu | `targetPath` + `showInNav: true` - this is what makes it appear in the WP admin nav at all. |
| `panel` | A shortcode **and** a block, both generic | The slot id is an attribute, so N features registered this way need zero new WordPress registrations and no plugin release. |
| `override` | `the_content` replacement on the matching singular view | Full-page swap only, same "no content-injection path" limitation `Override` has on the DotNetShared side. |

Infer which kind from the request the same way Step 3 already infers `Override` vs `NewPage`: one existing
page's content being replaced/augmented in place -> `override` (only if the WHOLE content region can be
replaced - there is no partial-injection path); a small thing bolted onto an existing admin area, or content
combining multiple existing elements -> `panel` or `page` respectively.

## The data surface - this is the part that differs most from DotNetShared

A plugin bundle **cannot** fetch the WordPress site directly - the served CSP pins `connect-src` to the
platform API origin only (this is what forces all egress through `EgressProxy`, deliberately). Reading the
site's own content means: bundle calls `hoc.http.send` -> `EgressProxy` -> the site's own
`/wp-json/hoc/v1/...` data API -> `HOC_Query_Catalog` (`includes/class-hoc-query-catalog.php`).

**The query catalog is a FIXED, named, parameterized list - never raw SQL, never a caller-supplied
`meta_query`/`WP_Query`.** This is the WordPress analogue of DotNetShared's `/api/v1` surface, except much
narrower today. If the request needs data no existing catalog query exposes:
- Extending the catalog is allowed, but is a change to **unsandboxed, shared PHP that ships to the customer's
  real site** - not a per-tenant bundle the platform's own guarantees protect. There is no GuardTool
  equivalent for PHP (see `docs/wordpress-host.md`'s "why the extensibility model was NOT ported" - a
  two-token string concat defeats any static scanner, so there is no trustworthy in-process PHP sandbox).
  Keep any addition narrow, parameterized, and capability-checked, matching the existing entries' own style
  exactly (see `class-hoc-query-catalog.php`'s current entries for the pattern).
- **Call this out explicitly in the task's close-out description** ("shared plugin code changed, not just a
  per-tenant bundle") - this is a materially different risk profile worth a human noticing even after the
  fact, the same spirit as never silently recommending a host-app edit on the DotNetShared side.
- If a narrow catalog addition genuinely cannot satisfy the request safely, that is grounds for `Needs Human`,
  not a reason to reach for raw SQL or bypass the catalog.

**If the plugin needs to read the site's own content, the site's own domain must be on ITS OWN egress
allowlist** (the WP admin's Settings page calls this "Also allow this site itself" - it is the exact
`permission_denied ... not in both the manifest's egressHosts and the tenant's admin-approved allowlist`
error a first-run plugin shows before this is set). There is no dedicated automation CLI command for this yet
(`tools/sample-bootstrap` only has `register-host`/`add-host-origins`/`rotate-api-key`/`activate` - flagged as
a real gap, not built here). Set it directly instead, same host-api-key auth every other automation call in
this doc uses:
```
PUT {platformBaseUrl}/host/v1/egress-allowlist
x-api-key: {hostApiKey}
{"tenantId": "{tenantId}", "allowedHosts": ["{the site's own domain(s)}"]}
```
(This is the exact same endpoint the WP admin's own "Save allowlist" button calls - `class-hoc-admin.php`'s
`save_egress()`.)

## Hygiene - already enforced, nothing extra to hand-check

`hoc-publish` (the publisher CLI) already scans for `eval()`/`new Function()`, service-worker registration,
and common embedded-secret patterns at publish time - explicitly hygiene, not a security boundary, matching
this repo's own design-doc framing. Nothing in this workflow needs to duplicate that check.

## Never write raw PHP for a customer, ever

The WordPress plugin itself is FIXED code shipped through the normal plugin channel; customer features arrive
as data (a published, activated bundle). Generating PHP onto a customer's live site would be unsanctioned
root with no rollback and one fatal error between it and a white screen - see `docs/wordpress-host.md`. The
only PHP change this workflow should ever make is a narrow, reviewed addition to the shared query catalog
(see above), never a bespoke per-customer PHP file.

## Verify before you ship - two different things, don't conflate them

1. **Mechanics** (does the bundle mount, render, and handshake correctly against a real WordPress runtime at
   all): publish the THROWAWAY variant (disposable `packageId`, `hostId: "wp-local"`, `tenantId: "localhost"`)
   through `host-adapters\wordpress\devharness\test-plugin.ps1`'s existing build -> publish -> activate ->
   smoke-check pipeline. Also re-run `node host-adapters/wordpress/devharness/setup.mjs --test` (the existing
   PHP suites) if this session touched the shared query catalog or any other PHP under
   `host-adapters/wordpress/handofclient/` - a real regression gate, not optional.
2. **The real thing** (does the actual feature work for the actual customer): only provable by publishing the
   REAL `packageId` under the REAL `hostId` and activating for the REAL `tenantId` - there is no safe
   "staging" WordPress site the way DotNetShared has a `- Copy` folder. This is why step 1 must never use the
   real `packageId` - it is the only rehearsal available before the one-shot real publish.

## Version bump convention

`0.1.0` for a brand-new package. A semantic bump (`0.1.0` -> `0.1.1`/`0.2.0`) for an update to an EXISTING
`packageId` - same convention as DotNetShared's `Version` bump, same reasoning: `Pin`/`Rollback` already exist
on the platform as the safety net, so there is no reason to fear shipping a new version number.
