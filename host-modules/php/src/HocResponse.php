<?php

declare(strict_types=1);

namespace HandOfClient\Host;

/** What the host module answers: a status and a JSON payload (null = empty body). */
final class HocResponse
{
    /** Sent with every response: JSON, and never cached (answers depend on the signed-in user). */
    public const HEADERS = ['content-type' => 'application/json; charset=utf-8', 'cache-control' => 'no-store'];

    public function __construct(public readonly int $status, public readonly mixed $payload = null)
    {
    }

    public function body(): string
    {
        return $this->payload === null ? '' : Json::encode($this->payload);
    }

    /** @return array<string,string> */
    public function headers(): array
    {
        return self::HEADERS;
    }
}
