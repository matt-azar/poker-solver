const std = @import("std");
const card = @import("../poker/card.zig");
const chips = @import("../poker/chips.zig");
const range_mod = @import("../poker/range.zig");
const payoff = @import("../poker/payoff.zig");
const icm = @import("../poker/icm.zig");
const street_spec = @import("street_spec.zig");
const betting = @import("betting.zig");

pub const CompileError = error{
    InvalidCompile,
    OutOfMemory,
};

pub const NodeKind = enum { decision, chance, terminal };

pub const Node = struct {
    kind: NodeKind = .decision,
    player: i32 = -1,
    street: i32 = 0,
    deal_which: i32 = 0,
    folded: i32 = -1,
    contrib: [2]chips.Chip = .{ 0, 0 },
    n_actions: u8 = 0,
    child: [8]u32 = .{0} ** 8,
    /// Owned by CompiledGame.allocator (duped labels).
    action_labels: [8][]const u8 = .{""} ** 8,
    path: []const u8 = "",
    card_mode: u8 = 0,
    mode1_is_turn: bool = false,
    incentive_u0: f64 = 0,
    incentive_u1: f64 = 0,
};

pub const RunoutIndex = struct {
    mode1_cards: []card.Card = &.{},
    mode1_of: [52]i32 = .{-1} ** 52,
    mode2_turn: []card.Card = &.{},
    mode2_river: []card.Card = &.{},
    mode2_of: []i32 = &.{}, // 52*52, -1 if illegal; empty unless flop root

    pub fn deinit(self: *RunoutIndex, allocator: std.mem.Allocator) void {
        if (self.mode1_cards.len != 0) allocator.free(self.mode1_cards);
        if (self.mode2_turn.len != 0) allocator.free(self.mode2_turn);
        if (self.mode2_river.len != 0) allocator.free(self.mode2_river);
        if (self.mode2_of.len != 0) allocator.free(self.mode2_of);
        self.* = .{};
    }

    pub fn runoutDim(self: RunoutIndex, node: Node) u64 {
        return switch (node.card_mode) {
            1 => self.mode1_cards.len,
            2 => self.mode2_turn.len,
            else => 1,
        };
    }
};

pub const PrivateHandIndex = struct {
    /// Combo ids (0..1325) with positive weight that appear in some legal pair.
    combos: [2][]i32 = .{ &.{}, &.{} },
    combo_to_hand: [2][]i32 = .{ &.{}, &.{} }, // 1326, -1 if unused
    hole_low: [2][]card.Card = .{ &.{}, &.{} },
    hole_high: [2][]card.Card = .{ &.{}, &.{} },
    range_w: [2][]f64 = .{ &.{}, &.{} },
    counted_deals: u64 = 0,
    joint_mass: f64 = 0,

    pub fn nHands(self: PrivateHandIndex, player: usize) i32 {
        return @intCast(self.combos[player].len);
    }

    pub fn deinit(self: *PrivateHandIndex, allocator: std.mem.Allocator) void {
        inline for (0..2) |p| {
            if (self.combos[p].len != 0) allocator.free(self.combos[p]);
            if (self.combo_to_hand[p].len != 0) allocator.free(self.combo_to_hand[p]);
            if (self.hole_low[p].len != 0) allocator.free(self.hole_low[p]);
            if (self.hole_high[p].len != 0) allocator.free(self.hole_high[p]);
            if (self.range_w[p].len != 0) allocator.free(self.range_w[p]);
        }
        self.* = .{};
    }
};

