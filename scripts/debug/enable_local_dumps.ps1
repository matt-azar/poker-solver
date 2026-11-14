# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
# One-shot: enable Windows LocalDumps for Holdem Study + solver-engine.
#
# Run once (elevated) from the repo clone:
#   powershell -ExecutionPolicy Bypass -File scripts\debug\enable_local_dumps.ps1
#   scripts\debug\study-debug.cmd enable-dumps
#
# Dumps land in %LOCALAPPDATA%\CrashDumps\ as:
#   Holdem Study.exe.*.dmp
#   solver-engine.exe.*.dmp

[CmdletBinding()]
param(
    [string]$DumpFolder = "",
    [int]$DumpType = 2,   # 0=custom, 1=mini, 2=full
    [int]$DumpCount = 10,
    [switch]$WhatIf,
    [switch]$StatusOnly
)

$ErrorActionPreference = "Stop"

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not $DumpFolder) {
    $DumpFolder = Join-Path $env:LOCALAPPDATA "CrashDumps"
}

$exeNames = @(
    "Holdem Study.exe",
    "solver-engine.exe"
)

$baseKey = "HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps"

function Get-ExeStatus([string]$Name) {
    $key = Join-Path $baseKey $Name
    if (-not (Test-Path $key)) {
        return [pscustomobject]@{
            Exe = $Name
            Enabled = $false
            DumpFolder = $null
            DumpType = $null
            DumpCount = $null
        }
    }
    $props = Get-ItemProperty -Path $key
    return [pscustomobject]@{
        Exe = $Name
        Enabled = $true
        DumpFolder = $props.DumpFolder
        DumpType = $props.DumpType
        DumpCount = $props.DumpCount
    }
}

Write-Host "LocalDumps target folder: $DumpFolder"
Write-Host "DumpType=$DumpType (2=full) DumpCount=$DumpCount"
Write-Host ""

$statuses = @()
foreach ($name in $exeNames) {
    $st = Get-ExeStatus $name
    $statuses += $st
    if ($st.Enabled) {
        Write-Host "[ok] $($st.Exe) DumpFolder=$($st.DumpFolder) Type=$($st.DumpType) Count=$($st.DumpCount)"
    } else {
        Write-Host "[missing] $($st.Exe) — not configured"
    }
}

if ($StatusOnly) {
    $allOk = ($statuses | Where-Object { -not $_.Enabled }).Count -eq 0
    if ($allOk) { exit 0 } else { exit 1 }
}

$need = $statuses | Where-Object {
    -not $_.Enabled -or
    $_.DumpFolder -ne $DumpFolder -or
    [int]$_.DumpType -ne $DumpType -or
    [int]$_.DumpCount -ne $DumpCount
}
if (-not $need -or $need.Count -eq 0) {
    Write-Host ""
    Write-Host "Already configured. Reproduce a crash, then:"
    Write-Host "  scripts\debug\study-debug.cmd dumps --since-hours 48"
    exit 0
}

if (-not (Test-IsAdmin)) {
    Write-Host ""
    Write-Host "Administrator rights required to write HKLM LocalDumps."
    Write-Host "Re-launching elevated…"
    $self = $MyInvocation.MyCommand.Path
    $argList = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", "`"$self`"",
        "-DumpFolder", "`"$DumpFolder`"",
        "-DumpType", "$DumpType",
        "-DumpCount", "$DumpCount"
    )
    if ($WhatIf) { $argList += "-WhatIf" }
    Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $argList -Wait
    # Re-check status in this (non-admin) session after elevation returns.
    $failed = $false
    foreach ($name in $exeNames) {
        $st = Get-ExeStatus $name
        if (-not $st.Enabled) { $failed = $true }
    }
    if ($failed) {
        Write-Host "LocalDumps still incomplete — elevation may have been cancelled."
        exit 1
    }
    Write-Host "LocalDumps enabled."
    exit 0
}

if ($WhatIf) {
    Write-Host "WhatIf: would configure LocalDumps for: $($need.Exe -join ', ')"
    exit 0
}

New-Item -Path $baseKey -Force | Out-Null
New-Item -ItemType Directory -Path $DumpFolder -Force | Out-Null

foreach ($name in $exeNames) {
    $key = Join-Path $baseKey $name
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name DumpFolder -Value $DumpFolder -Type ExpandString
    Set-ItemProperty -Path $key -Name DumpType -Value $DumpType -Type DWord
    Set-ItemProperty -Path $key -Name DumpCount -Value $DumpCount -Type DWord
    Write-Host "configured: $name -> $DumpFolder"
}

Write-Host ""
Write-Host "Done. Next crash of Holdem Study.exe / solver-engine.exe should write a .dmp under:"
Write-Host "  $DumpFolder"
Write-Host "Then: scripts\debug\study-debug.cmd dumps --since-hours 48"
exit 0
