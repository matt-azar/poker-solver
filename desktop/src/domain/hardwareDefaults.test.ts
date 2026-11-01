import { describe, expect, it } from "vitest";
import { fastSolveDefaults, formatHardwareHint } from "./hardwareDefaults";

describe("fastSolveDefaults", () => {
  it("uses all cores on dual-core machines and enables frozen", () => {
    expect(fastSolveDefaults(2, 8)).toEqual({
      threads: 2,
      memoryMib: 4096,
      frozen: true,
    });
  });

  it("leaves one core free when many logical cores are available", () => {
    expect(fastSolveDefaults(8, 16)).toEqual({
      threads: 7,
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

  it("floors memory at 1024 MiB", () => {
    expect(fastSolveDefaults(4, 1)).toEqual({
      threads: 3,
      memoryMib: 1024,
      frozen: true,
    });
  });

  it("formats a short hardware hint", () => {
    expect(
      formatHardwareHint({ threads: 7, memoryMib: 8192, frozen: true }),
    ).toBe("7 threads · 8 GiB engine budget (machine default)");
  });
});
