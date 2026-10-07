<?php
/**
 * ES256 embed-token verification.
 *
 * @package HandOfClient
 */

defined( 'ABSPATH' ) || exit;

/**
 * Verifies the platform's ES256 embed tokens against its published JWKS.
 *
 * No Composer dependency. firebase/php-jwt would do this, but vendoring a Composer tree into a
 * WordPress plugin is a genuinely bad distribution story (conflicting vendor copies between plugins
 * is a well-known way to break a site), and the part actually needed here is small and completely
 * specified: convert a P-256 JWK to a PEM, convert a JOSE signature to DER, call openssl_verify.
 * ext/openssl is present on every WordPress host worth supporting.
 *
 * The crypto helpers below are static, pure, and take everything as arguments precisely so they can
 * be exercised without WordPress loaded - see tests/test-jwt.php.
 */
class HOC_JWT {

	/** Must match EmbedTokenService.Issuer. */
	const ISSUER = 'handofclient';

	/** Must match EmbedTokenService.Audience. */
	const AUDIENCE = 'handofclient-platform-api';

	/** Clock skew allowance, matching the platform's own 30s and then some. */
	const LEEWAY = 60;

	const JWKS_CACHE_KEY = 'hoc_jwks';

	/** Stops an unknown-kid storm from hammering the platform once per request. */
	const JWKS_REFETCH_LOCK = 'hoc_jwks_refetch_lock';

	/**
	 * Verifies a token and returns its claims.
	 *
	 * @param string $token Compact JWS.
	 * @return array<string,mixed>|WP_Error
	 */
	public static function verify( $token ) {
		if ( ! is_string( $token ) || '' === $token ) {
			return new WP_Error( 'hoc_jwt_missing', __( 'No token supplied.', 'handofclient' ) );
		}

		$parts = explode( '.', $token );
		if ( 3 !== count( $parts ) ) {
			return new WP_Error( 'hoc_jwt_malformed', __( 'Token is not a compact JWS.', 'handofclient' ) );
		}

		list( $header_b64, $payload_b64, $signature_b64 ) = $parts;

		$header = json_decode( (string) self::b64url_decode( $header_b64 ), true );
		if ( ! is_array( $header ) ) {
			return new WP_Error( 'hoc_jwt_malformed', __( 'Token header is not JSON.', 'handofclient' ) );
		}

		// Pinned, not read-and-trusted. Accepting whatever `alg` says is the classic JWT
		// vulnerability - "none", or an RS256/HS256 confusion that verifies a symmetric MAC against
		// a public key. This host only ever issues ES256, so anything else is rejected outright.
		if ( ! isset( $header['alg'] ) || 'ES256' !== $header['alg'] ) {
			return new WP_Error( 'hoc_jwt_bad_alg', __( 'Token algorithm is not ES256.', 'handofclient' ) );
		}

		$claims = json_decode( (string) self::b64url_decode( $payload_b64 ), true );
		if ( ! is_array( $claims ) ) {
			return new WP_Error( 'hoc_jwt_malformed', __( 'Token payload is not JSON.', 'handofclient' ) );
		}

		$signature = self::b64url_decode( $signature_b64 );
		if ( false === $signature || 64 !== strlen( $signature ) ) {
			return new WP_Error( 'hoc_jwt_malformed', __( 'Token signature is not a P-256 signature.', 'handofclient' ) );
		}

		$kid           = isset( $header['kid'] ) ? (string) $header['kid'] : '';
		$signing_input = $header_b64 . '.' . $payload_b64;

		$verified = self::verify_against_jwks( $signing_input, $signature, $kid, false );
		if ( ! $verified ) {
			// A key the cached JWKS does not contain is the expected state right after the platform
			// rotates its signing key, so refetch once before calling the token bad. The lock keeps
			// a stream of genuinely-forged tokens from turning into a request-per-call stampede
			// against the platform.
			if ( false === get_transient( self::JWKS_REFETCH_LOCK ) ) {
				set_transient( self::JWKS_REFETCH_LOCK, 1, 60 );
				$verified = self::verify_against_jwks( $signing_input, $signature, $kid, true );
			}
		}

		if ( ! $verified ) {
			return new WP_Error( 'hoc_jwt_bad_signature', __( 'Token signature did not verify.', 'handofclient' ) );
		}

		$claim_error = self::validate_claims( $claims );
		if ( is_wp_error( $claim_error ) ) {
			return $claim_error;
		}

		return $claims;
	}

