<?php

declare(strict_types=1);

namespace HandOfClient\Host;

use HandOfClient\Host\Platform\PlatformApi;
use HandOfClient\Host\Storage\FeatureRec;
use HandOfClient\Host\Storage\RequestRec;
use HandOfClient\Host\Storage\Storage;
use HandOfClient\Host\Storage\StorageTx;
use HandOfClient\Host\Storage\VersionRec;
use Psr\Log\LoggerInterface;

/**
 * The host module proper: every hoc/token, hoc/api/* and hoc/webhook call, independent of web framework.
 *
 * Adapters (Adapter\PlainPhp, Adapter\Laravel) translate their framework's request into handle() and its
 * HocResponse back. Contract: openapi/site-hoc-api.yaml.
 */
final class HostModule
{
    public const POLICIES = ['owner', 'admins', 'nobody'];
    public const STATUSES = ['InProgress', 'NeedsInfo', 'Rejected', 'Success'];
    public const KINDS = ['slot', 'page-override', 'new-page'];
    public const MODES = ['inject', 'iframe'];
    public const TEXT_MAX = 20000;
    public const SNAPSHOT_MAX = 2 * 1024 * 1024;
    /** Background build retries run at most this often (seconds), across all PHP processes. */
    public const BUILD_RETRY_INTERVAL = 15;
    private const DEFAULT_SETTINGS = [
        'renderingMode' => 'inject',
        'shareWithNamedUsers' => 'owner',
        'shareWithEveryone' => 'admins',
        'viewAllRequests' => 'admins',
        'dataSources' => [],
    ];

    private readonly LoggerInterface $logger;
    /** @var callable */
    private $getCurrentUser;
    /** @var callable */
    private $isAdmin;
    /** @var callable */
    private $findUsers;
    /** @var callable|null */
    private $userExists;
    private bool $migrated = false;
    /** @var list<array{0:string,1:string,2:callable,3:bool}> */
    private array $routes = [];

    /**
     * @param Storage $storage where requests, features, versions and settings live (e.g. SqlStorage::sqlite('hoc.db'))
     * @param PlatformApi $platform the PlatformClient for your tenant
     * @param string $webhookSecret the host's webhook secret (verifies hoc/webhook)
     * @param callable $getCurrentUser f($request): array|object|null; the user has `id` and optionally `name` / `email`;
     *        null means signed out. $request is the framework's own request object (null for plain PHP).
     * @param callable $isAdmin f($user): bool, given what getCurrentUser returned
     * @param callable $findUsers f(string $query): iterable of ['id' => ..., 'name' => ...]; backs the share picker
     * @param callable|null $userExists f(string $userId): bool, to reject unknown ids when sharing; without it the module
     *        asks findUsers for the id and wants an exact match
     * @param string|null $legacyPackageId only for `GET token` without featureId (the original single-plugin endpoint):
     * @param string|null $legacySlotId     the package and slot to mint for, with the tenant's activated version
     * @param bool $autoMigrate run storage->migrate() on first use (one cheap SELECT per request once migrated)
     * @param bool $retryBuilds after a response, retry builds the platform could not take (see runDeferred())
     * @param LoggerInterface|null $logger PSR-3; the default only prints warnings and errors with error_log()
     */
    public function __construct(
        public readonly Storage $storage,
        public readonly PlatformApi $platform,
        private readonly string $webhookSecret,
        callable $getCurrentUser,
        callable $isAdmin,
        callable $findUsers,
        ?callable $userExists = null,
        private readonly ?string $legacyPackageId = null,
        private readonly ?string $legacySlotId = null,
        private readonly bool $autoMigrate = true,
        private readonly bool $retryBuilds = true,
        ?LoggerInterface $logger = null,
    ) {
        if ($webhookSecret === '') {
            throw new \InvalidArgumentException('webhookSecret is required');
        }
        $this->getCurrentUser = $getCurrentUser;
        $this->isAdmin = $isAdmin;
        $this->findUsers = $findUsers;
        $this->userExists = $userExists;
        $this->logger = $logger ?? new ErrorLogLogger();
        $this->buildRoutes();
    }

    // ------------------------------------------------------------------ entry points

    /**
     * Serve one call.
     *
     * @param string $path relative to the mount prefix and already percent-decoded, e.g. "api/features/abc/pin"
     * @param string|array<string,mixed>|null $query raw query string, or parsed (name => value or list of values)
     * @param array<string,string> $headers request headers (names are lower-cased here; only the webhook signature is read)
     * @param string $body the raw request body
     * @param mixed $request handed to getCurrentUser
     */
    public function handle(string $method, string $path, string|array|null $query = null, array $headers = [], string $body = '', mixed $request = null): HocResponse
    {
        $method = strtoupper($method);
        $path = trim($path, '/');
        try {
            $this->ensureReady();
            if ($path === 'webhook' && $method === 'POST') {
                return $this->webhook(array_change_key_case($headers, CASE_LOWER), $body);
            }
            $user = HocUser::from(($this->getCurrentUser)($request));
            if ($user === null) {
                throw HocError::unauthenticated();
            }
            foreach ($this->routes as [$m, $pattern, $handler, $wantsBody]) {
                if ($m !== $method || !preg_match($pattern, $path, $match)) {
                    continue;
                }
                $parsed = null;
                if ($wantsBody && $body !== '') {
                    try {
                        $parsed = Json::decode($body);
                    } catch (\JsonException) {
                        throw HocError::invalid('Malformed JSON.', 'body', 'invalid_format');
                    }
                }
                $this->logger->info('hoc {method} {path} user={user}', ['method' => $method, 'path' => $path, 'user' => $user->id]);

                return $handler(new Call($user, Query::parse($query), $parsed, $body, $parsed !== null && str_starts_with(ltrim($body), '{'), array_slice($match, 1)));
            }
            throw new HocError(404, 'not_found', 'Not found.');
        } catch (HocError $e) {
            return new HocResponse($e->status, $e->toPayload());
        } catch (\Throwable $e) {
            $this->logger->error('hoc {method} {path} failed', ['method' => $method, 'path' => $path, 'exception' => $e]);

            return new HocResponse(500, ['error' => 'internal', 'message' => 'Internal error.']);
        }
    }

