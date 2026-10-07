<?php
/**
 * Named, capability-checked write commands.
 *
 * @package HandOfClient
 */

defined( 'ABSPATH' ) || exit;

/**
 * The write half of the data API. Same three rules as HOC_Query_Catalog (named, parameterised,
 * capability-checked), plus two that only matter for writes:
 *
 *  4. THROUGH WORDPRESS, NEVER SQL. Every command calls wp_insert_post/update_post_meta/etc. so
 *     that hooks fire, caches invalidate, revisions are written, and other plugins observe the
 *     change. A direct UPDATE would be faster and would quietly break every one of those.
 *  5. IDEMPOTENT. A plugin retrying after a network blip must not create a second draft. Commands
 *     accept an idempotency key and replay the first response for a repeat.
 *
 * The catalogue is intentionally tiny. A read is reversible and a write is not, so the bar for
 * adding one is higher: it should be something a plugin genuinely cannot do by asking the user to
 * click a button in WordPress itself.
 */
class HOC_Command_Catalog {

	/** How long a completed command's response is replayable. */
	const IDEMPOTENCY_TTL = DAY_IN_SECONDS;

	const IDEMPOTENCY_PREFIX = 'hoc_idem_';

	/**
	 * Post meta keys a plugin may write.
	 *
	 * An allowlist, not a denylist. Post meta is where plugins and themes keep everything from
	 * layout settings to access control, so "any key except these" would be a way to reconfigure a
	 * site through the back door - and a leading-underscore check is not sufficient, since plenty of
	 * security-relevant meta is stored unprefixed.
	 *
	 * @return array<int,string>
	 */
	public static function allowed_meta_keys() {
		/**
		 * Filters the post meta keys the write API may set.
		 *
		 * @param array<int,string> $keys Allowed meta keys.
		 */
		return apply_filters( 'hoc_allowed_meta_keys', array( 'hoc_note', 'hoc_tag', 'hoc_external_id' ) );
	}

	/**
	 * @return array<string,array<string,mixed>>
	 */
	public static function all() {
		$commands = array(

			'posts.create-draft' => array(
				'capability'  => 'edit_posts',
				'description' => 'Creates a draft post. Never publishes - a plugin should not be able to put content in front of the public without a human step.',
				'handler'     => array( __CLASS__, 'c_posts_create_draft' ),
			),

			'posts.set-meta'     => array(
				'capability'  => 'edit_posts',
				'description' => 'Sets an allowlisted meta key on a post.',
				'handler'     => array( __CLASS__, 'c_posts_set_meta' ),
			),

			'comments.set-status' => array(
				'capability'  => 'moderate_comments',
				'description' => 'Approves, unapproves or spams a comment.',
				'handler'     => array( __CLASS__, 'c_comments_set_status' ),
			),
		);

		/**
		 * Filters the command catalogue.
		 *
		 * @param array<string,array<string,mixed>> $commands Catalogue.
		 */
		return apply_filters( 'hoc_command_catalog', $commands );
	}

	/**
	 * Catalogue metadata for the admin screen - never includes handlers.
	 *
	 * @return array<int,array<string,mixed>>
	 */
	public static function describe() {
		$out = array();
		foreach ( self::all() as $name => $definition ) {
			$out[] = array(
				'name'        => $name,
				'capability'  => $definition['capability'],
				'description' => $definition['description'],
			);
		}
		return $out;
	}

	/**
	 * Runs a named command for the current user.
	 *
	 * @param string              $name            Command name.
	 * @param array<string,mixed> $body            Request body.
	 * @param string              $idempotency_key Client-supplied key, or ''.
	 * @return array<string,mixed>|WP_Error
	 */
	public function run( $name, array $body, $idempotency_key = '' ) {
		$catalog = self::all();

		if ( ! isset( $catalog[ $name ] ) ) {
			return new WP_Error( 'hoc_unknown_command', __( 'No such command.', 'handofclient' ), array( 'status' => 404 ) );
		}

		$definition = $catalog[ $name ];

		if ( ! current_user_can( $definition['capability'] ) ) {
			return new WP_Error(
				'hoc_forbidden',
				sprintf(
					/* translators: %s: WordPress capability name */
					__( 'This command requires the "%s" capability.', 'handofclient' ),
					$definition['capability']
				),
				array( 'status' => 403 )
			);
		}

		// The key is scoped to the user and command as well as the key itself, so one plugin's key
		// can never replay another plugin's - or another user's - result.
		$cache_key = '';
		if ( '' !== $idempotency_key ) {
			$cache_key = self::IDEMPOTENCY_PREFIX . md5( get_current_user_id() . '|' . $name . '|' . $idempotency_key );
			$replayed  = get_transient( $cache_key );
			if ( is_array( $replayed ) ) {
				$replayed['idempotentReplay'] = true;
				return $replayed;
			}
		}

		$result = call_user_func( $definition['handler'], $body );
		if ( is_wp_error( $result ) ) {
			// Failures are deliberately NOT cached: a retry after a transient failure must be allowed
			// to actually retry.
			return $result;
		}

		$response = array(
			'command'          => $name,
			'result'           => $result,
			'idempotentReplay' => false,
		);

		if ( '' !== $cache_key ) {
			set_transient( $cache_key, $response, self::IDEMPOTENCY_TTL );
		}

		return $response;
	}

	// ---- handlers ---------------------------------------------------------------------------

