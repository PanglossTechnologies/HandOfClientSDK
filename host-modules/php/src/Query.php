<?php

declare(strict_types=1);

namespace HandOfClient\Host;

/** Query strings as name => list of values (a name may repeat: status=A&status=B). PHP's own $_GET keeps only the last. */
final class Query
{
    /**
     * @param string|array<string,mixed>|null $query raw query string (with or without the leading ?), or an already-parsed map
     * @return array<string,list<string>>
     */
    public static function parse(string|array|null $query): array
    {
        if ($query === null || $query === '') {
            return [];
        }
        if (is_array($query)) {
            $out = [];
            foreach ($query as $name => $value) {
                $values = is_array($value) ? array_values($value) : [$value];
                $out[(string) $name] = array_map(static fn ($v): string => is_scalar($v) ? (string) $v : '', $values);
            }

            return $out;
        }
        $out = [];
        foreach (explode('&', ltrim($query, '?')) as $pair) {
            if ($pair === '') {
                continue;
            }
            $parts = explode('=', $pair, 2);
            $out[urldecode($parts[0])][] = urldecode($parts[1] ?? '');
        }

        return $out;
    }
}
