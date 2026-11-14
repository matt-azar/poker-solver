/** Machine-aware fast solve defaults for Build / Study. */

export interface FastSolveDefaults {
  threads: number;
  memoryMib: number;
  frozen: boolean;
}

const THREAD_CAP = 64;
const MEMORY_MIN_MIB = 1024;
const MEMORY_MAX_MIB = 32768;
/** Fallback when the browser cannot report RAM (GiB). */
const FALLBACK_DEVICE_GIB = 8;

function readLogicalCores(): number {
  if (typeof navigator === "undefined") {
    return 4;
  }
  const cores = Number(navigator.hardwareConcurrency);
  return Number.isFinite(cores) && cores >= 1 ? Math.floor(cores) : 4;
}

function readDeviceMemoryGib(): number {
  if (typeof navigator === "undefined") {
    return FALLBACK_DEVICE_GIB;
  }
  const deviceMemory = Number(
    (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
  );
  return Number.isFinite(deviceMemory) && deviceMemory > 0
    ? deviceMemory
    : FALLBACK_DEVICE_GIB;
}

/**
 * Prefer most logical cores but leave headroom so packaged Study IPC stays
 * live under Windows flop MT train: one core for the solver-engine stdin loop
 * and one for the UI / OS when many cores are available. About half of reported
 * device RAM for the engine budget — Pio / GTO Wizard style.
 */
export function fastSolveDefaults(
  cores = readLogicalCores(),
  deviceMemoryGib = readDeviceMemoryGib(),
): FastSolveDefaults {
  const logical = Math.max(1, Math.floor(cores));
  // Match host `WorkerBudget.maxTrainThreads`: ≤2 → all/1; 3 → 2; ≥4 → n-2.
  const threads =
    logical <= 2
      ? logical === 2
        ? 1
        : logical
      : logical === 3
        ? 2
        : Math.min(THREAD_CAP, Math.max(1, logical - 2));
  const halfRamMib = Math.floor(deviceMemoryGib * 1024 * 0.5);
  const memoryMib = Math.min(
    MEMORY_MAX_MIB,
    Math.max(MEMORY_MIN_MIB, halfRamMib),
  );
  return {
    threads,
    memoryMib,
    frozen: true,
  };
}

export function formatHardwareHint(defaults: FastSolveDefaults): string {
  const gib = defaults.memoryMib / 1024;
  const memLabel =
    gib >= 1 && Number.isInteger(gib)
      ? `${gib} GiB`
      : `${defaults.memoryMib} MiB`;
  return `${defaults.threads} threads · ${memLabel} engine budget (machine default)`;
}
