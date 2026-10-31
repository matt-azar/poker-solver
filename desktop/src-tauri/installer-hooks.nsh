; Hold'em Study NSIS installer hooks (Tauri bundle.windows.nsis.installerHooks)
;
; Sidecar naming
; --------------
; tauri.conf.json externalBin is "binaries/explorer".
; Tauri ships that sidecar next to the app executable as:
;   $INSTDIR\explorer.exe
; (basename of the externalBin entry — NOT "binaries/explorer.exe").
;
; CRITICAL: Do NOT run `taskkill /IM explorer.exe`.
; Windows File Explorer is also named explorer.exe; an image-name kill
; would tear down the user's desktop shell. Always scope by full path
; under $INSTDIR (our bundled sidecar only).
;
; If the externalBin basename is ever renamed (e.g. holdem-explorer),
; update SIDECAR_EXE below to match the new installed filename.

!define SIDECAR_EXE "explorer.exe"

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
