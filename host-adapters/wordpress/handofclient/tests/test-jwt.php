<?php
/**
 * Standalone tests for HOC_JWT's pure crypto helpers.
 *
 * Runs without WordPress and without PHPUnit - the point is that anyone can check the one piece of
 * this plugin that is hand-rolled cryptography with a single command:
 *
 *   php host-adapters/wordpress/handofclient/tests/test-jwt.php
 *
 * Requires ext/openssl.
 *
 * @package HandOfClient
 */

define( 'ABSPATH', __DIR__ );

require_once dirname( __DIR__ ) . '/includes/class-hoc-jwt.php';

$tests  = 0;
$failed = 0;

/**
 * @param string $name      Test name.
 * @param bool   $condition Assertion.
 * @return void
 */
function ok( $name, $condition ) {
	global $tests, $failed;
	++$tests;
	if ( $condition ) {
		echo "  ok   $name\n";
	} else {
		++$failed;
		echo "  FAIL $name\n";
	}
}

/**
 * Converts an OpenSSL DER ECDSA signature to the raw r||s form a JWT carries.
 *
 * This is the inverse of HOC_JWT::jose_to_der and lives only in the test - the plugin never needs to
 * produce a signature, only verify one.
 *
 * @param string $der DER SEQUENCE.
 * @return string 64 raw bytes.
 */
function der_to_jose( $der ) {
	$offset = 0;
	if ( "\x30" !== $der[ $offset ] ) {
		throw new RuntimeException( 'not a SEQUENCE' );
	}
	++$offset;
	$seq_len = ord( $der[ $offset ] );
	++$offset;
	if ( $seq_len > 127 ) {
		throw new RuntimeException( 'long-form length unexpected for P-256' );
	}

	$read_int = static function () use ( $der, &$offset ) {
		if ( "\x02" !== $der[ $offset ] ) {
			throw new RuntimeException( 'not an INTEGER' );
		}
		++$offset;
		$len = ord( $der[ $offset ] );
		++$offset;
		$value   = substr( $der, $offset, $len );
		$offset += $len;
		// Strip DER's sign byte, then left-pad to the fixed 32-byte JOSE width.
		$value = ltrim( $value, "\x00" );
		return str_pad( $value, 32, "\x00", STR_PAD_LEFT );
	};

	$r = $read_int();
	$s = $read_int();

	return $r . $s;
}

/**
 * Builds a public JWK from an OpenSSL EC key.
 *
 * @param resource|OpenSSLAsymmetricKey $key Key.
 * @param string                        $kid Key id.
 * @return array<string,mixed>
 */
function jwk_from_key( $key, $kid = 'test-key' ) {
	$details = openssl_pkey_get_details( $key );
	return array(
		'kty' => 'EC',
		'crv' => 'P-256',
		'kid' => $kid,
		// The platform emits fixed-width 32-byte coordinates; pad defensively in case OpenSSL
		// returns a short one for a coordinate with leading zero bytes.
		'x'   => HOC_JWT::b64url_encode( str_pad( $details['ec']['x'], 32, "\x00", STR_PAD_LEFT ) ),
		'y'   => HOC_JWT::b64url_encode( str_pad( $details['ec']['y'], 32, "\x00", STR_PAD_LEFT ) ),
	);
}

echo "HOC_JWT crypto tests\n\n";

// ---- base64url round trip ---------------------------------------------------------------------

echo "base64url:\n";
foreach ( array( '', 'a', 'ab', 'abc', 'abcd', "\x00\xff\xfe", random_bytes( 32 ), random_bytes( 64 ) ) as $raw ) {
	$encoded = HOC_JWT::b64url_encode( $raw );
	ok(
		'round trips ' . strlen( $raw ) . ' bytes',
		HOC_JWT::b64url_decode( $encoded ) === $raw
	);
}
ok( 'no padding characters emitted', false === strpos( HOC_JWT::b64url_encode( random_bytes( 10 ) ), '=' ) );
ok( 'no + or / emitted', ! preg_match( '#[+/]#', HOC_JWT::b64url_encode( random_bytes( 200 ) ) ) );
ok( 'rejects non-base64 input', false === HOC_JWT::b64url_decode( 'not valid base64!!' ) );

// ---- jose_to_der ------------------------------------------------------------------------------

echo "\njose_to_der:\n";
ok( 'rejects wrong length', false === HOC_JWT::jose_to_der( str_repeat( 'a', 63 ) ) );
ok( 'rejects empty', false === HOC_JWT::jose_to_der( '' ) );

// A high bit set in the leading byte must gain a 0x00 sign byte, or OpenSSL reads it as negative.
$high_bit = str_repeat( "\xff", 32 ) . str_repeat( "\xff", 32 );
$der      = HOC_JWT::jose_to_der( $high_bit );
ok( 'pads high-bit r and s with a sign byte', "\x30\x46\x02\x21\x00" === substr( $der, 0, 5 ) );
ok( 'high-bit DER is 72 bytes total', 72 === strlen( $der ) );

