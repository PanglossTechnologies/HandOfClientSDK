/**
 * The generic "HandOfClient panel" block.
 *
 * One block for every panel slot, not one block per feature: the slot is an attribute, so activating
 * a new package on the platform makes it selectable here with no new JS and no plugin release.
 *
 * A dynamic block - the server renders it (HOC_Mounts::render_block). The editor therefore shows a
 * placeholder rather than a live iframe, which is deliberate: mounting a real plugin inside the block
 * editor would let it fight with the editor's own DOM, and a slot deactivated on the platform would
 * leave stale saved markup behind.
 */
( function ( blocks, element, blockEditor, components ) {
	'use strict';

	var el = element.createElement;
	var useBlockProps = blockEditor.useBlockProps;
	var InspectorControls = blockEditor.InspectorControls;
	var PanelBody = components.PanelBody;
	var SelectControl = components.SelectControl;

	var slots = ( window.HOC_BLOCK_DATA && window.HOC_BLOCK_DATA.slots ) || [];

	var options = [ { value: '', label: 'Select a plugin panel...' } ].concat( slots );

	blocks.registerBlockType( 'handofclient/panel', {
		title: 'HandOfClient panel',
		icon: 'screenoptions',
		category: 'widgets',
		attributes: {
			slotId: { type: 'string', default: '' }
		},

		edit: function ( props ) {
			var slotId = props.attributes.slotId;

			var selected = slots.filter( function ( slot ) {
				return slot.value === slotId;
			} )[ 0 ];

			var label;
			if ( ! slotId ) {
				label = 'HandOfClient: choose a panel in the block settings.';
			} else if ( selected ) {
				label = 'HandOfClient panel: ' + selected.label;
			} else {
				// The saved slot is no longer activated. Saying so beats rendering an empty box that
				// looks like the block is broken.
				label = 'HandOfClient panel "' + slotId + '" is not currently activated for this site.';
			}

			return el(
				'div',
				useBlockProps( { style: { padding: '12px', border: '1px dashed #949494', borderRadius: '4px' } } ),
				el(
					InspectorControls,
					{},
					el(
						PanelBody,
						{ title: 'Panel' },
						el( SelectControl, {
							label: 'Plugin panel',
							value: slotId,
							options: options,
							onChange: function ( value ) {
								props.setAttributes( { slotId: value } );
							}
						} )
					)
				),
				label
			);
		},

		// Rendered by PHP - see the render_callback in HOC_Mounts.
		save: function () {
			return null;
		}
	} );
} )( window.wp.blocks, window.wp.element, window.wp.blockEditor, window.wp.components );
