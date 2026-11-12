const std = @import("std");
const card = @import("../poker/card.zig");
const chips = @import("../poker/chips.zig");
const compile = @import("../game/compile.zig");
const range_mod = @import("../poker/range.zig");
const training_state = @import("../solve/training_state.zig");
const node_id = @import("node_id.zig");

pub const InspectError = error{ InvalidAnalysis, OutOfMemory };

pub const ChanceCard = struct {
    /// Two-char card code (e.g. "As"); owned.
    card: []const u8 = "",
    /// Study child id `pN.tT.rR`; owned.
    child_id: []const u8 = "",
    weight: f64 = 0,
};

/// Strategy / browse page for one public node under a published average revision (D2).
/// Row copy only — never reads trainer-exclusive sigma.
pub const NodePage = struct {
    allocator: std.mem.Allocator,
    node_index: u32 = 0,
    kind: compile.NodeKind = .decision,
    player: i32 = -1,
    policy_revision: u64 = 0,
    actions: [][]const u8 = &.{},
    /// Decision action → child Study ids (`pN.tT.rR`). Empty for chance/terminal.
    children: [][]const u8 = &.{},
    /// Chance next-card rows. Empty for decision/terminal.
    cards: []ChanceCard = &.{},
    /// Hero (acting seat) combo labels in PrivateHandIndex order. Empty at terminal when unused.
    combos: [][]const u8 = &.{},
    /// Hand-major strategy: hand * n_actions + action. Expanded to 1.0 for single-action.
    strategy: []f32 = &.{},
    n_actions: u8 = 0,
    n_hands: i32 = 0,
    reach: []f32 = &.{},
    marginal: []f32 = &.{},
    reach_defined: bool = false,
    opponent_player: i32 = -1,
    opponent_combos: [][]const u8 = &.{},
    opponent_reach: []f32 = &.{},
    opponent_marginal: []f32 = &.{},
    pot: f64 = 0,
    stacks: [2]f64 = .{ 0, 0 },
    stack: f64 = 0,
    contrib: [2]f64 = .{ 0, 0 },
    to_call: f64 = 0,
    parent_id: ?[]const u8 = null,
    board: [][]const u8 = &.{},
    joint: f64 = 0,

    pub fn deinit(self: *NodePage) void {
        for (self.actions) |label| {
            if (label.len != 0) self.allocator.free(label);
        }
        if (self.actions.len != 0) self.allocator.free(self.actions);
        for (self.children) |id| {
            if (id.len != 0) self.allocator.free(id);
        }
        if (self.children.len != 0) self.allocator.free(self.children);
        for (self.cards) |*row| {
            if (row.card.len != 0) self.allocator.free(row.card);
            if (row.child_id.len != 0) self.allocator.free(row.child_id);
        }
        if (self.cards.len != 0) self.allocator.free(self.cards);
        for (self.combos) |label| {
            if (label.len != 0) self.allocator.free(label);
        }
        if (self.combos.len != 0) self.allocator.free(self.combos);
        if (self.strategy.len != 0) self.allocator.free(self.strategy);
        if (self.reach.len != 0) self.allocator.free(self.reach);
        if (self.marginal.len != 0) self.allocator.free(self.marginal);
        for (self.opponent_combos) |label| {
            if (label.len != 0) self.allocator.free(label);
        }
        if (self.opponent_combos.len != 0) self.allocator.free(self.opponent_combos);
        if (self.opponent_reach.len != 0) self.allocator.free(self.opponent_reach);
        if (self.opponent_marginal.len != 0) self.allocator.free(self.opponent_marginal);
        if (self.parent_id) |id| {
            if (id.len != 0) self.allocator.free(id);
        }
        for (self.board) |c| {
            if (c.len != 0) self.allocator.free(c);
        }
        if (self.board.len != 0) self.allocator.free(self.board);
        self.* = .{ .allocator = self.allocator };
    }
};

fn dealConflictsFixedCards(deal: compile.Deal, turn: i32, river: i32) bool {
    if (turn >= 0) {
        if (deal.c0 == turn or deal.c1 == turn or deal.d0 == turn or deal.d1 == turn) return true;
    }
    if (river >= 0) {
        if (deal.c0 == river or deal.c1 == river or deal.d0 == river or deal.d1 == river) return true;
    }
    return false;
}

