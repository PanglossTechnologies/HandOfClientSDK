<?php
/**
 * Uninstall cleanup.
 *
 * Runs only on delete, never on deactivate - see hoc_deactivate(), which deliberately keeps settings
 * so that switching the plugin off and on again does not require re-pairing.
 *
 * Nothing here touches the platform. Deleting this plugin removes this site's ability to mount
 * plugins; it does not revoke the host, delete activations, or delete stored credentials, because a
 * site being deleted or rebuilt is not a decision to destroy the tenant's data on a system this
 * plugin does not own. Those are removed from the platform's own admin.
 *
 * @package HandOfClient
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

delete_option( 'hoc_settings' );
delete_option( 'hoc_safe_mode_tripped' );
delete_option( 'hoc_failure_count' );

delete_transient( 'hoc_mounted_slots' );
delete_transient( 'hoc_jwks' );
delete_transient( 'hoc_jwks_refetch_lock' );
delete_transient( 'hoc_inflight_render' );

global $wpdb;

// Platform response and idempotency caches are per-key transients with generated names, so they have
// to be swept by prefix rather than deleted individually.
foreach ( array( 'hoc_pf_', 'hoc_idem_' ) as $prefix ) {
	// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.NotPrepared
	$names = $wpdb->get_col(
		$wpdb->prepare(
			"SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s OR option_name LIKE %s",
			$wpdb->esc_like( '_transient_' . $prefix ) . '%',
			$wpdb->esc_like( '_transient_timeout_' . $prefix ) . '%'
		)
	);

	foreach ( (array) $names as $name ) {
		delete_option( (string) $name );
	}
}
