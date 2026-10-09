<?php

declare(strict_types=1);

namespace HandOfClient\Host\Tests;

use HandOfClient\Host\HostModule;
use HandOfClient\Host\Json;
use HandOfClient\Host\Platform\PlatformResult;
use HandOfClient\Host\Storage\StorageTx;
use HandOfClient\Host\Tests\Support\Host;
use HandOfClient\Host\TimeUtil;
use HandOfClient\Host\Webhook;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/** Behaviour the language-neutral conformance suite cannot see (host-module internals) plus negative cases. */
final class CoreTest extends TestCase
{
    private Host $host;

    protected function setUp(): void
    {
        $this->host = new Host();
    }

    public function testSignedOutIs401BeforeRoutingEvenForUnknownPaths(): void
    {
        $this->assertSame(401, $this->host->call(null, 'GET', 'api/nope')->status);
        $this->assertSame(404, $this->host->call('alice', 'GET', 'api/nope')->status);
        $this->assertSame(401, $this->host->call(null, 'GET', 'webhook')->status, 'only POST webhook skips sign-in');
    }

    public function testGetCurrentUserExceptionIsA500NotALeak(): void
    {
        $h = new Host(null, ['getCurrentUser' => static function ($req): never {
            throw new \RuntimeException('database down: secret details');
        }, 'logger' => new \Psr\Log\NullLogger()]);
        $res = $h->call('alice', 'GET', 'api/features');
        $this->assertSame(500, $res->status);
        $this->assertSame(['error' => 'internal', 'message' => 'Internal error.'], $res->payload);
    }

    public function testMalformedJsonIs400(): void
    {
        foreach (['{nope', '[1,', "\xB1\x31"] as $raw) {
            $res = $this->host->raw('alice', 'POST', 'api/requests', $raw);
            $this->assertSame(400, $res->status, $raw);
            $this->assertSame('invalid_request', $res->payload['error']);
        }
    }

    #[DataProvider('nonObjectBodies')]
    public function testBodiesThatAreNotObjectsAreRejected(string $raw): void
    {
        foreach (['api/requests', 'api/features/x/pin', 'api/features/x/share'] as $path) {
            $this->assertContains($this->host->raw('alice', 'POST', $path, $raw)->status, [400, 404], "$path <- $raw");
        }
        $this->assertSame(400, $this->host->raw('admin', 'PUT', 'api/settings', $raw)->status);
    }

    /** @return array<string,array{string}> */
    public static function nonObjectBodies(): array
    {
        return ['list' => ['[1,2]'], 'empty list' => ['[]'], 'string' => ['"hi"'], 'number' => ['5'], 'null' => ['null'], 'true' => ['true']];
    }

    public function testRequiresUserOnlySkipsTheWebhook(): void
    {
        $this->assertFalse(HostModule::requiresUser('POST', 'webhook'));
        $this->assertFalse(HostModule::requiresUser('post', '/webhook/'));
        $this->assertTrue(HostModule::requiresUser('GET', 'webhook'));
        $this->assertTrue(HostModule::requiresUser('POST', 'api/requests'));
    }

    public function testRequestTextAndSnapshotLimits(): void
    {
        $h = $this->host;
        $this->assertSame(413, $h->call('alice', 'POST', 'api/requests', ['text' => str_repeat('x', 20001)])->status);
        $this->assertSame(201, $h->call('alice', 'POST', 'api/requests', ['text' => str_repeat('é', 20000)])->status, 'the limit counts characters, not bytes');
        $this->assertSame(400, $h->call('alice', 'POST', 'api/requests', ['text' => '   '])->status);
        $this->assertSame(400, $h->call('alice', 'POST', 'api/requests', ['text' => 5])->status);
        $this->assertSame(400, $h->call('alice', 'POST', 'api/requests', ['text' => 'ok', 'snapshot' => 'no'])->status);
        $this->assertSame(400, $h->raw('alice', 'POST', 'api/requests', '{"text":"ok","snapshot":[1]}')->status);
        $this->assertSame(400, $h->raw('alice', 'POST', 'api/requests', '{"text":"ok","snapshot":[]}')->status, 'an empty array is not an object');
        $this->assertSame(400, $h->call('alice', 'POST', 'api/requests', ['text' => 'ok', 'featureId' => 7])->status);
        $before = count($h->platform->named('startBuild'));
        $this->assertSame(413, $h->call('alice', 'POST', 'api/requests', ['text' => 'ok', 'snapshot' => ['html' => str_repeat('x', 2 * 1024 * 1024 + 1)]])->status);
        $this->assertCount($before, $h->platform->named('startBuild'), 'a rejected request never reaches the platform');
    }

