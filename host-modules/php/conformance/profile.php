<?php

// The conformance profile (see host-modules/conformance/README.md): fixed roster, cookie identity, fixed keys.
// Test configuration only - nothing here is for production.
declare(strict_types=1);

namespace HandOfClient\Host\Conformance;

use HandOfClient\Host\HostModule;
use HandOfClient\Host\Platform\PlatformClient;
use HandOfClient\Host\Storage\SqlStorage;
use HandOfClient\Host\Storage\Storage;

final class Profile
{
    public const COOKIE = 'hoc_user';
    public const ROSTER = [
        'admin' => ['id' => 'admin', 'name' => 'Ada Admin'],
        'alice' => ['id' => 'alice', 'name' => 'Alice Owner'],
        'bob' => ['id' => 'bob', 'name' => 'Bob Builder'],
        'carol' => ['id' => 'carol', 'name' => 'Carol Customer'],
        'dave' => ['id' => 'dave', 'name' => 'Dave Dev'],
        'erin+qa@example.com' => ['id' => 'erin+qa@example.com', 'name' => 'Erin Special'],
    ];

    public static function env(string $name, string $default): string
    {
        $v = getenv($name);

        return $v === false || $v === '' ? $default : $v;
    }

    /** @return array{id:string,name:string}|null */
    public static function userFromCookie(?string $value): ?array
    {
        return $value !== null && $value !== '' ? (self::ROSTER[$value] ?? null) : null;
    }

    public static function isAdmin(mixed $user): bool
    {
        return $user['id'] === 'admin';
    }

    /** @return list<array{id:string,name:string}> */
    public static function findUsers(string $query): array
    {
        $q = mb_strtolower($query);

        return array_values(array_filter(
            self::ROSTER,
            static fn (array $u): bool => str_contains(mb_strtolower($u['id']), $q) || str_contains(mb_strtolower($u['name']), $q),
        ));
    }

    public static function userExists(string $id): bool
    {
        return isset(self::ROSTER[$id]);
    }

    /** SQLite file by default; HOC_CONFORMANCE_DATABASE_URL=postgresql://... or mysql://... for the others. */
    public static function makeStorage(): Storage
    {
        $url = getenv('HOC_CONFORMANCE_DATABASE_URL');
        if ($url === false || $url === '') {
            return SqlStorage::sqlite(self::env('HOC_CONFORMANCE_DB', 'conformance.db'));
        }
        $u = parse_url($url);
        $scheme = (string) ($u['scheme'] ?? '');
        $user = isset($u['user']) ? rawurldecode($u['user']) : null;
        $pass = isset($u['pass']) ? rawurldecode($u['pass']) : null;
        $db = ltrim((string) ($u['path'] ?? ''), '/');
        if (str_starts_with($scheme, 'postgres')) {
            $dsn = 'pgsql:host=' . ($u['host'] ?? '127.0.0.1') . ';port=' . ($u['port'] ?? 5432) . ';dbname=' . $db;
        } elseif (str_starts_with($scheme, 'mysql')) {
            $dsn = 'mysql:host=' . ($u['host'] ?? '127.0.0.1') . ';port=' . ($u['port'] ?? 3306) . ';dbname=' . $db . ';charset=utf8mb4';
        } else {
            throw new \InvalidArgumentException("unsupported HOC_CONFORMANCE_DATABASE_URL scheme $scheme");
        }

        return new SqlStorage(static fn (): \PDO => new \PDO($dsn, $user, $pass, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]));
    }

    public static function platform(): PlatformClient
    {
        $transport = self::env('HOC_CONFORMANCE_TRANSPORT', 'curl') === 'stream' ? [PlatformClient::class, 'streamTransport'] : null;

        return new PlatformClient(
            'http://127.0.0.1:' . self::env('HOC_CONFORMANCE_PLATFORM_PORT', '4010'),
            self::env('HOC_CONFORMANCE_API_KEY', 'conformance-host-api-key'),
            self::env('HOC_CONFORMANCE_TENANT_ID', 'conformance-tenant'),
            10.0,
            $transport,
        );
    }

    public static function module(callable $getCurrentUser, ?Storage $storage = null): HostModule
    {
        return new HostModule(
            storage: $storage ?? self::makeStorage(),
            platform: self::platform(),
            webhookSecret: self::env('HOC_CONFORMANCE_WEBHOOK_SECRET', 'whsec_conformance'),
            getCurrentUser: $getCurrentUser,
            isAdmin: [self::class, 'isAdmin'],
            findUsers: [self::class, 'findUsers'],
            userExists: [self::class, 'userExists'],
        );
    }
}
