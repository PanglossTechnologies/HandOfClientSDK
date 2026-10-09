<?php
/**
 * Plugin Name: HOC Conformance Profile
 * Description: TEST CONFIGURATION ONLY. Gives the HandOfClient plugin the fixed roster, cookie identity and
 *              keys the language-neutral host-module conformance suite expects
 *              (host-modules/conformance/README.md). The runner (run-conformance.mjs) copies this file into
 *              mu-plugins for the duration of a run and removes it again; it does nothing unless
 *              HOC_WP_CONFORMANCE is set in the environment.
 */

defined( 'ABSPATH' ) || exit;

if ( ! getenv( 'HOC_WP_CONFORMANCE' ) ) {
	return;
}

/**
 * @param string $name    Variable.
 * @param string $default Default.
 * @return string
 */
function hoc_conformance_env( $name, $default ) {
	$value = getenv( $name );
	return false === $value || '' === $value ? $default : $value;
}

/** @return array<string,array{id:string,name:string}> */
function hoc_conformance_roster() {
	return array(
		'admin'               => array( 'id' => 'admin', 'name' => 'Ada Admin' ),
		'alice'               => array( 'id' => 'alice', 'name' => 'Alice Owner' ),
		'bob'                 => array( 'id' => 'bob', 'name' => 'Bob Builder' ),
		'carol'               => array( 'id' => 'carol', 'name' => 'Carol Customer' ),
		'dave'                => array( 'id' => 'dave', 'name' => 'Dave Dev' ),
		'erin+qa@example.com' => array( 'id' => 'erin+qa@example.com', 'name' => 'Erin Special' ),
	);
}

// Pairing and keys come from the profile, not from the database.
add_filter(
	'pre_option_hoc_settings',
	function () {
		return array_merge(
			HOC_Options::defaults(),
			array(
				'enabled'           => true,
				'platform_base_url' => 'http://127.0.0.1:' . hoc_conformance_env( 'HOC_CONFORMANCE_PLATFORM_PORT', '4010' ),
				'host_id'           => hoc_conformance_env( 'HOC_CONFORMANCE_HOST_ID', 'conformance' ),
				'api_key'           => hoc_conformance_env( 'HOC_CONFORMANCE_API_KEY', 'conformance-host-api-key' ),
				'tenant_id'         => hoc_conformance_env( 'HOC_CONFORMANCE_TENANT_ID', 'conformance-tenant' ),
				'webhook_secret'    => hoc_conformance_env( 'HOC_CONFORMANCE_WEBHOOK_SECRET', 'whsec_conformance' ),
			)
		);
	}
);

add_filter(
	'hoc_site_current_user',
	function () {
		$id     = isset( $_COOKIE['hoc_user'] ) ? (string) wp_unslash( $_COOKIE['hoc_user'] ) : '';
		$roster = hoc_conformance_roster();
		return '' !== $id && isset( $roster[ $id ] ) ? $roster[ $id ] : null;
	}
);

add_filter(
	'hoc_site_is_admin',
	function ( $unused, $user ) {
		return isset( $user['id'] ) && 'admin' === $user['id'];
	},
	10,
	2
);

add_filter(
	'hoc_site_find_users',
	function ( $unused, $query ) {
		$needle = mb_strtolower( (string) $query );
		return array_values(
			array_filter(
				hoc_conformance_roster(),
				function ( $user ) use ( $needle ) {
					return false !== mb_strpos( mb_strtolower( $user['id'] ), $needle ) || false !== mb_strpos( mb_strtolower( $user['name'] ), $needle );
				}
			)
		);
	},
	10,
	2
);

add_filter(
	'hoc_site_user_exists',
	function ( $unused, $user_id ) {
		return isset( hoc_conformance_roster()[ (string) $user_id ] );
	},
	10,
	2
);
