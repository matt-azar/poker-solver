import { create } from "zustand";
import {
  createDefaultEquityDraft,
  type EquityCalcResultPayload,
  type EquityJobStatus,
  type EquityMethod,
  type EquityRecentEntry,
  type EquityScenarioDraft,
} from "../domain/equity/types";
import { validateEquityDraft } from "../domain/equity/validation";
import { EngineError, engineClient } from "../engine/client";
import { parseCardList, serializeExactRange, type ExactRange } from "../domain/range";

const DRAFT_KEY = "poker-solver.equity.draft.v1";
const RECENT_KEY = "poker-solver.equity.recent.v1";
const MAX_RECENT = 20;

function loadDraft(): EquityScenarioDraft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) {
      return createDefaultEquityDraft();
    }
    const parsed = JSON.parse(raw) as EquityScenarioDraft;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.players)) {
      return createDefaultEquityDraft();
    }
    return {
      ...createDefaultEquityDraft(),
      ...parsed,
      players: parsed.players.slice(0, 6),
    };
  } catch {
    return createDefaultEquityDraft();
  }
}

function loadRecent(): EquityRecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as EquityRecentEntry[];
    return Array.isArray(parsed) ? parsed.slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

function persistDraft(draft: EquityScenarioDraft) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // ignore quota / private mode
  }
}

function persistRecent(recent: EquityRecentEntry[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)));
  } catch {
    // ignore
  }
}

function newPlayerId(existing: string[]): string {
  let n = existing.length + 1;
  let id = `p${n}`;
  while (existing.includes(id)) {
    n += 1;
    id = `p${n}`;
  }
  return id;
}

type EquityRunState = {
  jobId: string | null;
  revision: string;
  status: EquityJobStatus | null;
  starting: boolean;
  stale: boolean;
  error: string | null;
  previous: { revision: string; result: EquityCalcResultPayload; snapshot: EquityScenarioDraft } | null;
};

type EquityStore = {
  draft: EquityScenarioDraft;
  recent: EquityRecentEntry[];
  run: EquityRunState;
  setName: (name: string) => void;
  setMethod: (method: EquityMethod) => void;
  setBoardText: (text: string) => void;
  setDeadText: (text: string) => void;
  setPlayerLabel: (id: string, label: string) => void;
  setPlayerEnabled: (id: string, enabled: boolean) => void;
  setPlayerRangeText: (id: string, rangeText: string) => void;
  setPlayerExactRange: (id: string, range: ExactRange) => void;
  selectPlayer: (id: string) => void;
  addPlayer: () => void;
  removePlayer: (id: string) => void;
  clearPlayer: (id: string) => void;
  randomPlayer: (id: string) => void;
  importDraft: (draft: EquityScenarioDraft) => void;
  exportDraftJson: () => string;
  importDraftJson: (text: string) => { ok: boolean; error?: string };
  calculate: () => Promise<void>;
  stop: () => Promise<void>;
  refreshJob: () => Promise<void>;
  restoreRecent: (id: string) => void;
  deleteRecent: (id: string) => void;
  copyResultsText: () => string;
  markStale: () => void;
};

let pollTimer: ReturnType<typeof setInterval> | null = null;
let revisionCounter = 0;

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function cloneDraft(draft: EquityScenarioDraft): EquityScenarioDraft {
  return structuredClone(draft);
}

