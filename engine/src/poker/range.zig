const std = @import("std");
const card = @import("card.zig");

pub const RangeError = error{InvalidRange};

pub const Range = struct {
    weights: [card.combo_count]f64 = [_]f64{0} ** card.combo_count,

    pub fn comboIndex(card0: card.Card, card1: card.Card) RangeError!i32 {
        if (!card.validCard(card0) or !card.validCard(card1) or card0 == card1) {
            return error.InvalidRange;
        }
        var a = card0;
        var b = card1;
        if (a > b) {
            const tmp = a;
            a = b;
            b = tmp;
        }
        return @divTrunc(a * (103 - a), 2) + (b - a - 1);
    }

    pub fn comboCards(index: i32) RangeError!struct { card.Card, card.Card } {
        if (index < 0 or index >= card.combo_count) return error.InvalidRange;
        var cursor = index;
        var low: i32 = 0;
        while (low < card.deck_size) : (low += 1) {
            const width = card.deck_size - 1 - low;
            if (cursor < width) {
                return .{ low, low + 1 + cursor };
            }
            cursor -= width;
        }
        return error.InvalidRange;
    }

    pub fn comboText(index: i32, buf: *[4]u8) RangeError![]const u8 {
        const pair = try comboCards(index);
        var c0 = pair[0];
        var c1 = pair[1];
        if (card.rankOf(c0) < card.rankOf(c1) or
            (card.rankOf(c0) == card.rankOf(c1) and card.suitOf(c0) < card.suitOf(c1)))
        {
            const tmp = c0;
            c0 = c1;
            c1 = tmp;
        }
        var a: [2]u8 = undefined;
        var b: [2]u8 = undefined;
        const t0 = card.formatCard(c0, &a) catch return error.InvalidRange;
        const t1 = card.formatCard(c1, &b) catch return error.InvalidRange;
        @memcpy(buf[0..2], t0);
        @memcpy(buf[2..4], t1);
        return buf.*[0..4];
    }

    pub fn weight(self: Range, index: i32) RangeError!f64 {
        if (index < 0 or index >= card.combo_count) return error.InvalidRange;
        return self.weights[@intCast(index)];
    }

    pub fn setWeight(self: *Range, card0: card.Card, card1: card.Card, value: f64) RangeError!void {
        if (!std.math.isFinite(value) or value < 0.0) return error.InvalidRange;
        const index = try comboIndex(card0, card1);
        self.weights[@intCast(index)] = value;
    }

    pub fn total(self: Range) f64 {
        var sum: f64 = 0;
        for (self.weights) |w| sum += w;
        return sum;
    }

    pub fn parse(text: []const u8) RangeError!Range {
        var range = Range{};
        const body = trim(text);
        if (body.len == 0) return range;
        var start: usize = 0;
        while (start <= body.len) {
            const comma = std.mem.indexOfScalarPos(u8, body, start, ',');
            const end = comma orelse body.len;
            try applyToken(&range, body[start..end]);
            if (comma == null) break;
            start = comma.? + 1;
        }
        return range;
    }

    pub fn toComboList(self: Range, allocator: std.mem.Allocator) RangeError![]u8 {
        var list = std.ArrayList(u8).init(allocator);
        errdefer list.deinit();
        var first = true;
        var index: i32 = 0;
        while (index < card.combo_count) : (index += 1) {
            const value = self.weights[@intCast(index)];
            if (value == 0.0) continue;
            if (!first) list.append(',') catch return error.InvalidRange;
            first = false;
            var combo_buf: [4]u8 = undefined;
            const combo = try comboText(index, &combo_buf);
            list.appendSlice(combo) catch return error.InvalidRange;
            list.append(':') catch return error.InvalidRange;
            var num_buf: [64]u8 = undefined;
            const num = std.fmt.bufPrint(&num_buf, "{d}", .{value}) catch return error.InvalidRange;
            list.appendSlice(num) catch return error.InvalidRange;
        }
        return list.toOwnedSlice() catch return error.InvalidRange;
    }
};

fn trim(text: []const u8) []const u8 {
    var start: usize = 0;
    var end = text.len;
    while (start < end and (text[start] == ' ' or text[start] == '\t')) start += 1;
    while (end > start and (text[end - 1] == ' ' or text[end - 1] == '\t')) end -= 1;
    return text[start..end];
}

const Shape = enum { pair, suited, offsuit, both };

const Group = struct {
    shape: Shape = .both,
    high: i32 = 0,
    low: i32 = 0,
    plus: bool = false,
    spanned: bool = false,
    low_end: i32 = 0,
};

