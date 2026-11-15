# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
<#
.SYNOPSIS
  Windows installer E2E — Stage A (WebView drive) + Stage B (river PSOL round-trip).

.DESCRIPTION
  Smokes the exact NSIS artifact under test (PR installer when this job runs
  after windows-installer on the same workflow; else pass -InstallerExe for a
  post-merge artifact of the same commit).

  Stage A (default):
    1. Silent-install the artifact with an explicit /D= install dir
       (avoids Tauri NSIS relative placeholder\PRODUCTNAME resolving against cwd)
    2. Launch Study in an interactive Windows session with
       STUDY_INSTALLER_E2E=stage-a so the WebView boot hook drives
       ensure_solver_engine + status (proves WebView control)
    3. Explicit timeouts; on failure report lastCompletedStep + diagnostics

  Stage B (-Stage B; requires STUDY_INSTALLER_E2E_STAGE_B=1):
    Tiny river solve → browse node → save PSOL → clear active solution
    (kill+re-ensure sidecar) → reopen PSOL → assert strategy restored →
    close; sidecar exits. Same last-step + diagnostics rules.

.PARAMETER InstallerExe
  Path to the NSIS setup exe (artifact from windows-installer job).

.PARAMETER Stage
  A (default) or B.

.PARAMETER OutDir
  Logs + failure diagnostic bundle directory.

.PARAMETER StudyReadySec
  Max seconds for Study + WebView probe to exit (default 120 Stage A / 180 Stage B).

.PARAMETER SidecarExitSec
  Max seconds to wait for solver-engine after Study exits (default 45).

.PARAMETER InstallDir
  Explicit NSIS /D= target (default %LOCALAPPDATA%\Holdem Study).
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerExe,
  [ValidateSet("A", "B")]
  [string]$Stage = "A",
  [string]$OutDir = "",
  [int]$StudyReadySec = 0,
  [int]$SidecarExitSec = 45,
  [string]$InstallDir = ""
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

if ($StudyReadySec -le 0) {
  if ($Stage -eq "B") { $StudyReadySec = 180 } else { $StudyReadySec = 120 }
}

if (-not $InstallDir) {
  $InstallDir = Join-Path $env:LOCALAPPDATA "Holdem Study"
}

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

