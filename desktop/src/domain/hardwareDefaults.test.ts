import { describe, expect, it } from "vitest";
import { fastSolveDefaults, formatHardwareHint } from "./hardwareDefaults";

describe("fastSolveDefaults", () => {
  it("leaves an IPC core free on dual-core machines and enables frozen", () => {
    expect(fastSolveDefaults(2, 8)).toEqual({
      threads: 1,
      memoryMib: 4096,
      frozen: true,
    });
  });

  it("leaves IPC + UI/OS cores free when many logical cores are available", () => {
    expect(fastSolveDefaults(8, 16)).toEqual({
      threads: 6,
      memoryMib: 8192,
      frozen: true,
    });
  });

  it("caps threads at 64 and memory at 32 GiB", () => {
    expect(fastSolveDefaults(128, 128)).toEqual({
      threads: 64,
      memoryMib: 32768,
      frozen: true,
    });
  });

  it("floors memory at 1024 MiB and reserves two cores on quad-core", () => {
    expect(fastSolveDefaults(4, 1)).toEqual({
      threads: 2,
      memoryMib: 1024,
      frozen: true,
    });
  });

  it("formats a short hardware hint", () => {
    expect(
      formatHardwareHint({ threads: 6, memoryMib: 8192, frozen: true }),
    ).toBe("6 threads · 8 GiB engine budget (machine default)");
  });
});
