# Shared Windows configure/build/test entry point (mirrors CI Release defaults).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$BuildDir = if ($env:BUILD_DIR) { $env:BUILD_DIR } else { Join-Path $Root "build" }
$BuildBenchmarks = if ($env:BUILD_BENCHMARKS) { $env:BUILD_BENCHMARKS } else { "ON" }

cmake -S $Root -B $BuildDir `
  -G "Visual Studio 17 2022" -A x64 `
  -DBUILD_TESTING=ON `
  -DPOKER_SOLVER_BUILD_BENCHMARKS=$BuildBenchmarks

$targets = @(
  "river_solver", "street_solver", "explorer", "equity_calculator",
  "poker_solver_tests", "poker_engine_tests", "poker_study_tests", "poker_http_tests",
  "equity_tests", "equity_calculator_tests"
)
if ($BuildBenchmarks -eq "ON") {
  $targets += @("street_memory_bench", "street_betting_bench", "street_parallel_bench")
}

$targetArgs = @()
foreach ($t in $targets) {
  $targetArgs += @("--target", $t)
}
cmake --build $BuildDir --config Release --parallel @targetArgs
ctest --test-dir $BuildDir -C Release --output-on-failure
