<?php
/**
 * Turns platform activations into WordPress surfaces.
 *
 * @package HandOfClient
 */

defined( 'ABSPATH' ) || exit;

/**
 * The declarative capability bridge.
 *
 * A manifest slot says WHAT it is; this site's settings say WHERE it goes. Neither the package nor
 * this plugin generates any PHP - the three slot kinds map onto three fixed implementations here:
 *
 *   SLOT_KIND_PAGE     -> an admin submenu page at admin.php?page=hoc-{slotId}
 *   SLOT_KIND_PANEL    -> the [handofclient] shortcode and the handofclient/panel block
 *   SLOT_KIND_OVERRIDE -> replaces the content of the post/page whose path matches
 *
 * Adding a fourth capability means shipping a new version of this plugin, which is the honest cost of
 * refusing to write PHP onto a customer's site. It buys versioning, rollback, a kill switch, and a
 * blast radius that stops at one slot.
 */
class HOC_Mounts {

	/** Combined activation + manifest cache. */
	const SLOTS_CACHE_KEY = 'hoc_mounted_slots';

	/** Non-fatal problems from the last discovery refresh - surfaced on the Status screen. */
	const DISCOVERY_ISSUES_KEY = 'hoc_discovery_issues';

	/** Collected during render, emitted as inline script data. */
	private $pending_mounts = array();

	/** True once the shared scripts have been enqueued for this request. */
	private $assets_enqueued = false;

	/**
	 * @return void
	 */
	public function register() {
		add_action( 'admin_menu', array( $this, 'register_admin_pages' ), 20 );
		add_action( 'init', array( $this, 'register_shortcode_and_block' ) );
		add_filter( 'the_content', array( $this, 'maybe_override_content' ), 20 );
	}

	/**
	 * Every slot this site should mount.
	 *
	 * One cached read for the whole request. On a cache miss this makes one HTTP call for the
	 * activation list plus one per activation - acceptable because it is cached for minutes and
	 * because HOC_Platform_Client negatively caches failures, so a platform outage costs one attempt
	 * per backoff window rather than one per page view.
	 *
	 * @param bool $force_refresh Bypass the cache.
	 * @return array<int,array<string,mixed>>
	 */
	public static function get_mounted_slots( $force_refresh = false ) {
		if ( ! $force_refresh ) {
			$cached = get_transient( self::SLOTS_CACHE_KEY );
			if ( is_array( $cached ) ) {
				return $cached;
			}
		}

		$client      = new HOC_Platform_Client();
		$activations = $client->list_activations( $force_refresh ? 0 : null );

		if ( is_wp_error( $activations ) || ! isset( $activations['activations'] ) || ! is_array( $activations['activations'] ) ) {
			// Cache the empty result briefly so a broken pairing does not retry on every request.
			set_transient( self::SLOTS_CACHE_KEY, array(), MINUTE_IN_SECONDS );
			set_transient(
				self::DISCOVERY_ISSUES_KEY,
				array(
					is_wp_error( $activations )
						? sprintf( 'ListActivations failed: %s', $activations->get_error_message() )
						: 'ListActivations returned a response with no activations array.',
				),
				MINUTE_IN_SECONDS
			);
			return array();
		}

		$slots  = array();
		$issues = array();

		foreach ( $activations['activations'] as $activation ) {
			if ( ! is_array( $activation ) || empty( $activation['enabled'] ) ) {
				continue;
			}

			$package_id = isset( $activation['scope']['packageId'] ) ? (string) $activation['scope']['packageId'] : '';
			$slot_id    = isset( $activation['slotId'] ) ? (string) $activation['slotId'] : '';
			if ( '' === $package_id || '' === $slot_id ) {
				continue;
			}

			$active = $client->get_active_version( $package_id, $slot_id, $force_refresh ? 0 : null );
			if ( is_wp_error( $active ) ) {
				// phpcs:ignore WordPress.WP.I18n.MissingTranslatorsComment -- log-style string, not user-facing i18n copy.
				$issues[] = sprintf( '%s / %s: GetActiveVersion failed: %s', $package_id, $slot_id, $active->get_error_message() );
				continue;
			}
			if ( empty( $active['enabled'] ) || ! isset( $active['slot'] ) ) {
				// phpcs:ignore WordPress.WP.I18n.MissingTranslatorsComment -- log-style string, not user-facing i18n copy.
				$issues[] = sprintf( '%s / %s: activated here, but has no enabled version on the platform.', $package_id, $slot_id );
				continue;
			}

			$slot     = $active['slot'];
			$manifest = isset( $active['version']['manifest'] ) ? $active['version']['manifest'] : array();

			$slots[] = array(
				'packageId'   => $package_id,
				'slotId'      => $slot_id,
				'version'     => isset( $active['version']['version'] ) ? (string) $active['version']['version'] : '',
				// Proto enum, serialised by name: SLOT_KIND_PAGE / _PANEL / _OVERRIDE.
				'kind'        => isset( $slot['kind'] ) ? (string) $slot['kind'] : 'SLOT_KIND_UNSPECIFIED',
				'title'       => isset( $slot['title'] ) ? (string) $slot['title'] : $slot_id,
				'showInNav'   => ! empty( $slot['showInNav'] ),
				'targetPath'  => isset( $slot['targetPath'] ) ? (string) $slot['targetPath'] : '',
				'matchPath'   => isset( $slot['matchPath'] ) ? (string) $slot['matchPath'] : '',
				'hostPanelId' => isset( $slot['hostPanelId'] ) ? (string) $slot['hostPanelId'] : '',
				'packageName' => isset( $manifest['name'] ) ? (string) $manifest['name'] : $package_id,
				// Carried through for HOC_Hooks. Kept on the slot rather than fetched separately so
				// hook registration costs no extra HTTP call and shares this cache's lifetime.
				'hooks'       => ( isset( $manifest['hooks'] ) && is_array( $manifest['hooks'] ) ) ? $manifest['hooks'] : array(),
			);
		}

		set_transient( self::SLOTS_CACHE_KEY, $slots, (int) HOC_Options::get( 'cache_ttl', 300 ) );
		set_transient( self::DISCOVERY_ISSUES_KEY, $issues, (int) HOC_Options::get( 'cache_ttl', 300 ) );
		return $slots;
	}