	/**
	 * @param string $signing_input Header.payload.
	 * @param string $signature     Raw 64-byte signature.
	 * @param string $kid           Key id from the header, or ''.
	 * @param bool   $force_refresh Bypass the JWKS cache.
	 * @return bool
	 */
	private static function verify_against_jwks( $signing_input, $signature, $kid, $force_refresh ) {
		$keys = self::get_jwks_keys( $force_refresh );
		if ( empty( $keys ) ) {
			return false;
		}

		foreach ( $keys as $jwk ) {
			if ( ! is_array( $jwk ) ) {
				continue;
			}
			// An unkeyed token (no kid) is tried against every key rather than rejected: the kid is a
			// routing hint, not a security control, and the signature is what actually decides.
			if ( '' !== $kid && isset( $jwk['kid'] ) && (string) $jwk['kid'] !== $kid ) {
				continue;
			}
			if ( self::verify_signature_with_jwk( $signing_input, $signature, $jwk ) ) {
				return true;
			}
		}

		return false;
	}

	/**
	 * @param bool $force_refresh Bypass the cache.
	 * @return array<int,array<string,mixed>>
	 */
	private static function get_jwks_keys( $force_refresh = false ) {
		if ( ! $force_refresh ) {
			$cached = get_transient( self::JWKS_CACHE_KEY );
			if ( is_array( $cached ) && isset( $cached['keys'] ) && is_array( $cached['keys'] ) ) {
				return $cached['keys'];
			}
		}

		$client = new HOC_Platform_Client();
		$jwks   = $client->get_jwks( 0 );
		if ( is_wp_error( $jwks ) || ! isset( $jwks['keys'] ) || ! is_array( $jwks['keys'] ) ) {
			return array();
		}

		set_transient( self::JWKS_CACHE_KEY, $jwks, HOUR_IN_SECONDS );
		return $jwks['keys'];
	}

	/**
	 * Validates the registered claims.
	 *
	 * @param array<string,mixed> $claims Decoded payload.
	 * @return true|WP_Error
	 */
	private static function validate_claims( array $claims ) {
		$now = time();

		if ( ! isset( $claims['iss'] ) || self::ISSUER !== $claims['iss'] ) {
			return new WP_Error( 'hoc_jwt_bad_issuer', __( 'Token was not issued by this platform.', 'handofclient' ) );
		}

		// aud may be a string or an array per RFC 7519.
		$aud    = isset( $claims['aud'] ) ? $claims['aud'] : null;
		$aud_ok = is_array( $aud ) ? in_array( self::AUDIENCE, $aud, true ) : ( self::AUDIENCE === $aud );
		if ( ! $aud_ok ) {
			return new WP_Error( 'hoc_jwt_bad_audience', __( 'Token audience does not match.', 'handofclient' ) );
		}

		if ( ! isset( $claims['exp'] ) || ! is_numeric( $claims['exp'] ) ) {
			return new WP_Error( 'hoc_jwt_no_expiry', __( 'Token has no expiry.', 'handofclient' ) );
		}
		if ( $now > ( (int) $claims['exp'] + self::LEEWAY ) ) {
			return new WP_Error( 'hoc_jwt_expired', __( 'Token has expired.', 'handofclient' ) );
		}

		if ( isset( $claims['nbf'] ) && is_numeric( $claims['nbf'] ) && $now < ( (int) $claims['nbf'] - self::LEEWAY ) ) {
			return new WP_Error( 'hoc_jwt_not_yet_valid', __( 'Token is not valid yet.', 'handofclient' ) );
		}

		// The token must be for THIS site. Without this check, a token minted for another tenant of
		// the same platform host would verify cryptographically and then be honoured here.
		$tenant = isset( $claims['tid'] ) ? (string) $claims['tid'] : '';
		if ( $tenant !== HOC_Options::get_tenant_id() ) {
			return new WP_Error( 'hoc_jwt_wrong_tenant', __( 'Token was issued for a different tenant.', 'handofclient' ) );
		}

		$host_id = isset( $claims['hid'] ) ? (string) $claims['hid'] : '';
		if ( $host_id !== HOC_Options::get_host_id() ) {
			return new WP_Error( 'hoc_jwt_wrong_host', __( 'Token was issued for a different host.', 'handofclient' ) );
		}

		return true;
	}

	// ---- pure helpers (no WordPress) --------------------------------------------------------

	/**
	 * Verifies a raw JOSE signature against a JWK.
	 *
	 * @param string              $signing_input Header.payload.
	 * @param string              $signature     Raw 64-byte r||s signature.
	 * @param array<string,mixed> $jwk           Public JWK.
	 * @return bool
	 */
	public static function verify_signature_with_jwk( $signing_input, $signature, array $jwk ) {
		$pem = self::jwk_to_pem( $jwk );
		if ( false === $pem ) {
			return false;
		}

		$der = self::jose_to_der( $signature );
		if ( false === $der ) {
			return false;
		}

		$key = openssl_pkey_get_public( $pem );
		if ( false === $key ) {
			return false;
		}

		$result = openssl_verify( $signing_input, $der, $key, OPENSSL_ALGO_SHA256 );

		// openssl_verify returns 1 valid, 0 invalid, -1 error. Only 1 is success; -1 must never be
		// treated as truthy.
		return 1 === $result;
	}