    /**
     * Start platform builds for requests that were stored but never reached the platform. Returns how many started.
     * The platform deduplicates on the request id, so calling this again is always safe. Adapters call runDeferred()
     * after each response; also call this from a scheduler (cron, Laravel's schedule) if traffic is low.
     */
    public function retryUnstartedBuilds(int $limit = 100): int
    {
        $this->ensureReady();
        $pending = $this->storage->transaction(static fn (StorageTx $tx): array => $tx->listUnstartedBuilds($limit));
        $started = 0;
        foreach ($pending as $r) {
            if ($this->startBuild($r->id)) {
                $started++;
            }
        }

        return $started;
    }

    /**
     * Work to do after the response is on its way (adapters call this once the response is flushed): at most every
     * BUILD_RETRY_INTERVAL seconds across all processes, retry builds the platform could not take at submit time.
     * PHP has no background threads, so this is what stands in for timers. Never throws.
     */
    public function runDeferred(): void
    {
        if (!$this->retryBuilds || !$this->migrated) {
            return;
        }
        try {
            $now = time();
            $last = $this->storage->transaction(static fn (StorageTx $tx): int => $tx->getBuildRetryAt());
            if ($now - $last < self::BUILD_RETRY_INTERVAL) {
                return;
            }
            if (!$this->storage->transaction(static fn (StorageTx $tx): bool => $tx->swapBuildRetryAt($last, $now), true)) {
                return; // another process took this slot
            }
            $this->retryUnstartedBuilds();
        } catch (\Throwable $e) {
            $this->logger->error('retrying unstarted builds failed', ['exception' => $e]);
        }
    }

    /** False only for `POST webhook` (signature-authenticated), which needs no signed-in user. */
    public static function requiresUser(string $method, string $path): bool
    {
        return !(strtoupper($method) === 'POST' && trim($path, '/') === 'webhook');
    }

    // ------------------------------------------------------------------ plumbing
    private function ensureReady(): void
    {
        if ($this->migrated) {
            return;
        }
        if ($this->autoMigrate) {
            $this->storage->migrate();
        }
        $this->migrated = true;
    }

    private function route(string $method, string $pattern, callable $handler, bool $body = false): void
    {
        $this->routes[] = [$method, '#^' . $pattern . '\z#', $handler, $body];
    }

    private function admin(Call $c): bool
    {
        return $c->admin ??= (bool) ($this->isAdmin)($c->user->raw);
    }

    /** @param array<string,list<string>> $query */
    private static function q1(array $query, string $name): ?string
    {
        return $query[$name][0] ?? null;
    }

    /** @param array<string,list<string>> $query */
    private static function intParam(array $query, string $name, int $default, int $lo, int $hi): int
    {
        $raw = self::q1($query, $name);
        if ($raw === null) {
            return $default;
        }
        if (!preg_match('/^[0-9]+\z/', $raw) || (int) $raw < $lo || (int) $raw > $hi) {
            throw HocError::invalid("$name must be $lo-$hi.", $name, 'out_of_range', null, $hi);
        }

        return (int) $raw;
    }

    /** @return array<string,mixed> */
    private function settings(StorageTx $tx): array
    {
        $merged = [...self::DEFAULT_SETTINGS, ...($tx->getSettings() ?? [])];
        $merged['dataSources'] = array_values(is_array($merged['dataSources'] ?? null) ? $merged['dataSources'] : []);

        return $merged;
    }

    private static function allowedBy(string $policy, bool $admin, bool $owner): bool
    {
        return match ($policy) {
            'nobody' => false,
            'admins' => $admin,
            default => $owner || $admin,
        };
    }

    private function loadVisible(StorageTx $tx, string $featureId, HocUser $user): Loaded
    {
        $f = $tx->getFeature($featureId);
        if ($f === null) {
            throw HocError::notFound();
        }
        $assignments = $tx->getAssignments([$f->id])[$f->id] ?? [];
        $visible = false;
        foreach ($assignments as $a) {
            if ($a->userId === null || $a->userId === $user->id) {
                $visible = true;
                break;
            }
        }
        if (!$visible) {
            throw HocError::notFound();
        }

        return new Loaded($f, $assignments, $tx->getUserState([$f->id], $user->id)[$f->id]);
    }

