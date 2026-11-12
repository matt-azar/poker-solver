const std = @import("std");
const card = @import("../poker/card.zig");
const range_mod = @import("../poker/range.zig");
const hand_eval = @import("../poker/hand_eval.zig");
const compile = @import("../game/compile.zig");
const training_state = @import("../solve/training_state.zig");

pub const EquityError = error{ InvalidEquity, OutOfMemory, WorkLimit, InvalidWeight };

/// C++ `kFullRangeTurnPairRunouts` / Study packaging ceiling.
pub const full_range_turn_pair_runouts: u64 = 51_369_120;
/// C++ `kDefaultMaxPairRunouts` (library / Equity Calculator default).
pub const default_max_pair_runouts: u64 = 1_100_000;
/// C++ `kStudyExplorerMaxPairRunouts` (= full-range turn).
pub const study_explorer_max_pair_runouts: u64 = full_range_turn_pair_runouts;
pub const equity_distribution_buckets: usize = 10;

pub const EquityDistributionBucket = struct {
    lo: f64 = 0,
    hi: f64 = 0,
    weight: f64 = 0,
};

pub const ComboEquity = struct {
    index: i32 = 0,
    combo: []const u8 = "",
    input_weight: f64 = 0,
    defined: bool = false,
    compatible_mass: f64 = 0,
    win: f64 = 0,
    tie: f64 = 0,
    loss: f64 = 0,
    equity: f64 = 0,
};

pub const PlayerEquity = struct {
    defined: bool = false,
    win: f64 = 0,
    tie: f64 = 0,
    loss: f64 = 0,
    equity: f64 = 0,
    combos: []ComboEquity = &.{},
};

pub const ShowdownEquity = struct {
    allocator: std.mem.Allocator,
    joint_defined: bool = false,
    pair_runouts: u64 = 0,
    player0: PlayerEquity = .{},
    player1: PlayerEquity = .{},

    pub fn deinit(self: *ShowdownEquity) void {
        freePlayer(self.allocator, &self.player0);
        freePlayer(self.allocator, &self.player1);
        self.* = .{ .allocator = self.allocator };
    }
};

fn freePlayer(allocator: std.mem.Allocator, player: *PlayerEquity) void {
    for (player.combos) |row| {
        if (row.combo.len != 0) allocator.free(row.combo);
    }
    if (player.combos.len != 0) allocator.free(player.combos);
    player.* = .{};
}

fn boardBlocked(board: []const card.Card, c0: card.Card, c1: card.Card) bool {
    for (board) |b| {
        if (b == c0 or b == c1) return true;
    }
    return false;
}

fn cardsOverlap(a0: card.Card, a1: card.Card, b0: card.Card, b1: card.Card) bool {
    return a0 == b0 or a0 == b1 or a1 == b0 or a1 == b1;
}

fn compareHoles(
    board: []const card.Card,
    h0: [2]card.Card,
    h1: [2]card.Card,
) EquityError!i32 {
    return hand_eval.compareShowdown(h0[0], h0[1], h1[0], h1[1], board) catch return error.InvalidEquity;
}

