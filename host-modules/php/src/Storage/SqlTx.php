<?php

declare(strict_types=1);

namespace HandOfClient\Host\Storage;

use HandOfClient\Host\Json;

/** One SQL transaction. Created by SqlStorage::transaction(); SQL uses ? placeholders on every dialect. */
final class SqlTx implements StorageTx
{
    private const REQ_COLS = 'id, seq, user_id, user_name, user_email, text, status, message, feature_id, change_of, mode, snapshot, build_id, created_at, updated_at';
    private const FEAT_COLS = 'id, title, kind, path, slot_id, mode, package_id, current_version, owner_user_id, request_id, created_at';
    private const VER_COLS = 'feature_id, version, published_at, request_id, sha256, entry, seq';
    private const REQ_UPDATABLE = ['status' => 'status', 'message' => 'message', 'featureId' => 'feature_id', 'buildId' => 'build_id', 'updatedAt' => 'updated_at'];
    private const FEAT_UPDATABLE = ['currentVersion' => 'current_version', 'slotId' => 'slot_id', 'mode' => 'mode'];
    private const CHUNK = 400;
    private const RETRY_COUNTER = 'build_retry_at';

    public function __construct(private readonly \PDO $pdo, private readonly Dialect $dialect)
    {
    }

    /** @param list<mixed> $params */
    private function exec(string $sql, array $params = []): \PDOStatement
    {
        $st = $this->pdo->prepare($sql);
        foreach (array_values($params) as $i => $p) {
            $st->bindValue($i + 1, $p, is_int($p) ? \PDO::PARAM_INT : ($p === null ? \PDO::PARAM_NULL : \PDO::PARAM_STR));
        }
        $st->execute();

        return $st;
    }

    /**
     * @param list<mixed> $params
     * @return list<list<mixed>>
     */
    private function all(string $sql, array $params = []): array
    {
        $st = $this->exec($sql, $params);
        $rows = $st->fetchAll(\PDO::FETCH_NUM);
        $st->closeCursor();

        return $rows;
    }

    /**
     * @param list<mixed> $params
     * @return list<mixed>|null
     */
    private function one(string $sql, array $params = []): ?array
    {
        $st = $this->exec($sql, $params);
        $row = $st->fetch(\PDO::FETCH_NUM);
        $st->closeCursor();

        return $row === false ? null : $row;
    }

    private static function ns(mixed $v): ?string
    {
        return $v === null ? null : (string) $v;
    }

    // ---- counters / events / settings
    public function nextSeq(): int
    {
        $this->exec('UPDATE hoc_counters SET value = value + 1 WHERE name = ?', ['seq']);
        $row = $this->one('SELECT value FROM hoc_counters WHERE name = ?', ['seq']);
        if ($row === null) {
            throw new \RuntimeException("hoc_counters is missing its 'seq' row; run SqlStorage::migrate()");
        }

        return (int) $row[0];
    }

    public function recordEvent(string $eventId, string $receivedAt): bool
    {
        return $this->exec($this->dialect->insertIgnore('hoc_events', 'event_id, received_at', '?, ?'), [$eventId, $receivedAt])->rowCount() === 1;
    }

    public function getSettings(): ?array
    {
        $row = $this->one('SELECT value FROM hoc_settings WHERE name = ?', ['settings']);

        return $row === null ? null : Json::decode((string) $row[0]);
    }

    public function saveSettings(array $settings): void
    {
        $this->exec('DELETE FROM hoc_settings WHERE name = ?', ['settings']);
        $this->exec('INSERT INTO hoc_settings (name, value) VALUES (?, ?)', ['settings', Json::encode($settings)]);
    }

    public function getBuildRetryAt(): int
    {
        $row = $this->one('SELECT value FROM hoc_counters WHERE name = ?', [self::RETRY_COUNTER]);

        return $row === null ? 0 : (int) $row[0];
    }

    public function swapBuildRetryAt(int $expected, int $new): bool
    {
        if ($expected === 0 && $this->one('SELECT 1 FROM hoc_counters WHERE name = ?', [self::RETRY_COUNTER]) === null) {
            return $this->exec($this->dialect->insertIgnore('hoc_counters', 'name, value', '?, ?'), [self::RETRY_COUNTER, $new])->rowCount() === 1;
        }

        return $this->exec('UPDATE hoc_counters SET value = ? WHERE name = ? AND value = ?', [$new, self::RETRY_COUNTER, $expected])->rowCount() === 1;
    }

    // ---- requests
    /** @param list<mixed> $r */
    private static function req(array $r): RequestRec
    {
        return new RequestRec(
            (string) $r[0], (int) $r[1], (string) $r[2], self::ns($r[3]), self::ns($r[4]), (string) $r[5], (string) $r[6], self::ns($r[7]),
            self::ns($r[8]), self::ns($r[9]), (string) $r[10], self::ns($r[11]), self::ns($r[12]), (string) $r[13], (string) $r[14],
        );
    }

