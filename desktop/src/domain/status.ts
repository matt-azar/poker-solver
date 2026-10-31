import type { StatusPayload } from "./types";

export interface GapSample {
  iteration: number;
  nash_gap: number;
  value?: number;
}

/** Prefer gap_series from explorer status; tolerate legacy sample-array shapes. */
export function gapSamplesFromStatus(status: StatusPayload | null | undefined): GapSample[] {
  if (!status) {
    return [];
  }
  const series = status.gap_series;
  if (Array.isArray(series)) {
    return series
      .map((entry) => ({
        iteration: Number(entry.iterations ?? entry.iteration ?? 0),
        nash_gap: Number(entry.nash_gap),
        value:
          entry.value == null || Number.isNaN(Number(entry.value))
            ? undefined
            : Number(entry.value),
      }))
      .filter((entry) => entry.iteration > 0 && Number.isFinite(entry.nash_gap));
  }
  if (Array.isArray(status.samples)) {
    return status.samples
      .map((entry) => ({
        iteration: Number(entry.iteration),
        nash_gap: Number(entry.nash_gap),
        value: entry.value,
      }))
      .filter((entry) => entry.iteration > 0 && Number.isFinite(entry.nash_gap));
  }
  return [];
}

export function statusRootEv(status: StatusPayload | null | undefined): number | null {
  if (!status) {
    return null;
  }
  const value = status.player0_expected_utility ?? status.value;
  return value == null || Number.isNaN(Number(value)) ? null : Number(value);
}

export function statusRootNodeId(status: StatusPayload | null | undefined): string | null {
  if (!status) {
    return null;
  }
  const id = status.root_node_id;
  return typeof id === "string" && id ? id : null;
}
