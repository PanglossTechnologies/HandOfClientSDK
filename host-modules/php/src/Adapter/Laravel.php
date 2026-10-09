<?php

declare(strict_types=1);

namespace HandOfClient\Host\Adapter;

use HandOfClient\Host\HostModule;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Route;

/**
 * Laravel adapter. In routes/web.php (or a service provider's boot()):
 *
 *     Laravel::routes($module);                       // serves /hoc/token, /hoc/api/*, /hoc/webhook
 *
 * Routes run in the `web` middleware group, so the session and `$request->user()` work in getCurrentUser. The
 * webhook is always exempt from CSRF (the platform has no CSRF token; its HMAC signature is the credential); the
 * browser routes follow your CSRF policy unless you pass csrfExempt: true. Prefer sending the CSRF header from the
 * page script (embed.js lets you replace `fetch`).
 */
final class Laravel
{
    /** The CSRF middleware of each Laravel generation (only those that exist are used). */
    private const CSRF_MIDDLEWARE = [
        'Illuminate\Foundation\Http\Middleware\PreventRequestForgery', // 13+
        'Illuminate\Foundation\Http\Middleware\VerifyCsrfToken',
        'Illuminate\Foundation\Http\Middleware\ValidateCsrfToken',
        'App\Http\Middleware\VerifyCsrfToken',
    ];

    /**
     * Register the routes.
     *
     * @param list<string> $middleware groups / middleware to run the routes in
     */
    public static function routes(HostModule $module, string $prefix = 'hoc', bool $csrfExempt = false, array $middleware = ['web']): void
    {
        $handler = static fn (Request $request, string $path = '') => self::respond($module, $request, $path);
        $csrf = array_values(array_filter(self::CSRF_MIDDLEWARE, 'class_exists'));
        Route::middleware($middleware)->prefix(trim($prefix, '/'))->group(static function () use ($handler, $csrf, $csrfExempt): void {
            Route::post('webhook', static fn (Request $request) => $handler($request, 'webhook'))->withoutMiddleware($csrf)->name('handofclient.webhook');
            $browser = Route::match(['GET', 'POST', 'PUT', 'DELETE'], '{path?}', $handler)->where('path', '.*')->name('handofclient.api');
            if ($csrfExempt) {
                $browser->withoutMiddleware($csrf);
            }
        });
    }

    /** What the routes call; use it directly from your own controller if you prefer. $path is relative to the prefix. */
    public static function respond(HostModule $module, Request $request, string $path = ''): Response
    {
        $headers = [];
        foreach ($request->headers->all() as $name => $values) {
            $headers[strtolower((string) $name)] = (string) ($values[0] ?? '');
        }
        $response = $module->handle(
            $request->getMethod(),
            $path,
            (string) $request->server->get('QUERY_STRING', ''), // the raw string: getQueryString() re-sorts it
            $headers,
            $request->getContent(),
            $request,
        );
        // After the response has been sent (Laravel's terminate phase), retry builds the platform could not take.
        app()->terminating(static fn () => $module->runDeferred());

        return new Response($response->body(), $response->status, $response->headers());
    }
}
