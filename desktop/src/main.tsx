import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./styles/tokens.css";
import "./styles/layout.css";
import { applyDocumentTheme, resolveTheme, useThemeStore } from "./state/themeStore";
import { detectAndInstallPlatform, isTauriRuntime } from "./platform";

applyDocumentTheme(resolveTheme(useThemeStore.getState().preference));
detectAndInstallPlatform();

async function probeTauriEngineStatus(): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  try {
    // String specifier keeps the browser Vite graph from requiring @tauri-apps/api.
    const spec = "@tauri-apps/api/core";
    const { invoke } = (await import(/* @vite-ignore */ spec)) as {
      invoke: (cmd: string) => Promise<unknown>;
    };
    const status = await invoke("engine_status");
    console.info("[tauri] engine_status", status);
  } catch (err) {
    console.info("[tauri] engine_status unavailable", err);
  }
}

void probeTauriEngineStatus();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
