<?php
/**
 * Admin screens.
 *
 * @package HandOfClient
 */

defined( 'ABSPATH' ) || exit;

/**
 * The site owner's whole view of HandOfClient: pairing, what is mounted and where, which third-party
 * hosts plugins may call, and which credentials they may use without ever seeing.
 *
 * Registered unconditionally, even when the adapter is disabled or the breaker has tripped - see
 * hoc_bootstrap(). A settings screen that disappears when something goes wrong is a settings screen
 * you cannot use to fix it.
 */
class HOC_Admin {

	const CAPABILITY = 'manage_options';

	/**
	 * @return void
	 */
	public function register() {
		add_action( 'admin_menu', array( $this, 'register_menu' ), 10 );
		add_action( 'admin_init', array( $this, 'handle_actions' ) );
	}

	/**
	 * @return void
	 */
	public function register_menu() {
		add_menu_page(
			__( 'HandOfClient', 'handofclient' ),
			__( 'HandOfClient', 'handofclient' ),
			self::CAPABILITY,
			'hoc-root',
			array( $this, 'render_page' ),
			'dashicons-screenoptions',
			76
		);

		// Without this, WordPress labels the first submenu entry with the parent's name.
		add_submenu_page(
			'hoc-root',
			__( 'Settings', 'handofclient' ),
			__( 'Settings', 'handofclient' ),
			self::CAPABILITY,
			'hoc-root',
			array( $this, 'render_page' )
		);
	}

	/**
	 * Processes form posts and one-click actions.
	 *
	 * @return void
	 */
	public function handle_actions() {
		if ( ! current_user_can( self::CAPABILITY ) ) {
			return;
		}

		$action = isset( $_REQUEST['hoc_action'] ) ? sanitize_key( wp_unslash( $_REQUEST['hoc_action'] ) ) : '';
		if ( '' === $action ) {
			return;
		}

		switch ( $action ) {
			case 'save_settings':
				check_admin_referer( 'hoc_save_settings' );
				$this->save_settings();
				break;

			case 'save_slots':
				check_admin_referer( 'hoc_save_slots' );
				$this->save_slots();
				break;

			case 'clear_safe_mode':
				check_admin_referer( 'hoc_clear_safe_mode' );
				HOC_Safe_Mode::reset();
				$this->redirect_with_notice( 'safe_mode_cleared' );
				break;

			case 'refresh':
				check_admin_referer( 'hoc_refresh' );
				HOC_Mounts::flush_slot_cache();
				$this->redirect_with_notice( 'refreshed' );
				break;

			case 'save_egress':
				check_admin_referer( 'hoc_save_egress' );
				$this->save_egress();
				break;

			case 'save_secret':
				check_admin_referer( 'hoc_save_secret' );
				$this->save_secret();
				break;

			case 'delete_secret':
				check_admin_referer( 'hoc_delete_secret' );
				$this->delete_secret();
				break;
		}
	}

	/**
	 * @return void
	 */
	private function save_settings() {
		$values = array(
			'platform_base_url' => isset( $_POST['platform_base_url'] ) ? esc_url_raw( wp_unslash( $_POST['platform_base_url'] ) ) : '',
			'embed_origin'      => isset( $_POST['embed_origin'] ) ? esc_url_raw( wp_unslash( $_POST['embed_origin'] ) ) : '',
			'host_id'           => isset( $_POST['host_id'] ) ? sanitize_text_field( wp_unslash( $_POST['host_id'] ) ) : '',
			'tenant_id'         => isset( $_POST['tenant_id'] ) ? sanitize_text_field( wp_unslash( $_POST['tenant_id'] ) ) : '',
			'enabled'           => ! empty( $_POST['enabled'] ),
			'cache_ttl'         => isset( $_POST['cache_ttl'] ) ? max( 30, min( 3600, (int) $_POST['cache_ttl'] ) ) : 300,
		);

		// An empty API key field means "leave it alone", so re-saving the page does not wipe a key the
		// form never displays. Clearing it is a separate, explicit checkbox.
		if ( isset( $_POST['api_key'] ) && '' !== trim( (string) wp_unslash( $_POST['api_key'] ) ) ) {
			$values['api_key'] = sanitize_text_field( wp_unslash( $_POST['api_key'] ) );
		}
		if ( ! empty( $_POST['clear_api_key'] ) ) {
			$values['api_key'] = '';
		}

		HOC_Options::update( $values );
		HOC_Mounts::flush_slot_cache();

		$this->redirect_with_notice( 'saved' );
	}

