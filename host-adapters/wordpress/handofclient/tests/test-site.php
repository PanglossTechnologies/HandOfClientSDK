<?php
/**
 * Standalone tests for the request loop's pure pieces: the MySQL DSN built from wp-config's DB_HOST, the
 * cross-site-write check (the only CSRF defence the loop has), the mount prefix, and the identity
 * override filters.
 *
 * Runs without WordPress and without PHPUnit, same as test-jwt.php:
 *
 *   php host-adapters/wordpress/handofclient/tests/test-site.php
 *
 * The WordPress functions these two classes use are stubbed below with the behaviour that matters
 * (URL parsing, filters returning their default); everything else is exercised for real by the
 * conformance suite (conformance/run-conformance.mjs) and the browser tests.
 *
 * @package HandOfClient
 */

define( 'ABSPATH', __DIR__ );
define( 'HOC_VERSION', 'test' );
define( 'HOC_PLUGIN_FILE', dirname( __DIR__ ) . '/handofclient.php' );
define( 'HOC_PLUGIN_DIR', dirname( __DIR__ ) . '/' );

$GLOBALS['hoc_test_filters'] = array();
$GLOBALS['hoc_test_home']    = 'https://example.com/blog';

function wp_parse_url( $url, $component = -1 ) {
	return parse_url( $url, $component );
}
function wp_unslash( $value ) {
	return $value;
}
function home_url( $path = '' ) {
	return $GLOBALS['hoc_test_home'] . $path;
}
function site_url( $path = '' ) {
	return $GLOBALS['hoc_test_home'] . $path;
}
function trailingslashit( $value ) {
	return rtrim( $value, '/\\' ) . '/';
}
function untrailingslashit( $value ) {
	return rtrim( $value, '/\\' );
}
function apply_filters( $hook, $value, ...$args ) {
	if ( isset( $GLOBALS['hoc_test_filters'][ $hook ] ) ) {
		return call_user_func( $GLOBALS['hoc_test_filters'][ $hook ], $value, ...$args );
	}
	return $value;
}

require_once dirname( __DIR__ ) . '/includes/class-hoc-site-loader.php';
require_once dirname( __DIR__ ) . '/includes/class-hoc-site.php';

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
 * @param string $method Private static method of HOC_Site.
 * @param array  $args   Arguments.
 * @return mixed
 */
function site_private( $method, array $args = array() ) {
	$reflected = new ReflectionMethod( 'HOC_Site', $method );
	$reflected->setAccessible( true );
	return $reflected->invokeArgs( null, $args );
}

echo "mysql_dsn\n";
ok( 'plain host', 'mysql:host=db.internal;dbname=wp;charset=utf8mb4' === HOC_Site_Loader::mysql_dsn( 'db.internal', 'wp' ) );
ok( 'host and port', 'mysql:host=db.internal;port=3307;dbname=wp;charset=utf8mb4' === HOC_Site_Loader::mysql_dsn( 'db.internal:3307', 'wp' ) );
ok( 'socket only', 'mysql:unix_socket=/var/run/mysqld/mysqld.sock;dbname=wp;charset=utf8mb4' === HOC_Site_Loader::mysql_dsn( ':/var/run/mysqld/mysqld.sock', 'wp' ) );
ok( 'host and socket', 'mysql:unix_socket=/tmp/my.sock;dbname=wp;charset=utf8mb4' === HOC_Site_Loader::mysql_dsn( 'localhost:/tmp/my.sock', 'wp' ) );
ok( 'ipv6 with port', 'mysql:host=::1;port=3306;dbname=wp;charset=utf8mb4' === HOC_Site_Loader::mysql_dsn( '[::1]:3306', 'wp' ) );
ok( 'empty host is localhost', 'mysql:host=localhost;dbname=wp;charset=utf8mb4' === HOC_Site_Loader::mysql_dsn( '', 'wp' ) );
ok( 'utf8 is widened to utf8mb4', false !== strpos( HOC_Site_Loader::mysql_dsn( 'h', 'wp', 'utf8' ), 'charset=utf8mb4' ) );
ok( 'latin1 is kept', false !== strpos( HOC_Site_Loader::mysql_dsn( 'h', 'wp', 'latin1' ), 'charset=latin1' ) );
ok( 'non-numeric port is ignored, not injected', 'mysql:host=h;dbname=wp;charset=utf8mb4' === HOC_Site_Loader::mysql_dsn( 'h:12;x=1', 'wp' ) );

