/**
 * Opens and closes the request dock (see HOC_Site::print_dock()). The components inside it are
 * embed.js custom elements; this file only toggles visibility.
 */
( function () {
	'use strict';

	function init() {
		var dock = document.getElementById( 'hoc-dock' );
		if ( ! dock ) {
			return;
		}
		var toggle = dock.querySelector( '.hoc-dock__toggle' );
		var panel = document.getElementById( 'hoc-dock-panel' );
		if ( ! toggle || ! panel ) {
			return;
		}

		function setOpen( open ) {
			panel.hidden = ! open;
			toggle.setAttribute( 'aria-expanded', open ? 'true' : 'false' );
		}

		toggle.addEventListener( 'click', function () {
			setOpen( panel.hidden );
		} );
		document.addEventListener( 'keydown', function ( event ) {
			if ( 'Escape' === event.key && ! panel.hidden ) {
				setOpen( false );
				toggle.focus();
			}
		} );
	}

	if ( 'loading' === document.readyState ) {
		document.addEventListener( 'DOMContentLoaded', init );
	} else {
		init();
	}
}() );