// Leading zeros must be stripped, not preserved.
$leading_zero = str_pad( "\x01", 32, "\x00", STR_PAD_LEFT ) . str_pad( "\x01", 32, "\x00", STR_PAD_LEFT );
$der          = HOC_JWT::jose_to_der( $leading_zero );
ok( 'strips leading zeros', "\x30\x06\x02\x01\x01\x02\x01\x01" === $der );

// An all-zero component is the integer 0 - one byte, not zero bytes.
$all_zero = str_repeat( "\x00", 64 );
$der      = HOC_JWT::jose_to_der( $all_zero );
ok( 'encodes an all-zero component as a single zero byte', "\x30\x06\x02\x01\x00\x02\x01\x00" === $der );

// ---- jwk_to_pem -------------------------------------------------------------------------------

echo "\njwk_to_pem:\n";
$keygen_args = array(
	'private_key_type' => OPENSSL_KEYTYPE_EC,
	'curve_name'       => 'prime256v1',
);
// PHP on Windows ships no default openssl.cnf, and openssl_pkey_new fails without one. On Linux
// OpenSSL finds its own, so this stays opt-in via the environment rather than hardcoded.
$openssl_conf = getenv( 'HOC_OPENSSL_CONF' );
if ( is_string( $openssl_conf ) && '' !== $openssl_conf ) {
	$keygen_args['config'] = $openssl_conf;
}

$key = openssl_pkey_new( $keygen_args );
if ( false === $key ) {
	echo "  FAIL could not generate a P-256 key (is ext/openssl configured?)\n";
	exit( 1 );
}
$jwk = jwk_from_key( $key );

$pem = HOC_JWT::jwk_to_pem( $jwk );
ok( 'produces a PEM', is_string( $pem ) && 0 === strpos( $pem, '-----BEGIN PUBLIC KEY-----' ) );
ok( 'PEM is loadable by OpenSSL', false !== openssl_pkey_get_public( $pem ) );

$details   = openssl_pkey_get_details( $key );
$expected  = $details['key'];
$roundtrip = openssl_pkey_get_details( openssl_pkey_get_public( $pem ) );
ok( 'PEM matches the original public key', trim( $roundtrip['key'] ) === trim( $expected ) );

ok( 'rejects a non-EC key', false === HOC_JWT::jwk_to_pem( array( 'kty' => 'RSA', 'n' => 'x', 'e' => 'y' ) ) );
ok( 'rejects the wrong curve', false === HOC_JWT::jwk_to_pem( array_merge( $jwk, array( 'crv' => 'P-384' ) ) ) );
ok( 'rejects a missing coordinate', false === HOC_JWT::jwk_to_pem( array( 'kty' => 'EC', 'crv' => 'P-256', 'x' => $jwk['x'] ) ) );
ok(
	'rejects a short coordinate',
	false === HOC_JWT::jwk_to_pem( array_merge( $jwk, array( 'x' => HOC_JWT::b64url_encode( random_bytes( 31 ) ) ) ) )
);

// ---- signature verification -------------------------------------------------------------------

echo "\nverify_signature_with_jwk:\n";

$signing_input = HOC_JWT::b64url_encode( '{"alg":"ES256","kid":"test-key"}' ) . '.'
	. HOC_JWT::b64url_encode( '{"sub":"42","iss":"handofclient"}' );

openssl_sign( $signing_input, $der_sig, $key, OPENSSL_ALGO_SHA256 );
$jose_sig = der_to_jose( $der_sig );

ok( 'signature is 64 raw bytes', 64 === strlen( $jose_sig ) );
ok( 'verifies a genuine signature', HOC_JWT::verify_signature_with_jwk( $signing_input, $jose_sig, $jwk ) );
ok(
	'rejects a tampered payload',
	! HOC_JWT::verify_signature_with_jwk( $signing_input . 'x', $jose_sig, $jwk )
);

$flipped     = $jose_sig;
$flipped[0]  = chr( ord( $flipped[0] ) ^ 0x01 );
ok( 'rejects a tampered signature', ! HOC_JWT::verify_signature_with_jwk( $signing_input, $flipped, $jwk ) );

$other_key = openssl_pkey_new( $keygen_args );
ok(
	'rejects a signature from a different key',
	! HOC_JWT::verify_signature_with_jwk( $signing_input, $jose_sig, jwk_from_key( $other_key ) )
);

// The r/s padding paths only trigger for certain signature values, so one signature proves very
// little. ECDSA is randomised, so a loop covers both the high-bit and leading-zero branches in
// practice within a few dozen iterations.
$loop_failures = 0;
for ( $i = 0; $i < 200; $i++ ) {
	$message = 'message-' . $i . '-' . bin2hex( random_bytes( 8 ) );
	openssl_sign( $message, $d, $key, OPENSSL_ALGO_SHA256 );
	if ( ! HOC_JWT::verify_signature_with_jwk( $message, der_to_jose( $d ), $jwk ) ) {
		++$loop_failures;
	}
}
ok( '200 randomised signatures all verify', 0 === $loop_failures );

echo "\n";
if ( $failed > 0 ) {
	echo "FAILED: $failed of $tests\n";
	exit( 1 );
}
echo "All $tests tests passed.\n";
exit( 0 );
