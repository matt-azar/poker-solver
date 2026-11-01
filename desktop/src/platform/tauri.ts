/** Tauri platform adapter — native open/save dialogs when the plugin is available. */

import type { PlatformFileApi } from "./browser";

type DialogPlugin = {
  open: (options?: {
    multiple?: boolean;
    filters?: { name: string; extensions: string[] }[];
  }) => Promise<string | string[] | null>;
  save: (options?: {
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
  }) => Promise<string | null>;
};

async function loadDialogPlugin(): Promise<DialogPlugin> {
  // String specifier + @vite-ignore keeps the browser Vite graph from requiring the package.
  const spec = "@tauri-apps/plugin-dialog";
  const mod = (await import(/* @vite-ignore */ spec)) as DialogPlugin;
  return mod;
}

function promptFallback(message: string, defaultPath = ""): string | null {
  const path = window.prompt(message, defaultPath);
  return path && path.trim() ? path.trim() : null;
}

export const tauriPlatform: PlatformFileApi = {
  kind: "tauri",
  async pickOpenPath() {
    try {
      const dialog = await loadDialogPlugin();
      const selected = await dialog.open({
        multiple: false,
        filters: [{ name: "Solution", extensions: ["psol"] }],
      });
      if (selected == null) {
        return null;
      }
      if (Array.isArray(selected)) {
        return selected[0] ?? null;
      }
      return selected;
    } catch {
      return promptFallback("Open solution path (.psol)");
    }
  },
  async pickSavePath(defaultPath = "") {
    try {
      const dialog = await loadDialogPlugin();
      const selected = await dialog.save({
        defaultPath: defaultPath || undefined,
        filters: [{ name: "Solution", extensions: ["psol"] }],
      });
      return selected;
    } catch {
      return promptFallback("Save solution path (.psol)", defaultPath);
    }
  },
  async revealInFolder(_path: string) {
    // Shell reveal can be wired via a Tauri plugin later; no-op for now.
  },
};
