<?php

declare(strict_types=1);

namespace HandOfClient\Host\Storage;

/** One published version of a feature. */
final class VersionRec
{
    public function __construct(
        public string $featureId,
        public string $version,
        public string $publishedAt,
        public ?string $requestId,
        public string $sha256,
        public string $entry,
        public int $seq,
    ) {
    }
}
