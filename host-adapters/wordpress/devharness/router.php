<?php
/**
 * Router for PHP's built-in server so WordPress pretty permalinks (and therefore
 * /wp-json/ REST routes) resolve the same way they do under Apache/nginx.
 *
 * chr(92) is a literal backslash: DOCUMENT_ROOT is a Windows path here, and writing
 * the escape inline is a known way to get a silently unterminated string.
 */
$root = rtrim( $_SERVER['DOCUMENT_ROOT'], '/' . chr( 92 ) );
$uri  = parse_url( $_SERVER['REQUEST_URI'], PHP_URL_PATH );

// Real file on disk - let the built-in server stream it.
if ( '/' !== $uri && file_exists( $root . $uri ) && ! is_dir( $root . $uri ) ) {
	return false;
}
// Directory holding its own index - same.
if ( is_dir( $root . $uri ) ) {
	foreach ( array( 'index.php', 'index.html' ) as $index ) {
		if ( file_exists( rtrim( $root . $uri, '/' ) . '/' . $index ) ) {
			return false;
		}
	}
}
// Anything else is a WordPress route.
$_SERVER['SCRIPT_NAME']     = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = $root . '/index.php';
$_SERVER['PHP_SELF']        = '/index.php';
require $root . '/index.php';
