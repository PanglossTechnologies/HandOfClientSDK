<?php

declare(strict_types=1);

namespace HandOfClient\Host\Storage;

use HandOfClient\Host\TimeUtil;

/**
 * Storage over PDO: SQLite (pdo_sqlite), PostgreSQL (pdo_pgsql) and MySQL / MariaDB (pdo_mysql).
 *
 *     SqlStorage::sqlite('hoc.db');
 *     new SqlStorage($pdo);                                   // a PDO you already have (Laravel: DB::connection()->getPdo())
 *     new SqlStorage(fn () => new PDO($dsn, $user, $pass));   // or a function that returns one
 *
 * Tables are prefixed hoc_ and created / upgraded by migrate(); the schema is the same as the Python and Node host
 * modules', so they can serve one database. A PDO that is already inside a transaction is joined (the caller commits).
 */
final class SqlStorage implements Storage
{
    private const MIGRATION_LOCK_ID = 5081201;
    private const MIGRATION_LOCK_NAME = 'handofclient_hoc_migrate';

    /** @var \PDO|callable():\PDO */
    private $connection;
    private ?Dialect $forced;

    /**
     * @param \PDO|callable():\PDO $connection
     * @param string|null $dialect force 'sqlite' | 'postgres' | 'mysql' instead of detecting it from the driver
     */
    public function __construct(\PDO|callable $connection, ?string $dialect = null)
    {
        $this->connection = $connection;
        $this->forced = $dialect === null ? null : Dialect::named($dialect);
    }