export const useEquityStore = create<EquityStore>((set, get) => ({
  draft: loadDraft(),
  recent: loadRecent(),
  run: {
    jobId: null,
    revision: "",
    status: null,
    starting: false,
    stale: false,
    error: null,
    previous: null,
  },

  setName(name) {
    const draft = { ...get().draft, name };
    persistDraft(draft);
    set({ draft });
  },

  setMethod(method) {
    const draft = { ...get().draft, method };
    persistDraft(draft);
    set({ draft });
    get().markStale();
  },

  setBoardText(text) {
    const board = parseCardList(text);
    const draft = { ...get().draft, board };
    persistDraft(draft);
    set({ draft });
    get().markStale();
  },

  setDeadText(text) {
    const deadCards = parseCardList(text);
    const draft = { ...get().draft, deadCards };
    persistDraft(draft);
    set({ draft });
    get().markStale();
  },

  setPlayerLabel(id, label) {
    const draft = {
      ...get().draft,
      players: get().draft.players.map((player) =>
        player.id === id ? { ...player, label } : player,
      ),
    };
    persistDraft(draft);
    set({ draft });
  },

  setPlayerEnabled(id, enabled) {
    const draft = {
      ...get().draft,
      players: get().draft.players.map((player) =>
        player.id === id ? { ...player, enabled } : player,
      ),
    };
    persistDraft(draft);
    set({ draft });
    get().markStale();
  },

  setPlayerRangeText(id, rangeText) {
    const draft = {
      ...get().draft,
      players: get().draft.players.map((player) =>
        player.id === id ? { ...player, rangeText } : player,
      ),
    };
    persistDraft(draft);
    set({ draft });
    get().markStale();
  },

  setPlayerExactRange(id, range) {
    get().setPlayerRangeText(id, serializeExactRange(range));
  },

  selectPlayer(id) {
    const draft = { ...get().draft, selectedPlayerId: id };
    persistDraft(draft);
    set({ draft });
  },

  addPlayer() {
    const draft = get().draft;
    if (draft.players.length >= 6) {
      return;
    }
    const id = newPlayerId(draft.players.map((player) => player.id));
    const next = {
      ...draft,
      players: [
        ...draft.players,
        {
          id,
          label: `Player ${draft.players.length + 1}`,
          enabled: true,
          rangeText: "",
        },
      ],
      selectedPlayerId: id,
    };
    persistDraft(next);
    set({ draft: next });
    get().markStale();
  },

  removePlayer(id) {
    const draft = get().draft;
    if (draft.players.length <= 2) {
      return;
    }
    const players = draft.players.filter((player) => player.id !== id);
    const next = {
      ...draft,
      players,
      selectedPlayerId:
        draft.selectedPlayerId === id ? (players[0]?.id ?? null) : draft.selectedPlayerId,
    };
    persistDraft(next);
    set({ draft: next });
    get().markStale();
  },

  clearPlayer(id) {
    get().setPlayerRangeText(id, "");
  },

  randomPlayer(id) {
    get().setPlayerRangeText(id, "random");
  },

  importDraft(draft) {
    const next = { ...createDefaultEquityDraft(), ...draft, version: 1 as const };
    persistDraft(next);
    set({
      draft: next,
      run: {
        jobId: null,
        revision: "",
        status: null,
        starting: false,
        stale: false,
        error: null,
        previous: null,
      },
    });
    stopPolling();
  },

  exportDraftJson() {
    return JSON.stringify(
      {
        version: 1,
        draft: get().draft,
        result: get().run.status?.result ?? null,
      },
      null,
      2,
    );
  },

  importDraftJson(text) {
    try {
      const parsed = JSON.parse(text) as {
        version?: number;
        draft?: EquityScenarioDraft;
      };
      if (!parsed.draft || parsed.draft.version !== 1) {
        return { ok: false, error: "Unsupported equity JSON version." };
      }
      get().importDraft(parsed.draft);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Invalid equity JSON",
      };
    }
  },

  markStale() {
    const run = get().run;
    if (!run.status?.result || run.stale) {
      if (run.jobId && !run.stale) {
        set({ run: { ...run, stale: true } });
      }
      return;
    }
    set({
      run: {
        ...run,
        stale: true,
        previous: {
          revision: run.revision,
          result: run.status.result,
          snapshot: cloneDraft(get().draft),
        },
      },
    });
  },

  async calculate() {
    const state = get();
    if (state.run.starting) {
      return;
    }
    const validation = validateEquityDraft(state.draft);
    if (!validation.ok) {
      set({
        run: {
          ...state.run,
          error: validation.errors.join(" "),
          starting: false,
        },
      });
      return;
    }

    if (state.run.jobId) {
      try {
        await engineClient.cancelEquityJob(state.run.jobId);
      } catch {
        // best-effort cancel of prior job
      }
    }
    stopPolling();

    const revision = `r${++revisionCounter}-${Date.now()}`;
    set({
      run: {
        ...state.run,
        starting: true,
        error: null,
        stale: false,
        revision,
        jobId: null,
        status: null,
      },
    });

    try {
      const body = {
        version: 1,
        client_revision: revision,
        method: state.draft.method,
        target_samples: state.draft.targetSamples,
        seed: state.draft.seed,
        board: validation.board,
        dead_cards: validation.deadCards,
        players: validation.activePlayers.map((player) => ({
          id: player.id,
          range: player.rangeText,
        })),
      };
      const accepted = await engineClient.startEquityJob(body);
      const jobId = accepted.job_id;
      if (get().run.revision !== revision) {
        await engineClient.cancelEquityJob(jobId);
        return;
      }
      set({
        run: {
          ...get().run,
          jobId,
          starting: false,
          status: {
            job_id: jobId,
            state: "queued",
            client_revision: revision,
            progress_done: 0,
            progress_total: 0,
            elapsed_seconds: 0,
          },
        },
      });

      const poll = async () => {
        const current = get().run;
        if (current.revision !== revision || current.jobId !== jobId) {
          stopPolling();
          return;
        }
        try {
          const data = (await engineClient.getEquityJob(jobId)) as EquityJobStatus;
          if (get().run.revision !== revision) {
            return;
          }
          set({ run: { ...get().run, status: data, error: data.error ?? null } });
          if (
            data.state === "completed" ||
            data.state === "stopped" ||
            data.state === "failed" ||
            data.state === "cancelled"
          ) {
            stopPolling();
            if (data.state === "completed" || data.state === "stopped") {
              const entry: EquityRecentEntry = {
                id: `${Date.now()}-${jobId}`,
                savedAt: Date.now(),
                name: get().draft.name || `Calc ${new Date().toLocaleString()}`,
                draft: cloneDraft(get().draft),
                result: data.result ?? null,
              };
              const recent = [entry, ...get().recent].slice(0, MAX_RECENT);
              persistRecent(recent);
              set({ recent });
            }
          }
        } catch (error) {
          stopPolling();
          set({
            run: {
              ...get().run,
              error:
                error instanceof EngineError
                  ? error.message
                  : error instanceof Error
                    ? error.message
                    : "Equity job poll failed",
            },
          });
        }
      };

      void poll();
      pollTimer = setInterval(() => {
        void poll();
      }, 250);
    } catch (error) {
      set({
        run: {
          ...get().run,
          starting: false,
          error:
            error instanceof EngineError
              ? error.message
              : error instanceof Error
                ? error.message
                : "Failed to start equity job",
        },
      });
    }
  },

  async stop() {
    const { jobId, revision } = get().run;
    if (!jobId) {
      return;
    }
    try {
      await engineClient.cancelEquityJob(jobId);
      await get().refreshJob();
    } catch (error) {
      if (get().run.revision === revision) {
        set({
          run: {
            ...get().run,
            error:
              error instanceof Error ? error.message : "Failed to stop equity job",
          },
        });
      }
    }
  },

  async refreshJob() {
    const { jobId, revision } = get().run;
    if (!jobId) {
      return;
    }
    try {
      const data = (await engineClient.getEquityJob(jobId)) as EquityJobStatus;
      if (get().run.revision !== revision) {
        return;
      }
      set({ run: { ...get().run, status: data, error: data.error ?? null } });
    } catch (error) {
      set({
        run: {
          ...get().run,
          error: error instanceof Error ? error.message : "Failed to refresh equity job",
        },
      });
    }
  },

  restoreRecent(id) {
    const entry = get().recent.find((item) => item.id === id);
    if (!entry) {
      return;
    }
    get().importDraft(entry.draft);
    if (entry.result) {
      set({
        run: {
          jobId: null,
          revision: `restored-${id}`,
          starting: false,
          stale: false,
          error: null,
          status: {
            job_id: "restored",
            state: "completed",
            client_revision: `restored-${id}`,
            progress_done: 0,
            progress_total: 0,
            elapsed_seconds: entry.result.elapsed_seconds,
            result: entry.result,
          },
          previous: null,
        },
      });
    }
  },

  deleteRecent(id) {
    const recent = get().recent.filter((item) => item.id !== id);
    persistRecent(recent);
    set({ recent });
  },

  copyResultsText() {
    const { draft, run } = get();
    const result = run.status?.result;
    if (!result) {
      return "";
    }
    const lines = [
      `Equity calculator (${result.actual_method}${result.exact_complete ? ", exact" : ""})`,
      draft.name ? `Scenario: ${draft.name}` : null,
      `Board: ${result.board.join(" ") || "(preflop)"}`,
      result.dead_cards.length ? `Dead: ${result.dead_cards.join(" ")}` : null,
      result.accepted_samples
        ? `Samples: ${result.accepted_samples} (seed ${result.seed})`
        : `Deals: ${result.exact_deals}`,
      ...result.players.map((player) => {
        const label =
          draft.players.find((row) => row.id === player.id)?.label ?? player.id;
        const eq =
          player.equity === null || player.equity === undefined
            ? "—"
            : `${(player.equity * 100).toFixed(2)}%`;
        const win =
          player.win === null || player.win === undefined
            ? "—"
            : `${(player.win * 100).toFixed(2)}%`;
        const tie =
          player.tie === null || player.tie === undefined
            ? "—"
            : `${(player.tie * 100).toFixed(2)}%`;
        return `${label}: equity ${eq}, win ${win}, tie ${tie}`;
      }),
    ].filter(Boolean);
    return lines.join("\n");
  },
}));
