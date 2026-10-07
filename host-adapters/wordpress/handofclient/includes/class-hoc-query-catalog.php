<?php
/**
 * Named, capability-checked read queries.
 *
 * @package HandOfClient
 */

defined( 'ABSPATH' ) || exit;

/**
 * The only way a plugin reads anything out of this WordPress install.
 *
 * Three rules, and all three are the point:
 *
 *  1. NAMED. A plugin picks a query from this catalogue; it never composes one. There is no endpoint
 *     that accepts SQL, a meta_query, or a WP_Query argument array - each of those is a way to ask
 *     for data the caller was never meant to see, or to write a table scan that takes the site down.
 *  2. PARAMETERISED. Every parameter is declared with a type and coerced through sanitise_params()
 *     before a handler sees it. Handlers receive clean scalars.
 *  3. CAPABILITY-CHECKED. Each query declares the WordPress capability it needs, and the caller runs
 *     as a real WP user (see HOC_REST::authenticate_embed_token). "A plugin cannot read what its
 *     user cannot read" is therefore enforced by WordPress's own capability system rather than by
 *     anything in this file being careful.
 *
 * Adding a query is a deliberate act by whoever ships this plugin - which is exactly the property
 * that makes the read surface reviewable.
 */
class HOC_Query_Catalog {

	const MAX_LIMIT = 100;

	/**
	 * The catalogue.
	 *
	 * @return array<string,array<string,mixed>>
	 */
	public static function all() {
		$queries = array(

			'site.summary'           => array(
				'capability'  => 'read',
				'description' => 'Site name, URL, versions and top-level content counts.',
				'params'      => array(),
				'handler'     => array( __CLASS__, 'q_site_summary' ),
			),

			'posts.recent'           => array(
				'capability'  => 'edit_posts',
				'description' => 'Most recent posts of a type.',
				'params'      => array(
					'postType' => array( 'type' => 'post_type', 'default' => 'post' ),
					'status'   => array( 'type' => 'post_status', 'default' => 'publish' ),
					'limit'    => array( 'type' => 'int', 'default' => 10, 'min' => 1, 'max' => self::MAX_LIMIT ),
					'search'   => array( 'type' => 'string', 'default' => '', 'maxLength' => 200 ),
				),
				'handler'     => array( __CLASS__, 'q_posts_recent' ),
			),

			'posts.count-by-status'  => array(
				'capability'  => 'edit_posts',
				'description' => 'Post counts grouped by status.',
				'params'      => array(
					'postType' => array( 'type' => 'post_type', 'default' => 'post' ),
				),
				'handler'     => array( __CLASS__, 'q_posts_count_by_status' ),
			),

			'posts.count-by-month'   => array(
				'capability'  => 'edit_posts',
				'description' => 'Published post counts per month, most recent last.',
				'params'      => array(
					'postType' => array( 'type' => 'post_type', 'default' => 'post' ),
					'months'   => array( 'type' => 'int', 'default' => 12, 'min' => 1, 'max' => 36 ),
				),
				'handler'     => array( __CLASS__, 'q_posts_count_by_month' ),
			),

			'terms.list'             => array(
				'capability'  => 'read',
				'description' => 'Terms in a taxonomy with post counts.',
				'params'      => array(
					'taxonomy' => array( 'type' => 'taxonomy', 'default' => 'category' ),
					'limit'    => array( 'type' => 'int', 'default' => 50, 'min' => 1, 'max' => self::MAX_LIMIT ),
					'orderby'  => array( 'type' => 'enum', 'default' => 'count', 'values' => array( 'count', 'name', 'slug' ) ),
				),
				'handler'     => array( __CLASS__, 'q_terms_list' ),
			),

			'comments.recent'        => array(
				'capability'  => 'moderate_comments',
				'description' => 'Most recent comments.',
				'params'      => array(
					'status' => array( 'type' => 'enum', 'default' => 'approve', 'values' => array( 'approve', 'hold', 'spam', 'all' ) ),
					'limit'  => array( 'type' => 'int', 'default' => 10, 'min' => 1, 'max' => self::MAX_LIMIT ),
				),
				'handler'     => array( __CLASS__, 'q_comments_recent' ),
			),

			'comments.count-by-status' => array(
				'capability'  => 'moderate_comments',
				'description' => 'Comment counts grouped by status.',
				'params'      => array(),
				'handler'     => array( __CLASS__, 'q_comments_count_by_status' ),
			),

			'users.count-by-role'    => array(
				'capability'  => 'list_users',
				'description' => 'User counts grouped by role.',
				'params'      => array(),
				'handler'     => array( __CLASS__, 'q_users_count_by_role' ),
			),

			'media.recent'           => array(
				'capability'  => 'upload_files',
				'description' => 'Most recent media attachments.',
				'params'      => array(
					'limit' => array( 'type' => 'int', 'default' => 10, 'min' => 1, 'max' => self::MAX_LIMIT ),
				),
				'handler'     => array( __CLASS__, 'q_media_recent' ),
			),
		);

		// WooCommerce queries only exist when WooCommerce does. Registering them unconditionally
		// would mean a plugin author sees them in the catalogue and gets a fatal, rather than a clean
		// "no such query", on a site without it.
		if ( class_exists( 'WooCommerce' ) ) {
			$queries['woo.orders.recent'] = array(
				'capability'  => 'edit_shop_orders',
				'description' => 'Most recent WooCommerce orders.',
				'params'      => array(
					'limit'  => array( 'type' => 'int', 'default' => 10, 'min' => 1, 'max' => self::MAX_LIMIT ),
					'status' => array( 'type' => 'string', 'default' => 'any', 'maxLength' => 40 ),
				),
				'handler'     => array( __CLASS__, 'q_woo_orders_recent' ),
			);

			$queries['woo.sales-by-day'] = array(
				'capability'  => 'view_woocommerce_reports',
				'description' => 'Gross order totals per day.',
				'params'      => array(
					'days' => array( 'type' => 'int', 'default' => 30, 'min' => 1, 'max' => 90 ),
				),
				'handler'     => array( __CLASS__, 'q_woo_sales_by_day' ),
			);
		}

		/**
		 * Filters the query catalogue.
		 *
		 * Deliberately last, so a site can add its OWN named queries without editing this plugin -
		 * but note that anything added here is subject to the same three rules, and nothing
		 * validates that for you.
		 *
		 * @param array<string,array<string,mixed>> $queries Catalogue.
		 */
		return apply_filters( 'hoc_query_catalog', $queries );
	}

