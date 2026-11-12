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
; The solver sidecar is deliberately named holdem-explorer.exe so an
; image-name kill of ${SIDECAR_EXE} cannot touch the desktop shell.
;
; Upgrade / reinstall lock
; ------------------------
; Tauri's CheckIfAppIsRunning only stops the UI image (${MAINBINARYNAME}.exe).
; Force-closing Holdem Study.exe does not run our Rust Exit handler, so
; holdem-explorer.exe often keeps running and NSIS fails with:
;   "Error opening file for writing: …\holdem-explorer.exe"
; (Abort / Retry / Ignore). Ignoring leaves a stale sidecar — PR-only UI
; bumps still "work", which hides the miss.
;
; PREINSTALL therefore: stop the UI (so it cannot respawn the engine), then
; force-stop the sidecar, wait for handles, and Delete the old binary so the
; following File copy always replaces it.
;
; Do NOT !insertmacro CheckIfAppIsRunning here. Tauri 2.5's macro uses fixed
; labels (kill:/cancel:/app_check_done:) and the installer template already
; inserts it once in the same Section — a second insert fails makensis with
; "label kill: already declared". Kill the UI via nsis_tauri_utils instead;
; the later template check then finds nothing and is a no-op.
;
; Engine setup
; ------------
; POSTINSTALL verifies the sidecar is present, clears Mark-of-the-Web
; (Zone.Identifier) so SmartScreen does not silently block the first launch,
; and writes a short setup note next to the binaries.

!define SIDECAR_EXE "holdem-explorer.exe"
; Zig typed-IPC host (tauri.conf externalBin). Present in shipping and
; Zig tech-preview installers; Study still defaults to holdem-explorer.
!define ZIG_ENGINE_EXE "solver-engine.exe"
; Prefer Tauri's MAINBINARYNAME so Zig tech-preview productName renames work.
!define APP_EXE "${MAINBINARYNAME}.exe"

!macro KillHoldemStudyUi
  ; Same helpers CheckIfAppIsRunning uses on its kill path (no duplicate labels).
  DetailPrint "Stopping ${MAINBINARYNAME}.exe if running..."
  !if "${INSTALLMODE}" == "currentUser"
    nsis_tauri_utils::KillProcessCurrentUser "${MAINBINARYNAME}.exe"
  !else
    nsis_tauri_utils::KillProcess "${MAINBINARYNAME}.exe"
  !endif
  Pop $0
!macroend

!macro KillHoldemStudySidecar
  ; Image-name kill is safe: ${SIDECAR_EXE} is not explorer.exe.
  ; /T covers any child helpers; missing process is fine (nonzero exit).
  DetailPrint "Stopping ${SIDECAR_EXE} if running..."
  nsExec::ExecToLog 'taskkill /F /T /IM "${SIDECAR_EXE}"'
  Pop $0
  ; Path-scoped backup: only the installed copy under $INSTDIR.
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "$$target = [System.IO.Path]::GetFullPath((Join-Path ''$INSTDIR'' ''${SIDECAR_EXE}'')); Get-CimInstance Win32_Process -Filter \"Name=''${SIDECAR_EXE}''\" -ErrorAction SilentlyContinue | ForEach-Object { $$path = $$_.ExecutablePath; if (-not $$path) { try { $$path = (Get-Process -Id $$_.ProcessId -ErrorAction Stop).Path } catch { $$path = $$null } }; if ($$path -and ([System.IO.Path]::GetFullPath($$path) -ieq $$target)) { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue } }"'
  Pop $0
!macroend

!macro KillZigSolverEngine
  ; Safe: solver-engine.exe is not explorer.exe. Missing process is fine.
  DetailPrint "Stopping ${ZIG_ENGINE_EXE} if running..."
  nsExec::ExecToLog 'taskkill /F /T /IM "${ZIG_ENGINE_EXE}"'
  Pop $0
!macroend

!macro StopHoldemStudyForInstall
  !insertmacro KillHoldemStudyUi
  !insertmacro KillHoldemStudySidecar
  !insertmacro KillZigSolverEngine
  ; Give Windows time to release the exe image section after Stop-Process.
  Sleep 1500
  ClearErrors
  Delete "$INSTDIR\${SIDECAR_EXE}"
  ${If} ${Errors}
    DetailPrint "Old ${SIDECAR_EXE} still present; File copy will overwrite if unlocked."
  ${Else}
    DetailPrint "Removed previous ${SIDECAR_EXE} so setup can replace it."
  ${EndIf}
  ClearErrors
  Delete "$INSTDIR\${ZIG_ENGINE_EXE}"
  ${If} ${Errors}
    DetailPrint "Old ${ZIG_ENGINE_EXE} still present; File copy will overwrite if unlocked."
  ${Else}
    DetailPrint "Removed previous ${ZIG_ENGINE_EXE} so setup can replace it."
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro StopHoldemStudyForInstall
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Verifying Hold'em Study engine sidecar..."
  IfFileExists "$INSTDIR\${SIDECAR_EXE}" sidecar_ok sidecar_missing
  sidecar_missing:
    MessageBox MB_ICONSTOP|MB_OK "Installation incomplete: ${SIDECAR_EXE} is missing from:$\r$\n$INSTDIR$\r$\n$\r$\nRe-download the installer artifact or rebuild the Windows Installer workflow."
    SetErrorLevel 3
    Quit
  sidecar_ok:

  DetailPrint "Verifying Zig solver-engine sidecar..."
  IfFileExists "$INSTDIR\${ZIG_ENGINE_EXE}" zig_ok zig_missing
  zig_missing:
    MessageBox MB_ICONSTOP|MB_OK "Installation incomplete: ${ZIG_ENGINE_EXE} is missing from:$\r$\n$INSTDIR$\r$\n$\r$\nRebuild the Windows installer so both externalBin sidecars are present."
    SetErrorLevel 3
    Quit
  zig_ok:

  ; Clear Mark-of-the-Web on the app + engines so the first launch is not blocked.
  DetailPrint "Unblocking installed executables (Zone.Identifier)..."
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "$$ErrorActionPreference=''SilentlyContinue''; Unblock-File -LiteralPath (Join-Path ''$INSTDIR'' ''${APP_EXE}''); Unblock-File -LiteralPath (Join-Path ''$INSTDIR'' ''${SIDECAR_EXE}''); Unblock-File -LiteralPath (Join-Path ''$INSTDIR'' ''${ZIG_ENGINE_EXE}''); Get-ChildItem -LiteralPath ''$INSTDIR'' -Filter ''*.exe'' -File | Unblock-File"'
  Pop $0

  ; Tiny marker so support can confirm engine install ran.
  FileOpen $1 "$INSTDIR\engine-setup.txt" w
  FileWrite $1 "Hold'em Study engine sidecar: ${SIDECAR_EXE}$\r$\n"
  FileWrite $1 "Zig IPC host (dormant until cutover): ${ZIG_ENGINE_EXE}$\r$\n"
  FileWrite $1 "Installed beside the UI in:$\r$\n$INSTDIR$\r$\n"
  FileWrite $1 "Default Study still launches ${SIDECAR_EXE} on 127.0.0.1:8765.$\r$\n"
  FileClose $1
  DetailPrint "Engine sidecars ready: $INSTDIR\${SIDECAR_EXE} + $INSTDIR\${ZIG_ENGINE_EXE}"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro StopHoldemStudyForInstall
!macroend
