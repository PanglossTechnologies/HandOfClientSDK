<?php

declare(strict_types=1);

namespace HandOfClient\Host\Tests;

use HandOfClient\Host\Adapter\PlainPhp;
use HandOfClient\Host\HostModule;
use HandOfClient\Host\Json;
use HandOfClient\Host\Tests\Support\Host;
use HandOfClient\Host\Webhook;
use PHPUnit\Framework\TestCase;

final class PlainPhpAdapterTest extends TestCase
{
    private Host $host;
    private HostModule $module;

    protected function setUp(): void
    {
        // getCurrentUser gets null from this adapter, so identify the user from the cookie the test sets.
        $this->host = new Host(null, ['getCurrentUser' => static fn ($req) => Host::USERS[$_COOKIE['hoc_user'] ?? ''] ?? null]);
        $this->module = $this->host->module;
    }

    protected function tearDown(): void
    {
        unset($_COOKIE['hoc_user']);
    }

    /** @param array<string,mixed> $extra */
    private function server(string $method, string $uri, array $extra = []): array
    {
        return ['REQUEST_METHOD' => $method, 'REQUEST_URI' => $uri] + $extra;
    }

    public function testOnlyRequestsUnderThePrefixAreHandled(): void
    {
        foreach (['/', '/hoc2/api/features', '/other/hoc/api/features', '/ho', ''] as $uri) {
            $this->assertNull(PlainPhp::dispatch($this->module, '/hoc', $this->server('GET', $uri), ''), $uri);
        }
        $this->assertSame(401, PlainPhp::dispatch($this->module, '/hoc', $this->server('GET', '/hoc/api/features'), '')->status);
        $this->assertSame(401, PlainPhp::dispatch($this->module, 'hoc/', $this->server('GET', '/hoc/api/features'), '')->status, 'the prefix is normalised');
        $this->assertSame(401, PlainPhp::dispatch($this->module, '/hoc', $this->server('GET', '/hoc'), '')->status, '/hoc itself reaches the router');
    }

    public function testNestedPrefixAndAbsoluteFormTargets(): void
    {
        $_COOKIE['hoc_user'] = 'alice';
        $this->assertSame(200, PlainPhp::dispatch($this->module, '/app/hoc', $this->server('GET', '/app/hoc/api/features'), '')->status);
        $this->assertSame(200, PlainPhp::dispatch($this->module, '/hoc', $this->server('GET', 'http://example.com:8080/hoc/api/features?x=1'), '')->status);
    }

    public function testQueryStringKeepsRepeatedParametersAndComesFromTheUriWhenNeeded(): void
    {
        $_COOKIE['hoc_user'] = 'alice';
        $rid = $this->host->submit('alice', 'one');
        $this->host->event(['type' => 'build.status', 'requestRef' => $rid, 'status' => 'Rejected']);
        $rid2 = $this->host->submit('alice', 'two');
        $this->host->event(['type' => 'build.status', 'requestRef' => $rid2, 'status' => 'Success']);
        $this->host->submit('alice', 'three');
        foreach ([$this->server('GET', '/hoc/api/requests?status=Rejected&status=Success', ['QUERY_STRING' => 'status=Rejected&status=Success']), $this->server('GET', '/hoc/api/requests?status=Rejected&status=Success')] as $server) {
            $res = PlainPhp::dispatch($this->module, '/hoc', $server, '');
            $this->assertEqualsCanonicalizing(['Rejected', 'Success'], array_column($res->payload['requests'], 'status'));
        }
    }

    public function testThePathIsPercentDecodedPerRfc3986NotFormDecoded(): void
    {
        $_COOKIE['hoc_user'] = 'alice';
        $rid = $this->host->submit('alice');
        $this->host->publish($rid);
        $this->host->call('alice', 'POST', "api/features/$rid/share", ['userIds' => ['bob']]);
        $id = rawurlencode('erin+qa@example.com'); // + stays a plus
        $res = PlainPhp::dispatch($this->module, '/hoc', $this->server('DELETE', "/hoc/api/features/$rid/share/$id"), '');
        $this->assertSame(200, $res->status, 'an unknown assignment is simply removed');
        $res = PlainPhp::dispatch($this->module, '/hoc', $this->server('DELETE', "/hoc/api/features/$rid/share/bob"), '');
        $this->assertSame(['alice'], $res->payload['sharing']['userIds']);
        $this->assertSame(404, PlainPhp::dispatch($this->module, '/hoc', $this->server('GET', '/hoc/api/features/' . rawurlencode('no such') . '/versions'), '')->status);
    }

    public function testWebhookHeadersComeFromTheServerArray(): void
    {
        $raw = Json::encode(['type' => 'something.new', 'sentAt' => gmdate('Y-m-d\TH:i:s\Z')]);
        $server = $this->server('POST', '/hoc/webhook', ['HTTP_X_HANDOFCLIENT_SIGNATURE' => Webhook::sign(Host::SECRET, $raw), 'CONTENT_TYPE' => 'application/json']);
        $res = PlainPhp::dispatch($this->module, '/hoc', $server, $raw);
        $this->assertSame(200, $res->status);
        $bad = PlainPhp::dispatch($this->module, '/hoc', $this->server('POST', '/hoc/webhook', ['HTTP_X_HANDOFCLIENT_SIGNATURE' => 'sha256=00']), $raw);
        $this->assertSame(401, $bad->status);
        $this->assertSame(401, PlainPhp::dispatch($this->module, '/hoc', $this->server('POST', '/hoc/webhook'), $raw)->status);
    }

    public function testHeaderMapping(): void
    {
        $this->assertSame(
            ['x-handofclient-signature' => 'sig', 'content-type' => 'application/json', 'content-length' => '5', 'accept-language' => 'en'],
            PlainPhp::headers(['HTTP_X_HANDOFCLIENT_SIGNATURE' => 'sig', 'CONTENT_TYPE' => 'application/json', 'CONTENT_LENGTH' => '5', 'HTTP_ACCEPT_LANGUAGE' => 'en', 'REQUEST_TIME' => 5, 'argv' => ['x']]),
        );
    }

    public function testPostBodyIsPassedThrough(): void
    {
        $_COOKIE['hoc_user'] = 'alice';
        $res = PlainPhp::dispatch($this->module, '/hoc', $this->server('POST', '/hoc/api/requests'), '{"text":"from the adapter"}');
        $this->assertSame(201, $res->status);
        $this->assertSame('from the adapter', $res->payload['text']);
    }
}
