<?php

declare(strict_types=1);

namespace HandOfClient\Host\Platform;

/** The platform calls a site makes (/host/v1, openapi/platform-host-v1.yaml). PlatformClient is the HTTP implementation. */
interface PlatformApi
{
    /**
     * @param array<string,mixed> $user {id, name?, email?}
     * @param array<string,mixed>|object|null $snapshot
     * @param array<string,string>|null $feature {ref, packageId} when the request changes an existing feature
     */
    public function startBuild(string $requestRef, array $user, string $text, string $mode, array|object|null $snapshot = null, ?array $feature = null): PlatformResult;

    public function replyToBuild(string $buildId, string $text): PlatformResult;

    public function embedToken(string $userId, string $packageId, string $slotId, ?string $version): PlatformResult;

    public function putSecret(string $name, string $value, string $updatedBy): PlatformResult;

    /** @param list<array<string,mixed>> $dataSources */
    public function putDataSources(array $dataSources): PlatformResult;
}