	/**
	 * @param array<string,mixed> $body Request body.
	 * @return array<string,mixed>|WP_Error
	 */
	public static function c_posts_create_draft( array $body ) {
		$title = isset( $body['title'] ) ? sanitize_text_field( (string) $body['title'] ) : '';
		if ( '' === $title ) {
			return new WP_Error( 'hoc_bad_param', __( 'title is required.', 'handofclient' ), array( 'status' => 400 ) );
		}

		$post_type = isset( $body['postType'] ) ? sanitize_key( (string) $body['postType'] ) : 'post';
		if ( ! in_array( $post_type, get_post_types( array( 'show_ui' => true ) ), true ) ) {
			return new WP_Error( 'hoc_bad_param', __( 'Unknown post type.', 'handofclient' ), array( 'status' => 400 ) );
		}

		$type_object = get_post_type_object( $post_type );
		if ( ! $type_object || ! current_user_can( $type_object->cap->create_posts ) ) {
			return new WP_Error( 'hoc_forbidden', __( 'You cannot create posts of that type.', 'handofclient' ), array( 'status' => 403 ) );
		}

		$content = isset( $body['content'] ) ? (string) $body['content'] : '';

		$post_id = wp_insert_post(
			array(
				'post_title'   => $title,
				// wp_kses_post, not raw: the content originates in a plugin bundle, which is
				// untrusted input no matter how trustworthy its author. Storing raw HTML here would
				// make this endpoint a stored-XSS vector against every future viewer of the post.
				'post_content' => wp_kses_post( $content ),
				'post_status'  => 'draft',
				'post_type'    => $post_type,
				'post_author'  => get_current_user_id(),
			),
			true
		);

		if ( is_wp_error( $post_id ) ) {
			return $post_id;
		}

		return array(
			'postId'  => (int) $post_id,
			'status'  => 'draft',
			'editUrl' => get_edit_post_link( $post_id, 'raw' ),
		);
	}

	/**
	 * @param array<string,mixed> $body Request body.
	 * @return array<string,mixed>|WP_Error
	 */
	public static function c_posts_set_meta( array $body ) {
		$post_id = isset( $body['postId'] ) ? (int) $body['postId'] : 0;
		$key     = isset( $body['key'] ) ? sanitize_key( (string) $body['key'] ) : '';
		$value   = isset( $body['value'] ) ? (string) $body['value'] : '';

		if ( $post_id <= 0 || '' === $key ) {
			return new WP_Error( 'hoc_bad_param', __( 'postId and key are required.', 'handofclient' ), array( 'status' => 400 ) );
		}

		if ( ! in_array( $key, self::allowed_meta_keys(), true ) ) {
			return new WP_Error( 'hoc_forbidden_meta', __( 'That meta key is not writable through this API.', 'handofclient' ), array( 'status' => 403 ) );
		}

		if ( ! get_post( $post_id ) ) {
			return new WP_Error( 'hoc_not_found', __( 'No such post.', 'handofclient' ), array( 'status' => 404 ) );
		}

		// Per-post, not just the blanket edit_posts checked above: edit_posts means "can edit posts
		// in general", while edit_post means "can edit THIS one" - the difference is exactly an
		// author editing someone else's post.
		if ( ! current_user_can( 'edit_post', $post_id ) ) {
			return new WP_Error( 'hoc_forbidden', __( 'You cannot edit that post.', 'handofclient' ), array( 'status' => 403 ) );
		}

		if ( strlen( $value ) > 64 * 1024 ) {
			return new WP_Error( 'hoc_bad_param', __( 'value is too large.', 'handofclient' ), array( 'status' => 400 ) );
		}

		update_post_meta( $post_id, $key, sanitize_text_field( $value ) );

		return array(
			'postId' => $post_id,
			'key'    => $key,
		);
	}

	/**
	 * @param array<string,mixed> $body Request body.
	 * @return array<string,mixed>|WP_Error
	 */
	public static function c_comments_set_status( array $body ) {
		$comment_id = isset( $body['commentId'] ) ? (int) $body['commentId'] : 0;
		$status     = isset( $body['status'] ) ? (string) $body['status'] : '';

		if ( $comment_id <= 0 ) {
			return new WP_Error( 'hoc_bad_param', __( 'commentId is required.', 'handofclient' ), array( 'status' => 400 ) );
		}

		// No 'trash' or 'delete': a plugin should not be able to destroy content through this API.
		// Spam is reversible from the WordPress UI; deletion effectively is not.
		if ( ! in_array( $status, array( 'approve', 'hold', 'spam' ), true ) ) {
			return new WP_Error( 'hoc_bad_param', __( 'status must be approve, hold or spam.', 'handofclient' ), array( 'status' => 400 ) );
		}

		if ( ! get_comment( $comment_id ) ) {
			return new WP_Error( 'hoc_not_found', __( 'No such comment.', 'handofclient' ), array( 'status' => 404 ) );
		}

		if ( ! current_user_can( 'edit_comment', $comment_id ) ) {
			return new WP_Error( 'hoc_forbidden', __( 'You cannot moderate that comment.', 'handofclient' ), array( 'status' => 403 ) );
		}

		$updated = wp_set_comment_status( $comment_id, $status, true );
		if ( is_wp_error( $updated ) ) {
			return $updated;
		}

		return array(
			'commentId' => $comment_id,
			'status'    => $status,
		);
	}
}