    public function testSnapshotKeepsEmptyObjectsAndIsNotReordered(): void
    {
        $h = $this->host;
        $raw = '{"text":"x","snapshot":{"url":"u","styles":{},"list":[],"nested":{"a":{}},"n":1.0}}';
        $this->assertSame(201, $h->raw('alice', 'POST', 'api/requests', $raw)->status);
        $sent = $h->platform->named('startBuild')[0][5];
        $this->assertSame('{"url":"u","styles":{},"list":[],"nested":{"a":{}},"n":1.0}', Json::encode($sent));
    }

    public function testBuildCarriesEmailSnapshotAndChangeTarget(): void
    {
        $h = $this->host;
        $rid = $h->submit('alice', 'Make it red', ['snapshot' => ['url' => 'u', 'path' => '/orders', 'html' => '<p/>']]);
        $h->publish($rid);
        [, , $user, , , $snap, $feat] = $h->platform->named('startBuild')[0];
        $this->assertSame(['id' => 'alice', 'name' => 'Alice Owner', 'email' => 'alice@example.com'], $user);
        $this->assertSame('/orders', $snap->path);
        $this->assertNull($feat);
        $again = $h->submit('alice', 'change it', ['featureId' => $rid]);
        $this->assertSame(['ref' => $rid, 'packageId' => "acme/f-$rid"], $h->platform->named('startBuild')[1][6]);
        $this->assertNotSame($rid, $again);
    }

    public function testChangeRequestForAnInvisibleFeatureIs404AndNeverReachesThePlatform(): void
    {
        $h = $this->host;
        $rid = $h->submit('alice');
        $h->publish($rid);
        $before = count($h->platform->named('startBuild'));
        $this->assertSame(404, $h->call('bob', 'POST', 'api/requests', ['text' => 'x', 'featureId' => $rid])->status);
        $this->assertCount($before, $h->platform->named('startBuild'));
    }

    public function testUnstartedBuildIsRetriedWithTheSameUserDetails(): void
    {
        $h = $this->host;
        $h->platform->answers['startBuild'] = [new PlatformResult(503), new PlatformResult(200, ['buildId' => 'b9'])];
        $rid = $h->submit();
        $this->assertSame($rid, $h->call('alice', 'GET', 'api/requests')->payload['requests'][0]['id']);
        $this->assertSame(1, $h->module->retryUnstartedBuilds());
        $this->assertSame(0, $h->module->retryUnstartedBuilds());
        $calls = $h->platform->named('startBuild');
        $this->assertCount(2, $calls);
        $this->assertSame($calls[0][2], $calls[1][2], 'the email survives the retry');
        $this->assertSame('b9', $h->storage->transaction(static fn (StorageTx $tx) => $tx->getRequest($rid)->buildId));
    }

    public function testPlatformThrowingDuringSubmitDoesNotLoseTheRequest(): void
    {
        $h = $this->host;
        $h->platform->answers['startBuild'] = new PlatformResult(0);
        $rid = $h->submit();
        $this->assertSame('InProgress', $h->call('alice', 'GET', 'api/requests')->payload['requests'][0]['status']);
        $this->assertNull($h->storage->transaction(static fn (StorageTx $tx) => $tx->getRequest($rid)->buildId));
    }

    public function testRunDeferredRetriesAtMostOncePerIntervalAndOnlyWhenEnabled(): void
    {
        $h = new Host(null, ['retryBuilds' => true]);
        $h->platform->answers['startBuild'] = [new PlatformResult(503), new PlatformResult(200, ['buildId' => 'b1'])];
        $rid = $h->submit();
        $h->module->runDeferred(); // first call: due (never ran) -> retries
        $this->assertCount(2, $h->platform->named('startBuild'));
        $this->assertSame('b1', $h->storage->transaction(static fn (StorageTx $tx) => $tx->getRequest($rid)->buildId));
        $h->platform->answers['startBuild'] = new PlatformResult(503);
        $rid2 = $h->submit();
        $h->module->runDeferred(); // within the interval: nothing
        $this->assertCount(3, $h->platform->named('startBuild'), 'only the submit itself');
        $h->storage->transaction(static fn (StorageTx $tx) => $tx->swapBuildRetryAt($tx->getBuildRetryAt(), time() - HostModule::BUILD_RETRY_INTERVAL - 1), true);
        $h->platform->answers['startBuild'] = new PlatformResult(200, ['buildId' => 'b2']);
        $h->module->runDeferred();
        $this->assertSame('b2', $h->storage->transaction(static fn (StorageTx $tx) => $tx->getRequest($rid2)->buildId));
        // disabled: never touches storage or the platform
        $off = new Host(null, ['retryBuilds' => false]);
        $off->submit();
        $off->module->runDeferred();
        $this->assertSame(0, $off->storage->transaction(static fn (StorageTx $tx) => $tx->getBuildRetryAt()));
    }

