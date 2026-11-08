import { statusRootEv } from "./status";
import type { SolvePhase, StatusPayload } from "./types";
import { presentUserText } from "./userText";

/** Short label for the study phase pill (Pio-style activity word). */
export function phaseLabel(phase: SolvePhase): string {
  switch (phase) {
    case "idle":
      return "Idle";
    case "building":
      return "Building";
    case "solving":
      return "Solving";
    case "pause_requested":
      return "Pausing";
    case "paused":
      return "Paused";
    case "stop_requested":
      return "Stopping";
    case "complete":
      return "Complete";
    case "loading":
      return "Loading";
    case "saving":
      return "Saving";
    case "analysis_pending":
      return "Analyzing";
    case "failed":
      return "Failed";
    default:
      return phase;
  }
}

/** Pio Accuracy in chips = NashConv / 2. Prefer status.accuracy_chips when present. */
export function measuredAccuracyChips(
  status: StatusPayload | null | undefined,
): number | null {
  if (status == null) {
    return null;
  }
  const chips = Number(status.accuracy_chips);
  if (Number.isFinite(chips)) {
    return chips;
  }
  const nash = Number(status.nash_gap);
  if (Number.isFinite(nash)) {
    return 0.5 * nash;
  }
  return null;
}

/** Format Pio Accuracy (average of unilateral BR gains), with % pot when available. */
export function formatAccuracy(
  accuracyChips: number | null | undefined,
  pot: number | null | undefined,
): string {
  if (accuracyChips == null || Number.isNaN(accuracyChips)) {
    return "—";
  }
  const abs = accuracyChips.toFixed(3);
  if (pot && pot > 0) {
    return `${abs} (${((accuracyChips / pot) * 100).toFixed(2)}% pot)`;
  }
  return abs;
}

/** @deprecated Prefer formatAccuracy with Pio Accuracy chips. */
export function formatNashGap(
  gap: number | null | undefined,
  pot: number | null | undefined,
): string {
  if (gap == null || Number.isNaN(gap)) {
    return "—";
  }
  return formatAccuracy(0.5 * gap, pot);
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !(bytes > 0)) {
    return "—";
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatRuntime(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds - mins * 60);
  return `${mins}m ${secs}s`;
}

function iterationsPerSecond(status: StatusPayload | null | undefined): number | null {
  if (!status) {
    return null;
  }
  const iterations = Number(status.iterations);
  const runtime = Number(status.runtime_seconds ?? status.runtime);
  if (!(iterations > 0) || !(runtime > 0)) {
    return null;
  }
  return iterations / runtime;
}

/**
 * Primary status-bar sentence: what the engine is doing right now.
 * Prefer backend `message` when present; otherwise derive from phase + status.
 */
export function engineActivityMessage(
  phase: SolvePhase,
  status: StatusPayload | null | undefined,
  fallbackMessage: string,
): string {
  if (status?.error) {
    return presentUserText(String(status.error));
  }
  if (status?.message && String(status.message).trim()) {
    return String(status.message).trim();
  }
  if (fallbackMessage && fallbackMessage.trim()) {
    const trimmed = fallbackMessage.trim();
    // Prefer richer derived copy while a solve is live.
    if (
      phase !== "solving" &&
      phase !== "building" &&
      phase !== "pause_requested" &&
      phase !== "stop_requested"
    ) {
      return trimmed;
    }
  }

  const iter = status?.iterations ?? 0;
  const target = status?.iterations_requested;
  const iterPart =
    target != null && Number(target) > 0
      ? `${iter} / ${target} iters`
      : `${iter} iters`;
  const accuracyChips = measuredAccuracyChips(status);
  const gapPart =
    accuracyChips != null
      ? ` · Acc ${formatAccuracy(accuracyChips, status?.pot)}`
      : "";
  const runtime = formatRuntime(
    status?.runtime_seconds ?? status?.runtime ?? null,
  );
  const rate = iterationsPerSecond(status);
  const ratePart = rate != null ? ` · ${rate.toFixed(1)} it/s` : "";
  const timePart = runtime ? ` · ${runtime}` : "";

  switch (phase) {
    case "building":
      return "Building public tree and allocating engine memory…";
    case "solving":
      return `Solving — ${iterPart}${gapPart}${ratePart}${timePart}`;
    case "pause_requested":
      return `Pausing after current sample — ${iterPart}${gapPart}`;
    case "paused":
      return `Paused at ${iterPart}${gapPart}. Browse freely; Continue resumes.`;
    case "stop_requested":
      return `Stopping — keeping completed iterations (${iterPart})…`;
    case "complete":
      return status?.cancelled
        ? `Stopped at ${iterPart}${gapPart}${timePart}`
        : status?.time_limit_reached
          ? `Time limit at ${iterPart}${gapPart}${timePart}`
          : `Solve complete — ${iterPart}${gapPart}${timePart}`;
    case "failed":
      return status?.error ? presentUserText(String(status.error)) : "Solve failed.";
    case "loading":
      return "Loading solution…";
    case "saving":
      return "Saving solution…";
    case "analysis_pending":
      return "Computing EV / analysis…";
    default:
      return fallbackMessage?.trim() || "Ready";
  }
}

