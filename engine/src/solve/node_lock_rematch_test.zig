//! Durable Zig pins vs tip C++ `tests/unit/test_node_lock.cpp` +
//! `apply_lock_to_strategy` units from `test_lock_apply.cpp`.
//! CFR StreetBatch lock-honoring walks remain deferred (residual Study UX).
const std = @import("std");
const node_lock = @import("node_lock.zig");

test "validate action row accepts and rejects" {
    try std.testing.expect(node_lock.validateActionRow(&.{}, 0));
    try std.testing.expect(node_lock.validateActionRow(&.{}, 3));
    try std.testing.expect(node_lock.validateActionRow(&.{ 0.5, 0.5 }, 2));
    try std.testing.expect(node_lock.validateActionRow(&.{ 1.0, 0.0, 0.0 }, 3));
    try std.testing.expect(node_lock.validateActionRow(&.{ 0.333333333333, 0.333333333333, 0.333333333334 }, 3));

    try std.testing.expect(!node_lock.validateActionRow(&.{ 0.5, 0.5 }, 3));
    try std.testing.expect(!node_lock.validateActionRow(&.{ 1.2, -0.2 }, 2));
    try std.testing.expect(!node_lock.validateActionRow(&.{ 0.5, std.math.nan(f64) }, 2));
    try std.testing.expect(!node_lock.validateActionRow(&.{ 0.5, std.math.inf(f64) }, 2));
    try std.testing.expect(!node_lock.validateActionRow(&.{ 0.4, 0.4 }, 2));
    try std.testing.expect(!node_lock.validateActionRow(&.{ 0.6, 0.6 }, 2));

    try std.testing.expectError(error.InvalidLockRow, node_lock.makeActionLockRow(std.testing.allocator, &.{ 0.4, 0.4 }, 2));
}

test "full node vs selected combos locked_probability" {
    var full = node_lock.NodeLock{
        .infoset_id = 7,
        .kind = .full_node,
        .actions = try node_lock.makeActionLockRow(std.testing.allocator, &.{ 0.25, 0.75 }, 2),
    };
    defer full.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(f64, 0.25), node_lock.lockedProbability(full, 0, 0).?);
    try std.testing.expectEqual(@as(f64, 0.75), node_lock.lockedProbability(full, 99, 1).?);
    try std.testing.expect(node_lock.lockedProbability(full, 0, 2) == null);

    var selected = node_lock.NodeLock{
        .infoset_id = 7,
        .kind = .selected_combos,
        .combo_indices = try std.testing.allocator.dupe(usize, &.{ 3, 5 }),
        .actions = try node_lock.makeActionLockRow(std.testing.allocator, &.{ 0.25, 0.75 }, 2),
    };
    defer selected.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(f64, 0.25), node_lock.lockedProbability(selected, 3, 0).?);
    try std.testing.expectEqual(@as(f64, 0.75), node_lock.lockedProbability(selected, 5, 1).?);
    try std.testing.expect(node_lock.lockedProbability(selected, 4, 0) == null);
    try std.testing.expect(node_lock.lockedProbability(selected, 0, 1) == null);
}

test "unlocked distinct from zero-probability lock" {
    var unlocked = node_lock.NodeLock{ .infoset_id = 1, .kind = .full_node };
    defer unlocked.deinit(std.testing.allocator);
    try std.testing.expect(unlocked.actions.unlocked());
    try std.testing.expect(node_lock.lockedProbability(unlocked, 0, 0) == null);

    var zero_lock = node_lock.NodeLock{
        .infoset_id = 1,
        .kind = .full_node,
        .actions = try node_lock.makeActionLockRow(std.testing.allocator, &.{ 0.0, 1.0 }, 2),
    };
    defer zero_lock.deinit(std.testing.allocator);
    try std.testing.expect(!zero_lock.actions.unlocked());
    try std.testing.expectEqual(@as(f64, 0.0), node_lock.lockedProbability(zero_lock, 0, 0).?);
    try std.testing.expectEqual(@as(f64, 1.0), node_lock.lockedProbability(zero_lock, 0, 1).?);

    var selected_empty = node_lock.NodeLock{
        .infoset_id = 2,
        .kind = .selected_combos,
        .actions = try node_lock.makeActionLockRow(std.testing.allocator, &.{ 0.0, 1.0 }, 2),
    };
    defer selected_empty.deinit(std.testing.allocator);
    try std.testing.expect(node_lock.lockedProbability(selected_empty, 0, 0) == null);
}

