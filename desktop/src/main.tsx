import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./styles/tokens.css";
import "./styles/layout.css";
import { applyDocumentTheme, resolveTheme, useThemeStore } from "./state/themeStore";
import { detectAndInstallPlatform } from "./platform";
import { startUiHangMonitor } from "./platform/diagnostics";
import { ensureEngine } from "./platform/engine";
import { useStudyStore } from "./state/studyStore";

applyDocumentTheme(resolveTheme(useThemeStore.getState().preference));
detectAndInstallPlatform();
// ZR-173: cheap main-thread stall → ui-hang-events.json (Tauri only).
startUiHangMonitor();

async function bootEngineThenRender(): Promise<void> {
  // Packaged Tauri: solver-engine IPC only.
  const result = await ensureEngine();
  if (result.ok) {
    console.info("[tauri] ensure_engine", result.status, result.transport.kind);
  } else {
    console.warn("[tauri] ensure_engine failed", result.error, result.status);
    useStudyStore.setState({
      connection: "disconnected",
      message: `Engine setup failed: ${result.error}`,
    });
  }

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootEngineThenRender();