	/**
	 * @return void
	 */
	private function save_slots() {
		$submitted = isset( $_POST['slot'] ) && is_array( $_POST['slot'] ) ? wp_unslash( $_POST['slot'] ) : array();

		foreach ( $submitted as $slot_id => $config ) {
			if ( ! is_array( $config ) ) {
				continue;
			}
			$slot_id = sanitize_text_field( (string) $slot_id );

			$capability = isset( $config['capability'] ) ? sanitize_key( (string) $config['capability'] ) : 'read';
			// Only capabilities this site actually knows about; a typo would otherwise silently make
			// a slot invisible to everyone, which looks exactly like the plugin being broken.
			if ( ! in_array( $capability, self::capability_choices(), true ) ) {
				$capability = 'read';
			}

			HOC_Options::set_slot_config(
				$slot_id,
				array(
					'capability'  => $capability,
					'menu_parent' => 'hoc-root',
					'shortcode'   => isset( $config['shortcode'] ) ? sanitize_key( (string) $config['shortcode'] ) : '',
					'enabled'     => ! empty( $config['enabled'] ),
				)
			);
		}

		HOC_Mounts::flush_slot_cache();
		$this->redirect_with_notice( 'slots_saved' );
	}

	/**
	 * @return void
	 */
	private function save_egress() {
		$raw   = isset( $_POST['egress_hosts'] ) ? (string) wp_unslash( $_POST['egress_hosts'] ) : '';
		$hosts = array_filter( array_map( 'trim', preg_split( '/[\r\n,]+/', $raw ) ) );

		if ( ! empty( $_POST['allow_own_site'] ) ) {
			// The one-click case that makes the data API usable at all: a plugin calling this site's
			// own /wp-json/hoc/v1 goes through EgressProxy like any other outbound call, so this
			// site's own host name has to be on its own allowlist.
			$own = wp_parse_url( home_url(), PHP_URL_HOST );
			if ( is_string( $own ) && '' !== $own ) {
				$hosts[] = $own;
			}
		}

		$client = new HOC_Platform_Client();
		$result = $client->put(
			'/egress-allowlist',
			array(
				'tenantId'     => HOC_Options::get_tenant_id(),
				'allowedHosts' => array_values( array_unique( $hosts ) ),
			)
		);

		$this->redirect_with_notice( is_wp_error( $result ) ? 'egress_failed' : 'egress_saved', $result );
	}

	/**
	 * @return void
	 */
	private function save_secret() {
		$name  = isset( $_POST['secret_name'] ) ? sanitize_key( wp_unslash( $_POST['secret_name'] ) ) : '';
		$value = isset( $_POST['secret_value'] ) ? (string) wp_unslash( $_POST['secret_value'] ) : '';

		if ( '' === $name || '' === $value ) {
			$this->redirect_with_notice( 'secret_incomplete' );
			return;
		}

		$client = new HOC_Platform_Client();
		$result = $client->put(
			'/secrets',
			array(
				'tenantId'  => HOC_Options::get_tenant_id(),
				'name'      => $name,
				'value'     => $value,
				'updatedBy' => wp_get_current_user()->user_login,
			)
		);

		$this->redirect_with_notice( is_wp_error( $result ) ? 'secret_failed' : 'secret_saved', $result );
	}

	/**
	 * @return void
	 */
	private function delete_secret() {
		$name = isset( $_REQUEST['secret_name'] ) ? sanitize_key( wp_unslash( $_REQUEST['secret_name'] ) ) : '';
		if ( '' === $name ) {
			$this->redirect_with_notice( 'secret_incomplete' );
			return;
		}

		$client = new HOC_Platform_Client();
		$result = $client->delete(
			'/secrets',
			array(
				'tenantId' => HOC_Options::get_tenant_id(),
				'name'     => $name,
			)
		);

		$this->redirect_with_notice( is_wp_error( $result ) ? 'secret_failed' : 'secret_deleted', $result );
	}

