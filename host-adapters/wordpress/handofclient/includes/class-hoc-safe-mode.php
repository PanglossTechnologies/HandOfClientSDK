<?php
/**
 * Circuit breaker.
 *
 * @package HandOfClient
 */

defined( 'ABSPATH' ) || exit;

/**
 * Stops a repeatedly-failing mount from taking the site down with it.
 *
 * WordPress 5.2+ has its own fatal-error recovery (it deactivates the offending plugin and emails
 * the admin), but that is a blunt, whole-plugin instrument and it does not fire for every failure
 * class - a PHP notice storm, a memory exhaustion inside one render, or a plugin whose iframe simply
 * never loads all leave the site technically "working" and visibly broken.
 *
 * The guarantee here is narrower and more useful: ONE bad slot degrades to an inline error message,
 * and if slot rendering keeps dying hard, the adapter stops mounting anything at all rather than
 * repeating the failure on every page view. The admin screen always stays reachable so the site
 * owner can see what happened and switch it back on - see hoc_bootstrap().
 */
class HOC_Safe_Mode {

	/** Marks a render that started but never finished - set before, deleted after. */
	const INFLIGHT_KEY = 'hoc_inflight_render';

	/** Consecutive hard failures. */
	const FAILURE_KEY = 'hoc_failure_count';

	/** Set once the breaker opens. */
	const TRIPPED_KEY = 'hoc_safe_mode_tripped';

	/** Failures before the breaker opens. Two is a coincidence; three is a pattern. */
	const FAILURE_THRESHOLD = 3;

	/**
	 * @return bool
	 */
	public static function is_tripped() {
		return (bool) get_option( self::TRIPPED_KEY, false );
	}

	/**
	 * Clears the breaker and its counters.
	 *
	 * @return void
	 */
	public static function reset() {
		delete_option( self::TRIPPED_KEY );
		delete_option( self::FAILURE_KEY );
		delete_transient( self::INFLIGHT_KEY );
	}

	/**
	 * Runs a slot render inside the breaker.
	 *
	 * Two failure modes are covered, and they need different machinery:
	 *
	 *  - A thrown Throwable (including a TypeError from bad plugin data) is caught here, counted, and
	 *    turned into an inline message. The rest of the page still renders.
	 *  - A true fatal - memory exhaustion, a timeout - unwinds past every catch block. Nothing can
	 *    catch it, so instead a marker is written BEFORE the render and deleted after; a marker still
	 *    present on the next request is proof the previous one died inside a render.
	 *
	 * @param string   $context  Human-readable identifier, recorded for the admin notice.
	 * @param callable $callback Render callback. Its return value is passed through.
	 * @return string Rendered HTML, or an inline error message.
	 */
	public static function guard( $context, callable $callback ) {
		self::detect_previous_fatal();

		if ( self::is_tripped() ) {
			return self::inline_error( __( 'This feature is temporarily disabled.', 'handofclient' ) );
		}

		set_transient( self::INFLIGHT_KEY, $context, 60 );

		try {
			$output = $callback();
			delete_transient( self::INFLIGHT_KEY );
			self::record_success();
			return $output;
		} catch ( Throwable $e ) {
			delete_transient( self::INFLIGHT_KEY );
			self::record_failure( $context, $e->getMessage() );

			if ( defined( 'WP_DEBUG' ) && WP_DEBUG ) {
				// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
				error_log( sprintf( '[HandOfClient] render failed for %s: %s', $context, $e->getMessage() ) );
			}

			return self::inline_error( __( 'This feature could not be displayed.', 'handofclient' ) );
		}
	}

	/**
	 * A marker left over from a previous request means that request died inside a render.
	 *
	 * @return void
	 */
	private static function detect_previous_fatal() {
		$stale = get_transient( self::INFLIGHT_KEY );
		if ( false === $stale ) {
			return;
		}
		delete_transient( self::INFLIGHT_KEY );
		self::record_failure( is_string( $stale ) ? $stale : 'unknown', 'request ended during render (fatal)' );
	}

	/**
	 * @param string $context Slot identifier.
	 * @param string $reason  Why it failed.
	 * @return void
	 */
	private static function record_failure( $context, $reason ) {
		$count = (int) get_option( self::FAILURE_KEY, 0 ) + 1;
		update_option( self::FAILURE_KEY, $count, false );

		if ( $count >= self::FAILURE_THRESHOLD ) {
			update_option(
				self::TRIPPED_KEY,
				array(
					'context'    => $context,
					'reason'     => $reason,
					'tripped_at' => time(),
				),
				false
			);
		}
	}

	/**
	 * A clean render resets the counter, so three failures spread across a month never accumulate
	 * into a trip. The breaker is for a feature that is broken NOW.
	 *
	 * @return void
	 */
	private static function record_success() {
		if ( 0 !== (int) get_option( self::FAILURE_KEY, 0 ) ) {
			update_option( self::FAILURE_KEY, 0, false );
		}
	}

	/**
	 * @param string $message Message text.
	 * @return string
	 */
	private static function inline_error( $message ) {
		return '<div class="hoc-slot-error" style="padding:12px;border:1px solid #dba617;background:#fcf9e8;border-radius:4px;">'
			. esc_html( $message )
			. '</div>';
	}

	/**
	 * Admin notice shown while the breaker is open.
	 *
	 * @return void
	 */
	public static function register_notice() {
		add_action(
			'admin_notices',
			static function () {
				if ( ! current_user_can( 'manage_options' ) ) {
					return;
				}
				$state   = get_option( self::TRIPPED_KEY, array() );
				$context = is_array( $state ) && isset( $state['context'] ) ? $state['context'] : 'unknown';
				$reason  = is_array( $state ) && isset( $state['reason'] ) ? $state['reason'] : '';

				printf(
					'<div class="notice notice-error"><p><strong>%s</strong> %s</p><p>%s</p><p><a class="button" href="%s">%s</a></p></div>',
					esc_html__( 'HandOfClient is in safe mode.', 'handofclient' ),
					esc_html(
						sprintf(
							/* translators: 1: slot identifier, 2: failure reason */
							__( 'Rendering "%1$s" failed repeatedly (%2$s), so no plugins are being mounted.', 'handofclient' ),
							$context,
							$reason
						)
					),
					esc_html__( 'The rest of this site is unaffected. Fix or deactivate the offending package on the platform, then clear safe mode.', 'handofclient' ),
					esc_url( admin_url( 'admin.php?page=hoc-root&hoc_action=clear_safe_mode&_wpnonce=' . wp_create_nonce( 'hoc_clear_safe_mode' ) ) ),
					esc_html__( 'Clear safe mode', 'handofclient' )
				);
			}
		);
	}
}
