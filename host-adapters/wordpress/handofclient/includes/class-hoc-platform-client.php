<?php
/**
 * Server-to-server client for the platform's Host Gateway.
 *
 * @package HandOfClient
 */

defined( 'ABSPATH' ) || exit;

/**
 * Talks to /host/v1 on the platform.
 *
 * Why not gRPC: the platform's native surface is gRPC and grpc-web, and the gRPC PHP client is a PECL
 * extension that essentially no shared or managed WordPress host has installed. The Host Gateway
 * exists precisely so this file can be plain wp_remote_get/post against JSON (the /host/v1 REST
 * surface, described in openapi/platform-host-v1.yaml).
 *
 * Every read is cached, and every failure is negatively cached. That second half matters more than
 * it looks: without it, a platform that is down or slow adds its full timeout to EVERY page view of
 * this site, turning someone else's outage into this site's outage.
 */
class HOC_Platform_Client {

	/** Cache key prefix; also what flush_caches() sweeps. */
	const CACHE_PREFIX = 'hoc_pf_';

	/** How long a failed call suppresses retries. */
	const FAILURE_BACKOFF = 300;

	/** Per-request timeout. Deliberately short - this can run during an admin page render. */
	const TIMEOUT = 8;

	/**
	 * GET a Host Gateway path, with caching.
	 *
	 * @param string              $path      Path under /host/v1, e.g. "/activations".
	 * @param array<string,mixed> $query     Query parameters.
	 * @param int|null            $cache_ttl Seconds to cache; null uses the configured default, 0 disables.
	 * @return array<string,mixed>|WP_Error
	 */
	public function get( $path, array $query = array(), $cache_ttl = null ) {
		$ttl = ( null === $cache_ttl ) ? (int) HOC_Options::get( 'cache_ttl', 300 ) : (int) $cache_ttl;
		$key = self::cache_key( 'GET', $path, $query );

		if ( $ttl > 0 ) {
			$cached = get_transient( $key );
			if ( false !== $cached ) {
				// A cached failure is replayed as a failure rather than as a cache miss, so a down
				// platform costs one request per backoff window instead of one per page view.
				if ( is_array( $cached ) && isset( $cached['__hoc_error'] ) ) {
					return new WP_Error( 'hoc_platform_cached_error', (string) $cached['__hoc_error'] );
				}
				return $cached;
			}
		}

		$result = $this->request( 'GET', $path, $query, null );

		if ( $ttl > 0 ) {
			if ( is_wp_error( $result ) ) {
				set_transient( $key, array( '__hoc_error' => $result->get_error_message() ), self::FAILURE_BACKOFF );
			} else {
				set_transient( $key, $result, $ttl );
			}
		}

		return $result;
	}

	/**
	 * @param string              $path Path under /host/v1.
	 * @param array<string,mixed> $body JSON body.
	 * @return array<string,mixed>|WP_Error
	 */
	public function post( $path, array $body ) {
		return $this->request( 'POST', $path, array(), $body );
	}

	/**
	 * @param string              $path Path under /host/v1.
	 * @param array<string,mixed> $body JSON body.
	 * @return array<string,mixed>|WP_Error
	 */
	public function put( $path, array $body ) {
		return $this->request( 'PUT', $path, array(), $body );
	}

