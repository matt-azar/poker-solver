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
    hands: i32 = 0,
    parent: i32 = -1,
    parent_action: i32 = -1,
    from_chance: bool = false,
    /// Dense slot index per card_key; -1 if no multi-action row. Owned.
    slot_of: []i32 = &.{},
};

pub const Deal = struct {
    h0: i32 = 0,
    h1: i32 = 0,
    combo0: i32 = 0,
    combo1: i32 = 0,
    c0: card.Card = 0,
    c1: card.Card = 0,
    d0: card.Card = 0,
    d1: card.Card = 0,
    probability: f64 = 0,
};

pub const Slot = struct {
    node: i32 = 0,
    base: i32 = 0,
    hand: u16 = 0,
    turn: i8 = -1,
    river: i8 = -1,
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

/// Immutable compiled postflop game. Numeric training tables live in solve/.
pub const CompiledGame = struct {
    allocator: std.mem.Allocator,
    board: []card.Card = &.{},
    pot: chips.Chip = 0,
    stack: chips.Chip = 0,
    first_to_act: i32 = 0,
    rake: payoff.RakeConfig = .{},
    icm_stacks: []f64 = &.{},
    icm_payouts: []f64 = &.{},
    incentive_rules: []street_spec.IncentiveRule = &.{},
    incentive_edge_tags: []street_spec.IncentiveEdgeTagSpec = &.{},
    nodes: []Node = &.{},
    decision_ids: []u32 = &.{},
    public_decisions: u64 = 0,
    public_terminals: u64 = 0,
    runouts: RunoutIndex = .{},
    hands: PrivateHandIndex = .{},
    deals: []Deal = &.{},
    slots: []Slot = &.{},
    table_entries: i32 = 0,

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
            if (node.slot_of.len != 0) self.allocator.free(node.slot_of);
        }
        if (self.nodes.len != 0) self.allocator.free(self.nodes);
        if (self.decision_ids.len != 0) self.allocator.free(self.decision_ids);
        if (self.board.len != 0) self.allocator.free(self.board);
        if (self.icm_stacks.len != 0) self.allocator.free(self.icm_stacks);
        if (self.icm_payouts.len != 0) self.allocator.free(self.icm_payouts);
        for (self.incentive_rules) |rule| {
            if (rule.key.len != 0) self.allocator.free(rule.key);
        }
        if (self.incentive_rules.len != 0) self.allocator.free(self.incentive_rules);
        for (self.incentive_edge_tags) |spec| {
            if (spec.action_key.len != 0) self.allocator.free(spec.action_key);
            for (spec.tags) |tag| self.allocator.free(tag);
            if (spec.tags.len != 0) self.allocator.free(spec.tags);
        }
        if (self.incentive_edge_tags.len != 0) self.allocator.free(self.incentive_edge_tags);
        if (self.deals.len != 0) self.allocator.free(self.deals);
        if (self.slots.len != 0) self.allocator.free(self.slots);
        self.runouts.deinit(self.allocator);
        self.hands.deinit(self.allocator);
        self.* = .{ .allocator = self.allocator };
    }

    pub fn cardKey(self: CompiledGame, node: Node, hand: i32, turn: i32, river: i32) CompileError!i32 {
        if (node.card_mode == 0) return hand;
        if (node.card_mode == 1) {
            const c = if (node.mode1_is_turn) turn else river;
            const runout = self.runouts.mode1_of[@intCast(c)];
            if (runout < 0) return error.InvalidCompile;
            return runout * node.hands + hand;
        }
        if (self.runouts.mode2_of.len == 0) return error.InvalidCompile;
        const runout = self.runouts.mode2_of[@intCast(turn * 52 + river)];
        if (runout < 0) return error.InvalidCompile;
        return runout * node.hands + hand;
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
    game.first_to_act = spec.first_to_act;
    game.rake = .{ .rate = spec.rake.rate, .cap = spec.rake.cap };
    if (spec.icm.stacks.len != 0) {
        game.icm_stacks = allocator.dupe(f64, spec.icm.stacks) catch return error.OutOfMemory;
        game.icm_payouts = allocator.dupe(f64, spec.icm.payouts) catch return error.OutOfMemory;
    }
    try copyIncentives(allocator, &game, spec);

    try buildRunoutIndex(allocator, &game);
    try buildPublicTree(allocator, &game, spec);
    try buildHandIndex(allocator, &game, spec);
    try setHandCounts(&game);
    try fillTerminalIncentives(allocator, &game);
    try buildDeals(allocator, &game, spec);
    try buildPolicyMap(allocator, &game);
    return game;
}