	/**
	 * Catalogue metadata for the admin screen and for plugin authors - never includes handlers.
	 *
	 * @return array<int,array<string,mixed>>
	 */
	public static function describe() {
		$out = array();
		foreach ( self::all() as $name => $definition ) {
			$params = array();
			foreach ( $definition['params'] as $param_name => $spec ) {
				$params[ $param_name ] = array(
					'type'    => $spec['type'],
					'default' => isset( $spec['default'] ) ? $spec['default'] : null,
				);
			}
			$out[] = array(
				'name'        => $name,
				'capability'  => $definition['capability'],
				'description' => $definition['description'],
				'params'      => $params,
			);
		}
		return $out;
	}

	/**
	 * Runs a named query for the current user.
	 *
	 * @param string              $name   Query name.
	 * @param array<string,mixed> $params Raw request parameters.
	 * @return array<string,mixed>|WP_Error
	 */
	public function run( $name, array $params ) {
		$catalog = self::all();

		if ( ! isset( $catalog[ $name ] ) ) {
			return new WP_Error( 'hoc_unknown_query', __( 'No such query.', 'handofclient' ), array( 'status' => 404 ) );
		}

		$definition = $catalog[ $name ];

		if ( ! current_user_can( $definition['capability'] ) ) {
			return new WP_Error(
				'hoc_forbidden',
				sprintf(
					/* translators: %s: WordPress capability name */
					__( 'This query requires the "%s" capability.', 'handofclient' ),
					$definition['capability']
				),
				array( 'status' => 403 )
			);
		}

		$clean = self::sanitize_params( $definition['params'], $params );
		if ( is_wp_error( $clean ) ) {
			return $clean;
		}

		$rows = call_user_func( $definition['handler'], $clean );
		if ( is_wp_error( $rows ) ) {
			return $rows;
		}

		return array(
			'query'  => $name,
			'params' => $clean,
			'data'   => $rows,
		);
	}

