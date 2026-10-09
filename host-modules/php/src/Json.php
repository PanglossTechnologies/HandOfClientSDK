<?php

declare(strict_types=1);

namespace HandOfClient\Host;

/** JSON helpers. PHP arrays cannot tell `[]` from `{}`, so object-ness is checked where it matters (see HostModule). */
final class Json
{
    public static function encode(mixed $value): string
    {
        return json_encode(
            $value,
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PRESERVE_ZERO_FRACTION | JSON_THROW_ON_ERROR,
        );
    }

    /**
     * @throws \JsonException on malformed JSON
     */
    public static function decode(string $raw, bool $assoc = true): mixed
    {
        return json_decode($raw, $assoc, 512, JSON_THROW_ON_ERROR);
    }

    /** True when the (decoded-as-array) value is a JSON array: empty, or keys 0..n-1. */
    public static function isList(mixed $value): bool
    {
        return is_array($value) && ($value === [] || array_keys($value) === range(0, count($value) - 1));
    }

    /** True for a decoded-as-array JSON object (a non-list array; an empty array is ambiguous and counts). */
    public static function isObject(mixed $value): bool
    {
        return is_array($value) && ($value === [] || !self::isList($value));
    }

    /** Deterministic JSON for comparing two structures: object keys sorted recursively. */
    public static function canonical(mixed $value): string
    {
        return self::encode(self::sorted($value));
    }

    private static function sorted(mixed $value): mixed
    {
        if (!is_array($value)) {
            return $value;
        }
        $out = array_map([self::class, 'sorted'], $value);
        if (!self::isList($out)) {
            ksort($out);
        }

        return $out;
    }
}
