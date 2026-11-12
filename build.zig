const std = @import("std");

// Phase 1 scaffold: poker_engine (+ StreetSpec / street-config 1) and empty
// sibling modules for later phases. Host binary name will be `solver-engine`.
pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
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

    // Static library so `zig build` has a concrete install artifact in Phase 1.
    const engine_lib = b.addLibrary(.{
        .linkage = .static,
        .name = "poker_engine",
        .root_module = engine_mod,
    });
    b.installArtifact(engine_lib);

    // street-config smoke CLI (parse + reformat). Not the product street_solver.
    const street_config_cli = b.addExecutable(.{
        .name = "street-config-check",
        .root_module = cli_mod,
    });
    b.installArtifact(street_config_cli);

    // Host stub compiles as a library until Phase 6 wires IPC + `solver-engine`.
    const host_lib = b.addLibrary(.{
        .linkage = .static,
        .name = "poker_host",
        .root_module = host_mod,
    });
    b.installArtifact(host_lib);

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

    const test_step = b.step("test", "Run Zig unit tests");
    test_step.dependOn(&run_engine_tests.step);
    test_step.dependOn(&run_app_tests.step);
    test_step.dependOn(&run_formats_tests.step);
}
