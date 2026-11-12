# Local Zig build + test entry point (mirrors .github/workflows/zig.yml defaults).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$Optimize = if ($env:ZIG_OPTIMIZE) { $env:ZIG_OPTIMIZE } else { "ReleaseFast" }

zig build "-Doptimize=$Optimize"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
zig build test
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$engine = "zig-out/bin/solver-engine.exe"
if (-not (Test-Path $engine)) {
  Write-Error "solver-engine.exe missing under zig-out/bin"
}
python scripts/zig/ready-smoke.py $engine
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
