//! Phase 7 interim gate bench (Linux ReleaseFast approximation).
//! Windows Release remains authoritative for cutover (D10/D12).
//! Usage: gate-bench <street-config.txt> [--iterations N] [--label NAME]
//!
//! Always wrap flop-scale runs with `scripts/zig/run-gate-bounded.sh` (or GNU
//! `timeout`). Do not leave unbounded trains running in agent digs.
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
        std.debug.print("usage: gate-bench <street-config.txt> [--iterations N] [--label NAME]\n", .{});
        std.process.exit(2);
    };

    var iterations: i32 = 2;
    var label: []const u8 = "unnamed";
    while (args.next()) |arg| {
        if (std.mem.eql(u8, arg, "--iterations")) {
            const v = args.next() orelse {
                std.debug.print("--iterations needs a value\n", .{});
                std.process.exit(2);
            };
            iterations = try std.fmt.parseInt(i32, v, 10);
        } else if (std.mem.eql(u8, arg, "--label")) {
            label = args.next() orelse {
                std.debug.print("--label needs a value\n", .{});
                std.process.exit(2);
            };
        } else {
            std.debug.print("unknown arg: {s}\n", .{arg});
            std.process.exit(2);
        }
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
    const begin_ns = std.time.nanoTimestamp() - t_begin0;
    const game = sess.game orelse return error.InvalidSession;
    try stdout.print("phase: construction\n", .{});
    try stdout.print("begin_seconds: {d:.6}\n", .{@as(f64, @floatFromInt(begin_ns)) / 1e9});
    try stdout.print("deals: {d}\n", .{game.deals.len});
    try stdout.print("infosets: {d}\n", .{game.slots.len});
    try stdout.print("public_decisions: {d}\n", .{game.nodes.len});

    const t_train0 = std.time.nanoTimestamp();
    try sess.train(iterations);
    const train_ns = std.time.nanoTimestamp() - t_train0;
    const published = sess.published orelse return error.NothingPublished;
    try stdout.print("phase: training\n", .{});
    try stdout.print("train_seconds: {d:.6}\n", .{@as(f64, @floatFromInt(train_ns)) / 1e9});
    try stdout.print("trained: {d}\n", .{published.trained});
    try stdout.print("policy_revision: {d}\n", .{published.revision});

    const t_eval0 = std.time.nanoTimestamp();
    const eval = try poker_engine.analysis.best_response.evaluatePublished(
        allocator,
        game,
        published.average,
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