	/**
	 * @param string        $notice Notice slug.
	 * @param WP_Error|null $error  Optional error to surface.
	 * @return void
	 */
	private function redirect_with_notice( $notice, $error = null ) {
		$args = array(
			'page'       => 'hoc-root',
			'hoc_notice' => $notice,
		);
		if ( is_wp_error( $error ) ) {
			$args['hoc_error'] = rawurlencode( $error->get_error_message() );
		}
		wp_safe_redirect( add_query_arg( $args, admin_url( 'admin.php' ) ) );
		exit;
	}

	/**
	 * @return array<int,string>
	 */
	private static function capability_choices() {
		return array( 'read', 'edit_posts', 'publish_posts', 'edit_others_posts', 'moderate_comments', 'manage_options' );
	}

	/**
	 * @return void
	 */
	public function render_page() {
		if ( ! current_user_can( self::CAPABILITY ) ) {
			wp_die( esc_html__( 'You do not have permission to view this page.', 'handofclient' ) );
		}

		$settings = HOC_Options::get_all();

		echo '<div class="wrap"><h1>' . esc_html__( 'HandOfClient', 'handofclient' ) . '</h1>';

		$this->render_notice();
		$this->render_status();
		$this->render_settings_form( $settings );

		if ( HOC_Options::is_paired() ) {
			$this->render_slots_form();
			$this->render_egress_form();
			$this->render_secrets_form();
		}

		echo '</div>';
	}

	/**
	 * @return void
	 */
	private function render_notice() {
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- read-only display of a redirect result.
		$notice = isset( $_GET['hoc_notice'] ) ? sanitize_key( wp_unslash( $_GET['hoc_notice'] ) ) : '';
		if ( '' === $notice ) {
			return;
		}

		$messages = array(
			'saved'             => array( 'success', __( 'Settings saved.', 'handofclient' ) ),
			'slots_saved'       => array( 'success', __( 'Slot placement saved.', 'handofclient' ) ),
			'refreshed'         => array( 'success', __( 'Refreshed from the platform.', 'handofclient' ) ),
			'safe_mode_cleared' => array( 'success', __( 'Safe mode cleared.', 'handofclient' ) ),
			'egress_saved'      => array( 'success', __( 'Outbound allowlist saved.', 'handofclient' ) ),
			'egress_failed'     => array( 'error', __( 'Could not save the outbound allowlist.', 'handofclient' ) ),
			'secret_saved'      => array( 'success', __( 'Credential saved on the platform.', 'handofclient' ) ),
			'secret_deleted'    => array( 'success', __( 'Credential deleted.', 'handofclient' ) ),
			'secret_failed'     => array( 'error', __( 'Could not save the credential.', 'handofclient' ) ),
			'secret_incomplete' => array( 'error', __( 'A credential needs both a name and a value.', 'handofclient' ) ),
		);

		if ( ! isset( $messages[ $notice ] ) ) {
			return;
		}

		// phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$detail = isset( $_GET['hoc_error'] ) ? sanitize_text_field( wp_unslash( $_GET['hoc_error'] ) ) : '';

		printf(
			'<div class="notice notice-%s is-dismissible"><p>%s%s</p></div>',
			esc_attr( $messages[ $notice ][0] ),
			esc_html( $messages[ $notice ][1] ),
			'' !== $detail ? ' <code>' . esc_html( $detail ) . '</code>' : ''
		);
	}

