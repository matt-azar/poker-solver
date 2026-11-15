# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
<#
.SYNOPSIS
  Windows installer E2E — Stage A (prove the runner) first; Stage B gated.

.DESCRIPTION
  Smokes the exact NSIS artifact under test (PR installer when this job runs
  after windows-installer on the same workflow; else pass -InstallerExe for a
  post-merge artifact of the same commit).

  Stage A (default; CI pass bar):
    1. Silent-install the artifact
    2. Launch Study in an interactive Windows session with
       STUDY_INSTALLER_E2E=stage-a so the WebView boot hook drives
       ensure_solver_engine + status (proves WebView control)
    3. Explicit timeouts; on failure report lastCompletedStep + diagnostics

  Stage B (-Stage B, also requires STUDY_INSTALLER_E2E_STAGE_B=1 in the app):
    Scaffold only until Stage A is proven green. Intended: tiny river solve →
    browse node → clear active solution → reopen PSOL → assert strategy
    restored → close; sidecar exits. Same last-step + diagnostics rules.

.PARAMETER InstallerExe
  Path to the NSIS setup exe (artifact from windows-installer job).

.PARAMETER Stage
  A (default) or B.

.PARAMETER OutDir
  Logs + failure diagnostic bundle directory.

.PARAMETER StudyReadySec
  Max seconds for Study + Stage A WebView probe to exit (default 120).

.PARAMETER SidecarExitSec
  Max seconds to wait for solver-engine after Study exits (default 45).
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerExe,
  [ValidateSet("A", "B")]
  [string]$Stage = "A",
  [string]$OutDir = "",
  [int]$StudyReadySec = 120,
  [int]$SidecarExitSec = 45
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $Root

if (-not $OutDir) {
  if ($env:RUNNER_TEMP) {
    $OutDir = Join-Path $env:RUNNER_TEMP "windows-installer-e2e"
  } else {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $OutDir = Join-Path $env:TEMP "windows-installer-e2e-$stamp"
  }
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$LogPath = Join-Path $OutDir "e2e-log.txt"
$ResultPath = Join-Path $OutDir "e2e-result.json"
$LastStepPath = Join-Path $OutDir "last-completed-step.txt"

function Write-E2E([string]$Message) {
  $line = "[{0}] {1}" -f (Get-Date -Format "o"), $Message
  Write-Host $line
  Add-Content -Path $LogPath -Value $line
}

function Set-LastStep([string]$Step, $ResultObj) {
  $ResultObj.lastCompletedStep = $Step
  Set-Content -Path $LastStepPath -Value $Step -Encoding utf8
  Write-E2E "lastCompletedStep=$Step"
}

function Get-SidecarProcesses([string]$InstallDir) {
  $target = [System.IO.Path]::GetFullPath((Join-Path $InstallDir "solver-engine.exe"))
  $hits = @()
  Get-CimInstance Win32_Process -Filter "Name='solver-engine.exe'" -ErrorAction SilentlyContinue |
    ForEach-Object {
      $path = $_.ExecutablePath
      if (-not $path) {
        try {
          $path = (Get-Process -Id $_.ProcessId -ErrorAction Stop).Path
        } catch {
          $path = $null
        }
      }
      if ($path -and ([System.IO.Path]::GetFullPath($path) -ieq $target)) {
        $hits += $_
      }
    }
  return $hits
}

function Invoke-FailureDiagnostics([string]$InstallDir) {
  Write-E2E "Collecting diagnostic bundle on failure..."
  $bundleDir = Join-Path $OutDir "diagnostics-bundle"
  $collect = Join-Path $Root "scripts\debug\windows_collect.ps1"
  try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $collect `
      -OutDir $bundleDir `
      -InstallDir $InstallDir `
      -SkipStacks
  } catch {
    Write-E2E "windows_collect.ps1 failed: $_"
    $py = Get-Command python -ErrorAction SilentlyContinue
    if (-not $py) { $py = Get-Command python3 -ErrorAction SilentlyContinue }
    if ($py) {
      & $py.Source (Join-Path $Root "scripts\debug\collect_bundle.py") `
        --out $bundleDir --zip
    }
  }
}