    public function testRunDeferredNeverThrows(): void
    {
        $h = new Host(null, ['retryBuilds' => true, 'logger' => new \Psr\Log\NullLogger()]);
        $h->submit();
        unlink($h->dbPath);
        mkdir($h->dbPath); // storage now unusable
        try {
            $h->module->runDeferred();
            $this->addToAssertionCount(1);
        } finally {
            rmdir($h->dbPath);
        }
    }

    public function testReplyFlowAndNegativeCases(): void
    {
        $h = $this->host;
        $rid = $h->submit();
        $this->assertSame('not_awaiting_reply', $h->call('alice', 'POST', "api/requests/$rid/reply", ['text' => 'x'])->payload['error']);
        $this->assertSame(200, $h->event(['type' => 'build.status', 'requestRef' => $rid, 'status' => 'NeedsInfo', 'message' => 'Which?'])->status);
        $this->assertSame(404, $h->call('bob', 'POST', "api/requests/$rid/reply", ['text' => 'x'])->status);
        $this->assertSame(400, $h->call('alice', 'POST', "api/requests/$rid/reply", ['text' => ''])->status);
        $this->assertSame(404, $h->call('alice', 'POST', 'api/requests/req-nope/reply', ['text' => 'x'])->status);
        $h->platform->answers['replyToBuild'] = new PlatformResult(500);
        $this->assertSame(502, $h->call('alice', 'POST', "api/requests/$rid/reply", ['text' => 'last week'])->status);
        $this->assertSame('NeedsInfo', $h->call('alice', 'GET', 'api/requests')->payload['requests'][0]['status'], 'a failed relay changes nothing');
        unset($h->platform->answers['replyToBuild']);
        $ok = $h->call('alice', 'POST', "api/requests/$rid/reply", ['text' => 'last week']);
        $this->assertSame(200, $ok->status);
        $this->assertSame('InProgress', $ok->payload['status']);
        $this->assertNull($ok->payload['message']);
        $this->assertSame([['replyToBuild', "b-$rid", 'last week']], array_slice($h->platform->named('replyToBuild'), -1));
    }

    public function testListRequestsValidation(): void
    {
        $h = $this->host;
        foreach (['limit=0', 'limit=201', 'limit=abc', 'limit=-1', 'scope=everyone', 'status=Bogus', 'cursor=!!!', 'cursor=' . rtrim(strtr(base64_encode('-5'), '+/', '-_'), '='), 'cursor=' . rtrim(strtr(base64_encode('9999999999999999999999'), '+/', '-_'), '=')] as $q) {
            $this->assertSame(400, $h->call('alice', 'GET', 'api/requests', null, $q)->status, $q);
        }
        $this->assertSame(403, $h->call('alice', 'GET', 'api/requests', null, 'scope=all')->status);
        $this->assertSame(200, $h->call('admin', 'GET', 'api/requests', null, 'scope=all')->status);
    }

    public function testRepeatedStatusParametersAreAllHonoured(): void
    {
        $h = $this->host;
        $a = $h->submit('alice', 'a');
        $b = $h->submit('alice', 'b');
        $h->event(['type' => 'build.status', 'requestRef' => $a, 'status' => 'Rejected', 'message' => 'no']);
        $h->event(['type' => 'build.status', 'requestRef' => $b, 'status' => 'Success']);
        $h->submit('alice', 'c');
        $statuses = static fn (string $q): array => array_column($h->call('alice', 'GET', 'api/requests', null, $q)->payload['requests'], 'status');
        $this->assertEqualsCanonicalizing(['Rejected', 'Success'], $statuses('status=Rejected&status=Success'));
        $this->assertSame(['InProgress'], $statuses('status=InProgress'));
    }

