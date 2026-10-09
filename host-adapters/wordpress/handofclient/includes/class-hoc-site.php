<?php
/**
 * The customization loop on this site: signed-in users type "I want X", it is built, and only the
 * requester sees the change until it is shared.
 *
 * @package HandOfClient
 */

defined( 'ABSPATH' ) || exit;

/**
 * WordPress side of the bundled PHP host module (`handofclient/host`, host-modules/php):
 *
 *  - serves the module's three endpoint groups (`hoc/token`, `hoc/api/*`, `hoc/webhook`) under
 *    `<home>/hoc/...`, answering from `init` before WordPress routes the request;
 *  - maps WordPress users onto the module's three callbacks (current user, is-admin, user search);
 *  - on the front end, for signed-in users only, loads embed.js, applies the features that match the page
 *    (`autoMount`) and shows a request box + "my features" dock;
 *  - in wp-admin, shows the same request box and `<hoc-feature-admin>`;
 *  - retries builds the platform could not take at submit time from WP-Cron.
 *
 * The module keeps requests, features, versions and assignments in `hoc_*` tables in the WordPress
 * database (see HOC_Site_Loader::connection_spec()). Everything here is syntax-compatible with PHP 7.4 so
 * that older installs keep running the slot features; the module itself needs 8.1.
 *
 * Identity comes only from the WordPress session. The filters below exist so a site (or a test profile)
 * can map users differently; a callback returning the sentinel leaves the default in place.
 */
class HOC_Site {

	/** First path segment this loop answers under. */
	const ROUTE_SLUG = 'hoc';

	/** WP-Cron hook that retries unstarted builds. */
	const CRON_HOOK = 'hoc_site_retry_builds';

	/** Script handle shared with the legacy slot mounts (HOC_Mounts). */
	const EMBED_HANDLE = 'hoc-embed';

	/** @var object|null The HostModule once built. */
	private static $module = null;

	/** @var string|null Cached HOC_Site_Loader::unavailable_reason(). */
	private static $unavailable = null;

	/** @var bool Static: the inline configure() must be added once per page however many instances ask. */
	private static $embed_configured = false;

	/**
	 * @return void
	 */
	public function register() {
		add_action( 'init', array( $this, 'maybe_serve' ), 0 );
		add_action( 'init', array( $this, 'schedule_cron' ) );
		add_filter( 'cron_schedules', array( $this, 'cron_schedules' ) );
		add_action( self::CRON_HOOK, array( $this, 'run_cron' ) );

		add_action( 'wp_head', array( $this, 'print_head_snippet' ), 0 );
		add_action( 'wp_enqueue_scripts', array( $this, 'enqueue_front_end' ) );
		add_action( 'wp_footer', array( $this, 'print_dock' ) );

		add_shortcode( 'hoc_request_feature', array( $this, 'shortcode_request_feature' ) );
		add_shortcode( 'hoc_my_features', array( $this, 'shortcode_my_features' ) );
	}

	// ------------------------------------------------------------------ state

	/**
	 * True when the loop can run: switched on, paired, a webhook secret, and a server that can host it.
	 *
	 * @return bool
	 */
	public static function is_active() {
		return HOC_Options::is_enabled()
			&& '' !== HOC_Options::get_webhook_secret()
			&& '' === self::unavailable_reason();
	}

	/**
	 * Why the loop cannot run on this server (PHP/extension problem), or an empty string.
	 *
	 * @return string
	 */
	public static function unavailable_reason() {
		if ( null === self::$unavailable ) {
			self::$unavailable = HOC_Site_Loader::unavailable_reason();
		}
		return self::$unavailable;
	}

	/**
	 * Path prefix the module is mounted at, always with a trailing slash ("/hoc/", or "/blog/hoc/" for a
	 * site in a sub-directory). This is the `sitePrefix` embed.js is configured with.
	 *
	 * @return string
	 */
	public static function site_prefix() {
		$path = wp_parse_url( home_url( '/' . self::ROUTE_SLUG . '/' ), PHP_URL_PATH );
		$path = is_string( $path ) && '' !== $path ? $path : '/' . self::ROUTE_SLUG . '/';
		return trailingslashit( $path );
	}

	/**
	 * The URL to register with the platform as this host's webhook.
	 *
	 * @return string
	 */
	public static function webhook_url() {
		return home_url( '/' . self::ROUTE_SLUG . '/webhook' );
	}