/// Immutable compiled postflop game (Phase 2). Policy / training tables are Phase 3.
pub const CompiledGame = struct {
    allocator: std.mem.Allocator,
    board: []card.Card = &.{},
    pot: chips.Chip = 0,
    stack: chips.Chip = 0,
    rake: payoff.RakeConfig = .{},
    icm_stacks: []f64 = &.{},
    icm_payouts: []f64 = &.{},
    nodes: []Node = &.{},
    decision_ids: []u32 = &.{},
    public_decisions: u64 = 0,
    public_terminals: u64 = 0,
    runouts: RunoutIndex = .{},
    hands: PrivateHandIndex = .{},

    pub fn icmConfig(self: CompiledGame) icm.IcmConfig {
        return .{ .stacks = self.icm_stacks, .payouts = self.icm_payouts };
    }

    pub fn deinit(self: *CompiledGame) void {
        for (self.nodes) |node| {
            if (node.path.len != 0) self.allocator.free(node.path);
            var a: usize = 0;
            while (a < node.n_actions) : (a += 1) {
                if (node.action_labels[a].len != 0) self.allocator.free(node.action_labels[a]);
            }
        }
        if (self.nodes.len != 0) self.allocator.free(self.nodes);
        if (self.decision_ids.len != 0) self.allocator.free(self.decision_ids);
        if (self.board.len != 0) self.allocator.free(self.board);
        if (self.icm_stacks.len != 0) self.allocator.free(self.icm_stacks);
        if (self.icm_payouts.len != 0) self.allocator.free(self.icm_payouts);
        self.runouts.deinit(self.allocator);
        self.hands.deinit(self.allocator);
        self.* = .{ .allocator = self.allocator };
    }
};

pub fn compile(allocator: std.mem.Allocator, spec: street_spec.StreetSpec) CompileError!CompiledGame {
    if (spec.board.len != 3 and spec.board.len != 4 and spec.board.len != 5) return error.InvalidCompile;
    card.validateBoard(spec.board) catch return error.InvalidCompile;
    if (spec.pot <= 0) return error.InvalidCompile;
    if (spec.stack < 0) return error.InvalidCompile;
    if (spec.first_to_act != 0 and spec.first_to_act != 1) return error.InvalidCompile;
    if (spec.max_raises < 0 or spec.max_raises > 6) return error.InvalidCompile;
    payoff.RakeConfig.validate(.{ .rate = spec.rake.rate, .cap = spec.rake.cap }) catch return error.InvalidCompile;
    const icm_cfg = icm.IcmConfig{ .stacks = spec.icm.stacks, .payouts = spec.icm.payouts };
    icm_cfg.validate(spec.pot, spec.stack) catch return error.InvalidCompile;

    var game = CompiledGame{ .allocator = allocator };
    errdefer game.deinit();

    game.board = allocator.dupe(card.Card, spec.board) catch return error.OutOfMemory;
    game.pot = spec.pot;
    game.stack = spec.stack;
    game.rake = .{ .rate = spec.rake.rate, .cap = spec.rake.cap };
    if (spec.icm.stacks.len != 0) {
        game.icm_stacks = allocator.dupe(f64, spec.icm.stacks) catch return error.OutOfMemory;
        game.icm_payouts = allocator.dupe(f64, spec.icm.payouts) catch return error.OutOfMemory;
    }

    try buildRunoutIndex(allocator, &game);
    try buildPublicTree(allocator, &game, spec);
    try buildHandIndex(allocator, &game, spec);
    return game;
}