	/**
	 * Coerces raw request input to the declared types.
	 *
	 * @param array<string,array<string,mixed>> $specs Parameter specs.
	 * @param array<string,mixed>               $raw   Raw input.
	 * @return array<string,mixed>|WP_Error
	 */
	private static function sanitize_params( array $specs, array $raw ) {
		$clean = array();

		foreach ( $specs as $name => $spec ) {
			$value = array_key_exists( $name, $raw ) ? $raw[ $name ] : null;

			if ( null === $value || '' === $value ) {
				$clean[ $name ] = isset( $spec['default'] ) ? $spec['default'] : null;
				continue;
			}

			switch ( $spec['type'] ) {
				case 'int':
					$int = (int) $value;
					if ( isset( $spec['min'] ) ) {
						$int = max( (int) $spec['min'], $int );
					}
					if ( isset( $spec['max'] ) ) {
						$int = min( (int) $spec['max'], $int );
					}
					$clean[ $name ] = $int;
					break;

				case 'string':
					$string = sanitize_text_field( (string) $value );
					if ( isset( $spec['maxLength'] ) ) {
						$string = substr( $string, 0, (int) $spec['maxLength'] );
					}
					$clean[ $name ] = $string;
					break;

				case 'enum':
					$candidate = (string) $value;
					if ( ! in_array( $candidate, $spec['values'], true ) ) {
						return new WP_Error(
							'hoc_bad_param',
							sprintf(
								/* translators: 1: parameter name, 2: allowed values */
								__( '"%1$s" must be one of: %2$s', 'handofclient' ),
								$name,
								implode( ', ', $spec['values'] )
							),
							array( 'status' => 400 )
						);
					}
					$clean[ $name ] = $candidate;
					break;

				case 'post_type':
					// Only types with a UI. An internal type (revision, nav_menu_item) is never
					// something a plugin should be listing, and several of them leak content the
					// user cannot otherwise see.
					$candidate = sanitize_key( (string) $value );
					if ( ! in_array( $candidate, get_post_types( array( 'show_ui' => true ) ), true ) ) {
						return new WP_Error( 'hoc_bad_param', __( 'Unknown post type.', 'handofclient' ), array( 'status' => 400 ) );
					}
					$clean[ $name ] = $candidate;
					break;

				case 'post_status':
					$candidate = sanitize_key( (string) $value );
					$allowed   = array_merge( array_keys( get_post_stati() ), array( 'any' ) );
					if ( ! in_array( $candidate, $allowed, true ) ) {
						return new WP_Error( 'hoc_bad_param', __( 'Unknown post status.', 'handofclient' ), array( 'status' => 400 ) );
					}
					$clean[ $name ] = $candidate;
					break;

				case 'taxonomy':
					$candidate = sanitize_key( (string) $value );
					if ( ! taxonomy_exists( $candidate ) ) {
						return new WP_Error( 'hoc_bad_param', __( 'Unknown taxonomy.', 'handofclient' ), array( 'status' => 400 ) );
					}
					$clean[ $name ] = $candidate;
					break;

				default:
					return new WP_Error( 'hoc_bad_spec', __( 'Query parameter type is not supported.', 'handofclient' ), array( 'status' => 500 ) );
			}
		}

		return $clean;
	}

	// ---- handlers ---------------------------------------------------------------------------

	/**
	 * @param array<string,mixed> $p Parameters.
	 * @return array<string,mixed>
	 */
	public static function q_site_summary( array $p ) {
		$theme    = wp_get_theme();
		$comments = wp_count_comments();

		return array(
			'name'         => get_bloginfo( 'name' ),
			'description'  => get_bloginfo( 'description' ),
			'url'          => home_url(),
			'language'     => get_bloginfo( 'language' ),
			'timezone'     => wp_timezone_string(),
			'wpVersion'    => get_bloginfo( 'version' ),
			'phpVersion'   => PHP_VERSION,
			'theme'        => array(
				'name'    => $theme->get( 'Name' ),
				'version' => $theme->get( 'Version' ),
			),
			'counts'       => array(
				'posts'            => (int) wp_count_posts( 'post' )->publish,
				'pages'            => (int) wp_count_posts( 'page' )->publish,
				'commentsApproved' => (int) $comments->approved,
				'commentsPending'  => (int) $comments->moderated,
				'users'            => (int) count_users()['total_users'],
			),
			'isMultisite'  => is_multisite(),
			'hasWoo'       => class_exists( 'WooCommerce' ),
		);
	}

