<?php

declare(strict_types=1);

namespace HandOfClient\Host\Tests;

use HandOfClient\Host\Storage\Dialect;
use HandOfClient\Host\Storage\FeatureRec;
use HandOfClient\Host\Storage\RequestRec;
use HandOfClient\Host\Storage\SqlStorage;
use HandOfClient\Host\Storage\StorageTx;
use HandOfClient\Host\Storage\VersionRec;
use PHPUnit\Framework\TestCase;

final class SqlStorageTest extends TestCase
{
    private string $db;
    private SqlStorage $storage;

    protected function setUp(): void
    {
        $this->db = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'hoc-s-' . bin2hex(random_bytes(6)) . '.db';
        $this->storage = SqlStorage::sqlite($this->db);
        $this->storage->migrate();
    }

    protected function tearDown(): void
    {
        foreach (['', '-wal', '-shm'] as $suffix) {
            @unlink($this->db . $suffix);
        }
    }

    private static function rec(string $id = 'r1', string $user = 'alice', int $seq = 1, string $status = 'InProgress'): RequestRec
    {
        return new RequestRec($id, $seq, $user, 'Alice', null, 'text', $status, null, null, null, 'inject', null, null, 't', 't');
    }

    private function pdo(): \PDO
    {
        return new \PDO('sqlite:' . $this->db, null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
    }

    public function testMigrateIsIdempotentAndRecordsVersions(): void
    {
        $this->storage->migrate();
        $this->storage->migrate();
        $this->assertSame([1], array_map('intval', $this->pdo()->query('SELECT version FROM hoc_migrations')->fetchAll(\PDO::FETCH_COLUMN)));
        $this->assertSame('wal', strtolower((string) $this->pdo()->query('PRAGMA journal_mode')->fetchColumn()));
    }

    public function testMigrateOnAnEmptyDatabaseCreatesEverything(): void
    {
        $tables = $this->pdo()->query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")->fetchAll(\PDO::FETCH_COLUMN);
        foreach (['hoc_assignments', 'hoc_counters', 'hoc_disabled', 'hoc_events', 'hoc_features', 'hoc_migrations', 'hoc_pins', 'hoc_requests', 'hoc_settings', 'hoc_versions'] as $t) {
            $this->assertContains($t, $tables);
        }
    }

    public function testTransactionRollsBackOnErrorAndRethrows(): void
    {
        try {
            $this->storage->transaction(function (StorageTx $tx): void {
                $tx->insertRequest(self::rec());
                throw new \RuntimeException('boom');
            }, true);
            $this->fail('expected the exception');
        } catch (\RuntimeException $e) {
            $this->assertSame('boom', $e->getMessage());
        }
        $this->assertNull($this->storage->transaction(static fn (StorageTx $tx) => $tx->getRequest('r1')));
    }

    public function testTransactionReturnsTheCallbacksResultAndCommits(): void
    {
        $this->assertSame('done', $this->storage->transaction(static function (StorageTx $tx): string {
            $tx->insertRequest(self::rec());

            return 'done';
        }, true));
        $this->assertNotNull($this->storage->transaction(static fn (StorageTx $tx) => $tx->getRequest('r1')));
    }

    public function testSequenceIsStrictlyIncreasingAcrossTransactions(): void
    {
        $seen = [];
        for ($i = 0; $i < 3; $i++) {
            $seen[] = $this->storage->transaction(static fn (StorageTx $tx): int => $tx->nextSeq(), true);
        }
        $this->assertSame($seen, array_values(array_unique($seen)));
        $sorted = $seen;
        sort($sorted);
        $this->assertSame($sorted, $seen);
    }

    public function testRecordEventDeduplicates(): void
    {
        $this->storage->transaction(function (StorageTx $tx): void {
            $this->assertTrue($tx->recordEvent('e1', 't'));
            $this->assertFalse($tx->recordEvent('e1', 't'));
        }, true);
        $this->storage->transaction(function (StorageTx $tx): void {
            $this->assertFalse($tx->recordEvent('e1', 't'));
            $this->assertTrue($tx->recordEvent('e2', 't'));
        }, true);
    }

    public function testRecordEventAcrossTwoConnectionsAppliesOnce(): void
    {
        $other = SqlStorage::sqlite($this->db);
        $this->assertTrue($this->storage->transaction(static fn (StorageTx $tx) => $tx->recordEvent('same', 't'), true));
        $this->assertFalse($other->transaction(static fn (StorageTx $tx) => $tx->recordEvent('same', 't'), true));
    }

    public function testSettingsRoundTrip(): void
    {
        $this->assertNull($this->storage->transaction(static fn (StorageTx $tx) => $tx->getSettings()));
        $this->storage->transaction(static fn (StorageTx $tx) => $tx->saveSettings(['a' => 1, 'dataSources' => []]), true);
        $this->storage->transaction(static fn (StorageTx $tx) => $tx->saveSettings(['a' => 2, 'dataSources' => [['name' => 'x']]]), true);
        $this->assertSame(['a' => 2, 'dataSources' => [['name' => 'x']]], $this->storage->transaction(static fn (StorageTx $tx) => $tx->getSettings()));
    }

    public function testBuildRetryCompareAndSwap(): void
    {
        $swap = fn (int $expected, int $new): bool => $this->storage->transaction(static fn (StorageTx $tx): bool => $tx->swapBuildRetryAt($expected, $new), true);
        $get = fn (): int => $this->storage->transaction(static fn (StorageTx $tx): int => $tx->getBuildRetryAt());
        $this->assertSame(0, $get());
        $this->assertTrue($swap(0, 100));
        $this->assertSame(100, $get());
        $this->assertFalse($swap(0, 200), 'a stale expectation loses');
        $this->assertFalse($swap(99, 200));
        $this->assertTrue($swap(100, 200));
        $this->assertSame(200, $get());
    }

    public function testRequestsListNewestFirstWithPagingFiltersAndUpdate(): void
    {
        $this->storage->transaction(function (StorageTx $tx): void {
            $tx->insertRequest(self::rec('r1', 'alice', 1));
            $tx->insertRequest(self::rec('r2', 'bob', 2, 'Success'));
            $tx->insertRequest(self::rec('r3', 'alice', 3));
            $tx->updateRequest('r3', ['status' => 'NeedsInfo', 'message' => 'which?', 'buildId' => 'b3', 'updatedAt' => 'u']);
        }, true);
        $this->storage->transaction(function (StorageTx $tx): void {
            [$page, $more] = $tx->listRequests('alice', [], 1, 0);
            $this->assertSame(['r3'], array_map(static fn ($r) => $r->id, $page));
            $this->assertTrue($more);
            [$page, $more] = $tx->listRequests('alice', [], 1, 1);
            $this->assertSame(['r1'], array_map(static fn ($r) => $r->id, $page));
            $this->assertFalse($more);
            [$all] = $tx->listRequests(null, [], 10, 0);
            $this->assertSame(['r3', 'r2', 'r1'], array_map(static fn ($r) => $r->id, $all));
            [$filtered] = $tx->listRequests(null, ['Success', 'NeedsInfo'], 10, 0);
            $this->assertSame(['r3', 'r2'], array_map(static fn ($r) => $r->id, $filtered));
            $r3 = $tx->getRequest('r3');
            $this->assertSame(['NeedsInfo', 'which?', 'b3', 'u'], [$r3->status, $r3->message, $r3->buildId, $r3->updatedAt]);
            $this->assertSame(['r1'], array_map(static fn ($r) => $r->id, $tx->listUnstartedBuilds(10)), 'only InProgress without a build id');
        });
    }

    public function testUpdateRejectsUnknownColumns(): void
    {
        foreach ([['id' => 'x'], ['status; DROP TABLE hoc_requests' => 'x'], []] as $fields) {
            try {
                $this->storage->transaction(static fn (StorageTx $tx) => $tx->updateRequest('r1', $fields), true);
                $this->fail('expected an exception for ' . json_encode($fields));
            } catch (\InvalidArgumentException) {
                $this->addToAssertionCount(1);
            }
        }
        $this->expectException(\InvalidArgumentException::class);
        $this->storage->transaction(static fn (StorageTx $tx) => $tx->updateFeature('f', ['ownerUserId' => 'x']), true);
    }

    public function testFeaturesAssignmentsPinsAndVersions(): void
    {
        $this->storage->transaction(function (StorageTx $tx): void {
            $tx->insertFeature(new FeatureRec('f1', 'T', 'page-override', '/p', 'main', 'inject', 'pkg', '1.0.0', 'alice', null, 'c1'));
            $tx->insertFeature(new FeatureRec('f2', 'T2', 'slot', null, 'main', 'inject', 'pkg2', '1.0.0', 'bob', null, 'c2'));
            $tx->addAssignment('f1', 'alice', $tx->nextSeq());
            $tx->addAssignment('f1', 'alice', $tx->nextSeq()); // idempotent
            $tx->addAssignment('f2', null, $tx->nextSeq());
            $tx->setPin('f1', 'alice', '1.0.0');
            $tx->setDisabled('f2', 'alice', true);
            $tx->upsertVersion(new VersionRec('f1', '1.0.0', 'p1', null, 'aa', 'e', $tx->nextSeq()));
            $tx->upsertVersion(new VersionRec('f1', '1.1.0', 'p2', 'r', 'bb', 'e', $tx->nextSeq()));
            $tx->upsertVersion(new VersionRec('f1', '1.0.0', 'p3', null, 'cc', 'e2', $tx->nextSeq())); // replaces
        }, true);
        $this->storage->transaction(function (StorageTx $tx): void {
            $this->assertSame(['f1', 'f2'], array_map(static fn ($f) => $f->id, $tx->listVisibleFeatures('alice')));
            $this->assertSame(['f2'], array_map(static fn ($f) => $f->id, $tx->listVisibleFeatures('bob')), 'only what is assigned to them or everyone');
            $this->assertSame(['f1'], array_map(static fn ($f) => $f->id, $tx->listVisibleFeatures('alice', '/p')));
            $this->assertSame([], $tx->listVisibleFeatures('nobody', '/p'));
            $assignments = $tx->getAssignments(['f1', 'f2', 'missing']);
            $this->assertSame(['alice'], array_map(static fn ($a) => $a->userId, $assignments['f1']));
            $this->assertSame([null], array_map(static fn ($a) => $a->userId, $assignments['f2']));
            $this->assertSame([], $assignments['missing']);
            $states = $tx->getUserState(['f1', 'f2'], 'alice');
            $this->assertSame(['1.0.0', false], [$states['f1']->pinnedVersion, $states['f1']->disabled]);
            $this->assertSame([null, true], [$states['f2']->pinnedVersion, $states['f2']->disabled]);
            $this->assertSame(['1.0.0', '1.1.0'], array_map(static fn ($v) => $v->version, $tx->listVersions('f1')), 'newest (by seq) first; the replaced 1.0.0 got a new seq');
            $this->assertSame(['cc', 'e2'], [$tx->getVersion('f1', '1.0.0')->sha256, $tx->getVersion('f1', '1.0.0')->entry]);
            $this->assertNull($tx->getVersion('f1', '9'));
        });
        $this->storage->transaction(function (StorageTx $tx): void {
            $tx->removeAssignment('f1', 'alice'); // also clears alice's pin
            $tx->setDisabled('f2', 'alice', false);
            $tx->updateFeature('f1', ['currentVersion' => '1.1.0', 'slotId' => 's', 'mode' => 'iframe']);
        }, true);
        $this->storage->transaction(function (StorageTx $tx): void {
            $this->assertSame([], $tx->getAssignments(['f1'])['f1']);
            $this->assertNull($tx->getUserState(['f1'], 'alice')['f1']->pinnedVersion);
            $this->assertFalse($tx->getUserState(['f2'], 'alice')['f2']->disabled);
            $f = $tx->getFeature('f1');
            $this->assertSame(['1.1.0', 's', 'iframe'], [$f->currentVersion, $f->slotId, $f->mode]);
            $this->assertNull($tx->getFeature('nope'));
        });
    }

    public function testLargeIdListsAreChunked(): void
    {
        $ids = array_map(static fn (int $i): string => "f$i", range(1, 1000));
        $this->storage->transaction(function (StorageTx $tx) use ($ids): void {
            $this->assertCount(1000, $tx->getAssignments($ids));
            $this->assertCount(1000, $tx->getUserState($ids, 'alice'));
        });
    }

    public function testIdsThatLookLikeNumbersKeepWorking(): void
    {
        $this->storage->transaction(function (StorageTx $tx): void {
            $tx->insertFeature(new FeatureRec('123', 'T', 'slot', null, 'main', 'inject', 'pkg', '1', 'alice', null, 'c'));
            $tx->addAssignment('123', 'alice', $tx->nextSeq());
        }, true);
        $this->storage->transaction(function (StorageTx $tx): void {
            $this->assertCount(1, $tx->getAssignments(['123'])['123']);
            $this->assertSame('123', $tx->listVisibleFeatures('alice')[0]->id);
        });
    }

    public function testAJoinedOuterTransactionIsLeftToTheCaller(): void
    {
        $pdo = new \PDO('sqlite:' . $this->db, null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
        $storage = new SqlStorage($pdo);
        $pdo->exec('BEGIN IMMEDIATE');
        $storage->transaction(static fn (StorageTx $tx) => $tx->insertRequest(self::rec('joined')), true);
        $pdo->exec('ROLLBACK'); // would fail if the storage had committed the caller's transaction
        $this->assertNull($storage->transaction(static fn (StorageTx $tx) => $tx->getRequest('joined')));
    }

    public function testASharedPdoIsUsableAgainAfterAFailedTransaction(): void
    {
        $storage = new SqlStorage($this->pdo());
        try {
            $storage->transaction(static function (StorageTx $tx): void {
                $tx->insertRequest(self::rec('gone'));
                throw new \RuntimeException('boom');
            }, true);
        } catch (\RuntimeException) {
        }
        $this->assertNull($storage->transaction(static fn (StorageTx $tx) => $tx->getRequest('gone')), 'rolled back on the same connection');
        $storage->transaction(static fn (StorageTx $tx) => $tx->insertRequest(self::rec('kept')), true);
        $this->assertNotNull((new SqlStorage($this->pdo()))->transaction(static fn (StorageTx $tx) => $tx->getRequest('kept')), 'and the connection did not keep a transaction open');
    }

    public function testExistingPdoIsAcceptedAndPutIntoExceptionMode(): void
    {
        $pdo = new \PDO('sqlite:' . $this->db);
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_SILENT);
        $storage = new SqlStorage($pdo);
        $storage->migrate();
        $this->expectException(\PDOException::class);
        $storage->transaction(static fn (StorageTx $tx) => $tx->insertRequest(self::rec('dup')), true);
        $storage->transaction(static fn (StorageTx $tx) => $tx->insertRequest(self::rec('dup')), true);
    }

    public function testDialects(): void
    {
        $this->assertSame('postgres', Dialect::named('pgsql')->name);
        $this->assertSame('mysql', Dialect::named('MariaDB')->name);
        $this->assertSame('sqlite', Dialect::detect($this->pdo())->name);
        $this->assertStringContainsString('ON CONFLICT DO NOTHING', Dialect::postgres()->insertIgnore('t', 'a', '?'));
        $this->assertStringStartsWith('INSERT IGNORE', Dialect::mysql()->insertIgnore('t', 'a', '?'));
        $this->assertStringContainsString('utf8mb4_bin', Dialect::mysql()->ddl('CREATE TABLE t (a {KEY} NOT NULL)'));
        $this->assertStringEndsWith('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4', Dialect::mysql()->ddl('CREATE TABLE t (a {KEY})'));
        $this->assertStringNotContainsString('ENGINE', Dialect::mysql()->ddl('ALTER TABLE t ADD b {KEY}'));
        $this->assertSame('CREATE TABLE t (a VARCHAR(190), b TEXT, c BIGINT)', Dialect::postgres()->ddl('CREATE TABLE t (a {KEY}, b {TEXT}, c {BIGINT})'));
        $this->expectException(\InvalidArgumentException::class);
        Dialect::named('oracle');
    }

    public function testBusyWriterWaitsForTheLockInsteadOfFailing(): void
    {
        $blocker = $this->pdo();
        $blocker->exec('BEGIN IMMEDIATE');
        $quick = SqlStorage::sqlite($this->db, 0.2);
        $this->expectException(\PDOException::class); // bounded by the busy timeout, not hung
        try {
            $quick->transaction(static fn (StorageTx $tx) => $tx->nextSeq(), true);
        } finally {
            $blocker->exec('ROLLBACK');
        }
    }
}