fn buildRunoutIndex(allocator: std.mem.Allocator, game: *CompiledGame) CompileError!void {
    var on_board: [52]bool = .{false} ** 52;
    for (game.board) |c| on_board[@intCast(c)] = true;

    var cards = std.ArrayList(card.Card).init(allocator);
    errdefer cards.deinit();
    var mode1_of: [52]i32 = .{-1} ** 52;
    var c: i32 = 0;
    while (c < 52) : (c += 1) {
        if (on_board[@intCast(c)]) continue;
        mode1_of[@intCast(c)] = @intCast(cards.items.len);
        cards.append(c) catch return error.OutOfMemory;
    }
    game.runouts.mode1_of = mode1_of;
    game.runouts.mode1_cards = cards.toOwnedSlice() catch return error.OutOfMemory;

    if (game.board.len != 3) return;

    var mode2_of = allocator.alloc(i32, 52 * 52) catch return error.OutOfMemory;
    errdefer allocator.free(mode2_of);
    @memset(mode2_of, -1);
    var turns = std.ArrayList(card.Card).init(allocator);
    errdefer turns.deinit();
    var rivers = std.ArrayList(card.Card).init(allocator);
    errdefer rivers.deinit();

    var turn: i32 = 0;
    while (turn < 52) : (turn += 1) {
        if (on_board[@intCast(turn)]) continue;
        var river: i32 = 0;
        while (river < 52) : (river += 1) {
            if (river == turn or on_board[@intCast(river)]) continue;
            const key: usize = @intCast(turn * 52 + river);
            mode2_of[key] = @intCast(turns.items.len);
            turns.append(turn) catch return error.OutOfMemory;
            rivers.append(river) catch return error.OutOfMemory;
        }
    }
    game.runouts.mode2_of = mode2_of;
    game.runouts.mode2_turn = turns.toOwnedSlice() catch return error.OutOfMemory;
    game.runouts.mode2_river = rivers.toOwnedSlice() catch return error.OutOfMemory;
}

fn buildPublicTree(allocator: std.mem.Allocator, game: *CompiledGame, spec: street_spec.StreetSpec) CompileError!void {
    var nodes = std.ArrayList(Node).init(allocator);
    errdefer {
        for (nodes.items) |node| {
            if (node.path.len != 0) allocator.free(node.path);
            var a: usize = 0;
            while (a < node.n_actions) : (a += 1) {
                if (node.action_labels[a].len != 0) allocator.free(node.action_labels[a]);
            }
        }
        nodes.deinit();
    }
    var decision_ids = std.ArrayList(u32).init(allocator);
    errdefer decision_ids.deinit();

    var root = betting.BetState{};
    root.pot = spec.pot;
    root.acting = spec.first_to_act;
    _ = try buildNode(allocator, spec, game, &nodes, &decision_ids, root, "", 0);

    game.nodes = nodes.toOwnedSlice() catch return error.OutOfMemory;
    game.decision_ids = decision_ids.toOwnedSlice() catch return error.OutOfMemory;
    var decisions: u64 = 0;
    var terminals: u64 = 0;
    for (game.nodes) |n| {
        if (n.kind == .decision) decisions += 1;
        if (n.kind == .terminal) terminals += 1;
    }
    game.public_decisions = decisions;
    game.public_terminals = terminals;
}

