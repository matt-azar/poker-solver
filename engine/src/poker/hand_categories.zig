//! Strategy-weighted made-hand category mass (Study Categories tab).
//! Five-card boards only; flop/turn draw tags are deferred.
const std = @import("std");
const card = @import("card.zig");
const hand_eval = @import("hand_eval.zig");
const range_mod = @import("range.zig");

pub const hand_category_count: usize = 9;
pub const category_model = "made-hand";

pub const CategoriesError = error{ InvalidCategories, OutOfMemory };

pub const PlayerCategoryMass = struct {
    defined: bool = false,
    total_mass: f64 = 0,
    mass: [hand_category_count]f64 = .{0} ** hand_category_count,
    fraction: [hand_category_count]f64 = .{0} ** hand_category_count,
};

pub const CategoryComposition = struct {
    model: []const u8 = category_model,
    available: bool = false,
    exclusive: bool = true,
    reason: []const u8 = "",
    /// Owned copy of the board through the node (length `board_len`).
    board_cards: [5]card.Card = .{0} ** 5,
    board_len: usize = 0,
    player0: PlayerCategoryMass = .{},
    player1: PlayerCategoryMass = .{},

    pub fn board(self: *const CategoryComposition) []const card.Card {
        return self.board_cards[0..self.board_len];
    }
};

pub fn categoryName(category: hand_eval.HandCategory) []const u8 {
    return switch (category) {
        .high_card => "high card",
        .pair => "pair",
        .two_pair => "two pair",
        .three_of_a_kind => "three of a kind",
        .straight => "straight",
        .flush => "flush",
        .full_house => "full house",
        .four_of_a_kind => "four of a kind",
        .straight_flush => "straight flush",
    };
}

fn boardBlocks(board: []const card.Card, c0: card.Card, c1: card.Card) bool {
    for (board) |b| {
        if (b == c0 or b == c1) return true;
    }
    return false;
}

/// Best five-card made-hand category for hole + five-card board.
pub fn madeHandCategory(hole0: card.Card, hole1: card.Card, board: []const card.Card) CategoriesError!hand_eval.HandCategory {
    if (board.len != 5) return error.InvalidCategories;
    card.validateBoard(board) catch return error.InvalidCategories;
    if (!card.validCard(hole0) or !card.validCard(hole1) or hole0 == hole1) return error.InvalidCategories;
    if (boardBlocks(board, hole0, hole1)) return error.InvalidCategories;
    var cards: [7]card.Card = undefined;
    cards[0] = hole0;
    cards[1] = hole1;
    @memcpy(cards[2..][0..5], board[0..5]);
    const value = hand_eval.evaluate(cards[0..7]) catch return error.InvalidCategories;
    return value.category;
}

fn composePlayer(board: []const card.Card, range: range_mod.Range) CategoriesError!PlayerCategoryMass {
    var out = PlayerCategoryMass{};
    var index: i32 = 0;
    while (index < card.combo_count) : (index += 1) {
        const weight = range.weights[@intCast(index)];
        if (!(weight > 0.0) or !std.math.isFinite(weight)) continue;
        const holes = range_mod.Range.comboCards(index) catch continue;
        if (boardBlocks(board, holes[0], holes[1])) continue;
        const category = madeHandCategory(holes[0], holes[1], board) catch continue;
        const slot: usize = @intFromEnum(category);
        out.mass[slot] += weight;
        out.total_mass += weight;
    }
    if (!(out.total_mass > 0.0) or !std.math.isFinite(out.total_mass)) {
        return out;
    }
    out.defined = true;
    var slot: usize = 0;
    while (slot < hand_category_count) : (slot += 1) {
        out.fraction[slot] = out.mass[slot] / out.total_mass;
    }
    return out;
}

/// Board length 5 → made-hand composition. Shorter boards set available=false.
/// Draw/backdoor tags for flop/turn are not implemented on Zig yet.
pub fn categoryComposition(
    board_in: []const card.Card,
    range0: range_mod.Range,
    range1: range_mod.Range,
) CategoriesError!CategoryComposition {
    var report = CategoryComposition{};
    if (board_in.len <= 5) {
        @memcpy(report.board_cards[0..board_in.len], board_in);
        report.board_len = board_in.len;
    } else {
        report.available = false;
        report.reason = "made-hand categories require a five-card board";
        return report;
    }
    if (board_in.len != 5) {
        report.available = false;
        report.reason = if (board_in.len == 3 or board_in.len == 4)
            "draw/backdoor categories are not available on Zig IPC yet; made-hand categories require a five-card board"
        else
            "made-hand categories require a five-card board";
        return report;
    }
    card.validateBoard(board_in) catch {
        report.available = false;
        report.reason = "invalid board";
        return report;
    };
    report.available = true;
    report.player0 = try composePlayer(board_in, range0);
    report.player1 = try composePlayer(board_in, range1);
    return report;
}

test "made-hand category pins quads and full house" {
    const board = [_]card.Card{
        try card.parseCard("Ah"),
        try card.parseCard("Ad"),
        try card.parseCard("7c"),
        try card.parseCard("4s"),
        try card.parseCard("2h"),
    };
    try std.testing.expectEqual(
        hand_eval.HandCategory.four_of_a_kind,
        try madeHandCategory(try card.parseCard("As"), try card.parseCard("Ac"), &board),
    );
    try std.testing.expectEqual(
        hand_eval.HandCategory.full_house,
        try madeHandCategory(try card.parseCard("7d"), try card.parseCard("7s"), &board),
    );
}

test "weighted mix trips vs pair fractions" {
    const board = [_]card.Card{
        try card.parseCard("Ah"),
        try card.parseCard("Kd"),
        try card.parseCard("7c"),
        try card.parseCard("4s"),
        try card.parseCard("2h"),
    };
    const r0 = try range_mod.Range.parse("AcAd:1,QcQs:3");
    const r1 = try range_mod.Range.parse("2c3d");
    const report = try categoryComposition(&board, r0, r1);
    try std.testing.expect(report.available);
    try std.testing.expect(report.player0.defined);
    try std.testing.expectApproxEqAbs(@as(f64, 4.0), report.player0.total_mass, 1e-12);
    try std.testing.expectApproxEqAbs(
        @as(f64, 0.25),
        report.player0.fraction[@intFromEnum(hand_eval.HandCategory.three_of_a_kind)],
        1e-12,
    );
    try std.testing.expectApproxEqAbs(
        @as(f64, 0.75),
        report.player0.fraction[@intFromEnum(hand_eval.HandCategory.pair)],
        1e-12,
    );
}

test "short board unavailable" {
    const board = [_]card.Card{
        try card.parseCard("Ah"),
        try card.parseCard("Kd"),
        try card.parseCard("7c"),
    };
    const r0 = try range_mod.Range.parse("AcAd");
    const r1 = try range_mod.Range.parse("QcQs");
    const report = try categoryComposition(&board, r0, r1);
    try std.testing.expect(!report.available);
    try std.testing.expect(std.mem.indexOf(u8, report.reason, "five-card") != null);
}
