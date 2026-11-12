//! Strategy abs-diff harness: Zig frozen river smoke pins vs tip C++ StreetBatch dump.
//! Dig 2026-11-12 on tip `2716816`: max abs-diff Zig↔C++ ≈ 2e-8 across 16 entries.
const std = @import("std");
const compile_mod = @import("../game/compile.zig");
const street_config = @import("../game/street_config.zig");
const training_state = @import("training_state.zig");
const frozen_walk = @import("frozen_walk.zig");
const inspect = @import("../analysis/inspect.zig");

const Pin = struct {
    combo: []const u8,
    action: []const u8,
    probability: f64,
};

test "river_gate_smoke frozen 40-iter strategy abs-diff pins vs tip C++" {
    const text = try std.fs.cwd().readFileAlloc(
        std.testing.allocator,
        "benchmarks/study/configs/river_gate_smoke.txt",
        1024 * 1024,
    );
    defer std.testing.allocator.free(text);
    var spec = try street_config.parseStreetConfig(std.testing.allocator, text);
    defer spec.deinit();
    var game = try compile_mod.compile(std.testing.allocator, spec);
    defer game.deinit();
    var state = try training_state.TrainingState.init(std.testing.allocator, game);
    defer state.deinit();
    var published = try frozen_walk.trainFrozenCfrPlus(std.testing.allocator, game, &state, 40);
    defer published.deinit();

    const eval = try frozen_walk.evaluatePublishedFrozen(std.testing.allocator, game, published.average);
    try std.testing.expectApproxEqAbs(@as(f64, -0.109203680245), eval.u0, 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, 0.279470518608), eval.nash_gap, 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, 0.139735259304), eval.accuracy, 1e-12);

    // Root OOP open pins from tip C++ `average_strategy_entries` dump.
    const pins = [_]Pin{
        .{ .combo = "2h2d", .action = "Check", .probability = 0.664837419987 },
        .{ .combo = "2h2d", .action = "Bet 100 all-in", .probability = 0.335162609816 },
        .{ .combo = "AsQs", .action = "Check", .probability = 0.996544718742 },
        .{ .combo = "AsQs", .action = "Bet 100 all-in", .probability = 0.00345528428443 },
    };

    var page = try inspect.inspectNode(std.testing.allocator, game, published, 0, -1, -1);
    defer page.deinit();
    try std.testing.expectEqual(@as(u8, 2), page.n_actions);

    var worst: f64 = 0;
    for (pins) |pin| {
        var hand_i: ?usize = null;
        for (page.combos, 0..) |combo, i| {
            if (std.mem.eql(u8, combo, pin.combo)) hand_i = i;
        }
        try std.testing.expect(hand_i != null);
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
    // Plan §5.1 strategy abs-diff band ~1e-5–1e-8; tip dig measured ≈2e-8.
    try std.testing.expect(worst <= 1e-7);
}
