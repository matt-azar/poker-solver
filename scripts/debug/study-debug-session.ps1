# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
# Automated Study crash/hang capture session (Windows).
#
#   powershell -ExecutionPolicy Bypass -File scripts\debug\study-debug-session.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\debug\study-debug-session.ps1 collect
#   # or double-click study-debug-session.cmd

[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CommandArgs
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Entry = Join-Path $ScriptDir "study_debug_session.py"

if (-not (Test-Path $Entry)) {
    Write-Error "missing $Entry"
}

function Find-Python {
    $candidates = @(
        @{ Cmd = "py"; Args = @("-3") },
        @{ Cmd = "python"; Args = @() },
        @{ Cmd = "python3"; Args = @() }
    )
    foreach ($c in $candidates) {
        $found = Get-Command $c.Cmd -ErrorAction SilentlyContinue
        if ($found) {
            return @{ Exe = $found.Source; PrefixArgs = $c.Args }
        }
    }
    return $null
}

$py = Find-Python
if (-not $py) {
    Write-Error @"
Python 3.10+ not found on PATH.
Install from https://www.python.org/downloads/ (check 'Add python.exe to PATH').
"@
}

$invokeArgs = @($py.PrefixArgs + @($Entry))
if ($CommandArgs -and $CommandArgs.Count -gt 0) {
    $invokeArgs += $CommandArgs
}

Write-Host "Using $($py.Exe) $($invokeArgs -join ' ')"
& $py.Exe @invokeArgs
exit $LASTEXITCODE
