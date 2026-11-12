; Hold'em Study NSIS installer hooks (Tauri bundle.windows.nsis.installerHooks)
;
; Sidecar naming
; --------------
; tauri.conf.json externalBin is "binaries/solver-engine".
; Tauri ships that sidecar next to the app executable as:
;   $INSTDIR\solver-engine.exe
; (basename of the externalBin entry — NOT "binaries/solver-engine.exe").
;
; CRITICAL: Never taskkill Windows File Explorer (`explorer.exe`).
; Image-name kill of ${SIDECAR_EXE} / ${LEGACY_EXPLORER_EXE} cannot touch it.
;
; Upgrade / reinstall lock
; ------------------------
; Tauri's CheckIfAppIsRunning only stops the UI image (${MAINBINARYNAME}.exe).
; Force-closing Holdem Study.exe does not run our Rust Exit handler, so
; solver-engine.exe (and older holdem-explorer.exe installs) often keep running
; and NSIS fails with:
;   "Error opening file for writing: …\solver-engine.exe"
; (Abort / Retry / Ignore). Ignoring leaves a stale sidecar.
;
; PREINSTALL therefore: stop the UI (so it cannot respawn the engine), then
; force-stop sidecars, wait for handles, and Delete the old binaries so the
; following File copy always replaces them.
;
; Do NOT !insertmacro CheckIfAppIsRunning here. Tauri 2.5's macro uses fixed
; labels (kill:/cancel:/app_check_done:) and the installer template already
; inserts it once in the same Section — a second insert fails makensis with
; "label kill: already declared". Kill the UI via nsis_tauri_utils instead;
; the later template check then finds nothing and is a no-op.
;
; Engine setup
; ------------
; POSTINSTALL verifies solver-engine.exe is present, clears Mark-of-the-Web
; (Zone.Identifier) so SmartScreen does not silently block the first launch,
; and writes a short setup note next to the binaries.

!define SIDECAR_EXE "solver-engine.exe"
; Older C++ installs may still have holdem-explorer.exe — kill/delete on upgrade
; so the File copy is not blocked. Not bundled after Zig cutover.
!define LEGACY_EXPLORER_EXE "holdem-explorer.exe"
; Prefer Tauri's MAINBINARYNAME so productName renames work.
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

!macro KillLegacyExplorerSidecar
  ; Safe: holdem-explorer.exe is not explorer.exe. Missing process is fine.
  DetailPrint "Stopping legacy ${LEGACY_EXPLORER_EXE} if running..."
  nsExec::ExecToLog 'taskkill /F /T /IM "${LEGACY_EXPLORER_EXE}"'
  Pop $0
!macroend

!macro StopHoldemStudyForInstall
  !insertmacro KillHoldemStudyUi
  !insertmacro KillHoldemStudySidecar
  !insertmacro KillLegacyExplorerSidecar
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
  Delete "$INSTDIR\${LEGACY_EXPLORER_EXE}"
  ${If} ${Errors}
    DetailPrint "Legacy ${LEGACY_EXPLORER_EXE} still present or absent; continuing."
  ${Else}
    DetailPrint "Removed legacy ${LEGACY_EXPLORER_EXE} from a prior install."
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro StopHoldemStudyForInstall
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Verifying Hold'em Study Zig solver-engine sidecar..."
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
  FileWrite $1 "Transport: Zig typed IPC (protocol 2, inherited pipes)$\r$\n"
  FileWrite $1 "Installed beside the UI in:$\r$\n$INSTDIR$\r$\n"
  FileWrite $1 "Study launches ${SIDECAR_EXE}; HTTP holdem-explorer is not shipped.$\r$\n"
  FileClose $1
  DetailPrint "Engine sidecar ready: $INSTDIR\${SIDECAR_EXE}"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro StopHoldemStudyForInstall
!macroend
