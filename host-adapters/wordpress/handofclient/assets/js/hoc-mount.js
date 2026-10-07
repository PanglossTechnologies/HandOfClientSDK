/**
 * Mounts every HandOfClient slot queued on the page.
 *
 * HOC_Mounts pushes one config object per rendered slot into window.HOC_MOUNTS before this script
 * runs. Everything this file does is spelled out in docs/postmessage-protocol.md - it is deliberately
 * a thin wrapper over HandOfClient.mount() rather than a framework.
 */
( function () {
	'use strict';

	var configured = false;

	/**
	 * The error text a site owner can actually act on. embed.js's own messages name the protocol
	 * failure ("token-fetch-failed"), which is right for a log and useless in a page.
	 */
	function describe( error ) {
		var reason = ( error && error.reason ) || 'unknown';

		switch ( reason ) {
			case 'token-fetch-failed':
				// Overwhelmingly the expired-nonce case: WordPress nonces last about a day, and this
				// page has been open longer than that. A reload mints a fresh one.
				return 'Could not start this feature. Your session may have expired - reload the page to try again.';
			case 'no-active-version':
				return 'This feature is not activated for this site.';
			case 'iframe-load-failed':
				return 'This feature could not be loaded from the platform.';
			case 'timeout':
				return 'This feature did not finish loading.';
			case 'plugin-error':
				return 'This feature reported an error while starting up.';
			default:
				return 'This feature could not be displayed.';
		}
	}

	function showError( container, error ) {
		var box = document.createElement( 'div' );
		box.className = 'hoc-slot-error';
		box.style.cssText = 'padding:12px;border:1px solid #dba617;background:#fcf9e8;border-radius:4px;';
		box.textContent = describe( error );
		container.appendChild( box );

		// The actionable message goes in the page; the diagnostic detail goes to the console, where
		// someone debugging will look for it.
		if ( window.console && window.console.error ) {
			window.console.error( '[HandOfClient] mount failed', error );
		}
	}

	function mountOne( config ) {
		var container = document.getElementById( config.domId );
		if ( ! container ) {
			return;
		}

		if ( typeof window.HandOfClient === 'undefined' ) {
			showError( container, { reason: 'iframe-load-failed', message: 'embed.js did not load' } );
			return;
		}

		// configure() is global to the page, and every slot on a page shares one platform, so the
		// first mount settles it for all of them.
		if ( ! configured ) {
			window.HandOfClient.configure( {
				apiBaseUrl: config.apiBaseUrl,
				embedOrigin: config.embedOrigin
			} );
			configured = true;
		}

		window.HandOfClient.mount( container, {
			hostId: config.hostId,
			tenantId: config.tenantId,
			packageId: config.packageId,
			slotId: config.slotId,
			tokenUrl: config.tokenUrl,
			theme: config.theme,
			locale: config.locale,
			launchParams: config.launchParams || {},
			onError: function ( error ) {
				showError( container, error );
			}
		} ).catch( function ( error ) {
			showError( container, error );
		} );
	}

	function mountAll() {
		var mounts = window.HOC_MOUNTS || [];
		for ( var i = 0; i < mounts.length; i++ ) {
			mountOne( mounts[ i ] );
		}
	}

	if ( 'loading' === document.readyState ) {
		document.addEventListener( 'DOMContentLoaded', mountAll );
	} else {
		mountAll();
	}
} )();