    /** @return array<string,mixed> */
    private function view(Call $c, Loaded $ld): array
    {
        $f = $ld->feature;
        $out = [
            'id' => $f->id,
            'title' => $f->title,
            'kind' => $f->kind,
            'path' => $f->path,
            'slotId' => $f->slotId,
            'mode' => $f->mode,
            'packageId' => $f->packageId,
            'currentVersion' => $f->currentVersion,
            'pinnedVersion' => $ld->state->pinnedVersion,
            'enabled' => !$ld->state->disabled,
            'ownerUserId' => $f->ownerUserId,
            'requestId' => $f->requestId,
        ];
        if ($f->ownerUserId === $c->user->id || $this->admin($c)) {
            $out['sharing'] = [
                'everyone' => count(array_filter($ld->assignments, static fn ($a): bool => $a->userId === null)) > 0,
                'userIds' => array_values(array_map(static fn ($a): string => (string) $a->userId, array_filter($ld->assignments, static fn ($a): bool => $a->userId !== null))),
            ];
        }

        return $out;
    }

    private function reloadView(StorageTx $tx, Call $c, string $featureId): HocResponse
    {
        return new HocResponse(200, $this->view($c, $this->loadVisible($tx, $featureId, $c->user)));
    }

    /** @return array<string,mixed> */
    private static function publicRequest(RequestRec $r): array
    {
        return [
            'id' => $r->id,
            'text' => $r->text,
            'status' => $r->status,
            'message' => $r->message,
            'featureId' => $r->featureId,
            'userId' => $r->userId,
            'userName' => $r->userName,
            'createdAt' => $r->createdAt,
            'updatedAt' => $r->updatedAt,
        ];
    }

    private static function isBlank(string $s): bool
    {
        return preg_match('/\S/u', $s) !== 1;
    }

    // ------------------------------------------------------------------ routes
    private function buildRoutes(): void
    {
        $this->route('GET', 'token', $this->token(...));
        $this->route('POST', 'api/requests', $this->createRequest(...), true);
        $this->route('GET', 'api/requests', $this->listRequests(...));
        $this->route('POST', 'api/requests/([^/]+)/reply', $this->reply(...), true);
        $this->route('GET', 'api/features', $this->listFeatures(...));
        $this->route('GET', 'api/resolve', $this->resolve(...));
        $this->route('GET', 'api/features/([^/]+)/versions', $this->versions(...));
        $this->route('POST', 'api/features/([^/]+)/pin', $this->pin(...), true);
        $this->route('POST', 'api/features/([^/]+)/current', $this->setCurrent(...), true);
        $this->route('POST', 'api/features/([^/]+)/share', $this->share(...), true);
        $this->route('DELETE', 'api/features/([^/]+)/share/(.+)', $this->unshare(...));
        $this->route('POST', 'api/features/([^/]+)/enabled', $this->enabled(...), true);
        $this->route('GET', 'api/users', $this->users(...));
        $this->route('GET', 'api/settings', $this->getSettings(...));
        $this->route('PUT', 'api/settings', $this->putSettings(...), true);
    }

    // ---- token
    private function token(Call $c): HocResponse
    {
        $featureId = self::q1($c->query, 'featureId');
        if ($featureId === null || $featureId === '') {
            if (!$this->legacyPackageId || !$this->legacySlotId) {
                throw HocError::invalid('featureId is required.', 'featureId', 'required');
            }
            [$packageId, $slotId, $version] = [$this->legacyPackageId, $this->legacySlotId, null];
        } else {
            $ld = $this->storage->transaction(fn (StorageTx $tx): Loaded => $this->loadVisible($tx, $featureId, $c->user));
            if ($ld->state->disabled) {
                throw HocError::notFound();
            }
            $packageId = $ld->feature->packageId;
            $slotId = $ld->feature->slotId;
            $version = $ld->state->pinnedVersion ?: $ld->feature->currentVersion;
        }
        $res = $this->platform->embedToken($c->user->id, $packageId, $slotId, $version);
        if ($res->status === 409) {
            throw new HocError(409, 'version_unavailable', 'That version is no longer available.', platform: HocError::platformFailure($res));
        }
        if (!$res->ok() || !is_array($res->body) || empty($res->body['token'])) {
            throw HocError::platformUnavailable($res);
        }

        return new HocResponse(200, ['token' => $res->body['token'], 'expiresAt' => $res->body['expiresAt'] ?? null, 'userId' => $c->user->id, 'displayName' => $c->user->name]);
    }

    // ---- requests
    private function createRequest(Call $c): HocResponse
    {
        $body = $c->object();
        if ($body === null) {
            throw HocError::invalid('Body must be an object.', 'body', 'wrong_type');
        }
        $text = $body['text'] ?? null;
        if (!is_string($text) || self::isBlank($text)) {
            throw HocError::invalid('text is required.', 'text', 'required');
        }
        if (mb_strlen($text, 'UTF-8') > self::TEXT_MAX) {
            throw new HocError(413, 'payload_too_large', 'The request text is too long.', 'text', 'too_long', limit: self::TEXT_MAX);
        }
        $snapshotJson = null;
        if (isset($body['snapshot'])) {
            // Re-decode as objects so empty `{}` inside the page capture survive instead of becoming `[]`.
            $snapshot = Json::decode($c->rawBody, false)->snapshot ?? null;
            if (!$snapshot instanceof \stdClass) {
                throw HocError::invalid('snapshot must be an object.', 'snapshot', 'wrong_type');
            }
            $snapshotJson = Json::encode($snapshot);
            if (strlen($snapshotJson) > self::SNAPSHOT_MAX) {
                throw new HocError(413, 'payload_too_large', 'The page snapshot is too large.', 'snapshot', 'too_long', limit: self::SNAPSHOT_MAX);
            }
        }
        $featureId = $body['featureId'] ?? null;
        if ($featureId !== null && !is_string($featureId)) {
            throw HocError::invalid('featureId must be a string.', 'featureId', 'wrong_type');
        }
        $rec = $this->storage->transaction(function (StorageTx $tx) use ($c, $text, $featureId, $snapshotJson): RequestRec {
            if ($featureId !== null) {
                $this->loadVisible($tx, $featureId, $c->user);
            }
            $now = TimeUtil::nowIso();
            $rec = new RequestRec(
                'req-' . bin2hex(random_bytes(6)),
                $tx->nextSeq(),
                $c->user->id,
                $c->user->name,
                $c->user->email,
                $text,
                'InProgress',
                null,
                $featureId,
                $featureId,
                $this->settings($tx)['renderingMode'],
                $snapshotJson,
                null,
                $now,
                $now,
            );
            $tx->insertRequest($rec);

            return $rec;
        }, true);
        $this->startBuild($rec->id); // if the platform is down the request stays InProgress; runDeferred() retries it

        return new HocResponse(201, self::publicRequest($rec));
    }

