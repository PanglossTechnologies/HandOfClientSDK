<?php
/**
 * "Request a Feature" - the self-service customization intake screen.
 *
 * @package HandOfClient
 */

defined( 'ABSPATH' ) || exit;

/**
 * "Type a feature request and see it built without a release cycle" - the WordPress half of the same
 * loop DotNetShared.Extensibility's CustomizationRequestForm/CustomizationRequestList already provide
 * for .NET hosts (see HandOfClient.Platform's TaskExport/CustomizationRequestSubmissionService for the
 * platform side this screen calls).
 *
 * Registered only when the adapter is enabled and paired (alongside HOC_REST/HOC_Mounts/HOC_Hooks in
 * hoc_bootstrap(), NOT alongside HOC_Admin which is unconditional) - unlike the Settings screen, this
 * page has nothing useful to show or do until there is a real platform connection to submit against.
 *
 * MVP scope, deliberately: shows each request's own status but has no reply UI for a NeedsInfo-style
 * "we need more detail from you" round trip yet - that is DotNetShared's
 * CustomizationRequestService.SubmitAdditionalInfoAsync equivalent, not built here. A real, known gap,
 * not silently dropped - see PROGRESS.md.
 */
class HOC_Customization {

	/** Any authenticated user who can already reach the HandOfClient admin menu. Matches HOC_Admin's own
	 * capability - this is a site-owner-facing tool today, not a per-visitor one. */
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
		add_submenu_page(
			'hoc-root',
			__( 'Request a Feature', 'handofclient' ),
			__( 'Request a Feature', 'handofclient' ),
			self::CAPABILITY,
			'hoc-customization',
			array( $this, 'render_page' )
		);
	}

	/**
	 * @return void
	 */
	public function handle_actions() {
		if ( ! current_user_can( self::CAPABILITY ) ) {
			return;
		}

		$action = isset( $_REQUEST['hoc_action'] ) ? sanitize_key( wp_unslash( $_REQUEST['hoc_action'] ) ) : '';
		if ( 'submit_customization_request' !== $action ) {
			return;
		}

		check_admin_referer( 'hoc_submit_customization_request' );

		$text = isset( $_POST['request_text'] ) ? sanitize_textarea_field( wp_unslash( $_POST['request_text'] ) ) : '';
		if ( '' === trim( $text ) ) {
			$this->redirect_with_notice( 'request_empty' );
			return;
		}

		$user   = wp_get_current_user();
		$client = new HOC_Platform_Client();
		$result = $client->submit_customization_request(
			$user->display_name ? $user->display_name : $user->user_login,
			$user->user_email,
			$text
		);

		$this->redirect_with_notice( is_wp_error( $result ) ? 'request_failed' : 'request_submitted', $result );
	}

	/**
	 * @param string        $notice Notice slug.
	 * @param WP_Error|null $error  Optional error to surface.
	 * @return void
	 */
	private function redirect_with_notice( $notice, $error = null ) {
		$args = array(
			'page'       => 'hoc-customization',
			'hoc_notice' => $notice,
		);
		if ( is_wp_error( $error ) ) {
			$args['hoc_error'] = rawurlencode( $error->get_error_message() );
		}
		wp_safe_redirect( add_query_arg( $args, admin_url( 'admin.php' ) ) );
		exit;
	}

	/**
	 * @return void
	 */
	public function render_page() {
		if ( ! current_user_can( self::CAPABILITY ) ) {
			wp_die( esc_html__( 'You do not have permission to view this page.', 'handofclient' ) );
		}

		echo '<div class="wrap"><h1>' . esc_html__( 'Request a Feature', 'handofclient' ) . '</h1>';

		if ( ! HOC_Options::is_paired() ) {
			printf(
				'<p>%s</p>',
				esc_html__( 'HandOfClient is not paired with a platform yet - finish setup on the Settings page first.', 'handofclient' )
			);
			echo '</div>';
			return;
		}

		$this->render_notice();
		$this->render_form();
		$this->render_request_list();

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
			'request_submitted' => array( 'success', __( 'Thanks - your request has been received. It has been added to the build queue with your name attached.', 'handofclient' ) ),
			'request_empty'     => array( 'error', __( 'Please describe what you would like before submitting.', 'handofclient' ) ),
			'request_failed'    => array( 'error', __( 'Something went wrong and your request was not recorded.', 'handofclient' ) ),
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
	 * @return void
	 */
	private function render_form() {
		echo '<p>' . esc_html__( 'Describe the feature, integration, or page change you would like. This goes straight into the build queue with your name attached.', 'handofclient' ) . '</p>';

		echo '<form method="post" action="' . esc_url( admin_url( 'admin.php?page=hoc-customization' ) ) . '">';
		wp_nonce_field( 'hoc_submit_customization_request' );
		echo '<input type="hidden" name="hoc_action" value="submit_customization_request" />';
		printf(
			'<p><textarea name="request_text" rows="6" class="large-text" placeholder="%s"></textarea></p>',
			esc_attr__( 'What would you like?', 'handofclient' )
		);
		submit_button( __( 'Submit request', 'handofclient' ) );
		echo '</form>';
	}

	/**
	 * Live pairing check via a real round trip, same "answers with data, not a promise" philosophy as
	 * HOC_Admin::render_status - if the platform cannot be reached, say so plainly rather than showing
	 * an empty list that looks identical to "no requests yet".
	 *
	 * @return void
	 */
	private function render_request_list() {
		echo '<h2>' . esc_html__( 'Your requests', 'handofclient' ) . '</h2>';

		$client = new HOC_Platform_Client();
		$listing = $client->list_customization_requests();

		if ( is_wp_error( $listing ) ) {
			printf(
				'<p><span style="color:#d63638">%s</span> <code>%s</code></p>',
				esc_html__( 'Could not load your requests from the platform.', 'handofclient' ),
				esc_html( $listing->get_error_message() )
			);
			return;
		}

		$requests = isset( $listing['requests'] ) && is_array( $listing['requests'] ) ? $listing['requests'] : array();
		if ( empty( $requests ) ) {
			echo '<p>' . esc_html__( 'No requests submitted yet.', 'handofclient' ) . '</p>';
			return;
		}

		echo '<table class="widefat striped" style="max-width:900px"><thead><tr>';
		printf(
			'<th>%s</th><th>%s</th><th>%s</th><th>%s</th>',
			esc_html__( 'Request', 'handofclient' ),
			esc_html__( 'Submitted', 'handofclient' ),
			esc_html__( 'By', 'handofclient' ),
			esc_html__( 'Status', 'handofclient' )
		);
		echo '</tr></thead><tbody>';

		foreach ( $requests as $request ) {
			$text = isset( $request['requestText'] ) ? (string) $request['requestText'] : '';
			printf(
				'<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>',
				esc_html( mb_strlen( $text ) > 140 ? mb_substr( $text, 0, 140 ) . '...' : $text ),
				esc_html( isset( $request['atUtc'] ) ? (string) $request['atUtc'] : '' ),
				esc_html( isset( $request['requesterName'] ) ? (string) $request['requesterName'] : '' ),
				esc_html( isset( $request['status'] ) ? (string) $request['status'] : '' )
			);
		}

		echo '</tbody></table>';
	}
}