	/**
	 * @param array<string,mixed> $p Parameters.
	 * @return array<int,array<string,mixed>>
	 */
	public static function q_posts_recent( array $p ) {
		$args = array(
			'post_type'        => $p['postType'],
			'post_status'      => $p['status'],
			'posts_per_page'   => $p['limit'],
			'orderby'          => 'date',
			'order'            => 'DESC',
			// Skip the found-rows count - nothing here paginates, and SQL_CALC_FOUND_ROWS is the
			// expensive half of a WP_Query on a large table.
			'no_found_rows'    => true,
			'suppress_filters' => false,
		);

		if ( '' !== $p['search'] ) {
			$args['s'] = $p['search'];
		}

		$posts = get_posts( $args );

		return array_map(
			static function ( $post ) {
				return array(
					'id'        => (int) $post->ID,
					'title'     => get_the_title( $post ),
					'status'    => $post->post_status,
					'type'      => $post->post_type,
					'date'      => mysql2date( 'c', $post->post_date_gmt, false ),
					'modified'  => mysql2date( 'c', $post->post_modified_gmt, false ),
					'author'    => (int) $post->post_author,
					'url'       => get_permalink( $post ),
					'excerpt'   => wp_trim_words( wp_strip_all_tags( $post->post_content ), 30 ),
					'commentCount' => (int) $post->comment_count,
				);
			},
			$posts
		);
	}

	/**
	 * @param array<string,mixed> $p Parameters.
	 * @return array<string,int>
	 */
	public static function q_posts_count_by_status( array $p ) {
		$counts = wp_count_posts( $p['postType'] );
		$out    = array();
		foreach ( (array) $counts as $status => $count ) {
			$out[ $status ] = (int) $count;
		}
		return $out;
	}

