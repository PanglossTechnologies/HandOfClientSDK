<?php

declare(strict_types=1);

namespace HandOfClient\Host\Storage;

/** The few places where SQLite, PostgreSQL and MySQL differ for the hoc_* schema. */
final class Dialect
{
    private function __construct(
        public readonly string $name,
        private readonly string $key,    // short indexed identifier column
        private readonly string $str,    // medium string
        private readonly string $text,   // large text
        private readonly string $bigint,
        private readonly string $smallint,
        private readonly string $tableSuffix = '',
    ) {
    }

    public static function sqlite(): self
    {
        return new self('sqlite', 'TEXT', 'TEXT', 'TEXT', 'INTEGER', 'INTEGER');
    }

    public static function postgres(): self
    {
        return new self('postgres', 'VARCHAR(190)', 'VARCHAR(1024)', 'TEXT', 'BIGINT', 'SMALLINT');
    }

    public static function mysql(): self
    {
        // utf8mb4_bin: ids are case-sensitive, as they are in SQLite and PostgreSQL.
        return new self(
            'mysql',
            'VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin',
            'VARCHAR(1024)',
            'LONGTEXT',
            'BIGINT',
            'SMALLINT',
            ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
        );
    }

    /** 'sqlite' | 'postgres' (or 'pgsql' / 'postgresql') | 'mysql' (or 'mariadb') */
    public static function named(string $name): self
    {
        return match (strtolower($name)) {
            'sqlite' => self::sqlite(),
            'postgres', 'postgresql', 'pgsql' => self::postgres(),
            'mysql', 'mariadb' => self::mysql(),
            default => throw new \InvalidArgumentException("Unknown SQL dialect '$name'; use sqlite, postgres or mysql."),
        };
    }

    public static function detect(\PDO $pdo): self
    {
        $driver = (string) $pdo->getAttribute(\PDO::ATTR_DRIVER_NAME);
        try {
            return self::named($driver);
        } catch (\InvalidArgumentException) {
            throw new \InvalidArgumentException("The PDO driver '$driver' is not supported; use pdo_sqlite, pdo_pgsql or pdo_mysql, or implement Storage yourself.");
        }
    }

    /** Fill the {KEY} {STR} {TEXT} {BIGINT} {SMALLINT} type placeholders of a CREATE TABLE. */
    public function ddl(string $statement): string
    {
        return strtr($statement, [
            '{KEY}' => $this->key,
            '{STR}' => $this->str,
            '{TEXT}' => $this->text,
            '{BIGINT}' => $this->bigint,
            '{SMALLINT}' => $this->smallint,
        ]) . (str_starts_with(ltrim($statement), 'CREATE TABLE') ? $this->tableSuffix : '');
    }

    /** An INSERT that does nothing (rowCount 0) when the primary key already exists, and waits for a concurrent writer of it. */
    public function insertIgnore(string $table, string $columns, string $placeholders): string
    {
        return $this->name === 'mysql'
            ? "INSERT IGNORE INTO $table ($columns) VALUES ($placeholders)"
            : "INSERT INTO $table ($columns) VALUES ($placeholders) ON CONFLICT DO NOTHING";
    }
}
