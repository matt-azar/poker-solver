/**
 * Public-demo phone layout detection.
 * Portrait phone widths + coarse-pointer landscape (short height).
 */
import { useSyncExternalStore } from "react";
import { getActiveDemoConfig, subscribeDemoMode } from "./demoMode";

/** Matches iPhone/Android portrait (~360–430) and short landscape phones. */
export const PHONE_DEMO_LAYOUT_MQ =
  "(max-width: 540px), (max-width: 926px) and (max-height: 500px) and (pointer: coarse)";

function subscribeMedia(query: string, onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mql = window.matchMedia(query);
  const handler = () => onChange();
  mql.addEventListener("change", handler);
  return () => mql.removeEventListener("change", handler);
}

function matchesPhoneLayoutMq(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(PHONE_DEMO_LAYOUT_MQ).matches;
}

/** True when the public demo is active (banner/config live). */
export function usePublicDemoActive(): boolean {
  return useSyncExternalStore(
    subscribeDemoMode,
    () => getActiveDemoConfig() != null,
    () => false,
  );
}

/** True when public demo + phone media query both match. */
export function usePhoneDemoLayout(): boolean {
  const demoActive = usePublicDemoActive();
  const phoneMq = useSyncExternalStore(
    (onStoreChange) => subscribeMedia(PHONE_DEMO_LAYOUT_MQ, onStoreChange),
    matchesPhoneLayoutMq,
    () => false,
  );
  return demoActive && phoneMq;
}

/** Sync document markers for CSS (call from AppShell). */
export function syncPublicDemoDocumentAttrs(opts: {
  demoActive: boolean;
  phoneLayout: boolean;
}): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  if (opts.demoActive) {
    root.setAttribute("data-public-demo", "true");
  } else {
    root.removeAttribute("data-public-demo");
  }
  if (opts.phoneLayout) {
    root.setAttribute("data-phone-demo", "true");
  } else {
    root.removeAttribute("data-phone-demo");
  }
}
