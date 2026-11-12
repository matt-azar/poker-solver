const std = @import("std");
const card = @import("../poker/card.zig");
const range_mod = @import("../poker/range.zig");
const hand_eval = @import("../poker/hand_eval.zig");
const compile = @import("../game/compile.zig");

pub const EquityError = error{ InvalidEquity, OutOfMemory, WorkLimit };

pub const default_max_pair_runouts: u64 = 1_100_000;

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
        var t: i32 = 0;
        while (t < 52) : (t += 1) {
            if (dead[@intCast(t)]) continue;
            var r: i32 = 0;
            while (r < 52) : (r += 1) {
                if (r == t or dead[@intCast(r)]) continue;
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