    public function insertRequest(RequestRec $r): void
    {
        $this->exec(
            'INSERT INTO hoc_requests (' . self::REQ_COLS . ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [$r->id, $r->seq, $r->userId, $r->userName, $r->userEmail, $r->text, $r->status, $r->message, $r->featureId, $r->changeOf, $r->mode, $r->snapshot, $r->buildId, $r->createdAt, $r->updatedAt],
        );
    }

    public function getRequest(string $requestId): ?RequestRec
    {
        $row = $this->one('SELECT ' . self::REQ_COLS . ' FROM hoc_requests WHERE id = ?', [$requestId]);

        return $row === null ? null : self::req($row);
    }

    public function updateRequest(string $requestId, array $fields): void
    {
        [$sets, $values] = self::assignments($fields, self::REQ_UPDATABLE, 'request');
        $this->exec("UPDATE hoc_requests SET $sets WHERE id = ?", [...$values, $requestId]);
    }

    public function listRequests(?string $userId, array $statuses, int $limit, int $offset): array
    {
        $where = [];
        $params = [];
        if ($userId !== null) {
            $where[] = 'user_id = ?';
            $params[] = $userId;
        }
        if ($statuses) {
            $where[] = 'status IN (' . implode(', ', array_fill(0, count($statuses), '?')) . ')';
            array_push($params, ...array_values($statuses));
        }
        $clause = $where ? ' WHERE ' . implode(' AND ', $where) : '';
        $rows = $this->all('SELECT ' . self::REQ_COLS . " FROM hoc_requests$clause ORDER BY seq DESC LIMIT ? OFFSET ?", [...$params, $limit + 1, $offset]);

        return [array_map([self::class, 'req'], array_slice($rows, 0, $limit)), count($rows) > $limit];
    }

    public function listUnstartedBuilds(int $limit): array
    {
        $rows = $this->all('SELECT ' . self::REQ_COLS . ' FROM hoc_requests WHERE build_id IS NULL AND status = ? ORDER BY seq LIMIT ?', ['InProgress', $limit]);

        return array_map([self::class, 'req'], $rows);
    }

    // ---- features
    /** @param list<mixed> $r */
    private static function feat(array $r): FeatureRec
    {
        return new FeatureRec(
            (string) $r[0], (string) $r[1], (string) $r[2], self::ns($r[3]), (string) $r[4], (string) $r[5], (string) $r[6], (string) $r[7],
            (string) $r[8], self::ns($r[9]), (string) $r[10],
        );
    }

    public function getFeature(string $featureId): ?FeatureRec
    {
        $row = $this->one('SELECT ' . self::FEAT_COLS . ' FROM hoc_features WHERE id = ?', [$featureId]);

        return $row === null ? null : self::feat($row);
    }

    public function insertFeature(FeatureRec $f): void
    {
        $this->exec(
            'INSERT INTO hoc_features (' . self::FEAT_COLS . ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [$f->id, $f->title, $f->kind, $f->path, $f->slotId, $f->mode, $f->packageId, $f->currentVersion, $f->ownerUserId, $f->requestId, $f->createdAt],
        );
    }

    public function updateFeature(string $featureId, array $fields): void
    {
        [$sets, $values] = self::assignments($fields, self::FEAT_UPDATABLE, 'feature');
        $this->exec("UPDATE hoc_features SET $sets WHERE id = ?", [...$values, $featureId]);
    }

    public function listVisibleFeatures(string $userId, ?string $path = null): array
    {
        $cols = implode(', ', array_map(static fn (string $c): string => 'f.' . trim($c), explode(',', self::FEAT_COLS)));
        $sql = "SELECT $cols FROM hoc_features f WHERE EXISTS "
            . '(SELECT 1 FROM hoc_assignments a WHERE a.feature_id = f.id AND (a.everyone = 1 OR (a.everyone = 0 AND a.user_id = ?)))';
        $params = [$userId];
        if ($path !== null) {
            $sql .= ' AND f.path = ?';
            $params[] = $path;
        }
        $sql .= ' ORDER BY f.created_at, f.id';

        return array_map([self::class, 'feat'], $this->all($sql, $params));
    }

    public function getAssignments(array $featureIds): array
    {
        $out = [];
        foreach ($featureIds as $id) {
            $out[$id] = [];
        }
        foreach (array_chunk(array_values($featureIds), self::CHUNK) as $chunk) {
            $marks = implode(', ', array_fill(0, count($chunk), '?'));
            foreach ($this->all("SELECT feature_id, everyone, user_id, seq FROM hoc_assignments WHERE feature_id IN ($marks) ORDER BY seq", $chunk) as [$fid, $everyone, $uid, $seq]) {
                $out[$fid][] = new Assignment((int) $everyone === 1 ? null : (string) $uid, (int) $seq);
            }
        }

        return $out;
    }