	// ------------------------------------------------------------------ the module

	/**
	 * The host module, built on first use.
	 *
	 * @return \HandOfClient\Host\HostModule
	 */
	public static function module() {
		if ( null === self::$module ) {
			HOC_Site_Loader::register();
			require_once HOC_PLUGIN_DIR . 'includes/class-hoc-site-logger.php';

			$logger   = new HOC_Site_Logger();
			$storage  = new \HandOfClient\Host\Storage\SqlStorage( HOC_Site_Loader::pdo_factory() );
			$platform = new \HandOfClient\Host\Platform\PlatformClient(
				HOC_Options::get_platform_base_url(),
				HOC_Options::get_api_key(),
				HOC_Options::get_tenant_id(),
				10.0,
				array( __CLASS__, 'http_transport' ),
				$logger
			);

			// Positional on purpose: named arguments are a parse error on PHP < 8, and this file must load there.
			self::$module = new \HandOfClient\Host\HostModule(
				$storage,
				$platform,
				HOC_Options::get_webhook_secret(),
				array( __CLASS__, 'current_user' ),
				array( __CLASS__, 'is_admin' ),
				array( __CLASS__, 'find_users' ),
				array( __CLASS__, 'user_exists' ),
				null,
				null,
				true,
				true,
				$logger
			);
		}
		return self::$module;
	}

	/**
	 * Platform HTTP through WordPress's own HTTP API, so proxy settings and transport fallbacks apply.
	 *
	 * @param string               $method  HTTP method.
	 * @param string               $url     URL.
	 * @param array<string,string> $headers Request headers.
	 * @param string|null          $body    JSON body.
	 * @param float                $timeout Seconds.
	 * @return array{0:int,1:string} Status and body.
	 * @throws RuntimeException On a transport failure (the module logs it and treats the platform as unreachable).
	 */
	public static function http_transport( $method, $url, array $headers, $body, $timeout ) {
		$args = array(
			'method'      => $method,
			'headers'     => $headers,
			'timeout'     => $timeout,
			'redirection' => 0,
			'user-agent'  => 'HandOfClient-WordPress/' . HOC_VERSION,
		);
		if ( null !== $body ) {
			$args['body'] = $body;
		}
		$response = wp_remote_request( $url, $args );
		if ( is_wp_error( $response ) ) {
			throw new RuntimeException( esc_html( $response->get_error_message() ) );
		}
		return array( (int) wp_remote_retrieve_response_code( $response ), (string) wp_remote_retrieve_body( $response ) );
	}

	// ------------------------------------------------------------------ identity callbacks

	/**
	 * The signed-in WordPress user, or null. The only source of identity: ids in bodies, queries and headers are never trusted.
	 *
	 * @param mixed $request Unused (plain PHP adapter passes null).
	 * @return array{id:string,name:string,email:string}|null
	 */
	public static function current_user( $request = null ) {
		/**
		 * Overrides the signed-in user (tests and SSO bridges). Return false to keep the WordPress session
		 * user; an array with `id`, `name`, optional `email` signs that user in; null signs everyone out.
		 *
		 * @param array|null|false $user    Sentinel false.
		 * @param mixed            $request Request object, if any.
		 */
		$override = apply_filters( 'hoc_site_current_user', false, $request );
		if ( false !== $override ) {
			return $override;
		}
		$user = wp_get_current_user();
		if ( ! $user || ! $user->exists() ) {
			return null;
		}
		return array(
			'id'    => (string) $user->ID,
			'name'  => '' !== $user->display_name ? $user->display_name : $user->user_login,
			'email' => $user->user_email,
		);
	}

	/**
	 * Whether this user may change settings, roll back for everyone and see every request: administrators.
	 *
	 * @param array<string,mixed> $user What current_user() returned.
	 * @return bool
	 */
	public static function is_admin( $user ) {
		/**
		 * Overrides the admin decision. Return null to use the default (the `manage_options` capability).
		 *
		 * @param bool|null           $is_admin Sentinel null.
		 * @param array<string,mixed> $user     The module's user.
		 */
		$override = apply_filters( 'hoc_site_is_admin', null, $user );
		if ( null !== $override ) {
			return (bool) $override;
		}
		return isset( $user['id'] ) && ctype_digit( (string) $user['id'] ) && user_can( (int) $user['id'], 'manage_options' );
	}

