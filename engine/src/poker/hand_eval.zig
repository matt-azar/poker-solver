const std = @import("std");
const card = @import("card.zig");

pub const EvalError = error{InvalidHand};

pub const HandCategory = enum(u8) {
    high_card = 0,
    pair = 1,
    two_pair = 2,
    three_of_a_kind = 3,
    straight = 4,
    flush = 5,
    full_house = 6,
    four_of_a_kind = 7,
    straight_flush = 8,
};

pub const HandValue = struct {
    category: HandCategory = .high_card,
    tiebreak: [5]i32 = .{ 0, 0, 0, 0, 0 },

    pub fn eql(self: HandValue, other: HandValue) bool {
        if (self.category != other.category) return false;
        return std.mem.eql(i32, &self.tiebreak, &other.tiebreak);
    }
};

fn betterRank(left: HandValue, right: HandValue) bool {
    if (left.category != right.category) {
        return @intFromEnum(left.category) > @intFromEnum(right.category);
    }
    var i: usize = 0;
    while (i < 5) : (i += 1) {
        if (left.tiebreak[i] != right.tiebreak[i]) {
            return left.tiebreak[i] > right.tiebreak[i];
        }
    }
    return false;
}

fn scoreFive(cards: [5]card.Card) EvalError!HandValue {
    var rank_count: [card.rank_count]i32 = .{0} ** card.rank_count;
    var suit_count: [card.suit_count]i32 = .{0} ** card.suit_count;
    for (cards) |c| {
        if (!card.validCard(c)) return error.InvalidHand;
        rank_count[@intCast(card.rankOf(c))] += 1;
        suit_count[@intCast(card.suitOf(c))] += 1;
    }

    var flush = false;
    for (suit_count) |count| {
        if (count == 5) flush = true;
    }

    var present: [card.rank_count]bool = .{false} ** card.rank_count;
    var rank: i32 = 0;
    while (rank < card.rank_count) : (rank += 1) {
        present[@intCast(rank)] = rank_count[@intCast(rank)] > 0;
    }

    var straight_top: i32 = -1;
    var top: i32 = 12;
    while (top >= 4) : (top -= 1) {
        var consecutive = true;
        var step: i32 = 0;
        while (step < 5) : (step += 1) {
            if (!present[@intCast(top - step)]) {
                consecutive = false;
                break;
            }
        }
        if (consecutive) {
            straight_top = top;
            break;
        }
    }
    if (straight_top < 0 and present[12] and present[0] and present[1] and present[2] and present[3]) {
        straight_top = 3; // wheel
    }

    var value = HandValue{};
    if (flush and straight_top >= 0) {
        value.category = .straight_flush;
        value.tiebreak[0] = straight_top;
        return value;
    }

    var four: i32 = -1;
    var three: i32 = -1;
    var pairs: [2]i32 = .{ -1, -1 };
    var pair_count: i32 = 0;
    var singles: [5]i32 = .{0} ** 5;
    var single_count: i32 = 0;
    rank = card.rank_count - 1;
    while (rank >= 0) : (rank -= 1) {
        const count = rank_count[@intCast(rank)];
        if (count == 4) {
            four = rank;
        } else if (count == 3) {
            three = rank;
        } else if (count == 2) {
            pairs[@intCast(pair_count)] = rank;
            pair_count += 1;
        } else if (count == 1) {
            singles[@intCast(single_count)] = rank;
            single_count += 1;
        }
    }

    if (four >= 0) {
        value.category = .four_of_a_kind;
        value.tiebreak[0] = four;
        value.tiebreak[1] = singles[0];
        return value;
    }
    if (three >= 0 and pair_count == 1) {
        value.category = .full_house;
        value.tiebreak[0] = three;
        value.tiebreak[1] = pairs[0];
        return value;
    }
    if (flush) {
        value.category = .flush;
        var i: i32 = 0;
        while (i < single_count) : (i += 1) {
            value.tiebreak[@intCast(i)] = singles[@intCast(i)];
        }
        return value;
    }
    if (straight_top >= 0) {
        value.category = .straight;
        value.tiebreak[0] = straight_top;
        return value;
    }
    if (three >= 0) {
        value.category = .three_of_a_kind;
        value.tiebreak[0] = three;
        value.tiebreak[1] = singles[0];
        value.tiebreak[2] = singles[1];
        return value;
    }
    if (pair_count == 2) {
        value.category = .two_pair;
        value.tiebreak[0] = pairs[0];
        value.tiebreak[1] = pairs[1];
        value.tiebreak[2] = singles[0];
        return value;
    }
    if (pair_count == 1) {
        value.category = .pair;
        value.tiebreak[0] = pairs[0];
        value.tiebreak[1] = singles[0];
        value.tiebreak[2] = singles[1];
        value.tiebreak[3] = singles[2];
        return value;
    }
    value.category = .high_card;
    var i: i32 = 0;
    while (i < single_count) : (i += 1) {
        value.tiebreak[@intCast(i)] = singles[@intCast(i)];
    }
    return value;
}

