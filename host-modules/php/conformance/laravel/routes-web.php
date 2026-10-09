<?php

// routes/web.php of the Laravel conformance app (setup-laravel.mjs copies this over the skeleton's file).
// Test configuration only - nothing here is for production.
declare(strict_types=1);

use HandOfClient\Host\Adapter\Laravel;
use HandOfClient\Host\Conformance\Profile;
use HandOfClient\Host\Storage\SqlStorage;
use Illuminate\Support\Facades\DB;

require_once base_path('../host-modules/php/conformance/profile.php');

$module = Profile::module(
    // The suite signs in with a plain `hoc_user` cookie. Laravel's EncryptCookies drops cookies it did not encrypt, so
    // read the raw one; a real site would use $request->user() here.
    static fn ($request) => Profile::userFromCookie($_COOKIE[Profile::COOKIE] ?? null),
    // The app's own database connection: proves SqlStorage works on a PDO it does not own.
    new SqlStorage(DB::connection()->getPdo()),
);

// HOC_CONFORMANCE_CSRF_EXEMPT=0 keeps Laravel's CSRF protection on the browser routes (the webhook is exempt either way).
Laravel::routes($module, 'hoc', csrfExempt: Profile::env('HOC_CONFORMANCE_CSRF_EXEMPT', '1') === '1');