	/**
	 * Live pairing check. This is the screen's most useful element - it answers "is this thing
	 * actually working" with a real round trip rather than by echoing back what was typed in.
	 *
	 * @return void
	 */
	private function render_status() {
		echo '<h2>' . esc_html__( 'Status', 'handofclient' ) . '</h2>';

		if ( ! HOC_Options::is_paired() ) {
			echo '<p>' . esc_html__( 'Not paired yet. Fill in the platform URL, host id and API key below.', 'handofclient' ) . '</p>';
			return;
		}

		$client = new HOC_Platform_Client();
		$who    = $client->whoami();

		echo '<table class="widefat striped" style="max-width:820px"><tbody>';

		if ( is_wp_error( $who ) ) {
			$hint = ( 'hoc_platform_unauthorized' === $who->get_error_code() )
				? __( 'The platform rejected this API key. Check that it belongs to this host id.', 'handofclient' )
				: __( 'The platform could not be reached from this server. Check the URL and any outbound firewall.', 'handofclient' );

			printf(
				'<tr><th style="width:220px">%s</th><td><span style="color:#d63638">%s</span><br><em>%s</em><br><code>%s</code></td></tr>',
				esc_html__( 'Connection', 'handofclient' ),
				esc_html__( 'Failed', 'handofclient' ),
				esc_html( $hint ),
				esc_html( $who->get_error_message() )
			);
		} else {
			$host    = isset( $who['host'] ) ? $who['host'] : array();
			$origins = isset( $host['registeredOrigins'] ) && is_array( $host['registeredOrigins'] ) ? $host['registeredOrigins'] : array();
			$site    = home_url();

			printf(
				'<tr><th style="width:220px">%s</th><td><span style="color:#00a32a">%s</span> %s</td></tr>',
				esc_html__( 'Connection', 'handofclient' ),
				esc_html__( 'OK', 'handofclient' ),
				esc_html( isset( $host['displayName'] ) ? '- ' . $host['displayName'] : '' )
			);

			// A near-universal first-run failure: the site's own origin has to be registered on the
			// platform or the browser refuses to frame the plugin (frame-ancestors), and the symptom
			// is a blank box with a console error most people will not think to open.
			$origin_ok = false;
			foreach ( $origins as $origin ) {
				if ( untrailingslashit( (string) $origin ) === untrailingslashit( $site ) ) {
					$origin_ok = true;
					break;
				}
			}

			printf(
				'<tr><th>%s</th><td>%s</td></tr>',
				esc_html__( 'This site is a registered origin', 'handofclient' ),
				$origin_ok
					? '<span style="color:#00a32a">' . esc_html__( 'Yes', 'handofclient' ) . '</span>'
					: '<span style="color:#d63638">' . esc_html__( 'No', 'handofclient' ) . '</span> - '
						. esc_html__( 'plugins will not render until this site\'s URL is added to the host\'s registered origins on the platform.', 'handofclient' )
			);
		}

		printf(
			'<tr><th>%s</th><td><code>%s</code></td></tr>',
			esc_html__( 'Tenant id', 'handofclient' ),
			esc_html( HOC_Options::get_tenant_id() )
		);

		printf(
			'<tr><th>%s</th><td>%s</td></tr>',
			esc_html__( 'API key source', 'handofclient' ),
			HOC_Options::api_key_is_from_constant()
				? esc_html__( 'wp-config.php constant HOC_API_KEY (recommended)', 'handofclient' )
				: esc_html__( 'Database. Define HOC_API_KEY in wp-config.php to keep it out of database dumps.', 'handofclient' )
		);

		// Pairing can be entirely healthy (Connection: OK above) while discovery - "what is actually
		// activated for this host/tenant" - still fails or finds nothing, which used to be
		// indistinguishable from "no packages activated yet". Surface it here rather than nowhere.
		$mounted_slots    = HOC_Mounts::get_mounted_slots();
		$discovery_issues = HOC_Mounts::get_discovery_issues();

		if ( count( $mounted_slots ) > 0 ) {
			printf(
				'<tr><th>%s</th><td><span style="color:#00a32a">%s</span></td></tr>',
				esc_html__( 'Mounted plugins', 'handofclient' ),
				esc_html( implode( ', ', wp_list_pluck( $mounted_slots, 'title' ) ) )
			);
		} elseif ( ! empty( $discovery_issues ) ) {
			printf(
				'<tr><th>%s</th><td><span style="color:#d63638">%s</span><br>%s</td></tr>',
				esc_html__( 'Mounted plugins', 'handofclient' ),
				esc_html__( 'None - the last check found a problem:', 'handofclient' ),
				implode( '<br>', array_map( 'esc_html', $discovery_issues ) )
			);
		} else {
			printf(
				'<tr><th>%s</th><td>%s</td></tr>',
				esc_html__( 'Mounted plugins', 'handofclient' ),
				esc_html__( 'None. Nothing is activated for this host/tenant on the platform yet - or discovery has not run yet, try Refresh from platform below.', 'handofclient' )
			);
		}

		echo '</tbody></table>';

		printf(
			'<p><a class="button" href="%s">%s</a></p>',
			esc_url( wp_nonce_url( admin_url( 'admin.php?page=hoc-root&hoc_action=refresh' ), 'hoc_refresh' ) ),
			esc_html__( 'Refresh from platform', 'handofclient' )
		);
	}