/// Check-down showdown equity for a fixed board (Phase 4: river first; flop/turn via enumeration).
/// Tie contributes half. Values are pot fractions in [0, 1], not chip EV.
pub fn showdownEquity(
    allocator: std.mem.Allocator,
    board: []const card.Card,
    range0: range_mod.Range,
    range1: range_mod.Range,
    max_pair_runouts: u64,
) EquityError!ShowdownEquity {
    if (board.len != 3 and board.len != 4 and board.len != 5) return error.InvalidEquity;
    card.validateBoard(board) catch return error.InvalidEquity;

    var result = ShowdownEquity{ .allocator = allocator };
    errdefer result.deinit();

    // Collect positive-weight combos.
    var combos0 = std.ArrayList(i32).init(allocator);
    defer combos0.deinit();
    var combos1 = std.ArrayList(i32).init(allocator);
    defer combos1.deinit();
    var index: i32 = 0;
    while (index < card.combo_count) : (index += 1) {
        if (range0.weights[@intCast(index)] > 0) combos0.append(index) catch return error.OutOfMemory;
        if (range1.weights[@intCast(index)] > 0) combos1.append(index) catch return error.OutOfMemory;
    }

    result.player0.combos = try allocComboRows(allocator, combos0.items, range0);
    result.player1.combos = try allocComboRows(allocator, combos1.items, range1);

    // Estimate work for river (board.len==5): one runout per legal pair.
    if (board.len == 5) {
        var legal: u64 = 0;
        for (combos0.items) |c0| {
            const p0 = range_mod.Range.comboCards(c0) catch continue;
            if (boardBlocked(board, p0[0], p0[1])) continue;
            for (combos1.items) |c1| {
                const p1 = range_mod.Range.comboCards(c1) catch continue;
                if (boardBlocked(board, p1[0], p1[1])) continue;
                if (cardsOverlap(p0[0], p0[1], p1[0], p1[1])) continue;
                legal += 1;
            }
        }
        result.pair_runouts = legal;
        if (legal > max_pair_runouts) return error.WorkLimit;
        try fillRiverEquity(&result, board, range0, range1, combos0.items, combos1.items);
        return result;
    }

    // Flop/turn: enumerate remaining boards (Phase 4 supports with work limit).
    var dead: [52]bool = .{false} ** 52;
    for (board) |c| dead[@intCast(c)] = true;
    var runouts = std.ArrayList([2]card.Card).init(allocator);
    defer runouts.deinit();
    if (board.len == 4) {
        var c: i32 = 0;
        while (c < 52) : (c += 1) {
            if (dead[@intCast(c)]) continue;
            runouts.append(.{ c, -1 }) catch return error.OutOfMemory;
        }
    } else {
        // Unordered flop completions C(n,2) — match C++ showdown_equity / Study.
        var t: i32 = 0;
        while (t < 52) : (t += 1) {
            if (dead[@intCast(t)]) continue;
            var r: i32 = t + 1;
            while (r < 52) : (r += 1) {
                if (dead[@intCast(r)]) continue;
                runouts.append(.{ t, r }) catch return error.OutOfMemory;
            }
        }
    }

    var legal_pairs: u64 = 0;
    for (combos0.items) |c0| {
        const p0 = range_mod.Range.comboCards(c0) catch continue;
        if (boardBlocked(board, p0[0], p0[1])) continue;
        for (combos1.items) |c1| {
            const p1 = range_mod.Range.comboCards(c1) catch continue;
            if (boardBlocked(board, p1[0], p1[1])) continue;
            if (cardsOverlap(p0[0], p0[1], p1[0], p1[1])) continue;
            // Count runouts that also avoid hole cards.
            var count: u64 = 0;
            for (runouts.items) |ro| {
                if (ro[0] == p0[0] or ro[0] == p0[1] or ro[0] == p1[0] or ro[0] == p1[1]) continue;
                if (board.len == 3) {
                    if (ro[1] == p0[0] or ro[1] == p0[1] or ro[1] == p1[0] or ro[1] == p1[1]) continue;
                }
                count += 1;
            }
            legal_pairs += count;
        }
    }
    result.pair_runouts = legal_pairs;
    if (legal_pairs > max_pair_runouts) return error.WorkLimit;
    try fillRunoutEquity(&result, board, range0, range1, combos0.items, combos1.items, runouts.items);
    return result;
}

fn allocComboRows(allocator: std.mem.Allocator, combos: []const i32, range: range_mod.Range) EquityError![]ComboEquity {
    var rows = allocator.alloc(ComboEquity, combos.len) catch return error.OutOfMemory;
    errdefer allocator.free(rows);
    for (combos, 0..) |combo, i| {
        var buf: [4]u8 = undefined;
        const text = range_mod.Range.comboText(combo, &buf) catch return error.InvalidEquity;
        rows[i] = .{
            .index = combo,
            .combo = allocator.dupe(u8, text) catch return error.OutOfMemory,
            .input_weight = range.weights[@intCast(combo)],
        };
    }
    return rows;
}