	/**
	 * Problems from the last discovery refresh that did not fail the whole request - an activation
	 * with no enabled version, or a per-activation platform error. Empty on a clean run or before the
	 * first refresh. Read by the admin Status screen; nothing else consumes this.
	 *
	 * @return array<int,string>
	 */
	public static function get_discovery_issues() {
		$issues = get_transient( self::DISCOVERY_ISSUES_KEY );
		return is_array( $issues ) ? $issues : array();
	}

	/**
	 * Drops the slot cache. Called after settings changes and from the admin "refresh" action.
	 *
	 * @return void
	 */
	public static function flush_slot_cache() {
		delete_transient( self::SLOTS_CACHE_KEY );
		delete_transient( self::DISCOVERY_ISSUES_KEY );
		HOC_Platform_Client::flush_caches();
	}

	// ---- SLOT_KIND_PAGE ------------------------------------------------------------------------

	/**
	 * @return void
	 */
	public function register_admin_pages() {
		foreach ( self::get_mounted_slots() as $slot ) {
			if ( 'SLOT_KIND_PAGE' !== $slot['kind'] || ! $slot['showInNav'] ) {
				continue;
			}

			$config = HOC_Options::get_slot_config( $slot['slotId'] );
			if ( empty( $config['enabled'] ) ) {
				continue;
			}

			add_submenu_page(
				'hoc-root',
				$slot['title'],
				$slot['title'],
				$config['capability'],
				'hoc-slot-' . sanitize_key( $slot['slotId'] ),
				function () use ( $slot ) {
					// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- render_slot escapes its own output.
					echo $this->render_admin_page( $slot );
				}
			);
		}
	}

	/**
	 * @param array<string,mixed> $slot Slot descriptor.
	 * @return string
	 */
	private function render_admin_page( array $slot ) {
		return '<div class="wrap"><h1>' . esc_html( $slot['title'] ) . '</h1>'
			. $this->render_slot( $slot )
			. '</div>';
	}

	// ---- SLOT_KIND_PANEL -----------------------------------------------------------------------