const Cursor = struct {
    text: []const u8,
    index: usize = 0,

    fn done(self: Cursor) bool {
        return self.index >= self.text.len;
    }
    fn peek(self: Cursor) u8 {
        return if (self.done()) 0 else self.text[self.index];
    }
    fn get(self: *Cursor) RangeError!u8 {
        if (self.done()) return error.InvalidRange;
        const c = self.text[self.index];
        self.index += 1;
        return c;
    }
};

fn rankChar(c: u8) ?i32 {
    return switch (c) {
        '2' => 0,
        '3' => 1,
        '4' => 2,
        '5' => 3,
        '6' => 4,
        '7' => 5,
        '8' => 6,
        '9' => 7,
        'T', 't' => 8,
        'J', 'j' => 9,
        'Q', 'q' => 10,
        'K', 'k' => 11,
        'A', 'a' => 12,
        else => null,
    };
}

fn suitChar(c: u8) ?i32 {
    return switch (c) {
        'c', 'C' => 0,
        'd', 'D' => 1,
        'h', 'H' => 2,
        's', 'S' => 3,
        else => null,
    };
}

fn readRank(cursor: *Cursor) RangeError!i32 {
    if (cursor.peek() == '1') {
        const next = cursor.index + 1;
        if (next < cursor.text.len and cursor.text[next] == '0') {
            cursor.index += 2;
            return 8;
        }
    }
    const rank = rankChar(try cursor.get()) orelse return error.InvalidRange;
    return rank;
}

fn consumeSuitMarker(cursor: *Cursor, marker: u8) bool {
    const upper = marker - 'a' + 'A';
    if (cursor.peek() == marker or cursor.peek() == upper) {
        cursor.index += 1;
        return true;
    }
    return false;
}

fn atCard(cursor: Cursor) bool {
    if (cursor.done()) return false;
    if (cursor.peek() == '1') {
        const next = cursor.index + 1;
        if (next + 1 < cursor.text.len and cursor.text[next] == '0') {
            return suitChar(cursor.text[next + 1]) != null;
        }
    }
    if (cursor.index + 1 >= cursor.text.len) return false;
    return rankChar(cursor.peek()) != null and suitChar(cursor.text[cursor.index + 1]) != null;
}

fn readSpecificCard(cursor: *Cursor) RangeError!card.Card {
    const rank = try readRank(cursor);
    const suit = suitChar(try cursor.get()) orelse return error.InvalidRange;
    return card.makeCard(rank, suit);
}

fn skipSpaces(cursor: *Cursor) void {
    while (cursor.peek() == ' ' or cursor.peek() == '\t') cursor.index += 1;
}

fn addPair(range: *Range, rank: i32, weight: f64) RangeError!void {
    var s0: i32 = 0;
    while (s0 < card.suit_count) : (s0 += 1) {
        var s1: i32 = s0 + 1;
        while (s1 < card.suit_count) : (s1 += 1) {
            try range.setWeight(card.makeCard(rank, s0), card.makeCard(rank, s1), weight);
        }
    }
}

fn addSuited(range: *Range, high: i32, low: i32, weight: f64) RangeError!void {
    var suit: i32 = 0;
    while (suit < card.suit_count) : (suit += 1) {
        try range.setWeight(card.makeCard(high, suit), card.makeCard(low, suit), weight);
    }
}

fn addOffsuit(range: *Range, high: i32, low: i32, weight: f64) RangeError!void {
    var s0: i32 = 0;
    while (s0 < card.suit_count) : (s0 += 1) {
        var s1: i32 = 0;
        while (s1 < card.suit_count) : (s1 += 1) {
            if (s0 == s1) continue;
            try range.setWeight(card.makeCard(high, s0), card.makeCard(low, s1), weight);
        }
    }
}

fn applyGroup(range: *Range, group: Group, weight: f64) RangeError!void {
    if (group.shape == .pair) {
        if (!group.spanned and !group.plus) {
            try addPair(range, group.high, weight);
            return;
        }
        const low_rank = if (group.plus) group.high else group.low;
        const high_rank = if (group.plus) @as(i32, 12) else group.high;
        var rank = low_rank;
        while (rank <= high_rank) : (rank += 1) {
            try addPair(range, rank, weight);
        }
        return;
    }
    const kicker_begin = group.low;
    const kicker_end = if (group.spanned) (if (group.plus) group.high - 1 else group.low_end) else group.low;
    var kicker = @min(kicker_begin, kicker_end);
    const kicker_last = @max(kicker_begin, kicker_end);
    while (kicker <= kicker_last) : (kicker += 1) {
        if (kicker == group.high) continue;
        if (group.shape == .suited or group.shape == .both) {
            try addSuited(range, group.high, kicker, weight);
        }
        if (group.shape == .offsuit or group.shape == .both) {
            try addOffsuit(range, group.high, kicker, weight);
        }
    }
}

