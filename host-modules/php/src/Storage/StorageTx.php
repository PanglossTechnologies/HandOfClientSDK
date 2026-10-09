<?php

declare(strict_types=1);

namespace HandOfClient\Host\Storage;

/**
 * One transaction, handed to the callback of Storage::transaction() and committed when it returns.
 * A dumb, rule-free record keeper: all the rules (visibility, sharing, precedence) live in the host module.
 */
interface StorageTx
{
    // ---- counters / events / settings

    /** A strictly increasing number (orders requests, versions and assignments). */
    public function nextSeq(): int;

    /** Remember a webhook event id. False if it was already recorded. */
    public function recordEvent(string $eventId, string $receivedAt): bool;

    /** @return array<string,mixed>|null */
    public function getSettings(): ?array;

    /** @param array<string,mixed> $settings */
    public function saveSettings(array $settings): void;

    /** Epoch seconds of the last background build retry (0 = never). */
    public function getBuildRetryAt(): int;

    /** Compare-and-swap of the above: true only if the stored value was still $expected. */
    public function swapBuildRetryAt(int $expected, int $new): bool;

    // ---- requests

    public function insertRequest(RequestRec $r): void;

    public function getRequest(string $requestId): ?RequestRec;

    /** @param array<string,mixed> $fields columns: status, message, featureId, buildId, updatedAt */
    public function updateRequest(string $requestId, array $fields): void;

    /**
     * Newest first (by seq). $userId null = everyone's.
     *
     * @param list<string> $statuses
     * @return array{0:list<RequestRec>,1:bool} the page and whether there is more
     */
    public function listRequests(?string $userId, array $statuses, int $limit, int $offset): array;

    /** @return list<RequestRec> InProgress requests that never got a buildId, oldest first */
    public function listUnstartedBuilds(int $limit): array;

    // ---- features

    public function getFeature(string $featureId): ?FeatureRec;

    public function insertFeature(FeatureRec $f): void;

    /** @param array<string,mixed> $fields columns: currentVersion, slotId, mode */
    public function updateFeature(string $featureId, array $fields): void;

    /**
     * Features assigned to $userId or to everyone, optionally only those whose path equals $path.
     *
     * @return list<FeatureRec>
     */
    public function listVisibleFeatures(string $userId, ?string $path = null): array;

    /**
     * @param list<string> $featureIds
     * @return array<string,list<Assignment>> every id present, ordered by seq
     */
    public function getAssignments(array $featureIds): array;

    /**
     * @param list<string> $featureIds
     * @return array<string,UserState> every id present
     */
    public function getUserState(array $featureIds, string $userId): array;

    /** Idempotent: an existing assignment is left untouched. */
    public function addAssignment(string $featureId, ?string $userId, int $seq): void;

    /** Also clears that user's pin. */
    public function removeAssignment(string $featureId, ?string $userId): void;

    public function setPin(string $featureId, string $userId, ?string $version): void;

    public function setDisabled(string $featureId, string $userId, bool $disabled): void;

    // ---- versions

    public function getVersion(string $featureId, string $version): ?VersionRec;

    /** @return list<VersionRec> newest first (by seq) */
    public function listVersions(string $featureId): array;

    /** Insert, or replace the version with the same (feature, version). */
    public function upsertVersion(VersionRec $v): void;
}
