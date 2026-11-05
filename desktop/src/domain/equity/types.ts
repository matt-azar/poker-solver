export type EquityMethod = "auto" | "exact" | "monte_carlo";

export type EquityPlayerDraft = {
  id: string;
  label: string;
  enabled: boolean;
  rangeText: string;
};

export type EquityScenarioDraft = {
  version: 1;
  name: string;
  players: EquityPlayerDraft[];
  board: string[];
  deadCards: string[];
  method: EquityMethod;
  targetSamples: number;
  seed: number;
  selectedPlayerId: string | null;
};

export type EquityPlayerResult = {
  id: string;
  defined: boolean;
  equity: number | null;
  win: number | null;
  tie: number | null;
  loss: number | null;
  equity_ci_low?: number | null;
  equity_ci_high?: number | null;
};

export type EquityCalcResultPayload = {
  model: string;
  units: string;
  method_version: string;
  requested_method: string;
  actual_method: string;
  method_reason: string;
  joint_defined: boolean;
  exact_complete: boolean;
  stopped: boolean;
  legal_tuples: number;
  completions_per_tuple: number;
  exact_deals: number;
  accepted_samples: number;
  attempted_tuples: number;
  seed: number;
  elapsed_seconds: number;
  board: string[];
  dead_cards: string[];
  players: EquityPlayerResult[];
};

export type EquityJobStatus = {
  job_id: string;
  state:
    | "queued"
    | "preparing"
    | "running"
    | "stopping"
    | "completed"
    | "stopped"
    | "cancelled"
    | "failed";
  client_revision: string;
  progress_done: number;
  progress_total: number;
  elapsed_seconds: number;
  error?: string;
  error_kind?: string;
  result?: EquityCalcResultPayload;
};

export type EquityRecentEntry = {
  id: string;
  savedAt: number;
  name: string;
  draft: EquityScenarioDraft;
  result: EquityCalcResultPayload | null;
};

export function createDefaultEquityDraft(): EquityScenarioDraft {
  return {
    version: 1,
    name: "",
    players: [
      { id: "p1", label: "Player 1", enabled: true, rangeText: "" },
      { id: "p2", label: "Player 2", enabled: true, rangeText: "" },
    ],
    board: [],
    deadCards: [],
    method: "auto",
    targetSamples: 100_000,
    seed: 1,
    selectedPlayerId: "p1",
  };
}