/// Both players' average-policy mass along betting edges to `target` (chance edges skipped).
fn pathBettingReach(
    game: compile.CompiledGame,
    sigma: []const f32,
    target: u32,
    deal: compile.Deal,
    turn: i32,
    river: i32,
) InspectError!f64 {
    var parents: [64]u32 = undefined;
    var parent_actions: [64]i32 = undefined;
    var depth: usize = 0;
    var cur = target;
    while (game.nodes[cur].parent >= 0) {
        if (depth >= parents.len) return error.InvalidAnalysis;
        parents[depth] = @intCast(game.nodes[cur].parent);
        parent_actions[depth] = game.nodes[cur].parent_action;
        cur = parents[depth];
        depth += 1;
    }
    var reach: f64 = 1.0;
    var i = depth;
    while (i > 0) {
        i -= 1;
        const pnode = game.nodes[parents[i]];
        const pa = parent_actions[i];
        if (pnode.kind != .decision or pa < 0) continue;
        if (pnode.n_actions <= 1) continue;
        const hand = if (pnode.player == 0) deal.h0 else deal.h1;
        if (hand < 0) return error.InvalidAnalysis;
        const key = game.cardKey(pnode, hand, turn, river) catch return error.InvalidAnalysis;
        if (key < 0 or @as(usize, @intCast(key)) >= pnode.slot_of.len) return error.InvalidAnalysis;
        const slot_i = pnode.slot_of[@intCast(key)];
        if (slot_i < 0) return error.InvalidAnalysis;
        const base: usize = @intCast(game.slots[@intCast(slot_i)].base);
        reach *= @as(f64, @floatCast(sigma[base + @as(usize, @intCast(pa))]));
    }
    return reach;
}

fn fillComboLabels(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    player: usize,
) InspectError![][]const u8 {
    const hands: usize = @intCast(@max(game.hands.nHands(player), 0));
    var combos = allocator.alloc([]const u8, hands) catch return error.OutOfMemory;
    @memset(combos, "");
    errdefer {
        for (combos) |label| {
            if (label.len != 0) allocator.free(label);
        }
        allocator.free(combos);
    }
    var hand: usize = 0;
    while (hand < hands) : (hand += 1) {
        const combo = game.hands.combos[player][hand];
        var buf: [4]u8 = undefined;
        const text = range_mod.Range.comboText(combo, &buf) catch return error.InvalidAnalysis;
        combos[hand] = allocator.dupe(u8, text) catch return error.OutOfMemory;
    }
    return combos;
}

fn normalizeMarginal(reach: []const f32, marginal: []f32) void {
    var sum: f64 = 0;
    for (reach) |r| sum += r;
    if (!(sum > 0)) {
        @memset(marginal, 0);
        return;
    }
    var i: usize = 0;
    while (i < reach.len) : (i += 1) {
        marginal[i] = @floatCast(@as(f64, @floatCast(reach[i])) / sum);
    }
}

fn fillReachArrays(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    sigma: []const f32,
    node_index: u32,
    turn: i32,
    river: i32,
    actor: i32,
    page: *NodePage,
) InspectError!void {
    const n0: usize = @intCast(@max(game.hands.nHands(0), 0));
    const n1: usize = @intCast(@max(game.hands.nHands(1), 0));
    var mass0 = allocator.alloc(f32, n0) catch return error.OutOfMemory;
    defer allocator.free(mass0);
    var mass1 = allocator.alloc(f32, n1) catch return error.OutOfMemory;
    defer allocator.free(mass1);
    @memset(mass0, 0);
    @memset(mass1, 0);

    var any = false;
    var joint: f64 = 0;
    for (game.deals) |deal| {
        if (dealConflictsFixedCards(deal, turn, river)) continue;
        const path_w = pathBettingReach(game, sigma, node_index, deal, turn, river) catch continue;
        if (!(path_w > 0) or !(deal.probability > 0)) continue;
        const w: f32 = @floatCast(deal.probability * path_w);
        if (deal.h0 >= 0 and @as(usize, @intCast(deal.h0)) < n0) {
            mass0[@intCast(deal.h0)] += w;
        }
        if (deal.h1 >= 0 and @as(usize, @intCast(deal.h1)) < n1) {
            mass1[@intCast(deal.h1)] += w;
        }
        joint += deal.probability * path_w;
        any = true;
    }
    page.joint = joint;
    page.reach_defined = any;

    const hero: usize = if (actor == 1) 1 else 0;
    const vill: usize = 1 - hero;
    const hero_mass = if (hero == 0) mass0 else mass1;
    const vill_mass = if (vill == 0) mass0 else mass1;

    page.combos = try fillComboLabels(allocator, game, hero);
    page.n_hands = @intCast(page.combos.len);
    page.reach = allocator.dupe(f32, hero_mass) catch return error.OutOfMemory;
    page.marginal = allocator.alloc(f32, hero_mass.len) catch return error.OutOfMemory;
    normalizeMarginal(page.reach, page.marginal);

    page.opponent_player = @intCast(vill);
    page.opponent_combos = try fillComboLabels(allocator, game, vill);
    page.opponent_reach = allocator.dupe(f32, vill_mass) catch return error.OutOfMemory;
    page.opponent_marginal = allocator.alloc(f32, vill_mass.len) catch return error.OutOfMemory;
    normalizeMarginal(page.opponent_reach, page.opponent_marginal);
}

