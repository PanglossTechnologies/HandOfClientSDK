<?php

declare(strict_types=1);

namespace HandOfClient\Host;

/** Webhook signature check (see /webhook in openapi/site-hoc-api.yaml). */
final class Webhook
{
    public const SIGNATURE_HEADER = 'x-handofclient-signature';
    public const TOLERANCE_SECONDS = 300;

    /** "sha256=" + lowercase hex HMAC-SHA256 of the raw body. */
    public static function sign(string $secret, string $rawBody): string
    {
        return 'sha256=' . hash_hmac('sha256', $rawBody, $secret);
    }

    /** Constant-time comparison of the X-HandOfClient-Signature header against the raw body. */
    public static function verify(string $secret, string $rawBody, ?string $header): bool
    {
        if ($header === null || $header === '') {
            return false;
        }

        return hash_equals(self::sign($secret, $rawBody), $header);
    }

    /** True when sentAt is unparsable or differs from now by more than the 300 s tolerance (either direction). */
    public static function isStale(mixed $sentAt, ?\DateTimeImmutable $now = null): bool
    {
        $t = TimeUtil::parseIso($sentAt);
        if ($t === null) {
            return true;
        }
        $now ??= new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        $diff = (float) $now->format('U.u') - (float) $t->format('U.u');

        return abs($diff) > self::TOLERANCE_SECONDS;
    }
}
