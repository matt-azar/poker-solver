import { useEffect, useState, type ReactNode } from "react";
import { useStudyStore, type WorkspaceId } from "../../state/studyStore";
import { ensureEngine } from "../../platform/engine";
import { BuildWorkspace } from "../build/BuildWorkspace";
import { CompareWorkspace } from "../compare/CompareWorkspace";
import { LibraryWorkspace } from "../library/LibraryWorkspace";
import { StudyWorkspace } from "../study/StudyWorkspace";
import { HelpOverlay, MenuBar } from "./MenuBar";
import { StatusBar } from "./StatusBar";

export function AppShell() {
  const workspace = useStudyStore((s) => s.workspace);
  const setWorkspace = useStudyStore((s) => s.setWorkspace);
  const theme = useStudyStore((s) => s.theme);
  const message = useStudyStore((s) => s.message);
  const connection = useStudyStore((s) => s.connection);
  const phase = useStudyStore((s) => s.phase);
  const status = useStudyStore((s) => s.status);
  const startPolling = useStudyStore((s) => s.startPolling);
  const stopPolling = useStudyStore((s) => s.stopPolling);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.body.dataset.theme = theme;
    document.body.classList.remove("theme-light", "theme-dark");
    document.body.classList.add(`theme-${theme}`);
  }, [theme]);

  useEffect(() => {
    startPolling();
    return () => stopPolling();
  }, [startPolling, stopPolling]);

  async function reconnectEngine() {
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
    </div>
  );
}
