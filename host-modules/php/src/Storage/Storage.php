<?php

declare(strict_types=1);

namespace HandOfClient\Host\Storage;

/**
 * Where requests, features, versions and settings live. SqlStorage (SQLite, PostgreSQL, MySQL over PDO) is the
 * ready-made one; implement this and StorageTx to keep the data anywhere else.
 */
interface Storage
{
    /** Create / upgrade the schema. Idempotent and safe to call on every request. */
    public function migrate(): void;

    /**
     * Run $fn(StorageTx) as one unit of work: commit when it returns, roll back (and rethrow) when it throws.
     * Returns what $fn returned. $write = true when it will change data.
     *
     * @template T
     * @param callable(StorageTx):T $fn
     * @return T
     */
    public function transaction(callable $fn, bool $write = false): mixed;
}
