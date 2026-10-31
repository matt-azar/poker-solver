/** Browser platform adapter — no native privileges; path fields instead of OS dialogs. */

export interface PlatformFileApi {
  kind: "browser" | "tauri";
  pickOpenPath(): Promise<string | null>;
  pickSavePath(defaultPath?: string): Promise<string | null>;
  revealInFolder(_path: string): Promise<void>;
}

export const browserPlatform: PlatformFileApi = {
  kind: "browser",
  async pickOpenPath() {
    const path = window.prompt("Open solution path (.psol)");
    return path && path.trim() ? path.trim() : null;
  },
  async pickSavePath(defaultPath = "") {
    const path = window.prompt("Save solution path (.psol)", defaultPath);
    return path && path.trim() ? path.trim() : null;
  },
  async revealInFolder() {
    // Not available in the browser adapter.
  },
};

export type PlatformApi = PlatformFileApi;

let active: PlatformApi = browserPlatform;

export function getPlatform(): PlatformApi {
  return active;
}

/** Tauri (or other native) adapters replace this without rewriting Study components. */
export function setPlatform(platform: PlatformApi) {
  active = platform;
}