test "lock set upsert erase and runout vs line lookup" {
    var locks = node_lock.LockSet.init(std.testing.allocator);
    defer locks.deinit();
    try std.testing.expect(locks.empty());

    const a = node_lock.NodeLock{
        .infoset_id = 10,
        .kind = .full_node,
        .scope = .line,
        .actions = try node_lock.makeActionLockRow(std.testing.allocator, &.{ 1.0, 0.0 }, 2),
    };
    try locks.upsert(a);
    try std.testing.expectEqual(@as(usize, 1), locks.size());
    try std.testing.expectEqual(@as(f64, 1.0), locks.find(10).?.actions.probs[0]);

    const b = node_lock.NodeLock{
        .infoset_id = 10,
        .kind = .full_node,
        .scope = .line,
        .actions = try node_lock.makeActionLockRow(std.testing.allocator, &.{ 0.0, 1.0 }, 2),
    };
    try locks.upsert(b);
    try std.testing.expectEqual(@as(usize, 1), locks.size());
    try std.testing.expectEqual(@as(f64, 0.0), locks.find(10).?.actions.probs[0]);

    const c = node_lock.NodeLock{
        .infoset_id = 11,
        .kind = .selected_combos,
        .scope = .line,
        .combo_indices = try std.testing.allocator.dupe(usize, &.{1}),
        .actions = try node_lock.makeActionLockRow(std.testing.allocator, &.{ 1.0, 0.0 }, 2),
    };
    try locks.upsert(c);
    try std.testing.expectEqual(@as(usize, 2), locks.size());
    try std.testing.expect(locks.erase(10));
    try std.testing.expectEqual(@as(usize, 1), locks.size());
    try std.testing.expect(locks.find(10) == null);
    try std.testing.expect(locks.find(11) != null);
    try std.testing.expect(!locks.erase(10));
    locks.clear();
    try std.testing.expect(locks.empty());

    const node = node_lock.NodeLock{
        .infoset_id = 12,
        .turn = -1,
        .river = 7,
        .scope = .node,
        .kind = .full_node,
        .actions = try node_lock.makeActionLockRow(std.testing.allocator, &.{ 1.0, 0.0 }, 2),
    };
    try locks.upsert(node);
    const line = node_lock.NodeLock{
        .infoset_id = 12,
        .scope = .line,
        .kind = .full_node,
        .actions = try node_lock.makeActionLockRow(std.testing.allocator, &.{ 0.0, 1.0 }, 2),
    };
    try locks.upsert(line);
    try std.testing.expectEqual(@as(usize, 2), locks.size());
    try std.testing.expectEqual(@as(f64, 0.0), locks.find(12).?.actions.probs[0]);
    try std.testing.expectEqual(@as(f64, 1.0), locks.findExact(12, -1, 7).?.actions.probs[0]);
    try std.testing.expectEqual(@as(f64, 1.0), locks.findForRunout(12, -1, 7).?.actions.probs[0]);
    try std.testing.expectEqual(@as(f64, 0.0), locks.findForRunout(12, -1, 9).?.actions.probs[0]);
    try std.testing.expect(locks.eraseExact(12, -1, 7));
    try std.testing.expectEqual(@as(usize, 1), locks.size());
    try std.testing.expectEqual(@as(f64, 0.0), locks.findForRunout(12, -1, 7).?.actions.probs[0]);
}

