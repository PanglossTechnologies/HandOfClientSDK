<?php

// Plain PHP conformance app (no framework). Router script for the built-in server:
//   php -S 127.0.0.1:5000 conformance/plain_app.php        (db: HOC_CONFORMANCE_DB)
declare(strict_types=1);

use HandOfClient\Host\Adapter\PlainPhp;
use HandOfClient\Host\Conformance\Profile;

require __DIR__ . '/../vendor/autoload.php';
require __DIR__ . '/profile.php';

$module = Profile::module(static fn ($request) => Profile::userFromCookie($_COOKIE[Profile::COOKIE] ?? null));

if (!PlainPhp::serve($module, '/hoc')) {
    http_response_code(404);
    echo 'not found';
}
