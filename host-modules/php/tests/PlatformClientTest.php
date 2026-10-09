<?php

declare(strict_types=1);

namespace HandOfClient\Host\Tests;

use HandOfClient\Host\Json;
use HandOfClient\Host\Platform\PlatformClient;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Psr\Log\NullLogger;

final class PlatformClientTest extends TestCase
{
    /** @var resource|null */
    private static $server = null;
    private static int $port = 0;

    public static function setUpBeforeClass(): void
    {
        $sock = stream_socket_server('tcp://127.0.0.1:0');
        self::$port = (int) substr((string) strrchr((string) stream_socket_get_name($sock, false), ':'), 1);
        fclose($sock);
        $cmd = [PHP_BINARY, '-S', '127.0.0.1:' . self::$port, __DIR__ . '/Support/echo_server.php'];
        $proc = proc_open($cmd, [0 => ['pipe', 'r'], 1 => ['file', sys_get_temp_dir() . '/hoc-echo-out.txt', 'w'], 2 => ['file', sys_get_temp_dir() . '/hoc-echo-err.txt', 'w']], $pipes);
        self::$server = is_resource($proc) ? $proc : null;
        for ($i = 0; $i < 100; $i++) {
            $c = @fsockopen('127.0.0.1', self::$port, $errno, $errstr, 0.2);
            if ($c !== false) {
                fclose($c);

                return;
            }
            usleep(100_000);
        }
        self::fail('the test server did not start');
    }

    public static function tearDownAfterClass(): void
    {
        if (self::$server !== null) {
            proc_terminate(self::$server); // the array form of proc_open starts php directly, with no shell in between
            proc_close(self::$server);
        }
    }

    /** @return array<string,array{callable}> */
    public static function transports(): array
    {
        $t = ['stream' => [[PlatformClient::class, 'streamTransport']]];
        if (extension_loaded('curl')) {
            $t['curl'] = [[PlatformClient::class, 'curlTransport']];
        }

        return $t;
    }

    private function client(callable $transport, string $base = '', float $timeout = 5.0): PlatformClient
    {
        return new PlatformClient($base !== '' ? $base : 'http://127.0.0.1:' . self::$port . '/', 'key-1', 'tenant-1', $timeout, $transport, new NullLogger());
    }

    #[DataProvider('transports')]
    public function testRealHttpRoundTripShapesTheRequest(callable $transport): void
    {
        $res = $this->client($transport)->embedToken('alice', 'acme/f-1', 'main', '1.2.3');
        $this->assertSame(200, $res->status);
        $this->assertSame('POST', $res->body['method']);
        $this->assertSame('/host/v1/embed-token', $res->body['uri']);
        $this->assertSame('key-1', $res->body['apiKey']);
        $this->assertSame('application/json', $res->body['contentType']);
        $this->assertSame(['tenantId' => 'tenant-1', 'userId' => 'alice', 'packageId' => 'acme/f-1', 'slotId' => 'main', 'version' => '1.2.3'], Json::decode($res->body['body']));
    }

