<#
.SYNOPSIS
  Starts the local WordPress dev harness (the "wp instance" used to test HandOfClient WordPress
  plugins) on http://localhost:8088.

.DESCRIPTION
  Thin wrapper over setup.mjs --start. That script is idempotent - if the WordPress/PHP install
  under .wp-local/ already exists, it just re-verifies the plugin is active and launches
  php.exe -S. It only does real work (downloads, install) the first time it runs.

  Runs in a new visible console window (via Start-Process) so PHP's request log / router errors
  are visible, and so the harness keeps running after this script returns. To stop it, run
  stop-wordpress.ps1 in this same folder - do not close the window or kill php.exe by name.

.NOTES
  Companion to stop-wordpress.ps1. See setup.mjs's header comment for why this harness exists
  (native PHP + WordPress + SQLite, not wp-env/Docker).
#>
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$port = 8088

$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    $existingPid = ($existing | Select-Object -First 1 -ExpandProperty OwningProcess)
    Write-Host "Port $port is already in use (PID $existingPid) - the WordPress harness looks like it's already running." -ForegroundColor Yellow
    Write-Host "http://localhost:$port  (admin / hocadmin)"
    exit 0
}

Write-Host "Starting the HandOfClient WordPress dev harness ..."
Start-Process -FilePath "node" `
    -ArgumentList @("host-adapters/wordpress/devharness/setup.mjs", "--start") `
    -WorkingDirectory $repoRoot

Write-Host "Launched in a new window. Once it's up: http://localhost:$port  (admin / hocadmin)"