test "text round trip node line selected unlocked legacy" {
    const allocator = std.testing.allocator;
    var full = node_lock.NodeLock{
        .infoset_id = 42,
        .kind = .full_node,
        .scope = .node,
        .actions = try node_lock.makeActionLockRow(allocator, &.{ 0.2, 0.3, 0.5 }, 3),
    };
    defer full.deinit(allocator);
    const full_line = try node_lock.formatNodeLock(allocator, full);
    defer allocator.free(full_line);
    var full_back = try node_lock.parseNodeLock(allocator, full_line);
    defer full_back.deinit(allocator);
    try std.testing.expectEqual(@as(usize, 42), full_back.infoset_id);
    try std.testing.expect(full_back.kind == .full_node);
    try std.testing.expect(full_back.scope == .node);
    try std.testing.expect(!full_back.isLine());
    try std.testing.expectEqual(@as(i8, -1), full_back.turn);
    try std.testing.expectEqual(@as(i8, -1), full_back.river);
    try std.testing.expectEqual(@as(usize, 3), full_back.actions.probs.len);
    try std.testing.expectApproxEqAbs(@as(f64, 0.2), full_back.actions.probs[0], 1e-15);
    try std.testing.expectApproxEqAbs(@as(f64, 0.3), full_back.actions.probs[1], 1e-15);
    try std.testing.expectApproxEqAbs(@as(f64, 0.5), full_back.actions.probs[2], 1e-15);

    var selected = node_lock.NodeLock{
        .infoset_id = 9,
        .kind = .selected_combos,
        .scope = .node,
        .combo_indices = try allocator.dupe(usize, &.{ 0, 4, 7 }),
        .actions = try node_lock.makeActionLockRow(allocator, &.{ 0.2, 0.3, 0.5 }, 3),
    };
    defer selected.deinit(allocator);
    const selected_line = try node_lock.formatNodeLock(allocator, selected);
    defer allocator.free(selected_line);
    var selected_back = try node_lock.parseNodeLock(allocator, selected_line);
    defer selected_back.deinit(allocator);
    try std.testing.expectEqual(@as(usize, 9), selected_back.infoset_id);
    try std.testing.expect(selected_back.kind == .selected_combos);
    try std.testing.expectEqual(@as(usize, 3), selected_back.combo_indices.len);
    try std.testing.expectEqual(@as(usize, 0), selected_back.combo_indices[0]);
    try std.testing.expectEqual(@as(usize, 4), selected_back.combo_indices[1]);
    try std.testing.expectEqual(@as(usize, 7), selected_back.combo_indices[2]);

    var unlocked = node_lock.NodeLock{ .infoset_id = 3, .kind = .full_node, .scope = .node };
    defer unlocked.deinit(allocator);
    const unlocked_line = try node_lock.formatNodeLock(allocator, unlocked);
    defer allocator.free(unlocked_line);
    var unlocked_back = try node_lock.parseNodeLock(allocator, unlocked_line);
    defer unlocked_back.deinit(allocator);
    try std.testing.expect(unlocked_back.actions.unlocked());

    var runout = node_lock.NodeLock{
        .infoset_id = 12,
        .turn = -1,
        .river = 7,
        .scope = .node,
        .kind = .full_node,
        .actions = try node_lock.makeActionLockRow(allocator, &.{ 0.2, 0.3, 0.5 }, 3),
    };
    defer runout.deinit(allocator);
    const runout_line = try node_lock.formatNodeLock(allocator, runout);
    defer allocator.free(runout_line);
    try std.testing.expect(std.mem.indexOf(u8, runout_line, " at -1 7 ") != null);
    var runout_back = try node_lock.parseNodeLock(allocator, runout_line);
    defer runout_back.deinit(allocator);
    try std.testing.expectEqual(@as(i8, -1), runout_back.turn);
    try std.testing.expectEqual(@as(i8, 7), runout_back.river);
    try std.testing.expect(runout_back.scope == .node);

    var explicit_line = node_lock.NodeLock{
        .infoset_id = 8,
        .scope = .line,
        .kind = .full_node,
        .actions = try node_lock.makeActionLockRow(allocator, &.{ 0.2, 0.3, 0.5 }, 3),
    };
    defer explicit_line.deinit(allocator);
    const line_text = try node_lock.formatNodeLock(allocator, explicit_line);
    defer allocator.free(line_text);
    var line_back = try node_lock.parseNodeLock(allocator, line_text);
    defer line_back.deinit(allocator);
    try std.testing.expect(line_back.isLine());

    var legacy = try node_lock.parseNodeLock(allocator, "lock 5 full probs 1 0");
    defer legacy.deinit(allocator);
    try std.testing.expect(legacy.isLine());
    try std.testing.expectEqual(@as(usize, 5), legacy.infoset_id);

    var set = node_lock.LockSet.init(allocator);
    defer set.deinit();
    // Move ownership of copies into the set.
    const full2 = node_lock.NodeLock{
        .infoset_id = 42,
        .kind = .full_node,
        .scope = .node,
        .actions = try node_lock.makeActionLockRow(allocator, &.{ 0.2, 0.3, 0.5 }, 3),
    };
    try set.upsert(full2);
    const selected2 = node_lock.NodeLock{
        .infoset_id = 9,
        .kind = .selected_combos,
        .scope = .node,
        .combo_indices = try allocator.dupe(usize, &.{ 0, 4, 7 }),
        .actions = try node_lock.makeActionLockRow(allocator, &.{ 0.2, 0.3, 0.5 }, 3),
    };
    try set.upsert(selected2);
    const runout2 = node_lock.NodeLock{
        .infoset_id = 12,
        .turn = -1,
        .river = 7,
        .scope = .node,
        .kind = .full_node,
        .actions = try node_lock.makeActionLockRow(allocator, &.{ 0.2, 0.3, 0.5 }, 3),
    };
    try set.upsert(runout2);
    const text = try node_lock.formatLockSet(allocator, &set);
    defer allocator.free(text);
    var round = try node_lock.parseLockSet(allocator, text);
    defer round.deinit();
    try std.testing.expectEqual(@as(usize, 3), round.size());
    try std.testing.expect(round.find(42) != null);
    try std.testing.expect(round.find(9) != null);
    try std.testing.expect(round.findExact(12, -1, 7) != null);
    try std.testing.expectEqual(@as(f64, 0.5), node_lock.lockedProbability(round.find(9).?.*, 4, 2).?);
    try std.testing.expect(node_lock.lockedProbability(round.find(9).?.*, 1, 2) == null);
}