    /** Tell the platform about a stored request. Idempotent on the platform side (keyed by the request id). */
    private function startBuild(string $requestId): bool
    {
        [$r, $feature] = $this->storage->transaction(static function (StorageTx $tx) use ($requestId): array {
            $r = $tx->getRequest($requestId);

            return [$r, $r !== null && !$r->buildId && $r->changeOf ? $tx->getFeature($r->changeOf) : null];
        });
        if ($r === null || $r->buildId) {
            return $r !== null;
        }
        $user = ['id' => $r->userId];
        if ($r->userName) {
            $user['name'] = $r->userName;
        }
        if ($r->userEmail) {
            $user['email'] = $r->userEmail;
        }
        $res = $this->platform->startBuild(
            $r->id,
            $user,
            $r->text,
            $r->mode,
            $r->snapshot ? Json::decode($r->snapshot, false) : null,
            $feature ? ['ref' => $feature->id, 'packageId' => $feature->packageId] : null,
        );
        $buildId = $res->ok() && is_array($res->body) ? ($res->body['buildId'] ?? null) : null;
        if (!$buildId) {
            $this->logger->warning('platform did not take the build for request {request} (status {status})', ['request' => $r->id, 'status' => $res->status]);

            return false;
        }
        $this->storage->transaction(static fn (StorageTx $tx) => $tx->updateRequest($r->id, ['buildId' => (string) $buildId]), true);

        return true;
    }

    private function listRequests(Call $c): HocResponse
    {
        $scope = self::q1($c->query, 'scope') ?? 'mine';
        if (!in_array($scope, ['mine', 'all'], true)) {
            throw HocError::invalid('scope must be mine or all.', 'scope', 'invalid_value', ['mine', 'all']);
        }
        $statuses = $c->query['status'] ?? [];
        foreach ($statuses as $s) {
            if (!in_array($s, self::STATUSES, true)) {
                throw HocError::invalid('Unknown status.', 'status', 'invalid_value', self::STATUSES);
            }
        }
        $limit = self::intParam($c->query, 'limit', 50, 1, 200);
        $offset = 0;
        $cursor = self::q1($c->query, 'cursor');
        if ($cursor !== null) {
            $decoded = base64_decode(strtr($cursor, '-_', '+/'), true);
            if ($decoded === false || !preg_match('/^[0-9]{1,12}\z/', $decoded)) {
                throw HocError::invalid('Bad cursor.', 'cursor', 'invalid_format');
            }
            $offset = (int) $decoded;
        }
        [$rows, $more] = $this->storage->transaction(function (StorageTx $tx) use ($c, $scope, $statuses, $limit, $offset): array {
            if ($scope === 'all') {
                $policy = $this->settings($tx)['viewAllRequests'];
                if (!($policy === 'everyone' || ($policy === 'admins' && $this->admin($c)))) {
                    throw HocError::forbidden("You may not see everyone's requests.");
                }
            }

            return $tx->listRequests($scope === 'all' ? null : $c->user->id, $statuses, $limit, $offset);
        });
        $next = $more ? rtrim(strtr(base64_encode((string) ($offset + $limit)), '+/', '-_'), '=') : null;

        return new HocResponse(200, ['requests' => array_map([self::class, 'publicRequest'], $rows), 'nextCursor' => $next]);
    }

    private function reply(Call $c): HocResponse
    {
        $r = $this->storage->transaction(static fn (StorageTx $tx): ?RequestRec => $tx->getRequest($c->params[0]));
        if ($r === null || $r->userId !== $c->user->id) {
            throw HocError::notFound('No such request.');
        }
        $text = $c->object()['text'] ?? null;
        if (!is_string($text) || self::isBlank($text)) {
            throw HocError::invalid('text is required (max 20000 characters).', 'text', 'required');
        }
        if (mb_strlen($text, 'UTF-8') > self::TEXT_MAX) {
            throw HocError::invalid('text is required (max 20000 characters).', 'text', 'too_long', null, self::TEXT_MAX);
        }
        if ($r->status !== 'NeedsInfo' || !$r->buildId) {
            throw new HocError(409, 'not_awaiting_reply', 'This request is not waiting for an answer.', 'status', 'invalid_value', [$r->status]);
        }
        $replied = $this->platform->replyToBuild($r->buildId, $text);
        if (!$replied->ok()) {
            throw HocError::platformUnavailable($replied);
        }
        $updated = $this->storage->transaction(static function (StorageTx $tx) use ($r): ?RequestRec {
            $tx->updateRequest($r->id, ['status' => 'InProgress', 'message' => null, 'updatedAt' => TimeUtil::nowIso()]);

            return $tx->getRequest($r->id);
        }, true);

        return new HocResponse(200, self::publicRequest($updated ?? $r));
    }

