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
const line_validate = @import("line_validate.zig");

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

fn exitJobError(err: job_json.JobError) noreturn {
    const msg: []const u8 = switch (err) {
        error.InvalidJob => "invalid job (check schema / run limits)",
        error.MissingField => "invalid job (missing field)",
        error.BadIterations => "invalid job (iterations must be >= 1)",
        error.BadStreetConfig => "invalid job (street-config 1 required)",
        error.OutOfMemory => "out of memory",
    };
    std.debug.print("{s}\n", .{msg});
    std.process.exit(2);
}

const StatusSnapshot = struct {
    running: bool = false,
    failed: bool = false,
    cancelled: bool = false,
    terminal_reason: []const u8 = "none",
    last_error: ?[]const u8 = null,
};

fn parseStatus(allocator: std.mem.Allocator, raw: []const u8) !StatusSnapshot {
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, raw, .{});
    defer parsed.deinit();
    const root = parsed.value;
    if (root != .object) return error.InvalidStatus;
    var snap: StatusSnapshot = .{};
    if (root.object.get("running")) |v| {
        if (v == .bool) snap.running = v.bool;
    }
    if (root.object.get("failed")) |v| {
        if (v == .bool) snap.failed = v.bool;
    }
    if (root.object.get("cancelled")) |v| {
        if (v == .bool) snap.cancelled = v.bool;
    }
    if (root.object.get("terminal_reason")) |v| {
        if (v == .string) snap.terminal_reason = try allocator.dupe(u8, v.string);
    } else {
        snap.terminal_reason = try allocator.dupe(u8, "none");
    }
    if (root.object.get("last_error")) |v| {
        if (v == .string) snap.last_error = try allocator.dupe(u8, v.string);
    }
    return snap;
}

fn deinitStatus(allocator: std.mem.Allocator, snap: *StatusSnapshot) void {
    if (snap.terminal_reason.len != 0) allocator.free(snap.terminal_reason);
    if (snap.last_error) |e| allocator.free(e);
    snap.* = .{};
}

fn solveOutcomeFailed(snap: StatusSnapshot) bool {
    if (snap.failed) return true;
    if (snap.cancelled) return true;
    if (snap.last_error != null) return true;
    // Host uses TrainTerminal tag names on status.
    if (std.mem.eql(u8, snap.terminal_reason, "failed")) return true;
    if (std.mem.eql(u8, snap.terminal_reason, "cancelled")) return true;
    return false;
}

fn refuseMissingLine(job: job_json.Job) void {
    if (job.missing_sizes.len == 0) return;
    std.debug.print("error: job reports missing_sizes (", .{});
    for (job.missing_sizes, 0..) |m, i| {
        if (i > 0) std.debug.print(", ", .{});
        std.debug.print("{s}", .{m});
    }
    std.debug.print(") — refusing success\n", .{});
    std.process.exit(1);
}

fn validateDecisionOrExit(allocator: std.mem.Allocator, job: job_json.Job) !void {
    refuseMissingLine(job);
    if (job.decision_actions.len == 0) return;
    var labels = try allocator.alloc([]const u8, job.decision_actions.len);
    defer allocator.free(labels);
    for (job.decision_actions, 0..) |a, i| labels[i] = a;
    var walk = try line_validate.validateConfigLine(allocator, job.street_config, labels);
    defer walk.deinit(allocator);
    // decision.actions must already be the Study open path (no trailing Call/Fold).
    // walkPlayedLine truncates terminal endings — reject any length mismatch.
    if (!walk.ok or walk.missing.len != 0 or walk.decision_actions.len != labels.len) {
        std.debug.print("error: decision path not a Study decision in compiled tree", .{});
        if (walk.missing.len != 0) {
            std.debug.print(" (missing", .{});
            for (walk.missing) |m| std.debug.print(" {s}", .{m});
            std.debug.print(")", .{});
        } else if (walk.decision_actions.len != labels.len) {
            std.debug.print(" (path ends on terminal; strip Call/Fold from decision.actions)", .{});
        }
        std.debug.print("\n", .{});
        std.process.exit(1);
    }
    if (walk.legal_at_decision.len == 0) {
        std.debug.print("error: decision path does not land on a Study decision node\n", .{});
        std.process.exit(1);
    }
}