export function statusMetrics(status: StatusPayload | null | undefined): {
  iterations: string;
  target: string;
  ev: string;
  nash: string;
  runtime: string;
  rate: string;
  memory: string;
  eta: string;
} {
  const ev = statusRootEv(status);
  const rate = iterationsPerSecond(status);
  const runtime = formatRuntime(
    status?.runtime_seconds ?? status?.runtime ?? null,
  );
  return {
    iterations:
      status?.iterations == null ? "—" : String(status.iterations),
    target:
      status?.iterations_requested == null ||
      !(Number(status.iterations_requested) > 0)
        ? "—"
        : String(status.iterations_requested),
    ev: ev == null ? "—" : ev.toFixed(3),
    nash: formatAccuracy(measuredAccuracyChips(status), status?.pot),
    runtime: runtime ?? "—",
    rate: rate == null ? "—" : `${rate.toFixed(1)}/s`,
    memory: formatBytes(
      status?.engine_allocated ?? status?.engine_heap_bytes,
    ),
    eta: formatEta(estimateRemainingSeconds(status)),
  };
}

function formatEta(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) {
    return "—";
  }
  if (seconds < 60) {
    return `~${Math.max(1, Math.round(seconds))}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds - mins * 60);
  if (mins < 60) {
    return `~${mins}m ${secs}s`;
  }
  const hours = Math.floor(mins / 60);
  return `~${hours}h ${mins % 60}m`;
}

/**
 * ETA to the active stop criterion when it is not a wall-clock time limit.
 * Prefers remaining iterations / rate; falls back to Pio Accuracy extrapolation.
 */
export function estimateRemainingSeconds(
  status: StatusPayload | null | undefined,
): number | null {
  if (!status?.running || status.paused) {
    return null;
  }
  // Time-limit solves: the criterion *is* time — no separate ETA.
  if (status.time_limit_reached) {
    return null;
  }
  const timeLimit = Number(
    (status as { time_limit?: number }).time_limit ?? NaN,
  );
  if (Number.isFinite(timeLimit) && timeLimit >= 0) {
    return null;
  }

  const rate = iterationsPerSecond(status);
  const iterations = Number(status.iterations ?? 0);
  const target = Number(status.iterations_requested ?? 0);
  if (rate != null && rate > 0 && target > iterations) {
    return (target - iterations) / rate;
  }

  const pot = Number(status.pot ?? 0);
  const measured = measuredAccuracyChips(status);
  // status.accuracy is the job target: pot fraction by default (≤1), else chips.
  const accuracyTarget =
    status.accuracy != null
      ? Number(status.accuracy)
      : status.accuracy_threshold != null
        ? Number(status.accuracy_threshold)
        : NaN;
  const gapTarget =
    Number.isFinite(accuracyTarget) && accuracyTarget >= 0
      ? pot > 0 && accuracyTarget <= 1
        ? accuracyTarget * pot
        : accuracyTarget
      : NaN;
  if (
    !(rate != null && rate > 0) ||
    !(measured != null && measured > 0) ||
    !(gapTarget >= 0) ||
    measured <= gapTarget
  ) {
    return null;
  }

  const series = Array.isArray(status.gap_series) ? status.gap_series : [];
  if (series.length >= 2) {
    const a = series[series.length - 2]!;
    const b = series[series.length - 1]!;
    const iterA = Number(a.iterations ?? a.iteration ?? 0);
    const iterB = Number(b.iterations ?? b.iteration ?? 0);
    const gapA = Number(
      a.accuracy_chips != null ? a.accuracy_chips : 0.5 * Number(a.nash_gap),
    );
    const gapB = Number(
      b.accuracy_chips != null ? b.accuracy_chips : 0.5 * Number(b.nash_gap),
    );
    if (iterB > iterA && gapA > gapB && gapB > gapTarget && gapB > 0) {
      // Log-linear decay toward the target Accuracy.
      const decay = Math.log(gapA / gapB) / (iterB - iterA);
      if (decay > 0) {
        const itersLeft = Math.log(gapB / gapTarget) / decay;
        if (Number.isFinite(itersLeft) && itersLeft > 0) {
          return itersLeft / rate;
        }
      }
    }
  }
  return null;
}
