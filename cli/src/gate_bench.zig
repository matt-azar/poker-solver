//! Phase 7 interim gate bench (Linux ReleaseFast approximation).
//! Windows Release remains authoritative for cutover (D10/D12).
//! Usage: gate-bench <street-config.txt> [--iterations N] [--threads N] [--label NAME]
//!          [--skip-eval | --eval-root]
//!
//! Always wrap flop-scale runs with `scripts/zig/run-gate-bounded.sh` (or GNU
//! `timeout`). Do not leave unbounded trains running in agent digs.
//! Prefer `--skip-eval` for flop-scale trains until BR/NashConv is bounded.
//! `--eval-root` reports deal-by-deal root EV only (no NashConv) — fine for
//! tiny/river parity; still avoid on full one_size until a frozen EV path lands.
const std = @import("std");
const poker_engine = @import("poker_engine");
const poker_app = @import("poker_app");

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    var args = try std.process.argsWithAllocator(allocator);
    defer args.deinit();
    _ = args.next();

    const path = args.next() orelse {
        std.debug.print("usage: gate-bench <street-config.txt> [--iterations N] [--threads N] [--label NAME] [--skip-eval|--eval-root]\n", .{});
        std.process.exit(2);
    };

    var iterations: i32 = 2;
    var threads_override: ?u32 = null;
    var label: []const u8 = "unnamed";
    var skip_eval = false;
    var eval_root = false;
    while (args.next()) |arg| {
        if (std.mem.eql(u8, arg, "--iterations")) {
            const v = args.next() orelse {
                std.debug.print("--iterations needs a value\n", .{});
                std.process.exit(2);
            };
            iterations = try std.fmt.parseInt(i32, v, 10);
        } else if (std.mem.eql(u8, arg, "--threads")) {
            const v = args.next() orelse {
                std.debug.print("--threads needs a value\n", .{});
                std.process.exit(2);
            };
            threads_override = try std.fmt.parseInt(u32, v, 10);
        } else if (std.mem.eql(u8, arg, "--label")) {
            label = args.next() orelse {
                std.debug.print("--label needs a value\n", .{});
                std.process.exit(2);
            };
        } else if (std.mem.eql(u8, arg, "--skip-eval")) {
            skip_eval = true;
        } else if (std.mem.eql(u8, arg, "--eval-root")) {
            eval_root = true;
        } else {
            std.debug.print("unknown arg: {s}\n", .{arg});
            std.process.exit(2);
        }
    }
    if (skip_eval and eval_root) {
        std.debug.print("use only one of --skip-eval / --eval-root\n", .{});
        std.process.exit(2);
    }
    if (iterations < 1) {
        std.debug.print("iterations must be >= 1\n", .{});
        std.process.exit(2);
    }

    const text = try std.fs.cwd().readFileAlloc(allocator, path, 16 * 1024 * 1024);
    defer allocator.free(text);

    const stdout = std.io.getStdOut().writer();
    try stdout.print("phase: start\n", .{});
    try stdout.print("label: {s}\n", .{label});
    try stdout.print("config: {s}\n", .{path});
    try stdout.print("engine: zig-session-cfr-plus\n", .{});
    try stdout.print("iterations_requested: {d}\n", .{iterations});
    try stdout.print("platform_note: Linux interim; Windows Release is authoritative\n", .{});

    var sess = poker_app.Session.init(allocator);
    defer sess.deinit();

    const t_begin0 = std.time.nanoTimestamp();
    try sess.begin(text);
    if (threads_override) |n| {
        if (n < 1 or n > 64) {
            std.debug.print("--threads must be 1..64\n", .{});
            std.process.exit(2);
        }
        sess.setThreads(n);
    }
    const begin_ns = std.time.nanoTimestamp() - t_begin0;
    const game = sess.game orelse return error.InvalidSession;
    try stdout.print("phase: construction\n", .{});
    try stdout.print("begin_seconds: {d:.6}\n", .{@as(f64, @floatFromInt(begin_ns)) / 1e9});
    try stdout.print("deals: {d}\n", .{game.deals.len});
    try stdout.print("infosets: {d}\n", .{game.slots.len});
    try stdout.print("public_decisions: {d}\n", .{game.nodes.len});
    try stdout.print("threads: {d}\n", .{sess.threads});

    const t_train0 = std.time.nanoTimestamp();
    try sess.train(iterations);
    const train_ns = std.time.nanoTimestamp() - t_train0;
    const published = sess.published orelse return error.NothingPublished;
    try stdout.print("phase: training\n", .{});
    try stdout.print("train_seconds: {d:.6}\n", .{@as(f64, @floatFromInt(train_ns)) / 1e9});
    try stdout.print("trained: {d}\n", .{published.trained});
    try stdout.print("policy_revision: {d}\n", .{published.revision});

    if (skip_eval) {
        try stdout.print("phase: final\n", .{});
        try stdout.print("evaluation_skipped: 1\n", .{});
        try stdout.print("total_seconds: {d:.6}\n", .{
            @as(f64, @floatFromInt(begin_ns + train_ns)) / 1e9,
        });
        return;
    }

    if (eval_root) {
        const t_eval0 = std.time.nanoTimestamp();
        const root_ev = try poker_engine.solve.cfr_plus.evaluatePublished(allocator, game, published);
        const eval_ns = std.time.nanoTimestamp() - t_eval0;
        try stdout.print("phase: final\n", .{});
        try stdout.print("evaluation_mode: root_ev\n", .{});
        try stdout.print("evaluation_seconds: {d:.6}\n", .{@as(f64, @floatFromInt(eval_ns)) / 1e9});
        try stdout.print("player0_expected_utility: {d:.10}\n", .{root_ev});
        try stdout.print("total_seconds: {d:.6}\n", .{
            @as(f64, @floatFromInt(begin_ns + train_ns + eval_ns)) / 1e9,
        });
        return;
    }

    const t_eval0 = std.time.nanoTimestamp();
    const frozen_eval = try poker_engine.solve.frozen_walk.evaluatePublishedFrozenThreaded(
        allocator,
        game,
        published.average,
        sess.threads,
    );
    const eval = poker_engine.analysis.evaluation.makeEvaluation(
        frozen_eval.u0,
        frozen_eval.u1,
        frozen_eval.br0,
        frozen_eval.br1,
    );
    const eval_ns = std.time.nanoTimestamp() - t_eval0;
    // StreetSpec / CompiledGame pot is tenths-of-a-chip (matches C++ Chip).
    const pot_chips = @as(f64, @floatFromInt(game.pot)) / 10.0;
    const accuracy_frac = if (pot_chips > 0) eval.accuracy / pot_chips else 0;

    try stdout.print("phase: final\n", .{});
    try stdout.print("evaluation_seconds: {d:.6}\n", .{@as(f64, @floatFromInt(eval_ns)) / 1e9});
    try stdout.print("player0_expected_utility: {d:.10}\n", .{eval.u0});
    try stdout.print("player0_best_response_utility: {d:.10}\n", .{eval.br0});
    try stdout.print("player1_best_response_utility: {d:.10}\n", .{eval.br1});
    try stdout.print("nash_gap: {d:.10}\n", .{eval.nash_gap});
    try stdout.print("accuracy: {d:.10}\n", .{eval.accuracy});
    try stdout.print("accuracy_fraction_of_pot: {d:.10}\n", .{accuracy_frac});
    try stdout.print("pot_chips: {d:.4}\n", .{pot_chips});
    try stdout.print("total_seconds: {d:.6}\n", .{
        @as(f64, @floatFromInt(begin_ns + train_ns + eval_ns)) / 1e9,
    });
}