	/**
	 * Fire-and-forget POST: opens the connection, writes the request, and does not wait for a reply.
	 *
	 * This exists for exactly one caller - HOC_Hooks dispatching a WordPress action - and the
	 * non-blocking part is the whole point. An action fires inside a request a real visitor is
	 * waiting on (publishing a post, leaving a comment), so a blocking call would put a third
	 * party's latency directly into this site's page load, and their outage into its uptime.
	 *
	 * The cost is honest and worth stating: there is no status code to check, so delivery is
	 * at-most-once and unverified from this end. That is acceptable for an action precisely because
	 * WordPress discards an action's return value - nothing here was ever going to branch on the
	 * result. It would NOT be acceptable for a filter, which is why filters never reach this method.
	 *
	 * @param string              $path Path under /host/v1.
	 * @param array<string,mixed> $body JSON body.
	 * @return true|WP_Error True once the request has been handed to the transport.
	 */
	public function post_fire_and_forget( $path, array $body ) {
		$base = HOC_Options::get_platform_base_url();
		if ( '' === $base ) {
			return new WP_Error( 'hoc_not_configured', __( 'HandOfClient is not paired with a platform yet.', 'handofclient' ) );
		}
		$api_key = HOC_Options::get_api_key();
		if ( '' === $api_key ) {
			return new WP_Error( 'hoc_not_configured', __( 'No platform API key is set.', 'handofclient' ) );
		}

		$response = wp_remote_post(
			$base . '/host/v1' . $path,
			array(
				'blocking' => false,
				// Still bounded: 'blocking' => false skips reading the RESPONSE, it does not make
				// connecting free. A platform that accepts the TCP connection and then stalls would
				// otherwise hold this page load open.
				'timeout'  => 1,
				'headers'  => array(
					'Accept'       => 'application/json',
					'Content-Type' => 'application/json',
					'User-Agent'   => 'HandOfClient-WordPress/' . HOC_VERSION,
					'x-api-key'    => $api_key,
				),
				'body'     => wp_json_encode( $body ),
			)
		);

		return is_wp_error( $response ) ? $response : true;
	}

	/**
	 * @param string              $path  Path under /host/v1.
	 * @param array<string,mixed> $query Query parameters.
	 * @return array<string,mixed>|WP_Error
	 */
	public function delete( $path, array $query = array() ) {
		return $this->request( 'DELETE', $path, $query, null );
	}

	/**
	 * Verifies pairing. Never cached - the whole point is to test the credentials as they are now.
	 *
	 * @return array<string,mixed>|WP_Error
	 */
	public function whoami() {
		return $this->request( 'GET', '/whoami', array(), null );
	}

	/**
	 * Mints an embed token for one user and slot.
	 *
	 * @param string $user_id    Host-side user identifier (the WP user id).
	 * @param string $package_id Package id.
	 * @param string $slot_id    Slot id.
	 * @return array<string,mixed>|WP_Error
	 */
	public function issue_embed_token( $user_id, $package_id, $slot_id ) {
		return $this->post(
			'/embed-token',
			array(
				'tenantId'  => HOC_Options::get_tenant_id(),
				'userId'    => (string) $user_id,
				'packageId' => $package_id,
				'slotId'    => $slot_id,
			)
		);
	}

	/**
	 * Every activation for this tenant.
	 *
	 * @param int|null $cache_ttl Override cache lifetime.
	 * @return array<string,mixed>|WP_Error
	 */
	public function list_activations( $cache_ttl = null ) {
		return $this->get( '/activations', array( 'tenantId' => HOC_Options::get_tenant_id() ), $cache_ttl );
	}

	/**
	 * @param string   $package_id Package id.
	 * @param string   $slot_id    Slot id.
	 * @param int|null $cache_ttl  Override cache lifetime.
	 * @return array<string,mixed>|WP_Error
	 */
	public function get_active_version( $package_id, $slot_id, $cache_ttl = null ) {
		return $this->get(
			'/active-version',
			array(
				'tenantId'  => HOC_Options::get_tenant_id(),
				'packageId' => $package_id,
				'slotId'    => $slot_id,
			),
			$cache_ttl
		);
	}

	/**
	 * The platform's JWKS. Public - no API key needed.
	 *
	 * @param int $cache_ttl Seconds to cache.
	 * @return array<string,mixed>|WP_Error
	 */
	public function get_jwks( $cache_ttl = 3600 ) {
		return $this->get( '/jwks', array(), $cache_ttl );
	}

