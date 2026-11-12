const std = @import("std");
const compile = @import("../game/compile.zig");
const payoff = @import("../poker/payoff.zig");
const kernel = @import("../kernel/terminal.zig");
const traversal = @import("../solve/traversal.zig");
const training_state = @import("../solve/training_state.zig");
const evaluation = @import("evaluation.zig");

pub const BrError = error{ InvalidAnalysis, OutOfMemory };

fn nodeDepth(game: compile.CompiledGame, node_index: i32) i32 {
    var depth: i32 = 0;
    var at = node_index;
    while (at >= 0) {
        const parent = game.nodes[@intCast(at)].parent;
        if (parent < 0) break;
        depth += 1;
        at = parent;
        if (depth > 64) break;
    }
    return depth;
}

fn fillStrategyRow(
    average: []const f32,
    br_action: []const i32,
    responding: i32,
    slot_index: usize,
    node_player: i32,
    base: usize,
    n: usize,
    out: []f32,
) void {
    if (node_player == responding) {
        const chosen = br_action[slot_index];
        if (chosen >= 0) {
            @memset(out[0..n], 0);
            out[@intCast(chosen)] = 1.0;
            return;
        }
    }
    @memcpy(out[0..n], average[base .. base + n]);
}

fn remaining(game: compile.CompiledGame, deal: compile.Deal, turn: i32, river: i32, out: *[52]i32) usize {
    var dead: [52]bool = .{false} ** 52;
    for (game.board) |c| dead[@intCast(c)] = true;
    dead[@intCast(deal.c0)] = true;
    dead[@intCast(deal.c1)] = true;
    dead[@intCast(deal.d0)] = true;
    dead[@intCast(deal.d1)] = true;
    if (turn >= 0) dead[@intCast(turn)] = true;
    if (river >= 0) dead[@intCast(river)] = true;
    var count: usize = 0;
    var c: i32 = 0;
    while (c < 52) : (c += 1) {
        if (!dead[@intCast(c)]) {
            out[count] = c;
            count += 1;
        }
    }
    return count;
}

fn terminalPay(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    node: compile.Node,
    deal: compile.Deal,
    turn: i32,
    river: i32,
) BrError!payoff.PlayerPayoff {
    return kernel.terminalNodePayoff(
        allocator,
        game,
        node,
        .{ deal.c0, deal.c1 },
        .{ deal.d0, deal.d1 },
        if (turn >= 0) turn else null,
        if (river >= 0) river else null,
    ) catch return error.InvalidAnalysis;
}

fn expectedWithBr(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    average: []const f32,
    br_action: []const i32,
    responding: i32,
    target_slot: i32,
    forced_action: i32,
    node_index: u32,
    deal: compile.Deal,
    turn: i32,
    river: i32,
) BrError!payoff.PlayerPayoff {
    const node = game.nodes[node_index];
    if (node.kind == .terminal) {
        return terminalPay(allocator, game, node, deal, turn, river);
    }
    if (node.kind == .chance) {
        var cards: [52]i32 = undefined;
        const count = remaining(game, deal, turn, river, &cards);
        if (count == 0) return error.InvalidAnalysis;
        const probability = 1.0 / @as(f64, @floatFromInt(count));
        var value = payoff.PlayerPayoff{};
        var i: usize = 0;
        while (i < count) : (i += 1) {
            var next_turn = turn;
            var next_river = river;
            if (node.deal_which == 1) next_turn = cards[i] else next_river = cards[i];
            const child = try expectedWithBr(
                allocator,
                game,
                average,
                br_action,
                responding,
                target_slot,
                forced_action,
                node.child[0],
                deal,
                next_turn,
                next_river,
            );
            value.utility[0] += probability * child.utility[0];
            value.utility[1] += probability * child.utility[1];
        }
        return value;
    }
    if (node.n_actions <= 1) {
        return expectedWithBr(
            allocator,
            game,
            average,
            br_action,
            responding,
            target_slot,
            forced_action,
            node.child[0],
            deal,
            turn,
            river,
        );
    }

    const hand = if (node.player == 0) deal.h0 else deal.h1;
    const key = game.cardKey(node, hand, turn, river) catch return error.InvalidAnalysis;
    if (key < 0 or @as(usize, @intCast(key)) >= node.slot_of.len) return error.InvalidAnalysis;
    const slot_i = node.slot_of[@intCast(key)];
    if (slot_i < 0) return error.InvalidAnalysis;
    const slot_index: usize = @intCast(slot_i);
    const base: usize = @intCast(game.slots[slot_index].base);
    const n: usize = node.n_actions;

    var row_buf: [8]f32 = undefined;
    if (target_slot >= 0 and slot_index == @as(usize, @intCast(target_slot))) {
        @memset(row_buf[0..n], 0);
        if (forced_action < 0 or forced_action >= @as(i32, @intCast(n))) return error.InvalidAnalysis;
        row_buf[@intCast(forced_action)] = 1.0;
    } else {
        fillStrategyRow(average, br_action, responding, slot_index, node.player, base, n, row_buf[0..n]);
    }

    var value = payoff.PlayerPayoff{};
    var action: usize = 0;
    while (action < n) : (action += 1) {
        const played: f64 = row_buf[action];
        if (played == 0) continue;
        const child = try expectedWithBr(
            allocator,
            game,
            average,
            br_action,
            responding,
            target_slot,
            forced_action,
            node.child[action],
            deal,
            turn,
            river,
        );
        value.utility[0] += played * child.utility[0];
        value.utility[1] += played * child.utility[1];
    }
    return value;
}