    #[DataProvider('transports')]
    public function testEveryCallUsesTheContractsMethodPathAndBody(callable $transport): void
    {
        $c = $this->client($transport);
        $seen = [];
        foreach ([
            $c->startBuild('req-1', ['id' => 'alice', 'name' => 'Alice'], 'make it red', 'inject', (object) ['url' => 'u', 'o' => new \stdClass()], ['ref' => 'f', 'packageId' => 'p']),
            $c->startBuild('req-2', ['id' => 'bob'], 'x', 'iframe'),
            $c->replyToBuild('b 1/2', 'answer'),
            $c->embedToken('alice', 'p', 's', null),
            $c->putSecret('orders-key', 'v', 'admin'),
            $c->putDataSources([['name' => 'a', 'baseUrl' => 'https://x']]),
        ] as $res) {
            $seen[] = [$res->body['method'], $res->body['uri'], $res->body['body']];
        }
        $this->assertSame(['POST', '/host/v1/builds', '{"tenantId":"tenant-1","requestRef":"req-1","user":{"id":"alice","name":"Alice"},"text":"make it red","mode":"inject","snapshot":{"url":"u","o":{}},"feature":{"ref":"f","packageId":"p"}}'], $seen[0]);
        $this->assertSame('{"tenantId":"tenant-1","requestRef":"req-2","user":{"id":"bob"},"text":"x","mode":"iframe"}', $seen[1][2], 'no snapshot / feature when there are none');
        $this->assertSame(['POST', '/host/v1/builds/b%201%2F2/reply', '{"text":"answer"}'], $seen[2]);
        $this->assertSame('{"tenantId":"tenant-1","userId":"alice","packageId":"p","slotId":"s"}', $seen[3][2], 'no version key: tenant activation');
        $this->assertSame(['PUT', '/host/v1/secrets', '{"tenantId":"tenant-1","name":"orders-key","value":"v","updatedBy":"admin"}'], $seen[4]);
        $this->assertSame(['PUT', '/host/v1/data-sources', '{"tenantId":"tenant-1","dataSources":[{"name":"a","baseUrl":"https://x"}]}'], $seen[5]);
    }

    #[DataProvider('transports')]
    public function testErrorStatusesBodiesAndNetworkFailures(callable $transport): void
    {
        $base = 'http://127.0.0.1:' . self::$port;
        $r = $this->client($transport, "$base/x?status=409&raw=%7B%22a%22%3A1%7D#")->putDataSources([]);
        $this->assertSame(409, $r->status, 'a 4xx body is still read (ignore_errors / curl)');
        $this->assertFalse($r->ok());
        $r = $this->client($transport, "$base/?status=200&raw=notjson#")->putDataSources([]);
        $this->assertSame([200, null, true], [$r->status, $r->body, $r->ok()], 'a non-JSON body is null, not an error');
        $r = $this->client($transport, "$base/?status=204&raw=#")->putDataSources([]);
        $this->assertSame(204, $r->status);
        $this->assertSame(0, $this->client($transport, 'http://127.0.0.1:1')->putDataSources([])->status, 'refused connection = status 0');
        $this->assertSame(500, $this->client($transport, "$base/?status=500&raw=#")->putDataSources([])->status);
    }

    #[DataProvider('transports')]
    public function testSlowPlatformTimesOutAsStatusZero(callable $transport): void
    {
        $started = microtime(true);
        $r = $this->client($transport, 'http://127.0.0.1:' . self::$port . '/?sleep=3#', 0.5)->putDataSources([]);
        $this->assertSame(0, $r->status);
        $this->assertLessThan(2.5, microtime(true) - $started);
    }

    public function testCustomTransportAndConfigurationErrors(): void
    {
        $calls = [];
        $c = new PlatformClient('https://platform.example/', 'k', 't', 3.0, static function (string $m, string $url, array $h, ?string $body, float $timeout) use (&$calls): array {
            $calls[] = [$m, $url, $h['x-api-key'], $timeout];

            return [200, '{"buildId":"b1"}'];
        });
        $res = $c->startBuild('r', ['id' => 'u'], 't', 'inject');
        $this->assertSame(['b1'], [$res->body['buildId']]);
        $this->assertSame([['POST', 'https://platform.example/host/v1/builds', 'k', 3.0]], $calls);
        $boom = new PlatformClient('https://p', 'k', 't', 1.0, static function (): never {
            throw new \RuntimeException('network down');
        }, new NullLogger());
        $this->assertSame(0, $boom->putDataSources([])->status);
        foreach ([['', 'k', 't'], ['https://p', '', 't'], ['https://p', 'k', '']] as $args) {
            try {
                new PlatformClient(...$args);
                $this->fail('expected InvalidArgumentException');
            } catch (\InvalidArgumentException) {
                $this->addToAssertionCount(1);
            }
        }
    }
}
