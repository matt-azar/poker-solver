/**
 * Soft-gate Study features that still lack a live solver-engine IPC op.
 *
 * Flip a flag to `true` in the same PR that wires the matching EngineClient
 * IPC branch / host op (do not invent fake host ops here):
 * - resolveLocked  → ZR-100 (#301) — enabled
 * - strategyEdits  → ZR-101 (#303) — enabled
 * - categories     → ZR-103 (#302) — enabled
 * - compare        → deferred (immutable dual-session baseline)
 *
 * Packaged Study is IPC-only. Browser/Vitest (no Tauri, no IPC) leave controls
 * enabled so unit tests that mock the store can still exercise handlers.
 */
import { isTauriRuntime } from "../platform";
import { isIpcTransport } from "./transport";

export const STUDY_IPC_FEATURE_FLAGS = {
  // Host `resolve_locked` + EngineClient IPC branch (#301).
  resolveLocked: true,
  compare: false,
  // ZR-103: host `categories` + EngineClient IPC branch (made-hand on 5-card boards).
  categories: true,
  // Host strategy-edits CRUD + EngineClient IPC branch (#303).
  strategyEdits: true,
} as const;

export type StudyIpcFeature = keyof typeof STUDY_IPC_FEATURE_FLAGS;

const UNAVAILABLE_COPY: Record<StudyIpcFeature, string> = {
  resolveLocked:
    "Resolve locked is not available over solver-engine IPC yet",
  compare:
    "Compare needs an immutable dual-session baseline; not available over Zig IPC yet",
  categories: "Categories are not available over solver-engine IPC yet",
  strategyEdits:
    "Strategy edits are not available over solver-engine IPC yet",
};

/** Test/sibling overrides — prefer flipping STUDY_IPC_FEATURE_FLAGS when ops ship. */
const overrides = new Map<StudyIpcFeature, boolean>();

/** True when the UI should treat Study as the packaged IPC shell. */
export function studyUsesIpcFeatureGates(): boolean {
  return isIpcTransport() || isTauriRuntime();
}

/** Whether a Study feature is callable on the active transport. */
export function studyIpcFeatureAvailable(feature: StudyIpcFeature): boolean {
  if (!studyUsesIpcFeatureGates()) {
    return true;
  }
  if (overrides.has(feature)) {
    return overrides.get(feature)!;
  }
  return STUDY_IPC_FEATURE_FLAGS[feature];
}

/** Short status-bar / tooltip copy when a feature is soft-disabled. */
export function studyIpcUnavailableReason(feature: StudyIpcFeature): string {
  return UNAVAILABLE_COPY[feature];
}

/**
 * Thin hook for sibling landings / tests: temporarily override a capability.
 * Pass `null` to clear. Prefer flipping {@link STUDY_IPC_FEATURE_FLAGS} when
 * the host op ships.
 */
export function setStudyIpcFeatureOverrideForTests(
  feature: StudyIpcFeature,
  available: boolean | null,
): void {
  if (available == null) {
    overrides.delete(feature);
    return;
  }
  overrides.set(feature, available);
}

export function clearStudyIpcFeatureOverridesForTests(): void {
  overrides.clear();
}