fn fillBoard(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    turn: i32,
    river: i32,
) InspectError![][]const u8 {
    var count: usize = game.board.len;
    if (turn >= 0) count += 1;
    if (river >= 0) count += 1;
    var board = allocator.alloc([]const u8, count) catch return error.OutOfMemory;
    @memset(board, "");
    errdefer {
        for (board) |c| {
            if (c.len != 0) allocator.free(c);
        }
        allocator.free(board);
    }
    var i: usize = 0;
    for (game.board) |c| {
        var buf: [2]u8 = undefined;
        const text = card.formatCard(c, &buf) catch return error.InvalidAnalysis;
        board[i] = allocator.dupe(u8, text) catch return error.OutOfMemory;
        i += 1;
    }
    if (turn >= 0) {
        var buf: [2]u8 = undefined;
        const text = card.formatCard(@intCast(turn), &buf) catch return error.InvalidAnalysis;
        board[i] = allocator.dupe(u8, text) catch return error.OutOfMemory;
        i += 1;
    }
    if (river >= 0) {
        var buf: [2]u8 = undefined;
        const text = card.formatCard(@intCast(river), &buf) catch return error.InvalidAnalysis;
        board[i] = allocator.dupe(u8, text) catch return error.OutOfMemory;
    }
    return board;
}

fn fillPotStacks(page: *NodePage, game: compile.CompiledGame, node: compile.Node) void {
    const c0 = chips.tenthsToChips(node.contrib[0]);
    const c1 = chips.tenthsToChips(node.contrib[1]);
    const start_pot = chips.tenthsToChips(game.pot);
    const start_stack = chips.tenthsToChips(game.stack);
    page.contrib = .{ c0, c1 };
    page.pot = start_pot + c0 + c1;
    page.stacks = .{ start_stack - c0, start_stack - c1 };
    page.stack = @min(page.stacks[0], page.stacks[1]);
    // Facing amount is not stored on the compiled node; leave 0 (check / first to act).
    page.to_call = 0;
}

fn fillParentId(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    node: compile.Node,
    turn: i32,
    river: i32,
) InspectError!?[]const u8 {
    if (node.parent < 0) return null;
    const parent = game.nodes[@intCast(node.parent)];
    // Parent chance that dealt the current street card should keep the card in its child id,
    // but the chance node itself usually carries the pre-deal board (t-1 / prior turn).
    var p_turn = turn;
    var p_river = river;
    if (parent.kind == .chance) {
        if (parent.deal_which == 1) {
            p_turn = -1;
            p_river = -1;
        } else if (game.board.len == 3) {
            // River deal on a flop tree: chance id still carries the turn.
            p_river = -1;
        } else {
            p_turn = -1;
            p_river = -1;
        }
    }
    const text = node_id.formatNodeId(allocator, @intCast(node.parent), p_turn, p_river) catch return error.OutOfMemory;
    return text;
}

fn fillDecisionChildren(
    allocator: std.mem.Allocator,
    node: compile.Node,
    turn: i32,
    river: i32,
) InspectError![][]const u8 {
    var children = allocator.alloc([]const u8, node.n_actions) catch return error.OutOfMemory;
    @memset(children, "");
    errdefer {
        for (children) |id| {
            if (id.len != 0) allocator.free(id);
        }
        allocator.free(children);
    }
    var a: usize = 0;
    while (a < node.n_actions) : (a += 1) {
        children[a] = node_id.formatNodeId(allocator, node.child[a], turn, river) catch return error.OutOfMemory;
    }
    return children;
}

fn cardBlocked(game: compile.CompiledGame, c: i32, turn: i32, river: i32) bool {
    if (c < 0 or c >= 52) return true;
    for (game.board) |b| {
        if (@as(i32, b) == c) return true;
    }
    if (turn >= 0 and c == turn) return true;
    if (river >= 0 and c == river) return true;
    return false;
}

