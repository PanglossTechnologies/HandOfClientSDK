/**
 * When the request box sends a request, refresh any "my features" list on the same page so the new request
 * shows up without a reload. The browser components fire a bubbling `hoc-request-submitted` event.
 */
( function () {
	'use strict';

	document.addEventListener( 'hoc-request-submitted', function () {
		var lists = document.querySelectorAll( 'hoc-my-features' );
		for ( var i = 0; i < lists.length; i++ ) {
			if ( typeof lists[ i ].refresh === 'function' ) {
				lists[ i ].refresh();
			}
		}
	} );
}() );