function Get-SidecarProcesses([string]$InstallDirPath) {
  $target = [System.IO.Path]::GetFullPath((Join-Path $InstallDirPath "solver-engine.exe"))
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

function Invoke-FailureDiagnostics([string]$InstallDirPath) {
  Write-E2E "Collecting diagnostic bundle on failure..."
  $bundleDir = Join-Path $OutDir "diagnostics-bundle"
  $collect = Join-Path $Root "scripts\debug\windows_collect.ps1"
  try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $collect `
      -OutDir $bundleDir `
      -InstallDir $InstallDirPath `
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

# Tauri MAINBINARYNAME follows Cargo package name (poker-solver-study), while
# productName / install folder is "Holdem Study". diagnostics.rs already covers both.
$script:StudyUiExeNames = @(
  "Holdem Study.exe",
  "poker-solver-study.exe"
)

function Get-StudyUiExeNamesFromRegistry {
  $names = New-Object System.Collections.Generic.List[string]
  foreach ($rootKey in @("HKCU:", "HKLM:")) {
    $uninst = Join-Path $rootKey "Software\Microsoft\Windows\CurrentVersion\Uninstall\Holdem Study"
    try {
      $props = Get-ItemProperty -LiteralPath $uninst -ErrorAction Stop
      foreach ($field in @("MainBinaryName", "DisplayIcon")) {
        $raw = [string]$props.$field
        if (-not $raw) { continue }
        # DisplayIcon is often `"C:\...\foo.exe",0`
        if ($raw -match '(?i)([^\\/]+\.exe)') {
          $n = $Matches[1]
          if ($n -and -not ($names -contains $n)) { [void]$names.Add($n) }
        }
      }
    } catch {}
  }
  return @($names)
}

function Resolve-StudyUiExe([string]$InstallDirPath) {
  $ordered = New-Object System.Collections.Generic.List[string]
  foreach ($n in @(Get-StudyUiExeNamesFromRegistry) + $script:StudyUiExeNames) {
    if ($n -and -not ($ordered -contains $n)) { [void]$ordered.Add($n) }
  }
  foreach ($name in $ordered) {
    $path = Join-Path $InstallDirPath $name
    if (Test-Path -LiteralPath $path) {
      return $path
    }
  }
  # Any non-sidecar / non-uninstaller exe beside solver-engine.
  $sidecar = "solver-engine.exe"
  $hit = Get-ChildItem -LiteralPath $InstallDirPath -Filter "*.exe" -File -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -ine $sidecar -and
      $_.Name -notlike "uninstall*" -and
      $_.Name -ine "holdem-explorer.exe"
    } |
    Select-Object -First 1
  if ($hit) {
    return $hit.FullName
  }
  return $null
}

function Find-StudyInstallDir([string]$Preferred) {
  $candidates = New-Object System.Collections.Generic.List[string]
  if ($Preferred) { [void]$candidates.Add($Preferred) }
  foreach ($extra in @(
      (Join-Path $env:LOCALAPPDATA "Holdem Study"),
      (Join-Path $env:LOCALAPPDATA "Programs\Holdem Study"),
      (Join-Path ${env:ProgramFiles} "Holdem Study")
    )) {
    if ($extra -and -not ($candidates -contains $extra)) {
      [void]$candidates.Add($extra)
    }
  }

  # Registry InstallLocation written by Tauri NSIS (currentUser → HKCU).
  foreach ($rootKey in @("HKCU:", "HKLM:")) {
    $uninst = Join-Path $rootKey "Software\Microsoft\Windows\CurrentVersion\Uninstall\Holdem Study"
    try {
      $loc = (Get-ItemProperty -LiteralPath $uninst -ErrorAction Stop).InstallLocation
      if ($loc) {
        $loc = $loc.Trim().Trim('"')
        if ($loc -and -not ($candidates -contains $loc)) {
          [void]$candidates.Insert(0, $loc)
        }
      }
    } catch {}
  }

  foreach ($cand in $candidates) {
    if (-not (Test-Path -LiteralPath $cand)) { continue }
    $ui = Resolve-StudyUiExe $cand
    $sidecar = Join-Path $cand "solver-engine.exe"
    # Prefer dirs that have the UI; accept sidecar-only only for diagnostics below.
    if ($ui) {
      return [pscustomobject]@{ InstallDir = $cand; StudyExe = $ui }
    }
    # Sidecar-only: keep scanning other candidates; failure diag lists contents.
    void $sidecar
  }

  # Last-resort: find either known UI name under LocalAppData.
  foreach ($name in $script:StudyUiExeNames) {
    $hit = Get-ChildItem -LiteralPath $env:LOCALAPPDATA -Recurse -Filter $name `
      -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) {
      return [pscustomobject]@{
        InstallDir = $hit.Directory.FullName
        StudyExe   = $hit.FullName
      }
    }
  }

  # Diagnose: list actual contents when /D= landed but UI name mismatched.
  $diag = @()
  foreach ($cand in $candidates) {
    if (Test-Path -LiteralPath $cand) {
      $listing = @(Get-ChildItem -LiteralPath $cand -Force -ErrorAction SilentlyContinue |
        ForEach-Object { $_.Name }) -join ","
      $diag += "present=$cand contents=[$listing]"
    } else {
      $diag += "missing=$cand"
    }
  }
  $placeholderDir = Join-Path $Root "placeholder\Holdem Study"
  if (Test-Path -LiteralPath $placeholderDir) {
    $listing = @(Get-ChildItem -LiteralPath $placeholderDir -Force -ErrorAction SilentlyContinue |
      ForEach-Object { $_.Name }) -join ","
    $diag += "FOUND_cwd_placeholder=$placeholderDir contents=[$listing]"
  } else {
    $diag += "no_cwd_placeholder=$placeholderDir"
  }
  throw "Study UI exe not found after silent install (tried $($script:StudyUiExeNames -join ', ')). $($diag -join '; ')"
}

$result = [ordered]@{
  ok                 = $false
  stageRequested     = $Stage
  lastCompletedStep  = "init"
  installer          = $InstallerExe
  installDir         = $null
  preferredInstallDir = $InstallDir
  studyExe           = $null
  studyPid           = $null
  studyExitCode      = $null
  sidecarPids        = @()
  interactiveSession = $null
  error              = $null
  remaining          = @()
}