    // ---- features
    /** @return list<Loaded> */
    private function visibleWithState(StorageTx $tx, HocUser $user, ?string $path = null): array
    {
        $feats = $tx->listVisibleFeatures($user->id, $path);
        $ids = array_map(static fn (FeatureRec $f): string => $f->id, $feats);
        $assigns = $tx->getAssignments($ids);
        $states = $tx->getUserState($ids, $user->id);

        return array_map(static fn (FeatureRec $f): Loaded => new Loaded($f, $assigns[$f->id] ?? [], $states[$f->id]), $feats);
    }

    private function listFeatures(Call $c): HocResponse
    {
        $loaded = $this->storage->transaction(fn (StorageTx $tx): array => $this->visibleWithState($tx, $c->user));

        return new HocResponse(200, ['features' => array_map(fn (Loaded $ld): array => $this->view($c, $ld), $loaded)]);
    }

    private function resolve(Call $c): HocResponse
    {
        $path = self::q1($c->query, 'path');
        if ($path === null || !str_starts_with($path, '/')) {
            throw HocError::invalid('path must start with /.', 'path', 'invalid_format');
        }
        $out = $this->storage->transaction(function (StorageTx $tx) use ($c, $path): array {
            $cands = array_values(array_filter($this->visibleWithState($tx, $c->user, $path), static fn (Loaded $ld): bool => !$ld->state->disabled));
            // A user-specific assignment beats "everyone"; among equals the most recently assigned wins.
            $rank = static function (Loaded $ld) use ($c): array {
                $mine = array_values(array_filter($ld->assignments, static fn ($a): bool => $a->userId === $c->user->id));
                $every = array_values(array_filter($ld->assignments, static fn ($a): bool => $a->userId === null));
                $a = $mine[0] ?? $every[0];

                return [$mine ? 1 : 0, $a->seq];
            };
            $pages = array_values(array_filter($cands, static fn (Loaded $ld): bool => $ld->feature->kind !== 'slot'));
            usort($pages, static fn (Loaded $x, Loaded $y): int => $rank($y) <=> $rank($x));
            $chosen = [...array_slice($pages, 0, 1), ...array_filter($cands, static fn (Loaded $ld): bool => $ld->feature->kind === 'slot')];
            $features = [];
            foreach ($chosen as $ld) {
                $f = $ld->feature;
                $wanted = $ld->state->pinnedVersion ?: $f->currentVersion;
                $v = $tx->getVersion($f->id, $wanted);
                if ($v === null) {
                    $this->logger->warning('feature {feature} has no record of version {version}', ['feature' => $f->id, 'version' => $wanted]);
                    continue;
                }
                $features[] = [
                    'featureId' => $f->id,
                    'kind' => $f->kind,
                    'mode' => $f->mode,
                    'slotId' => $f->slotId,
                    'path' => $f->path,
                    'packageId' => $f->packageId,
                    'version' => $v->version,
                    'sha256' => $v->sha256,
                    'entry' => $v->entry,
                ];
            }

            return $features;
        });

        return new HocResponse(200, ['path' => $path, 'features' => $out]);
    }

    private function versions(Call $c): HocResponse
    {
        [$ld, $versions] = $this->storage->transaction(function (StorageTx $tx) use ($c): array {
            $ld = $this->loadVisible($tx, $c->params[0], $c->user);

            return [$ld, $tx->listVersions($ld->feature->id)];
        });

        return new HocResponse(200, [
            'featureId' => $ld->feature->id,
            'currentVersion' => $ld->feature->currentVersion,
            'pinnedVersion' => $ld->state->pinnedVersion,
            'versions' => array_map(static fn (VersionRec $v): array => ['version' => $v->version, 'publishedAt' => $v->publishedAt, 'requestId' => $v->requestId, 'sha256' => $v->sha256], $versions),
        ]);
    }

    private function pin(Call $c): HocResponse
    {
        return $this->storage->transaction(function (StorageTx $tx) use ($c): HocResponse {
            $ld = $this->loadVisible($tx, $c->params[0], $c->user);
            $body = $c->object();
            if ($body === null || !array_key_exists('version', $body) || ($body['version'] !== null && !is_string($body['version']))) {
                throw HocError::invalid('version is required (a version string or null).', 'version', 'required');
            }
            $version = $body['version'];
            if ($version !== null && $tx->getVersion($ld->feature->id, $version) === null) {
                throw new HocError(404, 'version_not_found', 'No such version.', 'version', 'not_found', [(string) $version]);
            }
            $tx->setPin($ld->feature->id, $c->user->id, $version);

            return $this->reloadView($tx, $c, $ld->feature->id);
        }, true);
    }

