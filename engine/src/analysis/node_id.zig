//! Study public node ids: `pN.tT.rR` (C++ StreetBatchSolver::parse_node_id / locate_node).
const std = @import("std");
const compile = @import("../game/compile.zig");

pub const NodeIdError = error{ UnknownNode, OutOfMemory };

pub const ParsedNodeId = struct {
    node_index: u32 = 0,
    turn: i32 = -1,
    river: i32 = -1,
};

/// Parse `pN.tT.rR`. Leading zeros accepted; `+` prefixes rejected (C++ parity).
pub fn parseNodeId(text: []const u8) NodeIdError!ParsedNodeId {
    if (text.len < 7 or text[0] != 'p') return error.UnknownNode;
    var cursor: usize = 1;
    const node = try readNumber(text, &cursor);
    if (cursor >= text.len or text[cursor] != '.') return error.UnknownNode;
    cursor += 1;
    if (cursor >= text.len or text[cursor] != 't') return error.UnknownNode;
    cursor += 1;
    const turn = try readNumber(text, &cursor);
    if (cursor >= text.len or text[cursor] != '.') return error.UnknownNode;
    cursor += 1;
    if (cursor >= text.len or text[cursor] != 'r') return error.UnknownNode;
    cursor += 1;
    const river = try readNumber(text, &cursor);
    if (cursor != text.len) return error.UnknownNode;
    if (node < 0) return error.UnknownNode;
    return .{
        .node_index = @intCast(node),
        .turn = turn,
        .river = river,
    };
}

pub fn formatNodeId(allocator: std.mem.Allocator, node_index: u32, turn: i32, river: i32) NodeIdError![]u8 {
    return std.fmt.allocPrint(allocator, "p{d}.t{d}.r{d}", .{ node_index, turn, river }) catch return error.OutOfMemory;
}

/// Resolve a Study node id against a compiled tree (range + card-mode checks).
pub fn locateNode(game: compile.CompiledGame, text: []const u8) NodeIdError!ParsedNodeId {
    const parsed = try parseNodeId(text);
    if (parsed.node_index >= game.nodes.len) return error.UnknownNode;
    const found = game.nodes[parsed.node_index];

    var want_turn = false;
    var want_river = false;
    if (game.board.len == 5) {
        // Fixed board: ids never carry a turn or river card.
    } else if (found.kind == .chance) {
        if (found.deal_which == 1) {
            // no cards
        } else if (game.board.len == 3) {
            want_turn = true;
        }
    } else if (found.kind == .terminal) {
        if (game.board.len == 3) {
            want_turn = found.street >= 1;
            want_river = found.street >= 2;
        } else {
            want_river = found.street >= 1;
        }
    } else if (game.board.len == 4) {
        want_river = found.card_mode == 1;
    } else if (found.card_mode == 1) {
        want_turn = true;
    } else if (found.card_mode == 2) {
        want_turn = true;
        want_river = true;
    }

    if (want_turn and want_river and parsed.turn == parsed.river) return error.UnknownNode;
    try requireCard(game, parsed.turn, want_turn);
    try requireCard(game, parsed.river, want_river);
    return parsed;
}

fn requireCard(game: compile.CompiledGame, card: i32, wanted: bool) NodeIdError!void {
    if (!wanted) {
        if (card != -1) return error.UnknownNode;
        return;
    }
    if (card < 0 or card >= 52) return error.UnknownNode;
    for (game.board) |b| {
        if (@as(i32, b) == card) return error.UnknownNode;
    }
}

fn readNumber(text: []const u8, cursor: *usize) NodeIdError!i32 {
    if (cursor.* >= text.len or text[cursor.*] == '+') return error.UnknownNode;
    const first = cursor.*;
    var i = first;
    if (i < text.len and text[i] == '-') i += 1;
    if (i >= text.len or text[i] < '0' or text[i] > '9') return error.UnknownNode;
    while (i < text.len and text[i] >= '0' and text[i] <= '9') : (i += 1) {}
    const parsed = std.fmt.parseInt(i64, text[first..i], 10) catch return error.UnknownNode;
    if (parsed < std.math.minInt(i32) or parsed > std.math.maxInt(i32)) return error.UnknownNode;
    cursor.* = i;
    return @intCast(parsed);
}

test "parse root and leading zeros" {
    const root = try parseNodeId("p0.t-1.r-1");
    try std.testing.expectEqual(@as(u32, 0), root.node_index);
    try std.testing.expectEqual(@as(i32, -1), root.turn);
    try std.testing.expectEqual(@as(i32, -1), root.river);
    const padded = try parseNodeId("p00.t-1.r-1");
    try std.testing.expectEqual(@as(u32, 0), padded.node_index);
}

test "reject malformed node ids" {
    try std.testing.expectError(error.UnknownNode, parseNodeId("p+1.t-1.r-1"));
    try std.testing.expectError(error.UnknownNode, parseNodeId("p0.t-1.r-1x"));
    try std.testing.expectError(error.UnknownNode, parseNodeId("p0.t-1.r"));
    try std.testing.expectError(error.UnknownNode, parseNodeId("p0"));
    try std.testing.expectError(error.UnknownNode, parseNodeId("p-1.t-1.r-1"));
}

test "format roundtrip" {
    const text = try formatNodeId(std.testing.allocator, 12, 10, -1);
    defer std.testing.allocator.free(text);
    try std.testing.expectEqualStrings("p12.t10.r-1", text);
    const back = try parseNodeId(text);
    try std.testing.expectEqual(@as(u32, 12), back.node_index);
    try std.testing.expectEqual(@as(i32, 10), back.turn);
    try std.testing.expectEqual(@as(i32, -1), back.river);
}
