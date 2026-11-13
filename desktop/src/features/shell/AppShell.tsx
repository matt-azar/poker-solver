/**
 * Top-level desktop chrome: menu bar, active workspace, status bar, dialogs.
 * Global colors/type: styles/tokens.css. Shell grid: styles/layout.css (.app-shell*).
 */
import { useEffect, useState, type ReactNode } from "react";
import { useSettingsStore } from "../../state/settingsStore";
import { useStudyStore, type WorkspaceId } from "../../state/studyStore";
import { applyDocumentTheme, useThemeStore } from "../../state/themeStore";
import { useHelpChatStore } from "../../state/assistantWindowStore";
import { BuildWorkspace } from "../build/BuildWorkspace";
import { CompareWorkspace } from "../compare/CompareWorkspace";
import { EquityWorkspace } from "../equity/EquityWorkspace";
import { LibraryWorkspace } from "../library/LibraryWorkspace";
import { StudyWorkspace } from "../study/StudyWorkspace";
import { StudyAssistantWindow } from "../assistant/StudyAssistantWindow";
import { HelpOverlay, MenuBar } from "./MenuBar";
import { SettingsDialog } from "./SettingsDialog";
import { StatusBar } from "./StatusBar";

export function AppShell() {
  const workspace = useStudyStore((s) => s.workspace);
  const setWorkspace = useStudyStore((s) => s.setWorkspace);
  // themeStore is the single display + preference authority (R15).
  const theme = useThemeStore((s) => s.theme);
  const setEvDisplayBasis = useStudyStore((s) => s.setEvDisplayBasis);
  const settings = useSettingsStore((s) => s.settings);
  const message = useStudyStore((s) => s.message);
  const connection = useStudyStore((s) => s.connection);
  const phase = useStudyStore((s) => s.phase);
  const status = useStudyStore((s) => s.status);
  const startPolling = useStudyStore((s) => s.startPolling);
  const stopPolling = useStudyStore((s) => s.stopPolling);
  const recoverEngineSession = useStudyStore((s) => s.recoverEngineSession);
  const reopenLastCheckpoint = useStudyStore((s) => s.reopenLastCheckpoint);
  const assistantOpen = useHelpChatStore((s) => s.layout.visible);
  const toggleAssistant = useHelpChatStore((s) => s.toggleVisible);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    applyDocumentTheme(theme);
  }, [theme]);

  // Sync non-theme settings into the study store only — do not push
  // settings.themePreference into themeStore (that wiped Theme-button choices).
  useEffect(() => {
    setEvDisplayBasis(settings.evDisplayBasis);
  }, [settings.evDisplayBasis, setEvDisplayBasis]);

  useEffect(() => {
    // If boot already failed ensure_engine, keep that message until Reconnect.
    if (useStudyStore.getState().connection === "disconnected") {
      return () => stopPolling();
    }
    startPolling();
    return () => stopPolling();
  }, [startPolling, stopPolling]);

  async function reconnectEngine() {
    // Durable recovery path (ZR-123): re-ensure + clear sticky busy/cancel.
    const result = await recoverEngineSession();
    if (result.ok) {
      console.info("[tauri] recover engine session ok");
    } else {
      console.warn("[tauri] recover engine session failed", result.error);
    }
  }

  async function reopenCheckpoint() {
    // ZR-157: action backed by last successful Save/Open, not path-only copy.
    const result = await reopenLastCheckpoint();
    if (result.ok) {
      console.info("[tauri] reopen last checkpoint ok", result.path);
    } else {
      console.warn("[tauri] reopen last checkpoint failed", result.error);
    }
  }

  let body: ReactNode;
  if (workspace === "study") {
    body = <StudyWorkspace />;
  } else if (workspace === "build") {
    body = <BuildWorkspace />;
  } else if (workspace === "equity") {
    body = <EquityWorkspace />;
  } else if (workspace === "compare") {
    body = <CompareWorkspace />;
  } else {
    body = <LibraryWorkspace />;
  }

  return (
    <div className="app-shell">
      <MenuBar
        workspace={workspace}
        onWorkspace={(id: WorkspaceId) => setWorkspace(id)}
        helpOpen={helpOpen}
        onHelpOpen={setHelpOpen}
        assistantOpen={assistantOpen}
        onAssistantToggle={toggleAssistant}
      />
      <div className="app-body">{body}</div>
      <StatusBar
        message={message}
        connection={connection}
        phase={phase}
        status={status}
        onReconnect={() => {
          void reconnectEngine();
        }}
        onReopenLastCheckpoint={() => {
          void reopenCheckpoint();
        }}
      />
      <HelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
      <SettingsDialog />
      <StudyAssistantWindow />
    </div>
  );
}
