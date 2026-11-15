/**
 * Browser Study preview mode — same React UI, recorded IPC replies.
 * Live solving stays on the desktop Tauri + solver-engine path.
 */

import { SOLVER_ENGINE_PROTOCOL } from "../engine/ipcProtocol";
import {
  installFixtureIpcHandler,
  setIpcTransport,
  type FixtureIpcHandler,
} from "../engine/transport";
import {
  createNodeLockingFixtureHandler,
  NODE_LOCKING_PREVIEW_ID,
  type NodeLockingFixtureController,
  type PreviewReviewerState,
} from "./scenarios/nodeLockingFixture";

export type PreviewScenarioId = typeof NODE_LOCKING_PREVIEW_ID;

export type PreviewBootConfig = {
  scenario: PreviewScenarioId;
  state: PreviewReviewerState;
  commitSha: string;
};

/** Playwright / Vitest hook for test-controlled fixture timing. */
export type PreviewFixtureTestApi = {
  holdValues: (nodeId: string) => void;
  releaseValues: (nodeId: string) => void;
  getLastPutLock: () => ReturnType<NodeLockingFixtureController["getLastPutLock"]>;
  getReviewerState: () => PreviewReviewerState;
};

declare global {
  interface Window {
    __STUDY_PREVIEW_FIXTURE__?: PreviewFixtureTestApi;
  }
}

let activeFixture: NodeLockingFixtureController | null = null;
let activeConfig: PreviewBootConfig | null = null;

const LISTENERS = new Set<() => void>();

function notify(): void {
  for (const listener of LISTENERS) {
    listener();
  }
}

function publishTestApi(fixture: NodeLockingFixtureController | null): void {
  if (typeof window === "undefined") {
    return;
  }
  if (!fixture) {
    delete window.__STUDY_PREVIEW_FIXTURE__;
    return;
  }
  window.__STUDY_PREVIEW_FIXTURE__ = {
    holdValues: (nodeId) => fixture.holdValues(nodeId),
    releaseValues: (nodeId) => fixture.releaseValues(nodeId),
    getLastPutLock: () => fixture.getLastPutLock(),
    getReviewerState: () => fixture.getReviewerState(),
  };
}

function armFixture(fixture: NodeLockingFixtureController): void {
  activeFixture = fixture;
  const handler: FixtureIpcHandler = fixture.handler;
  installFixtureIpcHandler(handler);
  setIpcTransport({
    protocol: SOLVER_ENGINE_PROTOCOL,
    launchId: "fixture-preview",
    sidecar: "recorded-fixture",
    workers: 0,
    label: "recorded fixture IPC (browser preview)",
  });
  publishTestApi(fixture);
}

export function subscribePreviewMode(listener: () => void): () => void {
  LISTENERS.add(listener);
  return () => {
    LISTENERS.delete(listener);
  };
}

export function getPreviewCommitSha(): string {
  const fromEnv = import.meta.env.VITE_PREVIEW_COMMIT_SHA;
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    return fromEnv.trim();
  }
  return "unknown";
}

export function parsePreviewSearch(search: string): {
  scenario: PreviewScenarioId | null;
  state: PreviewReviewerState;
} {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const raw = (params.get("preview") || "").trim().toLowerCase();
  const scenario = raw === NODE_LOCKING_PREVIEW_ID ? NODE_LOCKING_PREVIEW_ID : null;
  const stateRaw = (params.get("state") || "default").trim().toLowerCase();
  let state: PreviewReviewerState = "default";
  if (stateRaw === "pending-ev" || stateRaw === "pending_ev") {
    state = "pending-ev";
  } else if (
    stateRaw === "dropped-connection" ||
    stateRaw === "dropped_connection" ||
    stateRaw === "connection-loss"
  ) {
    state = "dropped-connection";
  }
  return { scenario, state };
}

export function isBrowserPreviewMode(
  search: string = typeof window !== "undefined" ? window.location.search : "",
): boolean {
  return parsePreviewSearch(search).scenario != null;
}

export function getActivePreviewConfig(): PreviewBootConfig | null {
  return activeConfig;
}

export function getActivePreviewReviewerState(): PreviewReviewerState {
  return activeFixture?.getReviewerState() ?? activeConfig?.state ?? "default";
}

export function getActivePreviewFixture(): NodeLockingFixtureController | null {
  return activeFixture;
}

/** Write scenario + reviewer state into the URL without reloading. */
export function writePreviewUrlState(
  scenario: PreviewScenarioId,
  state: PreviewReviewerState,
): void {
  if (typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  url.searchParams.set("preview", scenario);
  if (state === "default") {
    url.searchParams.delete("state");
  } else {
    url.searchParams.set("state", state);
  }
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

/**
 * Install recorded fixture IPC and mark transport as IPC so EngineClient
 * uses typed IPC branches (never HTTP fallthrough).
 */
export function installBrowserPreviewTransport(
  search: string = typeof window !== "undefined" ? window.location.search : "",
): PreviewBootConfig | null {
  const parsed = parsePreviewSearch(search);
  if (!parsed.scenario) {
    activeFixture = null;
    activeConfig = null;
    installFixtureIpcHandler(null);
    publishTestApi(null);
    return null;
  }

  armFixture(createNodeLockingFixtureHandler(parsed.state));

  activeConfig = {
    scenario: parsed.scenario,
    state: parsed.state,
    commitSha: getPreviewCommitSha(),
  };
  notify();
  return activeConfig;
}

/** Reviewer-facing state switch (pending EV / dropped connection / default). */
export function setPreviewReviewerState(next: PreviewReviewerState): void {
  if (!activeConfig || !activeFixture) {
    return;
  }
  activeFixture.setReviewerState(next);
  activeConfig = { ...activeConfig, state: next };
  writePreviewUrlState(activeConfig.scenario, next);
  notify();
}

/** Test helper — drop preview fixture + URL-driven config. */
export function clearBrowserPreviewForTests(): void {
  activeFixture = null;
  activeConfig = null;
  installFixtureIpcHandler(null);
  publishTestApi(null);
  notify();
}

/** Re-arm fixture after a dropped-connection recovery (Reconnect). */
export function rearmBrowserPreviewTransport(): PreviewBootConfig | null {
  if (!activeConfig) {
    return installBrowserPreviewTransport();
  }
  const state =
    activeFixture?.getReviewerState() === "dropped-connection"
      ? "default"
      : (activeFixture?.getReviewerState() ?? activeConfig.state);
  armFixture(createNodeLockingFixtureHandler(state));
  activeConfig = {
    ...activeConfig,
    state,
    commitSha: getPreviewCommitSha(),
  };
  writePreviewUrlState(activeConfig.scenario, state);
  notify();
  return activeConfig;
}
