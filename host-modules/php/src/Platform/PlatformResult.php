<?php

declare(strict_types=1);

namespace HandOfClient\Host\Platform;

/** What a platform call answered. `status` is 0 when the platform could not be reached at all. */
final class PlatformResult
{
    public function __construct(public readonly int $status, public readonly mixed $body = null)
    {
    }

    public function ok(): bool
    {
        return $this->status >= 200 && $this->status < 300;
    }
}
