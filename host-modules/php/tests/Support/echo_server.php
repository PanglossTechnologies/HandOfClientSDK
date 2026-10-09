<?php

// Router script for `php -S`: answers every request with a JSON description of it (used by PlatformClientTest).
// ?status=NNN picks the status, ?raw=TEXT makes the body that text instead, ?sleep=SECONDS delays.
declare(strict_types=1);

parse_str((string) ($_SERVER['QUERY_STRING'] ?? ''), $q);
if (isset($q['sleep'])) {
    sleep((int) $q['sleep']);
}
http_response_code((int) ($q['status'] ?? 200));
header('Content-Type: application/json');
if (isset($q['raw'])) {
    echo $q['raw'];

    return;
}
echo json_encode([
    'method' => $_SERVER['REQUEST_METHOD'],
    'uri' => $_SERVER['REQUEST_URI'],
    'apiKey' => $_SERVER['HTTP_X_API_KEY'] ?? null,
    'contentType' => $_SERVER['CONTENT_TYPE'] ?? null,
    'body' => file_get_contents('php://input'),
]);