fn rootPayoffWithBr(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    average: []const f32,
    br_action: []const i32,
    responding: i32,
    target_slot: i32,
    forced_action: i32,
) BrError!payoff.PlayerPayoff {
    var total = payoff.PlayerPayoff{};
    for (game.deals) |deal| {
        const paid = try expectedWithBr(
            allocator,
            game,
            average,
            br_action,
            responding,
            target_slot,
            forced_action,
            0,
            deal,
            -1,
            -1,
        );
        total.utility[0] += deal.probability * paid.utility[0];
        total.utility[1] += deal.probability * paid.utility[1];
    }
    return total;
}

/// Exact infoset best response for `responding` against published average (deepest-first).
pub fn payoffOfBestResponse(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    average: []const f32,
    responding: i32,
) BrError!payoff.PlayerPayoff {
    if (responding != 0 and responding != 1) return error.InvalidAnalysis;
    if (game.table_entries > 0 and average.len == 0) return error.InvalidAnalysis;

    var br_action = allocator.alloc(i32, game.slots.len) catch return error.OutOfMemory;
    defer allocator.free(br_action);
    @memset(br_action, -1);

    const SlotOrder = struct {
        index: usize,
        depth: i32,
        node: i32,
    };
    var order = std.ArrayList(SlotOrder).init(allocator);
    defer order.deinit();
    for (game.slots, 0..) |slot, index| {
        const node = game.nodes[@intCast(slot.node)];
        if (node.player != responding) continue;
        if (node.n_actions <= 1) continue;
        order.append(.{
            .index = index,
            .depth = nodeDepth(game, slot.node),
            .node = slot.node,
        }) catch return error.OutOfMemory;
    }
    std.mem.sort(SlotOrder, order.items, {}, struct {
        fn less(_: void, a: SlotOrder, b: SlotOrder) bool {
            if (a.depth != b.depth) return a.depth > b.depth;
            return a.index < b.index;
        }
    }.less);

    for (order.items) |item| {
        const node = game.nodes[@intCast(item.node)];
        const n: usize = node.n_actions;
        var action_value: [8]f64 = .{0} ** 8;
        var action: i32 = 0;
        while (action < @as(i32, @intCast(n))) : (action += 1) {
            const paid = try rootPayoffWithBr(
                allocator,
                game,
                average,
                br_action,
                responding,
                @intCast(item.index),
                action,
            );
            action_value[@intCast(action)] = paid.utility[@intCast(responding)];
        }
        var best: i32 = 0;
        var a: i32 = 1;
        while (a < @as(i32, @intCast(n))) : (a += 1) {
            if (action_value[@intCast(a)] > action_value[@intCast(best)]) best = a;
        }
        br_action[item.index] = best;
    }

    return rootPayoffWithBr(allocator, game, average, br_action, responding, -1, -1);
}

/// On-profile expected payoff under published average (both seats mix).
pub fn onProfilePayoff(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    average: []const f32,
) BrError!payoff.PlayerPayoff {
    var total = payoff.PlayerPayoff{};
    var sigma = average;
    var owned: ?[]f32 = null;
    defer if (owned) |buf| allocator.free(buf);
    if (average.len == 0) {
        var uniform = training_state.TrainingState.init(allocator, game) catch return error.OutOfMemory;
        defer uniform.deinit();
        owned = allocator.dupe(f32, uniform.sigma) catch return error.OutOfMemory;
        sigma = owned.?;
    }
    for (game.deals) |deal| {
        const paid = traversal.expectedDeal(allocator, game, sigma, 0, deal, -1, -1) catch return error.InvalidAnalysis;
        total.utility[0] += deal.probability * paid.utility[0];
        total.utility[1] += deal.probability * paid.utility[1];
    }
    return total;
}

/// Evaluate published average: on-path + unilateral BRs → NashConv / Accuracy.
pub fn evaluatePublished(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    average: []const f32,
) BrError!evaluation.EvaluationResult {
    const on_path = try onProfilePayoff(allocator, game, average);
    const when0 = try payoffOfBestResponse(allocator, game, average, 0);
    const when1 = try payoffOfBestResponse(allocator, game, average, 1);
    return evaluation.makeEvaluation(
        on_path.utility[0],
        on_path.utility[1],
        when0.utility[0],
        when1.utility[1],
    );
}
