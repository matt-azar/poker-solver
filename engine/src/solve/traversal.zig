const std = @import("std");
const card = @import("../poker/card.zig");
const compile = @import("../game/compile.zig");
const payoff = @import("../poker/payoff.zig");
const kernel = @import("../kernel/terminal.zig");
const regret_matching = @import("regret_matching.zig");
const training_state = @import("training_state.zig");

pub const TravError = error{ InvalidTraversal, OutOfMemory };

fn remainingCards(game: compile.CompiledGame, deal: compile.Deal, turn: i32, river: i32, out: *[52]card.Card) usize {
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

fn slotIndex(game: compile.CompiledGame, node: compile.Node, hand: i32, turn: i32, river: i32) TravError!usize {
    const key = game.cardKey(node, hand, turn, river) catch return error.InvalidTraversal;
    if (key < 0 or @as(usize, @intCast(key)) >= node.slot_of.len) return error.InvalidTraversal;
    const index = node.slot_of[@intCast(key)];
    if (index < 0) return error.InvalidTraversal;
    return @intCast(index);
}

fn terminalModeled(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    node: compile.Node,
    deal: compile.Deal,
    turn: i32,
    river: i32,
) TravError!payoff.PlayerPayoff {
    return kernel.terminalNodePayoff(
        allocator,
        game,
        node,
        .{ deal.c0, deal.c1 },
        .{ deal.d0, deal.d1 },
        if (turn >= 0) turn else null,
        if (river >= 0) river else null,
    ) catch return error.InvalidTraversal;
}

/// Read-only expected payoff under a fixed strategy row buffer (`sigma`).
pub fn expectedDeal(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    sigma: []const f32,
    node_index: u32,
    deal: compile.Deal,
    turn: i32,
    river: i32,
) TravError!payoff.PlayerPayoff {
    const node = game.nodes[node_index];
    if (node.kind == .terminal) {
        return terminalModeled(allocator, game, node, deal, turn, river);
    }
    if (node.kind == .chance) {
        var cards: [52]card.Card = undefined;
        const count = remainingCards(game, deal, turn, river, &cards);
        if (count == 0) return error.InvalidTraversal;
        const probability = 1.0 / @as(f64, @floatFromInt(count));
        var value = payoff.PlayerPayoff{};
        var i: usize = 0;
        while (i < count) : (i += 1) {
            var next_turn = turn;
            var next_river = river;
            if (node.deal_which == 1) next_turn = cards[i] else next_river = cards[i];
            const child = try expectedDeal(
                allocator,
                game,
                sigma,
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
        return expectedDeal(allocator, game, sigma, node.child[0], deal, turn, river);
    }
    const hand = if (node.player == 0) deal.h0 else deal.h1;
    const index = try slotIndex(game, node, hand, turn, river);
    const base: usize = @intCast(game.slots[index].base);
    const n: usize = node.n_actions;
    const row = sigma[base .. base + n];
    var node_utility = payoff.PlayerPayoff{};
    var action: usize = 0;
    while (action < n) : (action += 1) {
        const played: f64 = row[action];
        if (played == 0) continue;
        const child = try expectedDeal(allocator, game, sigma, node.child[action], deal, turn, river);
        node_utility.utility[0] += played * child.utility[0];
        node_utility.utility[1] += played * child.utility[1];
    }
    return node_utility;
}

/// Deal-by-deal CFR traversal (C++ cfr_deal_payoff). Updates regret/strategy_sum
/// for `updating` player when matching; reads trainer-exclusive `sigma`.
pub fn cfrDeal(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    state: *training_state.TrainingState,
    node_index: u32,
    pi0: f64,
    pi1: f64,
    chance: f64,
    deal: compile.Deal,
    turn: i32,
    river: i32,
    updating: i32,
    weight_iter: f64,
) TravError!payoff.PlayerPayoff {
    const node = game.nodes[node_index];
    if (node.kind == .terminal) {
        return terminalModeled(allocator, game, node, deal, turn, river);
    }
    if (node.kind == .chance) {
        var cards: [52]card.Card = undefined;
        const count = remainingCards(game, deal, turn, river, &cards);
        if (count == 0) return error.InvalidTraversal;
        const probability = 1.0 / @as(f64, @floatFromInt(count));
        var value = payoff.PlayerPayoff{};
        var i: usize = 0;
        while (i < count) : (i += 1) {
            var next_turn = turn;
            var next_river = river;
            if (node.deal_which == 1) next_turn = cards[i] else next_river = cards[i];
            const child = try cfrDeal(
                allocator,
                game,
                state,
                node.child[0],
                pi0,
                pi1,
                chance * probability,
                deal,
                next_turn,
                next_river,
                updating,
                weight_iter,
            );
            value.utility[0] += probability * child.utility[0];
            value.utility[1] += probability * child.utility[1];
        }
        return value;
    }

    if (node.n_actions <= 1) {
        return cfrDeal(
            allocator,
            game,
            state,
            node.child[0],
            pi0,
            pi1,
            chance,
            deal,
            turn,
            river,
            updating,
            weight_iter,
        );
    }

    const hand = if (node.player == 0) deal.h0 else deal.h1;
    const reach = if (node.player == 0) pi0 else pi1;
    const index = try slotIndex(game, node, hand, turn, river);
    const base: usize = @intCast(game.slots[index].base);
    const n: usize = node.n_actions;
    const row = state.sigma[base .. base + n];
    const update = updating < 0 or updating == node.player;
    if (update) {
        regret_matching.accumulateAverage(state.strategy_sum[base .. base + n], row, weight_iter * reach);
    }

    var action_utility: [8]payoff.PlayerPayoff = [_]payoff.PlayerPayoff{.{}} ** 8;
    var node_utility = payoff.PlayerPayoff{};
    var action: usize = 0;
    while (action < n) : (action += 1) {
        const played: f64 = row[action];
        if (node.player == 0) {
            action_utility[action] = try cfrDeal(
                allocator,
                game,
                state,
                node.child[action],
                pi0 * played,
                pi1,
                chance,
                deal,
                turn,
                river,
                updating,
                weight_iter,
            );
        } else {
            action_utility[action] = try cfrDeal(
                allocator,
                game,
                state,
                node.child[action],
                pi0,
                pi1 * played,
                chance,
                deal,
                turn,
                river,
                updating,
                weight_iter,
            );
        }
        node_utility.utility[0] += played * action_utility[action].utility[0];
        node_utility.utility[1] += played * action_utility[action].utility[1];
    }
    if (update) {
        const opponent_reach = (if (node.player == 0) pi1 else pi0) * chance;
        const player: usize = @intCast(node.player);
        action = 0;
        while (action < n) : (action += 1) {
            const instant = action_utility[action].utility[player] - node_utility.utility[player];
            state.regret[base + action] += @floatCast(opponent_reach * instant);
        }
    }
    return node_utility;
}

/// Expected player-0 utility under a published/average strategy buffer.
pub fn rootValue(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    sigma: []const f32,
) TravError!f64 {
    var total: f64 = 0;
    for (game.deals) |deal| {
        const paid = try expectedDeal(allocator, game, sigma, 0, deal, -1, -1);
        total += deal.probability * paid.utility[0];
    }
    return total;
}
