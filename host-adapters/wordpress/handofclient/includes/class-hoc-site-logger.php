<?php
/**
 * PSR-3 logger for the bundled host module.
 *
 * Only ever included after HOC_Site_Loader::register(), because it extends a psr/log class.
 *
 * @package HandOfClient
 */

defined( 'ABSPATH' ) || exit;

/**
 * Warnings and above go to PHP's error log (with the exception and every inner exception); everything
 * goes to the `hoc_site_log` action so a site can route it elsewhere. Info lines (one per request-loop
 * call, with the user id) are written to the error log too when WP_DEBUG is on.
 */
class HOC_Site_Logger extends \Psr\Log\AbstractLogger {

	/**
	 * @param mixed                $level   PSR-3 level.
	 * @param string|\Stringable   $message Message with {placeholders}.
	 * @param array<string,mixed>  $context Context; `exception` is a Throwable.
	 * @return void
	 */
	public function log( $level, $message, array $context = array() ): void {
		$replace = array();
		foreach ( $context as $key => $value ) {
			if ( is_scalar( $value ) || null === $value ) {
				$replace[ '{' . $key . '}' ] = (string) $value;
			}
		}
		$line = 'handofclient.' . $level . ': ' . strtr( (string) $message, $replace );
		if ( isset( $context['exception'] ) && $context['exception'] instanceof \Throwable ) {
			$line .= "\n" . $context['exception']; // __toString includes the previous chain.
		}

		/**
		 * Fires for every log line of the request loop.
		 *
		 * @param string $level   PSR-3 level.
		 * @param string $line    Formatted line.
		 * @param array  $context Raw context.
		 */
		do_action( 'hoc_site_log', (string) $level, $line, $context );

		$loud = in_array( $level, array( 'warning', 'error', 'critical', 'alert', 'emergency' ), true );
		if ( $loud || ( defined( 'WP_DEBUG' ) && WP_DEBUG ) ) {
			// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
			error_log( $line );
		}
	}
}
