export type ShortcutAction =
  | "solve"
  | "stop"
  | "continue"
  | "help"
  | "theme"
  | "save"
  | "open";

export interface ShortcutBinding {
  key: string;
  action: ShortcutAction;
  label: string;
}

export const SHORTCUTS: ShortcutBinding[] = [
  { key: "s", action: "solve", label: "Solve" },
  { key: "x", action: "stop", label: "Stop" },
  { key: "c", action: "continue", label: "Continue" },
  { key: "?", action: "help", label: "Toggle help" },
];

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }
  return target.isContentEditable;
}

export function matchShortcut(event: KeyboardEvent): ShortcutAction | null {
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return null;
  }
  if (isTypingTarget(event.target)) {
    return null;
  }
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (key === "?" || (event.shiftKey && key === "/")) {
    return "help";
  }
  const hit = SHORTCUTS.find((entry) => entry.key === key);
  return hit?.action ?? null;
}
