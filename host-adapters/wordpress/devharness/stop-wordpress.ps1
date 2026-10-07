<#
.SYNOPSIS
  Stops the local WordPress dev harness (php.exe -S ... on port 8088).

.DESCRIPTION
  Follows the mandatory "resolve by port -> verify by command line -> kill that one PID" procedure
  (see the global CLAUDE.md kill-process rules) rather than killing php.exe by name - a name-based
  kill would hit any other php.exe running on this machine, not just this harness.

  Refuses to kill anything whose command line doesn't reference this repo's .wp-local php.exe.
#>
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$port = 8088

$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $conns) {
    Write-Host "Nothing is listening on port $port - the WordPress harness is not running."
    exit 0
}

$targetPids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($targetPid in $targetPids) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $targetPid" -ErrorAction SilentlyContinue
    if (-not $proc) {
        Write-Host "PID $targetPid vanished before it could be verified - skipping." -ForegroundColor Yellow
        continue
    }

    Write-Host "PID $targetPid  CommandLine: $($proc.CommandLine)"

    $looksRight = $proc.CommandLine -and
                  $proc.CommandLine.Contains('.wp-local\php\php.exe') -and
                  $proc.CommandLine.Contains([IO.Path]::Combine($repoRoot, '.wp-local'))

    if (-not $looksRight) {
        Write-Host "Refusing to stop PID $targetPid - its command line does not look like this repo's WordPress harness (.wp-local\php\php.exe under $repoRoot). Investigate manually before killing anything." -ForegroundColor Red
        continue
    }

    Write-Host "Stopping PID $targetPid ..."
    Stop-Process -Id $targetPid -Force
    Write-Host "Stopped."
}