	/**
	 * @param array<string,mixed> $settings Current settings.
	 * @return void
	 */
	private function render_settings_form( array $settings ) {
		echo '<h2>' . esc_html__( 'Connection', 'handofclient' ) . '</h2>';
		echo '<form method="post" action="' . esc_url( admin_url( 'admin.php?page=hoc-root' ) ) . '">';
		wp_nonce_field( 'hoc_save_settings' );
		echo '<input type="hidden" name="hoc_action" value="save_settings" />';
		echo '<table class="form-table" role="presentation"><tbody>';

		$this->text_row( 'platform_base_url', __( 'Platform API URL', 'handofclient' ), $settings['platform_base_url'], 'https://api.handofclient.com', __( 'Must be reachable from BOTH this server and your visitors\' browsers - the browser loads the plugin bundle directly from it.', 'handofclient' ) );
		$this->text_row( 'embed_origin', __( 'Embed origin', 'handofclient' ), $settings['embed_origin'], __( '(defaults to the platform URL\'s origin)', 'handofclient' ), '' );
		$this->text_row( 'host_id', __( 'Host id', 'handofclient' ), $settings['host_id'], __( 'e.g. acme-corp', 'handofclient' ), __( 'The host id the platform issued you when this site was registered.', 'handofclient' ) );
		$this->text_row( 'tenant_id', __( 'Tenant id', 'handofclient' ), $settings['tenant_id'], HOC_Options::default_tenant_id(), __( 'Identifies this site to the platform. Change it only if you know why.', 'handofclient' ) );

		printf(
			'<tr><th scope="row"><label for="api_key">%s</label></th><td>
				<input type="password" id="api_key" name="api_key" value="" class="regular-text" autocomplete="new-password" placeholder="%s" />
				<p class="description">%s</p>
				<label><input type="checkbox" name="clear_api_key" value="1" /> %s</label>
			</td></tr>',
			esc_html__( 'API key', 'handofclient' ),
			'' !== HOC_Options::get_api_key() ? esc_attr__( '(unchanged)', 'handofclient' ) : '',
			esc_html__( 'Leave blank to keep the current key. Never displayed back.', 'handofclient' ),
			esc_html__( 'Clear the stored key', 'handofclient' )
		);

		printf(
			'<tr><th scope="row">%s</th><td><label><input type="checkbox" name="enabled" value="1" %s /> %s</label><p class="description">%s</p></td></tr>',
			esc_html__( 'Enabled', 'handofclient' ),
			checked( ! empty( $settings['enabled'] ), true, false ),
			esc_html__( 'Mount HandOfClient plugins on this site', 'handofclient' ),
			esc_html__( 'Unchecking this is the kill switch: no hooks are registered at all, and nothing is mounted.', 'handofclient' )
		);

		printf(
			'<tr><th scope="row"><label for="cache_ttl">%s</label></th><td><input type="number" id="cache_ttl" name="cache_ttl" value="%d" min="30" max="3600" class="small-text" /> %s</td></tr>',
			esc_html__( 'Cache lifetime', 'handofclient' ),
			(int) $settings['cache_ttl'],
			esc_html__( 'seconds', 'handofclient' )
		);

		echo '</tbody></table>';
		submit_button( __( 'Save settings', 'handofclient' ) );
		echo '</form>';
	}

	/**
	 * @param string $name        Field name.
	 * @param string $label       Field label.
	 * @param string $value       Current value.
	 * @param string $placeholder Placeholder.
	 * @param string $description Help text.
	 * @return void
	 */
	private function text_row( $name, $label, $value, $placeholder = '', $description = '' ) {
		printf(
			'<tr><th scope="row"><label for="%1$s">%2$s</label></th><td><input type="text" id="%1$s" name="%1$s" value="%3$s" class="regular-text" placeholder="%4$s" />%5$s</td></tr>',
			esc_attr( $name ),
			esc_html( $label ),
			esc_attr( (string) $value ),
			esc_attr( $placeholder ),
			'' !== $description ? '<p class="description">' . esc_html( $description ) . '</p>' : ''
		);
	}