echo "site_prefix\n";
ok( 'sub-directory install', '/blog/hoc/' === HOC_Site::site_prefix() );
$GLOBALS['hoc_test_home'] = 'https://example.com';
ok( 'root install', '/hoc/' === HOC_Site::site_prefix() );

echo "cross-site writes\n";
$GLOBALS['hoc_test_home'] = 'https://example.com';
/**
 * @param array<string,string> $server Server vars for one request.
 * @return bool
 */
function cross_site( array $server ) {
	$_SERVER = $server;
	return site_private( 'is_cross_site_write' );
}
ok( 'same-origin Origin is allowed', false === cross_site( array( 'HTTP_ORIGIN' => 'https://example.com' ) ) );
ok( 'Origin case is normalised', false === cross_site( array( 'HTTP_ORIGIN' => 'https://EXAMPLE.com' ) ) );
ok( 'other site is refused', true === cross_site( array( 'HTTP_ORIGIN' => 'https://evil.example' ) ) );
ok( 'other scheme is refused', true === cross_site( array( 'HTTP_ORIGIN' => 'http://example.com' ) ) );
ok( 'other port is refused', true === cross_site( array( 'HTTP_ORIGIN' => 'https://example.com:8443' ) ) );
ok( 'sub-domain is refused', true === cross_site( array( 'HTTP_ORIGIN' => 'https://evil.example.com' ) ) );
ok( 'Origin: null is refused', true === cross_site( array( 'HTTP_ORIGIN' => 'null' ) ) );
ok( 'no Origin, no Fetch Metadata (curl, tests) is allowed', false === cross_site( array() ) );
ok( 'no Origin, Sec-Fetch-Site cross-site is refused', true === cross_site( array( 'HTTP_SEC_FETCH_SITE' => 'cross-site' ) ) );
ok( 'no Origin, Sec-Fetch-Site same-origin is allowed', false === cross_site( array( 'HTTP_SEC_FETCH_SITE' => 'same-origin' ) ) );
$GLOBALS['hoc_test_filters']['hoc_site_allowed_origins'] = function ( $origins ) {
	$origins[] = 'https://app.example.com';
	return $origins;
};
ok( 'a filtered-in origin is allowed', false === cross_site( array( 'HTTP_ORIGIN' => 'https://app.example.com' ) ) );
ok( 'others are still refused after the filter', true === cross_site( array( 'HTTP_ORIGIN' => 'https://evil.example' ) ) );
$GLOBALS['hoc_test_filters'] = array();

echo "identity overrides\n";
$GLOBALS['hoc_test_filters']['hoc_site_current_user'] = function () {
	return null;
};
ok( 'a null override signs everyone out', null === HOC_Site::current_user() );
$GLOBALS['hoc_test_filters']['hoc_site_current_user'] = function () {
	return array( 'id' => 'u1', 'name' => 'U One' );
};
ok( 'an array override signs that user in', 'u1' === HOC_Site::current_user()['id'] );
$GLOBALS['hoc_test_filters']['hoc_site_is_admin'] = function () {
	return true;
};
ok( 'is_admin override wins', true === HOC_Site::is_admin( array( 'id' => 'u1' ) ) );
$GLOBALS['hoc_test_filters']['hoc_site_is_admin'] = function () {
	return false;
};
ok( 'is_admin override can deny', false === HOC_Site::is_admin( array( 'id' => '1' ) ) );
$GLOBALS['hoc_test_filters']['hoc_site_find_users'] = function () {
	return array( array( 'id' => 'x', 'name' => 'X' ) );
};
ok( 'find_users override wins', 'x' === HOC_Site::find_users( 'q' )[0]['id'] );
$GLOBALS['hoc_test_filters']['hoc_site_user_exists'] = function () {
	return true;
};
ok( 'user_exists override wins', true === HOC_Site::user_exists( 'anything' ) );

echo "\n$tests tests, $failed failed\n";
exit( $failed > 0 ? 1 : 0 );