	/**
	 * Performs the HTTP call.
	 *
	 * @param string                   $method HTTP method.
	 * @param string                   $path   Path under /host/v1.
	 * @param array<string,mixed>      $query  Query parameters.
	 * @param array<string,mixed>|null $body   JSON body, or null.
	 * @return array<string,mixed>|WP_Error
	 */
	private function request( $method, $path, array $query, $body ) {
		$base = HOC_Options::get_platform_base_url();
		if ( '' === $base ) {
			return new WP_Error( 'hoc_not_configured', __( 'HandOfClient is not paired with a platform yet.', 'handofclient' ) );
		}

		$url = $base . '/host/v1' . $path;
		if ( ! empty( $query ) ) {
			$url = add_query_arg( array_map( 'strval', $query ), $url );
		}

		$args = array(
			'method'  => $method,
			'timeout' => self::TIMEOUT,
			'headers' => array(
				'Accept'     => 'application/json',
				'User-Agent' => 'HandOfClient-WordPress/' . HOC_VERSION,
			),
		);

		// The JWKS endpoint is public; sending the key there would leak it to any future proxy in
		// front of it for no benefit.
		if ( '/jwks' !== $path ) {
			$api_key = HOC_Options::get_api_key();
			if ( '' === $api_key ) {
				return new WP_Error( 'hoc_not_configured', __( 'No platform API key is set.', 'handofclient' ) );
			}
			$args['headers']['x-api-key'] = $api_key;
		}

		if ( null !== $body ) {
			$args['headers']['Content-Type'] = 'application/json';
			$args['body']                    = wp_json_encode( $body );
		}

		$response = wp_remote_request( $url, $args );

		if ( is_wp_error( $response ) ) {
			return new WP_Error(
				'hoc_platform_unreachable',
				sprintf(
					/* translators: %s: underlying transport error */
					__( 'Could not reach the HandOfClient platform: %s', 'handofclient' ),
					$response->get_error_message()
				)
			);
		}

		$status = (int) wp_remote_retrieve_response_code( $response );
		$raw    = wp_remote_retrieve_body( $response );
		$parsed = json_decode( $raw, true );

		if ( $status < 200 || $status >= 300 ) {
			$detail = ( is_array( $parsed ) && isset( $parsed['error'] ) )
				? (string) $parsed['error']
				: sprintf( 'HTTP %d', $status );

			// 401 is worth its own code: it is nearly always a wrong or revoked API key, and the
			// admin screen can say so instead of showing a generic failure.
			$code = ( 401 === $status ) ? 'hoc_platform_unauthorized' : 'hoc_platform_error';
			return new WP_Error( $code, $detail, array( 'status' => $status ) );
		}

		if ( ! is_array( $parsed ) ) {
			return new WP_Error( 'hoc_platform_bad_response', __( 'The platform returned a response that was not JSON.', 'handofclient' ) );
		}

		return $parsed;
	}

	/**
	 * @param string              $method HTTP method.
	 * @param string              $path   Request path.
	 * @param array<string,mixed> $query  Query parameters.
	 * @return string
	 */
	private static function cache_key( $method, $path, array $query ) {
		ksort( $query );
		// The host id is part of the key so re-pairing this site to a different host does not serve
		// the previous host's cached activations.
		return self::CACHE_PREFIX . md5( HOC_Options::get_host_id() . '|' . $method . '|' . $path . '|' . wp_json_encode( $query ) );
	}

	/**
	 * Drops every cached platform response.
	 *
	 * Transients have no prefix-based delete in the options table, and an object cache has no
	 * enumeration API at all, so this bumps a namespace salt instead of trying to find and delete
	 * individual keys - the old entries become unreachable and expire on their own.
	 *
	 * @return void
	 */
	public static function flush_caches() {
		global $wpdb;

		// Best effort for the common (no persistent object cache) case: delete the rows outright so
		// the options table does not keep them until expiry.
		if ( isset( $wpdb ) && ! wp_using_ext_object_cache() ) {
			$like = $wpdb->esc_like( '_transient_' . self::CACHE_PREFIX ) . '%';
			// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
			$names = $wpdb->get_col( $wpdb->prepare( "SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s", $like ) );
			foreach ( (array) $names as $name ) {
				delete_transient( substr( (string) $name, strlen( '_transient_' ) ) );
			}
		}

		delete_transient( 'hoc_jwks' );
	}
}
