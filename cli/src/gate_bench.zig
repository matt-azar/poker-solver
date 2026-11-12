//! Phase 7 interim gate bench (Linux ReleaseFast approximation).
//! Windows Release remains authoritative for cutover (D10/D12).
//! Usage: gate-bench <street-config.txt> [--iterations N] [--threads N] [--label NAME]
//!          [--skip-eval | --eval-root]
//!          [--accuracy X [fraction|chips]] [--eval-every N] [--time-limit SECONDS]
//!
//! Always wrap flop-scale runs with `scripts/zig/run-gate-bounded.sh` (or GNU
//! `timeout`). Do not leave unbounded trains running in agent digs.
//! Prefer `--skip-eval` for flop-scale trains until BR/NashConv is bounded.
//! `--eval-root` reports deal-by-deal root EV only (no NashConv) — fine for
//! tiny/river parity; still avoid on full one_size until a frozen EV path lands.
//!
//! Accuracy-stop mode (`--accuracy`): trains 1 frozen CFR+ iter at a time with
//! frozen NashConv/Accuracy eval every `--eval-every`; stops at Acc ≤ threshold,
//! soft `--time-limit`, or iteration cap. Honors `--threads` / config threads.
const std = @import("std");
const poker_engine = @import("poker_engine");
const poker_app = @import("poker_app");

const EvalMode = enum {
    full,
    skip,
    root,
    accuracy_stop,
};