fn fillRiverEquity(
    result: *ShowdownEquity,
    board: []const card.Card,
    range0: range_mod.Range,
    range1: range_mod.Range,
    combos0: []const i32,
    combos1: []const i32,
) EquityError!void {
    _ = range0;
    _ = range1;
    var joint: f64 = 0;
    var win0: f64 = 0;
    var tie0: f64 = 0;
    var loss0: f64 = 0;

    for (combos0, 0..) |c0, row0| {
        const p0 = range_mod.Range.comboCards(c0) catch continue;
        if (boardBlocked(board, p0[0], p0[1])) continue;
        const w0 = result.player0.combos[row0].input_weight;
        for (combos1, 0..) |c1, row1| {
            const p1 = range_mod.Range.comboCards(c1) catch continue;
            if (boardBlocked(board, p1[0], p1[1])) continue;
            if (cardsOverlap(p0[0], p0[1], p1[0], p1[1])) continue;
            const w1 = result.player1.combos[row1].input_weight;
            const mass = w0 * w1;
            if (mass == 0) continue;
            const cmp = try compareHoles(board, .{ p0[0], p0[1] }, .{ p1[0], p1[1] });
            joint += mass;
            result.player0.combos[row0].compatible_mass += w1;
            result.player1.combos[row1].compatible_mass += w0;
            if (cmp > 0) {
                win0 += mass;
                result.player0.combos[row0].win += w1;
                result.player1.combos[row1].loss += w0;
            } else if (cmp < 0) {
                loss0 += mass;
                result.player0.combos[row0].loss += w1;
                result.player1.combos[row1].win += w0;
            } else {
                tie0 += mass;
                result.player0.combos[row0].tie += w1;
                result.player1.combos[row1].tie += w0;
            }
        }
    }

    if (joint <= 0) return;
    result.joint_defined = true;
    finalizePlayer(&result.player0, win0, tie0, loss0, joint);
    finalizePlayer(&result.player1, loss0, tie0, win0, joint);
}

fn fillRunoutEquity(
    result: *ShowdownEquity,
    board: []const card.Card,
    range0: range_mod.Range,
    range1: range_mod.Range,
    combos0: []const i32,
    combos1: []const i32,
    runouts: []const [2]card.Card,
) EquityError!void {
    _ = range0;
    _ = range1;
    var joint: f64 = 0;
    var win0: f64 = 0;
    var tie0: f64 = 0;
    var loss0: f64 = 0;
    var board_buf: [5]card.Card = undefined;
    @memcpy(board_buf[0..board.len], board);

    for (combos0, 0..) |c0, row0| {
        const p0 = range_mod.Range.comboCards(c0) catch continue;
        if (boardBlocked(board, p0[0], p0[1])) continue;
        const w0 = result.player0.combos[row0].input_weight;
        for (combos1, 0..) |c1, row1| {
            const p1 = range_mod.Range.comboCards(c1) catch continue;
            if (boardBlocked(board, p1[0], p1[1])) continue;
            if (cardsOverlap(p0[0], p0[1], p1[0], p1[1])) continue;
            const w1 = result.player1.combos[row1].input_weight;
            if (w0 * w1 == 0) continue;
            var local_win: f64 = 0;
            var local_tie: f64 = 0;
            var local_loss: f64 = 0;
            var runout_count: f64 = 0;
            for (runouts) |ro| {
                if (ro[0] == p0[0] or ro[0] == p0[1] or ro[0] == p1[0] or ro[0] == p1[1]) continue;
                var len = board.len;
                board_buf[len] = ro[0];
                len += 1;
                if (board.len == 3) {
                    if (ro[1] == p0[0] or ro[1] == p0[1] or ro[1] == p1[0] or ro[1] == p1[1]) continue;
                    board_buf[len] = ro[1];
                    len += 1;
                }
                const cmp = try compareHoles(board_buf[0..len], .{ p0[0], p0[1] }, .{ p1[0], p1[1] });
                runout_count += 1;
                if (cmp > 0) local_win += 1 else if (cmp < 0) local_loss += 1 else local_tie += 1;
            }
            if (runout_count == 0) continue;
            const mass = w0 * w1;
            const scale = mass / runout_count;
            joint += mass;
            result.player0.combos[row0].compatible_mass += w1;
            result.player1.combos[row1].compatible_mass += w0;
            win0 += scale * local_win;
            tie0 += scale * local_tie;
            loss0 += scale * local_loss;
            result.player0.combos[row0].win += (w1 / runout_count) * local_win;
            result.player0.combos[row0].tie += (w1 / runout_count) * local_tie;
            result.player0.combos[row0].loss += (w1 / runout_count) * local_loss;
            result.player1.combos[row1].win += (w0 / runout_count) * local_loss;
            result.player1.combos[row1].tie += (w0 / runout_count) * local_tie;
            result.player1.combos[row1].loss += (w0 / runout_count) * local_win;
        }
    }
    if (joint <= 0) return;
    result.joint_defined = true;
    finalizePlayer(&result.player0, win0, tie0, loss0, joint);
    finalizePlayer(&result.player1, loss0, tie0, win0, joint);
}

