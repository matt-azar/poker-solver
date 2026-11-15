//! Bug 4 regressions: merge masks, unlock-selected on full-node, line vs
//! selected shadowing, multi-runout unlock isolation, scoped keys at -1/-1.
const std = @import("std");
const node_lock = @import("node_lock.zig");

const river_a: i32 = 7;
const river_b: i32 = 9;

fn selectedPerCombo(
    allocator: std.mem.Allocator,
    infoset: usize,
    scope: node_lock.LockScope,
    turn: i32,
    river: i32,
    indices: []const usize,
    rows: []const []const f64,
) !node_lock.NodeLock {
    const owned = try allocator.dupe(usize, indices);
    errdefer allocator.free(owned);
    return .{
        .infoset_id = infoset,
        .scope = scope,
        .turn = @intCast(turn),
        .river = @intCast(river),
        .kind = .selected_combos,
        .combo_indices = owned,
        .combo_actions = try node_lock.makeComboActionRows(allocator, owned, rows, 2),
    };
}

test "mergeUpsert locking A then B keeps A" {
    const allocator = std.testing.allocator;
    var set = node_lock.LockSet.init(allocator);
    defer set.deinit();

    try set.mergeUpsert(try selectedPerCombo(
        allocator,
        0,
        .node,
        -1,
        river_a,
        &.{0},
        &.{&.{ 1.0, 0.0 }},
    ));
    try set.mergeUpsert(try selectedPerCombo(
        allocator,
        0,
        .node,
        -1,
        river_a,
        &.{1},
        &.{&.{ 0.0, 1.0 }},
    ));
    try std.testing.expectEqual(@as(usize, 1), set.size());
    const lock = set.findExact(0, -1, river_a).?;
    try std.testing.expectEqual(@as(usize, 2), lock.combo_indices.len);
    try std.testing.expectEqual(@as(f64, 1.0), node_lock.lockedProbability(lock.*, 0, 0).?);
    try std.testing.expectEqual(@as(f64, 1.0), node_lock.lockedProbability(lock.*, 1, 1).?);
}

test "unlock selected works on full-node shared lock" {
    const allocator = std.testing.allocator;
    var set = node_lock.LockSet.init(allocator);
    defer set.deinit();
    try set.upsert(.{
        .infoset_id = 3,
        .scope = .node,
        .turn = -1,
        .river = river_a,
        .kind = .full_node,
        .actions = try node_lock.makeActionLockRow(allocator, &.{ 0.25, 0.75 }, 2),
    });
    try std.testing.expect(set.eraseComboKey(node_lock.makeLockKey(3, -1, river_a), 1, 3));
    const lock = set.findExact(3, -1, river_a).?;
    try std.testing.expect(lock.kind == .selected_combos);
    try std.testing.expect(node_lock.comboIsLocked(lock.*, 0));
    try std.testing.expect(!node_lock.comboIsLocked(lock.*, 1));
    try std.testing.expect(node_lock.comboIsLocked(lock.*, 2));
    try std.testing.expectEqual(@as(f64, 0.25), node_lock.lockedProbability(lock.*, 0, 0).?);
}

test "selected put on one river materializes line so other combos stay locked" {
    const allocator = std.testing.allocator;
    var set = node_lock.LockSet.init(allocator);
    defer set.deinit();

    // Line locks combos 0 and 1.
    try set.upsert(try selectedPerCombo(
        allocator,
        5,
        .line,
        -1,
        -1,
        &.{ 0, 1 },
        &.{ &.{ 1.0, 0.0 }, &.{ 0.0, 1.0 } },
    ));

    // Simulate host put: materialize line onto river_a, then merge selected combo 0 only.
    const base = try node_lock.materializeNodeFromLine(allocator, set.find(5).?.*, -1, river_a, 2);
    try set.upsert(base);
    try set.mergeUpsert(try selectedPerCombo(
        allocator,
        5,
        .node,
        -1,
        river_a,
        &.{0},
        &.{&.{ 0.5, 0.5 }},
    ));

    const on_a = set.findForRunout(5, -1, river_a).?;
    try std.testing.expectEqual(@as(f64, 0.5), node_lock.lockedProbability(on_a.*, 0, 0).?);
    // Combo 1 still locked from materialized line — not freed by selected shadow.
    try std.testing.expectEqual(@as(f64, 1.0), node_lock.lockedProbability(on_a.*, 1, 1).?);

    // Other river still uses the line record.
    const on_b = set.findForRunout(5, -1, river_b).?;
    try std.testing.expect(on_b.isLine());
    try std.testing.expectEqual(@as(f64, 1.0), node_lock.lockedProbability(on_b.*, 0, 0).?);
}