    private function setCurrent(Call $c): HocResponse
    {
        return $this->storage->transaction(function (StorageTx $tx) use ($c): HocResponse {
            $ld = $this->loadVisible($tx, $c->params[0], $c->user);
            $version = $c->object()['version'] ?? null;
            if (!is_string($version) || $version === '') {
                throw HocError::invalid('version is required.', 'version', 'required');
            }
            if ($ld->feature->ownerUserId !== $c->user->id && !$this->admin($c)) {
                throw HocError::forbidden('Only the owner or an admin may do this.');
            }
            if ($tx->getVersion($ld->feature->id, $version) === null) {
                throw new HocError(404, 'version_not_found', 'No such version.', 'version', 'not_found', [(string) $version]);
            }
            $tx->updateFeature($ld->feature->id, ['currentVersion' => $version]);

            return $this->reloadView($tx, $c, $ld->feature->id);
        }, true);
    }

    private function share(Call $c): HocResponse
    {
        [$ld, $policies] = $this->storage->transaction(fn (StorageTx $tx): array => [$this->loadVisible($tx, $c->params[0], $c->user), $this->settings($tx)]);
        $body = $c->object() ?? [];
        $keys = array_keys($body);
        $named = $keys === ['userIds'] && is_array($body['userIds']) && $body['userIds'] !== [] && Json::isList($body['userIds'])
            && count(array_filter($body['userIds'], 'is_string')) === count($body['userIds']);
        $everyone = $keys === ['everyone'] && $body['everyone'] === true;
        if (!$named && !$everyone) {
            throw HocError::invalid('Send either userIds (non-empty) or everyone: true.', 'userIds', 'required');
        }
        $policy = $everyone ? $policies['shareWithEveryone'] : $policies['shareWithNamedUsers'];
        if (!self::allowedBy($policy, $this->admin($c), $ld->feature->ownerUserId === $c->user->id)) {
            throw new HocError(403, 'sharing_not_allowed', 'Sharing is not allowed for you.');
        }
        /** @var list<string|null> $targets */
        $targets = $everyone ? [null] : array_values(array_unique($body['userIds']));
        if ($named) {
            foreach ($targets as $uid) {
                if ($uid !== $c->user->id && !$this->userKnown((string) $uid)) {
                    throw HocError::invalid('Unknown user id.', 'userIds', 'unknown_user', [(string) $uid]);
                }
            }
        }

        return $this->storage->transaction(function (StorageTx $tx) use ($c, $ld, $targets): HocResponse {
            $this->loadVisible($tx, $ld->feature->id, $c->user);
            foreach ($targets as $t) {
                $tx->addAssignment($ld->feature->id, $t, $tx->nextSeq());
            }

            return $this->reloadView($tx, $c, $ld->feature->id);
        }, true);
    }

    private function userKnown(string $userId): bool
    {
        if ($this->userExists !== null) {
            return (bool) ($this->userExists)($userId);
        }
        foreach (($this->findUsers)($userId) ?? [] as $m) {
            if ((string) HocUser::field($m, 'id') === $userId) {
                return true;
            }
        }

        return false;
    }

    private function unshare(Call $c): HocResponse
    {
        return $this->storage->transaction(function (StorageTx $tx) use ($c): HocResponse {
            $ld = $this->loadVisible($tx, $c->params[0], $c->user);
            if ($ld->feature->ownerUserId !== $c->user->id && !$this->admin($c)) {
                throw HocError::forbidden('Only the owner or an admin may do this.');
            }
            $target = $c->params[1];
            $tx->removeAssignment($ld->feature->id, $target === 'everyone' ? null : $target);

            return $this->reloadView($tx, $c, $ld->feature->id);
        }, true);
    }

    private function enabled(Call $c): HocResponse
    {
        return $this->storage->transaction(function (StorageTx $tx) use ($c): HocResponse {
            $ld = $this->loadVisible($tx, $c->params[0], $c->user);
            $enabled = $c->object()['enabled'] ?? null;
            if (!is_bool($enabled)) {
                throw HocError::invalid('enabled must be a boolean.', 'enabled', 'wrong_type');
            }
            $tx->setDisabled($ld->feature->id, $c->user->id, !$enabled);

            return $this->reloadView($tx, $c, $ld->feature->id);
        }, true);
    }

    private function users(Call $c): HocResponse
    {
        $q = self::q1($c->query, 'query');
        if ($q === null || $q === '') {
            throw HocError::invalid('query is required (max 100 characters).', 'query', 'required');
        }
        if (mb_strlen($q, 'UTF-8') > 100) {
            throw HocError::invalid('query is required (max 100 characters).', 'query', 'too_long', null, 100);
        }
        $limit = self::intParam($c->query, 'limit', 20, 1, 50);
        $policy = $this->storage->transaction(fn (StorageTx $tx): string => $this->settings($tx)['shareWithNamedUsers']);
        if ($policy === 'nobody' || ($policy === 'admins' && !$this->admin($c))) {
            throw new HocError(403, 'sharing_not_allowed', 'Sharing with named users is not allowed for you.');
        }
        $found = [];
        foreach (($this->findUsers)($q) ?? [] as $m) {
            $uid = HocUser::field($m, 'id');
            if ($uid === null || (string) $uid === $c->user->id) {
                continue;
            }
            $name = HocUser::field($m, 'name');
            $found[] = ['id' => (string) $uid, 'name' => $name === null || $name === '' ? null : (string) $name];
            if (count($found) >= $limit) {
                break;
            }
        }

        return new HocResponse(200, ['users' => $found]);
    }