	/**
	 * @return void
	 */
	private function render_slots_form() {
		$slots = HOC_Mounts::get_mounted_slots();

		echo '<h2>' . esc_html__( 'Mounted plugins', 'handofclient' ) . '</h2>';

		if ( empty( $slots ) ) {
			echo '<p>' . esc_html__( 'Nothing is activated for this tenant yet. Activate a package on the platform, then use "Refresh from platform" above.', 'handofclient' ) . '</p>';
			return;
		}

		echo '<form method="post" action="' . esc_url( admin_url( 'admin.php?page=hoc-root' ) ) . '">';
		wp_nonce_field( 'hoc_save_slots' );
		echo '<input type="hidden" name="hoc_action" value="save_slots" />';
		echo '<table class="widefat striped"><thead><tr>';
		printf( '<th>%s</th>', esc_html__( 'Plugin', 'handofclient' ) );
		printf( '<th>%s</th>', esc_html__( 'Kind', 'handofclient' ) );
		printf( '<th>%s</th>', esc_html__( 'Where it appears', 'handofclient' ) );
		printf( '<th>%s</th>', esc_html__( 'Who can see it', 'handofclient' ) );
		printf( '<th>%s</th>', esc_html__( 'On', 'handofclient' ) );
		echo '</tr></thead><tbody>';

		foreach ( $slots as $slot ) {
			$config  = HOC_Options::get_slot_config( $slot['slotId'] );
			$slot_id = $slot['slotId'];

			echo '<tr>';
			printf(
				'<td><strong>%s</strong><br><code>%s</code><br><small>%s %s</small></td>',
				esc_html( $slot['title'] ),
				esc_html( $slot['packageId'] ),
				esc_html__( 'version', 'handofclient' ),
				esc_html( $slot['version'] )
			);

			printf( '<td><code>%s</code></td>', esc_html( str_replace( 'SLOT_KIND_', '', $slot['kind'] ) ) );

			echo '<td>';
			switch ( $slot['kind'] ) {
				case 'SLOT_KIND_PAGE':
					printf(
						'%s <code>%s</code>',
						esc_html__( 'Admin menu:', 'handofclient' ),
						esc_html( 'HandOfClient > ' . $slot['title'] )
					);
					break;
				case 'SLOT_KIND_PANEL':
					printf(
						'%s<br><code>[handofclient slot="%s"]</code><br><small>%s</small>',
						esc_html__( 'Shortcode or the "HandOfClient panel" block:', 'handofclient' ),
						esc_attr( $slot_id ),
						esc_html__( 'Paste the shortcode into any post, page or widget.', 'handofclient' )
					);
					break;
				case 'SLOT_KIND_OVERRIDE':
					printf(
						'%s <code>/%s</code>',
						esc_html__( 'Replaces the content at', 'handofclient' ),
						esc_html( trim( $slot['matchPath'], '/' ) )
					);
					break;
				default:
					echo esc_html__( 'Unknown slot kind - this plugin may need updating.', 'handofclient' );
			}
			echo '</td>';

			echo '<td><select name="slot[' . esc_attr( $slot_id ) . '][capability]">';
			foreach ( self::capability_choices() as $capability ) {
				printf(
					'<option value="%s" %s>%s</option>',
					esc_attr( $capability ),
					selected( $config['capability'], $capability, false ),
					esc_html( $capability )
				);
			}
			echo '</select></td>';

			printf(
				'<td><input type="checkbox" name="slot[%s][enabled]" value="1" %s /></td>',
				esc_attr( $slot_id ),
				checked( ! empty( $config['enabled'] ), true, false )
			);

			echo '</tr>';
		}

		echo '</tbody></table>';
		submit_button( __( 'Save placement', 'handofclient' ) );
		echo '</form>';
	}

	/**
	 * @return void
	 */
	private function render_egress_form() {
		$client = new HOC_Platform_Client();
		$list   = $client->get( '/egress-allowlist', array( 'tenantId' => HOC_Options::get_tenant_id() ), 0 );
		$hosts  = ( ! is_wp_error( $list ) && isset( $list['allowedHosts'] ) && is_array( $list['allowedHosts'] ) ) ? $list['allowedHosts'] : array();

		echo '<h2>' . esc_html__( 'Outbound allowlist', 'handofclient' ) . '</h2>';
		echo '<p>' . esc_html__( 'Host names plugins on this site may call. A plugin can only reach a host that is BOTH declared in its own manifest and listed here - declaring it is a request, this list is the grant.', 'handofclient' ) . '</p>';

		echo '<form method="post" action="' . esc_url( admin_url( 'admin.php?page=hoc-root' ) ) . '">';
		wp_nonce_field( 'hoc_save_egress' );
		echo '<input type="hidden" name="hoc_action" value="save_egress" />';

		printf(
			'<p><textarea name="egress_hosts" rows="5" class="large-text code" placeholder="api.example.com">%s</textarea></p>',
			esc_textarea( implode( "\n", $hosts ) )
		);

		printf(
			'<p><label><input type="checkbox" name="allow_own_site" value="1" /> %s <code>%s</code></label><br><span class="description">%s</span></p>',
			esc_html__( 'Also allow this site itself:', 'handofclient' ),
			esc_html( (string) wp_parse_url( home_url(), PHP_URL_HOST ) ),
			esc_html__( 'Required if you want plugins to read this site\'s own content through the data API. Their requests reach it via the platform, so this site counts as an outbound destination.', 'handofclient' )
		);

		submit_button( __( 'Save allowlist', 'handofclient' ), 'secondary' );
		echo '</form>';
	}

