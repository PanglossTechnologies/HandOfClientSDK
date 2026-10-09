<?php

declare(strict_types=1);

namespace HandOfClient\Host\Storage;

/** Who a feature is assigned to: a user id, or null for everyone. */
final class Assignment
{
    public function __construct(public ?string $userId, public int $seq)
    {
    }
}