fn buildNode(
    allocator: std.mem.Allocator,
    spec: street_spec.StreetSpec,
    game: *CompiledGame,
    nodes: *std.ArrayList(Node),
    decision_ids: *std.ArrayList(u32),
    state: betting.BetState,
    path: []const u8,
    depth: i32,
) CompileError!u32 {
    if (depth > 48) return error.InvalidCompile;
    if (state.terminal) {
        var node = Node{ .kind = .terminal, .street = state.street, .folded = state.folded };
        node.contrib = state.contrib;
        node.path = allocator.dupe(u8, path) catch return error.OutOfMemory;
        const id: u32 = @intCast(nodes.items.len);
        nodes.append(node) catch return error.OutOfMemory;
        return id;
    }
    if (state.chance) {
        var node = Node{
            .kind = .chance,
            .street = state.street,
            .deal_which = state.deal_which,
            .contrib = state.contrib,
        };
        node.path = allocator.dupe(u8, path) catch return error.OutOfMemory;
        const id: u32 = @intCast(nodes.items.len);
        nodes.append(node) catch return error.OutOfMemory;
        var next = state;
        next.chance = false;
        next.deal_which = 0;
        next.acting = spec.first_to_act;
        next.pending_check = false;
        next.last_raise = 0;
        next.num_raises = 0;
        next.committed = next.contrib[0];
        const child = try buildNode(allocator, spec, game, nodes, decision_ids, next, path, depth);
        nodes.items[@intCast(id)].child[0] = child;
        return id;
    }

    var legal = betting.legalActions(spec, state) catch return error.InvalidCompile;
    betting.applyTreeEdits(&legal, spec, state, path) catch return error.InvalidCompile;
    const facing = state.committed > state.contrib[@intCast(state.acting)];

    var node = Node{
        .kind = .decision,
        .player = state.acting,
        .street = state.street,
        .contrib = state.contrib,
        .n_actions = @intCast(legal.count),
    };
    node.path = allocator.dupe(u8, path) catch return error.OutOfMemory;

    if (spec.board.len == 3) {
        if (state.street == 0) {
            node.card_mode = 0;
        } else if (state.street == 1) {
            node.card_mode = 1;
            node.mode1_is_turn = true;
        } else {
            node.card_mode = 2;
        }
    } else if (spec.board.len == 5) {
        node.card_mode = 0;
    } else {
        node.card_mode = if (state.street == 0) 0 else 1;
        node.mode1_is_turn = false;
    }

    var action: i32 = 0;
    while (action < legal.count) : (action += 1) {
        const street_total = state.contrib[@intCast(state.acting)] + legal.add[@intCast(action)];
        const all_in = legal.code[@intCast(action)] != 0 and street_total == spec.stack and legal.add[@intCast(action)] > 0;
        var label_buf: [64]u8 = undefined;
        const label = betting.chipLabel(
            legal.code[@intCast(action)],
            legal.add[@intCast(action)],
            street_total,
            all_in,
            facing,
            &label_buf,
        ) catch return error.InvalidCompile;
        node.action_labels[@intCast(action)] = allocator.dupe(u8, label) catch return error.OutOfMemory;
    }

    const id: u32 = @intCast(nodes.items.len);
    nodes.append(node) catch return error.OutOfMemory;
    decision_ids.append(id) catch return error.OutOfMemory;

    action = 0;
    while (action < legal.count) : (action += 1) {
        const label = nodes.items[@intCast(id)].action_labels[@intCast(action)];
        var next_path_buf: [512]u8 = undefined;
        const next_path = if (path.len == 0)
            label
        else blk: {
            const written = std.fmt.bufPrint(&next_path_buf, "{s}/{s}", .{ path, label }) catch return error.InvalidCompile;
            break :blk written;
        };
        const child = try buildNode(
            allocator,
            spec,
            game,
            nodes,
            decision_ids,
            betting.applyAction(spec, state, legal, action),
            next_path,
            depth + 1,
        );
        nodes.items[@intCast(id)].child[@intCast(action)] = child;
    }
    return id;
}

fn comboBlocked(combo: i32, board: []const card.Card) bool {
    const pair = range_mod.Range.comboCards(combo) catch return true;
    for (board) |b| {
        if (b == pair[0] or b == pair[1]) return true;
    }
    return false;
}

fn combosOverlap(left: i32, right: i32) bool {
    const a = range_mod.Range.comboCards(left) catch return true;
    const b = range_mod.Range.comboCards(right) catch return true;
    return a[0] == b[0] or a[0] == b[1] or a[1] == b[0] or a[1] == b[1];
}