    public function getUserState(array $featureIds, string $userId): array
    {
        $out = [];
        foreach ($featureIds as $id) {
            $out[$id] = new UserState();
        }
        foreach (array_chunk(array_values($featureIds), self::CHUNK) as $chunk) {
            $marks = implode(', ', array_fill(0, count($chunk), '?'));
            foreach ($this->all("SELECT feature_id, version FROM hoc_pins WHERE user_id = ? AND feature_id IN ($marks)", [$userId, ...$chunk]) as [$fid, $version]) {
                $out[$fid]->pinnedVersion = (string) $version;
            }
            foreach ($this->all("SELECT feature_id FROM hoc_disabled WHERE user_id = ? AND feature_id IN ($marks)", [$userId, ...$chunk]) as [$fid]) {
                $out[$fid]->disabled = true;
            }
        }

        return $out;
    }

    public function addAssignment(string $featureId, ?string $userId, int $seq): void
    {
        [$everyone, $uid] = $userId === null ? [1, ''] : [0, $userId];
        $this->exec($this->dialect->insertIgnore('hoc_assignments', 'feature_id, everyone, user_id, seq', '?, ?, ?, ?'), [$featureId, $everyone, $uid, $seq]);
    }

    public function removeAssignment(string $featureId, ?string $userId): void
    {
        [$everyone, $uid] = $userId === null ? [1, ''] : [0, $userId];
        $this->exec('DELETE FROM hoc_assignments WHERE feature_id = ? AND everyone = ? AND user_id = ?', [$featureId, $everyone, $uid]);
        if ($userId !== null) {
            $this->setPin($featureId, $userId, null);
        }
    }

    public function setPin(string $featureId, string $userId, ?string $version): void
    {
        $this->exec('DELETE FROM hoc_pins WHERE feature_id = ? AND user_id = ?', [$featureId, $userId]);
        if ($version !== null) {
            $this->exec('INSERT INTO hoc_pins (feature_id, user_id, version) VALUES (?, ?, ?)', [$featureId, $userId, $version]);
        }
    }

    public function setDisabled(string $featureId, string $userId, bool $disabled): void
    {
        $this->exec('DELETE FROM hoc_disabled WHERE feature_id = ? AND user_id = ?', [$featureId, $userId]);
        if ($disabled) {
            $this->exec('INSERT INTO hoc_disabled (feature_id, user_id) VALUES (?, ?)', [$featureId, $userId]);
        }
    }

    // ---- versions
    /** @param list<mixed> $r */
    private static function ver(array $r): VersionRec
    {
        return new VersionRec((string) $r[0], (string) $r[1], (string) $r[2], self::ns($r[3]), (string) $r[4], (string) $r[5], (int) $r[6]);
    }

    public function getVersion(string $featureId, string $version): ?VersionRec
    {
        $row = $this->one('SELECT ' . self::VER_COLS . ' FROM hoc_versions WHERE feature_id = ? AND version = ?', [$featureId, $version]);

        return $row === null ? null : self::ver($row);
    }

    public function listVersions(string $featureId): array
    {
        return array_map([self::class, 'ver'], $this->all('SELECT ' . self::VER_COLS . ' FROM hoc_versions WHERE feature_id = ? ORDER BY seq DESC', [$featureId]));
    }

    public function upsertVersion(VersionRec $v): void
    {
        $this->exec('DELETE FROM hoc_versions WHERE feature_id = ? AND version = ?', [$v->featureId, $v->version]);
        $this->exec(
            'INSERT INTO hoc_versions (' . self::VER_COLS . ') VALUES (?, ?, ?, ?, ?, ?, ?)',
            [$v->featureId, $v->version, $v->publishedAt, $v->requestId, $v->sha256, $v->entry, $v->seq],
        );
    }

    /**
     * @param array<string,mixed> $fields
     * @param array<string,string> $allowed field name => column
     * @return array{0:string,1:list<mixed>} "col = ?, col = ?" and the values
     */
    private static function assignments(array $fields, array $allowed, string $what): array
    {
        $bad = array_diff(array_keys($fields), array_keys($allowed));
        if ($bad || !$fields) {
            throw new \InvalidArgumentException("cannot update $what columns " . ($bad ? implode(', ', $bad) : '(none given)'));
        }

        return [
            implode(', ', array_map(static fn (string $k): string => $allowed[$k] . ' = ?', array_keys($fields))),
            array_values($fields),
        ];
    }
}
