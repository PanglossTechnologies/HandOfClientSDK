<?php

declare(strict_types=1);

namespace HandOfClient\Host\Storage;

/** One user's pin and on/off switch for one feature. */
final class UserState
{
    public function __construct(public ?string $pinnedVersion = null, public bool $disabled = false)
    {
    }
}