fn buildHandIndex(allocator: std.mem.Allocator, game: *CompiledGame, spec: street_spec.StreetSpec) CompileError!void {
    var combo_to_hand0 = allocator.alloc(i32, card.combo_count) catch return error.OutOfMemory;
    errdefer allocator.free(combo_to_hand0);
    var combo_to_hand1 = allocator.alloc(i32, card.combo_count) catch return error.OutOfMemory;
    errdefer allocator.free(combo_to_hand1);
    @memset(combo_to_hand0, -1);
    @memset(combo_to_hand1, -1);

    var combos0 = std.ArrayList(i32).init(allocator);
    errdefer combos0.deinit();
    var combos1 = std.ArrayList(i32).init(allocator);
    errdefer combos1.deinit();

    var mass: f64 = 0;
    var deals: u64 = 0;
    var first: i32 = 0;
    while (first < card.combo_count) : (first += 1) {
        const w0 = spec.oop.weights[@intCast(first)];
        if (w0 == 0.0 or comboBlocked(first, game.board)) continue;
        var second: i32 = 0;
        while (second < card.combo_count) : (second += 1) {
            const w1 = spec.ip.weights[@intCast(second)];
            if (w1 == 0.0 or comboBlocked(second, game.board)) continue;
            if (combosOverlap(first, second)) continue;
            const product = w0 * w1;
            mass += product;
            deals += 1;
            if (combo_to_hand0[@intCast(first)] < 0) {
                combo_to_hand0[@intCast(first)] = @intCast(combos0.items.len);
                combos0.append(first) catch return error.OutOfMemory;
            }
            if (combo_to_hand1[@intCast(second)] < 0) {
                combo_to_hand1[@intCast(second)] = @intCast(combos1.items.len);
                combos1.append(second) catch return error.OutOfMemory;
            }
        }
    }
    if (mass <= 0.0 or deals == 0) return error.InvalidCompile;

    game.hands.combo_to_hand[0] = combo_to_hand0;
    game.hands.combo_to_hand[1] = combo_to_hand1;
    game.hands.combos[0] = combos0.toOwnedSlice() catch return error.OutOfMemory;
    game.hands.combos[1] = combos1.toOwnedSlice() catch return error.OutOfMemory;
    game.hands.counted_deals = deals;
    game.hands.joint_mass = mass;

    inline for (0..2) |p| {
        const n = game.hands.combos[p].len;
        var low = allocator.alloc(card.Card, n) catch return error.OutOfMemory;
        var high = allocator.alloc(card.Card, n) catch return error.OutOfMemory;
        var weights = allocator.alloc(f64, n) catch return error.OutOfMemory;
        const range = if (p == 0) spec.oop else spec.ip;
        for (game.hands.combos[p], 0..) |combo, i| {
            const pair = range_mod.Range.comboCards(combo) catch return error.InvalidCompile;
            low[i] = pair[0];
            high[i] = pair[1];
            weights[i] = range.weights[@intCast(combo)];
        }
        game.hands.hole_low[p] = low;
        game.hands.hole_high[p] = high;
        game.hands.range_w[p] = weights;
    }
}

test "compile river check-only AA vs KK" {
    const text =
        \\street-config 1
        \\board Ah Kd 7c 4s 2h
        \\pot 100
        \\stack 100
        \\oop-range AcAd:1
        \\ip-range KsKc:1
        \\first-to-act 0
        \\max-raises 0
        \\allow-all-in 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 1024
        \\threads 1
        \\
    ;
    var spec = try @import("street_config.zig").parseStreetConfig(std.testing.allocator, text);
    defer spec.deinit();
    var game = try compile(std.testing.allocator, spec);
    defer game.deinit();

    try std.testing.expectEqual(@as(usize, 5), game.board.len);
    try std.testing.expect(game.public_decisions >= 1);
    try std.testing.expect(game.public_terminals >= 1);
    try std.testing.expectEqual(@as(i32, 1), game.hands.nHands(0));
    try std.testing.expectEqual(@as(i32, 1), game.hands.nHands(1));
    try std.testing.expectEqual(@as(u64, 1), game.hands.counted_deals);
    // River: only check/check path → decision Check, decision Check, terminal
    try std.testing.expectEqual(@as(usize, 0), game.runouts.mode2_turn.len);
}

test "compile flop runout index size" {
    const text =
        \\street-config 1
        \\board Ah Kd 7c
        \\pot 100
        \\stack 100
        \\oop-range QcQd:1
        \\ip-range JcJd:1
        \\first-to-act 0
        \\max-raises 0
        \\allow-all-in 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 1024
        \\threads 1
        \\
    ;
    var spec = try @import("street_config.zig").parseStreetConfig(std.testing.allocator, text);
    defer spec.deinit();
    var game = try compile(std.testing.allocator, spec);
    defer game.deinit();
    try std.testing.expectEqual(@as(usize, 49), game.runouts.mode1_cards.len);
    try std.testing.expectEqual(@as(usize, 49 * 48), game.runouts.mode2_turn.len);
}
