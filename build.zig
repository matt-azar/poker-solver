const std = @import("std");
const builtin = @import("builtin");

// Zig workspace: engine / app / formats / host(`solver-engine`) / cli.
pub fn build(b: *std.Build) void {
    // Portable floor when `-Dcpu` is omitted (ZR-175). Bare `zig build
    // -Doptimize=ReleaseFast` on an AVX-512 host otherwise emits EVEX/zmm
    // (e.g. vmovdqu64) and SIGILLs on AVX2-only laptops (i7-10510U /
    // 0xC000001D). Override explicitly with `-Dcpu=native` for host-only digs.
    const default_target: std.Target.Query = if (builtin.cpu.arch == .x86_64) .{
        .cpu_model = .{ .explicit = &std.Target.x86.cpu.x86_64_v2 },
    } else .{};
    const target = b.standardTargetOptions(.{
        .default_target = default_target,
    });
    const optimize = b.standardOptimizeOption(.{});

    const engine_mod = b.addModule("poker_engine", .{
        .root_source_file = b.path("engine/src/root.zig"),
        .target = target,
        .optimize = optimize,
    });

    const formats_mod = b.addModule("poker_formats", .{
        .root_source_file = b.path("formats/src/root.zig"),
        .target = target,
        .optimize = optimize,
    });
    formats_mod.addImport("poker_engine", engine_mod);

    const app_mod = b.addModule("poker_app", .{
        .root_source_file = b.path("app/src/root.zig"),
        .target = target,
        .optimize = optimize,
    });
    app_mod.addImport("poker_engine", engine_mod);
    app_mod.addImport("poker_formats", formats_mod);

    const host_mod = b.createModule(.{
        .root_source_file = b.path("host/src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    host_mod.addImport("poker_engine", engine_mod);
    host_mod.addImport("poker_app", app_mod);
    host_mod.addImport("poker_formats", formats_mod);

    const cli_mod = b.createModule(.{
        .root_source_file = b.path("cli/src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    cli_mod.addImport("poker_engine", engine_mod);

    const gate_bench_mod = b.createModule(.{
        .root_source_file = b.path("cli/src/gate_bench.zig"),
        .target = target,
        .optimize = optimize,
    });
    gate_bench_mod.addImport("poker_engine", engine_mod);
    gate_bench_mod.addImport("poker_app", app_mod);

    const engine_lib = b.addLibrary(.{
        .linkage = .static,
        .name = "poker_engine",
        .root_module = engine_mod,
    });
    b.installArtifact(engine_lib);

    const street_config_cli = b.addExecutable(.{
        .name = "street-config-check",
        .root_module = cli_mod,
    });
    b.installArtifact(street_config_cli);

    // Phase 7 interim measurement harness (not a shipping cutover claim).
    const gate_bench = b.addExecutable(.{
        .name = "gate-bench",
        .root_module = gate_bench_mod,
    });
    b.installArtifact(gate_bench);
    // Phase 6: typed-IPC sidecar (D11).
    const solver_engine = b.addExecutable(.{
        .name = "solver-engine",
        .root_module = host_mod,
    });
    // Packaged Study spawns this under a Windows-subsystem (GUI) shell with
    // inherited pipes. Default Console PE subsystem allocates a blank console
    // window; closing that window sends CTRL_CLOSE_EVENT and kills the sidecar
    // (Study then bricks on IPC). Prefer GUI subsystem so no console appears;
    // Tauri also passes CREATE_NO_WINDOW as defense in depth.
    if (target.result.os.tag == .windows) {
        solver_engine.subsystem = .Windows;
    }
    b.installArtifact(solver_engine);

    const engine_tests = b.addTest(.{
        .root_module = engine_mod,
    });
    const run_engine_tests = b.addRunArtifact(engine_tests);

    const app_tests = b.addTest(.{
        .root_module = app_mod,
    });
    const run_app_tests = b.addRunArtifact(app_tests);

    const formats_tests = b.addTest(.{
        .root_module = formats_mod,
    });
    const run_formats_tests = b.addRunArtifact(formats_tests);

    const host_tests = b.addTest(.{
        .root_module = host_mod,
    });
    const run_host_tests = b.addRunArtifact(host_tests);

    const test_step = b.step("test", "Run Zig unit tests");
    test_step.dependOn(&run_engine_tests.step);
    test_step.dependOn(&run_app_tests.step);
    test_step.dependOn(&run_formats_tests.step);
    test_step.dependOn(&run_host_tests.step);
}
