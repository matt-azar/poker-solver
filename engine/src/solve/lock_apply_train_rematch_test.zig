//! Frozen CFR train lock-apply rematch vs tip C++ `test_lock_apply.cpp`
//! (`test_street_batch_frozen_solve_honors_locks` + selected / null-identical).
const std = @import("std");
const compile_mod = @import("../game/compile.zig");
const street_config = @import("../game/street_config.zig");
const training_state = @import("training_state.zig");
const frozen_walk = @import("frozen_walk.zig");
const node_lock = @import("node_lock.zig");
const inspect = @import("../analysis/inspect.zig");

fn tinyTurnConfig(allocator: std.mem.Allocator, oop: []const u8, ip: []const u8) !compile_mod.CompiledGame {
    // Mirror C++ tiny_turn_lock_config (pot/stack 1000, oop-turn-bets 1, no all-in).
    const text = try std.fmt.allocPrint(allocator,
        \\street-config 1
        \\board Kh Kd 7c 4s
        \\pot 1000
        \\stack 1000
        \\oop-range {s}
        \\ip-range {s}
        \\oop-turn-bets 1
        \\first-to-act 0
        \\max-raises 1
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 64
        \\threads 1
        \\
    , .{ oop, ip });
    defer allocator.free(text);
    var spec = try street_config.parseStreetConfig(allocator, text);
    defer spec.deinit();
    return compile_mod.compile(allocator, spec);
}

fn actionProb(page: inspect.NodePage, combo: []const u8, action_prefix: []const u8) !f64 {
    var hand_i: ?usize = null;
    for (page.combos, 0..) |c, i| {
        if (std.mem.eql(u8, c, combo)) hand_i = i;
    }
    try std.testing.expect(hand_i != null);
    var action_i: ?usize = null;
    for (page.actions, 0..) |label, i| {
        if (std.mem.startsWith(u8, label, action_prefix)) action_i = i;
    }
    try std.testing.expect(action_i != null);
    return @as(f64, page.strategy[hand_i.? * page.n_actions + action_i.?]);
}

test "frozen CFR+ full-node lock forces always-check at open" {
    // C++ test_street_batch_frozen_solve_honors_locks: lock node 0 → Check=1.
    var game = try tinyTurnConfig(std.testing.allocator, "2c3d", "AhAd");
    defer game.deinit();

    var locks = node_lock.LockSet.init(std.testing.allocator);
    defer locks.deinit();
    const lock = node_lock.NodeLock{
        .infoset_id = 0,
        .kind = .full_node,
        .actions = try node_lock.makeActionLockRow(std.testing.allocator, &.{ 1.0, 0.0 }, 2),
    };
    try locks.upsert(lock);

    var state = try training_state.TrainingState.init(std.testing.allocator, game);
    defer state.deinit();
    var published = try frozen_walk.trainFrozenCfrPlus(std.testing.allocator, game, &state, 10, &locks);
    defer published.deinit();

    var page = try inspect.inspectNode(std.testing.allocator, game, published, 0, -1, -1);
    defer page.deinit();
    try std.testing.expect(page.n_hands >= 1);
    const combo = page.combos[0];
    try std.testing.expectApproxEqAbs(@as(f64, 1.0), try actionProb(page, combo, "Check"), 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, 0.0), try actionProb(page, combo, "Bet"), 1e-12);
}

test "frozen CFR+ selected-combos lock only listed hand" {
    // C++ test_street_batch_selected_combos_only_listed_hand (frozen path).
    var game = try tinyTurnConfig(std.testing.allocator, "2c3d,KcKs", "AhAd");
    defer game.deinit();

    var free_state = try training_state.TrainingState.init(std.testing.allocator, game);
    defer free_state.deinit();
    var free_pub = try frozen_walk.trainFrozenCfrPlus(std.testing.allocator, game, &free_state, 15, null);
    defer free_pub.deinit();
    var free_page = try inspect.inspectNode(std.testing.allocator, game, free_pub, 0, -1, -1);
    defer free_page.deinit();

    var locks = node_lock.LockSet.init(std.testing.allocator);
    defer locks.deinit();
    const indices = try std.testing.allocator.dupe(usize, &.{0});
    const lock = node_lock.NodeLock{
        .infoset_id = 0,
        .kind = .selected_combos,
        .combo_indices = indices,
        .actions = try node_lock.makeActionLockRow(std.testing.allocator, &.{ 0.0, 1.0 }, 2),
    };
    try locks.upsert(lock);

    var locked_state = try training_state.TrainingState.init(std.testing.allocator, game);
    defer locked_state.deinit();
    var locked_pub = try frozen_walk.trainFrozenCfrPlus(std.testing.allocator, game, &locked_state, 15, &locks);
    defer locked_pub.deinit();
    var locked_page = try inspect.inspectNode(std.testing.allocator, game, locked_pub, 0, -1, -1);
    defer locked_page.deinit();

    try std.testing.expect(locked_page.n_hands >= 2);
    const locked_combo = locked_page.combos[0];
    const free_combo = locked_page.combos[1];
    try std.testing.expectApproxEqAbs(@as(f64, 0.0), try actionProb(locked_page, locked_combo, "Check"), 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, 1.0), try actionProb(locked_page, locked_combo, "Bet"), 1e-12);

    try std.testing.expectApproxEqAbs(
        try actionProb(free_page, free_combo, "Check"),
        try actionProb(locked_page, free_combo, "Check"),
        1e-12,
    );
    try std.testing.expectApproxEqAbs(
        try actionProb(free_page, free_combo, "Bet"),
        try actionProb(locked_page, free_combo, "Bet"),
        1e-12,
    );
}

test "frozen CFR+ null locks bit-identical to unlocked empty row" {
    // C++ test_street_batch_null_locks_bit_identical_to_unlocked_row (frozen).
    var game = try tinyTurnConfig(std.testing.allocator, "2c3d", "AhAd");
    defer game.deinit();

    var unlocked = node_lock.LockSet.init(std.testing.allocator);
    defer unlocked.deinit();
    try unlocked.upsert(.{ .infoset_id = 0, .kind = .full_node }); // empty probs

    var with_unlocked = try training_state.TrainingState.init(std.testing.allocator, game);
    defer with_unlocked.deinit();
    var pub_unlocked = try frozen_walk.trainFrozenCfrPlus(std.testing.allocator, game, &with_unlocked, 12, &unlocked);
    defer pub_unlocked.deinit();

    var with_null = try training_state.TrainingState.init(std.testing.allocator, game);
    defer with_null.deinit();
    var pub_null = try frozen_walk.trainFrozenCfrPlus(std.testing.allocator, game, &with_null, 12, null);
    defer pub_null.deinit();

    try std.testing.expectEqual(pub_unlocked.average.len, pub_null.average.len);
    for (pub_unlocked.average, pub_null.average) |a, b| {
        try std.testing.expectEqual(a, b);
    }
}

test "applyLockToStrategyF32 mirrors f64 helper" {
    var probs = [_]f32{ 0.9, 0.1 };
    var lock = node_lock.NodeLock{
        .infoset_id = 0,
        .kind = .full_node,
        .actions = try node_lock.makeActionLockRow(std.testing.allocator, &.{ 0.25, 0.75 }, 2),
    };
    defer lock.deinit(std.testing.allocator);
    try std.testing.expect(try node_lock.applyLockToStrategyF32(probs[0..], &lock, 0));
    try std.testing.expectApproxEqAbs(@as(f64, 0.25), @as(f64, probs[0]), 1e-7);
    try std.testing.expectApproxEqAbs(@as(f64, 0.75), @as(f64, probs[1]), 1e-7);
}