    public function testCursorPagesThroughEveryRequestOnce(): void
    {
        $h = $this->host;
        $ids = [];
        for ($i = 0; $i < 5; $i++) {
            $ids[] = $h->submit('alice', "r$i");
        }
        $seen = [];
        $cursor = null;
        do {
            $res = $h->call('alice', 'GET', 'api/requests', null, ['limit' => '2'] + ($cursor ? ['cursor' => $cursor] : []))->payload;
            array_push($seen, ...array_column($res['requests'], 'id'));
            $cursor = $res['nextCursor'];
        } while ($cursor !== null);
        $this->assertSame(array_reverse($ids), $seen);
    }

    public function testTokenNeverMintedForInvisibleOrDisabledFeature(): void
    {
        $h = $this->host;
        $rid = $h->submit('alice');
        $h->publish($rid);
        $this->assertSame(404, $h->call('bob', 'GET', 'token', null, ['featureId' => $rid])->status);
        $res = $h->call('alice', 'GET', 'token', null, ['featureId' => $rid]);
        $this->assertSame(200, $res->status);
        $this->assertSame(['token' => 'jwt', 'expiresAt' => '2030-01-01T00:00:00Z', 'userId' => 'alice', 'displayName' => 'Alice Owner'], $res->payload);
        $this->assertSame(200, $h->call('alice', 'POST', "api/features/$rid/enabled", ['enabled' => false])->status);
        $this->assertSame(404, $h->call('alice', 'GET', 'token', null, ['featureId' => $rid])->status);
        $this->assertCount(1, $h->platform->named('embedToken'));
        $this->assertSame(['embedToken', 'alice', "acme/f-$rid", 'main', '1.0.0'], $h->platform->named('embedToken')[0]);
    }

    public function testTokenWithoutFeatureId(): void
    {
        $this->assertSame(400, $this->host->call('alice', 'GET', 'token')->status);
        $legacy = new Host(null, ['legacyPackageId' => 'acme/p', 'legacySlotId' => 'main']);
        $res = $legacy->call('alice', 'GET', 'token');
        $this->assertSame(200, $res->status);
        $this->assertSame('alice', $res->payload['userId']);
        $this->assertSame(['embedToken', 'alice', 'acme/p', 'main', null], $legacy->platform->named('embedToken')[0], 'no version: tenant activation');
    }

    public function testTokenPlatformFailures(): void
    {
        $h = $this->host;
        $rid = $h->submit();
        $h->publish($rid);
        $tok = static fn () => $h->call('alice', 'GET', 'token', null, ['featureId' => $rid]);
        $h->platform->answers['embedToken'] = new PlatformResult(409);
        $this->assertSame('version_unavailable', $tok()->payload['error']);
        $h->platform->answers['embedToken'] = new PlatformResult(0);
        $this->assertSame(502, $tok()->status);
        $h->platform->answers['embedToken'] = new PlatformResult(200, ['nothing' => 1]);
        $this->assertSame(502, $tok()->status);
        $h->platform->answers['embedToken'] = new PlatformResult(200, 'not an object');
        $this->assertSame(502, $tok()->status);
    }

