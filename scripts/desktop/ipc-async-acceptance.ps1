# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
<#
.SYNOPSIS
  Packaged Windows acceptance: WebView → Tauri → pipe with controllable test sidecar.

.DESCRIPTION
  Builds desktop/ipc-test-sidecar, points STUDY_SOLVER_ENGINE at it, sets
  STUDY_IPC_ACCEPTANCE=1, and launches Hold'em Study. The WebView runs concurrent
  invokes: values is withheld while status + cancel complete; process exits 0 on pass.

.PARAMETER StudyExe
  Path to Holdem Study.exe (packaged or tauri build output). Required for the
  full WebView gate.

.PARAMETER TimeoutSec
  Wall clock for the Study process (default 120).
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$StudyExe,
  [int]$TimeoutSec = 120
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$SidecarDir = Join-Path $Root "desktop\ipc-test-sidecar"

Write-Host "==> Building ipc-test-sidecar"
Push-Location $SidecarDir
try {
  cargo build --release
} finally {
  Pop-Location
}

$Sidecar = Join-Path $SidecarDir "target\release\ipc-test-sidecar.exe"
if (-not (Test-Path $Sidecar)) {
  $Sidecar = Join-Path $SidecarDir "target\debug\ipc-test-sidecar.exe"
}
if (-not (Test-Path $Sidecar)) {
  throw "ipc-test-sidecar.exe not found under desktop/ipc-test-sidecar/target"
}
if (-not (Test-Path $StudyExe)) {
  throw "Study exe not found: $StudyExe"
}

$env:STUDY_SOLVER_ENGINE = (Resolve-Path $Sidecar).Path
$env:STUDY_IPC_ACCEPTANCE = "1"
Write-Host "STUDY_SOLVER_ENGINE=$env:STUDY_SOLVER_ENGINE"
Write-Host "STUDY_IPC_ACCEPTANCE=$env:STUDY_IPC_ACCEPTANCE"
Write-Host "==> Launching Study: $StudyExe (timeout ${TimeoutSec}s)"

$proc = Start-Process -FilePath $StudyExe -PassThru
if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
  try { $proc.Kill() } catch {}
  throw "ipc async acceptance timed out after ${TimeoutSec}s"
}
if ($proc.ExitCode -ne 0) {
  throw "ipc async acceptance FAILED (exit $($proc.ExitCode))"
}
Write-Host "ipc async acceptance PASS"
exit 0
