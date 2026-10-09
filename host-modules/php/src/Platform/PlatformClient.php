<?php

declare(strict_types=1);

namespace HandOfClient\Host\Platform;

use HandOfClient\Host\ErrorLogLogger;
use HandOfClient\Host\Json;
use Psr\Log\LoggerInterface;

/**
 * Client for the platform calls a site makes (/host/v1, authenticated with the host API key).
 *
 * Uses ext-curl when it is loaded and PHP streams (allow_url_fopen) otherwise; no other dependency. To use your
 * own HTTP client pass `transport`: callable(string $method, string $url, array<string,string> $headers,
 * ?string $body, float $timeout): array{0:int,1:string} returning [status, body] and throwing on network failure.
 */
final class PlatformClient implements PlatformApi
{
    private readonly string $baseUrl;
    private readonly LoggerInterface $logger;
    /** @var callable */
    private $transport;

    public function __construct(
        string $baseUrl,
        private readonly string $apiKey,
        private readonly string $tenantId,
        private readonly float $timeout = 10.0,
        ?callable $transport = null,
        ?LoggerInterface $logger = null,
    ) {
        if ($baseUrl === '' || $apiKey === '' || $tenantId === '') {
            throw new \InvalidArgumentException('PlatformClient needs baseUrl, apiKey and tenantId');
        }
        $this->baseUrl = rtrim($baseUrl, '/');
        $this->logger = $logger ?? new ErrorLogLogger();
        $this->transport = $transport ?? (extension_loaded('curl') ? [self::class, 'curlTransport'] : [self::class, 'streamTransport']);
    }

    /** @param array<string,mixed>|null $body */
    private function call(string $method, string $path, ?array $body = null): PlatformResult
    {
        $headers = ['x-api-key' => $this->apiKey, 'content-type' => 'application/json', 'accept' => 'application/json'];
        try {
            [$status, $raw] = ($this->transport)($method, $this->baseUrl . $path, $headers, $body === null ? null : Json::encode($body), $this->timeout);
        } catch (\Throwable $e) { // connection refused, DNS, timeout...
            $this->logger->warning('platform call {method} {path} failed', ['method' => $method, 'path' => $path, 'exception' => $e]);

            return new PlatformResult(0);
        }
        try {
            $parsed = $raw === '' ? null : Json::decode($raw);
        } catch (\JsonException) {
            $parsed = null;
        }
        if ($status >= 400) {
            $this->logger->warning('platform call {method} {path} answered {status}', ['method' => $method, 'path' => $path, 'status' => $status]);
        }

        return new PlatformResult($status, $parsed);
    }

    public function startBuild(string $requestRef, array $user, string $text, string $mode, array|object|null $snapshot = null, ?array $feature = null): PlatformResult
    {
        $body = ['tenantId' => $this->tenantId, 'requestRef' => $requestRef, 'user' => $user, 'text' => $text, 'mode' => $mode];
        if ($snapshot !== null && $snapshot !== [] && (array) $snapshot !== []) {
            $body['snapshot'] = $snapshot;
        }
        if ($feature) {
            $body['feature'] = $feature;
        }

        return $this->call('POST', '/host/v1/builds', $body);
    }

    public function replyToBuild(string $buildId, string $text): PlatformResult
    {
        return $this->call('POST', '/host/v1/builds/' . rawurlencode($buildId) . '/reply', ['text' => $text]);
    }

    public function embedToken(string $userId, string $packageId, string $slotId, ?string $version): PlatformResult
    {
        $body = ['tenantId' => $this->tenantId, 'userId' => $userId, 'packageId' => $packageId, 'slotId' => $slotId];
        if ($version !== null) {
            $body['version'] = $version;
        }

        return $this->call('POST', '/host/v1/embed-token', $body);
    }

    public function putSecret(string $name, string $value, string $updatedBy): PlatformResult
    {
        return $this->call('PUT', '/host/v1/secrets', ['tenantId' => $this->tenantId, 'name' => $name, 'value' => $value, 'updatedBy' => $updatedBy]);
    }

    public function putDataSources(array $dataSources): PlatformResult
    {
        return $this->call('PUT', '/host/v1/data-sources', ['tenantId' => $this->tenantId, 'dataSources' => array_values($dataSources)]);
    }

    /**
     * @param array<string,string> $headers
     * @return array{0:int,1:string}
     */
    public static function curlTransport(string $method, string $url, array $headers, ?string $body, float $timeout): array
    {
        $ch = curl_init($url);
        if ($ch === false) {
            throw new \RuntimeException('curl_init failed');
        }
        $lines = [];
        foreach ($headers as $name => $value) {
            $lines[] = "$name: $value";
        }
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $lines,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT_MS => (int) ($timeout * 1000),
            CURLOPT_CONNECTTIMEOUT_MS => (int) min($timeout * 1000, 5000),
            CURLOPT_FOLLOWLOCATION => false,
        ]);
        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }
        $raw = curl_exec($ch);
        if ($raw === false) {
            $error = curl_error($ch) . ' (' . curl_errno($ch) . ')';
            curl_close($ch);
            throw new \RuntimeException("curl: $error");
        }
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);

        return [$status, (string) $raw];
    }

    /**
     * @param array<string,string> $headers
     * @return array{0:int,1:string}
     */
    public static function streamTransport(string $method, string $url, array $headers, ?string $body, float $timeout): array
    {
        $lines = [];
        foreach ($headers as $name => $value) {
            $lines[] = "$name: $value";
        }
        $http = ['method' => $method, 'header' => implode("\r\n", $lines), 'timeout' => $timeout, 'ignore_errors' => true, 'follow_location' => 0];
        if ($body !== null) {
            $http['content'] = $body;
        }
        $raw = @file_get_contents($url, false, stream_context_create(['http' => $http]));
        if ($raw === false) {
            $last = error_get_last();
            throw new \RuntimeException('stream: ' . ($last['message'] ?? 'request failed'));
        }
        /** @var list<string> $http_response_header set by file_get_contents */
        $status = 0;
        foreach ($http_response_header ?? [] as $line) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m)) {
                $status = (int) $m[1]; // the last status line wins (redirects are not followed, but be safe)
            }
        }
        if ($status === 0) {
            throw new \RuntimeException('stream: no HTTP status in the response');
        }

        return [$status, $raw];
    }
}