$result = [ordered]@{
  ok                 = $false
  stageRequested     = $Stage
  lastCompletedStep  = "init"
  installer          = $InstallerExe
  installDir         = $null
  studyPid           = $null
  studyExitCode      = $null
  sidecarPids        = @()
  interactiveSession = $null
  error              = $null
  remaining          = @()
}

$studyProc = $null
$installDir = $null

try {
  $result.interactiveSession = [ordered]@{
    sessionId = (Get-Process -Id $PID).SessionId
    userName  = $env:USERNAME
  }
  Write-E2E "Runner sessionId=$($result.interactiveSession.sessionId) user=$($result.interactiveSession.userName)"
  if ($result.interactiveSession.sessionId -eq 0) {
    throw "Interactive Windows session required for WebView drive (sessionId=0 / Session 0 isolation). Use a logged-on desktop runner or GitHub windows-latest interactive user session."
  }
  Set-LastStep "session-ok" $result

  if (-not (Test-Path -LiteralPath $InstallerExe)) {
    throw "Installer exe not found: $InstallerExe"
  }
  $InstallerExe = (Resolve-Path -LiteralPath $InstallerExe).Path
  $result.installer = $InstallerExe
  Write-E2E "Installer (exact artifact under test): $InstallerExe"
  Write-E2E "Size: $((Get-Item -LiteralPath $InstallerExe).Length) bytes"
  Unblock-File -LiteralPath $InstallerExe -ErrorAction SilentlyContinue
  Set-LastStep "artifact-resolved" $result

  Write-E2E "Silent install (/S)..."
  $setup = Start-Process -FilePath $InstallerExe -ArgumentList "/S" -PassThru -Wait
  if ($setup.ExitCode -ne 0 -and $null -ne $setup.ExitCode) {
    throw "NSIS silent install exited $($setup.ExitCode)"
  }
  Set-LastStep "silent-install" $result

  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\Holdem Study"),
    (Join-Path $env:LOCALAPPDATA "Holdem Study"),
    (Join-Path ${env:ProgramFiles} "Holdem Study")
  )
  foreach ($cand in $candidates) {
    $exe = Join-Path $cand "Holdem Study.exe"
    if (Test-Path -LiteralPath $exe) {
      $installDir = $cand
      break
    }
  }
  if (-not $installDir) {
    throw "Holdem Study.exe not found after silent install. Tried: $($candidates -join '; ')"
  }
  $result.installDir = $installDir
  Write-E2E "Install dir: $installDir"
  Set-LastStep "install-layout-found" $result

  $studyExe = Join-Path $installDir "Holdem Study.exe"
  $sidecarExe = Join-Path $installDir "solver-engine.exe"
  foreach ($path in @($studyExe, $sidecarExe)) {
    if (-not (Test-Path -LiteralPath $path)) {
      throw "Missing installed file: $path"
    }
    Write-E2E "Present: $path ($((Get-Item -LiteralPath $path).Length) bytes)"
  }
  $legacy = Join-Path $installDir "holdem-explorer.exe"
  if (Test-Path -LiteralPath $legacy) {
    throw "Legacy holdem-explorer.exe must not ship: $legacy"
  }
  Set-LastStep "verify-layout" $result

  $py = Get-Command python -ErrorAction SilentlyContinue
  if (-not $py) { $py = Get-Command python3 -ErrorAction SilentlyContinue }
  if (-not $py) { throw "Python not on PATH (PE checks)" }
  & $py.Source (Join-Path $Root "scripts\zig\check-pe-subsystem.py") $sidecarExe --expect 2
  & $py.Source (Join-Path $Root "scripts\zig\check-no-avx512.py") $sidecarExe
  Set-LastStep "pe-checks" $result

  Get-SidecarProcesses $installDir | ForEach-Object {
    Write-E2E "Killing leftover sidecar PID $($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1

  if ($Stage -eq "B") {
    $result.remaining = @(
      "Stage B: WebView river solve → browse node → clear active solution → reopen PSOL → assert strategy restored → close + sidecar exit"
    )
    Set-LastStep "stage-b-gated" $result
    throw "Stage B is scaffold-only until Stage A is proven green in CI. Do not pass -Stage B yet (set STUDY_INSTALLER_E2E_STAGE_B=1 only after Stage A passes)."
  }

  Write-E2E "Launching Study for Stage A WebView drive: $studyExe"
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $studyExe
  $psi.UseShellExecute = $false
  $psi.WorkingDirectory = $installDir
  foreach ($entry in [System.Environment]::GetEnvironmentVariables().GetEnumerator()) {
    try { $psi.Environment[$entry.Key] = [string]$entry.Value } catch {}
  }
  $psi.Environment["STUDY_INSTALLER_E2E"] = "stage-a"
  $psi.Environment["STUDY_INSTALLER_E2E_STAGE_B"] = "0"
  if ($env:HOLDEM_STUDY_DIAGNOSTICS_DIR) {
    $psi.Environment["HOLDEM_STUDY_DIAGNOSTICS_DIR"] = $env:HOLDEM_STUDY_DIAGNOSTICS_DIR
  }

  $studyProc = New-Object System.Diagnostics.Process
  $studyProc.StartInfo = $psi
  if (-not $studyProc.Start()) {
    throw "Failed to start Study process"
  }
  $result.studyPid = $studyProc.Id
  Set-LastStep "study-launched" $result
  Write-E2E "Study PID=$($studyProc.Id); waiting up to ${StudyReadySec}s for WebView Stage A exit"

  if (-not $studyProc.WaitForExit($StudyReadySec * 1000)) {
    try { $studyProc.Kill() } catch {}
    throw "Stage A timed out after ${StudyReadySec}s (Study did not exit; WebView hook may not have run — is this build's installer missing STUDY_INSTALLER_E2E?)"
  }
  $result.studyExitCode = $studyProc.ExitCode
  Write-E2E "Study exited code=$($studyProc.ExitCode)"
  if ($studyProc.ExitCode -ne 0) {
    throw "Stage A WebView probe FAILED (Study exit $($studyProc.ExitCode)); see engine.log / diagnostics (lastCompletedStep=study-launched until WebView reports)"
  }
  Set-LastStep "webview-control-proven" $result
  $studyProc = $null

  $exitDeadline = (Get-Date).AddSeconds($SidecarExitSec)
  while ((Get-Date) -lt $exitDeadline) {
    $left = @(Get-SidecarProcesses $installDir)
    if ($left.Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
  }
  $left = @(Get-SidecarProcesses $installDir)
  if ($left.Count -gt 0) {
    $pids = ($left | ForEach-Object { $_.ProcessId }) -join ", "
    throw "solver-engine still running after Stage A Study exit (PIDs $pids)"
  }
  Set-LastStep "sidecar-exited" $result

  $result.ok = $true
  $result.remaining = @(
    "Stage B (gated): river solve → browse → clear solution → reopen PSOL → strategy restore → close + sidecar exit"
  )
  Write-E2E "STAGE A PASS"
}
catch {
  $result.ok = $false
  $result.error = "$_"
  Write-E2E "FAIL lastCompletedStep=$($result.lastCompletedStep): $_"
  if ($studyProc -and -not $studyProc.HasExited) {
    try { $studyProc.Kill() } catch {}
  }
  if ($installDir) {
    Invoke-FailureDiagnostics $installDir
  } else {
    Invoke-FailureDiagnostics (Join-Path $env:LOCALAPPDATA "Programs\Holdem Study")
  }
  ($result | ConvertTo-Json -Depth 6) | Set-Content -Path $ResultPath -Encoding utf8
  Write-E2E "Result written: $ResultPath (lastCompletedStep=$($result.lastCompletedStep))"
  exit 1
}
finally {
  if ($installDir) {
    $uninst = Get-ChildItem -LiteralPath $installDir -Filter "uninstall*.exe" -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($uninst) {
      Write-E2E "Silent uninstall: $($uninst.FullName)"
      try {
        Start-Process -FilePath $uninst.FullName -ArgumentList "/S" -Wait -ErrorAction SilentlyContinue
      } catch {
        Write-E2E "Uninstall warning: $_"
      }
    }
  }
}

($result | ConvertTo-Json -Depth 6) | Set-Content -Path $ResultPath -Encoding utf8
Write-E2E "Result written: $ResultPath"
exit 0
