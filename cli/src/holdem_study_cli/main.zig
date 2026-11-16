//! holdem-study-cli — plan / solve portable holdem-study-job/1 over Zig IPC.
//!
//! plan  job.json              → machine-readable tree preview + memory plan
//! solve job.json --out x.psol → isolated solver-engine; save PSOL
//! from-hh hand.txt --out job.json → river hand-history 1 → reviewable job
//!
//! Plan uses the same plan_preview compile path as host tree_preview / plan_memory.
//! Solve spawns a fresh solver-engine (typed IPC protocol 2).
const std = @import("std");
const poker_app = @import("poker_app");
const poker_engine = @import("poker_engine");
const ipc_client = @import("ipc_client.zig");
const job_json = @import("job_json.zig");
const hand_history = @import("hand_history.zig");

fn usage() void {
    std.debug.print(
        \\usage:
        \\  holdem-study-cli plan <job.json>
        \\  holdem-study-cli solve <job.json> --out <study.psol> [--engine <solver-engine>]
        \\  holdem-study-cli from-hh <hand-history.txt> --out <job.json> [--iterations N]
        \\
    , .{});
}

fn findFlag(args: []const []const u8, name: []const u8) ?[]const u8 {
    var i: usize = 0;
    while (i + 1 < args.len) : (i += 1) {
        if (std.mem.eql(u8, args[i], name)) return args[i + 1];
    }
    return null;
}

fn hasFlag(args: []const []const u8, name: []const u8) bool {
    for (args) |a| {
        if (std.mem.eql(u8, a, name)) return true;
    }
    return false;
}

fn defaultEnginePath(allocator: std.mem.Allocator) ![]u8 {
    // Cross-platform (Windows Zig 0.14 has no std.posix.getenv).
    if (std.process.getEnvVarOwned(allocator, "HOLDEM_STUDY_SOLVER_ENGINE")) |env| {
        return env;
    } else |_| {}
    // Prefer zig-out next to cwd (developer layout).
    const candidates = [_][]const u8{
        "zig-out/bin/solver-engine",
        "zig-out/bin/solver-engine.exe",
    };
    for (candidates) |c| {
        std.fs.cwd().access(c, .{}) catch continue;
        return try allocator.dupe(u8, c);
    }
    return try allocator.dupe(u8, candidates[0]);
}

fn cmdPlan(allocator: std.mem.Allocator, job_path: []const u8) !void {
    var job = try job_json.loadJob(allocator, job_path);
    defer job.deinit(allocator);

    const preview = try poker_app.plan_preview.treePreviewJson(allocator, job.street_config);
    defer allocator.free(preview);

    // Wrap with job identity + optional decision walk summary.
    var out = std.ArrayList(u8).init(allocator);
    defer out.deinit();
    const w = out.writer();
    try w.writeAll("{\"schema\":\"holdem-study-plan/1\",\"job_schema\":\"holdem-study-job/1\",");
    try w.print("\"iterations\":{d},", .{job.iterations});
    if (job.accuracy) |acc| {
        try w.print("\"accuracy\":{d},", .{acc});
    } else {
        try w.writeAll("\"accuracy\":null,");
    }
    try w.writeAll("\"preview\":");
    try w.writeAll(preview);
    try w.writeAll("}\n");
    try std.io.getStdOut().writeAll(out.items);
}

