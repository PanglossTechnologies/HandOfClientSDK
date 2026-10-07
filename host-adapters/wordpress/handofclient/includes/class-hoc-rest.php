<?php
/**
 * REST routes.
 *
 * @package HandOfClient
 */

defined( 'ABSPATH' ) || exit;

/**
 * This site's own REST surface, under /wp-json/hoc/v1.
 *
 * Two different callers, two different authentication schemes, and it is worth being explicit about
 * which is which because they look similar and are not:
 *
 *  - /embed-token is called by THIS SITE'S OWN admin page, in the visitor's browser, same-origin,
 *    authenticated by the WordPress login cookie plus a nonce. It mints a short-lived embed token
 *    for the logged-in user. See docs/postmessage-protocol.md section 9.2 for the response shape,
 *    which embed.js parses.
 *
 *  - /q/* and /cmd/* are called by the PLATFORM, server-to-server, authenticated by an ES256 embed
 *    token in the Authorization header. A plugin bundle cannot call them directly: the CSP the
 *    platform serves with every bundle pins connect-src to the Platform API, so the plugin's request
 *    travels plugin -> hoc.http.send -> EgressProxy -> here. That indirection is not a workaround, it
 *    is what makes every host-data read auditable and rate-limited at the platform.
 *
 * That second point has a useful consequence: NO CORS HANDLING IS NEEDED ANYWHERE in this file.
 * Nothing cross-origin ever reaches these routes from a browser. If a future change relaxes the
 * bundle CSP to allow direct calls, CORS becomes necessary and this comment becomes wrong - which is
 * exactly why it says so out loud.
 */
class HOC_REST {

	/**
	 * @return void
	 */
	public function register() {
		add_action( 'rest_api_init', array( $this, 'register_routes' ) );
	}

	/**
	 * @return void
	 */
	public function register_routes() {
		// GET, not POST, because embed.js fetches tokenUrl with a bare fetch() and no method - see
		// MountOptions.tokenUrl. It is still CSRF-safe: the nonce is required, and the only effect is
		// minting a token for the user who is already logged in.
		register_rest_route(
			HOC_REST_NAMESPACE,
			'/embed-token',
			array(
				'methods'             => 'GET',
				'callback'            => array( $this, 'handle_embed_token' ),
				'permission_callback' => array( $this, 'can_mount_slot' ),
				'args'                => array(
					'packageId' => array( 'required' => true, 'type' => 'string' ),
					'slotId'    => array( 'required' => true, 'type' => 'string' ),
				),
			)
		);

		register_rest_route(
			HOC_REST_NAMESPACE,
			'/q/(?P<name>[a-z0-9._-]+)',
			array(
				'methods'             => 'GET',
				'callback'            => array( $this, 'handle_query' ),
				'permission_callback' => array( $this, 'authenticate_embed_token' ),
			)
		);

		register_rest_route(
			HOC_REST_NAMESPACE,
			'/cmd/(?P<name>[a-z0-9._-]+)',
			array(
				'methods'             => 'POST',
				'callback'            => array( $this, 'handle_command' ),
				'permission_callback' => array( $this, 'authenticate_embed_token' ),
			)
		);

		// Documentation surface for plugin authors and the admin screen. manage_options rather than
		// public: the list of available queries plus their required capabilities is a map of this
		// site's data surface, which is not something to hand to anonymous callers.
		register_rest_route(
			HOC_REST_NAMESPACE,
			'/catalog',
			array(
				'methods'             => 'GET',
				'callback'            => array( $this, 'handle_catalog' ),
				'permission_callback' => static function () {
					return current_user_can( 'manage_options' );
				},
			)
		);
	}

	// ---- permission callbacks ----------------------------------------------------------------

	/**
	 * Cookie + nonce, plus the per-slot capability this site configured.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return true|WP_Error
	 */
	public function can_mount_slot( $request ) {
		if ( ! is_user_logged_in() ) {
			return new WP_Error( 'hoc_not_logged_in', __( 'You must be logged in.', 'handofclient' ), array( 'status' => 401 ) );
		}

		$slot_id = (string) $request->get_param( 'slotId' );
		$config  = HOC_Options::get_slot_config( $slot_id );

		if ( ! current_user_can( $config['capability'] ) ) {
			return new WP_Error( 'hoc_forbidden', __( 'You do not have access to this feature.', 'handofclient' ), array( 'status' => 403 ) );
		}

		return true;
	}