fn fillChanceCards(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    node: compile.Node,
    turn: i32,
    river: i32,
) InspectError![]ChanceCard {
    if (node.kind != .chance) return &.{};
    const child_idx = node.child[0];
    var list = std.ArrayList(ChanceCard).init(allocator);
    errdefer {
        for (list.items) |*row| {
            if (row.card.len != 0) allocator.free(row.card);
            if (row.child_id.len != 0) allocator.free(row.child_id);
        }
        list.deinit();
    }

    var legal: usize = 0;
    var c: i32 = 0;
    while (c < 52) : (c += 1) {
        if (cardBlocked(game, c, turn, river)) continue;
        legal += 1;
    }
    const weight: f64 = if (legal > 0) 1.0 / @as(f64, @floatFromInt(legal)) else 0;

    c = 0;
    while (c < 52) : (c += 1) {
        if (cardBlocked(game, c, turn, river)) continue;
        var new_turn = turn;
        var new_river = river;
        if (node.deal_which == 1) {
            // Turn deal after flop.
            new_turn = c;
            new_river = -1;
        } else {
            // River deal.
            new_river = c;
            if (game.board.len == 4) {
                new_turn = -1;
            }
            // flop tree river deal keeps turn from the chance/query id.
        }
        var card_buf: [2]u8 = undefined;
        const card_text = card.formatCard(c, &card_buf) catch return error.InvalidAnalysis;
        const owned_card = allocator.dupe(u8, card_text) catch return error.OutOfMemory;
        errdefer allocator.free(owned_card);
        const child_id = node_id.formatNodeId(allocator, child_idx, new_turn, new_river) catch return error.OutOfMemory;
        try list.append(.{
            .card = owned_card,
            .child_id = child_id,
            .weight = weight,
        });
    }
    return list.toOwnedSlice() catch return error.OutOfMemory;
}

/// Copy requested strategy / browse rows for a public node from the published average.
pub fn inspectNode(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    published: training_state.PublishedPolicy,
    node_index: u32,
    turn: i32,
    river: i32,
) InspectError!NodePage {
    if (node_index >= game.nodes.len) return error.InvalidAnalysis;
    const node = game.nodes[node_index];

    var page = NodePage{
        .allocator = allocator,
        .node_index = node_index,
        .kind = node.kind,
        .player = node.player,
        .policy_revision = published.revision,
        .n_actions = node.n_actions,
    };
    errdefer page.deinit();

    fillPotStacks(&page, game, node);
    page.board = try fillBoard(allocator, game, turn, river);
    page.parent_id = try fillParentId(allocator, game, node, turn, river);

    var owned_sigma: ?[]f32 = null;
    defer if (owned_sigma) |buf| allocator.free(buf);
    const sigma: []const f32 = blk: {
        if (published.average.len != 0) break :blk published.average;
        var uniform = training_state.TrainingState.init(allocator, game) catch return error.OutOfMemory;
        defer uniform.deinit();
        owned_sigma = allocator.dupe(f32, uniform.sigma) catch return error.OutOfMemory;
        break :blk owned_sigma.?;
    };

    // Actor for reach: decision seat; chance/terminal use OOP as the browse hero.
    const actor: i32 = if (node.kind == .decision and node.player >= 0) node.player else 0;
    page.player = if (node.kind == .decision) node.player else -1;

    try fillReachArrays(allocator, game, sigma, node_index, turn, river, actor, &page);

    if (node.kind == .decision) {
        page.actions = allocator.alloc([]const u8, node.n_actions) catch return error.OutOfMemory;
        @memset(page.actions, "");
        var a: usize = 0;
        while (a < node.n_actions) : (a += 1) {
            page.actions[a] = allocator.dupe(u8, node.action_labels[a]) catch return error.OutOfMemory;
        }
        page.children = try fillDecisionChildren(allocator, node, turn, river);

        const hands: usize = @intCast(@max(page.n_hands, 0));
        if (node.n_actions == 0) {
            // No actions — leave strategy empty.
        } else if (node.n_actions == 1) {
            // Expand implicit σ=1 at the IPC boundary for Study matrix/nav.
            page.strategy = allocator.alloc(f32, hands) catch return error.OutOfMemory;
            @memset(page.strategy, 1);
        } else {
            page.strategy = allocator.alloc(f32, hands * node.n_actions) catch return error.OutOfMemory;
            @memset(page.strategy, 0);
            var hand: usize = 0;
            while (hand < hands) : (hand += 1) {
                const key = game.cardKey(node, @intCast(hand), turn, river) catch continue;
                if (key < 0 or @as(usize, @intCast(key)) >= node.slot_of.len) continue;
                const slot_i = node.slot_of[@intCast(key)];
                if (slot_i < 0) continue;
                const base: usize = @intCast(game.slots[@intCast(slot_i)].base);
                const row = sigma[base .. base + node.n_actions];
                const dest = hand * node.n_actions;
                @memcpy(page.strategy[dest .. dest + node.n_actions], row);
            }
        }
    } else if (node.kind == .chance) {
        page.n_actions = 0;
        page.cards = try fillChanceCards(allocator, game, node, turn, river);
    } else {
        page.n_actions = 0;
    }

    return page;
}