fn copyIncentives(allocator: std.mem.Allocator, game: *CompiledGame, spec: street_spec.StreetSpec) CompileError!void {
    if (spec.incentives.rules.len != 0) {
        var rules = allocator.alloc(street_spec.IncentiveRule, spec.incentives.rules.len) catch return error.OutOfMemory;
        errdefer allocator.free(rules);
        for (spec.incentives.rules, 0..) |rule, i| {
            rules[i] = .{
                .kind = rule.kind,
                .player = rule.player,
                .key = allocator.dupe(u8, rule.key) catch return error.OutOfMemory,
                .delta = rule.delta,
            };
        }
        game.incentive_rules = rules;
    }
    if (spec.incentives.edge_tags.len != 0) {
        var tags = allocator.alloc(street_spec.IncentiveEdgeTagSpec, spec.incentives.edge_tags.len) catch return error.OutOfMemory;
        errdefer allocator.free(tags);
        for (spec.incentives.edge_tags, 0..) |spec_tag, i| {
            var owned_tags = allocator.alloc([]const u8, spec_tag.tags.len) catch return error.OutOfMemory;
            for (spec_tag.tags, 0..) |tag, ti| {
                owned_tags[ti] = allocator.dupe(u8, tag) catch return error.OutOfMemory;
            }
            tags[i] = .{
                .player = spec_tag.player,
                .action_key = allocator.dupe(u8, spec_tag.action_key) catch return error.OutOfMemory,
                .tags = owned_tags,
            };
        }
        game.incentive_edge_tags = tags;
    }
}

fn setHandCounts(game: *CompiledGame) CompileError!void {
    for (game.nodes) |*node| {
        if (node.kind != .decision) continue;
        node.hands = if (node.player == 0) game.hands.nHands(0) else game.hands.nHands(1);
    }
}

fn compactFromDisplay(label: []const u8, buf: []u8) []const u8 {
    if (std.mem.eql(u8, label, "Fold")) return "f";
    if (std.mem.eql(u8, label, "Check")) return "c";
    if (std.mem.eql(u8, label, "Call")) return "call";
    var core = label;
    var all_in = false;
    if (std.mem.endsWith(u8, core, " all-in")) {
        all_in = true;
        core = core[0 .. core.len - " all-in".len];
    }
    var fbs = std.io.fixedBufferStream(buf);
    const w = fbs.writer();
    if (core.len > 4 and std.mem.eql(u8, core[0..4], "Bet ")) {
        w.print("b{s}", .{core[4..]}) catch return label;
        if (all_in) w.writeAll("ai") catch {};
        return fbs.getWritten();
    }
    if (core.len > 9 and std.mem.eql(u8, core[0..9], "Raise to ")) {
        w.print("r{s}", .{core[9..]}) catch return label;
        if (all_in) w.writeAll("ai") catch {};
        return fbs.getWritten();
    }
    return label;
}