    public function testDuplicateEventIsAppliedOnceAndFailedApplyCanBeRetried(): void
    {
        $h = $this->host;
        $rid = $h->submit();
        $ev = ['type' => 'build.version', 'eventId' => 'evt_dup', 'buildId' => 'b1', 'requestRef' => $rid, 'featureRef' => $rid, 'packageId' => 'p/f', 'version' => '1.0.0',
            'sha256' => 'aa', 'entry' => 'index.js', 'kind' => 'page-override', 'path' => '/p', 'slotId' => 'main', 'mode' => 'inject'];
        $deliver = static function () use ($h, $ev) {
            $raw = Json::encode($ev + ['sentAt' => TimeUtil::nowIso()]);

            return $h->module->handle('POST', 'webhook', null, [Webhook::SIGNATURE_HEADER => Webhook::sign(Host::SECRET, $raw)], $raw);
        };
        $pdo = new \PDO('sqlite:' . $h->dbPath, null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
        $pdo->exec("CREATE TRIGGER fail_versions BEFORE INSERT ON hoc_versions BEGIN SELECT RAISE(ABORT, 'disk full'); END");
        $this->assertSame(500, $deliver()->status, 'the platform will retry...');
        $pdo->exec('DROP TRIGGER fail_versions');
        $this->assertSame(200, $deliver()->status, '...and the retry must not be swallowed as a duplicate');
        $this->assertSame(200, $deliver()->status, 'a real duplicate is acknowledged');
        $this->assertCount(1, $h->call('alice', 'GET', "api/features/$rid/versions")->payload['versions']);
        $this->assertCount(1, $h->call('alice', 'GET', 'api/features')->payload['features']);
    }

    public function testWebhookRejectionsChangeNothing(): void
    {
        $h = $this->host;
        $rid = $h->submit();
        $raw = Json::encode(['type' => 'build.status', 'requestRef' => $rid, 'status' => 'Success']);
        foreach ([[], [Webhook::SIGNATURE_HEADER => 'sha256=' . str_repeat('0', 64)], [Webhook::SIGNATURE_HEADER => '']] as $headers) {
            $this->assertSame(401, $h->module->handle('POST', 'webhook', null, $headers, $raw)->status);
        }
        $this->assertSame('InProgress', $h->call('alice', 'GET', 'api/requests')->payload['requests'][0]['status']);
    }

    public function testWebhookHeaderNamesAreCaseInsensitive(): void
    {
        $raw = Json::encode(['type' => 'something.new', 'sentAt' => TimeUtil::nowIso()]);
        $res = $this->host->module->handle('POST', 'webhook', null, ['X-HandOfClient-Signature' => Webhook::sign(Host::SECRET, $raw)], $raw);
        $this->assertSame(200, $res->status);
        $this->assertSame('{}', $res->body(), 'the empty acknowledgement is an object, not []');
    }

    public function testWebhookUnknownAndMalformedEventsAreAcknowledgedOr400(): void
    {
        $h = $this->host;
        foreach ([
            ['type' => 'something.new'],
            ['event' => 'activation.changed'],
            ['type' => 'build.status', 'requestRef' => 'nope', 'status' => 'Success'],
            ['type' => 'build.status', 'requestRef' => 5, 'status' => 'Success'],
            ['type' => 'build.version', 'requestRef' => 'nope', 'featureRef' => 'f', 'version' => '1'],
            ['type' => 'build.version'],
        ] as $ev) {
            $this->assertSame(200, $h->event($ev)->status, Json::encode($ev));
        }
        foreach (['[1,2]', '[]', '"s"', '5', 'null'] as $raw) {
            $res = $h->module->handle('POST', 'webhook', null, [Webhook::SIGNATURE_HEADER => Webhook::sign(Host::SECRET, $raw)], $raw);
            $this->assertSame(400, $res->status, $raw);
        }
        $bad = '{not json';
        $this->assertSame(400, $h->module->handle('POST', 'webhook', null, [Webhook::SIGNATURE_HEADER => Webhook::sign(Host::SECRET, $bad)], $bad)->status);
    }

    public function testStaleAndUnparsableSentAtAreRejected(): void
    {
        $h = $this->host;
        foreach ([gmdate('Y-m-d\TH:i:s\Z', time() - 400), gmdate('Y-m-d\TH:i:s\Z', time() + 400), 'yesterday', 5, null] as $sentAt) {
            $raw = Json::encode(['type' => 'build.status', 'eventId' => 'e' . bin2hex(random_bytes(3)), 'sentAt' => $sentAt]);
            $res = $h->module->handle('POST', 'webhook', null, [Webhook::SIGNATURE_HEADER => Webhook::sign(Host::SECRET, $raw)], $raw);
            $this->assertSame([400, 'stale_event'], [$res->status, $res->payload['error']], Json::encode($sentAt));
        }
    }

    public function testBuildVersionDefaultsAndLongTitles(): void
    {
        $h = $this->host;
        $rid = $h->submit('alice', "\n  \n  " . str_repeat('word ', 30) . "\nsecond line");
        $h->event(['type' => 'build.version', 'requestRef' => $rid, 'featureRef' => $rid, 'version' => '1.0.0', 'kind' => 'bogus', 'mode' => 'bogus', 'slotId' => '']);
        $f = $h->call('alice', 'GET', 'api/features')->payload['features'][0];
        $this->assertSame('page-override', $f['kind']);
        $this->assertSame('inject', $f['mode']);
        $this->assertSame('main', $f['slotId']);
        $this->assertSame('', $f['packageId']);
        $this->assertNull($f['path']);
        $this->assertSame(62, mb_strlen($f['title']), '59 characters and "..." (same rule as the Python and Node modules)');
        $this->assertStringEndsWith('...', $f['title']);
        $this->assertStringStartsWith('word word', $f['title']);
        $this->assertStringNotContainsString("\n", $f['title']);
    }

    public function testSecondBuildVersionUpdatesTheSameFeatureWithoutReassigning(): void
    {
        $h = $this->host;
        $rid = $h->submit('alice');
        $h->publish($rid, '1.0.0');
        $this->assertSame(200, $h->call('alice', 'POST', "api/features/$rid/share", ['userIds' => ['bob']])->status);
        $h->publish($rid, '1.1.0');
        $f = $h->call('alice', 'GET', 'api/features')->payload['features'][0];
        $this->assertSame('1.1.0', $f['currentVersion']);
        $this->assertSame(['alice', 'bob'], $f['sharing']['userIds']);
        $this->assertSame('1.0.0', $h->call('bob', 'POST', "api/features/$rid/pin", ['version' => '1.0.0'])->payload['pinnedVersion']);
        $this->assertSame('version_not_found', $h->call('bob', 'POST', "api/features/$rid/pin", ['version' => '9.9.9'])->payload['error']);
        $this->assertNull($h->call('bob', 'POST', "api/features/$rid/pin", ['version' => null])->payload['pinnedVersion']);
        $this->assertSame(400, $h->call('bob', 'POST', "api/features/$rid/pin", [])->status);
        $this->assertSame(400, $h->call('bob', 'POST', "api/features/$rid/pin", ['version' => 5])->status);
        $this->assertSame(403, $h->call('bob', 'POST', "api/features/$rid/current", ['version' => '1.0.0'])->status);
        $this->assertSame('1.0.0', $h->call('alice', 'POST', "api/features/$rid/current", ['version' => '1.0.0'])->payload['currentVersion']);
    }

    public function testSharingPoliciesAndUnknownUsers(): void
    {
        $h = $this->host;
        $rid = $h->submit('alice');
        $h->publish($rid);
        $share = static fn (string $who, array $body) => $h->call($who, 'POST', "api/features/$rid/share", $body);
        $this->assertSame(400, $share('alice', ['userIds' => ['nobody-here']])->status);
        $this->assertSame('sharing_not_allowed', $share('alice', ['everyone' => true])->payload['error'], 'default: admins only');
        $this->assertSame(404, $share('bob', ['userIds' => ['bob']])->status, 'cannot even see it');
        $this->assertSame(400, $share('alice', ['userIds' => ['bob'], 'everyone' => true])->status);
        $this->assertSame(400, $share('alice', ['userIds' => []])->status);
        $this->assertSame(400, $share('alice', ['userIds' => [5]])->status);
        $this->assertSame(400, $share('alice', ['userIds' => ['a' => 'bob']])->status, 'userIds must be a list');
        $this->assertSame(400, $share('alice', ['everyone' => false])->status);
        $this->assertSame(404, $share('admin', ['everyone' => true])->status, 'admins see only what is assigned to them, like anyone');
        $this->assertSame(['alice', 'bob'], $share('alice', ['userIds' => ['bob', 'bob']])->payload['sharing']['userIds']);
        $this->assertSame(403, $h->call('bob', 'DELETE', "api/features/$rid/share/alice")->status);
        $this->assertSame(['alice'], $h->call('alice', 'DELETE', "api/features/$rid/share/bob")->payload['sharing']['userIds']);
    }

    public function testUserExistsFallsBackToFindUsersExactMatch(): void
    {
        $h = new Host(null, ['userExists' => null]);
        $rid = $h->submit('alice');
        $h->publish($rid);
        $share = static fn (array $ids) => $h->call('alice', 'POST', "api/features/$rid/share", ['userIds' => $ids]);
        $this->assertSame(400, $share(['bo'])->status, 'a substring match is not an exact id');
        $this->assertSame(200, $share(['bob'])->status);
    }

    public function testUsersSearch(): void
    {
        $h = $this->host;
        $this->assertSame(400, $h->call('alice', 'GET', 'api/users')->status);
        $this->assertSame(400, $h->call('alice', 'GET', 'api/users', null, 'query=' . str_repeat('x', 101))->status);
        $this->assertSame(400, $h->call('alice', 'GET', 'api/users', null, 'query=a&limit=51')->status);
        $names = array_column($h->call('alice', 'GET', 'api/users', null, 'query=b')->payload['users'], 'id');
        $this->assertSame(['bob'], $names, 'the caller is never offered');
        $this->assertSame(1, count($h->call('alice', 'GET', 'api/users', null, 'query=a&limit=1')->payload['users']));
        // The default policy is "owner", so a plain user may search; "admins" blocks them, "nobody" blocks everyone.
        $h->call('admin', 'PUT', 'api/settings', self::settings(['shareWithNamedUsers' => 'admins']));
        $this->assertSame(403, $h->call('alice', 'GET', 'api/users', null, 'query=b')->status);
        $this->assertSame(200, $h->call('admin', 'GET', 'api/users', null, 'query=b')->status);
        $h->call('admin', 'PUT', 'api/settings', self::settings(['shareWithNamedUsers' => 'nobody']));
        $this->assertSame(403, $h->call('admin', 'GET', 'api/users', null, 'query=b')->status);
    }

    /**
     * @param array<string,mixed> $over
     * @return array<string,mixed>
     */
    private static function settings(array $over = []): array
    {
        return $over + ['renderingMode' => 'iframe', 'shareWithNamedUsers' => 'owner', 'shareWithEveryone' => 'admins', 'viewAllRequests' => 'admins', 'dataSources' => []];
    }

    public function testSettingsValidationAndSecretsNeverReturned(): void
    {
        $h = $this->host;
        $put = static fn (array $body, string $who = 'admin') => $h->call($who, 'PUT', 'api/settings', $body);
        $this->assertSame(403, $put(self::settings(), 'alice')->status);
        $this->assertSame(403, $h->call('alice', 'GET', 'api/settings')->status);
        $this->assertSame(400, $put(self::settings(['renderingMode' => 'weird']))->status);
        $this->assertSame(400, $put(self::settings(['renderingMode' => 5]))->status);
        $this->assertSame(400, $put(self::settings(['shareWithEveryone' => 'everyone']))->status);
        $this->assertSame(400, $put(self::settings(['viewAllRequests' => 'nobody']))->status);
        $this->assertSame(400, $put(self::settings(['dataSources' => [['name' => 'a', 'baseUrl' => 'not a url']]]))->status);
        $this->assertSame(400, $put(self::settings(['dataSources' => [['name' => '', 'baseUrl' => 'https://x.example']]]))->status);
        $this->assertSame(400, $put(self::settings(['dataSources' => ['x']]))->status);
        $this->assertSame(400, $put(self::settings(['dataSources' => [['name' => 'a', 'baseUrl' => 'https://x.example', 'auth' => ['type' => 'bearer', 'secret' => 'Bad Name']]]]))->status);
        $this->assertSame(400, $put(self::settings(['dataSources' => [['name' => 'a', 'baseUrl' => 'https://x.example', 'auth' => ['type' => 'basic', 'secret' => 'ok']]]]))->status);
        $this->assertSame(400, $put(self::settings(['dataSources' => [['name' => 'a', 'baseUrl' => 'https://x.example', 'auth' => ['type' => 'bearer', 'secret' => 'ok', 'secretValue' => 5]]]]))->status);
        $this->assertSame(400, $h->raw('admin', 'PUT', 'api/settings', '{"renderingMode":"iframe","shareWithNamedUsers":"owner","shareWithEveryone":"admins","viewAllRequests":"admins","dataSources":{}}')->status, 'an object is not a list');
        $this->assertSame(400, $h->raw('admin', 'PUT', 'api/settings', '{"renderingMode":"iframe","shareWithNamedUsers":"owner","shareWithEveryone":"admins","viewAllRequests":"admins","dataSources":[{"name":"a","baseUrl":"https://x.example","auth":[]}]}')->status, 'auth must be an object');

        $ds = [['name' => 'orders', 'baseUrl' => 'https://api.example', 'auth' => ['type' => 'bearer', 'secret' => 'orders-key', 'secretValue' => 's3cr3t']]];
        $res = $put(self::settings(['dataSources' => $ds]));
        $this->assertSame(200, $res->status);
        $this->assertStringNotContainsString('s3cr3t', $res->body());
        $this->assertStringNotContainsString('s3cr3t', $h->call('admin', 'GET', 'api/settings')->body());
        $this->assertSame([['putSecret', 'orders-key', 's3cr3t', 'admin']], $h->platform->named('putSecret'));
        $stored = $h->storage->transaction(static fn (StorageTx $tx) => Json::encode($tx->getSettings()));
        $this->assertStringNotContainsString('s3cr3t', $stored, 'not stored locally either');

        $h->platform->calls = [];
        $same = [['name' => 'orders', 'baseUrl' => 'https://api.example', 'auth' => ['type' => 'bearer', 'secret' => 'orders-key']]];
        $this->assertSame(200, $put(self::settings(['dataSources' => $same]))->status);
        $this->assertSame([], $h->platform->named('putDataSources'), 'unchanged descriptions are not re-pushed');
        $h->platform->answers['putDataSources'] = new PlatformResult(500);
        $this->assertSame(502, $put(self::settings(['dataSources' => []]))->status);
        $this->assertNotSame([], $h->call('admin', 'GET', 'api/settings')->payload['dataSources'], 'not saved');
        unset($h->platform->answers['putDataSources']);
        $h->platform->answers['putSecret'] = new PlatformResult(500);
        $this->assertSame(502, $put(self::settings(['dataSources' => $ds]))->status);
    }

    public function testDefaultSettingsAndRoundTrip(): void
    {
        $h = $this->host;
        $this->assertSame(
            ['renderingMode' => 'inject', 'shareWithNamedUsers' => 'owner', 'shareWithEveryone' => 'admins', 'viewAllRequests' => 'admins', 'dataSources' => []],
            $h->call('admin', 'GET', 'api/settings')->payload,
        );
        $this->assertSame('[]', Json::encode($h->call('admin', 'GET', 'api/settings')->payload['dataSources']));
        $h->call('admin', 'PUT', 'api/settings', self::settings());
        $rid = $h->submit('alice');
        $this->assertSame('iframe', $h->storage->transaction(static fn (StorageTx $tx) => $tx->getRequest($rid)->mode), 'new requests use the configured rendering mode');
    }

    public function testViewAllRequestsPolicy(): void
    {
        $h = $this->host;
        $h->submit('alice');
        $h->call('admin', 'PUT', 'api/settings', self::settings(['viewAllRequests' => 'everyone']));
        $this->assertCount(1, $h->call('bob', 'GET', 'api/requests', null, 'scope=all')->payload['requests']);
        $this->assertCount(0, $h->call('bob', 'GET', 'api/requests')->payload['requests']);
    }

    public function testResolvePrefersUserAssignmentAndIgnoresDisabledFeatures(): void
    {
        $h = $this->host;
        $a = $h->submit('alice', 'a');
        $h->publish($a, '1.0.0', '/orders');
        $b = $h->submit('bob', 'b');
        $h->publish($b, '1.0.0', '/orders');
        $h->call('admin', 'PUT', 'api/settings', self::settings(['shareWithEveryone' => 'owner']));
        $this->assertSame(200, $h->call('alice', 'POST', "api/features/$a/share", ['everyone' => true])->status);
        $resolve = static fn (string $who): array => array_column($h->call($who, 'GET', 'api/resolve', null, ['path' => '/orders'])->payload['features'], 'featureId');
        $this->assertSame([$b], $resolve('bob'), "bob's own feature beats the one shared with everyone");
        $this->assertSame([$a], $resolve('alice'));
        $h->call('bob', 'POST', "api/features/$b/enabled", ['enabled' => false]);
        $this->assertSame([$a], $resolve('bob'), 'disabled features fall back to the next candidate');
        $this->assertSame(400, $h->call('bob', 'GET', 'api/resolve', null, ['path' => 'orders'])->status);
        $this->assertSame(400, $h->call('bob', 'GET', 'api/resolve')->status);
    }

    public function testAutoMigrateCanBeDisabled(): void
    {
        $h = new Host(null, ['autoMigrate' => false, 'logger' => new \Psr\Log\NullLogger()]);
        $this->assertSame(500, $h->call('alice', 'GET', 'api/features')->status, 'no tables: an error, not a crash');
        $h->storage->migrate();
        $this->assertSame(200, $h->call('alice', 'GET', 'api/features')->status);
    }

    public function testConstructorRejectsAnEmptyWebhookSecret(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        new Host(null, ['webhookSecret' => '']);
    }

    public function testResponsesAreNoStoreJson(): void
    {
        $res = $this->host->call('alice', 'GET', 'api/features');
        $this->assertSame('no-store', $res->headers()['cache-control']);
        $this->assertSame('application/json; charset=utf-8', $res->headers()['content-type']);
        $this->assertSame('{"features":[]}', $res->body());
    }

    public function testUnicodeSurvivesTheRoundTrip(): void
    {
        $h = $this->host;
        $rid = $h->submit('alice', "Make \"it\" \u{1F680} red / blue \\ \u{4E2D}\u{6587}");
        $this->assertSame("Make \"it\" \u{1F680} red / blue \\ \u{4E2D}\u{6587}", $h->call('alice', 'GET', 'api/requests')->payload['requests'][0]['text']);
        $this->assertStringContainsString("\u{4E2D}\u{6587}", $h->call('alice', 'GET', 'api/requests')->body(), 'not escaped to \\uXXXX');
        $this->assertStringNotContainsString('\/', $h->call('alice', 'GET', 'api/requests')->body());
        $this->assertSame($rid, $h->call('alice', 'GET', 'api/requests')->payload['requests'][0]['id']);
    }
}