	/**
	 * Share-picker search: users whose login, name or email contains the text (id and display name only).
	 *
	 * @param string $query Text typed by the user.
	 * @return array<int,array{id:string,name:string}>
	 */
	public static function find_users( $query ) {
		/**
		 * Overrides the user search. Return null to use the default.
		 *
		 * @param array|null $users Sentinel null.
		 * @param string     $query Search text.
		 */
		$override = apply_filters( 'hoc_site_find_users', null, $query );
		if ( null !== $override ) {
			return $override;
		}
		$query = trim( (string) $query );
		if ( '' === $query ) {
			return array();
		}
		$search = new WP_User_Query(
			array(
				'search'         => '*' . $query . '*',
				'search_columns' => array( 'user_login', 'user_nicename', 'user_email', 'display_name' ),
				'number'         => 50,
				'fields'         => array( 'ID', 'display_name', 'user_login' ),
				'orderby'        => 'display_name',
			)
		);
		$found = array();
		foreach ( (array) $search->get_results() as $row ) {
			$found[] = array(
				'id'   => (string) $row->ID,
				'name' => '' !== $row->display_name ? $row->display_name : $row->user_login,
			);
		}
		return $found;
	}

	/**
	 * @param string $user_id Id as stored in an assignment.
	 * @return bool
	 */
	public static function user_exists( $user_id ) {
		/**
		 * Overrides the existence check. Return null to use the default.
		 *
		 * @param bool|null $exists  Sentinel null.
		 * @param string    $user_id User id.
		 */
		$override = apply_filters( 'hoc_site_user_exists', null, $user_id );
		if ( null !== $override ) {
			return (bool) $override;
		}
		return ctype_digit( (string) $user_id ) && false !== get_userdata( (int) $user_id );
	}

	// ------------------------------------------------------------------ serving /hoc/*

	/**
	 * Answers requests under the prefix and exits; returns at once for everything else.
	 *
	 * @return void
	 */
	public function maybe_serve() {
		if ( ! self::is_active() ) {
			return;
		}
		$prefix = untrailingslashit( self::site_prefix() );
		// phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- compared as a path prefix only.
		$path = (string) strtok( isset( $_SERVER['REQUEST_URI'] ) ? (string) wp_unslash( $_SERVER['REQUEST_URI'] ) : '', '?' );
		if ( $path !== $prefix && 0 !== strpos( $path, $prefix . '/' ) ) {
			return;
		}

		$is_webhook = '/webhook' === substr( $path, strlen( $prefix ) );
		$method     = isset( $_SERVER['REQUEST_METHOD'] ) ? strtoupper( sanitize_key( wp_unslash( $_SERVER['REQUEST_METHOD'] ) ) ) : 'GET';
		if ( ! $is_webhook && ! in_array( $method, array( 'GET', 'HEAD', 'OPTIONS' ), true ) && self::is_cross_site_write() ) {
			// The browser components authenticate with the session cookie, so a write from another site
			// must be refused; the webhook is exempt (its HMAC signature is the credential).
			$this->send_json( 403, array( 'error' => 'forbidden', 'message' => 'Cross-site request refused.' ) );
			return;
		}

		try {
			$module   = self::module();
			$response = \HandOfClient\Host\Adapter\PlainPhp::dispatch( $module, $prefix );
		} catch ( \Throwable $e ) {
			$this->log_failure( 'serving ' . $path, $e );
			$this->send_json( 500, array( 'error' => 'internal', 'message' => 'Internal error.' ) );
			return;
		}
		if ( null === $response ) {
			return;
		}

		status_header( $response->status );
		foreach ( $response->headers() as $name => $value ) {
			header( $name . ': ' . $value );
		}
		// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- JSON produced by the module.
		echo $response->body();
		$this->finish_response();
		try {
			$module->runDeferred();
		} catch ( \Throwable $e ) {
			$this->log_failure( 'deferred work', $e );
		}
		exit;
	}

