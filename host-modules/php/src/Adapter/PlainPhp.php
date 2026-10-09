<?php

declare(strict_types=1);

namespace HandOfClient\Host\Adapter;

use HandOfClient\Host\HocResponse;
use HandOfClient\Host\HostModule;

/**
 * Plain PHP (no framework): call this near the top of your front controller.
 *
 *     if (PlainPhp::serve($module, '/hoc')) {
 *         exit;
 *     }
 *     // ...your own routing continues here
 *
 * It answers only requests under the prefix and returns false for everything else. `getCurrentUser` receives null
 * (read $_SESSION / $_COOKIE yourself). Start your session before calling serve() if getCurrentUser needs it.
 */
final class PlainPhp
{
    /**
     * Turn the current request into a HocResponse without sending anything; null when the request is not under $prefix.
     *
     * @param array<string,mixed>|null $server defaults to $_SERVER
     * @param string|null $body defaults to php://input
     */
    public static function dispatch(HostModule $module, string $prefix = '/hoc', ?array $server = null, ?string $body = null): ?HocResponse
    {
        $server ??= $_SERVER;
        $prefix = '/' . trim($prefix, '/');
        $uri = (string) ($server['REQUEST_URI'] ?? '');
        $rawPath = (string) strtok($uri, '?');
        if (preg_match('#^[A-Za-z][A-Za-z0-9+.-]*://[^/]*#', $rawPath, $m)) { // absolute-form request target
            $rawPath = substr($rawPath, strlen($m[0]));
        }
        if ($rawPath !== $prefix && !str_starts_with($rawPath, $prefix . '/')) {
            return null;
        }
        $query = array_key_exists('QUERY_STRING', $server) ? (string) $server['QUERY_STRING'] : (str_contains($uri, '?') ? substr($uri, strpos($uri, '?') + 1) : '');

        return $module->handle(
            (string) ($server['REQUEST_METHOD'] ?? 'GET'),
            rawurldecode(substr($rawPath, strlen($prefix))),
            $query,
            self::headers($server),
            $body ?? (string) file_get_contents('php://input'),
            null,
        );
    }

    /** Answer the request if it is under $prefix (status, headers, body), then run the module's deferred work. */
    public static function serve(HostModule $module, string $prefix = '/hoc'): bool
    {
        $response = self::dispatch($module, $prefix);
        if ($response === null) {
            return false;
        }
        http_response_code($response->status);
        foreach ($response->headers() as $name => $value) {
            header("$name: $value");
        }
        echo $response->body();
        if (function_exists('fastcgi_finish_request')) {
            fastcgi_finish_request(); // the browser has its answer; retries below don't delay it
        }
        $module->runDeferred();

        return true;
    }

    /**
     * @param array<string,mixed> $server
     * @return array<string,string>
     */
    public static function headers(array $server): array
    {
        $headers = [];
        foreach ($server as $key => $value) {
            if (!is_string($value)) {
                continue;
            }
            if (str_starts_with($key, 'HTTP_')) {
                $headers[strtolower(str_replace('_', '-', substr($key, 5)))] = $value;
            } elseif ($key === 'CONTENT_TYPE' || $key === 'CONTENT_LENGTH') {
                $headers[strtolower(str_replace('_', '-', $key))] = $value;
            }
        }

        return $headers;
    }
}
