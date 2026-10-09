<?php
/**
 * Loads the bundled PHP host module and gives it a database connection.
 *
 * @package HandOfClient
 */

defined( 'ABSPATH' ) || exit;

/**
 * Glue between WordPress and `handofclient/host` (host-modules/php): where its classes come from, and
 * which PDO connection its `hoc_*` tables live behind.
 *
 * The module is plain PHP 8.1+ with PDO, which is why this is separate from the rest of the plugin
 * (still 7.4-compatible for the older slot features): on an older PHP, or without PDO, the request
 * loop is simply unavailable and the admin screen says why, instead of the plugin fataling.
 */
class HOC_Site_Loader {

	/** Minimum PHP the host module needs. */
	const MIN_PHP_VERSION_ID = 80100;

	/** @var bool */
	private static $registered = false;

	/**
	 * Why the request loop cannot run on this server, or an empty string when it can.
	 *
	 * @return string
	 */
	public static function unavailable_reason() {
		if ( PHP_VERSION_ID < self::MIN_PHP_VERSION_ID ) {
			/* translators: %s: the running PHP version */
			return sprintf( __( 'Requesting features needs PHP 8.1 or newer; this server runs PHP %s.', 'handofclient' ), PHP_VERSION );
		}
		if ( ! extension_loaded( 'pdo' ) || ! extension_loaded( 'mbstring' ) ) {
			return __( 'Requesting features needs the PHP PDO and mbstring extensions.', 'handofclient' );
		}
		if ( null === self::host_source_dir() ) {
			return __( 'The bundled HandOfClient host module is missing from this installation. Reinstall the plugin from the release zip.', 'handofclient' );
		}
		if ( null === self::connection_spec() ) {
			return __( 'Requesting features needs the pdo_mysql PHP extension (or the SQLite database plugin) to store its data next to WordPress\'s own.', 'handofclient' );
		}
		return '';
	}

	/**
	 * Registers PSR-4 autoloaders for the host module and psr/log. Idempotent. Needs PHP 8.1+ to be
	 * useful, but registering is harmless on older versions - nothing is ever autoloaded there.
	 *
	 * @return void
	 */
	public static function register() {
		if ( self::$registered ) {
			return;
		}
		self::$registered = true;

		$host = self::host_source_dir();
		$psr  = self::psr_source_dir();
		spl_autoload_register(
			static function ( $class_name ) use ( $host, $psr ) {
				$maps = array(
					'HandOfClient\\Host\\' => $host,
					'Psr\\Log\\'           => $psr,
				);
				foreach ( $maps as $prefix => $dir ) {
					if ( null !== $dir && 0 === strpos( $class_name, $prefix ) ) {
						$file = $dir . '/' . str_replace( '\\', '/', substr( $class_name, strlen( $prefix ) ) ) . '.php';
						if ( is_file( $file ) ) {
							require_once $file;
						}
						return;
					}
				}
			}
		);
	}

	/**
	 * Directory holding HandOfClient\Host\*: the copy bundled into a built zip (lib/host) or, in a source
	 * checkout (the dev harness links the plugin folder into WordPress), the repo's host-modules/php/src.
	 *
	 * @return string|null
	 */
	public static function host_source_dir() {
		return self::first_dir(
			array(
				HOC_PLUGIN_DIR . 'lib/host',
				dirname( realpath( HOC_PLUGIN_FILE ) ) . '/../../../host-modules/php/src',
			)
		);
	}

	/**
	 * @return string|null
	 */
	private static function psr_source_dir() {
		return self::first_dir(
			array(
				HOC_PLUGIN_DIR . 'lib/psr-log',
				dirname( realpath( HOC_PLUGIN_FILE ) ) . '/../../../host-modules/php/vendor/psr/log/src',
			)
		);
	}

	/**
	 * @param string[] $candidates Directories, best first.
	 * @return string|null
	 */
	private static function first_dir( array $candidates ) {
		foreach ( $candidates as $dir ) {
			$real = realpath( $dir );
			if ( false !== $real && is_dir( $real ) ) {
				return str_replace( '\\', '/', $real );
			}
		}
		return null;
	}

