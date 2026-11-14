# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
# Local debug launcher (no Cloudflare).
#
#   powershell -ExecutionPolicy Bypass -File scripts\debug\study-debug-local.ps1
#   # or double-click study-debug-local.cmd
#
# Starts report-receiver on 127.0.0.1, writes
# %USERPROFILE%\.holdem-study\report-webhook.json, opens mini-app + reports folder.

[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CommandArgs
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Entry = Join-Path $ScriptDir "start_local_debug.py"

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
