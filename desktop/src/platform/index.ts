/** Platform detection and adapter installation for browser vs Tauri. */

import { browserPlatform, setPlatform, type PlatformApi } from "./browser";
import { tauriPlatform } from "./tauri";

export type { PlatformApi, PlatformFileApi } from "./browser";
export { browserPlatform, getPlatform, setPlatform } from "./browser";
export { tauriPlatform } from "./tauri";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

/** True when the Study UI is running inside a Tauri webview (or Tauri Vite env). */
export function isTauriRuntime(): boolean {
  if (typeof window !== "undefined" && window.__TAURI_INTERNALS__ != null) {
    return true;
  }
  const env = import.meta.env as Record<string, unknown>;
  return Boolean(env.TAURI_ENV);
}

/** Install the Tauri file adapter when detected; otherwise keep the browser default. */
export function detectAndInstallPlatform(): PlatformApi {
  if (isTauriRuntime()) {
    setPlatform(tauriPlatform);
    return tauriPlatform;
  }
  setPlatform(browserPlatform);
  return browserPlatform;
}
