<?php

declare(strict_types=1);

namespace HandOfClient\Host\Tests;

use HandOfClient\Host\HocUser;
use HandOfClient\Host\Json;
use HandOfClient\Host\Query;
use HandOfClient\Host\TimeUtil;
use HandOfClient\Host\Webhook;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class WebhookTimeUserTest extends TestCase
{
    // Test vector from openapi/site-hoc-api.yaml (/webhook)
    private const VECTOR_SECRET = 'whsec_example_secret';
    private const VECTOR_BODY = '{"type":"build.status","eventId":"evt_01","sentAt":"2026-10-09T18:00:05Z","buildId":"3f2a9c1e5b7d4a8e9c0d1f2a3b4c5d6e","requestRef":"req-123","status":"NeedsInfo","message":"Which date range?"}';
    private const VECTOR_SIG = 'sha256=33ea1034e3f86ff21fcb3036c05139790b60080144bbea0115540e05ee72f052';

    public function testSignatureMatchesPublishedTestVector(): void
    {
        $this->assertSame(self::VECTOR_SIG, Webhook::sign(self::VECTOR_SECRET, self::VECTOR_BODY));
        $this->assertTrue(Webhook::verify(self::VECTOR_SECRET, self::VECTOR_BODY, self::VECTOR_SIG));
    }

    /** @return array<string,array{?string}> */
    public static function wrongSignatures(): array
    {
        return [
            'null' => [null], 'empty' => [''], 'prefix only' => ['sha256='], 'short' => ['sha256=00'], 'upper case' => [strtoupper(self::VECTOR_SIG)],
            'no prefix' => [substr(self::VECTOR_SIG, 7)], 'extra char' => [self::VECTOR_SIG . '0'], 'sha1 prefix' => ['sha1=' . substr(self::VECTOR_SIG, 7)],
        ];
    }

    #[DataProvider('wrongSignatures')]
    public function testWrongOrMissingSignatureIsRejected(?string $header): void
    {
        $this->assertFalse(Webhook::verify(self::VECTOR_SECRET, self::VECTOR_BODY, $header));
    }

    public function testSignatureCoversEveryByteAndTheSecret(): void
    {
        $this->assertFalse(Webhook::verify(self::VECTOR_SECRET, self::VECTOR_BODY . ' ', self::VECTOR_SIG));
        $this->assertFalse(Webhook::verify('whsec_other', self::VECTOR_BODY, self::VECTOR_SIG));
    }

    public function testStalenessWindowIs300SecondsEitherWay(): void
    {
        $now = new \DateTimeImmutable('2026-10-09T18:00:00Z');
        $this->assertFalse(Webhook::isStale('2026-10-09T18:00:00Z', $now));
        $this->assertFalse(Webhook::isStale('2026-10-09T17:55:01Z', $now));
        $this->assertTrue(Webhook::isStale('2026-10-09T17:54:59Z', $now));
        $this->assertFalse(Webhook::isStale('2026-10-09T18:04:59Z', $now));
        $this->assertTrue(Webhook::isStale('2026-10-09T18:05:01Z', $now));
    }

    /** @return array<string,array{mixed}> */
    public static function unparsable(): array
    {
        return ['null' => [null], 'int' => [5], 'empty' => [''], 'word' => ['yesterday'], 'month 13' => ['2026-13-01T00:00:00Z'], 'date only' => ['2026-10-09'], 'feb 30' => ['2026-02-30T00:00:00Z'], 'hour 24' => ['2026-10-09T24:00:00Z'], 'array' => [[]]];
    }

    #[DataProvider('unparsable')]
    public function testUnparsableSentAtCountsAsStale(mixed $value): void
    {
        $this->assertTrue(Webhook::isStale($value));
        $this->assertNull(TimeUtil::parseIso($value));
    }

    /** @return array<string,array{string,string}> */
    public static function isoVariants(): array
    {
        return [
            'seconds' => ['2026-10-09T18:00:05Z', '2026-10-09 18:00:05.000000'],
            'millis' => ['2026-10-09T18:00:05.123Z', '2026-10-09 18:00:05.123000'],
            'seven digits (.NET)' => ['2026-10-09T18:00:05.1234567Z', '2026-10-09 18:00:05.123456'],
            'offset' => ['2026-10-09T20:00:05+02:00', '2026-10-09 18:00:05.000000'],
            'negative offset no colon' => ['2026-10-09T13:00:05-0500', '2026-10-09 18:00:05.000000'],
            'no zone' => ['2026-10-09T18:00:05', '2026-10-09 18:00:05.000000'],
            'space separator, lower z' => ['2026-10-09 18:00:05z', '2026-10-09 18:00:05.000000'],
        ];
    }

    #[DataProvider('isoVariants')]
    public function testParseIsoVariants(string $value, string $expectedUtc): void
    {
        $t = TimeUtil::parseIso($value);
        $this->assertNotNull($t);
        $this->assertSame($expectedUtc, $t->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s.u'));
    }

    public function testNowIsoRoundTrips(): void
    {
        $now = TimeUtil::nowIso();
        $this->assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/', $now);
        $this->assertNotNull(TimeUtil::parseIso($now));
        $this->assertLessThan(5, abs(time() - (int) TimeUtil::parseIso($now)->format('U')));
    }

    public function testUserNormalisation(): void
    {
        $object = new class {
            public int $id = 42;
            public string $name = 'Pat';
            public ?string $email = null;
        };
        $u = HocUser::from($object);
        $this->assertSame(['42', 'Pat', null], [$u->id, $u->name, $u->email]);
        $this->assertSame($object, $u->raw);
        $this->assertSame(['x', null], [HocUser::from(['id' => 'x', 'name' => ''])->id, HocUser::from(['id' => 'x', 'name' => ''])->name]);
        $this->assertNull(HocUser::from(null));
        $this->assertNull(HocUser::from([]));
        $this->assertNull(HocUser::from(['id' => '']));
        $this->assertNull(HocUser::from(false));
        $this->assertNull(HocUser::from(['id' => ['nested']]));
        $this->assertSame('0', HocUser::from(['id' => 0])->id, 'id 0 is a user');
    }

    public function testUserFromMagicPropertiesAndGetters(): void
    {
        $magic = new class {
            /** @var array<string,mixed> */
            private array $attrs = ['id' => 7, 'name' => 'Eloquent', 'email' => 'e@example.com'];

            public function __get(string $k): mixed
            {
                return $this->attrs[$k] ?? null;
            }

            public function __isset(string $k): bool
            {
                return isset($this->attrs[$k]);
            }
        };
        $this->assertSame(['7', 'Eloquent', 'e@example.com'], [HocUser::from($magic)->id, HocUser::from($magic)->name, HocUser::from($magic)->email]);
        $getters = new class {
            public function getId(): string
            {
                return 'g1';
            }

            public function getName(): string
            {
                return 'Getter';
            }
        };
        $this->assertSame(['g1', 'Getter', null], [HocUser::from($getters)->id, HocUser::from($getters)->name, HocUser::from($getters)->email]);
    }

    public function testQueryParsing(): void
    {
        $this->assertSame([], Query::parse(null));
        $this->assertSame([], Query::parse(''));
        $this->assertSame(['a' => ['1', '2'], 'b' => ['x y'], 'c' => [''], 'd' => ['']], Query::parse('?a=1&a=2&b=x+y&c=&d&&'));
        $this->assertSame(['q' => ['erin+qa@example.com']], Query::parse('q=erin%2Bqa%40example.com'));
        $this->assertSame(['p' => ['a=b']], Query::parse('p=a=b'));
        $this->assertSame(['a' => ['1'], 'b' => ['2', '3']], Query::parse(['a' => 1, 'b' => [2, 3]]));
    }

    public function testJsonHelpers(): void
    {
        $this->assertTrue(Json::isList([]));
        $this->assertTrue(Json::isList([1, 2]));
        $this->assertFalse(Json::isList(['a' => 1]));
        $this->assertFalse(Json::isList([1 => 'x']));
        $this->assertTrue(Json::isObject(['a' => 1]));
        $this->assertFalse(Json::isObject([1, 2]));
        $this->assertSame(Json::canonical(['b' => 1, 'a' => ['y' => 1, 'x' => 2]]), Json::canonical(['a' => ['x' => 2, 'y' => 1], 'b' => 1]));
        $this->assertNotSame(Json::canonical([1, 2]), Json::canonical([2, 1]), 'list order matters');
        $this->assertSame('"a/b é"', Json::encode('a/b é'));
        $this->assertSame("\"a\u{FFFD}b\"", Json::encode("a\xB1b"), 'invalid UTF-8 is substituted, not fatal');
        $this->expectException(\JsonException::class);
        Json::decode('{');
    }
}