    // ---- settings
    /**
     * @param array<string,mixed> $s
     * @return array<string,mixed>
     */
    private static function publicSettings(array $s): array
    {
        $sources = [];
        foreach ($s['dataSources'] ?? [] as $d) {
            if (isset($d['auth']) && is_array($d['auth'])) {
                $d['auth'] = array_diff_key($d['auth'], ['secretValue' => true]);
            }
            $sources[] = $d;
        }
        $s['dataSources'] = $sources;

        return $s;
    }

    private function getSettings(Call $c): HocResponse
    {
        if (!$this->admin($c)) {
            throw HocError::forbidden('Admins only.');
        }

        return new HocResponse(200, self::publicSettings($this->storage->transaction(fn (StorageTx $tx): array => $this->settings($tx))));
    }

    private function putSettings(Call $c): HocResponse
    {
        if (!$this->admin($c)) {
            throw HocError::forbidden('Admins only.');
        }
        $body = $c->object();
        if ($body === null) {
            throw HocError::invalid('Body must be an object.', 'body', 'wrong_type');
        }
        if (!in_array($body['renderingMode'] ?? null, self::MODES, true)) {
            throw HocError::invalid('renderingMode must be inject or iframe.', 'renderingMode', 'invalid_value', ['inject', 'iframe']);
        }
        foreach (['shareWithNamedUsers', 'shareWithEveryone'] as $f) {
            if (!in_array($body[$f] ?? null, self::POLICIES, true)) {
                throw HocError::invalid('Sharing policies must be owner, admins or nobody.', $f, 'invalid_value', self::POLICIES);
            }
        }
        if (!in_array($body['viewAllRequests'] ?? null, ['admins', 'everyone'], true)) {
            throw HocError::invalid('viewAllRequests must be admins or everyone.', 'viewAllRequests', 'invalid_value', ['admins', 'everyone']);
        }
        // Shape checks on the object-decoded tree: assoc arrays cannot tell [] from {}.
        $tree = Json::decode($c->rawBody, false)->dataSources ?? null;
        if (!is_array($tree)) {
            throw HocError::invalid('dataSources must be an array.', 'dataSources', 'wrong_type');
        }
        $sources = array_values($body['dataSources']);
        foreach ($sources as $i => $d) {
            $t = $tree[$i];
            $at = "dataSources[$i]";
            if (!$t instanceof \stdClass) {
                throw HocError::invalid('Each data source needs a name and baseUrl.', $at, 'wrong_type');
            }
            if (!is_string($d['name'] ?? null) || $d['name'] === '') {
                throw HocError::invalid('Each data source needs a name and baseUrl.', "$at.name", 'required');
            }
            if (!is_string($d['baseUrl'] ?? null)) {
                throw HocError::invalid('Each data source needs a name and baseUrl.', "$at.baseUrl", 'required');
            }
            if (!preg_match('#^[A-Za-z][A-Za-z0-9+.-]*://[^\s/]+#', $d['baseUrl'])) {
                throw HocError::invalid('baseUrl must be a URL.', "$at.baseUrl", 'invalid_format');
            }
            if (($t->auth ?? null) !== null) {
                $auth = $d['auth'];
                if (!$t->auth instanceof \stdClass
                    || ($auth['type'] ?? null) !== 'bearer'
                    || !is_string($auth['secret'] ?? null)
                    || !preg_match('/^[a-z0-9_-]{1,64}\z/', $auth['secret'])
                    || (array_key_exists('secretValue', $auth) && !is_string($auth['secretValue']))) {
                    throw HocError::invalid('auth must be bearer with a secret name [a-z0-9_-]{1,64}.', "$at.auth", 'invalid_format');
                }
            }
        }
        $new = [
            'renderingMode' => $body['renderingMode'],
            'shareWithNamedUsers' => $body['shareWithNamedUsers'],
            'shareWithEveryone' => $body['shareWithEveryone'],
            'viewAllRequests' => $body['viewAllRequests'],
            'dataSources' => self::publicSettings(['dataSources' => $sources])['dataSources'],
        ];
        $old = $this->storage->transaction(fn (StorageTx $tx): array => $this->settings($tx));
        $hasSecretValue = static fn (array $d): bool => is_string($d['auth']['secretValue'] ?? null) && $d['auth']['secretValue'] !== '';
        if (Json::canonical($new['dataSources']) !== Json::canonical($old['dataSources']) || array_filter($sources, $hasSecretValue)) {
            foreach ($sources as $d) {
                if (!$hasSecretValue($d)) {
                    continue;
                }
                $put = $this->platform->putSecret($d['auth']['secret'], $d['auth']['secretValue'], $c->user->id);
                if (!$put->ok()) {
                    throw HocError::platformUnavailable($put);
                }
            }
            $saved = $this->platform->putDataSources($new['dataSources']);
            if (!$saved->ok()) {
                throw HocError::platformUnavailable($saved);
            }
        }
        $this->storage->transaction(static fn (StorageTx $tx) => $tx->saveSettings($new), true);

        return new HocResponse(200, self::publicSettings($new));
    }