	/**
	 * Which database the module's tables go in: WordPress's own.
	 *
	 * @return array{driver:string,dsn:string,user:?string,password:?string,sqlite_path:?string}|null Null when no PDO driver can reach it.
	 */
	public static function connection_spec() {
		// The SQLite integration plugin (the dev harness, WordPress Playground): same file, own PDO connection.
		$sqlite_path = defined( 'DB_PATH' ) ? DB_PATH : ( defined( 'FQDB' ) ? FQDB : '' ); // FQDB: drop-in before 3.0.
		if ( is_string( $sqlite_path ) && '' !== $sqlite_path && ':memory:' !== $sqlite_path && defined( 'SQLITE_DB_DROPIN_VERSION' ) && extension_loaded( 'pdo_sqlite' ) ) {
			return array(
				'driver'      => 'sqlite',
				'dsn'         => 'sqlite:' . $sqlite_path,
				'user'        => null,
				'password'    => null,
				'sqlite_path' => $sqlite_path,
			);
		}
		if ( defined( 'DB_HOST' ) && defined( 'DB_NAME' ) && extension_loaded( 'pdo_mysql' ) ) {
			return array(
				'driver'      => 'mysql',
				'dsn'         => self::mysql_dsn( (string) DB_HOST, (string) DB_NAME, defined( 'DB_CHARSET' ) && '' !== DB_CHARSET ? (string) DB_CHARSET : 'utf8mb4' ),
				'user'        => defined( 'DB_USER' ) ? (string) DB_USER : null,
				'password'    => defined( 'DB_PASSWORD' ) ? (string) DB_PASSWORD : null,
				'sqlite_path' => null,
			);
		}
		return null;
	}

	/**
	 * Builds a PDO MySQL DSN from wp-config's DB_HOST, which can be `host`, `host:port`, `[v6]:port`,
	 * `:/path/to.sock` or `host:/path/to.sock` (the same forms wpdb::db_connect() accepts).
	 *
	 * @param string $db_host DB_HOST.
	 * @param string $name    DB_NAME.
	 * @param string $charset DB_CHARSET; "utf8" (MySQL's 3-byte alias) is widened to utf8mb4.
	 * @return string
	 */
	public static function mysql_dsn( $db_host, $name, $charset = 'utf8mb4' ) {
		$charset = ( '' === $charset || 'utf8' === strtolower( $charset ) ) ? 'utf8mb4' : $charset;
		$host    = $db_host;
		$port    = '';
		$socket  = '';

		if ( preg_match( '#^(?<host>\[[^\]]+\]|[^:]*):(?<tail>.*)$#', $db_host, $m ) ) {
			$host = $m['host'];
			if ( '' !== $m['tail'] && '/' === $m['tail'][0] ) {
				$socket = $m['tail'];
			} elseif ( ctype_digit( $m['tail'] ) ) {
				$port = $m['tail'];
			}
		}
		$host = trim( $host, '[]' );

		$dsn = 'mysql:';
		if ( '' !== $socket ) {
			$dsn .= 'unix_socket=' . $socket . ';';
		} else {
			$dsn .= 'host=' . ( '' === $host ? 'localhost' : $host ) . ';';
			if ( '' !== $port ) {
				$dsn .= 'port=' . $port . ';';
			}
		}
		return $dsn . 'dbname=' . $name . ';charset=' . $charset;
	}

	/**
	 * A function returning the (memoised) PDO the module uses. PDO errors are exceptions.
	 *
	 * @return callable
	 */
	public static function pdo_factory() {
		return static function () {
			static $pdo = null;
			if ( null === $pdo ) {
				$spec = HOC_Site_Loader::connection_spec();
				if ( null === $spec ) {
					throw new RuntimeException( 'No PDO driver can reach the WordPress database.' );
				}
				$pdo = new PDO( $spec['dsn'], $spec['user'], $spec['password'], array( PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION ) );
				if ( null !== $spec['sqlite_path'] ) {
					$pdo->exec( 'PRAGMA busy_timeout = 30000' );
				}
			}
			return $pdo;
		};
	}
}