	/**
	 * One shortcode and one block for every panel slot, not one each.
	 *
	 * N features therefore need no new registrations, no new PHP, and no new plugin release - the
	 * slot id is an attribute. This is the same trick the manifest uses to avoid a package hardcoding
	 * a host's routing.
	 *
	 * @return void
	 */
	public function register_shortcode_and_block() {
		add_shortcode( 'handofclient', array( $this, 'shortcode' ) );

		if ( function_exists( 'register_block_type' ) ) {
			register_block_type(
				'handofclient/panel',
				array(
					'api_version'     => 2,
					'attributes'      => array(
						'slotId' => array( 'type' => 'string', 'default' => '' ),
					),
					// A dynamic block: the front end is rendered by PHP here, so the editor never has
					// to reimplement the mount logic and a slot deactivated on the platform stops
					// rendering immediately rather than leaving stale saved markup in the post.
					'render_callback' => array( $this, 'render_block' ),
					'editor_script'   => 'hoc-block-editor',
				)
			);

			wp_register_script(
				'hoc-block-editor',
				HOC_PLUGIN_URL . 'assets/js/hoc-block.js',
				array( 'wp-blocks', 'wp-element', 'wp-block-editor', 'wp-components' ),
				HOC_VERSION,
				true
			);

			wp_localize_script(
				'hoc-block-editor',
				'HOC_BLOCK_DATA',
				array( 'slots' => $this->panel_slot_choices() )
			);
		}
	}

	/**
	 * @return array<int,array<string,string>>
	 */
	private function panel_slot_choices() {
		$choices = array();
		foreach ( self::get_mounted_slots() as $slot ) {
			if ( 'SLOT_KIND_PANEL' === $slot['kind'] ) {
				$choices[] = array(
					'value' => $slot['slotId'],
					'label' => $slot['title'],
				);
			}
		}
		return $choices;
	}

	/**
	 * @param array<string,mixed> $atts Shortcode attributes.
	 * @return string
	 */
	public function shortcode( $atts ) {
		$atts    = shortcode_atts( array( 'slot' => '' ), $atts, 'handofclient' );
		$slot_id = sanitize_text_field( (string) $atts['slot'] );

		return $this->render_panel_by_slot_id( $slot_id );
	}

	/**
	 * @param array<string,mixed> $attributes Block attributes.
	 * @return string
	 */
	public function render_block( $attributes ) {
		$slot_id = isset( $attributes['slotId'] ) ? sanitize_text_field( (string) $attributes['slotId'] ) : '';
		return $this->render_panel_by_slot_id( $slot_id );
	}

	/**
	 * @param string $slot_id Slot id.
	 * @return string
	 */
	private function render_panel_by_slot_id( $slot_id ) {
		if ( '' === $slot_id ) {
			return '';
		}

		foreach ( self::get_mounted_slots() as $slot ) {
			if ( $slot['slotId'] !== $slot_id || 'SLOT_KIND_PANEL' !== $slot['kind'] ) {
				continue;
			}

			$config = HOC_Options::get_slot_config( $slot_id );
			if ( empty( $config['enabled'] ) || ! current_user_can( $config['capability'] ) ) {
				// Renders nothing rather than an error: a panel the current visitor may not see should
				// be invisible, not an advertisement that something is there.
				return '';
			}

			return $this->render_slot( $slot );
		}

		return '';
	}

	// ---- SLOT_KIND_OVERRIDE --------------------------------------------------------------------

	/**
	 * Replaces the content of the single post/page whose path matches an override slot.
	 *
	 * Only in the main query, only on a singular view, and only for the matched path - an override
	 * that leaked into an archive loop or a widget would silently replace every excerpt on the page.
	 *
	 * @param string $content Post content.
	 * @return string
	 */
	public function maybe_override_content( $content ) {
		if ( is_admin() || ! is_singular() || ! in_the_loop() || ! is_main_query() ) {
			return $content;
		}

		$path = trim( (string) wp_parse_url( home_url( add_query_arg( array() ) ), PHP_URL_PATH ), '/' );

		foreach ( self::get_mounted_slots() as $slot ) {
			if ( 'SLOT_KIND_OVERRIDE' !== $slot['kind'] ) {
				continue;
			}
			if ( trim( $slot['matchPath'], '/' ) !== $path ) {
				continue;
			}

			$config = HOC_Options::get_slot_config( $slot['slotId'] );
			if ( empty( $config['enabled'] ) || ! current_user_can( $config['capability'] ) ) {
				return $content;
			}

			return $this->render_slot( $slot );
		}

		return $content;
	}