fn forEachFive(cards: []const card.Card, cb: anytype) EvalError!void {
    const count = cards.len;
    if (count == 5) {
        var hand: [5]card.Card = undefined;
        @memcpy(&hand, cards[0..5]);
        try cb.call(hand);
        return;
    }
    if (count == 6) {
        var skip: usize = 0;
        while (skip < 6) : (skip += 1) {
            var hand: [5]card.Card = undefined;
            var filled: usize = 0;
            var i: usize = 0;
            while (i < 6) : (i += 1) {
                if (i == skip) continue;
                hand[filled] = cards[i];
                filled += 1;
            }
            try cb.call(hand);
        }
        return;
    }
    if (count != 7) return error.InvalidHand;
    var skip0: usize = 0;
    while (skip0 < 7) : (skip0 += 1) {
        var skip1: usize = skip0 + 1;
        while (skip1 < 7) : (skip1 += 1) {
            var hand: [5]card.Card = undefined;
            var filled: usize = 0;
            var i: usize = 0;
            while (i < 7) : (i += 1) {
                if (i == skip0 or i == skip1) continue;
                hand[filled] = cards[i];
                filled += 1;
            }
            try cb.call(hand);
        }
    }
}

pub fn evaluate(cards: []const card.Card) EvalError!HandValue {
    if (cards.len < 5 or cards.len > 7) return error.InvalidHand;
    for (cards, 0..) |c, i| {
        if (!card.validCard(c)) return error.InvalidHand;
        for (cards[0..i]) |prior| {
            if (prior == c) return error.InvalidHand;
        }
    }
    var best = HandValue{};
    var have_best = false;
    try forEachFive(cards, struct {
        best: *HandValue,
        have: *bool,
        pub fn call(self: @This(), hand: [5]card.Card) EvalError!void {
            const value = try scoreFive(hand);
            if (!self.have.* or betterRank(value, self.best.*)) {
                self.best.* = value;
                self.have.* = true;
            }
        }
    }{ .best = &best, .have = &have_best });
    return best;
}

pub fn compareValues(left: HandValue, right: HandValue) i32 {
    if (left.eql(right)) return 0;
    return if (betterRank(left, right)) @as(i32, 1) else -1;
}

pub fn compareShowdown(
    left0: card.Card,
    left1: card.Card,
    right0: card.Card,
    right1: card.Card,
    board: []const card.Card,
) EvalError!i32 {
    card.validateBoard(board) catch return error.InvalidHand;
    if (board.len == 0) return error.InvalidHand;
    // Private cards must be distinct from board and each other.
    if (!card.validCard(left0) or !card.validCard(left1) or left0 == left1) return error.InvalidHand;
    if (!card.validCard(right0) or !card.validCard(right1) or right0 == right1) return error.InvalidHand;
    for (board) |b| {
        if (b == left0 or b == left1 or b == right0 or b == right1) return error.InvalidHand;
    }
    if (left0 == right0 or left0 == right1 or left1 == right0 or left1 == right1) return error.InvalidHand;

    var left_cards: [7]card.Card = undefined;
    var right_cards: [7]card.Card = undefined;
    const total = 2 + board.len;
    left_cards[0] = left0;
    left_cards[1] = left1;
    right_cards[0] = right0;
    right_cards[1] = right1;
    @memcpy(left_cards[2..][0..board.len], board);
    @memcpy(right_cards[2..][0..board.len], board);
    return compareValues(
        try evaluate(left_cards[0..total]),
        try evaluate(right_cards[0..total]),
    );
}

test "AA beats KK on dry board" {
    const board = [_]card.Card{
        try card.parseCard("2c"),
        try card.parseCard("7d"),
        try card.parseCard("9h"),
        try card.parseCard("Js"),
        try card.parseCard("3c"),
    };
    const outcome = try compareShowdown(
        try card.parseCard("Ac"),
        try card.parseCard("Ad"),
        try card.parseCard("Kc"),
        try card.parseCard("Kd"),
        &board,
    );
    try std.testing.expect(outcome > 0);
}

test "wheel straight" {
    const cards = [_]card.Card{
        try card.parseCard("Ac"),
        try card.parseCard("2d"),
        try card.parseCard("3h"),
        try card.parseCard("4s"),
        try card.parseCard("5c"),
    };
    const value = try evaluate(&cards);
    try std.testing.expect(value.category == .straight);
    try std.testing.expectEqual(@as(i32, 3), value.tiebreak[0]);
}
