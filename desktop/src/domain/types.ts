import { fastSolveDefaults } from "./hardwareDefaults";

export type PlayerSeat = "oop" | "ip";

export type MatrixMode =
  | "strategy"
  | "range"
  | "action-range"
  | "ev"
  | "equity"
  | "strategy-ev";

export type FrequencyMode = "aggression" | `${number}`;

export type ThemePreference = "system" | "light" | "dark";

export type SolvePhase =
  | "idle"
  | "building"
  | "solving"
  | "pause_requested"
  | "paused"
  | "stop_requested"
  | "complete"
  | "loading"
  | "saving"
  | "analysis_pending"
  | "failed";

export interface SolveJobRequest {
  board: string[];
  oop_range: string;
  ip_range: string;
  pot: number;
  stack: number;
  oop_bets: number[];
  ip_bets: number[];
  oop_flop_bets?: number[];
  ip_flop_bets?: number[];
  oop_turn_bets?: number[];
  ip_turn_bets?: number[];
  oop_river_bets?: number[];
  ip_river_bets?: number[];
  oop_donk?: number[];
  pot_cap?: number;
  allow_three_bet?: number;
  geometric?: number;
  all_in_threshold?: number;
  allow_all_in?: number;
  frozen?: number;
  accuracy?: number;
  max_raises?: number;
  iterations: number;
  memory_mib?: number;
  threads?: number;
  algorithm?: string;
  samples?: number;
  rake_rate?: number;
  rake_cap?: number;
  icm_stacks?: number[];
  icm_payouts?: number[];
  incentives?: Array<{
    kind: string;
    player: number;
    key: string;
    delta: number;
  }>;
  edge_tags?: Array<{
    player?: number;
    action: string;
    tags: string[];
  }>;
  time_limit?: number;
  /** TreeEditSet lines (`force - c`, `remove Check/Bet 50 b50`, `add-size - 0.33`). */
  tree_edits?: string[];
}

export interface MemoryPlanPayload {
  estimated_peak_bytes: number;
  memory_budget_bytes: number;
  deals: number;
  infosets: number;
  decision_nodes: number;
  terminals: number;
  public_decisions: number;
  threads: number;
  fits_budget: boolean;
  dry_run: boolean;
}

export interface TreePreviewAction {
  label: string;
  compact: string;
  child_index: number;
}

export interface TreePreviewNode {
  index: number;
  terminal: boolean;
  chance: boolean;
  player: number;
  street: number;
  path: string;
  chance_child: number;
  actions: TreePreviewAction[];
  children: number[];
}

export interface TreePreviewPayload {
  nodes: TreePreviewNode[];
  tree_edits: string[];
}

export interface GapSeriesPoint {
  iterations?: number;
  iteration?: number;
  value?: number;
  nash_gap: number;
}

export interface StatusPayload {
  running?: boolean;
  paused?: boolean;
  cancelled?: boolean;
  failed?: boolean;
  error?: string | null;
  job_id?: string | null;
  solution_id?: string | null;
  baseline_solution_id?: string | null;
  root_node_id?: string | null;
  status_generation?: number;
  iterations?: number | null;
  iterations_requested?: number | null;
  runtime_seconds?: number | null;
  runtime?: number | null;
  player0_expected_utility?: number | null;
  value?: number | null;
  nash_gap?: number | null;
  p1_best_response?: number | null;
  p2_best_response?: number | null;
  pot?: number | null;
  stack?: number | null;
  board?: string[] | string | null;
  algorithm?: string | null;
  frozen?: boolean | number | null;
  /** Job sample-chunk count (integer), not the chart series. */
  samples?: number | Array<{ iteration: number; nash_gap: number; value?: number }> | null;
  gap_series?: GapSeriesPoint[] | null;
  time_limit_reached?: boolean;
  engine_allocated?: number | null;
  engine_peak?: number | null;
  engine_heap_bytes?: number | null;
  message?: string | null;
  spot?: string | null;
  plays?: string | null;
  [key: string]: unknown;
}

export interface NodeActionChild {
  action?: string;
  label?: string;
  node_id?: string;
  frequency?: number | null;
  amount?: number | null;
}

export interface NodeCardChild {
  card?: string;
  node_id?: string;
  weight?: number | null;
}

