# Local Zig build + test entry point (mirrors .github/workflows/zig.yml defaults).
# Pin -Dcpu=x86_64_v2 so Windows ReleaseFast sidecars stay portable (no host
# AVX-512 APPCRASH on older CPUs — same pin as windows-installer.yml / zig.yml).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$Optimize = if ($env:ZIG_OPTIMIZE) { $env:ZIG_OPTIMIZE } else { "ReleaseFast" }
$Cpu = if ($env:ZIG_CPU) { $env:ZIG_CPU } else { "x86_64_v2" }

zig build "-Doptimize=$Optimize" "-Dcpu=$Cpu"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
zig build test "-Dcpu=$Cpu"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$engine = "zig-out/bin/solver-engine.exe"
if (-not (Test-Path $engine)) {
  Write-Error "solver-engine.exe missing under zig-out/bin"
}
python scripts/zig/ready-smoke.py $engine
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
