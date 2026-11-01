import type { SolvePhase, StatusPayload } from "./types";
import { statusRootEv } from "./status";

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

export function formatNashGap(
  gap: number | null | undefined,
  pot: number | null | undefined,
): string {
  if (gap == null || Number.isNaN(gap)) {
    return "—";
  }
  const abs = gap.toFixed(3);
  if (pot && pot > 0) {
    return `${abs} (${((gap / pot) * 100).toFixed(2)}% pot)`;
  }
  return abs;
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
    return String(status.error);
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
  const gapPart =
    status?.nash_gap != null
      ? ` · Nash ${formatNashGap(status.nash_gap, status.pot)}`
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
      return status?.error ? String(status.error) : "Solve failed.";
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
    nash: formatNashGap(status?.nash_gap, status?.pot),
    runtime: runtime ?? "—",
    rate: rate == null ? "—" : `${rate.toFixed(1)}/s`,
    memory: formatBytes(
      status?.engine_allocated ?? status?.engine_heap_bytes,
    ),
  };
}