	/**
	 * Verifies the embed token and becomes the user it was issued for.
	 *
	 * wp_set_current_user() here rather than in the handler is deliberate: everything downstream -
	 * the catalogues' current_user_can() checks, get_posts() respecting the user's own visibility,
	 * wp_insert_post() attributing authorship - is written against WordPress's normal notion of "the
	 * current user", and there is no second, parallel permission system in this plugin that could
	 * drift out of step with it.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return true|WP_Error
	 */
	public function authenticate_embed_token( $request ) {
		$token = self::extract_bearer_token( $request );
		if ( '' === $token ) {
			return new WP_Error( 'hoc_no_token', __( 'No embed token supplied.', 'handofclient' ), array( 'status' => 401 ) );
		}

		$claims = HOC_JWT::verify( $token );
		if ( is_wp_error( $claims ) ) {
			return new WP_Error( $claims->get_error_code(), $claims->get_error_message(), array( 'status' => 401 ) );
		}

		$user_id = isset( $claims['sub'] ) ? (int) $claims['sub'] : 0;
		if ( $user_id <= 0 || ! get_userdata( $user_id ) ) {
			// The user existed when the token was minted and does not now - deleted mid-session. Fail
			// closed rather than falling back to an anonymous or admin identity.
			return new WP_Error( 'hoc_unknown_user', __( 'The user this token was issued for no longer exists.', 'handofclient' ), array( 'status' => 401 ) );
		}

		wp_set_current_user( $user_id );

		// Stashed for the handlers, so they never re-parse the token.
		$request->set_param( '_hoc_claims', $claims );

		return true;
	}

	/**
	 * Reads the bearer token, tolerating hosts that strip the Authorization header.
	 *
	 * Apache running PHP as CGI/FastCGI drops Authorization unless the vhost explicitly re-exposes it
	 * - the same long-standing WordPress issue that Application Passwords documentation warns about.
	 * REDIRECT_HTTP_AUTHORIZATION covers the usual .htaccess workaround; X-HOC-Token is the fallback
	 * for hosts where neither is available, since nothing strips a custom header.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return string
	 */
	private static function extract_bearer_token( $request ) {
		$header = (string) $request->get_header( 'authorization' );

		if ( '' === $header && isset( $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ) ) {
			$header = sanitize_text_field( wp_unslash( $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ) );
		}

		if ( '' !== $header && 0 === stripos( $header, 'bearer ' ) ) {
			return trim( substr( $header, 7 ) );
		}

		$fallback = (string) $request->get_header( 'x-hoc-token' );
		return '' !== $fallback ? trim( $fallback ) : '';
	}

	// ---- handlers ----------------------------------------------------------------------------

	/**
	 * Mints an embed token for the logged-in user.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function handle_embed_token( $request ) {
		$user = wp_get_current_user();

		$client = new HOC_Platform_Client();
		$issued = $client->issue_embed_token(
			(string) $user->ID,
			(string) $request->get_param( 'packageId' ),
			(string) $request->get_param( 'slotId' )
		);

		if ( is_wp_error( $issued ) ) {
			return new WP_Error(
				$issued->get_error_code(),
				$issued->get_error_message(),
				array( 'status' => 502 )
			);
		}

		if ( ! isset( $issued['token'] ) || ! isset( $issued['expiresAt'] ) ) {
			return new WP_Error( 'hoc_bad_token_response', __( 'The platform returned an unexpected token response.', 'handofclient' ), array( 'status' => 502 ) );
		}

		// Exactly the shape embed.js expects (TokenEndpointResponse). hostId/tenantId/packageId/slotId
		// are deliberately absent - the page already knows all four, since they were mount()'s own
		// arguments.
		return new WP_REST_Response(
			array(
				'token'       => (string) $issued['token'],
				'expiresAt'   => (string) $issued['expiresAt'],
				'userId'      => (string) $user->ID,
				'displayName' => $user->display_name,
			)
		);
	}

	/**
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function handle_query( $request ) {
		$name = (string) $request->get_param( 'name' );

		$params = $request->get_query_params();
		unset( $params['name'], $params['_hoc_claims'], $params['rest_route'] );

		$catalog = new HOC_Query_Catalog();
		$result  = $catalog->run( $name, $params );

		if ( is_wp_error( $result ) ) {
			return $result;
		}

		return new WP_REST_Response( $result );
	}

	/**
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function handle_command( $request ) {
		$name = (string) $request->get_param( 'name' );

		$body = $request->get_json_params();
		if ( ! is_array( $body ) ) {
			$body = array();
		}

		$idempotency_key = sanitize_text_field( (string) $request->get_header( 'x-hoc-idempotency-key' ) );

		$catalog = new HOC_Command_Catalog();
		$result  = $catalog->run( $name, $body, $idempotency_key );

		if ( is_wp_error( $result ) ) {
			return $result;
		}

		return new WP_REST_Response( $result );
	}

	/**
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response
	 */
	public function handle_catalog( $request ) {
		return new WP_REST_Response(
			array(
				'queries'         => HOC_Query_Catalog::describe(),
				'commands'        => HOC_Command_Catalog::describe(),
				'allowedMetaKeys' => HOC_Command_Catalog::allowed_meta_keys(),
			)
		);
	}
}