	/**
	 * @return void
	 */
	private function render_secrets_form() {
		$client  = new HOC_Platform_Client();
		$listing = $client->get( '/secrets', array( 'tenantId' => HOC_Options::get_tenant_id() ), 0 );
		$secrets = ( ! is_wp_error( $listing ) && isset( $listing['secrets'] ) && is_array( $listing['secrets'] ) ) ? $listing['secrets'] : array();

		echo '<h2>' . esc_html__( 'Credentials for plugins', 'handofclient' ) . '</h2>';
		echo '<p>' . wp_kses(
			__( 'API keys a plugin may <strong>use</strong> but never <strong>see</strong>. A plugin writes <code>{{secret:name}}</code> in a request header; the platform substitutes the real value server-side, so the credential never reaches the browser. Values are stored on the platform, not in this site\'s database, and are never displayed again after saving.', 'handofclient' ),
			array( 'strong' => array(), 'code' => array() )
		) . '</p>';

		if ( ! empty( $secrets ) ) {
			echo '<table class="widefat striped" style="max-width:820px"><thead><tr>';
			printf( '<th>%s</th><th>%s</th><th>%s</th><th></th>', esc_html__( 'Name', 'handofclient' ), esc_html__( 'Updated', 'handofclient' ), esc_html__( 'By', 'handofclient' ) );
			echo '</tr></thead><tbody>';

			foreach ( $secrets as $secret ) {
				$name = isset( $secret['name'] ) ? (string) $secret['name'] : '';
				printf(
					'<tr><td><code>{{secret:%s}}</code></td><td>%s</td><td>%s</td><td><a class="button-link-delete" href="%s" onclick="return confirm(\'%s\')">%s</a></td></tr>',
					esc_html( $name ),
					esc_html( isset( $secret['updatedAt'] ) ? (string) $secret['updatedAt'] : '' ),
					esc_html( isset( $secret['updatedBy'] ) ? (string) $secret['updatedBy'] : '' ),
					esc_url(
						wp_nonce_url(
							add_query_arg(
								array( 'page' => 'hoc-root', 'hoc_action' => 'delete_secret', 'secret_name' => $name ),
								admin_url( 'admin.php' )
							),
							'hoc_delete_secret'
						)
					),
					esc_js( __( 'Delete this credential? Any plugin using it will start failing.', 'handofclient' ) ),
					esc_html__( 'Delete', 'handofclient' )
				);
			}
			echo '</tbody></table>';
		}

		echo '<form method="post" action="' . esc_url( admin_url( 'admin.php?page=hoc-root' ) ) . '">';
		wp_nonce_field( 'hoc_save_secret' );
		echo '<input type="hidden" name="hoc_action" value="save_secret" />';
		echo '<table class="form-table" role="presentation"><tbody>';
		printf(
			'<tr><th scope="row"><label for="secret_name">%s</label></th><td><input type="text" id="secret_name" name="secret_name" class="regular-text" placeholder="stripe" /><p class="description">%s</p></td></tr>',
			esc_html__( 'Name', 'handofclient' ),
			esc_html__( 'Lowercase letters, numbers, hyphens and underscores.', 'handofclient' )
		);
		printf(
			'<tr><th scope="row"><label for="secret_value">%s</label></th><td><input type="password" id="secret_value" name="secret_value" class="regular-text" autocomplete="new-password" /></td></tr>',
			esc_html__( 'Value', 'handofclient' )
		);
		echo '</tbody></table>';
		submit_button( __( 'Save credential', 'handofclient' ), 'secondary' );
		echo '</form>';
	}
}
