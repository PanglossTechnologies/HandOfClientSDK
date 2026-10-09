<?php

declare(strict_types=1);

namespace HandOfClient\Host\Tests\Support;

use HandOfClient\Host\Platform\PlatformApi;
use HandOfClient\Host\Platform\PlatformResult;

/** Records every call. `$answers[name]` scripts the reply: a PlatformResult, or a list consumed in order (the last one repeats). */
final class FakePlatform implements PlatformApi
{
    /** @var list<array<int,mixed>> */
    public array $calls = [];
    /** @var array<string,PlatformResult|list<PlatformResult>> */
    public array $answers = [];

    private function answer(string $name, PlatformResult $default): PlatformResult
    {
        $a = $this->answers[$name] ?? $default;
        if (is_array($a)) {
            return count($a) > 1 ? array_shift($this->answers[$name]) : $a[0];
        }

        return $a;
    }

    public function startBuild(string $requestRef, array $user, string $text, string $mode, array|object|null $snapshot = null, ?array $feature = null): PlatformResult
    {
        $this->calls[] = ['startBuild', $requestRef, $user, $text, $mode, $snapshot, $feature];

        return $this->answer('startBuild', new PlatformResult(200, ['buildId' => 'b-' . $requestRef]));
    }

    public function replyToBuild(string $buildId, string $text): PlatformResult
    {
        $this->calls[] = ['replyToBuild', $buildId, $text];

        return $this->answer('replyToBuild', new PlatformResult(200, []));
    }

    public function embedToken(string $userId, string $packageId, string $slotId, ?string $version): PlatformResult
    {
        $this->calls[] = ['embedToken', $userId, $packageId, $slotId, $version];

        return $this->answer('embedToken', new PlatformResult(200, ['token' => 'jwt', 'expiresAt' => '2030-01-01T00:00:00Z']));
    }

    public function putSecret(string $name, string $value, string $updatedBy): PlatformResult
    {
        $this->calls[] = ['putSecret', $name, $value, $updatedBy];

        return $this->answer('putSecret', new PlatformResult(200, []));
    }

    public function putDataSources(array $dataSources): PlatformResult
    {
        $this->calls[] = ['putDataSources', $dataSources];

        return $this->answer('putDataSources', new PlatformResult(200, []));
    }

    /** @return list<array<int,mixed>> */
    public function named(string $name): array
    {
        return array_values(array_filter($this->calls, static fn (array $c): bool => $c[0] === $name));
    }
}