	/**
	 * True for a state-changing request that a browser sent from a different origin.
	 *
	 * @return bool
	 */
	private static function is_cross_site_write() {
		$origin = isset( $_SERVER['HTTP_ORIGIN'] ) ? trim( (string) wp_unslash( $_SERVER['HTTP_ORIGIN'] ) ) : '';
		if ( '' !== $origin ) {
			$allowed = array();
			foreach ( array( home_url(), site_url() ) as $url ) {
				$allowed[] = self::origin_of( $url );
			}
			/**
			 * Origins that may send writes to the request loop (the site's own home and site URLs are always allowed).
			 *
			 * @param string[] $origins Allowed origins, e.g. "https://www.example.com".
			 */
			$allowed = apply_filters( 'hoc_site_allowed_origins', $allowed );
			return ! in_array( self::origin_of( $origin ), $allowed, true );
		}
		$fetch_site = isset( $_SERVER['HTTP_SEC_FETCH_SITE'] ) ? strtolower( trim( (string) wp_unslash( $_SERVER['HTTP_SEC_FETCH_SITE'] ) ) ) : '';
		return 'cross-site' === $fetch_site;
	}

	/**
	 * @param string $url URL or Origin header value.
	 * @return string scheme://host[:port], lower-cased; "null" for anything unparseable (including the literal origin "null").
	 */
	private static function origin_of( $url ) {
		$parts = wp_parse_url( $url );
		if ( ! is_array( $parts ) || empty( $parts['scheme'] ) || empty( $parts['host'] ) ) {
			return 'null';
		}
		return strtolower( $parts['scheme'] . '://' . $parts['host'] . ( ! empty( $parts['port'] ) ? ':' . $parts['port'] : '' ) );
	}

	/**
	 * @param int                 $status  HTTP status.
	 * @param array<string,mixed> $payload JSON payload.
	 * @return void
	 */
	private function send_json( $status, array $payload ) {
		status_header( $status );
		header( 'Content-Type: application/json; charset=utf-8' );
		header( 'Cache-Control: no-store' );
		echo wp_json_encode( $payload );
		exit;
	}

	/**
	 * Hands the finished response to the browser so deferred work does not delay it, where the SAPI can.
	 *
	 * @return void
	 */
	private function finish_response() {
		if ( function_exists( 'fastcgi_finish_request' ) ) {
			fastcgi_finish_request();
		} elseif ( function_exists( 'litespeed_finish_request' ) ) {
			litespeed_finish_request();
		}
	}

	/**
	 * @param string    $what What was being done.
	 * @param Throwable $e    The failure; every inner exception is included by __toString().
	 * @return void
	 */
	private function log_failure( $what, $e ) {
		// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
		error_log( 'handofclient.error: ' . $what . " failed\n" . $e );
	}

	// ------------------------------------------------------------------ WP-Cron

	/**
	 * @param array<string,array<string,mixed>> $schedules Existing schedules.
	 * @return array<string,array<string,mixed>>
	 */
	public function cron_schedules( $schedules ) {
		$schedules['hoc_five_minutes'] = array(
			'interval' => 300,
			'display'  => __( 'Every five minutes (HandOfClient)', 'handofclient' ),
		);
		return $schedules;
	}

	/**
	 * @return void
	 */
	public function schedule_cron() {
		if ( self::is_active() && ! wp_next_scheduled( self::CRON_HOOK ) ) {
			wp_schedule_event( time() + 60, 'hoc_five_minutes', self::CRON_HOOK );
		}
	}

	/**
	 * Starts builds the platform could not take when they were requested (PHP has no background threads;
	 * the module also retries after later responses).
	 *
	 * @return void
	 */
	public function run_cron() {
		if ( ! self::is_active() ) {
			return;
		}
		try {
			self::module()->retryUnstartedBuilds();
		} catch ( \Throwable $e ) {
			$this->log_failure( 'retrying unstarted builds', $e );
		}
	}

	// ------------------------------------------------------------------ front end

	/**
	 * Front-end pages get the loop only for signed-in users.
	 *
	 * @return bool
	 */
	private function front_end_enabled() {
		/**
		 * Whether this front-end page loads the request loop. Default: the loop is active and the visitor is signed in.
		 *
		 * @param bool $enabled Default decision.
		 */
		return (bool) apply_filters( 'hoc_site_load_front_end', ! is_admin() && self::is_active() && is_user_logged_in() && self::assets_present() );
	}

	/**
	 * @return bool
	 */
	private static function assets_present() {
		return is_readable( HOC_PLUGIN_DIR . 'assets/js/embed.global.js' );
	}