	// ---- shared rendering ----------------------------------------------------------------------

	/**
	 * Emits the mount container and queues its configuration.
	 *
	 * @param array<string,mixed> $slot Slot descriptor.
	 * @return string
	 */
	private function render_slot( array $slot ) {
		return HOC_Safe_Mode::guard(
			$slot['packageId'] . '/' . $slot['slotId'],
			function () use ( $slot ) {
				$this->enqueue_assets();

				$dom_id = 'hoc-slot-' . wp_generate_uuid4();

				$this->pending_mounts[] = array(
					'domId'      => $dom_id,
					'hostId'     => HOC_Options::get_host_id(),
					'tenantId'   => HOC_Options::get_tenant_id(),
					'packageId'  => $slot['packageId'],
					'slotId'     => $slot['slotId'],
					'apiBaseUrl' => HOC_Options::get_platform_base_url(),
					'embedOrigin' => HOC_Options::get_embed_origin(),
					// The nonce travels in the query string, not a header: embed.js fetches this URL
					// with a bare fetch() and cannot add headers. WordPress accepts _wpnonce as a
					// request parameter for exactly this kind of case.
					'tokenUrl'   => add_query_arg(
						array(
							'packageId' => rawurlencode( $slot['packageId'] ),
							'slotId'    => rawurlencode( $slot['slotId'] ),
							'_wpnonce'  => wp_create_nonce( 'wp_rest' ),
						),
						rest_url( HOC_REST_NAMESPACE . '/embed-token' )
					),
					'theme'      => $this->theme_tokens(),
					'locale'     => str_replace( '_', '-', get_user_locale() ),
					// How a plugin learns where this site's data API lives. It cannot derive this -
					// the bundle runs on the platform's embed origin and has no idea which WordPress
					// site framed it. Handing it over at mount time is the same launchParams route the
					// design already uses for host-supplied context.
					'launchParams' => array(
						'siteUrl'  => home_url(),
						'restBase' => rest_url( HOC_REST_NAMESPACE ),
						'siteName' => get_bloginfo( 'name' ),
					),
				);

				wp_add_inline_script(
					'hoc-mount',
					'window.HOC_MOUNTS = window.HOC_MOUNTS || []; window.HOC_MOUNTS.push('
						. wp_json_encode( $this->pending_mounts[ count( $this->pending_mounts ) - 1 ] ) . ');',
					'before'
				);

				return sprintf(
					'<div class="hoc-slot" id="%s" data-hoc-slot="%s"></div>',
					esc_attr( $dom_id ),
					esc_attr( $slot['slotId'] )
				);
			}
		);
	}

	/**
	 * @return void
	 */
	private function enqueue_assets() {
		if ( $this->assets_enqueued ) {
			return;
		}
		$this->assets_enqueued = true;

		// Shipped inside this plugin, not fetched from the platform at runtime. Loading executable
		// code from a remote server is both a wordpress.org guideline violation and an availability
		// risk - a platform outage would otherwise break the page rather than just the panel.
		wp_enqueue_script(
			'hoc-embed',
			HOC_PLUGIN_URL . 'assets/js/embed.global.js',
			array(),
			HOC_VERSION,
			true
		);

		wp_enqueue_script(
			'hoc-mount',
			HOC_PLUGIN_URL . 'assets/js/hoc-mount.js',
			array( 'hoc-embed' ),
			HOC_VERSION,
			true
		);
	}

	/**
	 * The fixed ThemeTokens set from the postMessage protocol, filterable so a theme can match its
	 * own palette without this plugin growing a settings screen for colours.
	 *
	 * @return array<string,string>
	 */
	private function theme_tokens() {
		/**
		 * Filters the theme tokens handed to every mounted plugin.
		 *
		 * @param array<string,string> $tokens Theme tokens.
		 */
		return apply_filters(
			'hoc_theme_tokens',
			array(
				'colorScheme'     => 'light',
				'accentColor'     => '#2271b1',
				'backgroundColor' => '#ffffff',
				'textColor'       => '#1d2327',
				'fontFamily'      => '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
				'borderRadius'    => '4px',
			)
		);
	}
}
