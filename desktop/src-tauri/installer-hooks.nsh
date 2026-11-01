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
;
; Engine setup
; ------------
; POSTINSTALL verifies the sidecar is present, clears Mark-of-the-Web
; (Zone.Identifier) so SmartScreen does not silently block the first launch,
; and writes a short setup note next to the binaries.

!define SIDECAR_EXE "holdem-explorer.exe"
!define APP_EXE "Holdem Study.exe"

!macro KillHoldemStudySidecar
  ; Path-scoped stop: only the installed sidecar, never C:\Windows\explorer.exe.
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "$$p = Join-Path ''$INSTDIR'' ''${SIDECAR_EXE}''; Get-CimInstance Win32_Process -Filter \"Name=''${SIDECAR_EXE}''\" -ErrorAction SilentlyContinue | Where-Object { $$_.ExecutablePath -and ($$_.ExecutablePath -ieq $$p) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"'
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro KillHoldemStudySidecar
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Verifying Hold'em Study engine sidecar..."
  IfFileExists "$INSTDIR\${SIDECAR_EXE}" sidecar_ok sidecar_missing
  sidecar_missing:
    MessageBox MB_ICONSTOP|MB_OK "Installation incomplete: ${SIDECAR_EXE} is missing from:$\r$\n$INSTDIR$\r$\n$\r$\nRe-download the installer artifact or rebuild the Windows Installer workflow."
    SetErrorLevel 3
    Quit
  sidecar_ok:

  ; Clear Mark-of-the-Web on the app + engine so the first launch is not blocked.
  DetailPrint "Unblocking installed executables (Zone.Identifier)..."
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "$$ErrorActionPreference=''SilentlyContinue''; Unblock-File -LiteralPath (Join-Path ''$INSTDIR'' ''${APP_EXE}''); Unblock-File -LiteralPath (Join-Path ''$INSTDIR'' ''${SIDECAR_EXE}''); Get-ChildItem -LiteralPath ''$INSTDIR'' -Filter ''*.exe'' -File | Unblock-File"'
  Pop $0

  ; Tiny marker so support can confirm engine install ran.
  FileOpen $1 "$INSTDIR\engine-setup.txt" w
  FileWrite $1 "Hold'em Study engine sidecar: ${SIDECAR_EXE}$\r$\n"
  FileWrite $1 "Installed beside the UI in:$\r$\n$INSTDIR$\r$\n"
  FileWrite $1 "The app launches this process on 127.0.0.1:8765.$\r$\n"
  FileClose $1
  DetailPrint "Engine sidecar ready: $INSTDIR\${SIDECAR_EXE}"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro KillHoldemStudySidecar
!macroend
