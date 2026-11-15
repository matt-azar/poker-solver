//! First regression for Pio-style per-combo node locks (bugs 1–3 + board-local unlock).
//! Two combos, opposite pure actions, on each of two rivers:
//! lock the line → unlock one combo on one river → warm-start publish + save/reopen.
const std = @import("std");
const compile_mod = @import("../game/compile.zig");
const street_config = @import("../game/street_config.zig");
const training_state = @import("training_state.zig");
const frozen_walk = @import("frozen_walk.zig");
const node_lock = @import("node_lock.zig");
const inspect = @import("../analysis/inspect.zig");

const river_a: i32 = 20; // 7c
const river_b: i32 = 21; // 7d

fn tinyTwoRiverConfig(allocator: std.mem.Allocator) !compile_mod.CompiledGame {
    // Turn board; chance deals river. Two disjoint hole combos.
    const text =
        \\street-config 1
        \\board Ah Kh Qh Jh
        \\pot 100
        \\stack 100
        \\oop-range AsQs:1,2d2h:1
        \\ip-range AsQs:1,2d2h:1
        \\oop-river-bets 1
        \\first-to-act 0
        \\max-raises 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 64
        \\threads 1
        \\
    ;
    var spec = try street_config.parseStreetConfig(allocator, text);
    defer spec.deinit();
    return compile_mod.compile(allocator, spec);
}

fn actionIndex(page: inspect.NodePage, prefix: []const u8) !usize {
    for (page.actions, 0..) |label, i| {
        if (std.mem.startsWith(u8, label, prefix)) return i;
    }
    return error.TestUnexpectedResult;
}

fn handStrategy(page: inspect.NodePage, hand: usize) []const f32 {
    const n: usize = page.n_actions;
    return page.strategy[hand * n ..][0..n];
}

fn expectPure(page: inspect.NodePage, hand: usize, want_check: bool) !void {
    const check_i = try actionIndex(page, "Check");
    const bet_i = try actionIndex(page, "Bet");
    const row = handStrategy(page, hand);
    if (want_check) {
        try std.testing.expectApproxEqAbs(@as(f64, 1.0), @as(f64, row[check_i]), 1e-5);
        try std.testing.expectApproxEqAbs(@as(f64, 0.0), @as(f64, row[bet_i]), 1e-5);
    } else {
        try std.testing.expectApproxEqAbs(@as(f64, 0.0), @as(f64, row[check_i]), 1e-5);
        try std.testing.expectApproxEqAbs(@as(f64, 1.0), @as(f64, row[bet_i]), 1e-5);
    }
}

fn makePerComboLineLock(allocator: std.mem.Allocator, infoset: usize) !node_lock.NodeLock {
    const indices = try allocator.dupe(usize, &.{ 0, 1 });
    errdefer allocator.free(indices);
    const rows = [_][]const f64{
        &.{ 1.0, 0.0 }, // combo 0: Check
        &.{ 0.0, 1.0 }, // combo 1: Bet
    };
    return .{
        .infoset_id = infoset,
        .scope = .line,
        .turn = -1,
        .river = -1,
        .kind = .selected_combos,
        .combo_indices = indices,
        .combo_actions = try node_lock.makeComboActionRows(allocator, indices, &rows, 2),
    };
}

fn makeRiverOverrideKeepCombo1(allocator: std.mem.Allocator, infoset: usize, river: i32) !node_lock.NodeLock {
    // Unlock combo 0 on this river: keep only combo 1 locked to Bet.
    const indices = try allocator.dupe(usize, &.{1});
    errdefer allocator.free(indices);
    const rows = [_][]const f64{&.{ 0.0, 1.0 }};
    return .{
        .infoset_id = infoset,
        .scope = .node,
        .turn = -1,
        .river = @intCast(river),
        .kind = .selected_combos,
        .combo_indices = indices,
        .combo_actions = try node_lock.makeComboActionRows(allocator, indices, &rows, 2),
    };
}