test "unlock combo on one river does not mutate line for other runouts" {
    const allocator = std.testing.allocator;
    var set = node_lock.LockSet.init(allocator);
    defer set.deinit();

    try set.upsert(try selectedPerCombo(
        allocator,
        8,
        .line,
        -1,
        -1,
        &.{ 0, 1 },
        &.{ &.{ 1.0, 0.0 }, &.{ 0.0, 1.0 } },
    ));

    const base = try node_lock.materializeNodeFromLine(allocator, set.find(8).?.*, -1, river_a, 2);
    try set.upsert(base);
    try std.testing.expect(set.eraseComboKey(node_lock.makeLockKey(8, -1, river_a), 0, 2));

    // river_a: combo 0 free, combo 1 locked.
    const on_a = set.findForRunout(8, -1, river_a).?;
    try std.testing.expect(!node_lock.comboIsLocked(on_a.*, 0));
    try std.testing.expect(node_lock.comboIsLocked(on_a.*, 1));

    // Line untouched — river_b still locks both.
    const line = set.find(8).?;
    try std.testing.expectEqual(@as(usize, 2), line.combo_indices.len);
    const on_b = set.findForRunout(8, -1, river_b).?;
    try std.testing.expect(node_lock.comboIsLocked(on_b.*, 0));
    try std.testing.expect(node_lock.comboIsLocked(on_b.*, 1));
}

test "node and line records at t-1 r-1 are distinct keys" {
    const allocator = std.testing.allocator;
    var set = node_lock.LockSet.init(allocator);
    defer set.deinit();

    try set.upsert(.{
        .infoset_id = 0,
        .scope = .line,
        .turn = -1,
        .river = -1,
        .kind = .full_node,
        .actions = try node_lock.makeActionLockRow(allocator, &.{ 1.0, 0.0 }, 2),
    });
    try set.upsert(.{
        .infoset_id = 0,
        .scope = .node,
        .turn = -1,
        .river = -1,
        .kind = .full_node,
        .actions = try node_lock.makeActionLockRow(allocator, &.{ 0.0, 1.0 }, 2),
    });
    try std.testing.expectEqual(@as(usize, 2), set.size());
    try std.testing.expectEqual(@as(f64, 1.0), set.find(0).?.actions.probs[0]);
    try std.testing.expectEqual(@as(f64, 0.0), set.findExact(0, -1, -1).?.actions.probs[0]);
    // Flop-root runout prefers node scope.
    try std.testing.expectEqual(@as(f64, 0.0), set.findForRunout(0, -1, -1).?.actions.probs[0]);
}

test "unlock-all node sentinel clears board without deleting line" {
    const allocator = std.testing.allocator;
    var set = node_lock.LockSet.init(allocator);
    defer set.deinit();

    try set.upsert(try selectedPerCombo(
        allocator,
        2,
        .line,
        -1,
        -1,
        &.{0},
        &.{&.{ 1.0, 0.0 }},
    ));
    try set.upsert(.{
        .infoset_id = 2,
        .scope = .node,
        .turn = -1,
        .river = river_a,
        .kind = .full_node,
    });
    try std.testing.expectEqual(@as(usize, 2), set.size());
    const on_a = set.findForRunout(2, -1, river_a).?;
    try std.testing.expect(on_a.isUnlockAllSentinel());
    try std.testing.expect(!node_lock.comboIsLocked(on_a.*, 0));
    try std.testing.expect(node_lock.comboIsLocked(set.findForRunout(2, -1, river_b).?.*, 0));
}