fn cmdPlan(allocator: std.mem.Allocator, job_path: []const u8) !void {
    var job = job_json.loadJob(allocator, job_path) catch |err| exitJobError(err);
    defer job.deinit(allocator);
    try validateDecisionOrExit(allocator, job);

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

    var job = job_json.loadJob(allocator, job_path) catch |err| exitJobError(err);
    defer job.deinit(allocator);
    // Run limits already enforced in loadJob; keep AF-27 decision-path gate.
    try validateDecisionOrExit(allocator, job);

    var client = try ipc_client.SolverClient.spawn(allocator, engine_path, "holdem-study-cli");
    defer client.deinit();

    _ = try client.request("ready", "null", null);
    {
        var begin_body = std.ArrayList(u8).init(allocator);
        defer begin_body.deinit();
        try begin_body.writer().print("{{\"config_text\":{s}}}", .{std.json.fmt(job.street_config, .{})});
        const begin = try client.request("begin_config", begin_body.items, null);
        defer allocator.free(begin);
        if (std.mem.indexOf(u8, begin, "\"ok\":false") != null or
            (std.mem.indexOf(u8, begin, "\"solution_id\"") == null and std.mem.indexOf(u8, begin, "\"accepted\"") == null))
        {
            // begin_config may be async-admit; tolerate accepted / solution_id shapes.
            if (std.mem.indexOf(u8, begin, "\"error_code\"") != null) {
                std.debug.print("begin_config failed: {s}\n", .{begin});
                std.process.exit(1);
            }
        }
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
        if (std.mem.indexOf(u8, admit, "\"ok\":false") != null) {
            std.debug.print("solve admit failed: {s}\n", .{admit});
            std.process.exit(1);
        }
        if (std.mem.indexOf(u8, admit, "\"accepted\":true") == null and
            std.mem.indexOf(u8, admit, "\"running\":true") == null and
            std.mem.indexOf(u8, admit, "\"solution_id\"") == null)
        {
            std.debug.print("solve admit unexpected: {s}\n", .{admit});
            std.process.exit(1);
        }
    }

    // Poll structured status until idle; distinguish success / failure / timeout.
    var n: usize = 0;
    var last_status: []u8 = try allocator.dupe(u8, "{}");
    defer allocator.free(last_status);
    var last_snap: StatusSnapshot = .{
        .terminal_reason = try allocator.dupe(u8, "none"),
    };
    defer deinitStatus(allocator, &last_snap);

    while (n < 100_000) : (n += 1) {
        const st = try client.request("status", "null", null);
        allocator.free(last_status);
        last_status = st;

        deinitStatus(allocator, &last_snap);
        last_snap = parseStatus(allocator, st) catch StatusSnapshot{
            .terminal_reason = try allocator.dupe(u8, "none"),
            .running = std.mem.indexOf(u8, st, "\"running\":true") != null,
        };

        std.debug.print("progress running={s} failed={s} terminal={s} status_bytes={d}\n", .{
            if (last_snap.running) "true" else "false",
            if (last_snap.failed) "true" else "false",
            last_snap.terminal_reason,
            st.len,
        });
        if (!last_snap.running) break;
        std.Thread.sleep(20 * std.time.ns_per_ms);
    }

    if (last_snap.running) {
        std.debug.print("solve timed out waiting for idle status\n", .{});
        std.process.exit(1);
    }
    if (solveOutcomeFailed(last_snap)) {
        std.debug.print(
            "solve failed terminal={s} last_error={s}\n",
            .{ last_snap.terminal_reason, last_snap.last_error orelse "" },
        );
        std.process.exit(1);
    }
    // Successful completion includes completed / accuracy_reached / time_limit_reached.
    // time_limit_reached still produces a usable checkpoint — save it.

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

    // Re-load and refuse success when the played line is missing from the tree.
    var job = try job_json.loadJob(allocator, out_path);
    defer job.deinit(allocator);
    const ok = job.missing_sizes.len == 0;
    try std.io.getStdOut().writer().print("{{\"ok\":{},\"out\":{s},\"bytes\":{d},\"missing_sizes\":", .{
        ok,
        std.json.fmt(out_path, .{}),
        job_text.len,
    });
    try std.io.getStdOut().writeAll("[");
    for (job.missing_sizes, 0..) |m, i| {
        if (i > 0) try std.io.getStdOut().writeAll(",");
        try std.json.stringify(m, .{}, std.io.getStdOut().writer());
    }
    try std.io.getStdOut().writeAll("]}\n");
    if (!ok) {
        std.debug.print("error: played line missing from compiled tree — job written for review only\n", .{});
        std.process.exit(1);
    }
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