fn finalizePlayer(player: *PlayerEquity, win: f64, tie: f64, loss: f64, joint: f64) void {
    player.defined = true;
    player.win = win / joint;
    player.tie = tie / joint;
    player.loss = loss / joint;
    player.equity = player.win + 0.5 * player.tie;
    for (player.combos) |*row| {
        if (!(row.compatible_mass > 0)) continue;
        row.defined = true;
        const w = row.win / row.compatible_mass;
        const t = row.tie / row.compatible_mass;
        const l = row.loss / row.compatible_mass;
        row.win = w;
        row.tie = t;
        row.loss = l;
        row.equity = w + 0.5 * t;
    }
}

/// Check-down equity at a compiled game's board using its range weights / hands.
pub fn checkdownEquity(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    max_pair_runouts: u64,
) EquityError!ShowdownEquity {
    var r0 = range_mod.Range{};
    var r1 = range_mod.Range{};
    for (game.hands.combos[0], 0..) |combo, i| {
        r0.weights[@intCast(combo)] = game.hands.range_w[0][i];
    }
    for (game.hands.combos[1], 0..) |combo, i| {
        r1.weights[@intCast(combo)] = game.hands.range_w[1][i];
    }
    return showdownEquity(allocator, game.board, r0, r1, max_pair_runouts);
}

fn handBlocksCards(game: compile.CompiledGame, player: usize, hand: usize, turn: i32, river: i32) bool {
    const c0 = game.hands.hole_low[player][hand];
    const c1 = game.hands.hole_high[player][hand];
    for (game.board) |b| {
        if (b == c0 or b == c1) return true;
    }
    if (turn >= 0 and (@as(card.Card, @intCast(turn)) == c0 or @as(card.Card, @intCast(turn)) == c1)) return true;
    if (river >= 0 and (@as(card.Card, @intCast(river)) == c0 or @as(card.Card, @intCast(river)) == c1)) return true;
    return false;
}

fn handStructurallySupported(game: compile.CompiledGame, player: usize, hand: usize, turn: i32, river: i32) bool {
    if (!(game.hands.range_w[player][hand] > 0)) return false;
    if (handBlocksCards(game, player, hand, turn, river)) return false;
    const opp: usize = 1 - player;
    const n_opp: usize = @intCast(@max(game.hands.nHands(opp), 0));
    const a0 = game.hands.hole_low[player][hand];
    const a1 = game.hands.hole_high[player][hand];
    var oh: usize = 0;
    while (oh < n_opp) : (oh += 1) {
        if (!(game.hands.range_w[opp][oh] > 0)) continue;
        if (handBlocksCards(game, opp, oh, turn, river)) continue;
        const b0 = game.hands.hole_low[opp][oh];
        const b1 = game.hands.hole_high[opp][oh];
        if (a0 == b0 or a0 == b1 or a1 == b0 or a1 == b1) continue;
        return true;
    }
    return false;
}

fn zeroCard(game: compile.CompiledGame, reach: []f64, player: usize, dealt: i32) void {
    if (dealt < 0) return;
    const dealt_c: card.Card = @intCast(dealt);
    var hand: usize = 0;
    while (hand < reach.len) : (hand += 1) {
        if (!(reach[hand] > 0)) continue;
        const c0 = game.hands.hole_low[player][hand];
        const c1 = game.hands.hole_high[player][hand];
        if (c0 == dealt_c or c1 == dealt_c) reach[hand] = 0;
    }
}

fn zeroUnsupported(game: compile.CompiledGame, reach: []f64, player: usize, turn: i32, river: i32) void {
    var hand: usize = 0;
    while (hand < reach.len) : (hand += 1) {
        if (!(reach[hand] > 0)) continue;
        if (!handStructurallySupported(game, player, hand, turn, river)) reach[hand] = 0;
    }
}

