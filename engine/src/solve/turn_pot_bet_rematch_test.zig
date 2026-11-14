//! Turn pot-bet formal rematch vs tip C++ StreetBatch/frozen on `configs/street_default.txt`.
//! Dig 2026-11-12: tip `origin/zig-rewrite` @ `7ea8945` + rebuilt C++ `street_solver` (g++ Release).
//! Zig frozen ↔ tip C++ frozen/public-tree batch match to printed precision; StreetGame
//! `--reference` still carries the older docs/STREETS.md pin (50.0016209123) — not the
//! production batch path this residual closes.
const std = @import("std");
const compile_mod = @import("../game/compile.zig");
const street_config = @import("../game/street_config.zig");
const training_state = @import("training_state.zig");
const frozen_walk = @import("frozen_walk.zig");
const inspect = @import("../analysis/inspect.zig");

const street_default_path = "configs/street_default.txt";

fn compileConfig(allocator: std.mem.Allocator, text: []const u8) !compile_mod.CompiledGame {
    var spec = try street_config.parseStreetConfig(allocator, text);
    defer spec.deinit();
    return compile_mod.compile(allocator, spec);
}

fn trainEval(allocator: std.mem.Allocator, game: compile_mod.CompiledGame, iterations: i32) !frozen_walk.FrozenEval {
    var state = try training_state.TrainingState.init(allocator, game);
    defer state.deinit();
    var published = try frozen_walk.trainFrozenCfrPlus(allocator, game, &state, iterations, null);
    defer published.deinit();
    return frozen_walk.evaluatePublishedFrozen(allocator, game, published.average);
}

test "turn check-down AhAd vs 3d2c pins +50 / gap 0 vs tip C++" {
    // Explicit-empty bet lines = check-only (docs: empty ≠ absent).
    const text =
        \\street-config 1
        \\board Kh Kd 7c 4s
        \\pot 100
        \\stack 100
        \\oop-range AhAd:1
        \\ip-range 3d2c:1
        \\first-to-act 0
        \\max-raises 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 1024
        \\threads 1
        \\oop-bets
        \\ip-bets
        \\oop-raises
        \\ip-raises
        \\
    ;
    var game = try compileConfig(std.testing.allocator, text);
    defer game.deinit();
    const eval = try trainEval(std.testing.allocator, game, 1);
    try std.testing.expectApproxEqAbs(@as(f64, 50.0), eval.u0, 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, 0.0), eval.nash_gap, 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, 0.0), eval.accuracy, 1e-12);
}

test "turn pot-bet frozen 20-iter gap pin vs tip C++ StreetBatch" {
    const text = try std.fs.cwd().readFileAlloc(std.testing.allocator, street_default_path, 1024 * 1024);
    defer std.testing.allocator.free(text);
    var game = try compileConfig(std.testing.allocator, text);
    defer game.deinit();
    const eval = try trainEval(std.testing.allocator, game, 20);
    // tip C++ frozen/public: u0 50.6138885879, gap 0.714287237062
    try std.testing.expectApproxEqAbs(@as(f64, 50.6138885879), eval.u0, 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, 0.714287237062), eval.nash_gap, 1e-9);
}

test "turn pot-bet frozen 400-iter value/gap/strategy pins vs tip C++ StreetBatch" {
    const text = try std.fs.cwd().readFileAlloc(std.testing.allocator, street_default_path, 1024 * 1024);
    defer std.testing.allocator.free(text);
    var game = try compileConfig(std.testing.allocator, text);
    defer game.deinit();

    var state = try training_state.TrainingState.init(std.testing.allocator, game);
    defer state.deinit();
    var published = try frozen_walk.trainFrozenCfrPlus(std.testing.allocator, game, &state, 400, null);
    defer published.deinit();
    const eval = try frozen_walk.evaluatePublishedFrozen(std.testing.allocator, game, published.average);

    // tip C++ frozen (= public-tree batch on this lock): u0 50.0016203147, gap 0.00186954556651
    // (StreetGame --reference docs pin 50.0016209123 / 0.00187032418952 is a separate oracle.)
    try std.testing.expectApproxEqAbs(@as(f64, 50.0016203147), eval.u0, 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, 0.00186954556651), eval.nash_gap, 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, 0.000934772783257), eval.accuracy, 1e-9);

    // Reach-weighted root mix from tip C++ `--report` after frozen 400.
    const root_pins = [_]struct { action: []const u8, probability: f64 }{
        .{ .action = "Check", .probability = 0.7999762892723083 },
        .{ .action = "Bet 100 all-in", .probability = 0.20002369582653046 },
    };
    var page = try inspect.inspectNode(std.testing.allocator, game, published, 0, -1, -1);
    defer page.deinit();
    try std.testing.expectEqual(@as(u8, 2), page.n_actions);
    try std.testing.expect(page.n_hands >= 1);

    // One-combo lock: hand-row strategy equals the reach-weighted root mix.
    var hand_i: ?usize = null;
    for (page.combos, 0..) |combo, i| {
        if (std.mem.eql(u8, combo, "AhAd")) hand_i = i;
    }
    try std.testing.expect(hand_i != null);

    var worst: f64 = 0;
    for (root_pins) |pin| {
        var action_i: ?usize = null;
        for (page.actions, 0..) |label, i| {
            if (std.mem.eql(u8, label, pin.action)) action_i = i;
        }
        try std.testing.expect(action_i != null);
        const got = @as(f64, page.strategy[hand_i.? * page.n_actions + action_i.?]);
        const d = @abs(got - pin.probability);
        if (d > worst) worst = d;
        try std.testing.expectApproxEqAbs(pin.probability, got, 1e-7);
    }
    try std.testing.expect(worst <= 1e-7);
}