	/**
	 * Published counts per month.
	 *
	 * The one handler that reaches $wpdb directly, because WordPress has no API for a GROUP BY over
	 * post_date. It is still a NAMED, parameterised query: post type comes from the post_type
	 * validator above and goes through prepare(), and the month count is clamped to 1-36 - a caller
	 * cannot influence the shape of this statement, only its two bound values.
	 *
	 * @param array<string,mixed> $p Parameters.
	 * @return array<int,array<string,mixed>>
	 */
	public static function q_posts_count_by_month( array $p ) {
		global $wpdb;

		$since = gmdate( 'Y-m-d H:i:s', strtotime( '-' . (int) $p['months'] . ' months' ) );

		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT DATE_FORMAT(post_date_gmt, '%%Y-%%m') AS month, COUNT(*) AS total
				 FROM {$wpdb->posts}
				 WHERE post_type = %s AND post_status = 'publish' AND post_date_gmt >= %s
				 GROUP BY month
				 ORDER BY month ASC",
				$p['postType'],
				$since
			),
			ARRAY_A
		);

		return array_map(
			static function ( $row ) {
				return array(
					'month' => (string) $row['month'],
					'count' => (int) $row['total'],
				);
			},
			(array) $rows
		);
	}

	/**
	 * @param array<string,mixed> $p Parameters.
	 * @return array<int,array<string,mixed>>|WP_Error
	 */
	public static function q_terms_list( array $p ) {
		$terms = get_terms(
			array(
				'taxonomy'   => $p['taxonomy'],
				'number'     => $p['limit'],
				'orderby'    => $p['orderby'],
				'order'      => 'count' === $p['orderby'] ? 'DESC' : 'ASC',
				'hide_empty' => false,
			)
		);

		if ( is_wp_error( $terms ) ) {
			return $terms;
		}

		return array_map(
			static function ( $term ) {
				return array(
					'id'    => (int) $term->term_id,
					'name'  => $term->name,
					'slug'  => $term->slug,
					'count' => (int) $term->count,
				);
			},
			$terms
		);
	}

	/**
	 * @param array<string,mixed> $p Parameters.
	 * @return array<int,array<string,mixed>>
	 */
	public static function q_comments_recent( array $p ) {
		$args = array(
			'number'  => $p['limit'],
			'orderby' => 'comment_date_gmt',
			'order'   => 'DESC',
		);
		if ( 'all' !== $p['status'] ) {
			$args['status'] = $p['status'];
		}

		$comments = get_comments( $args );

		return array_map(
			static function ( $comment ) {
				return array(
					'id'       => (int) $comment->comment_ID,
					'postId'   => (int) $comment->comment_post_ID,
					'postTitle' => get_the_title( (int) $comment->comment_post_ID ),
					'author'   => $comment->comment_author,
					'date'     => mysql2date( 'c', $comment->comment_date_gmt, false ),
					'approved' => (string) $comment->comment_approved,
					// Trimmed, not full: a comment body is untrusted user content and there is no
					// reason to hand a plugin more of it than a moderation view needs.
					'excerpt'  => wp_trim_words( wp_strip_all_tags( $comment->comment_content ), 30 ),
				);
			},
			$comments
		);
	}

	/**
	 * @param array<string,mixed> $p Parameters.
	 * @return array<string,int>
	 */
	public static function q_comments_count_by_status( array $p ) {
		$counts = wp_count_comments();
		return array(
			'approved'     => (int) $counts->approved,
			'moderated'    => (int) $counts->moderated,
			'spam'         => (int) $counts->spam,
			'trash'        => (int) $counts->trash,
			'total'        => (int) $counts->total_comments,
		);
	}

	/**
	 * @param array<string,mixed> $p Parameters.
	 * @return array<string,int>
	 */
	public static function q_users_count_by_role( array $p ) {
		$counts = count_users();
		$out    = array( 'total' => (int) $counts['total_users'] );
		foreach ( (array) $counts['avail_roles'] as $role => $count ) {
			$out[ $role ] = (int) $count;
		}
		return $out;
	}

	/**
	 * @param array<string,mixed> $p Parameters.
	 * @return array<int,array<string,mixed>>
	 */
	public static function q_media_recent( array $p ) {
		$attachments = get_posts(
			array(
				'post_type'      => 'attachment',
				'post_status'    => 'inherit',
				'posts_per_page' => $p['limit'],
				'orderby'        => 'date',
				'order'          => 'DESC',
				'no_found_rows'  => true,
			)
		);

		return array_map(
			static function ( $attachment ) {
				return array(
					'id'       => (int) $attachment->ID,
					'title'    => get_the_title( $attachment ),
					'mimeType' => $attachment->post_mime_type,
					'date'     => mysql2date( 'c', $attachment->post_date_gmt, false ),
					'url'      => wp_get_attachment_url( $attachment->ID ),
					'thumbnail' => wp_get_attachment_image_url( $attachment->ID, 'thumbnail' ),
				);
			},
			$attachments
		);
	}

	/**
	 * @param array<string,mixed> $p Parameters.
	 * @return array<int,array<string,mixed>>
	 */
	public static function q_woo_orders_recent( array $p ) {
		if ( ! function_exists( 'wc_get_orders' ) ) {
			return array();
		}

		$orders = wc_get_orders(
			array(
				'limit'   => $p['limit'],
				'orderby' => 'date',
				'order'   => 'DESC',
				'status'  => 'any' === $p['status'] ? array_keys( wc_get_order_statuses() ) : $p['status'],
			)
		);

		$out = array();
		foreach ( (array) $orders as $order ) {
			if ( ! is_object( $order ) || ! method_exists( $order, 'get_id' ) ) {
				continue;
			}
			$date = $order->get_date_created();
			$out[] = array(
				'id'       => (int) $order->get_id(),
				'number'   => (string) $order->get_order_number(),
				'status'   => (string) $order->get_status(),
				'total'    => (float) $order->get_total(),
				'currency' => (string) $order->get_currency(),
				'itemCount' => (int) $order->get_item_count(),
				'date'     => $date ? $date->date( 'c' ) : null,
			);
		}
		return $out;
	}

	/**
	 * @param array<string,mixed> $p Parameters.
	 * @return array<int,array<string,mixed>>
	 */
	public static function q_woo_sales_by_day( array $p ) {
		if ( ! function_exists( 'wc_get_orders' ) ) {
			return array();
		}

		$orders = wc_get_orders(
			array(
				'limit'        => -1,
				'status'       => array( 'wc-completed', 'wc-processing' ),
				'date_created' => '>' . ( time() - ( (int) $p['days'] * DAY_IN_SECONDS ) ),
				'orderby'      => 'date',
				'order'        => 'ASC',
			)
		);

		$by_day = array();
		foreach ( (array) $orders as $order ) {
			if ( ! is_object( $order ) || ! method_exists( $order, 'get_date_created' ) ) {
				continue;
			}
			$date = $order->get_date_created();
			if ( ! $date ) {
				continue;
			}
			$day = $date->date( 'Y-m-d' );
			if ( ! isset( $by_day[ $day ] ) ) {
				$by_day[ $day ] = array( 'day' => $day, 'orders' => 0, 'gross' => 0.0 );
			}
			++$by_day[ $day ]['orders'];
			$by_day[ $day ]['gross'] += (float) $order->get_total();
		}

		ksort( $by_day );
		return array_values( $by_day );
	}
}
