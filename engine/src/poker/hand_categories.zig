//! Strategy-weighted category mass (Study Categories tab).
//! Five-card boards → exclusive made-hand. Flop/turn → multi-label draws/backdoors.
const std = @import("std");
const card = @import("card.zig");
const hand_eval = @import("hand_eval.zig");
const range_mod = @import("range.zig");

pub const hand_category_count: usize = 9;
pub const draw_category_count: usize = 5;
pub const max_category_count: usize = hand_category_count;
pub const category_model = "made-hand";
pub const draw_category_model = "draws";

pub const CategoriesError = error{ InvalidCategories, OutOfMemory };

pub const DrawCategory = enum(u8) {
    flush_draw = 0,
    oesd = 1,
    gutshot = 2,
    backdoor_flush = 3,
    backdoor_straight = 4,
};

pub const DrawFlags = struct {
    flush_draw: bool = false,
    oesd: bool = false,
    gutshot: bool = false,
    backdoor_flush: bool = false,
    backdoor_straight: bool = false,
};

pub const PlayerCategoryMass = struct {
    defined: bool = false,
    total_mass: f64 = 0,
    /// Active slot count (9 made-hand or 5 draws).
    count: usize = hand_category_count,
    mass: [max_category_count]f64 = .{0} ** max_category_count,
    fraction: [max_category_count]f64 = .{0} ** max_category_count,
};

