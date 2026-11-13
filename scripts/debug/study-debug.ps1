# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
# Front door for Study crash/hang debug tools (Windows PowerShell).
#
#   powershell -ExecutionPolicy Bypass -File scripts\debug\study-debug.ps1
#   powershell -File scripts\debug\study-debug.ps1 collect --zip --stacks
#   powershell -File scripts\debug\study-debug.ps1 analyze --zip .\diagnostics.zip
#
# No args opens the mini-app. Requires Python 3.10+ on PATH.

[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CommandArgs
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Entry = Join-Path $ScriptDir "study_debug.py"

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
Install from https://www.python.org/downloads/ (check 'Add python.exe to PATH')
or analyze a Help → Copy diagnostics zip on another machine.
"@
}

$invokeArgs = @($py.PrefixArgs + @($Entry))
if (-not $CommandArgs -or $CommandArgs.Count -eq 0) {
    $invokeArgs += "gui"
} else {
    $invokeArgs += $CommandArgs
}

Write-Host "Using $($py.Exe) $($invokeArgs -join ' ')"
& $py.Exe @invokeArgs
exit $LASTEXITCODE