    // ------------------------------------------------------------------ webhook
    /** @param array<string,string> $headers lower-case names */
    private function webhook(array $headers, string $raw): HocResponse
    {
        if (!Webhook::verify($this->webhookSecret, $raw, $headers[Webhook::SIGNATURE_HEADER] ?? null)) {
            return new HocResponse(401, ['error' => 'invalid_signature', 'message' => 'Signature missing or wrong.']);
        }
        try {
            $ev = Json::decode($raw);
        } catch (\JsonException) {
            return new HocResponse(400, ['error' => 'invalid_request', 'message' => 'Malformed JSON.', 'field' => 'body', 'reason' => 'invalid_format']);
        }
        if (!is_array($ev) || !str_starts_with(ltrim($raw), '{')) {
            return new HocResponse(400, ['error' => 'invalid_request', 'message' => 'Body must be an object.', 'field' => 'body', 'reason' => 'wrong_type']);
        }
        if (array_key_exists('sentAt', $ev) && Webhook::isStale($ev['sentAt'])) {
            return new HocResponse(400, ['error' => 'stale_event', 'message' => 'sentAt is outside the tolerance.', 'field' => 'sentAt', 'reason' => 'out_of_range']);
        }
        $eventId = $ev['eventId'] ?? null;
        $this->storage->transaction(function (StorageTx $tx) use ($ev, $eventId): void {
            if (is_string($eventId) && $eventId !== '' && !$tx->recordEvent($eventId, TimeUtil::nowIso())) {
                return; // a repeat; nothing was changed in this transaction
            }
            $this->applyEvent($tx, $ev);
        }, true);

        return new HocResponse(200, new \stdClass());
    }

    /** @param array<string,mixed> $ev */
    private function applyEvent(StorageTx $tx, array $ev): void
    {
        $type = $ev['type'] ?? null;
        if ($type !== 'build.status' && $type !== 'build.version') {
            return; // activation.changed (legacy) and anything new: acknowledged, ignored
        }
        $ref = $ev['requestRef'] ?? null;
        $r = is_string($ref) ? $tx->getRequest($ref) : null;
        $now = TimeUtil::nowIso();
        $buildId = $ev['buildId'] ?? null;
        $newBuildId = $r !== null && !$r->buildId && is_string($buildId) && $buildId !== '' ? $buildId : null;
        if ($type === 'build.status') {
            $status = $ev['status'] ?? null;
            if ($r === null || !in_array($status, self::STATUSES, true)) {
                return;
            }
            $message = in_array($status, ['NeedsInfo', 'Rejected'], true) && is_string($ev['message'] ?? null) ? $ev['message'] : null;
            $fields = ['status' => $status, 'message' => $message, 'updatedAt' => $now];
            if ($newBuildId !== null) {
                $fields['buildId'] = $newBuildId;
            }
            $tx->updateRequest($r->id, $fields);

            return;
        }
        $featureRef = $ev['featureRef'] ?? null;
        $version = $ev['version'] ?? null;
        if (!is_string($featureRef) || $featureRef === '' || !is_string($version) || $version === '') {
            $this->logger->warning('ignoring build.version without featureRef/version: {event}', ['event' => $ev['eventId'] ?? '']);

            return;
        }
        $kind = in_array($ev['kind'] ?? null, self::KINDS, true) ? $ev['kind'] : 'page-override';
        $slotId = is_string($ev['slotId'] ?? null) && $ev['slotId'] !== '' ? $ev['slotId'] : 'main';
        $mode = in_array($ev['mode'] ?? null, self::MODES, true) ? $ev['mode'] : ($r !== null ? $r->mode : 'inject');
        $f = $tx->getFeature($featureRef);
        if ($f === null) {
            if ($r === null) {
                $this->logger->warning('build.version for unknown feature {feature} and unknown request {request}', ['feature' => $featureRef, 'request' => (string) $ref]);

                return;
            }
            $f = new FeatureRec(
                $featureRef,
                self::title($r->text),
                $kind,
                is_string($ev['path'] ?? null) ? $ev['path'] : null,
                $slotId,
                $mode,
                is_string($ev['packageId'] ?? null) ? $ev['packageId'] : '',
                $version,
                $r->userId,
                $r->id,
                $now,
            );
            $tx->insertFeature($f);
            $tx->addAssignment($f->id, $r->userId, $tx->nextSeq());
        } else {
            $tx->updateFeature($f->id, ['currentVersion' => $version, 'slotId' => $slotId, 'mode' => $mode]);
        }
        $tx->upsertVersion(new VersionRec(
            $f->id,
            $version,
            $now,
            $r?->id,
            is_string($ev['sha256'] ?? null) ? $ev['sha256'] : '',
            is_string($ev['entry'] ?? null) ? $ev['entry'] : '',
            $tx->nextSeq(),
        ));
        if ($r !== null) {
            $fields = ['featureId' => $f->id, 'updatedAt' => $now];
            if ($newBuildId !== null) {
                $fields['buildId'] = $newBuildId;
            }
            $tx->updateRequest($r->id, $fields);
        }
    }

    /** A short title from the request text: its first non-empty line, whitespace collapsed; longer than 60 is cut to 59 characters plus "...". */
    private static function title(string $text): string
    {
        $lines = preg_split('/\R|[\x1C-\x1E]/u', $text);
        $line = 'Feature';
        foreach (($lines === false ? [$text] : $lines) as $candidate) {
            $stripped = preg_replace('/^\s+|\s+\z/u', '', $candidate) ?? $candidate;
            if ($stripped !== '') {
                $line = $stripped;
                break;
            }
        }
        $line = preg_replace('/\s+/u', ' ', $line) ?? $line;

        return mb_strlen($line, 'UTF-8') <= 60 ? $line : rtrim(mb_substr($line, 0, 59, 'UTF-8')) . '...';
    }
}