    public static function sqlite(string $path, float $timeout = 30.0): self
    {
        return new self(static function () use ($path, $timeout): \PDO {
            $pdo = new \PDO('sqlite:' . $path, null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION, \PDO::ATTR_TIMEOUT => (int) ceil($timeout)]);
            $pdo->exec('PRAGMA busy_timeout = ' . (int) ($timeout * 1000));

            return $pdo;
        }, 'sqlite');
    }

    private function pdo(): \PDO
    {
        $pdo = $this->connection instanceof \PDO ? $this->connection : ($this->connection)();
        if ($pdo->getAttribute(\PDO::ATTR_ERRMODE) !== \PDO::ERRMODE_EXCEPTION) {
            $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        }

        return $pdo;
    }

    private function dialect(\PDO $pdo): Dialect
    {
        return $this->forced ?? Dialect::detect($pdo);
    }

    public function transaction(callable $fn, bool $write = false): mixed
    {
        $pdo = $this->pdo();
        $dialect = $this->dialect($pdo);
        $tx = new SqlTx($pdo, $dialect);
        if ($pdo->inTransaction()) {
            return $fn($tx); // joined: the caller owns commit / rollback
        }
        $sqlite = $dialect->name === 'sqlite';
        // SQLite is driven with plain statements: BEGIN IMMEDIATE for writers, so they queue on the busy timeout
        // instead of deadlocking on a lock upgrade (PDO::beginTransaction() can only issue a deferred BEGIN, and
        // pdo_sqlite's inTransaction() does not see transactions started by statement).
        try {
            $sqlite ? $pdo->exec($write ? 'BEGIN IMMEDIATE' : 'BEGIN') : $pdo->beginTransaction();
        } catch (\PDOException $e) {
            if ($sqlite && str_contains($e->getMessage(), 'within a transaction')) {
                return $fn($tx); // joined: the caller started a transaction of its own and owns commit / rollback
            }
            throw $e;
        }
        try {
            $result = $fn($tx);
            $sqlite ? $pdo->exec('COMMIT') : $pdo->commit();

            return $result;
        } catch (\Throwable $e) {
            try {
                if ($sqlite) {
                    $pdo->exec('ROLLBACK');
                } elseif ($pdo->inTransaction()) {
                    $pdo->rollBack();
                }
            } catch (\Throwable $rollbackFailure) {
                // The original error is the one worth reporting; the rollback failure is logged.
                if (!str_contains($rollbackFailure->getMessage(), 'no transaction is active')) {
                    error_log('handofclient: rollback failed: ' . $rollbackFailure);
                }
            }
            throw $e;
        }
    }

    public function migrate(): void
    {
        $pdo = $this->pdo();
        $dialect = $this->dialect($pdo);
        if (!$pdo->inTransaction() && array_diff_key(self::migrations(), $this->appliedVersions($pdo)) === []) {
            return; // the common case: one cheap SELECT per request
        }
        $this->withMigrationLock($pdo, $dialect, function () use ($pdo, $dialect): void {
            if ($dialect->name === 'sqlite') {
                $pdo->query('PRAGMA journal_mode = WAL')->fetchAll();
            }
            $pdo->exec($dialect->ddl('CREATE TABLE IF NOT EXISTS hoc_migrations (version {BIGINT} NOT NULL PRIMARY KEY, name {STR} NOT NULL, applied_at {KEY} NOT NULL)'));
            $applied = $this->appliedVersions($pdo);
            foreach (self::migrations() as $version => [$name, $fn]) {
                if (isset($applied[$version])) {
                    continue;
                }
                $fn($pdo, $dialect); // every step is idempotent, so two processes migrating at once cannot hurt
                $st = $pdo->prepare($dialect->insertIgnore('hoc_migrations', 'version, name, applied_at', '?, ?, ?'));
                $st->execute([$version, $name, TimeUtil::nowIso()]);
            }
        });
    }

    /** @return array<int,int> version => version; empty when the table does not exist yet */
    private function appliedVersions(\PDO $pdo): array
    {
        try {
            $out = [];
            foreach ($pdo->query('SELECT version FROM hoc_migrations')->fetchAll(\PDO::FETCH_NUM) as $row) {
                $out[(int) $row[0]] = (int) $row[0];
            }

            return $out;
        } catch (\PDOException) {
            return [];
        }
    }

    private function withMigrationLock(\PDO $pdo, Dialect $dialect, callable $fn): void
    {
        if ($dialect->name === 'postgres') {
            $pdo->query('SELECT pg_advisory_lock(' . self::MIGRATION_LOCK_ID . ')')->fetchAll();
        } elseif ($dialect->name === 'mysql') {
            $got = $pdo->query("SELECT GET_LOCK('" . self::MIGRATION_LOCK_NAME . "', 60)")->fetchColumn();
            if ((int) $got !== 1) {
                throw new \RuntimeException('Could not get the migration lock within 60 seconds.');
            }
        }
        try {
            $fn();
        } finally {
            if ($dialect->name === 'postgres') {
                $pdo->query('SELECT pg_advisory_unlock(' . self::MIGRATION_LOCK_ID . ')')->fetchAll();
            } elseif ($dialect->name === 'mysql') {
                $pdo->query("SELECT RELEASE_LOCK('" . self::MIGRATION_LOCK_NAME . "')")->fetchAll();
            }
        }
    }

    /**
     * Append only; never edit a shipped migration.
     *
     * @return array<int,array{0:string,1:callable(\PDO,Dialect):void}> version => [description, step]
     */
    private static function migrations(): array
    {
        return [1 => ['initial schema', static function (\PDO $pdo, Dialect $d): void {
            foreach ([
                'CREATE TABLE IF NOT EXISTS hoc_settings (name {KEY} NOT NULL PRIMARY KEY, value {TEXT} NOT NULL)',
                'CREATE TABLE IF NOT EXISTS hoc_counters (name {KEY} NOT NULL PRIMARY KEY, value {BIGINT} NOT NULL)',
                'CREATE TABLE IF NOT EXISTS hoc_events (event_id {KEY} NOT NULL PRIMARY KEY, received_at {KEY} NOT NULL)',
                'CREATE TABLE IF NOT EXISTS hoc_requests (
                    id {KEY} NOT NULL PRIMARY KEY, seq {BIGINT} NOT NULL, user_id {KEY} NOT NULL, user_name {STR} NULL, user_email {STR} NULL,
                    text {TEXT} NOT NULL, status {KEY} NOT NULL, message {TEXT} NULL, feature_id {KEY} NULL, change_of {KEY} NULL,
                    mode {KEY} NOT NULL, snapshot {TEXT} NULL, build_id {KEY} NULL, created_at {KEY} NOT NULL, updated_at {KEY} NOT NULL)',
                'CREATE TABLE IF NOT EXISTS hoc_features (
                    id {KEY} NOT NULL PRIMARY KEY, title {STR} NOT NULL, kind {KEY} NOT NULL, path {STR} NULL, slot_id {KEY} NOT NULL,
                    mode {KEY} NOT NULL, package_id {STR} NOT NULL, current_version {KEY} NOT NULL, owner_user_id {KEY} NOT NULL,
                    request_id {KEY} NULL, created_at {KEY} NOT NULL)',
                'CREATE TABLE IF NOT EXISTS hoc_versions (
                    feature_id {KEY} NOT NULL, version {KEY} NOT NULL, published_at {KEY} NOT NULL, request_id {KEY} NULL,
                    sha256 {KEY} NOT NULL, entry {STR} NOT NULL, seq {BIGINT} NOT NULL, PRIMARY KEY (feature_id, version))',
                'CREATE TABLE IF NOT EXISTS hoc_assignments (
                    feature_id {KEY} NOT NULL, everyone {SMALLINT} NOT NULL, user_id {KEY} NOT NULL, seq {BIGINT} NOT NULL,
                    PRIMARY KEY (feature_id, everyone, user_id))',
                'CREATE TABLE IF NOT EXISTS hoc_pins (
                    feature_id {KEY} NOT NULL, user_id {KEY} NOT NULL, version {KEY} NOT NULL, PRIMARY KEY (feature_id, user_id))',
                'CREATE TABLE IF NOT EXISTS hoc_disabled (
                    feature_id {KEY} NOT NULL, user_id {KEY} NOT NULL, PRIMARY KEY (feature_id, user_id))',
            ] as $statement) {
                $pdo->exec($d->ddl($statement));
            }
            self::index($pdo, $d, 'hoc_requests', 'hoc_requests_user_seq', 'user_id, seq');
            self::index($pdo, $d, 'hoc_requests', 'hoc_requests_seq', 'seq');
            self::index($pdo, $d, 'hoc_assignments', 'hoc_assignments_user', 'user_id, feature_id');
            self::index($pdo, $d, 'hoc_pins', 'hoc_pins_user', 'user_id');
            $pdo->prepare($d->insertIgnore('hoc_counters', 'name, value', '?, ?'))->execute(['seq', 0]);
        }]];
    }

    private static function index(\PDO $pdo, Dialect $d, string $table, string $name, string $columns): void
    {
        if ($d->name === 'mysql') { // no CREATE INDEX IF NOT EXISTS
            $st = $pdo->prepare('SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?');
            $st->execute([$table, $name]);
            if ((int) $st->fetchColumn() > 0) {
                return;
            }
            $pdo->exec("CREATE INDEX $name ON $table ($columns)");

            return;
        }
        $pdo->exec("CREATE INDEX IF NOT EXISTS $name ON $table ($columns)");
    }
}