fn cmdSolve(allocator: std.mem.Allocator, args: []const []const u8, job_path: []const u8) !void {
    const out_path = findFlag(args, "--out") orelse {
        std.debug.print("solve requires --out <study.psol>\n", .{});
        usage();
        std.process.exit(2);
    };
    const engine_flag = findFlag(args, "--engine");
    const engine_path = if (engine_flag) |p|
        try allocator.dupe(u8, p)
    else
        try defaultEnginePath(allocator);
    defer allocator.free(engine_path);

    var job = try job_json.loadJob(allocator, job_path);
    defer job.deinit(allocator);
    try job_json.validateRunLimits(job);

    var client = try ipc_client.SolverClient.spawn(allocator, engine_path, "holdem-study-cli");
    defer client.deinit();

    _ = try client.request("ready", "null", null);
    {
        var begin_body = std.ArrayList(u8).init(allocator);
        defer begin_body.deinit();
        try begin_body.writer().print("{{\"config_text\":{s}}}", .{std.json.fmt(job.street_config, .{})});
        const begin = try client.request("begin_config", begin_body.items, null);
        defer allocator.free(begin);
    }

    const job_id = "j-cli-solve";
    {
        var solve_body = std.ArrayList(u8).init(allocator);
        defer solve_body.deinit();
        const sw = solve_body.writer();
        try sw.print("{{\"iterations\":{d}", .{job.iterations});
        if (job.accuracy) |acc| {
            try sw.print(",\"accuracy\":{d}", .{acc});
        }
        if (job.time_limit) |tl| {
            try sw.print(",\"time_limit\":{d}", .{tl});
        }
        try sw.writeAll("}");
        const admit = try client.request("solve", solve_body.items, job_id);
        defer allocator.free(admit);
        if (std.mem.indexOf(u8, admit, "\"accepted\":true") == null and
            std.mem.indexOf(u8, admit, "\"running\":true") == null)
        {
            std.debug.print("solve admit unexpected: {s}\n", .{admit});
            std.process.exit(1);
        }
    }

    // Poll status until idle; print compact progress to stderr.
    var n: usize = 0;
    var last_status: []u8 = try allocator.dupe(u8, "{}");
    defer allocator.free(last_status);
    while (n < 100_000) : (n += 1) {
        const st = try client.request("status", "null", null);
        allocator.free(last_status);
        last_status = st;
        const running = std.mem.indexOf(u8, st, "\"running\":true") != null;
        std.debug.print("progress running={s} status_bytes={d}\n", .{
            if (running) "true" else "false",
            st.len,
        });
        if (!running) break;
        std.Thread.sleep(20 * std.time.ns_per_ms);
    }

    {
        var save_body = std.ArrayList(u8).init(allocator);
        defer save_body.deinit();
        try save_body.writer().print("{{\"path\":{s}}}", .{std.json.fmt(out_path, .{})});
        const saved = try client.request("save", save_body.items, null);
        defer allocator.free(saved);
        if (std.mem.indexOf(u8, saved, "\"saved\":true") == null) {
            std.debug.print("save failed: {s}\n", .{saved});
            std.process.exit(1);
        }
    }

    // Machine-readable summary on stdout.
    var summary = std.ArrayList(u8).init(allocator);
    defer summary.deinit();
    const w = summary.writer();
    try w.writeAll("{\"schema\":\"holdem-study-solve/1\",\"out\":");
    try std.json.stringify(out_path, .{}, w);
    try w.writeAll(",\"status\":");
    try w.writeAll(last_status);
    if (job.decision_actions_json) |actions| {
        try w.writeAll(",\"decision_actions\":");
        try w.writeAll(actions);
    }
    try w.writeAll("}\n");
    try std.io.getStdOut().writeAll(summary.items);
}

fn cmdFromHh(allocator: std.mem.Allocator, args: []const []const u8, hh_path: []const u8) !void {
    const out_path = findFlag(args, "--out") orelse {
        std.debug.print("from-hh requires --out <job.json>\n", .{});
        usage();
        std.process.exit(2);
    };
    var iterations: i32 = 50;
    if (findFlag(args, "--iterations")) |it| {
        iterations = try std.fmt.parseInt(i32, it, 10);
    }
    const text = try std.fs.cwd().readFileAlloc(allocator, hh_path, 4 * 1024 * 1024);
    defer allocator.free(text);
    var record = try hand_history.parse(allocator, text);
    defer record.deinit(allocator);
    const job_text = try hand_history.riverJobJson(allocator, record, iterations);
    defer allocator.free(job_text);
    try std.fs.cwd().writeFile(.{ .sub_path = out_path, .data = job_text });
    try std.io.getStdOut().writer().print("{{\"ok\":true,\"out\":{s},\"bytes\":{d}}}\n", .{
        std.json.fmt(out_path, .{}),
        job_text.len,
    });
}

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    var args = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, args);
    if (args.len < 3) {
        usage();
        std.process.exit(2);
    }
    const cmd = args[1];
    const path = args[2];
    const rest = args[1..];

    if (std.mem.eql(u8, cmd, "plan")) {
        try cmdPlan(allocator, path);
    } else if (std.mem.eql(u8, cmd, "solve")) {
        try cmdSolve(allocator, rest, path);
    } else if (std.mem.eql(u8, cmd, "from-hh")) {
        try cmdFromHh(allocator, rest, path);
    } else if (hasFlag(rest, "--help") or std.mem.eql(u8, cmd, "help")) {
        usage();
    } else {
        std.debug.print("unknown command: {s}\n", .{cmd});
        usage();
        std.process.exit(2);
    }
}

// Keep engine import live for street-config validation helpers.
comptime {
    _ = poker_engine;
}
