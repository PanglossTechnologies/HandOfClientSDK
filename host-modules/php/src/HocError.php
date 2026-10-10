<?php

declare(strict_types=1);

namespace HandOfClient\Host;

use HandOfClient\Host\Platform\PlatformResult;

/**
 * Raised anywhere inside request handling; becomes {"error": code, "message": message} with the status
 * (stable codes: openapi/site-hoc-api.yaml).
 *
 * `field`/`reason` (plus `values`/`limit`) are machine-readable debugging detail, no human text: which input
 * was wrong and why. `platform` is what the platform answered when a platform call failed (`status` 0 means
 * it could not be reached).
 */
final class HocError extends \RuntimeException
{
    /**
     * @param list<string>|null $values
     * @param array<string,mixed>|null $platform
     */
    public function __construct(
        public readonly int $status,
        public readonly string $errorCode,
        string $message,
        public readonly ?string $field = null,
        public readonly ?string $reason = null,
        public readonly ?array $values = null,
        public readonly ?int $limit = null,
        public readonly ?array $platform = null,
    ) {
        parent::__construct($message);
    }

    /** @return array<string,mixed> */
    public function toPayload(): array
    {
        $out = ['error' => $this->errorCode, 'message' => $this->getMessage()];
        if ($this->field !== null) {
            $out['field'] = $this->field;
            $out['reason'] = $this->reason;
            if ($this->values !== null && $this->values !== []) {
                $out['values'] = $this->values;
            }
            if ($this->limit !== null) {
                $out['limit'] = $this->limit;
            }
        }
        if ($this->platform !== null) {
            $out['platform'] = $this->platform;
        }
        return $out;
    }

    /** Distil a failed platform call into the `platform` block of an error. @return array<string,mixed> */
    public static function platformFailure(PlatformResult $res): array
    {
        $out = ['status' => $res->status];
        $b = $res->body;
        if (is_array($b)) {
            if (is_string($b['error'] ?? null)) {
                $out['error'] = $b['error'];
            }
            if (is_string($b['field'] ?? null)) {
                $out['field'] = $b['field'];
            }
            if (is_string($b['reason'] ?? null)) {
                $out['reason'] = $b['reason'];
            }
            if (is_array($b['values'] ?? null)) {
                $out['values'] = array_map('strval', array_values($b['values']));
            }
            if (is_int($b['limit'] ?? null)) {
                $out['limit'] = $b['limit'];
            }
        }
        return $out;
    }

    public static function unauthenticated(): self
    {
        return new self(401, 'unauthenticated', 'Please sign in.');
    }

    /** @param list<string>|null $values */
    public static function invalid(string $message, string $field, string $reason, ?array $values = null, ?int $limit = null): self
    {
        return new self(400, 'invalid_request', $message, $field, $reason, $values, $limit);
    }

    public static function notFound(string $message = 'No such feature.'): self
    {
        return new self(404, 'not_found', $message);
    }

    public static function forbidden(string $message = 'You are not allowed to do this.'): self
    {
        return new self(403, 'forbidden', $message);
    }

    public static function platformUnavailable(?PlatformResult $res = null): self
    {
        return new self(
            502,
            'platform_unavailable',
            'The HandOfClient platform could not be reached.',
            platform: $res === null ? null : self::platformFailure($res),
        );
    }
}
