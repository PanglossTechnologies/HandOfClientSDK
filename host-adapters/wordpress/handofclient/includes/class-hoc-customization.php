<?php
/**
 * wp-admin screens for the customization loop: "Request a Feature" and "Feature admin".
 *
 * @package HandOfClient
 */

defined( 'ABSPATH' ) || exit;

/**
 * The wp-admin face of HOC_Site. Both pages are thin: the work is done by the embed.js browser
 * components, which talk only to this site's own `/hoc/api/*` (served by the bundled host module), so
 * an administrator gets exactly the same request box, "my features" list and admin tools that other
 * signed-in users get on the front end.
 *
 *  - "Request a Feature": `<hoc-request-feature>` + `<hoc-my-features>` for the signed-in administrator.
 *    This replaces the earlier admin-only form that posted to the platform's /customization-request.
 *  - "Feature admin": `<hoc-feature-admin>` - settings (who may share, rendering mode), every request and
 *    feature, rolling back for everyone, and data sources. The module answers 403 to non-admins.
 *
 * Registered only when the adapter is enabled and paired (alongside HOC_REST/HOC_Mounts/HOC_Hooks in
 * hoc_bootstrap(), NOT alongside HOC_Admin which is unconditional).
 */
class HOC_Customization {

	/** Same capability as the HandOfClient menu itself. */
	const CAPABILITY = 'manage_options';

	/**
	 * @return void
	 */
	public function register() {
		add_action( 'admin_menu', array( $this, 'register_menu' ), 10 );
	}

	/**
	 * @return void
	 */
	public function register_menu() {
		add_submenu_page(
			'hoc-root',
			__( 'Request a Feature', 'handofclient' ),
			__( 'Request a Feature', 'handofclient' ),
			self::CAPABILITY,
			'hoc-customization',
			array( $this, 'render_request_page' )
		);
		add_submenu_page(
			'hoc-root',
			__( 'Feature admin', 'handofclient' ),
			__( 'Feature admin', 'handofclient' ),
			self::CAPABILITY,
			'hoc-features',
			array( $this, 'render_admin_page' )
		);
	}

	/**
	 * @return void
	 */
	public function render_request_page() {
		$this->render_page(
			__( 'Request a Feature', 'handofclient' ),
			'<p>' . esc_html__( 'Describe the feature, integration or page change you would like. It is built for you, and only you see it until you share it.', 'handofclient' ) . '</p>'
		);
	}

	/**
	 * @return void
	 */
	public function render_admin_page() {
		$this->render_page(
			__( 'Feature admin', 'handofclient' ),
			'<p>' . sprintf(
				/* translators: %s: the webhook URL */
				esc_html__( 'Settings, every request and feature, and data sources. The platform delivers build results to %s.', 'handofclient' ),
				'<code>' . esc_html( HOC_Site::webhook_url() ) . '</code>'
			) . '</p>',
			true
		);
	}

	/**
	 * @param string $title Page title.
	 * @param string $intro Already-escaped intro HTML.
	 * @param bool   $admin True for the admin screen.
	 * @return void
	 */
	private function render_page( $title, $intro, $admin = false ) {
		if ( ! current_user_can( self::CAPABILITY ) ) {
			wp_die( esc_html__( 'You do not have permission to view this page.', 'handofclient' ) );
		}

		echo '<div class="wrap"><h1>' . esc_html( $title ) . '</h1>';

		$problem = $this->problem();
		if ( '' !== $problem ) {
			echo '<p>' . esc_html( $problem ) . '</p></div>';
			return;
		}

		// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- escaped above.
		echo $intro;
		$site = new HOC_Site();
		if ( $admin ) {
			$site->render_admin_elements( '<hoc-feature-admin></hoc-feature-admin>' );
		} else {
			$site->render_admin_elements( '<hoc-request-feature></hoc-request-feature><hoc-my-features></hoc-my-features>' );
		}
		echo '</div>';
	}

	/**
	 * What stops the screens from working yet, in words a site owner can act on; empty when nothing does.
	 *
	 * @return string
	 */
	private function problem() {
		if ( ! HOC_Options::is_paired() ) {
			return __( 'HandOfClient is not paired with a platform yet - finish setup on the Settings page first.', 'handofclient' );
		}
		if ( '' === HOC_Options::get_webhook_secret() ) {
			return __( 'Add the webhook secret on the Settings page first - without it the platform cannot report build results back to this site.', 'handofclient' );
		}
		return HOC_Site::unavailable_reason();
	}
}