fn fillTerminalIncentives(allocator: std.mem.Allocator, game: *CompiledGame) CompileError!void {
    if (game.incentive_rules.len == 0) return;
    _ = allocator;
    var index: i32 = 0;
    while (index < @as(i32, @intCast(game.nodes.len))) : (index += 1) {
        if (game.nodes[@intCast(index)].kind != .terminal) continue;
        var path_players: [64]i32 = undefined;
        var path_display: [64][]const u8 = undefined;
        var path_compact_bufs: [64][64]u8 = undefined;
        var path_compact: [64][]const u8 = undefined;
        var path_len: usize = 0;
        var at = index;
        while (at >= 0) {
            const link_parent = game.nodes[@intCast(at)].parent;
            if (link_parent < 0) break;
            const from_chance = game.nodes[@intCast(at)].from_chance;
            const action = game.nodes[@intCast(at)].parent_action;
            if (!from_chance and action >= 0) {
                const parent = game.nodes[@intCast(link_parent)];
                const display = parent.action_labels[@intCast(action)];
                path_players[path_len] = parent.player;
                path_display[path_len] = display;
                path_compact[path_len] = compactFromDisplay(display, &path_compact_bufs[path_len]);
                path_len += 1;
            }
            at = link_parent;
        }
        // Reverse to root→terminal order (walk collected leaf→root).
        var lo: usize = 0;
        var hi = path_len;
        while (lo < hi) {
            hi -= 1;
            if (lo >= hi) break;
            const tp = path_players[lo];
            path_players[lo] = path_players[hi];
            path_players[hi] = tp;
            const td = path_display[lo];
            path_display[lo] = path_display[hi];
            path_display[hi] = td;
            const tc = path_compact[lo];
            path_compact[lo] = path_compact[hi];
            path_compact[hi] = tc;
            lo += 1;
        }
        var incentive0: f64 = 0;
        var incentive1: f64 = 0;
        var step: usize = 0;
        while (step < path_len) : (step += 1) {
            for (game.incentive_rules) |rule| {
                if (rule.player != path_players[step]) continue;
                if (rule.kind == .action_label_match) {
                    if (std.mem.eql(u8, rule.key, path_compact[step]) or std.mem.eql(u8, rule.key, path_display[step])) {
                        if (rule.player == 0) incentive0 += rule.delta else incentive1 += rule.delta;
                    }
                }
                // CategoryTag needs edge tags — attach_edge_tags omitted unless tags present.
                if (rule.kind == .category_tag) {
                    for (game.incentive_edge_tags) |etag| {
                        if (etag.player >= 0 and etag.player != path_players[step]) continue;
                        if (!std.mem.eql(u8, etag.action_key, path_compact[step]) and !std.mem.eql(u8, etag.action_key, path_display[step])) continue;
                        for (etag.tags) |tag| {
                            if (std.mem.eql(u8, tag, rule.key)) {
                                if (rule.player == 0) incentive0 += rule.delta else incentive1 += rule.delta;
                            }
                        }
                    }
                }
            }
        }
        game.nodes[@intCast(index)].incentive_u0 = incentive0;
        game.nodes[@intCast(index)].incentive_u1 = incentive1;
    }
}

fn buildDeals(allocator: std.mem.Allocator, game: *CompiledGame, spec: street_spec.StreetSpec) CompileError!void {
    var deals = std.ArrayList(Deal).init(allocator);
    errdefer deals.deinit();
    var first: i32 = 0;
    while (first < card.combo_count) : (first += 1) {
        const w0 = spec.oop.weights[@intCast(first)];
        if (w0 == 0.0) continue;
        const h0 = game.hands.combo_to_hand[0][@intCast(first)];
        if (h0 < 0) continue;
        var second: i32 = 0;
        while (second < card.combo_count) : (second += 1) {
            const w1 = spec.ip.weights[@intCast(second)];
            if (w1 == 0.0) continue;
            const h1 = game.hands.combo_to_hand[1][@intCast(second)];
            if (h1 < 0) continue;
            const pair0 = range_mod.Range.comboCards(first) catch continue;
            const pair1 = range_mod.Range.comboCards(second) catch continue;
            if (pair0[0] == pair1[0] or pair0[0] == pair1[1] or pair0[1] == pair1[0] or pair0[1] == pair1[1]) continue;
            var blocked = false;
            for (game.board) |b| {
                if (b == pair0[0] or b == pair0[1] or b == pair1[0] or b == pair1[1]) {
                    blocked = true;
                    break;
                }
            }
            if (blocked) continue;
            deals.append(.{
                .h0 = h0,
                .h1 = h1,
                .combo0 = first,
                .combo1 = second,
                .c0 = pair0[0],
                .c1 = pair0[1],
                .d0 = pair1[0],
                .d1 = pair1[1],
                .probability = (w0 * w1) / game.hands.joint_mass,
            }) catch return error.OutOfMemory;
        }
    }
    if (deals.items.len != game.hands.counted_deals) return error.InvalidCompile;
    game.deals = deals.toOwnedSlice() catch return error.OutOfMemory;
}

const Support = struct {
    compatible: i32 = 0,
    contain: [52]i32 = .{0} ** 52,
};

