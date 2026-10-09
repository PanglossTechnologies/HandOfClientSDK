<?php

declare(strict_types=1);

namespace HandOfClient\Host;

/**
 * One authenticated call as the route handlers see it.
 *
 * @internal
 */
final class Call
{
    public ?bool $admin = null;

    /**
     * @param array<string,list<string>> $query
     * @param list<string> $params the route's captured path segments
     */
    public function __construct(
        public readonly HocUser $user,
        public readonly array $query,
        public readonly mixed $body,
        public readonly string $rawBody,
        public readonly bool $bodyIsObject,
        public readonly array $params,
    ) {
    }

    /** The request body when it is a JSON object (`{...}`), else null. */
    public function object(): ?array
    {
        return $this->bodyIsObject && is_array($this->body) ? $this->body : null;
    }
}