/// C++ `StreetBatchSolver::Engine::replay_weights`: independent per-player reach
/// along the betting/chance line (own actions × card removal). Same scale for
/// flop, turn, and river Study inspect / equity / categories — unit-weight live
/// hands stay ≈ 1 (not deal-joint mass). Caller frees q0/q1.
pub fn replayReachWeights(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    sigma: []const f32,
    node_index: u32,
    turn: i32,
    river: i32,
) EquityError!struct { q0: []f64, q1: []f64 } {
    if (node_index >= game.nodes.len) return error.InvalidEquity;

    var chain_buf: [128]u32 = undefined;
    var depth: usize = 0;
    var at = node_index;
    while (true) {
        if (depth >= chain_buf.len) return error.InvalidEquity;
        chain_buf[depth] = at;
        depth += 1;
        const parent = game.nodes[at].parent;
        if (parent < 0) break;
        at = @intCast(parent);
    }
    std.mem.reverse(u32, chain_buf[0..depth]);
    if (depth == 0 or chain_buf[0] != 0) return error.InvalidEquity;

    const n0: usize = @intCast(@max(game.hands.nHands(0), 0));
    const n1: usize = @intCast(@max(game.hands.nHands(1), 0));
    const q0 = allocator.alloc(f64, n0) catch return error.OutOfMemory;
    errdefer allocator.free(q0);
    const q1 = allocator.alloc(f64, n1) catch return error.OutOfMemory;
    errdefer allocator.free(q1);
    if (n0 != 0) @memcpy(q0, game.hands.range_w[0][0..n0]);
    if (n1 != 0) @memcpy(q1, game.hands.range_w[1][0..n1]);

    var seen_turn: i32 = -1;
    var seen_river: i32 = -1;
    zeroUnsupported(game, q0, 0, seen_turn, seen_river);
    zeroUnsupported(game, q1, 1, seen_turn, seen_river);

    var step: usize = 0;
    while (step + 1 < depth) : (step += 1) {
        const current = chain_buf[step];
        const next = chain_buf[step + 1];
        const node = game.nodes[current];
        if (game.nodes[next].parent != @as(i32, @intCast(current))) return error.InvalidEquity;

        if (node.kind == .chance) {
            const dealt: i32 = if (node.deal_which == 1) turn else river;
            if (dealt < 0) return error.InvalidEquity;
            zeroCard(game, q0, 0, dealt);
            zeroCard(game, q1, 1, dealt);
            if (node.deal_which == 1) {
                seen_turn = dealt;
            } else {
                seen_river = dealt;
            }
            zeroUnsupported(game, q0, 0, seen_turn, seen_river);
            zeroUnsupported(game, q1, 1, seen_turn, seen_river);
            continue;
        }

        if (node.kind != .decision) return error.InvalidEquity;
        const action = game.nodes[next].parent_action;
        if (action < 0) return error.InvalidEquity;
        const player: usize = if (node.player == 0) 0 else 1;
        const acting = if (player == 0) q0 else q1;
        var hand: usize = 0;
        while (hand < acting.len) : (hand += 1) {
            if (!(acting[hand] > 0)) continue;
            if (!handStructurallySupported(game, player, hand, seen_turn, seen_river)) {
                acting[hand] = 0;
                continue;
            }
            if (node.n_actions <= 1) continue;
            const key = game.cardKey(node, @intCast(hand), seen_turn, seen_river) catch {
                acting[hand] = 0;
                continue;
            };
            if (key < 0 or @as(usize, @intCast(key)) >= node.slot_of.len) {
                acting[hand] = 0;
                continue;
            }
            const slot_i = node.slot_of[@intCast(key)];
            if (slot_i < 0) {
                acting[hand] = 0;
                continue;
            }
            const base: usize = @intCast(game.slots[@intCast(slot_i)].base);
            const sigma_i = base + @as(usize, @intCast(action));
            if (sigma_i >= sigma.len) {
                acting[hand] = 0;
                continue;
            }
            acting[hand] *= @as(f64, @floatCast(sigma[sigma_i]));
        }
    }

    if (seen_turn != turn or seen_river != river) return error.InvalidEquity;
    return .{ .q0 = q0, .q1 = q1 };
}

fn boardThroughNode(
    game: compile.CompiledGame,
    turn: i32,
    river: i32,
    out: *[5]card.Card,
) EquityError![]const card.Card {
    var n: usize = 0;
    for (game.board) |c| {
        if (n >= out.len) return error.InvalidEquity;
        out[n] = c;
        n += 1;
    }
    if (turn >= 0) {
        if (n >= out.len) return error.InvalidEquity;
        out[n] = @intCast(turn);
        n += 1;
    }
    if (river >= 0) {
        if (n >= out.len) return error.InvalidEquity;
        out[n] = @intCast(river);
        n += 1;
    }
    if (n != 3 and n != 4 and n != 5) return error.InvalidEquity;
    return out[0..n];
}

