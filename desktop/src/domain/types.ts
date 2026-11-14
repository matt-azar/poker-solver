import { fastSolveDefaults } from "./hardwareDefaults";

export type PlayerSeat = "oop" | "ip";

export type MatrixMode =
  | "strategy"
  | "range"
  | "ev"
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
  oop_raises?: number[];
  ip_raises?: number[];
  oop_raise_multiples?: number[];
  ip_raise_multiples?: number[];
  oop_flop_bets?: number[];
  ip_flop_bets?: number[];
  oop_turn_bets?: number[];
  ip_turn_bets?: number[];
  oop_river_bets?: number[];
  ip_river_bets?: number[];
  oop_flop_raises?: number[];
  ip_flop_raises?: number[];
  oop_turn_raises?: number[];
  ip_turn_raises?: number[];
  oop_river_raises?: number[];
  ip_river_raises?: number[];
  oop_donk?: number[];
  oop_flop_donk?: number[];
  oop_turn_donk?: number[];
  oop_river_donk?: number[];
  merge_threshold?: number;
  pot_cap?: number;
  allow_three_bet?: number;
  all_in_threshold?: number;
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
  /** Labeled mid-construction plan from the same plan-only build. */
  plan?: MemoryPlanPayload;
}

export interface GapSeriesPoint {
  iterations?: number;
  iteration?: number;
  value?: number;
  nash_gap: number;
  /** Pio Accuracy in chips (NashConv/2). */
  accuracy_chips?: number;
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
  /** Host published-average epoch (bumps on cadence / final publish). */
  policy_revision?: number;
  /** Alias some analysis replies use for policy_revision. */
  analysis_revision?: number;
  iterations?: number | null;
  iterations_requested?: number | null;
  runtime_seconds?: number | null;
  runtime?: number | null;
  player0_expected_utility?: number | null;
  value?: number | null;
  nash_gap?: number | null;
  /** Measured Pio Accuracy in chips (NashConv/2). */
  accuracy_chips?: number | null;
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
  /** Host: published average came from train or a checkpoint with flag_training. */
  has_training?: boolean;
  /** Host: Continue / further train is legal (requires trainer tables). */
  can_continue?: boolean;
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
  /** Host published-average epoch at inspect time. */
  policy_revision?: number;
  analysis_revision?: number;
  node_id: string;
  kind?: string;
  player?: number | null;
  /** Current pot at this node in chip units (same contract as status.pot). */
  pot?: number | null;
  /** Remaining stacks [OOP, IP] in chip units. */
  stacks?: number[] | null;
  /** Effective remaining stack (min of seats) in chip units. */
  stack?: number | null;
  /** Street contributions [OOP, IP] in chip units. */
  contrib?: number[] | null;
  /** Chips the acting seat must put in to call; 0 when first to act / check. */
  to_call?: number | null;
  /** Parent public-node id; null at the root. */
  parent_id?: string | null;
  to_act?: string | null;
  line?: string | null;
  board?: string[] | string | null;
  actions?: string[];
  children?: Array<NodeActionChild | NodeCardChild | string>;
  combos?: string[];
  reach?: number[];
  marginal?: number[];
  strategy?: number[][] | null;
  reach_defined?: boolean;
  /** Non-acting seat at a decision (0 OOP / 1 IP). */
  opponent_player?: number | null;
  opponent_combos?: string[];
  opponent_reach?: number[];
  opponent_marginal?: number[] | null;
  locked_hands?: number[] | boolean[] | null;
  /**
   * Acting-seat joint / reach mass at this node (engine inspection `joint`).
   * Keep distinct from a legitimate 0% action frequency.
   */
  joint?: number | null;
  [key: string]: unknown;
}

export type EvDisplayBasis = "local" | "root_centered";

export interface ActionValuesPayload {
  pending?: boolean;
  /** Settled failure message when /values could not complete. */
  error?: string;
  solution_id?: string;
  job_id?: string;
  status_generation?: number;
  node_id?: string;
  units?: string;
  /**
   * Zig `values` primary columns are local decision EV (`"local"`, Fold≈0).
   * Legacy / dual-root payloads may still say `"root_centered"`.
   */
  utility_basis?: string;
  /**
   * `-U_actor(fold-now)`. Still published for diagnostics and legacy clients;
   * Study prefers primary local columns (or dual `root_centered`) over shifting.
   */
  local_offset?: number | null;
  actions?: string[];
  combos?: string[];
  value?: Array<number | null>;
  action_ev?: Array<Array<number | null>>;
  ev_defined?: boolean[];
  node_ev?: number | null;
  node_ev_defined?: boolean;
  /** Dual root-centered columns when primary `utility_basis` is `"local"`. */
  root_centered?: {
    action_ev?: Array<Array<number | null>>;
    value?: Array<number | null>;
    node_ev?: number | null;
  };
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
  /** Shared raise text kept for older drafts. Street raise fields are the ones solved. */
  oopRaises: string;
  ipRaises: string;
  oopFlop: string;
  ipFlop: string;
  oopTurn: string;
  ipTurn: string;
  oopRiver: string;
  ipRiver: string;
  /** Blank copies that street's bets. `-` removes raises. */
  oopFlopRaises: string;
  ipFlopRaises: string;
  oopTurnRaises: string;
  ipTurnRaises: string;
  oopRiverRaises: string;
  ipRiverRaises: string;
  oopDonk: string;
  /** Blank donk text cannot lead on that street. */
  oopFlopDonk: string;
  oopTurnDonk: string;
  oopRiverDonk: string;
  /** When true, OOP flop sizes are also used as donk sizes on that street. */
  donkFlop: boolean;
  donkTurn: boolean;
  donkRiver: boolean;
  /** Merge near bet sizes within this percent of chip amount (0 = off). */
  mergeThresholdPct: number;
  potCap: number;
  /** Legacy draft flag; Build no longer exposes No 3-bet — use maxRaises. */
  noThreeBet: boolean;
  /**
   * Pio all-in threshold as a fraction of starting stack (0 = off).
   * Default 0.5 (more than half the stack → all-in). Build shows percent;
   * engine `all-in-threshold` is this fraction. List `a` for an explicit
   * all-in size; oversized listed sizes also shove.
   */
  allInThreshold: number;
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
  // Blank bet fields are forced checks. Blank raise fields are no pot-fraction raises.
  oopBets: "",
  ipBets: "",
  oopRaises: "",
  ipRaises: "",
  oopFlop: "",
  ipFlop: "",
  oopTurn: "",
  ipTurn: "",
  oopRiver: "",
  ipRiver: "",
  oopFlopRaises: "",
  ipFlopRaises: "",
  oopTurnRaises: "",
  ipTurnRaises: "",
  oopRiverRaises: "",
  ipRiverRaises: "",
  oopDonk: "",
  oopFlopDonk: "",
  oopTurnDonk: "",
  oopRiverDonk: "",
  donkFlop: false,
  donkTurn: false,
  donkRiver: false,
  mergeThresholdPct: 10,
  potCap: 0,
  noThreeBet: false,
  allInThreshold: 0.5,
  frozen: true,
  accuracy: "",
  // Facing raises only — opening street bets do not consume this cap.
  maxRaises: 1,
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
