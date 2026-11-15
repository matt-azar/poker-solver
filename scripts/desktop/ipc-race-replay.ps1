# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
<#
.SYNOPSIS
  One-command IPC race / bug-case replay (Windows).

.DESCRIPTION
  Builds desktop/ipc-test-sidecar when needed, then runs ipc_race_replay.py.
  Quick test-sidecar cases only by default — not flop/memory benches.

.PARAMETER Case
  Path to one case JSON (repeatable via remaining args not needed — pass -All).

.PARAMETER All
  Run every test-sidecar case under scripts/desktop/ipc-race-cases/.

.PARAMETER RequireSha
  Fail when case.build_sha does not match git HEAD.

.PARAMETER SkipBuild
  Do not cargo-build the test sidecar (use existing binary or .py fallback).
#>
param(
  [string]$Case = "",
  [switch]$All,
  [switch]$RequireSha,
  [switch]$SkipBuild,
  [string]$Sidecar = "",
  [string]$Engine = ""
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$SidecarDir = Join-Path $Root "desktop\ipc-test-sidecar"
$Replay = Join-Path $Root "scripts\desktop\ipc_race_replay.py"

if (-not $SkipBuild) {
  Write-Host "==> Building ipc-test-sidecar"
  Push-Location $SidecarDir
  try {
    cargo build --release
  } finally {
    Pop-Location
  }
}

$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) {
  $py = Get-Command python3 -ErrorAction SilentlyContinue
}
if (-not $py) {
  throw "python / python3 not found on PATH"
}

$argv = @($Replay)
if ($All -or -not $Case) {
  $argv += @("--all", "--filter-sidecar", "test")
} else {
  $argv += $Case
}
if ($RequireSha) { $argv += "--require-sha" }
if ($Sidecar) { $argv += @("--sidecar", $Sidecar) }
if ($Engine) { $argv += @("--engine", $Engine) }

Write-Host "==> $($py.Source) $($argv -join ' ')"
& $py.Source @argv
exit $LASTEXITCODE