fn buildPolicyMap(allocator: std.mem.Allocator, game: *CompiledGame) CompileError!void {
    var on_board: [52]bool = .{false} ** 52;
    for (game.board) |c| on_board[@intCast(c)] = true;

    var support: [2][]Support = .{ &.{}, &.{} };
    defer {
        if (support[0].len != 0) allocator.free(support[0]);
        if (support[1].len != 0) allocator.free(support[1]);
    }
    inline for (0..2) |player| {
        const count = game.hands.combos[player].len;
        support[player] = allocator.alloc(Support, count) catch return error.OutOfMemory;
        @memset(support[player], .{});
        const opp = 1 - player;
        const opp_count = game.hands.combos[opp].len;
        var hand: usize = 0;
        while (hand < count) : (hand += 1) {
            const c0 = game.hands.hole_low[player][hand];
            const c1 = game.hands.hole_high[player][hand];
            var other: usize = 0;
            while (other < opp_count) : (other += 1) {
                const d0 = game.hands.hole_low[opp][other];
                const d1 = game.hands.hole_high[opp][other];
                if (d0 == c0 or d0 == c1 or d1 == c0 or d1 == c1) continue;
                support[player][hand].compatible += 1;
                support[player][hand].contain[@intCast(d0)] += 1;
                support[player][hand].contain[@intCast(d1)] += 1;
            }
        }
    }

    // Allocate slot_of maps.
    for (game.nodes) |*node| {
        if (node.kind != .decision or node.n_actions <= 1) continue;
        const dim = game.runouts.runoutDim(node.*) * @as(u64, @intCast(node.hands));
        node.slot_of = allocator.alloc(i32, @intCast(dim)) catch return error.OutOfMemory;
        @memset(node.slot_of, -1);
    }

    var slots = std.ArrayList(Slot).init(allocator);
    errdefer slots.deinit();
    var cursor: i32 = 0;

    var node_index: i32 = 0;
    while (node_index < @as(i32, @intCast(game.nodes.len))) : (node_index += 1) {
        const node = &game.nodes[@intCast(node_index)];
        if (node.kind != .decision) continue;
        const player: usize = @intCast(node.player);
        var hand: i32 = 0;
        while (hand < node.hands) : (hand += 1) {
            const row = support[player][@intCast(hand)];
            const c0 = game.hands.hole_low[player][@intCast(hand)];
            const c1 = game.hands.hole_high[player][@intCast(hand)];
            if (node.card_mode == 0) {
                try considerSlot(game, &slots, &cursor, node_index, hand, -1, -1);
                continue;
            }
            if (node.card_mode == 1) {
                var c: i32 = 0;
                while (c < 52) : (c += 1) {
                    if (on_board[@intCast(c)] or c == c0 or c == c1) continue;
                    if (row.compatible - row.contain[@intCast(c)] <= 0) continue;
                    if (node.mode1_is_turn) {
                        try considerSlot(game, &slots, &cursor, node_index, hand, c, -1);
                    } else {
                        try considerSlot(game, &slots, &cursor, node_index, hand, -1, c);
                    }
                }
                continue;
            }
            var turn: i32 = 0;
            while (turn < 52) : (turn += 1) {
                if (on_board[@intCast(turn)] or turn == c0 or turn == c1) continue;
                var river: i32 = 0;
                while (river < 52) : (river += 1) {
                    if (river == turn or on_board[@intCast(river)] or river == c0 or river == c1) continue;
                    var blocked = row.contain[@intCast(turn)] + row.contain[@intCast(river)];
                    const pair = range_mod.Range.comboIndex(turn, river) catch continue;
                    if (game.hands.combo_to_hand[1 - player][@intCast(pair)] >= 0) blocked -= 1;
                    if (row.compatible - blocked <= 0) continue;
                    try considerSlot(game, &slots, &cursor, node_index, hand, turn, river);
                }
            }
        }
    }
    game.slots = slots.toOwnedSlice() catch return error.OutOfMemory;
    game.table_entries = cursor;
}

fn considerSlot(
    game: *CompiledGame,
    slots: *std.ArrayList(Slot),
    cursor: *i32,
    node_index: i32,
    hand: i32,
    turn: i32,
    river: i32,
) CompileError!void {
    const node = &game.nodes[@intCast(node_index)];
    if (node.n_actions <= 1) return;
    const key = try game.cardKey(node.*, hand, turn, river);
    const slot_index: i32 = @intCast(slots.items.len);
    node.slot_of[@intCast(key)] = slot_index;
    slots.append(.{
        .node = node_index,
        .base = cursor.*,
        .hand = @intCast(hand),
        .turn = @intCast(turn),
        .river = @intCast(river),
    }) catch return error.OutOfMemory;
    cursor.* += node.n_actions;
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
        nodes.items[@intCast(child)].parent = @intCast(id);
        nodes.items[@intCast(child)].parent_action = -1;
        nodes.items[@intCast(child)].from_chance = true;
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
        nodes.items[@intCast(child)].parent = @intCast(id);
        nodes.items[@intCast(child)].parent_action = action;
        nodes.items[@intCast(child)].from_chance = false;
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