export interface NodePayload {
  solution_id?: string;
  job_id?: string;
  status_generation?: number;
  node_id: string;
  kind?: string;
  player?: number | null;
  pot?: number | null;
  to_act?: string | null;
  line?: string | null;
  board?: string[] | string | null;
  actions?: string[];
  children?: Array<NodeActionChild | NodeCardChild | string>;
  combos?: string[];
  marginal?: number[];
  strategy?: number[][] | null;
  reach_defined?: boolean;
  locked_hands?: number[] | boolean[] | null;
  [key: string]: unknown;
}

export type EvDisplayBasis = "local" | "root_centered";

export interface ActionValuesPayload {
  pending?: boolean;
  solution_id?: string;
  job_id?: string;
  status_generation?: number;
  node_id?: string;
  units?: string;
  /** Engine values are root_centered; UI defaults to local via withEvBasis. */
  utility_basis?: string;
  /** Add to root-centered chips for local decision EV (fold → 0 under chip/ICM). */
  local_offset?: number | null;
  actions?: string[];
  combos?: string[];
  value?: Array<number | null>;
  action_ev?: Array<Array<number | null>>;
  ev_defined?: boolean[];
  node_ev?: number | null;
  node_ev_defined?: boolean;
  [key: string]: unknown;
}

export interface HandCell {
  row: number;
  col: number;
  text: string;
  hands: Array<{
    combo: string;
    actions: Array<{ action: string; probability: number }>;
  }>;
  range_combos: number;
  marginalSum: number;
  actionMass: number[];
  aggressionMass: number;
  defined: boolean;
}

export interface GroupEv {
  mixed: number;
  action: number[];
}

export interface SpotDraft {
  boardText: string;
  oopRange: string;
  ipRange: string;
  pot: number;
  stack: number;
  oopBets: string;
  ipBets: string;
  oopFlop: string;
  ipFlop: string;
  oopTurn: string;
  ipTurn: string;
  oopRiver: string;
  ipRiver: string;
  oopDonk: string;
  /** When true, OOP flop sizes are also used as donk sizes on that street. */
  donkFlop: boolean;
  donkTurn: boolean;
  donkRiver: boolean;
  /** Merge near bet sizes within this percent of chip amount (0 = off). */
  mergeThresholdPct: number;
  potCap: number;
  noThreeBet: boolean;
  geometric: boolean;
  allInThreshold: number;
  allowAllIn: boolean;
  frozen: boolean;
  accuracy: string;
  maxRaises: number;
  iterations: number;
  memoryMib: number;
  threads: number;
  algorithm: string;
  samples: number;
  rakeRate: number;
  rakeCap: number;
  /** When false, solve uses chip EV and ignores ICM stacks/payouts. */
  useIcm: boolean;
  icmStacks: string;
  icmPayouts: string;
  incentives: string;
  edgeTags: string;
  timeLimit: string;
  solutionPath: string;
  /** One TreeEditSet line per entry (Force/Remove/AddSize). */
  treeEdits: string[];
}

export const RANKS = [
  "A",
  "K",
  "Q",
  "J",
  "T",
  "9",
  "8",
  "7",
  "6",
  "5",
  "4",
  "3",
  "2",
] as const;

const FAST = fastSolveDefaults();

export const DEFAULT_SPOT: SpotDraft = {
  boardText: "Ah Kd 7c 4s 2h",
  oopRange: "AA",
  ipRange: "KK",
  pot: 100,
  stack: 200,
  oopBets: "50, 100",
  ipBets: "50, 100",
  oopFlop: "50, 100",
  ipFlop: "50, 100",
  oopTurn: "50, 100",
  ipTurn: "50, 100",
  oopRiver: "50, 100",
  ipRiver: "50, 100",
  oopDonk: "",
  donkFlop: false,
  donkTurn: false,
  donkRiver: false,
  mergeThresholdPct: 10,
  potCap: 0,
  noThreeBet: false,
  geometric: false,
  allInThreshold: 0,
  allowAllIn: true,
  frozen: true,
  accuracy: "",
  maxRaises: 2,
  iterations: 200,
  memoryMib: FAST.memoryMib,
  threads: FAST.threads,
  algorithm: "cfr_plus",
  samples: 5,
  rakeRate: 0,
  rakeCap: 0,
  useIcm: false,
  icmStacks: "",
  icmPayouts: "",
  incentives: "",
  edgeTags: "",
  timeLimit: "",
  solutionPath: "",
  treeEdits: [],
};
