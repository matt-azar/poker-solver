import { useEffect, useState, type ReactNode } from "react";
import { useSettingsStore } from "../../state/settingsStore";
import { useStudyStore, type WorkspaceId } from "../../state/studyStore";
import { applyDocumentTheme, useThemeStore } from "../../state/themeStore";
import { useHelpChatStore } from "../../state/assistantWindowStore";
import { ensureEngine } from "../../platform/engine";
import { BuildWorkspace } from "../build/BuildWorkspace";
import { CompareWorkspace } from "../compare/CompareWorkspace";
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
    stopPolling();
    useStudyStore.setState({
      connection: "connecting",
      message: "Starting local engine…",
    });
    const result = await ensureEngine();
    if (!result.ok) {
      useStudyStore.setState({
        connection: "disconnected",
        message: `Engine setup failed: ${result.error}`,
      });
      return;
    }
    startPolling();
    await useStudyStore.getState().refresh();
  }

  let body: ReactNode;
  if (workspace === "study") {
    body = <StudyWorkspace />;
  } else if (workspace === "build") {
    body = <BuildWorkspace />;
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
      />
      <HelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
      <SettingsDialog />
      <StudyAssistantWindow />
    </div>
  );
}