test "erase combo shrinks then removes selected lock" {
    var set = node_lock.LockSet.init(std.testing.allocator);
    defer set.deinit();
    const selected = node_lock.NodeLock{
        .infoset_id = 3,
        .kind = .selected_combos,
        .scope = .line,
        .combo_indices = try std.testing.allocator.dupe(usize, &.{ 1, 4, 7 }),
        .actions = try node_lock.makeActionLockRow(std.testing.allocator, &.{ 0.25, 0.75 }, 2),
    };
    try set.upsert(selected);
    try std.testing.expect(set.eraseCombo(3, 4));
    try std.testing.expectEqual(@as(usize, 2), set.find(3).?.combo_indices.len);
    try std.testing.expectEqual(@as(usize, 1), set.find(3).?.combo_indices[0]);
    try std.testing.expectEqual(@as(usize, 7), set.find(3).?.combo_indices[1]);
    try std.testing.expect(!set.eraseCombo(3, 4));
    try std.testing.expect(set.eraseCombo(3, 1));
    try std.testing.expect(set.eraseCombo(3, 7));
    try std.testing.expect(set.find(3) == null);

    const full = node_lock.NodeLock{
        .infoset_id = 8,
        .kind = .full_node,
        .scope = .line,
        .actions = try node_lock.makeActionLockRow(std.testing.allocator, &.{ 0.25, 0.75 }, 2),
    };
    try set.upsert(full);
    try std.testing.expect(!set.eraseCombo(8, 0));
    try std.testing.expect(set.find(8) != null);
}

test "applyLockToStrategy full selected unlocked zero" {
    var full = node_lock.NodeLock{
        .infoset_id = 0,
        .kind = .full_node,
        .actions = try node_lock.makeActionLockRow(std.testing.allocator, &.{ 0.25, 0.75 }, 2),
    };
    defer full.deinit(std.testing.allocator);
    var probs = [_]f64{ 1.0, 0.0 };
    try std.testing.expect(try node_lock.applyLockToStrategy(probs[0..], &full, 0));
    try std.testing.expectApproxEqAbs(@as(f64, 0.25), probs[0], 1e-15);
    try std.testing.expectApproxEqAbs(@as(f64, 0.75), probs[1], 1e-15);
    var again = [_]f64{ 1.0, 0.0 };
    try std.testing.expect(try node_lock.applyLockToStrategy(again[0..], &full, 99));
    try std.testing.expectApproxEqAbs(@as(f64, 0.25), again[0], 1e-15);

    var selected = node_lock.NodeLock{
        .infoset_id = 0,
        .kind = .selected_combos,
        .combo_indices = try std.testing.allocator.dupe(usize, &.{ 2, 7 }),
        .actions = try node_lock.makeActionLockRow(std.testing.allocator, &.{ 0.0, 1.0 }, 2),
    };
    defer selected.deinit(std.testing.allocator);
    var listed = [_]f64{ 0.6, 0.4 };
    try std.testing.expect(try node_lock.applyLockToStrategy(listed[0..], &selected, 2));
    try std.testing.expectEqual(@as(f64, 0.0), listed[0]);
    try std.testing.expectEqual(@as(f64, 1.0), listed[1]);
    var other = [_]f64{ 0.6, 0.4 };
    try std.testing.expect(!(try node_lock.applyLockToStrategy(other[0..], &selected, 1)));
    try std.testing.expectEqual(@as(f64, 0.6), other[0]);

    var noop = [_]f64{ 0.3, 0.7 };
    try std.testing.expect(!(try node_lock.applyLockToStrategy(noop[0..], null, 0)));
    var unlocked = node_lock.NodeLock{ .infoset_id = 0, .kind = .full_node };
    defer unlocked.deinit(std.testing.allocator);
    try std.testing.expect(!(try node_lock.applyLockToStrategy(noop[0..], &unlocked, 0)));
    try std.testing.expectEqual(@as(f64, 0.3), noop[0]);

    var zero = node_lock.NodeLock{
        .infoset_id = 0,
        .kind = .full_node,
        .actions = try node_lock.makeActionLockRow(std.testing.allocator, &.{ 0.0, 1.0 }, 2),
    };
    defer zero.deinit(std.testing.allocator);
    var zprobs = [_]f64{ 0.5, 0.5 };
    try std.testing.expect(try node_lock.applyLockToStrategy(zprobs[0..], &zero, 0));
    try std.testing.expectEqual(@as(f64, 0.0), zprobs[0]);
    try std.testing.expectEqual(@as(f64, 1.0), zprobs[1]);
}