	/**
	 * The few-line snippet that hides the page until autoMount knows what applies (embed.js reveals it).
	 *
	 * @return void
	 */
	public function print_head_snippet() {
		if ( ! $this->front_end_enabled() ) {
			return;
		}
		$file = HOC_PLUGIN_DIR . 'assets/js/hoc-head.min.js';
		if ( ! is_readable( $file ) ) {
			return;
		}
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents, WordPress.Security.EscapeOutput.OutputNotEscaped -- plugin's own static file.
		echo '<script id="hoc-head">' . file_get_contents( $file ) . "</script>\n";
	}

	/**
	 * @return void
	 */
	public function enqueue_front_end() {
		if ( ! $this->front_end_enabled() ) {
			return;
		}
		$this->enqueue_embed( true );
		wp_enqueue_style( 'hoc-dock', HOC_PLUGIN_URL . 'assets/css/hoc-dock.css', array(), HOC_VERSION );
		wp_enqueue_script( 'hoc-dock', HOC_PLUGIN_URL . 'assets/js/hoc-dock.js', array(), HOC_VERSION, true );
	}

	/**
	 * Loads embed.js and configures it for the request loop. Safe to call more than once.
	 *
	 * @param bool $auto_mount Also apply the features that match this page (front end only).
	 * @return void
	 */
	public function enqueue_embed( $auto_mount ) {
		wp_enqueue_script( self::EMBED_HANDLE, HOC_PLUGIN_URL . 'assets/js/embed.global.js', array(), HOC_VERSION, true );
		wp_enqueue_script( 'hoc-refresh', HOC_PLUGIN_URL . 'assets/js/hoc-refresh.js', array(), HOC_VERSION, true );
		if ( self::$embed_configured ) {
			return;
		}
		self::$embed_configured = true;

		$config = array(
			'apiBaseUrl'  => HOC_Options::get_platform_base_url(),
			'embedOrigin' => HOC_Options::get_embed_origin(),
			'sitePrefix'  => self::site_prefix(),
		);
		$js = 'HandOfClient.configure(' . wp_json_encode( $config ) . ');';
		if ( $auto_mount ) {
			// Never throws: if nothing applies, or anything fails, the original page is shown.
			$js .= 'HandOfClient.autoMount({timeoutMs:1500});';
		}
		wp_add_inline_script( self::EMBED_HANDLE, $js, 'after' );
	}

	/**
	 * The request box and "my features" in a collapsible dock, bottom right of every page.
	 *
	 * @return void
	 */
	public function print_dock() {
		if ( ! $this->front_end_enabled() || ! HOC_Options::get( 'show_dock', true ) ) {
			return;
		}
		printf(
			'<div id="hoc-dock" class="hoc-dock"><button type="button" class="hoc-dock__toggle" aria-expanded="false" aria-controls="hoc-dock-panel">%s</button><div id="hoc-dock-panel" class="hoc-dock__panel" hidden><hoc-request-feature></hoc-request-feature><hoc-my-features></hoc-my-features></div></div>',
			esc_html__( 'Request a feature', 'handofclient' )
		);
	}

	/**
	 * @return string
	 */
	public function shortcode_request_feature() {
		return $this->shortcode_element( 'hoc-request-feature' );
	}

	/**
	 * @return string
	 */
	public function shortcode_my_features() {
		return $this->shortcode_element( 'hoc-my-features' );
	}

	/**
	 * @param string $tag Custom element name.
	 * @return string Empty for visitors who are not signed in or when the loop is off.
	 */
	private function shortcode_element( $tag ) {
		if ( is_admin() || ! self::is_active() || ! is_user_logged_in() || ! self::assets_present() ) {
			return '';
		}
		$this->enqueue_embed( true );
		return '<' . $tag . '></' . $tag . '>';
	}

	// ------------------------------------------------------------------ wp-admin

	/**
	 * Prints elements on an admin screen (embed.js is loaded in the footer; no page lookup in wp-admin).
	 *
	 * @param string $tags Custom element tags, already escaped HTML.
	 * @return void
	 */
	public function render_admin_elements( $tags ) {
		if ( ! self::assets_present() ) {
			echo '<p>' . esc_html__( 'The HandOfClient browser script is missing from this installation (assets/js/embed.global.js). Reinstall the plugin from the release zip.', 'handofclient' ) . '</p>';
			return;
		}
		$this->enqueue_embed( false );
		// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- fixed element names from this plugin.
		echo $tags;
	}
}
