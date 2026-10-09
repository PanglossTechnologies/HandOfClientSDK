<?php

declare(strict_types=1);

namespace HandOfClient\Host;

/** Timestamps: stored and sent as UTC ISO-8601 with milliseconds and a Z, e.g. 2026-10-09T18:00:05.123Z. */
final class TimeUtil
{
    public static function nowIso(): string
    {
        return (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.v\Z');
    }

    /** Parse an ISO-8601 timestamp (any fraction length; no zone = UTC). Null if it is not one. */
    public static function parseIso(mixed $value): ?\DateTimeImmutable
    {
        if (!is_string($value)) {
            return null;
        }
        if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/i', trim($value), $m)) {
            return null;
        }
        [$y, $mo, $d, $h, $mi, $s] = array_map('intval', array_slice($m, 1, 6));
        if (!checkdate($mo, $d, $y) || $h > 23 || $mi > 59 || $s > 59) {
            return null;
        }
        $micro = (int) str_pad(substr($m[7] ?? '', 0, 6), 6, '0');
        $offset = 0;
        $zone = $m[8] ?? '';
        if ($zone !== '' && strtoupper($zone) !== 'Z') {
            $digits = str_replace(':', '', substr($zone, 1));
            $offset = ($zone[0] === '+' ? 1 : -1) * ((int) substr($digits, 0, 2) * 3600 + (int) substr($digits, 2) * 60);
        }
        $epoch = gmmktime($h, $mi, $s, $mo, $d, $y) - $offset;

        return (new \DateTimeImmutable('@' . $epoch))->modify("+{$micro} microseconds");
    }
}
