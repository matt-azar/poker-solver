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
  time_limit?: number;
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
  status_generation?: number;
  iterations?: number | null;
  runtime?: number | null;
  value?: number | null;
  nash_gap?: number | null;
  br0?: number | null;
  br1?: number | null;
  pot?: number | null;
  stack?: number | null;
  board?: string[] | string | null;
  algorithm?: string | null;
  frozen?: boolean | number | null;
  samples?: Array<{ iteration: number; nash_gap: number; value?: number }> | null;
  time_limit_reached?: boolean;
  engine_heap_bytes?: number | null;
  message?: string | null;
  spot?: string | null;
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

export interface ActionValuesPayload {
  pending?: boolean;
  solution_id?: string;
  job_id?: string;
  status_generation?: number;
  node_id?: string;
  units?: string;
  utility_basis?: string;
  combos?: string[];
  value?: Array<number | null>;
  action_ev?: Array<Array<number | null>>;
  ev_defined?: boolean[];
  node_ev?: number | null;
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
  icmStacks: string;
  icmPayouts: string;
  timeLimit: string;
  solutionPath: string;
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

export const DEFAULT_SPOT: SpotDraft = {
  boardText: "Ah Kd 7c 4s 2h",
  oopRange: "AA",
  ipRange: "KK",
  pot: 100,
  stack: 200,
  oopBets: "0.5, 1",
  ipBets: "0.5, 1",
  oopFlop: "",
  ipFlop: "",
  oopTurn: "",
  ipTurn: "",
  oopRiver: "",
  ipRiver: "",
  oopDonk: "",
  potCap: 0,
  noThreeBet: false,
  geometric: false,
  allInThreshold: 0,
  allowAllIn: true,
  frozen: false,
  accuracy: "",
  maxRaises: 2,
  iterations: 200,
  memoryMib: 1024,
  threads: 1,
  algorithm: "cfr_plus",
  samples: 5,
  rakeRate: 0,
  rakeCap: 0,
  icmStacks: "",
  icmPayouts: "",
  timeLimit: "",
  solutionPath: "",
};
