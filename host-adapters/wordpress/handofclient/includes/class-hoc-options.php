<?php
/**
 * Settings storage.
 *
 * @package HandOfClient
 */

defined( 'ABSPATH' ) || exit;

/**
 * All plugin settings live in one autoloaded option so the common path (every page load asking "am I
 * enabled?") is a single cache hit rather than one query per setting.
 */
class HOC_Options {

	const OPTION_KEY = 'hoc_settings';

	/**
	 * The one platform instance this plugin ships paired to. There is currently exactly one
	 * HandOfClient deployment (operated by HandOfClient itself, not self-hostable per-customer), so
	 * seeding this as a real default - not just a placeholder hint - saves every install from typing
	 * a URL they could not plausibly get wrong. Still a plain settings field, not a constant, so a
	 * local dev/staging platform can override it exactly like today.
	 */
	const DEFAULT_PLATFORM_BASE_URL = 'https://hocapi.panglosstechnologies.com';

	/**
	 * Defaults. Anything added here is picked up by existing installs automatically via the
	 * wp_parse_args in get_all(), so a new setting never needs a migration.
	 *
	 * @return array<string,mixed>
	 */
	public static function defaults() {
		return array(
			'enabled'           => false,
			'platform_base_url' => '',
			'embed_origin'      => '',
			'host_id'           => '',
			'api_key'           => '',
			'tenant_id'         => '',
			// HMAC secret that verifies the platform's signed webhooks (returned once, when the webhook URL is
			// registered). Prefer the HOC_WEBHOOK_SECRET constant - see get_webhook_secret().
			'webhook_secret'    => '',
			// Request box + "my features" dock on every front-end page for signed-in users.
			'show_dock'         => true,
			// Slot discovery cache lifetime. Short enough that activating a plugin on the platform
			// shows up promptly, long enough that a busy site is not making an HTTP call per request.
			'cache_ttl'         => 300,
			// Per-slot WordPress placement, keyed by slot id. The manifest says what a slot IS
			// (page/panel/override, title, path); this says where THIS site puts it. Keeping the two
			// apart means a package never hardcodes another site's admin menu structure.
			'slot_map'          => array(),
		);
	}

	/**
	 * @return array<string,mixed>
	 */
	public static function get_all() {
		$stored = get_option( self::OPTION_KEY, array() );
		if ( ! is_array( $stored ) ) {
			$stored = array();
		}
		return wp_parse_args( $stored, self::defaults() );
	}

	/**
	 * @param string $key     Setting name.
	 * @param mixed  $default Value if unset.
	 * @return mixed
	 */
	public static function get( $key, $default = null ) {
		$all = self::get_all();
		return array_key_exists( $key, $all ) ? $all[ $key ] : $default;
	}

	/**
	 * @param array<string,mixed> $values Partial settings to merge in.
	 * @return void
	 */
	public static function update( array $values ) {
		update_option( self::OPTION_KEY, array_merge( self::get_all(), $values ) );
	}

	/**
	 * Seeds first-run defaults. Never overwrites an existing value, so deactivate/reactivate keeps
	 * the site paired.
	 *
	 * @return void
	 */
	public static function seed_defaults() {
		$current = get_option( self::OPTION_KEY, null );
		if ( null === $current ) {
			add_option( self::OPTION_KEY, self::defaults() );
		}
		if ( '' === self::get( 'tenant_id', '' ) ) {
			self::update( array( 'tenant_id' => self::default_tenant_id() ) );
		}
		if ( '' === self::get( 'platform_base_url', '' ) ) {
			self::update( array( 'platform_base_url' => self::DEFAULT_PLATFORM_BASE_URL ) );
		}
	}

	/**
	 * The site's own host name, e.g. "example.com".
	 *
	 * Deliberately derived from the domain rather than a generated UUID: a staging clone of this site
	 * then gets a DIFFERENT tenant id automatically and does not inherit production's activations,
	 * which is what you want. The tradeoff is that changing the site's domain orphans its activations
	 * - a rare and highly visible event, versus a clone silently sharing production's plugins, which
	 * is neither.
	 *
	 * On multisite each blog is its own tenant, so the blog id disambiguates subdirectory installs
	 * that share a host name.
	 *
	 * @return string
	 */
	public static function default_tenant_id() {
		$host = wp_parse_url( home_url(), PHP_URL_HOST );
		if ( ! is_string( $host ) || '' === $host ) {
			$host = 'unknown-host';
		}
		if ( is_multisite() ) {
			return $host . '/' . get_current_blog_id();
		}
		return $host;
	}

	/**
	 * The API key, preferring a wp-config.php constant over the database.
	 *
	 * A constant is the better posture - it keeps the credential out of the options table (and
	 * therefore out of every database dump, migration plugin, and staging clone) - but requiring it
	 * would make the plugin uninstallable for anyone without file access to wp-config.php, which is
	 * most people on managed hosting. Supporting both, constant wins, is the honest compromise; the
	 * admin screen says which one is in effect.
	 *
	 * @return string
	 */
	public static function get_api_key() {
		if ( defined( 'HOC_API_KEY' ) && is_string( HOC_API_KEY ) && '' !== HOC_API_KEY ) {
			return HOC_API_KEY;
		}
		$key = self::get( 'api_key', '' );
		return is_string( $key ) ? $key : '';
	}

