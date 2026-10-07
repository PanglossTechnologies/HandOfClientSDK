<?php
/**
 * Plugin Name:       HandOfClient
 * Plugin URI:        https://github.com/PanglossTechnologies/HandOfClientSDK
 * Description:       Mounts versioned, sandboxed HandOfClient plugins into this site, and exposes a capability-checked read/write API for them to use.
 * Version:           0.1.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            HandOfClient
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       handofclient
 *
 * @package HandOfClient
 */

/**
 * This plugin is a HOST ADAPTER, not a code generator. It is fixed code, shipped and updated through
 * the normal plugin channel; customer features arrive as data (activations pointing at
 * platform-hosted bundles), never as new PHP written onto this site.
 *
 * That distinction is the whole security model. PHP has no usable in-process sandbox - a static
 * scanner is defeated by `$f = 'ex' . 'ec'; $f($cmd);` - so generated PHP running with $wpdb in
 * scope would be unsanctioned root on the customer's site, with no rollback and a single fatal
 * between it and a white screen. Everything a feature can do here goes through one of exactly three
 * doors, all of them in this plugin's own fixed code:
 *
 *   1. An iframe on the platform's embed origin (bundle JS, sandboxed by the browser and by the
 *      CSP the platform serves with the bundle).
 *   2. Class_HOC_Query_Catalog / Class_HOC_Command_Catalog - named, parameterised, capability-checked
 *      reads and writes. Never free-form SQL, never $wpdb from a feature.
 *   3. The platform's EgressProxy, for outbound calls to third-party APIs.
 */

defined( 'ABSPATH' ) || exit;

define( 'HOC_VERSION', '0.1.0' );
define( 'HOC_PLUGIN_FILE', __FILE__ );
define( 'HOC_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );
define( 'HOC_PLUGIN_URL', plugin_dir_url( __FILE__ ) );

/** REST namespace for everything this plugin exposes. */
define( 'HOC_REST_NAMESPACE', 'hoc/v1' );

require_once HOC_PLUGIN_DIR . 'includes/class-hoc-options.php';
require_once HOC_PLUGIN_DIR . 'includes/class-hoc-safe-mode.php';
require_once HOC_PLUGIN_DIR . 'includes/class-hoc-platform-client.php';
require_once HOC_PLUGIN_DIR . 'includes/class-hoc-jwt.php';
require_once HOC_PLUGIN_DIR . 'includes/class-hoc-query-catalog.php';
require_once HOC_PLUGIN_DIR . 'includes/class-hoc-command-catalog.php';
require_once HOC_PLUGIN_DIR . 'includes/class-hoc-rest.php';
require_once HOC_PLUGIN_DIR . 'includes/class-hoc-mounts.php';
require_once HOC_PLUGIN_DIR . 'includes/class-hoc-hooks.php';
require_once HOC_PLUGIN_DIR . 'includes/class-hoc-admin.php';
require_once HOC_PLUGIN_DIR . 'includes/class-hoc-customization.php';

/**
 * Boots the plugin.
 *
 * Everything is registered on `plugins_loaded` rather than at file scope so that a site can hard-
 * disable the whole adapter (kill switch, or the safe-mode circuit breaker having tripped) without
 * any of its hooks ever being attached. Nothing here performs network I/O - see
 * HOC_Mounts::get_mounted_slots() for why slot discovery is cached and never blocks a page load.
 *
 * @return void
 */
function hoc_bootstrap() {
	// The admin screen must load even when the adapter is off, or there would be no way to turn it
	// back on. It is the one piece that is never gated by the kill switch or the breaker.
	( new HOC_Admin() )->register();

	if ( ! HOC_Options::is_enabled() ) {
		return;
	}

	if ( HOC_Safe_Mode::is_tripped() ) {
		HOC_Safe_Mode::register_notice();
		return;
	}

	( new HOC_REST() )->register();
	( new HOC_Mounts() )->register();
	// Last: HOC_Hooks reads the cached slot list HOC_Mounts owns, and attaches only to hooks that
	// have not fired yet by this point (see HOC_Hooks::REFUSED_HOOKS).
	( new HOC_Hooks() )->register();
	// Gated here, not alongside HOC_Admin above: unlike Settings, this page has nothing useful to do
	// until there is a real paired platform connection to submit a request against.
	( new HOC_Customization() )->register();
}
add_action( 'plugins_loaded', 'hoc_bootstrap' );

/**
 * Activation: seed defaults without clobbering settings from a previous install.
 *
 * @return void
 */
function hoc_activate() {
	HOC_Options::seed_defaults();
	HOC_Safe_Mode::reset();
}
register_activation_hook( __FILE__, 'hoc_activate' );

/**
 * Deactivation: drop caches so a re-activation re-reads the platform rather than trusting whatever
 * was cached when the site owner switched the plugin off. Settings are deliberately preserved -
 * uninstall.php is what removes those.
 *
 * @return void
 */
function hoc_deactivate() {
	HOC_Platform_Client::flush_caches();
	HOC_Safe_Mode::reset();
}
register_deactivation_hook( __FILE__, 'hoc_deactivate' );
