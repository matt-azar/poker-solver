# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
# One-shot evidence collection for the Windows *installed* Holdem Study build.
#
# Run from a poker-solver clone while Study is frozen (preferred) or after a crash:
#   powershell -ExecutionPolicy Bypass -File scripts\debug\windows_collect.ps1
#   powershell -File scripts\debug\windows_collect.ps1 -InstallDir "C:\Program Files\Holdem Study"
#   powershell -File scripts\debug\windows_collect.ps1 -SkipStacks
#
# Requires Python 3.10+ on PATH. Does not kill Study or solver-engine.

[CmdletBinding()]
param(
    [string]$OutDir = "",
    [string]$InstallDir = "",
    [string]$DiagnosticsDir = "",
    [switch]$SkipStacks,
    [switch]$SkipProbes
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $RepoRoot

if (-not $OutDir) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $OutDir = Join-Path $env:TEMP "holdem-study-debug-$stamp"
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

if ($DiagnosticsDir) {
    $env:HOLDEM_STUDY_DIAGNOSTICS_DIR = $DiagnosticsDir
}

$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) { $py = Get-Command python3 -ErrorAction SilentlyContinue }
if (-not $py) {
    Write-Error "Python not found on PATH. Install Python 3.10+ or use Help → Copy diagnostics zip and analyze on another machine."
}

$Python = $py.Source
Write-Host "Using $Python"
Write-Host "Output: $OutDir"

& $Python scripts\debug\capture_snapshot.py --out (Join-Path $OutDir "live-snapshot.json")
& $Python scripts\debug\analyze_diagnostics.py --out (Join-Path $OutDir "diagnostics-analysis.json")
& $Python scripts\debug\find_crash_dumps.py --since-hours 168 --out (Join-Path $OutDir "crash-dumps.json")

if ($InstallDir) {
    $exe = Join-Path $InstallDir "solver-engine.exe"
    if (Test-Path $exe) {
        & $Python scripts\debug\windows_sidecar_check.py --exe $exe --out (Join-Path $OutDir "windows-sidecar-check.json")
        if (-not $SkipProbes) {
            & $Python scripts\debug\ipc_probe.py --binary $exe --out (Join-Path $OutDir "ipc-probe.json")
        }
    } else {
        Write-Warning "solver-engine.exe not found under InstallDir=$InstallDir"
    }
} else {
    & $Python scripts\debug\windows_sidecar_check.py --out (Join-Path $OutDir "windows-sidecar-check.json")
}

$collectArgs = @(
    "scripts\debug\collect_bundle.py",
    "--out", $OutDir,
    "--zip"
)
if (-not $SkipStacks) { $collectArgs += "--stacks" }
if (-not $SkipProbes -and $InstallDir -and (Test-Path (Join-Path $InstallDir "solver-engine.exe"))) {
    # collect_bundle --probes uses zig-out by default; still copy install probe above.
}
& $Python @collectArgs

Write-Host ""
Write-Host "Next:"
Write-Host "  1) If Study is still open: Help → Copy diagnostics zip (attach that too)."
Write-Host "  2) Attach $OutDir.zip to the bug report."
Write-Host "  3) If no dumps: re-run find_crash_dumps.py after enabling LocalDumps (see its output)."
