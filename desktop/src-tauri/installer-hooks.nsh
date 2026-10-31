; Hold'em Study NSIS installer hooks (Tauri bundle.windows.nsis.installerHooks)
;
; Sidecar naming
; --------------
; tauri.conf.json externalBin is "binaries/holdem-explorer".
; Tauri ships that sidecar next to the app executable as:
;   $INSTDIR\holdem-explorer.exe
; (basename of the externalBin entry — NOT "binaries/holdem-explorer.exe").
;
; CRITICAL: Never taskkill Windows File Explorer (`explorer.exe`).
; The solver sidecar is deliberately named holdem-explorer.exe.

!define SIDECAR_EXE "holdem-explorer.exe"

!macro KillHoldemStudySidecar
  ; Path-scoped stop: only the installed sidecar, never C:\Windows\explorer.exe.
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "$$p = Join-Path ''$INSTDIR'' ''${SIDECAR_EXE}''; Get-CimInstance Win32_Process -Filter \"Name=''${SIDECAR_EXE}''\" -ErrorAction SilentlyContinue | Where-Object { $$_.ExecutablePath -and ($$_.ExecutablePath -ieq $$p) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"'
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro KillHoldemStudySidecar
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro KillHoldemStudySidecar
!macroend