pub const CategoryComposition = struct {
    model: []const u8 = category_model,
    available: bool = false,
    exclusive: bool = true,
    reason: []const u8 = "",
    category_count: usize = hand_category_count,
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

pub fn drawCategoryName(category: DrawCategory) []const u8 {
    return switch (category) {
        .flush_draw => "flush draw",
        .oesd => "oesd",
        .gutshot => "gutshot",
        .backdoor_flush => "backdoor flush",
        .backdoor_straight => "backdoor straight",
    };
}

fn boardBlocks(board: []const card.Card, c0: card.Card, c1: card.Card) bool {
    for (board) |b| {
        if (b == c0 or b == c1) return true;
    }
    return false;
}

fn cardUsed(c: card.Card, hole0: card.Card, hole1: card.Card, board: []const card.Card) bool {
    if (c == hole0 or c == hole1) return true;
    for (board) |b| {
        if (b == c) return true;
    }
    return false;
}

fn suitCounts(hole0: card.Card, hole1: card.Card, board: []const card.Card, counts: *[4]i32) i32 {
    @memset(counts, 0);
    counts[@intCast(card.suitOf(hole0))] += 1;
    counts[@intCast(card.suitOf(hole1))] += 1;
    for (board) |b| {
        counts[@intCast(card.suitOf(b))] += 1;
    }
    var best: i32 = 0;
    for (counts.*) |count| {
        if (count > best) best = count;
    }
    return best;
}

fn collectRanks(hole0: card.Card, hole1: card.Card, board: []const card.Card, present: *[13]bool) void {
    @memset(present, false);
    present[@intCast(card.rankOf(hole0))] = true;
    present[@intCast(card.rankOf(hole1))] = true;
    for (board) |b| {
        present[@intCast(card.rankOf(b))] = true;
    }
}

fn rankAvailable(rank: i32, hole0: card.Card, hole1: card.Card, board: []const card.Card) bool {
    var suit: i32 = 0;
    while (suit < card.suit_count) : (suit += 1) {
        const c = card.makeCard(rank, suit);
        if (!cardUsed(c, hole0, hole1, board)) return true;
    }
    return false;
}

const StraightDrawScan = struct {
    present: *const [13]bool,
    hole0: card.Card,
    hole1: card.Card,
    board: []const card.Card,
    made_straight: bool = false,
    completing_rank: [13]bool = .{false} ** 13,
    completing_count: i32 = 0,
    backdoor: bool = false,
};

fn scanStraightWindow(scan: *StraightDrawScan, window: *const [5]i32) void {
    var missing_ranks: [5]i32 = undefined;
    var missing_count: usize = 0;
    for (window.*) |rank| {
        if (!scan.present[@intCast(rank)]) {
            missing_ranks[missing_count] = rank;
            missing_count += 1;
        }
    }
    if (missing_count == 0) {
        scan.made_straight = true;
        return;
    }
    if (missing_count == 1) {
        const rank = missing_ranks[0];
        if (!scan.completing_rank[@intCast(rank)] and rankAvailable(rank, scan.hole0, scan.hole1, scan.board)) {
            scan.completing_rank[@intCast(rank)] = true;
            scan.completing_count += 1;
        }
        return;
    }
    if (missing_count == 2 and scan.board.len == 3) {
        if (rankAvailable(missing_ranks[0], scan.hole0, scan.hole1, scan.board) and
            rankAvailable(missing_ranks[1], scan.hole0, scan.hole1, scan.board))
        {
            scan.backdoor = true;
        }
    }
}

fn eachStraightWindow(scan: *StraightDrawScan) void {
    var top: i32 = 4;
    while (top <= 12) : (top += 1) {
        const window = [_]i32{ top - 4, top - 3, top - 2, top - 1, top };
        scanStraightWindow(scan, &window);
    }
    // Wheel: A-2-3-4-5.
    const wheel = [_]i32{ 12, 0, 1, 2, 3 };
    scanStraightWindow(scan, &wheel);
}

/// Classify flush/straight draws and flop backdoors for one hole combo.
/// Board length must be 3 or 4. Colliding/invalid holes yield all-false flags.
pub fn classifyDraws(hole0: card.Card, hole1: card.Card, board: []const card.Card) DrawFlags {
    var flags = DrawFlags{};
    if (board.len != 3 and board.len != 4) return flags;
    if (!card.validCard(hole0) or !card.validCard(hole1) or hole0 == hole1 or boardBlocks(board, hole0, hole1)) {
        return flags;
    }
    card.validateBoard(board) catch return flags;

    var suits: [4]i32 = undefined;
    const best_suit = suitCounts(hole0, hole1, board, &suits);
    const flush_made = best_suit >= 5;
    if (!flush_made and best_suit >= 4) {
        flags.flush_draw = true;
    }
    if (board.len == 3 and !flush_made and best_suit == 3) {
        flags.backdoor_flush = true;
    }

    var present: [13]bool = undefined;
    collectRanks(hole0, hole1, board, &present);
    var scan = StraightDrawScan{
        .present = &present,
        .hole0 = hole0,
        .hole1 = hole1,
        .board = board,
    };
    eachStraightWindow(&scan);
    if (!scan.made_straight) {
        if (scan.completing_count >= 2) {
            flags.oesd = true;
        } else if (scan.completing_count == 1) {
            flags.gutshot = true;
        } else if (board.len == 3 and scan.backdoor) {
            flags.backdoor_straight = true;
        }
    }
    return flags;
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

fn composeMadePlayer(board: []const card.Card, range: range_mod.Range) CategoriesError!PlayerCategoryMass {
    var out = PlayerCategoryMass{ .count = hand_category_count };
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

fn composeDrawPlayer(board: []const card.Card, range: range_mod.Range) CategoriesError!PlayerCategoryMass {
    var out = PlayerCategoryMass{ .count = draw_category_count };
    var index: i32 = 0;
    while (index < card.combo_count) : (index += 1) {
        const weight = range.weights[@intCast(index)];
        if (!(weight > 0.0) or !std.math.isFinite(weight)) continue;
        const holes = range_mod.Range.comboCards(index) catch continue;
        if (boardBlocks(board, holes[0], holes[1])) continue;
        const flags = classifyDraws(holes[0], holes[1], board);
        out.total_mass += weight;
        if (flags.flush_draw) out.mass[@intFromEnum(DrawCategory.flush_draw)] += weight;
        if (flags.oesd) out.mass[@intFromEnum(DrawCategory.oesd)] += weight;
        if (flags.gutshot) out.mass[@intFromEnum(DrawCategory.gutshot)] += weight;
        if (flags.backdoor_flush) out.mass[@intFromEnum(DrawCategory.backdoor_flush)] += weight;
        if (flags.backdoor_straight) out.mass[@intFromEnum(DrawCategory.backdoor_straight)] += weight;
    }
    if (!(out.total_mass > 0.0) or !std.math.isFinite(out.total_mass)) {
        return out;
    }
    out.defined = true;
    var slot: usize = 0;
    while (slot < draw_category_count) : (slot += 1) {
        out.fraction[slot] = out.mass[slot] / out.total_mass;
    }
    return out;
}

/// Board length 5 → made-hand. Board length 3/4 → draws. Other lengths unavailable.
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
        report.reason = "categories require a flop, turn, or river board";
        return report;
    }
    if (board_in.len != 3 and board_in.len != 4 and board_in.len != 5) {
        report.available = false;
        report.reason = "categories require a flop, turn, or river board";
        return report;
    }
    card.validateBoard(board_in) catch {
        report.available = false;
        report.reason = "invalid board";
        return report;
    };
    report.available = true;
    if (board_in.len == 5) {
        report.model = category_model;
        report.exclusive = true;
        report.category_count = hand_category_count;
        report.player0 = try composeMadePlayer(board_in, range0);
        report.player1 = try composeMadePlayer(board_in, range1);
        return report;
    }
    report.model = draw_category_model;
    report.exclusive = false;
    report.category_count = draw_category_count;
    report.player0 = try composeDrawPlayer(board_in, range0);
    report.player1 = try composeDrawPlayer(board_in, range1);
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

test "classify draws: backdoor flush + gutshot on rainbow flop" {
    const flop = [_]card.Card{
        try card.parseCard("Ah"),
        try card.parseCard("Kd"),
        try card.parseCard("7c"),
    };
    const flags = classifyDraws(try card.parseCard("Qh"), try card.parseCard("Jh"), &flop);
    try std.testing.expect(!flags.flush_draw);
    try std.testing.expect(flags.backdoor_flush);
    try std.testing.expect(!flags.oesd);
    try std.testing.expect(flags.gutshot);
}

test "classify draws: backdoor flush + backdoor straight" {
    const flop = [_]card.Card{
        try card.parseCard("Ah"),
        try card.parseCard("Kd"),
        try card.parseCard("7c"),
    };
    const flags = classifyDraws(try card.parseCard("9h"), try card.parseCard("8h"), &flop);
    try std.testing.expect(!flags.flush_draw);
    try std.testing.expect(flags.backdoor_flush);
    try std.testing.expect(!flags.oesd);
    try std.testing.expect(!flags.gutshot);
    try std.testing.expect(flags.backdoor_straight);
}

test "classify draws: flush draw on two-tone flop" {
    const flop = [_]card.Card{
        try card.parseCard("Ah"),
        try card.parseCard("Kh"),
        try card.parseCard("7c"),
    };
    const flags = classifyDraws(try card.parseCard("Th"), try card.parseCard("9h"), &flop);
    try std.testing.expect(flags.flush_draw);
    try std.testing.expect(!flags.backdoor_flush);
}

test "classify draws: OESD on connected flop" {
    const flop = [_]card.Card{
        try card.parseCard("7h"),
        try card.parseCard("6s"),
        try card.parseCard("2c"),
    };
    const flags = classifyDraws(try card.parseCard("9c"), try card.parseCard("8d"), &flop);
    try std.testing.expect(flags.oesd);
    try std.testing.expect(!flags.gutshot);
}

test "classify draws: turn suppresses backdoors" {
    const turn = [_]card.Card{
        try card.parseCard("Ah"),
        try card.parseCard("Kh"),
        try card.parseCard("7c"),
        try card.parseCard("2d"),
    };
    const flags = classifyDraws(try card.parseCard("Th"), try card.parseCard("9h"), &turn);
    try std.testing.expect(flags.flush_draw);
    try std.testing.expect(!flags.backdoor_flush);
    try std.testing.expect(!flags.backdoor_straight);
}

test "flop draw composition weighted flush draw" {
    const flop = [_]card.Card{
        try card.parseCard("Ah"),
        try card.parseCard("Kh"),
        try card.parseCard("7c"),
    };
    const r0 = try range_mod.Range.parse("Th9h:1,2c3d:1");
    const r1 = try range_mod.Range.parse("QcQd");
    const report = try categoryComposition(&flop, r0, r1);
    try std.testing.expect(report.available);
    try std.testing.expectEqualStrings(draw_category_model, report.model);
    try std.testing.expect(!report.exclusive);
    try std.testing.expectEqual(@as(usize, draw_category_count), report.category_count);
    try std.testing.expect(report.player0.defined);
    try std.testing.expectApproxEqAbs(@as(f64, 2.0), report.player0.total_mass, 1e-12);
    try std.testing.expectApproxEqAbs(
        @as(f64, 0.5),
        report.player0.fraction[@intFromEnum(DrawCategory.flush_draw)],
        1e-12,
    );
}

test "empty board unavailable" {
    const board = [_]card.Card{};
    const r0 = try range_mod.Range.parse("AcAd");
    const r1 = try range_mod.Range.parse("QcQs");
    const report = try categoryComposition(&board, r0, r1);
    try std.testing.expect(!report.available);
    try std.testing.expect(std.mem.indexOf(u8, report.reason, "flop") != null);
}