	/**
	 * @return bool True when the key comes from wp-config.php rather than the database.
	 */
	public static function api_key_is_from_constant() {
		return defined( 'HOC_API_KEY' ) && is_string( HOC_API_KEY ) && '' !== HOC_API_KEY;
	}

	/**
	 * The webhook secret, preferring a wp-config.php constant over the database (same reasoning as
	 * get_api_key()).
	 *
	 * @return string
	 */
	public static function get_webhook_secret() {
		if ( defined( 'HOC_WEBHOOK_SECRET' ) && is_string( HOC_WEBHOOK_SECRET ) && '' !== HOC_WEBHOOK_SECRET ) {
			return HOC_WEBHOOK_SECRET;
		}
		$secret = self::get( 'webhook_secret', '' );
		return is_string( $secret ) ? $secret : '';
	}

	/**
	 * @return bool True when the webhook secret comes from wp-config.php rather than the database.
	 */
	public static function webhook_secret_is_from_constant() {
		return defined( 'HOC_WEBHOOK_SECRET' ) && is_string( HOC_WEBHOOK_SECRET ) && '' !== HOC_WEBHOOK_SECRET;
	}

	/**
	 * Platform API base URL with any trailing slash removed, so callers can concatenate paths.
	 *
	 * @return string
	 */
	public static function get_platform_base_url() {
		$url = self::get( 'platform_base_url', '' );
		return is_string( $url ) ? untrailingslashit( trim( $url ) ) : '';
	}

	/**
	 * Origin serving plugin bundles.
	 *
	 * Defaults to the platform base URL's own origin, which is correct for today's single-service
	 * deployment, but they are two separate things in the design (api.* vs embed.*) so this stays
	 * overridable rather than being computed at every call site.
	 *
	 * @return string
	 */
	public static function get_embed_origin() {
		$explicit = self::get( 'embed_origin', '' );
		if ( is_string( $explicit ) && '' !== trim( $explicit ) ) {
			return untrailingslashit( trim( $explicit ) );
		}

		$base = self::get_platform_base_url();
		if ( '' === $base ) {
			return '';
		}

		$parts = wp_parse_url( $base );
		if ( ! is_array( $parts ) || empty( $parts['scheme'] ) || empty( $parts['host'] ) ) {
			return '';
		}

		$origin = $parts['scheme'] . '://' . $parts['host'];
		if ( ! empty( $parts['port'] ) ) {
			$origin .= ':' . $parts['port'];
		}
		return $origin;
	}

	/**
	 * @return string
	 */
	public static function get_tenant_id() {
		$tenant = self::get( 'tenant_id', '' );
		if ( ! is_string( $tenant ) || '' === trim( $tenant ) ) {
			return self::default_tenant_id();
		}
		return trim( $tenant );
	}

	/**
	 * @return string
	 */
	public static function get_host_id() {
		$host_id = self::get( 'host_id', '' );
		return is_string( $host_id ) ? trim( $host_id ) : '';
	}

	/**
	 * True only when every field needed to talk to the platform is present AND the site owner has
	 * switched the adapter on. Checked before any hook is registered - see hoc_bootstrap().
	 *
	 * @return bool
	 */
	public static function is_enabled() {
		if ( ! self::get( 'enabled', false ) ) {
			return false;
		}
		return self::is_paired();
	}

	/**
	 * @return bool
	 */
	public static function is_paired() {
		return '' !== self::get_platform_base_url()
			&& '' !== self::get_host_id()
			&& '' !== self::get_api_key();
	}

	/**
	 * Per-slot placement for this site.
	 *
	 * @param string $slot_id Slot id from the manifest.
	 * @return array<string,mixed>
	 */
	public static function get_slot_config( $slot_id ) {
		$map = self::get( 'slot_map', array() );
		$config = ( is_array( $map ) && isset( $map[ $slot_id ] ) && is_array( $map[ $slot_id ] ) )
			? $map[ $slot_id ]
			: array();

		return wp_parse_args(
			$config,
			array(
				// Which WP capability a user needs to see this slot at all. read = any logged-in
				// user; the admin screen offers the usual ladder.
				'capability'  => 'read',
				// admin menu placement for kind=page slots.
				'menu_parent' => 'hoc-root',
				// shortcode tag for kind=panel slots; empty means "no shortcode, block only".
				'shortcode'   => '',
				'enabled'     => true,
			)
		);
	}

	/**
	 * @param string              $slot_id Slot id.
	 * @param array<string,mixed> $config  Placement config.
	 * @return void
	 */
	public static function set_slot_config( $slot_id, array $config ) {
		$map             = self::get( 'slot_map', array() );
		$map             = is_array( $map ) ? $map : array();
		$map[ $slot_id ] = $config;
		self::update( array( 'slot_map' => $map ) );
	}
}