test "per-combo line lock: warm-start publish + unlock board-local + constrained Accuracy" {
    const allocator = std.testing.allocator;
    var game = try tinyTwoRiverConfig(allocator);
    defer game.deinit();
    try std.testing.expect(game.nodes.len > 0);
    try std.testing.expectEqual(@as(i32, 2), game.hands.nHands(0));

    // Root should be a chance (deal river) or decision; find first OOP decision infoset.
    var root_decision: usize = 0;
    for (game.nodes, 0..) |node, i| {
        if (node.kind == .decision and node.player == 0 and node.n_actions >= 2) {
            root_decision = i;
            break;
        }
    }

    var locks = node_lock.LockSet.init(allocator);
    defer locks.deinit();
    try locks.upsert(try makePerComboLineLock(allocator, root_decision));
    try locks.upsert(try makeRiverOverrideKeepCombo1(allocator, root_decision, river_a));

    // Effective mask: river_a combo0 free, combo1 locked Bet; river_b both locked.
    try std.testing.expect(!node_lock.comboIsLocked(locks.findForRunout(root_decision, -1, river_a).?.*, 0));
    try std.testing.expect(node_lock.comboIsLocked(locks.findForRunout(root_decision, -1, river_a).?.*, 1));
    try std.testing.expect(node_lock.comboIsLocked(locks.findForRunout(root_decision, -1, river_b).?.*, 0));
    try std.testing.expect(node_lock.comboIsLocked(locks.findForRunout(root_decision, -1, river_b).?.*, 1));

    // Warm-start pollution: strategy_sum prefers the opposite of each lock.
    var state = try training_state.TrainingState.init(allocator, game);
    defer state.deinit();
    for (game.slots) |slot| {
        if (slot.node != root_decision) continue;
        const n: usize = game.nodes[@intCast(slot.node)].n_actions;
        const base: usize = @intCast(slot.base);
        // Mass on the forbidden action so normalizeAverage would violate the lock.
        if (slot.hand == 0) {
            state.strategy_sum[base + 0] = 0.0;
            state.strategy_sum[base + 1] = 10.0; // would publish Bet
        } else {
            state.strategy_sum[base + 0] = 10.0; // would publish Check
            state.strategy_sum[base + 1] = 0.0;
        }
        _ = n;
    }
    state.trained = 5;

    var published = try training_state.publishAverageThreaded(allocator, game, &state, 1, &locks);
    defer published.deinit();

    var page_a = try inspect.inspectNode(allocator, game, published, @intCast(root_decision), -1, river_a);
    defer page_a.deinit();
    var page_b = try inspect.inspectNode(allocator, game, published, @intCast(root_decision), -1, river_b);
    defer page_b.deinit();
    try std.testing.expect(page_a.n_hands >= 2);
    try std.testing.expect(page_b.n_hands >= 2);

    // river_a: combo0 free (polluted Bet may show); combo1 locked Bet.
    try expectPure(page_a, 1, false);
    // river_b: both locked — combo0 Check, combo1 Bet (not the polluted mixes).
    try expectPure(page_b, 0, true);
    try expectPure(page_b, 1, false);

    // Save/reopen lock text preserves per-combo rows.
    const text = try node_lock.formatLockSet(allocator, &locks);
    defer allocator.free(text);
    try std.testing.expect(std.mem.indexOf(u8, text, "combo_probs") != null);
    var round = try node_lock.parseLockSet(allocator, text);
    defer round.deinit();
    try std.testing.expectEqual(@as(usize, 2), round.size());
    try std.testing.expectEqual(@as(f64, 1.0), node_lock.lockedProbability(round.find(root_decision).?.*, 0, 0).?);
    try std.testing.expectEqual(@as(f64, 1.0), node_lock.lockedProbability(round.find(root_decision).?.*, 1, 1).?);
    try std.testing.expect(node_lock.lockedProbability(round.findExact(root_decision, -1, river_a).?.*, 0, 0) == null);

    // Zero-reach publish: locked rows must not fall back to uniform.
    @memset(state.strategy_sum, 0);
    var zero_pub = try training_state.publishAverageThreaded(allocator, game, &state, 1, &locks);
    defer zero_pub.deinit();
    var zero_b = try inspect.inspectNode(allocator, game, zero_pub, @intCast(root_decision), -1, river_b);
    defer zero_b.deinit();
    try expectPure(zero_b, 0, true);
    try expectPure(zero_b, 1, false);

    // Constrained Accuracy: BR must not credit forbidden deviations on locked rows.
    var ctx = try frozen_walk.FrozenCtx.initEvalThreaded(allocator, game, 1);
    defer ctx.deinit();
    ctx.locks = &locks;
    const constrained = try frozen_walk.evaluatePublishedFrozenOnCtx(&ctx, published.average);
    ctx.locks = null;
    const unconstrained = try frozen_walk.evaluatePublishedFrozenOnCtx(&ctx, published.average);
    // With locks, forbidden pure deviations are ignored → gap ≤ unconstrained.
    try std.testing.expect(constrained.nash_gap <= unconstrained.nash_gap + 1e-9);
    // Locked equilibrium on river_b rows: unconstrained BR can still want to deviate
    // from the polluted free row / locked constraints, so the constrained gap should
    // drop whenever a locked combo would otherwise BR away from its mix.
    if (unconstrained.nash_gap > 1e-6) {
        try std.testing.expect(constrained.nash_gap < unconstrained.nash_gap - 1e-12 or constrained.accuracy <= unconstrained.accuracy);
    }

    // Warm-start train under locks then re-inspect: three locked rows keep mixes;
    // unlocked combo0 on river_a may adapt.
    var train_state = try training_state.TrainingState.init(allocator, game);
    defer train_state.deinit();
    // Seed strategy_sum from the locked published policy (warm-start).
    @memcpy(train_state.strategy_sum, published.average);
    for (train_state.strategy_sum) |*s| s.* *= 5.0;
    var after = try frozen_walk.trainFrozenCfrPlus(allocator, game, &train_state, 8, &locks);
    defer after.deinit();

    var after_a = try inspect.inspectNode(allocator, game, after, @intCast(root_decision), -1, river_a);
    defer after_a.deinit();
    var after_b = try inspect.inspectNode(allocator, game, after, @intCast(root_decision), -1, river_b);
    defer after_b.deinit();
    try expectPure(after_a, 1, false);
    try expectPure(after_b, 0, true);
    try expectPure(after_b, 1, false);
}

test "per-combo applyLockToStrategy uses each combo row" {
    const allocator = std.testing.allocator;
    const indices = try allocator.dupe(usize, &.{ 0, 1 });
    var lock = node_lock.NodeLock{
        .infoset_id = 0,
        .kind = .selected_combos,
        .combo_indices = indices,
        .combo_actions = try node_lock.makeComboActionRows(allocator, indices, &.{ &.{ 1.0, 0.0 }, &.{ 0.0, 1.0 } }, 2),
    };
    defer lock.deinit(allocator);

    var row0 = [_]f64{ 0.5, 0.5 };
    var row1 = [_]f64{ 0.5, 0.5 };
    var row2 = [_]f64{ 0.5, 0.5 };
    try std.testing.expect(try node_lock.applyLockToStrategy(row0[0..], &lock, 0));
    try std.testing.expectEqual(@as(f64, 1.0), row0[0]);
    try std.testing.expect(try node_lock.applyLockToStrategy(row1[0..], &lock, 1));
    try std.testing.expectEqual(@as(f64, 1.0), row1[1]);
    try std.testing.expect(!(try node_lock.applyLockToStrategy(row2[0..], &lock, 2)));
    try std.testing.expectEqual(@as(f64, 0.5), row2[0]);
}