$studyProc = $null
$resolvedInstallDir = $null

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

  # Tauri NSIS InstallDir starts as relative "placeholder\PRODUCTNAME" and only
  # rewrites to %LOCALAPPDATA%\PRODUCTNAME when $INSTDIR still equals that
  # placeholder string. Running from a repo cwd can make NSIS resolve the
  # relative path first, so the rewrite never fires and files land under
  # <cwd>\placeholder\Holdem Study. Always pass absolute /D= (last arg, unquoted).
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Write-E2E "Silent install (/S /D=$InstallDir)..."
  $setup = Start-Process -FilePath $InstallerExe -ArgumentList @("/S", "/D=$InstallDir") -PassThru -Wait
  $setupCode = $setup.ExitCode
  Write-E2E "NSIS ExitCode=$setupCode"
  if ($null -eq $setupCode -or $setupCode -ne 0) {
    throw "NSIS silent install exited $setupCode (expected 0)"
  }
  Set-LastStep "silent-install" $result

  $layout = Find-StudyInstallDir $InstallDir
  $resolvedInstallDir = $layout.InstallDir
  $studyExe = $layout.StudyExe
  $result.installDir = $resolvedInstallDir
  $result.studyExe = $studyExe
  Write-E2E "Install dir: $resolvedInstallDir"
  Write-E2E "Study UI exe: $studyExe"
  Set-LastStep "install-layout-found" $result

  $sidecarExe = Join-Path $resolvedInstallDir "solver-engine.exe"
  foreach ($path in @($studyExe, $sidecarExe)) {
    if (-not (Test-Path -LiteralPath $path)) {
      throw "Missing installed file: $path"
    }
    Write-E2E "Present: $path ($((Get-Item -LiteralPath $path).Length) bytes)"
  }
  $legacy = Join-Path $resolvedInstallDir "holdem-explorer.exe"
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

  Get-SidecarProcesses $resolvedInstallDir | ForEach-Object {
    Write-E2E "Killing leftover sidecar PID $($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1

  $stageEnv = if ($Stage -eq "B") { "stage-b" } else { "stage-a" }
  $stageBGate = if ($Stage -eq "B") { "1" } else { "0" }
  $psolPath = Join-Path $OutDir "stage-b-roundtrip.psol"

  Write-E2E "Launching Study for Stage $Stage WebView drive: $studyExe"
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $studyExe
  $psi.UseShellExecute = $false
  $psi.WorkingDirectory = $resolvedInstallDir
  foreach ($entry in [System.Environment]::GetEnvironmentVariables().GetEnumerator()) {
    try { $psi.Environment[$entry.Key] = [string]$entry.Value } catch {}
  }
  $psi.Environment["STUDY_INSTALLER_E2E"] = $stageEnv
  $psi.Environment["STUDY_INSTALLER_E2E_STAGE_B"] = $stageBGate
  if ($Stage -eq "B") {
    $psi.Environment["STUDY_INSTALLER_E2E_PSOL"] = $psolPath
  }
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
  Write-E2E "Study PID=$($studyProc.Id); waiting up to ${StudyReadySec}s for WebView Stage $Stage exit"

  if (-not $studyProc.WaitForExit($StudyReadySec * 1000)) {
    try { $studyProc.Kill() } catch {}
    throw "Stage $Stage timed out after ${StudyReadySec}s (Study did not exit; WebView hook may not have run — is this build's installer missing STUDY_INSTALLER_E2E?)"
  }
  $result.studyExitCode = $studyProc.ExitCode
  Write-E2E "Study exited code=$($studyProc.ExitCode)"
  if ($studyProc.ExitCode -ne 0) {
    throw "Stage $Stage WebView probe FAILED (Study exit $($studyProc.ExitCode)); see engine.log / diagnostics (lastCompletedStep=study-launched until WebView reports)"
  }
  if ($Stage -eq "B") {
    Set-LastStep "stage-b-webview-pass" $result
  } else {
    Set-LastStep "webview-control-proven" $result
  }
  $studyProc = $null

  $exitDeadline = (Get-Date).AddSeconds($SidecarExitSec)
  while ((Get-Date) -lt $exitDeadline) {
    $left = @(Get-SidecarProcesses $resolvedInstallDir)
    if ($left.Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
  }
  $left = @(Get-SidecarProcesses $resolvedInstallDir)
  if ($left.Count -gt 0) {
    $pids = ($left | ForEach-Object { $_.ProcessId }) -join ", "
    throw "solver-engine still running after Stage $Stage Study exit (PIDs $pids)"
  }
  Set-LastStep "sidecar-exited" $result

  $result.ok = $true
  $result.remaining = @()
  Write-E2E "STAGE $Stage PASS"
}
catch {
  $result.ok = $false
  $result.error = "$_"
  Write-E2E "FAIL lastCompletedStep=$($result.lastCompletedStep): $_"
  if ($studyProc -and -not $studyProc.HasExited) {
    try { $studyProc.Kill() } catch {}
  }
  $diagDir = if ($resolvedInstallDir) { $resolvedInstallDir } else { $InstallDir }
  Invoke-FailureDiagnostics $diagDir
  ($result | ConvertTo-Json -Depth 6) | Set-Content -Path $ResultPath -Encoding utf8
  Write-E2E "Result written: $ResultPath (lastCompletedStep=$($result.lastCompletedStep))"
  exit 1
}
finally {
  $dirForUninstall = if ($resolvedInstallDir) { $resolvedInstallDir } else { $InstallDir }
  if ($dirForUninstall -and (Test-Path -LiteralPath $dirForUninstall)) {
    $uninst = Get-ChildItem -LiteralPath $dirForUninstall -Filter "uninstall*.exe" -ErrorAction SilentlyContinue |
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