const Options = struct {
    path: []const u8,
    iterations: i32 = 2,
    threads_override: ?u32 = null,
    label: []const u8 = "unnamed",
    skip_eval: bool = false,
    eval_root: bool = false,
    accuracy: f64 = -1.0,
    accuracy_is_fraction: bool = true,
    eval_every: i32 = 0, // 0 → default once accuracy is armed
    time_limit: f64 = -1.0,
};

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    var args = try std.process.argsWithAllocator(allocator);
    defer args.deinit();
    _ = args.next();

    var opts = Options{
        .path = args.next() orelse {
            std.debug.print(
                \\usage: gate-bench <street-config.txt> [--iterations N] [--threads N] [--label NAME]
                \\         [--skip-eval|--eval-root]
                \\         [--accuracy X [fraction|chips]] [--eval-every N] [--time-limit SECONDS]
                \\
            , .{});
            std.process.exit(2);
        },
    };

    while (args.next()) |arg| {
        if (std.mem.eql(u8, arg, "--iterations")) {
            opts.iterations = try parseI32(need(&args, "--iterations"));
        } else if (std.mem.eql(u8, arg, "--threads")) {
            opts.threads_override = try parseU32(need(&args, "--threads"));
        } else if (std.mem.eql(u8, arg, "--label")) {
            opts.label = need(&args, "--label");
        } else if (std.mem.eql(u8, arg, "--skip-eval")) {
            opts.skip_eval = true;
        } else if (std.mem.eql(u8, arg, "--eval-root")) {
            opts.eval_root = true;
        } else if (std.mem.eql(u8, arg, "--accuracy")) {
            opts.accuracy = try parseF64(need(&args, "--accuracy"));
            if (!(opts.accuracy >= 0.0) or !std.math.isFinite(opts.accuracy)) {
                std.debug.print("--accuracy must be a non-negative finite number\n", .{});
                std.process.exit(2);
            }
            // Optional unit (C++ street_solver: fraction|chips). Peek without consuming
            // unrelated flags by only accepting known unit tokens.
            if (args.next()) |maybe_unit| {
                if (std.mem.eql(u8, maybe_unit, "fraction")) {
                    opts.accuracy_is_fraction = true;
                } else if (std.mem.eql(u8, maybe_unit, "chips")) {
                    opts.accuracy_is_fraction = false;
                } else if (std.mem.startsWith(u8, maybe_unit, "--")) {
                    try applyFlag(maybe_unit, &args, &opts);
                } else {
                    std.debug.print("--accuracy unit must be fraction or chips (got {s})\n", .{maybe_unit});
                    std.process.exit(2);
                }
            }
        } else if (std.mem.eql(u8, arg, "--eval-every")) {
            opts.eval_every = try parseI32(need(&args, "--eval-every"));
            if (opts.eval_every < 1) {
                std.debug.print("--eval-every must be >= 1\n", .{});
                std.process.exit(2);
            }
        } else if (std.mem.eql(u8, arg, "--time-limit")) {
            opts.time_limit = try parseF64(need(&args, "--time-limit"));
            if (!(opts.time_limit >= 0.0) or !std.math.isFinite(opts.time_limit)) {
                std.debug.print("--time-limit must be a non-negative finite number of seconds\n", .{});
                std.process.exit(2);
            }
        } else {
            std.debug.print("unknown arg: {s}\n", .{arg});
            std.process.exit(2);
        }
    }

    if (opts.skip_eval and opts.eval_root) {
        std.debug.print("use only one of --skip-eval / --eval-root\n", .{});
        std.process.exit(2);
    }
    if (opts.accuracy >= 0.0 and (opts.skip_eval or opts.eval_root)) {
        std.debug.print("--accuracy cannot combine with --skip-eval / --eval-root\n", .{});
        std.process.exit(2);
    }
    if (opts.iterations < 1) {
        std.debug.print("iterations must be >= 1\n", .{});
        std.process.exit(2);
    }
    // C++ street_solver defaults eval-every to 20 when accuracy is armed.
    if (opts.accuracy >= 0.0 and opts.eval_every == 0) opts.eval_every = 20;
    if (opts.accuracy < 0.0 and opts.eval_every != 0) {
        std.debug.print("--eval-every requires --accuracy\n", .{});
        std.process.exit(2);
    }
    if (opts.accuracy < 0.0 and opts.time_limit >= 0.0) {
        std.debug.print("--time-limit requires --accuracy (Accuracy-stop / gated train mode)\n", .{});
        std.process.exit(2);
    }

    const mode: EvalMode = if (opts.accuracy >= 0.0)
        .accuracy_stop
    else if (opts.skip_eval)
        .skip
    else if (opts.eval_root)
        .root
    else
        .full;

    const text = try std.fs.cwd().readFileAlloc(allocator, opts.path, 16 * 1024 * 1024);
    defer allocator.free(text);

    const stdout = std.io.getStdOut().writer();
    try stdout.print("phase: start\n", .{});
    try stdout.print("label: {s}\n", .{opts.label});
    try stdout.print("config: {s}\n", .{opts.path});
    try stdout.print("engine: zig-session-cfr-plus\n", .{});
    try stdout.print("iterations_requested: {d}\n", .{opts.iterations});
    try stdout.print("platform_note: Linux interim; Windows Release is authoritative\n", .{});
    if (mode == .accuracy_stop) {
        try stdout.print("accuracy_stop: 1\n", .{});
        try stdout.print("accuracy_target_input: {d:.10}\n", .{opts.accuracy});
        try stdout.print("accuracy_unit: {s}\n", .{if (opts.accuracy_is_fraction) "fraction" else "chips"});
        try stdout.print("eval_every: {d}\n", .{opts.eval_every});
        if (opts.time_limit >= 0.0) {
            try stdout.print("time_limit_seconds: {d:.3}\n", .{opts.time_limit});
        } else {
            try stdout.print("time_limit_seconds: off\n", .{});
        }
        try stdout.print("evaluation_mode: frozen_accuracy_stop\n", .{});
    }

    var sess = poker_app.Session.init(allocator);
    defer sess.deinit();

    const t_begin0 = std.time.nanoTimestamp();
    try sess.begin(text);
    if (opts.threads_override) |n| {
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

    // StreetSpec / CompiledGame pot is tenths-of-a-chip (matches C++ Chip).
    const pot_chips = @as(f64, @floatFromInt(game.pot)) / 10.0;
    try stdout.print("pot_chips: {d:.4}\n", .{pot_chips});

    if (mode == .accuracy_stop) {
        const threshold_chips = if (opts.accuracy_is_fraction) opts.accuracy * pot_chips else opts.accuracy;
        try stdout.print("accuracy_threshold_chips: {d:.10}\n", .{threshold_chips});
        try runAccuracyStop(
            allocator,
            &sess,
            stdout,
            begin_ns,
            pot_chips,
            threshold_chips,
            opts.iterations,
            opts.eval_every,
            opts.time_limit,
        );
        return;
    }

    const t_train0 = std.time.nanoTimestamp();
    try sess.train(opts.iterations);
    const train_ns = std.time.nanoTimestamp() - t_train0;
    const published = sess.published orelse return error.NothingPublished;
    try stdout.print("phase: training\n", .{});
    try stdout.print("train_seconds: {d:.6}\n", .{@as(f64, @floatFromInt(train_ns)) / 1e9});
    try stdout.print("trained: {d}\n", .{published.trained});
    try stdout.print("policy_revision: {d}\n", .{published.revision});

    if (mode == .skip) {
        try stdout.print("phase: final\n", .{});
        try stdout.print("evaluation_skipped: 1\n", .{});
        try stdout.print("total_seconds: {d:.6}\n", .{
            @as(f64, @floatFromInt(begin_ns + train_ns)) / 1e9,
        });
        return;
    }

    if (mode == .root) {
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
    const eval = try evaluateFrozen(&sess, published.average);
    const eval_ns = std.time.nanoTimestamp() - t_eval0;
    const accuracy_frac = if (pot_chips > 0) eval.accuracy / pot_chips else 0;

    try stdout.print("phase: final\n", .{});
    try stdout.print("evaluation_seconds: {d:.6}\n", .{@as(f64, @floatFromInt(eval_ns)) / 1e9});
    try stdout.print("player0_expected_utility: {d:.10}\n", .{eval.u0});
    try stdout.print("player0_best_response_utility: {d:.10}\n", .{eval.br0});
    try stdout.print("player1_best_response_utility: {d:.10}\n", .{eval.br1});
    try stdout.print("nash_gap: {d:.10}\n", .{eval.nash_gap});
    try stdout.print("accuracy: {d:.10}\n", .{eval.accuracy});
    try stdout.print("accuracy_fraction_of_pot: {d:.10}\n", .{accuracy_frac});
    try stdout.print("total_seconds: {d:.6}\n", .{
        @as(f64, @floatFromInt(begin_ns + train_ns + eval_ns)) / 1e9,
    });
}

fn need(args: *std.process.ArgIterator, flag: []const u8) []const u8 {
    return args.next() orelse {
        std.debug.print("{s} needs a value\n", .{flag});
        std.process.exit(2);
    };
}

fn parseI32(text: []const u8) !i32 {
    return std.fmt.parseInt(i32, text, 10);
}

fn parseU32(text: []const u8) !u32 {
    return std.fmt.parseInt(u32, text, 10);
}

fn parseF64(text: []const u8) !f64 {
    return std.fmt.parseFloat(f64, text);
}

fn applyFlag(arg: []const u8, args: *std.process.ArgIterator, opts: *Options) !void {
    if (std.mem.eql(u8, arg, "--iterations")) {
        opts.iterations = try parseI32(need(args, "--iterations"));
    } else if (std.mem.eql(u8, arg, "--threads")) {
        opts.threads_override = try parseU32(need(args, "--threads"));
    } else if (std.mem.eql(u8, arg, "--label")) {
        opts.label = need(args, "--label");
    } else if (std.mem.eql(u8, arg, "--skip-eval")) {
        opts.skip_eval = true;
    } else if (std.mem.eql(u8, arg, "--eval-root")) {
        opts.eval_root = true;
    } else if (std.mem.eql(u8, arg, "--eval-every")) {
        opts.eval_every = try parseI32(need(args, "--eval-every"));
        if (opts.eval_every < 1) {
            std.debug.print("--eval-every must be >= 1\n", .{});
            std.process.exit(2);
        }
    } else if (std.mem.eql(u8, arg, "--time-limit")) {
        opts.time_limit = try parseF64(need(args, "--time-limit"));
        if (!(opts.time_limit >= 0.0) or !std.math.isFinite(opts.time_limit)) {
            std.debug.print("--time-limit must be a non-negative finite number of seconds\n", .{});
            std.process.exit(2);
        }
    } else if (std.mem.eql(u8, arg, "--accuracy")) {
        std.debug.print("nested --accuracy after unit peek is unsupported\n", .{});
        std.process.exit(2);
    } else {
        std.debug.print("unknown arg: {s}\n", .{arg});
        std.process.exit(2);
    }
}

fn evaluateFrozen(
    sess: *poker_app.Session,
    average: []const f32,
) !poker_engine.analysis.evaluation.EvaluationResult {
    // Session-owned FrozenCtx reuses ranks across Acc-stop train(1)/eval cycles.
    const frozen_eval = try sess.evaluateFrozen(average);
    return poker_engine.analysis.evaluation.makeEvaluation(
        frozen_eval.u0,
        frozen_eval.u1,
        frozen_eval.br0,
        frozen_eval.br1,
    );
}

fn runAccuracyStop(
    allocator: std.mem.Allocator,
    sess: *poker_app.Session,
    stdout: anytype,
    begin_ns: i128,
    pot_chips: f64,
    threshold_chips: f64,
    max_iterations: i32,
    eval_every: i32,
    time_limit: f64,
) !void {
    const Eval = poker_engine.analysis.evaluation.EvaluationResult;
    const t_loop0 = std.time.nanoTimestamp();
    var train_ns_total: i128 = 0;
    var eval_ns_total: i128 = 0;
    var completed: i32 = 0;
    var time_limit_reached = false;
    var accuracy_reached = false;
    var last_eval: ?Eval = null;
    var last_acc_frac: f64 = std.math.inf(f64);
    var best_acc_frac: f64 = std.math.inf(f64);
    var best_acc_iter: i32 = 0;
    var eval_count: i32 = 0;

    var history_acc = std.ArrayList(f64).init(allocator);
    defer history_acc.deinit();
    var history_iter = std.ArrayList(i32).init(allocator);
    defer history_iter.deinit();

    try stdout.print("phase: training\n", .{});

    // Match C++ StreetBatchSolver::solve_frozen: train 1 iter, optional Acc
    // check every eval_every, wall check at each iteration boundary.
    var fresh_eval = false;
    while (completed < max_iterations) {
        const t_train0 = std.time.nanoTimestamp();
        try sess.train(1);
        const step_train_ns = std.time.nanoTimestamp() - t_train0;
        train_ns_total += step_train_ns;
        completed += 1;
        fresh_eval = false;

        const do_eval = @rem(completed, eval_every) == 0;
        if (do_eval) {
            const published = sess.published orelse return error.NothingPublished;
            const t_eval0 = std.time.nanoTimestamp();
            const eval = try evaluateFrozen(sess, published.average);
            const step_eval_ns = std.time.nanoTimestamp() - t_eval0;
            eval_ns_total += step_eval_ns;
            eval_count += 1;
            last_eval = eval;
            fresh_eval = true;

            const acc_frac = if (pot_chips > 0) eval.accuracy / pot_chips else 0;
            last_acc_frac = acc_frac;
            if (acc_frac < best_acc_frac) {
                best_acc_frac = acc_frac;
                best_acc_iter = completed;
            }
            try history_acc.append(eval.accuracy);
            try history_iter.append(completed);

            const loop_elapsed = @as(f64, @floatFromInt(std.time.nanoTimestamp() - t_loop0)) / 1e9;
            try stdout.print(
                "checkpoint: iter={d} train_s={d:.3} eval_s={d:.3} elapsed_s={d:.3} accuracy={d:.10} acc_pot={d:.10} u0={d:.10} nash_gap={d:.10}\n",
                .{
                    completed,
                    @as(f64, @floatFromInt(step_train_ns)) / 1e9,
                    @as(f64, @floatFromInt(step_eval_ns)) / 1e9,
                    loop_elapsed,
                    eval.accuracy,
                    acc_frac,
                    eval.u0,
                    eval.nash_gap,
                },
            );

            if (eval.accuracy <= threshold_chips) {
                accuracy_reached = true;
                break;
            }
        }

        if (time_limit >= 0.0) {
            const loop_elapsed = @as(f64, @floatFromInt(std.time.nanoTimestamp() - t_loop0)) / 1e9;
            if (loop_elapsed >= time_limit) {
                time_limit_reached = true;
                break;
            }
        }
    }

    // Final evaluate if the last iteration was not already a checkpoint
    // (mirrors C++ solve_frozen when !fresh).
    if (!fresh_eval or last_eval == null) {
        const published = sess.published orelse return error.NothingPublished;
        const t_eval0 = std.time.nanoTimestamp();
        const eval = try evaluateFrozen(sess, published.average);
        const step_eval_ns = std.time.nanoTimestamp() - t_eval0;
        eval_ns_total += step_eval_ns;
        eval_count += 1;
        last_eval = eval;
        const acc_frac = if (pot_chips > 0) eval.accuracy / pot_chips else 0;
        last_acc_frac = acc_frac;
        if (acc_frac < best_acc_frac) {
            best_acc_frac = acc_frac;
            best_acc_iter = completed;
        }
        try history_acc.append(eval.accuracy);
        try history_iter.append(completed);
        const loop_elapsed = @as(f64, @floatFromInt(std.time.nanoTimestamp() - t_loop0)) / 1e9;
        try stdout.print(
            "checkpoint: iter={d} train_s=0.000 eval_s={d:.3} elapsed_s={d:.3} accuracy={d:.10} acc_pot={d:.10} u0={d:.10} nash_gap={d:.10} final=1\n",
            .{
                completed,
                @as(f64, @floatFromInt(step_eval_ns)) / 1e9,
                loop_elapsed,
                eval.accuracy,
                acc_frac,
                eval.u0,
                eval.nash_gap,
            },
        );
        if (eval.accuracy <= threshold_chips) accuracy_reached = true;
    }

    const eval = last_eval orelse return error.NothingPublished;
    const published = sess.published orelse return error.NothingPublished;
    const total_ns = begin_ns + train_ns_total + eval_ns_total;
    const loop_seconds = @as(f64, @floatFromInt(std.time.nanoTimestamp() - t_loop0)) / 1e9;

    try stdout.print("phase: final\n", .{});
    try stdout.print("trained: {d}\n", .{published.trained});
    try stdout.print("policy_revision: {d}\n", .{published.revision});
    try stdout.print("train_seconds: {d:.6}\n", .{@as(f64, @floatFromInt(train_ns_total)) / 1e9});
    try stdout.print("evaluation_seconds: {d:.6}\n", .{@as(f64, @floatFromInt(eval_ns_total)) / 1e9});
    try stdout.print("solve_loop_seconds: {d:.6}\n", .{loop_seconds});
    try stdout.print("eval_checkpoints: {d}\n", .{eval_count});
    try stdout.print("threads: {d}\n", .{sess.threads});
    try stdout.print("player0_expected_utility: {d:.10}\n", .{eval.u0});
    try stdout.print("player0_best_response_utility: {d:.10}\n", .{eval.br0});
    try stdout.print("player1_best_response_utility: {d:.10}\n", .{eval.br1});
    try stdout.print("nash_gap: {d:.10}\n", .{eval.nash_gap});
    try stdout.print("accuracy: {d:.10}\n", .{eval.accuracy});
    try stdout.print("accuracy_fraction_of_pot: {d:.10}\n", .{last_acc_frac});
    try stdout.print("best_accuracy_fraction_of_pot: {d:.10}\n", .{best_acc_frac});
    try stdout.print("best_accuracy_iteration: {d}\n", .{best_acc_iter});
    try stdout.print("accuracy_reached: {d}\n", .{@as(u8, if (accuracy_reached) 1 else 0)});
    try stdout.print("time_limit_reached: {d}\n", .{@as(u8, if (time_limit_reached) 1 else 0)});
    try stdout.print("iterations_cap_reached: {d}\n", .{
        @as(u8, if (!accuracy_reached and !time_limit_reached and completed >= max_iterations) 1 else 0),
    });
    if (history_acc.items.len != 0) {
        try stdout.print("accuracy_history:", .{});
        for (history_acc.items) |v| try stdout.print(" {d:.10}", .{v});
        try stdout.print("\n", .{});
        try stdout.print("accuracy_iterations:", .{});
        for (history_iter.items) |v| try stdout.print(" {d}", .{v});
        try stdout.print("\n", .{});
    }
    try stdout.print("total_seconds: {d:.6}\n", .{@as(f64, @floatFromInt(total_ns)) / 1e9});
}
