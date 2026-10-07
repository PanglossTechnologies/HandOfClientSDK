<?php
/**
 * Plugin Name: HOC Harness Auto-Login
 * Description: LOCAL TEST HARNESS ONLY. Logs in as a named user when ?hoc_harness_login=<secret>
 *              is present, so browser automation can exercise real authenticated admin screens
 *              without driving the login form. Never part of the shipped plugin; lives only in
 *              .wp-local, which is gitignored.
 */

defined( 'ABSPATH' ) || exit;

add_action(
	'init',
	function () {
		if ( ! isset( $_GET['hoc_harness_login'] ) ) {
			return;
		}
		// Refuse outright unless this really is the local harness.
		if ( 'local' !== wp_get_environment_type() || 'localhost' !== wp_parse_url( home_url(), PHP_URL_HOST ) ) {
			return;
		}
		if ( ! hash_equals( 'harness-secret-8088', (string) $_GET['hoc_harness_login'] ) ) {
			return;
		}

		$login = isset( $_GET['as'] ) ? sanitize_user( wp_unslash( $_GET['as'] ) ) : 'admin';
		$user  = get_user_by( 'login', $login );
		if ( ! $user ) {
			return;
		}

		wp_set_current_user( $user->ID );
		wp_set_auth_cookie( $user->ID, false );
		do_action( 'wp_login', $user->user_login, $user );

		// setcookie() does not populate $_COOKIE for the CURRENT request, so auth_redirect()
		// would still see an anonymous visitor and bounce to wp-login.php?reauth=1. Redirecting
		// makes the browser replay the request WITH the cookie it was just handed.
		wp_safe_redirect( remove_query_arg( array( 'hoc_harness_login', 'as' ) ) );
		exit;
	},
	1
);
