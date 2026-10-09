<?php

declare(strict_types=1);

namespace HandOfClient\Host;

/**
 * Raised anywhere inside request handling; becomes {"error": code, "message": message} with the status
 * (stable codes: openapi/site-hoc-api.yaml).
 */
final class HocError extends \RuntimeException
{
    public function __construct(public readonly int $status, public readonly string $errorCode, string $message)
    {
        parent::__construct($message);
    }

    public static function unauthenticated(): self
    {
        return new self(401, 'unauthenticated', 'Please sign in.');
    }

    public static function invalid(string $message): self
    {
        return new self(400, 'invalid_request', $message);
    }

    public static function notFound(string $message = 'No such feature.'): self
    {
        return new self(404, 'not_found', $message);
    }

    public static function forbidden(string $message = 'You are not allowed to do this.'): self
    {
        return new self(403, 'forbidden', $message);
    }

    public static function platformUnavailable(): self
    {
        return new self(502, 'platform_unavailable', 'The HandOfClient platform could not be reached.');
    }
}
