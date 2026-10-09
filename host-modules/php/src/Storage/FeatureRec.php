<?php

declare(strict_types=1);

namespace HandOfClient\Host\Storage;

/** A built feature (the unit of sharing, pinning and enabling). */
final class FeatureRec
{
    public function __construct(
        public string $id,
        public string $title,
        public string $kind,
        public ?string $path,
        public string $slotId,
        public string $mode,
        public string $packageId,
        public string $currentVersion,
        public string $ownerUserId,
        public ?string $requestId,
        public string $createdAt,
    ) {
    }
}
