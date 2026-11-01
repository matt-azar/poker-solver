/** Tauri platform adapter — native open/save dialogs when the plugin is available. */

import { open as dialogOpen, save as dialogSave } from "@tauri-apps/plugin-dialog";
import type { PlatformFileApi } from "./browser";

function promptFallback(message: string, defaultPath = ""): string | null {
  const path = window.prompt(message, defaultPath);
  return path && path.trim() ? path.trim() : null;
}

export const tauriPlatform: PlatformFileApi = {
  kind: "tauri",
  async pickOpenPath() {
    try {
      const selected = await dialogOpen({
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
      const selected = await dialogSave({
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