	/**
	 * Converts a P-256 public JWK into a PEM SubjectPublicKeyInfo.
	 *
	 * The DER prefix is fixed for prime256v1 with an uncompressed point, so it is a constant rather
	 * than a general-purpose ASN.1 encoder:
	 *
	 *   30 59                                SEQUENCE (89 bytes)
	 *     30 13                              SEQUENCE (19 bytes) - AlgorithmIdentifier
	 *       06 07 2a8648ce3d0201             OID 1.2.840.10045.2.1  (id-ecPublicKey)
	 *       06 08 2a8648ce3d030107           OID 1.2.840.10045.3.1.7 (prime256v1)
	 *     03 42 00                           BIT STRING (66 bytes, 0 unused bits)
	 *       04 <X:32> <Y:32>                 uncompressed point
	 *
	 * @param array<string,mixed> $jwk Public JWK.
	 * @return string|false PEM, or false if the JWK is not a usable P-256 key.
	 */
	public static function jwk_to_pem( array $jwk ) {
		if ( ! isset( $jwk['kty'] ) || 'EC' !== $jwk['kty'] ) {
			return false;
		}
		if ( ! isset( $jwk['crv'] ) || 'P-256' !== $jwk['crv'] ) {
			return false;
		}
		if ( ! isset( $jwk['x'] ) || ! isset( $jwk['y'] ) ) {
			return false;
		}

		$x = self::b64url_decode( (string) $jwk['x'] );
		$y = self::b64url_decode( (string) $jwk['y'] );

		// Exactly 32 bytes each. A short value would silently shift the point and verify nothing;
		// left-padding it would be guessing at the issuer's intent.
		if ( false === $x || false === $y || 32 !== strlen( $x ) || 32 !== strlen( $y ) ) {
			return false;
		}

		$der = hex2bin( '3059301306072a8648ce3d020106082a8648ce3d03010703420004' ) . $x . $y;

		return "-----BEGIN PUBLIC KEY-----\n"
			. chunk_split( base64_encode( $der ), 64, "\n" )
			. "-----END PUBLIC KEY-----\n";
	}

	/**
	 * Converts a JOSE ES256 signature (raw r||s, 32 bytes each) into the DER SEQUENCE that
	 * openssl_verify expects.
	 *
	 * @param string $signature Raw 64-byte signature.
	 * @return string|false
	 */
	public static function jose_to_der( $signature ) {
		if ( ! is_string( $signature ) || 64 !== strlen( $signature ) ) {
			return false;
		}

		$r = self::der_integer( substr( $signature, 0, 32 ) );
		$s = self::der_integer( substr( $signature, 32, 32 ) );

		$sequence = $r . $s;

		// For P-256 each INTEGER is at most 33 content bytes, so the sequence is at most 70 bytes and
		// always fits the short-form length. Guarded rather than assumed.
		if ( strlen( $sequence ) > 127 ) {
			return false;
		}

		return "\x30" . chr( strlen( $sequence ) ) . $sequence;
	}

	/**
	 * DER INTEGER encoding of a big-endian unsigned value.
	 *
	 * @param string $bytes Big-endian bytes.
	 * @return string
	 */
	private static function der_integer( $bytes ) {
		// DER forbids leading zero padding...
		$bytes = ltrim( $bytes, "\x00" );

		// ...but an all-zero value is still the integer 0, which is one zero byte, not nothing.
		if ( '' === $bytes ) {
			$bytes = "\x00";
		}

		// DER INTEGERs are signed, so a leading byte with the high bit set would read as negative.
		if ( 0 !== ( ord( $bytes[0] ) & 0x80 ) ) {
			$bytes = "\x00" . $bytes;
		}

		return "\x02" . chr( strlen( $bytes ) ) . $bytes;
	}

	/**
	 * @param string $input Base64url text.
	 * @return string|false
	 */
	public static function b64url_decode( $input ) {
		$input = strtr( (string) $input, '-_', '+/' );
		$pad   = strlen( $input ) % 4;
		if ( 0 !== $pad ) {
			$input .= str_repeat( '=', 4 - $pad );
		}
		return base64_decode( $input, true );
	}

	/**
	 * @param string $input Raw bytes.
	 * @return string
	 */
	public static function b64url_encode( $input ) {
		return rtrim( strtr( base64_encode( $input ), '+/', '-_' ), '=' );
	}
}
