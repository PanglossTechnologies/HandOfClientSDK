<?php

declare(strict_types=1);

namespace HandOfClient\Host;

use HandOfClient\Host\Storage\Assignment;
use HandOfClient\Host\Storage\FeatureRec;
use HandOfClient\Host\Storage\UserState;

/**
 * A feature with its assignments and the current user's state.
 *
 * @internal
 */
final class Loaded
{
    /** @param list<Assignment> $assignments */
    public function __construct(public readonly FeatureRec $feature, public readonly array $assignments, public readonly UserState $state)
    {
    }
}