/// Study node check-down equity: both players' strategy-conditioned reach along
/// the line, board through the node, pair enumeration. Zero-weight hands are
/// omitted from showdownEquity inputs and aggregates (ZR-95 / audit P0-2).
pub fn checkdownEquityAtNode(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    published: training_state.PublishedPolicy,
    node_index: u32,
    turn: i32,
    river: i32,
    max_pair_runouts: u64,
) EquityError!ShowdownEquity {
    var owned_sigma: ?[]f32 = null;
    defer if (owned_sigma) |buf| allocator.free(buf);
    const sigma: []const f32 = blk: {
        if (published.average.len != 0) break :blk published.average;
        var uniform = training_state.TrainingState.init(allocator, game) catch return error.OutOfMemory;
        defer uniform.deinit();
        owned_sigma = allocator.dupe(f32, uniform.sigma) catch return error.OutOfMemory;
        break :blk owned_sigma.?;
    };

    const reach = try replayReachWeights(allocator, game, sigma, node_index, turn, river);
    defer {
        allocator.free(reach.q0);
        allocator.free(reach.q1);
    }

    var r0 = range_mod.Range{};
    var r1 = range_mod.Range{};
    for (game.hands.combos[0], 0..) |combo, i| {
        if (i < reach.q0.len and reach.q0[i] > 0 and std.math.isFinite(reach.q0[i])) {
            r0.weights[@intCast(combo)] = reach.q0[i];
        }
    }
    for (game.hands.combos[1], 0..) |combo, i| {
        if (i < reach.q1.len and reach.q1[i] > 0 and std.math.isFinite(reach.q1[i])) {
            r1.weights[@intCast(combo)] = reach.q1[i];
        }
    }

    var board_buf: [5]card.Card = undefined;
    const board = try boardThroughNode(game, turn, river, &board_buf);
    return showdownEquity(allocator, board, r0, r1, max_pair_runouts);
}

pub fn emptyEquityDistribution() [equity_distribution_buckets]EquityDistributionBucket {
    var buckets: [equity_distribution_buckets]EquityDistributionBucket = undefined;
    var i: usize = 0;
    while (i < equity_distribution_buckets) : (i += 1) {
        buckets[i] = .{
            .lo = @as(f64, @floatFromInt(i)) / @as(f64, @floatFromInt(equity_distribution_buckets)),
            .hi = @as(f64, @floatFromInt(i + 1)) / @as(f64, @floatFromInt(equity_distribution_buckets)),
            .weight = 0,
        };
    }
    return buckets;
}

/// Ten-bucket Study histogram over [0,1]; last bucket includes 1.0.
pub fn equityDistribution(equities: []const f64, weights: []const f64) EquityError![equity_distribution_buckets]EquityDistributionBucket {
    if (equities.len != weights.len) return error.InvalidEquity;
    var buckets = emptyEquityDistribution();
    for (equities, weights) |eq_in, weight| {
        if (!std.math.isFinite(weight) or weight < 0.0) return error.InvalidWeight;
        if (weight == 0.0) continue;
        if (!std.math.isFinite(eq_in)) return error.InvalidEquity;
        var equity = eq_in;
        if (equity < 0.0) equity = 0.0 else if (equity > 1.0) equity = 1.0;
        var index: usize = @intFromFloat(equity * @as(f64, @floatFromInt(equity_distribution_buckets)));
        if (index >= equity_distribution_buckets) index = equity_distribution_buckets - 1;
        buckets[index].weight += weight;
    }
    return buckets;
}

pub fn equityDistributionFromPlayer(player: PlayerEquity) EquityError![equity_distribution_buckets]EquityDistributionBucket {
    var eqs: [1326]f64 = undefined;
    var ws: [1326]f64 = undefined;
    var n: usize = 0;
    for (player.combos) |row| {
        if (!row.defined or !(row.input_weight > 0)) continue;
        eqs[n] = row.equity;
        ws[n] = row.input_weight;
        n += 1;
    }
    return equityDistribution(eqs[0..n], ws[0..n]);
}