fn applyToken(range: *Range, piece_in: []const u8) RangeError!void {
    var piece = trim(piece_in);
    if (piece.len == 0) return;
    var weight: f64 = 1.0;
    if (std.mem.indexOfScalar(u8, piece, ':')) |colon| {
        const number = trim(piece[colon + 1 ..]);
        piece = trim(piece[0..colon]);
        weight = std.fmt.parseFloat(f64, number) catch return error.InvalidRange;
        if (!std.math.isFinite(weight) or weight < 0.0) return error.InvalidRange;
    }
    if (std.mem.eql(u8, piece, "random") or std.mem.eql(u8, piece, "*")) {
        var c0: i32 = 0;
        while (c0 < card.deck_size) : (c0 += 1) {
            var c1: i32 = c0 + 1;
            while (c1 < card.deck_size) : (c1 += 1) {
                try range.setWeight(c0, c1, weight);
            }
        }
        return;
    }
    var cursor = Cursor{ .text = piece };
    skipSpaces(&cursor);
    if (atCard(cursor)) {
        const first = try readSpecificCard(&cursor);
        skipSpaces(&cursor);
        if (!atCard(cursor)) return error.InvalidRange;
        const second = try readSpecificCard(&cursor);
        skipSpaces(&cursor);
        if (!cursor.done()) return error.InvalidRange;
        if (first == second) return error.InvalidRange;
        try range.setWeight(first, second, weight);
        return;
    }
    // Dash ranges need correct kicker handling — parse carefully.
    const group = try readGroupFixed(&cursor);
    skipSpaces(&cursor);
    if (!cursor.done()) return error.InvalidRange;
    try applyGroup(range, group, weight);
}

fn readGroupFixed(cursor: *Cursor) RangeError!Group {
    var group = Group{};
    const first = try readRank(cursor);
    if (cursor.peek() == '-' or cursor.peek() == '+') return error.InvalidRange;
    if (rankChar(cursor.peek()) == null and cursor.peek() != '1') return error.InvalidRange;
    const second = try readRank(cursor);
    if (first == second) {
        group.shape = .pair;
        group.high = first;
        group.low = first;
    } else {
        group.high = @max(first, second);
        group.low = @min(first, second);
        if (consumeSuitMarker(cursor, 's')) {
            group.shape = .suited;
        } else if (consumeSuitMarker(cursor, 'o')) {
            group.shape = .offsuit;
        } else {
            group.shape = .both;
        }
    }
    if (cursor.peek() == '+') {
        cursor.index += 1;
        group.plus = true;
        group.low_end = if (group.shape == .pair) 12 else group.high - 1;
        group.spanned = true;
    } else if (cursor.peek() == '-') {
        cursor.index += 1;
        const kicker_a = group.low;
        const high_saved = group.high;
        const shape_saved = group.shape;
        const tail = try readGroupFixed(cursor);
        if (tail.shape != shape_saved or tail.plus or tail.spanned) return error.InvalidRange;
        if (shape_saved == .pair) {
            group.low = @min(high_saved, tail.high);
            group.high = @max(high_saved, tail.high);
        } else {
            if (tail.high != high_saved) return error.InvalidRange;
            group.high = high_saved;
            group.low = @min(kicker_a, tail.low);
            group.low_end = @max(kicker_a, tail.low);
        }
        group.shape = shape_saved;
        group.spanned = true;
    }
    return group;
}

test "combo index AhAd" {
    const ah = try card.parseCard("Ah");
    const ad = try card.parseCard("Ad");
    const index = try Range.comboIndex(ah, ad);
    const pair = try Range.comboCards(index);
    try std.testing.expect((pair[0] == ah and pair[1] == ad) or (pair[0] == ad and pair[1] == ah));
}

test "parse specific combo with weight" {
    const r = try Range.parse("AhAd:1");
    const ah = try card.parseCard("Ah");
    const ad = try card.parseCard("Ad");
    try std.testing.expectEqual(@as(f64, 1.0), try r.weight(try Range.comboIndex(ah, ad)));
}

test "parse pair group" {
    const r = try Range.parse("QQ");
    try std.testing.expectApproxEqAbs(@as(f64, 6.0), r.total(), 1e-9);
}
