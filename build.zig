const std = @import("std");

// Zig workspace: engine / app / formats / host(`solver-engine`) / cli.
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

    // Phase 6: typed-IPC sidecar (D11).
    const solver_engine = b.addExecutable(.{
        .name = "solver-engine",
        .root_module = host_mod,
    });
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
