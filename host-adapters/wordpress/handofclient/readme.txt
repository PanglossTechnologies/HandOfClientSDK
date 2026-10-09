=== HandOfClient ===
Contributors: handofclient
Tags: plugins, extensibility, embed, api
Requires at least: 6.0
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 0.2.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Mounts versioned, sandboxed HandOfClient plugins into your site, and gives them a
capability-checked API to read and write your content.

== Description ==

HandOfClient lets custom features be built for your site and delivered as versioned packages that
can be rolled back, switched off, and audited - without anyone writing new PHP into your
installation.

**This plugin never installs generated code on your site.** It is fixed code, updated like any other
plugin. Custom features arrive as data: a package activated for your site on the HandOfClient
platform, rendered inside a sandboxed iframe. That is the whole design, and it is what makes the
following true:

* A broken feature cannot take your site down. Worst case it shows an error box where it should have
  rendered, and after repeated failures the plugin stops mounting anything at all (safe mode) while
  leaving the rest of your site untouched.
* Every feature is versioned and can be rolled back from the platform.
* A feature can only read what the logged-in user could already read. Data access goes through a
  fixed catalogue of named queries, each requiring a WordPress capability, run as the real user.
* A feature can only call third-party services you have explicitly allowlisted.
* API keys a feature needs are stored on the platform, not in your database, and are substituted
  into outbound requests server-side. The feature never sees them, and neither does the browser.

= Request a feature =

Signed-in users get a "Request a feature" button on every page. They describe what they want, it is built
automatically, and only they see the change until they (or an administrator, as your sharing rules allow)
share it. Administrators get **HandOfClient > Request a Feature** and **HandOfClient > Feature admin** in
wp-admin. Requests, features and who-sees-what are stored in `hoc_*` tables in your own database. This needs
PHP 8.1 or newer and the `pdo_mysql` extension (or the SQLite database plugin).

= Where features appear =

Each activated package declares what kind of surface it is, and you choose where it goes:

* **Page** - an entry under the HandOfClient admin menu.
* **Panel** - the `[handofclient slot="..."]` shortcode, or the "HandOfClient panel" block.
* **Override** - replaces the content of one specific page.

= The data API =

Features read your site through named, parameterised queries such as `site.summary`,
`posts.recent`, and `comments.count-by-status`. There is no endpoint that accepts SQL or arbitrary
query arguments. Each query declares the WordPress capability it requires, and runs as the user who
is actually logged in - so a feature shown to an Editor sees exactly what that Editor sees.

Writes are a much shorter list (create a draft, set an allowlisted meta key, moderate a comment),
all performed through WordPress's own functions so hooks and caches behave normally, and all
idempotent so a retry cannot double up.

The full catalogue, including which capability each query needs, is visible at
`/wp-json/hoc/v1/catalog` to administrators.

== Installation ==

1. Upload the plugin zip through Plugins > Add New > Upload Plugin, and activate it.
2. Go to **HandOfClient > Settings**.
3. Enter the platform API URL, your host id, and your API key, then save.
4. Tick **Enabled**.
5. Check the Status table at the top of the page. It tells you whether the platform is reachable,
   whether the key is accepted, and whether this site's URL is registered as an allowed origin on the
   platform - features will not render until that last one is true.

To use "Request a feature", register the Webhook URL shown in the Status table with the platform, and
enter the webhook secret it returns.

For better security, put the API key and webhook secret in `wp-config.php` instead of the database:

    define( 'HOC_API_KEY', 'hoc_...' );
    define( 'HOC_WEBHOOK_SECRET', 'whsec_...' );

The plugin prefers that constant when it is present, which keeps the credential out of database
dumps, migration exports and staging clones.

== Frequently Asked Questions ==

= Does this send my content to a third party? =

No. Your content is read by features running in your own browser, and the requests are made against
your own site. The platform brokers those requests (which is what lets it enforce the allowlist and
keep an audit trail) but the data is not stored there.

= What happens if the platform is unreachable? =

Features do not render, and the plugin shows an error where each one would have been. The rest of
your site is unaffected. Failed platform lookups are cached briefly so an outage does not slow down
every page view.

= Does this work with page caching? =

Yes. Features mount in the browser after the page loads, so cached HTML is not a problem. Note that
a feature placed on a public page will only render for visitors whose role satisfies the capability
you set for that slot.

= Can I turn everything off quickly? =

Untick **Enabled** on the settings screen. No hooks are registered at all when it is off.

== Changelog ==

= 0.2.0 =
* Request a feature: per-user request box, "my features" and feature admin on the new host module,
  a webhook receiver at /hoc/webhook, and WordPress users mapped onto the module. Replaces the
  admin-only "Request a Feature" form.

= 0.1.0 =
* First release: pairing, slot discovery, page/panel/override mounting, the named-query data API,
  the write-command API, outbound allowlist management, platform-side credential storage, and the
  safe-mode circuit breaker.
