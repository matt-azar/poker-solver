const std = @import("std");

pub const deck_size: i32 = 52;
pub const rank_count: i32 = 13;
pub const suit_count: i32 = 4;
pub const combo_count: i32 = 1326;

/// card = rank * 4 + suit. Rank 0 = deuce … 12 = ace. Suit 0=c,1=d,2=h,3=s.
pub const Card = i32;

pub const ParseError = error{InvalidCard};

pub fn rankOf(card: Card) i32 {
    return @divTrunc(card, suit_count);
}

pub fn suitOf(card: Card) i32 {
    return @mod(card, suit_count);
}

pub fn makeCard(rank: i32, suit: i32) Card {
    return rank * suit_count + suit;
}

pub fn validCard(card: Card) bool {
    return card >= 0 and card < deck_size;
}

fn rankFromChar(c: u8) ?i32 {
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

fn suitFromChar(c: u8) ?i32 {
    return switch (c) {
        'c', 'C' => 0,
        'd', 'D' => 1,
        'h', 'H' => 2,
        's', 'S' => 3,
        else => null,
    };
}

pub fn parseCard(text: []const u8) ParseError!Card {
    if (text.len == 3 and text[0] == '1' and text[1] == '0') {
        const suit = suitFromChar(text[2]) orelse return error.InvalidCard;
        return makeCard(8, suit);
    }
    if (text.len != 2) return error.InvalidCard;
    const rank = rankFromChar(text[0]) orelse return error.InvalidCard;
    const suit = suitFromChar(text[1]) orelse return error.InvalidCard;
    return makeCard(rank, suit);
}

pub fn formatCard(card: Card, buf: *[2]u8) ParseError![]const u8 {
    if (!validCard(card)) return error.InvalidCard;
    const ranks = "23456789TJQKA";
    const suits = "cdhs";
    buf.*[0] = ranks[@intCast(rankOf(card))];
    buf.*[1] = suits[@intCast(suitOf(card))];
    return buf.*[0..2];
}

pub fn validateBoard(cards: []const Card) ParseError!void {
    if (cards.len != 0 and cards.len != 3 and cards.len != 4 and cards.len != 5) {
        return error.InvalidCard;
    }
    for (cards, 0..) |c, i| {
        if (!validCard(c)) return error.InvalidCard;
        for (cards[0..i]) |prior| {
            if (prior == c) return error.InvalidCard;
        }
    }
}

test "parse and format Ah" {
    const c = try parseCard("Ah");
    try std.testing.expectEqual(@as(Card, makeCard(12, 2)), c);
    var buf: [2]u8 = undefined;
    const text = try formatCard(c, &buf);
    try std.testing.expectEqualStrings("Ah", text);
}

test "parse 10c as Tc" {
    const c = try parseCard("10c");
    try std.testing.expectEqual(@as(Card, makeCard(8, 0)), c);
}
