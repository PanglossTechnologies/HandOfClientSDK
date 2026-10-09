<?php

declare(strict_types=1);

namespace HandOfClient\Host\Storage;

/** A customer's "I want X" request. `snapshot` is JSON text. */
final class RequestRec
{
    public function __construct(
        public string $id,
        public int $seq,
        public string $userId,
        public ?string $userName,
        public ?string $userEmail,
        public string $text,
        public string $status,
        public ?string $message,
        public ?string $featureId,
        public ?string $changeOf,
        public string $mode,
        public ?string $snapshot,
        public ?string $buildId,
        public string $createdAt,
        public string $updatedAt,
    ) {
    }
}
