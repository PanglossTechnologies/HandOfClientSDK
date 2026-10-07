<#
.SYNOPSIS
  Builds, publishes, activates, and smoke-checks a HandOfClient plugin against this repo's local
  WordPress dev harness. Generic and reusable: other plugins call this with their own parameters
  from a thin wrapper script in their own repo.

.PARAMETER PluginDir
  Path to the plugin's own package folder (contains package.json, manifest.json, build.mjs).

.PARAMETER PackageId
  The manifest's packageId (e.g. "yaya/site-snapshot").

.PARAMETER SlotId
  The manifest's slots[].slotId to activate and smoke-check (e.g. "yaya-snapshot").

.PARAMETER Version
  The version being published (must match manifest.json's own "version" field).

.PARAMETER TenantId
  Tenant to activate under. Defaults to "localhost", matching the harness's own registered tenant.

.PARAMETER SkipBuild
  Skip `npm run build` in PluginDir (use an already-built bundle-dist/).

.NOTES
  Requires the plugin's manifest.json to target hostId "wp-local" - that is this harness's own host
  registration (see docs/wordpress-host.md and PROGRESS.md 2026-08-26). A manifest aimed at a
  production hostId (e.g. "yayatea") cannot be tested here - EgressGuard blocks private IPs and the
  publish-time validator rejects "localhost" as an egress host, by design (SSRF protection). That is
  a real, already-known limitation, not something this script works around: expect the smoke check
  below to see a graceful "[permission_denied] ... not in ... allowlist" error from the plugin's own
  data call unless PluginDir's manifest declares no egressHosts (proving the MOUNT pipeline only), or
  the harness is later made reachable at a public hostname.
#>
param(
    [Parameter(Mandatory = $true)] [string]$PluginDir,
    [Parameter(Mandatory = $true)] [string]$PackageId,
    [Parameter(Mandatory = $true)] [string]$SlotId,
    [Parameter(Mandatory = $true)] [string]$Version,
    [string]$TenantId = "localhost",
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$pluginDirResolved = (Resolve-Path $PluginDir).Path
$optJsonPath = Join-Path $repoRoot '.wp-local\opt.json'

if (-not (Get-NetTCPConnection -LocalPort 8088 -State Listen -ErrorAction SilentlyContinue)) {
    Write-Host "WordPress harness is not running - starting it first ..."
    & (Join-Path $PSScriptRoot 'start-wordpress.ps1')
    Write-Host "Waiting for it to come up ..."
    $deadline = (Get-Date).AddSeconds(30)
    while (-not (Get-NetTCPConnection -LocalPort 8088 -State Listen -ErrorAction SilentlyContinue)) {
        if ((Get-Date) -gt $deadline) { throw "WordPress harness did not come up within 30s." }
        Start-Sleep -Seconds 1
    }
}

if (-not (Test-Path $optJsonPath)) {
    throw "Harness options not found at $optJsonPath - has setup.mjs ever been run?"
}
$opt = Get-Content $optJsonPath -Raw | ConvertFrom-Json
if ($opt.host_id -ne 'wp-local') {
    throw "Harness is registered as host '$($opt.host_id)', not 'wp-local' - this script assumes the standard local harness pairing."
}
$apiKey = $opt.api_key
$platformHttpUrl = $opt.platform_base_url
# HocClient (the .NET activate client below) requires a TLS channel; the harness's opt.json only
# records the plain-http platform URL used for hoc-publish, so derive the https port the same way
# setup.mjs's own launchSettings.json does (http port + 2000 -> https port is NOT a real convention
# here; the platform's own launchSettings.json is the source of truth instead).
$platformHttpsUrl = "https://localhost:7320"

Write-Host "Building $pluginDirResolved ..."
Push-Location $pluginDirResolved
try {
    if (-not $SkipBuild) {
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed (exit $LASTEXITCODE)." }
    }

    Write-Host "Publishing $PackageId@$Version to $platformHttpUrl ..."
    npx hoc-publish --manifest manifest.json --bundle bundle-dist --api-base-url $platformHttpUrl --api-key $apiKey
    if ($LASTEXITCODE -ne 0) { throw "hoc-publish failed (exit $LASTEXITCODE)." }
}
finally {
    Pop-Location
}

Write-Host "Activating $PackageId@$Version for host wp-local / tenant $TenantId / slot $SlotId ..."
$sampleBootstrap = Join-Path $repoRoot 'tools\sample-bootstrap\HandOfClient.SampleBootstrap'
dotnet run --project $sampleBootstrap -- activate `
    --api-base-url $platformHttpsUrl --host-api-key $apiKey --host-id wp-local --tenant-id $TenantId `
    --package-id $PackageId --slot-id $SlotId --version $Version
if ($LASTEXITCODE -ne 0) { throw "activate failed (exit $LASTEXITCODE)." }

Write-Host "Smoke-checking admin.php?page=hoc-slot-$SlotId ..."
# Uses curl.exe, not Invoke-WebRequest: PowerShell's Invoke-WebRequest/HttpClient POST against PHP's
# built-in dev server here silently fails the wp-login.php form post (200 with the login page again,
# no redirect, no error) - reproducible, tried a raw body string, explicit content-type, and disabling
# Expect100Continue, none of it fixed. curl.exe (also present on this Windows box) posts the exact
# same form fields successfully. Root cause not chased further - not worth it for a smoke check.
$cookieJar = New-TemporaryFile
try {
    $loginBody = "log=admin&pwd=hocadmin&wp-submit=Log+In&redirect_to=http%3A%2F%2Flocalhost%3A8088%2Fwp-admin%2F&testcookie=1"
    curl.exe -s -c $cookieJar -b $cookieJar -L -d $loginBody `
        -H "Cookie: wordpress_test_cookie=WP+Cookie+check" `
        "http://localhost:8088/wp-login.php" -o NUL
    if ($LASTEXITCODE -ne 0) { throw "curl login POST failed (exit $LASTEXITCODE)." }

    $pageContent = curl.exe -s -b $cookieJar "http://localhost:8088/wp-admin/admin.php?page=hoc-slot-$SlotId"
    $statusCode = curl.exe -s -o NUL -w "%{http_code}" -b $cookieJar "http://localhost:8088/wp-admin/admin.php?page=hoc-slot-$SlotId"
}
finally {
    Remove-Item $cookieJar -ErrorAction SilentlyContinue
}

$mounted = $pageContent -match [regex]::Escape("data-hoc-slot=`"$SlotId`"")
$sawMountScript = $pageContent -match "HOC_MOUNTS\.push"

if ($statusCode -eq '200' -and $mounted -and $sawMountScript) {
    Write-Host "PASS: $PackageId/$SlotId is registered and mounts on the admin page." -ForegroundColor Green
    Write-Host "Open it in a browser to see the rendered panel: http://localhost:8088/wp-admin/admin.php?page=hoc-slot-$SlotId"
    exit 0
}
else {
    Write-Host "FAIL: expected mount markers not found (HTTP $statusCode)." -ForegroundColor Red
    exit 1
}
