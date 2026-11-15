/**
 * Browser-preview chrome: commit SHA + selectable reviewer states.
 * Not shown in the packaged Tauri shell.
 */
import { useEffect, useSyncExternalStore } from "react";
import { useStudyStore } from "../state/studyStore";
import {
  getActivePreviewConfig,
  getActivePreviewReviewerState,
  setPreviewReviewerState,
  subscribePreviewMode,
  type PreviewBootConfig,
} from "./previewMode";
import type { PreviewReviewerState } from "./scenarios/nodeLockingFixture";

declare global {
  interface Window {
    __STUDY_PREVIEW_DEBUG__?: {
      nodeId: string | null;
      nodeValuesId: string | null;
      nodeEv: number | null;
      valuesPending: boolean;
    };
  }
}

function shortSha(sha: string): string {
  if (!sha || sha === "unknown") {
    return sha || "unknown";
  }
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

function usePreviewConfig(): PreviewBootConfig | null {
  return useSyncExternalStore(subscribePreviewMode, getActivePreviewConfig, () => null);
}

function usePreviewState(): PreviewReviewerState {
  return useSyncExternalStore(
    subscribePreviewMode,
    getActivePreviewReviewerState,
    () => "default" as PreviewReviewerState,
  );
}

const STATES: Array<{ id: PreviewReviewerState; label: string }> = [
  { id: "default", label: "Default" },
  { id: "pending-ev", label: "Pending EV" },
  { id: "dropped-connection", label: "Dropped connection" },
];

export function PreviewBanner() {
  const config = usePreviewConfig();
  const state = usePreviewState();
  const nodeId = useStudyStore((s) => s.currentNode?.node_id ?? null);
  const nodeValues = useStudyStore((s) => s.nodeValues);

  // Playwright stale-EV reads this snapshot under test-controlled timing.
  useEffect(() => {
    if (!config) {
      delete window.__STUDY_PREVIEW_DEBUG__;
      return;
    }
    window.__STUDY_PREVIEW_DEBUG__ = {
      nodeId,
      nodeValuesId: nodeValues?.node_id ?? null,
      nodeEv:
        typeof nodeValues?.node_ev === "number" ? nodeValues.node_ev : null,
      valuesPending: Boolean(nodeValues?.pending),
    };
  }, [config, nodeId, nodeValues]);

  if (!config) {
    return null;
  }

  return (
    <div className="preview-banner" role="region" aria-label="Browser preview">
      <div className="preview-banner__meta">
        <strong className="preview-banner__title">Browser preview</strong>
        <span className="preview-banner__scenario muted">
          Scenario: {config.scenario}
        </span>
        <span className="preview-banner__sha tabular" title={config.commitSha}>
          Commit {shortSha(config.commitSha)}
        </span>
      </div>
      <div className="preview-banner__states" role="group" aria-label="Reviewer states">
        <span className="muted">Reviewer state</span>
        {STATES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={
              state === entry.id ? "toolbar-btn primary" : "toolbar-btn"
            }
            aria-pressed={state === entry.id}
            onClick={() => setPreviewReviewerState(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
    </div>
  );
}
