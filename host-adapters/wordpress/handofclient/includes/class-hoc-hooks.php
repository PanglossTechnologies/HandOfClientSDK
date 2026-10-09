<?php
/**
 * The PHP hook bridge: lets an activated package react to WordPress events without shipping any PHP
 * onto this site.
 *
 * The design turns entirely on one asymmetry in WordPress itself, and the code is arranged so that
 * asymmetry cannot be quietly ignored:
 *
 *   An ACTION is fire-and-forget. WordPress discards whatever the callback returns, so this bridge
 *   may hand the event to the platform without waiting - and does, non-blocking, so a third party's
 *   latency never lands in a visitor's page load.
 *
 *   A FILTER must return a value, synchronously, while WordPress is blocked mid-computation. No
 *   webhook can do that. A round trip would either stall every affected page load on a remote
 *   server, or - worse - have to invent a return value when it times out, silently corrupting the
 *   very content the filter exists to shape. So filters never touch the network at all: they carry
 *   a small declarative transform (append/prepend/replace/const) evaluated right here, in-process.
 *
 * Anything a transform cannot express is refused at publish time by the publisher CLI, not degraded
 * into "an action that looks like a filter". See docs/wordpress-host.md and the HookDecl comment in
 * proto/handofclient/v1/package_registry.proto.
 *
 * @package HandOfClient
 */

defined( 'ABSPATH' ) || exit;

/**
 * Registers manifest-declared hooks against WordPress.
 */
class HOC_Hooks {

	/**
	 * Hard ceiling on one dispatched payload. A WordPress action argument is frequently a whole post
	 * body, and an unbounded payload turns a busy site into an outbound flood.
	 */
	const MAX_PAYLOAD_BYTES = 32768;

	/** Longest string sent for a single argument. */
	const MAX_ARG_CHARS = 4096;

	/**
	 * Hooks this bridge must never register, whatever a manifest asks for.
	 *
	 * These fire on every request during bootstrap, before or around the point where the plugin
	 * itself is loaded. Attaching an outbound HTTP call to one is a way to make a site unbootable,
	 * and a package should not be able to do that to a customer by typo.
	 */
	const REFUSED_HOOKS = array(
		'muplugins_loaded',
		'plugins_loaded',
		'setup_theme',
		'after_setup_theme',
		'init',
		'wp_loaded',
		'shutdown',
		'all',
	);

	/**
	 * @return void
	 */
	public function register() {
		foreach ( HOC_Mounts::get_mounted_slots() as $slot ) {
			foreach ( $this->hooks_for_slot( $slot ) as $decl ) {
				$this->register_one( $slot, $decl );
			}
		}
	}

	/**
	 * @param array<string,mixed> $slot Slot descriptor from HOC_Mounts.
	 * @return array<int,array<string,mixed>>
	 */
	private function hooks_for_slot( array $slot ) {
		return ( isset( $slot['hooks'] ) && is_array( $slot['hooks'] ) ) ? $slot['hooks'] : array();
	}

	/**
	 * @param array<string,mixed> $slot Slot descriptor.
	 * @param array<string,mixed> $decl One HookDecl, as proto-JSON.
	 * @return void
	 */
	private function register_one( array $slot, array $decl ) {
		$hook = isset( $decl['hook'] ) ? (string) $decl['hook'] : '';
		$kind = isset( $decl['kind'] ) ? (string) $decl['kind'] : '';

		if ( '' === $hook || in_array( $hook, self::REFUSED_HOOKS, true ) ) {
			return;
		}

		// 0 means "unset" over the wire; WordPress's own defaults are 10 and 1.
		$priority       = ( isset( $decl['priority'] ) && (int) $decl['priority'] > 0 ) ? (int) $decl['priority'] : 10;
		$accepted_args  = ( isset( $decl['acceptedArgs'] ) && (int) $decl['acceptedArgs'] > 0 ) ? (int) $decl['acceptedArgs'] : 1;

		if ( 'HOOK_KIND_ACTION' === $kind ) {
			add_action(
				$hook,
				function () use ( $slot, $decl, $hook ) {
					$this->dispatch_action( $slot, $decl, $hook, func_get_args() );
				},
				$priority,
				$accepted_args
			);
			return;
		}

		if ( 'HOOK_KIND_FILTER' === $kind ) {
			add_filter(
				$hook,
				function ( $value ) use ( $decl ) {
					return $this->apply_transform( $value, isset( $decl['transform'] ) ? $decl['transform'] : array() );
				},
				$priority,
				$accepted_args
			);
		}
	}

	// ---- Actions -----------------------------------------------------------------------------

