<?php

declare(strict_types=1);

namespace HandOfClient\Host\Tests\Support;

use HandOfClient\Host\HocResponse;
use HandOfClient\Host\HostModule;
use HandOfClient\Host\Json;
use HandOfClient\Host\Storage\SqlStorage;
use HandOfClient\Host\TimeUtil;
use HandOfClient\Host\Webhook;
use PHPUnit\Framework\Assert;
use Psr\Log\NullLogger;

/** A HostModule over a temp SQLite file. The "request" handed to getCurrentUser is just the user key. */
final class Host
{
    public const SECRET = 'whsec_test';
    public const USERS = [
        'admin' => ['id' => 'admin', 'name' => 'Ada Admin'],
        'alice' => ['id' => 'alice', 'name' => 'Alice Owner', 'email' => 'alice@example.com'],
        'bob' => ['id' => 'bob', 'name' => 'Bob Builder'],
    ];

    public FakePlatform $platform;
    public SqlStorage $storage;
    public HostModule $module;
    public string $dbPath;
    private int $n = 0;

    /** @param array<string,mixed> $overrides named HostModule constructor arguments */
    public function __construct(?string $dir = null, array $overrides = [])
    {
        $this->dbPath = ($dir ?? sys_get_temp_dir()) . DIRECTORY_SEPARATOR . 'hoc-' . bin2hex(random_bytes(6)) . '.db';
        $this->platform = new FakePlatform();
        $this->storage = SqlStorage::sqlite($this->dbPath);
        $args = [
            'storage' => $this->storage,
            'platform' => $this->platform,
            'webhookSecret' => self::SECRET,
            'getCurrentUser' => static fn ($req) => is_string($req) ? (self::USERS[$req] ?? null) : null,
            'isAdmin' => static fn ($u) => $u['id'] === 'admin',
            'findUsers' => static fn (string $q) => array_values(array_filter(
                self::USERS,
                static fn (array $u): bool => str_contains(strtolower($u['id']), strtolower($q)) || str_contains(strtolower($u['name']), strtolower($q)),
            )),
            'userExists' => static fn (string $id): bool => isset(self::USERS[$id]),
            'retryBuilds' => false,
            'logger' => new NullLogger(),
        ];
        $this->module = new HostModule(...array_merge($args, $overrides));
    }

    public function __destruct()
    {
        foreach (['', '-wal', '-shm'] as $suffix) {
            @unlink($this->dbPath . $suffix);
        }
    }

    /**
     * @param array<string,mixed>|null $body
     * @param array<string,mixed>|string|null $query
     */
    public function call(?string $user, string $method, string $path, ?array $body = null, array|string|null $query = null): HocResponse
    {
        return $this->module->handle($method, $path, $query, [], $body === null ? '' : Json::encode($body), $user);
    }

    public function raw(?string $user, string $method, string $path, string $rawBody): HocResponse
    {
        return $this->module->handle($method, $path, null, [], $rawBody, $user);
    }

    /** @param array<string,mixed> $fields */
    public function event(array $fields): HocResponse
    {
        $this->n++;
        $raw = Json::encode(['eventId' => "evt_{$this->n}", 'sentAt' => TimeUtil::nowIso()] + $fields);

        return $this->module->handle('POST', 'webhook', null, [Webhook::SIGNATURE_HEADER => Webhook::sign(self::SECRET, $raw)], $raw);
    }

    /** @param array<string,mixed> $extra */
    public function publish(string $requestId, string $version = '1.0.0', string $path = '/orders', array $extra = []): HocResponse
    {
        $res = $this->event($extra + [
            'type' => 'build.version', 'buildId' => 'b1', 'requestRef' => $requestId, 'featureRef' => $requestId, 'packageId' => "acme/f-$requestId",
            'version' => $version, 'sha256' => str_repeat('ab', 32), 'entry' => 'index.js', 'kind' => 'page-override', 'path' => $path, 'slotId' => 'main', 'mode' => 'inject',
        ]);
        Assert::assertSame(200, $res->status, Json::encode($res->payload));

        return $res;
    }

    /** @param array<string,mixed> $extra */
    public function submit(string $user = 'alice', string $text = 'Make it red', array $extra = []): string
    {
        $res = $this->call($user, 'POST', 'api/requests', ['text' => $text] + $extra);
        Assert::assertSame(201, $res->status, Json::encode($res->payload));

        return $res->payload['id'];
    }

    public function tmpDir(): string
    {
        return dirname($this->dbPath);
    }
}
