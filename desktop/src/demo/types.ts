/**
 * Pack layout written by `scripts/public-demo/export_solutions.py`
 * under `desktop/public/demo/` (served as `/demo/…`).
 */

export type DemoExampleId = "flop-explore" | "river-lock" | string;

export type DemoCatalog = {
  version: number;
  label: string;
  engine_build_sha: string;
  download_windows_url: string;
  default_example: DemoExampleId;
  examples: Array<{
    id: DemoExampleId;
    title: string;
    street: string;
    description: string;
    path: string;
  }>;
  export_command?: string;
  follow_up?: string;
  stub?: boolean;
};

export type DemoVariantMeta = {
  id: string;
  title: string;
  description: string;
  pack: string;
};

export type DemoManifest = {
  id: DemoExampleId;
  title: string;
  label: string;
  street: string;
  description: string;
  root_node_id: string;
  default_variant: string;
  variants: DemoVariantMeta[];
  engine_build_sha?: string;
  board?: string[] | string | null;
  pot?: number | null;
  stub?: boolean;
  [key: string]: unknown;
};

export type DemoExpectedNode = {
  actions?: string[];
  action_frequencies?: number[];
  combos?: string[];
  node_ev?: number | null;
  value?: number[];
  action_ev?: number[][];
};

export type DemoExpected = {
  nodes: Record<string, DemoExpectedNode>;
};

export type DemoBootConfig = {
  exampleId: DemoExampleId;
  variantId: string;
  nodeId: string | null;
  catalog: DemoCatalog;
  manifest: DemoManifest;
  basePath: string;
};