	/**
	 * Sends one action event to the platform, which relays it to the destination the package
	 * declared. This site never learns that destination and never posts to it directly: the URL is
	 * resolved platform-side so a compromised site cannot redirect hook events.
	 *
	 * @param array<string,mixed> $slot Slot descriptor.
	 * @param array<string,mixed> $decl HookDecl.
	 * @param string              $hook Hook name.
	 * @param array<int,mixed>    $args Positional hook arguments.
	 * @return void
	 */
	private function dispatch_action( array $slot, array $decl, $hook, array $args ) {
		$indexes = ( isset( $decl['argIndexes'] ) && is_array( $decl['argIndexes'] ) ) ? $decl['argIndexes'] : array();

		$payload = array();
		foreach ( $indexes as $index ) {
			$index     = (int) $index;
			$payload[] = array_key_exists( $index, $args ) ? $this->reduce_arg( $args[ $index ] ) : null;
		}

		$body = array(
			'tenantId'  => HOC_Options::get_tenant_id(),
			'packageId' => isset( $slot['packageId'] ) ? (string) $slot['packageId'] : '',
			'slotId'    => isset( $slot['slotId'] ) ? (string) $slot['slotId'] : '',
			'hook'      => (string) $hook,
			'args'      => $payload,
		);

		$encoded = wp_json_encode( $body );
		if ( is_string( $encoded ) && strlen( $encoded ) > self::MAX_PAYLOAD_BYTES ) {
			// Drop the arguments rather than the event: "it fired" is the part a webhook consumer
			// cannot reconstruct, and a silently truncated argument list is worse than an explicit
			// marker saying the payload was too big.
			$body['args']      = array();
			$body['truncated'] = true;
		}

		$result = ( new HOC_Platform_Client() )->post_fire_and_forget( '/hook-event', $body );
		if ( is_wp_error( $result ) ) {
			// Logged, never surfaced and deliberately NOT counted against HOC_Safe_Mode: that breaker
			// exists to stop a render from killing pages, and an undelivered background event is a
			// different failure with a different remedy. Tripping it here would let an unreachable
			// webhook disable a site's working, visible plugins.
			if ( defined( 'WP_DEBUG' ) && WP_DEBUG ) {
				error_log( sprintf( // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
					'[HandOfClient] hook "%s" relay failed: %s',
					$hook,
					$result->get_error_message()
				) );
			}
		}
	}

	/**
	 * Reduces one hook argument to something safe to send off-site.
	 *
	 * WordPress hands actions live objects - a whole WP_Post, WP_User, WP_Comment - routinely
	 * carrying content, email addresses and hashed passwords. Serialising those by default would
	 * make an innocuous-looking `save_post` declaration into a content exfiltration channel, so
	 * anything that is not a scalar is reduced to its type name and nothing else.
	 *
	 * @param mixed $value Raw hook argument.
	 * @return scalar|null
	 */
	private function reduce_arg( $value ) {
		if ( is_scalar( $value ) || null === $value ) {
			return is_string( $value ) ? $this->clamp( $value ) : $value;
		}
		return is_object( $value ) ? '[object ' . get_class( $value ) . ']' : '[' . gettype( $value ) . ']';
	}

	/**
	 * @param string $text Text to clamp.
	 * @return string
	 */
	private function clamp( $text ) {
		return ( strlen( $text ) > self::MAX_ARG_CHARS )
			? substr( $text, 0, self::MAX_ARG_CHARS ) . '...[truncated]'
			: $text;
	}

	// ---- Filters -----------------------------------------------------------------------------

	/**
	 * Evaluates a declarative transform. No network, no user code, no regular expressions.
	 *
	 * Every branch is total: it returns a value for every input, cannot throw, and cannot fail
	 * partway. A non-string value passes through untouched rather than being coerced - a filter
	 * like `the_posts` hands over an array, and stringifying it to satisfy an "append" declaration
	 * would destroy the page instead of decorating it.
	 *
	 * @param mixed               $value     The value WordPress is filtering.
	 * @param array<string,mixed> $transform FilterTransform, as proto-JSON.
	 * @return mixed
	 */
	private function apply_transform( $value, $transform ) {
		if ( ! is_string( $value ) || ! is_array( $transform ) ) {
			return $value;
		}

		$kind = isset( $transform['kind'] ) ? (string) $transform['kind'] : '';
		$text = isset( $transform['text'] ) ? (string) $transform['text'] : '';

		switch ( $kind ) {
			case 'FILTER_TRANSFORM_KIND_APPEND':
				return $value . $text;

			case 'FILTER_TRANSFORM_KIND_PREPEND':
				return $text . $value;

			case 'FILTER_TRANSFORM_KIND_CONST':
				return $text;

			case 'FILTER_TRANSFORM_KIND_REPLACE':
				$replacements = ( isset( $transform['replacements'] ) && is_array( $transform['replacements'] ) )
					? $transform['replacements']
					: array();
				foreach ( $replacements as $search => $replacement ) {
					if ( '' === (string) $search ) {
						continue;
					}
					// str_replace, never preg_replace: a manifest-supplied pattern is a denial-of-
					// service primitive (catastrophic backtracking) against a value the host is
					// blocked on producing.
					$value = str_replace( (string) $search, (string) $replacement, $value );
				}
				return $value;

			default:
				return $value;
		}
	}
}
