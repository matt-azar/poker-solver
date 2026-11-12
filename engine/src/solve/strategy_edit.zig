//! Free-form strategy-edit overlays (C++ include/solver/strategy_edit.hpp).
//! Distinct from LockSet: edits rewrite published average rows for browse / EV;
//! they do not constrain CFR regret matching. Persisted as Session
//! `strategy_edits_text` in `.psol` v4.
const std = @import("std");
const compile = @import("../game/compile.zig");
const node_lock = @import("node_lock.zig");

pub const EditKind = enum { full_node, selected_combos };

pub const StrategyEdit = struct {
    infoset_id: usize = 0,
    turn: i8 = -1,
    river: i8 = -1,
    kind: EditKind = .full_node,
    hand_indices: []usize = &.{},
    probs: []f64 = &.{},

    pub fn key(self: StrategyEdit) node_lock.LockKey {
        return node_lock.makeLockKey(self.infoset_id, self.turn, self.river);
    }

    pub fn deinit(self: *StrategyEdit, allocator: std.mem.Allocator) void {
        if (self.hand_indices.len != 0) allocator.free(self.hand_indices);
        self.hand_indices = &.{};
        if (self.probs.len != 0) allocator.free(self.probs);
        self.probs = &.{};
    }
};

pub fn validateStrategyProbs(probs: []const f64, action_count: i32) bool {
    if (probs.len == 0) return false;
    return node_lock.validateActionRow(probs, action_count);
}

pub fn makeStrategyProbs(allocator: std.mem.Allocator, probs: []const f64, action_count: i32) ![]f64 {
    if (!validateStrategyProbs(probs, action_count)) return error.InvalidStrategyEdit;
    return try allocator.dupe(f64, probs);
}

pub fn handIsSelected(edit: StrategyEdit, hand_index: usize) bool {
    if (edit.kind == .full_node) return true;
    for (edit.hand_indices) |index| {
        if (index == hand_index) return true;
    }
    return false;
}

pub const StrategyEditSet = struct {
    allocator: std.mem.Allocator,
    entries: std.ArrayList(StrategyEdit),

    pub fn init(allocator: std.mem.Allocator) StrategyEditSet {
        return .{ .allocator = allocator, .entries = std.ArrayList(StrategyEdit).init(allocator) };
    }

    pub fn deinit(self: *StrategyEditSet) void {
        for (self.entries.items) |*edit| edit.deinit(self.allocator);
        self.entries.deinit();
    }

    pub fn empty(self: *const StrategyEditSet) bool {
        return self.entries.items.len == 0;
    }

    pub fn size(self: *const StrategyEditSet) usize {
        return self.entries.items.len;
    }

    fn findIndex(self: *const StrategyEditSet, key: node_lock.LockKey) ?usize {
        for (self.entries.items, 0..) |edit, i| {
            if (node_lock.LockKey.eql(edit.key(), key)) return i;
        }
        return null;
    }

    pub fn upsert(self: *StrategyEditSet, edit: StrategyEdit) !void {
        if (edit.probs.len == 0) return error.InvalidStrategyEdit;
        if (edit.kind == .selected_combos and edit.hand_indices.len == 0) return error.InvalidStrategyEdit;
        const key = edit.key();
        if (self.findIndex(key)) |idx| {
            self.entries.items[idx].deinit(self.allocator);
            self.entries.items[idx] = edit;
            return;
        }
        try self.entries.append(edit);
    }

    pub fn eraseKey(self: *StrategyEditSet, key: node_lock.LockKey) bool {
        const idx = self.findIndex(key) orelse return false;
        self.entries.items[idx].deinit(self.allocator);
        _ = self.entries.swapRemove(idx);
        return true;
    }

    pub fn eraseHand(self: *StrategyEditSet, key: node_lock.LockKey, hand_index: usize) bool {
        const idx = self.findIndex(key) orelse return false;
        const edit = &self.entries.items[idx];
        if (edit.kind != .selected_combos) return false;
        var found: ?usize = null;
        for (edit.hand_indices, 0..) |h, i| {
            if (h == hand_index) {
                found = i;
                break;
            }
        }
        const at = found orelse return false;
        const old = edit.hand_indices;
        if (old.len == 1) {
            edit.deinit(self.allocator);
            _ = self.entries.swapRemove(idx);
            return true;
        }
        var next = self.allocator.alloc(usize, old.len - 1) catch return false;
        var w: usize = 0;
        for (old, 0..) |h, i| {
            if (i == at) continue;
            next[w] = h;
            w += 1;
        }
        self.allocator.free(old);
        edit.hand_indices = next;
        return true;
    }

    pub fn findExactKey(self: *const StrategyEditSet, key: node_lock.LockKey) ?*const StrategyEdit {
        const idx = self.findIndex(key) orelse return null;
        return &self.entries.items[idx];
    }

    pub fn clear(self: *StrategyEditSet) void {
        for (self.entries.items) |*edit| edit.deinit(self.allocator);
        self.entries.clearRetainingCapacity();
    }
};

pub const ApplyError = error{
    InvalidStrategyEdit,
    UnknownNode,
    NotDecision,
    HandOutOfRange,
    NoInfoset,
    OutOfMemory,
};

/// True when `hand` has a stored infoset slot on this decision + board.
pub fn handHasInfoset(
    game: compile.CompiledGame,
    node_index: u32,
    turn: i32,
    river: i32,
    hand: usize,
) ApplyError!bool {
    if (node_index >= game.nodes.len) return error.UnknownNode;
    const node = game.nodes[node_index];
    if (node.kind != .decision or node.n_actions == 0) return error.NotDecision;
    if (node.player < 0) return error.NotDecision;
    const n_hands: usize = @intCast(@max(game.hands.nHands(@intCast(node.player)), 0));
    if (hand >= n_hands) return error.HandOutOfRange;
    if (node.n_actions <= 1) return true;
    const key = game.cardKey(node, @intCast(hand), turn, river) catch return false;
    if (key < 0 or @as(usize, @intCast(key)) >= node.slot_of.len) return false;
    return node.slot_of[@intCast(key)] >= 0;
}

/// Write one hand's probability row into the published average table.
pub fn setAverageStrategyRow(
    game: compile.CompiledGame,
    average: []f32,
    node_index: u32,
    turn: i32,
    river: i32,
    hand: usize,
    probs: []const f64,
) ApplyError!void {
    if (node_index >= game.nodes.len) return error.UnknownNode;
    const node = game.nodes[node_index];
    if (node.kind != .decision or node.n_actions == 0) return error.NotDecision;
    if (probs.len != node.n_actions) return error.InvalidStrategyEdit;
    if (!validateStrategyProbs(probs, @intCast(node.n_actions))) return error.InvalidStrategyEdit;
    if (node.player < 0) return error.NotDecision;
    const n_hands: usize = @intCast(@max(game.hands.nHands(@intCast(node.player)), 0));
    if (hand >= n_hands) return error.HandOutOfRange;
    if (node.n_actions <= 1) return; // Implicit σ=1; nothing to store.
    const key = game.cardKey(node, @intCast(hand), turn, river) catch return error.NoInfoset;
    if (key < 0 or @as(usize, @intCast(key)) >= node.slot_of.len) return error.NoInfoset;
    const slot_i = node.slot_of[@intCast(key)];
    if (slot_i < 0) return error.NoInfoset;
    const base: usize = @intCast(game.slots[@intCast(slot_i)].base);
    if (base + node.n_actions > average.len) return error.InvalidStrategyEdit;
    var a: usize = 0;
    while (a < node.n_actions) : (a += 1) {
        average[base + a] = @floatCast(probs[a]);
    }
}

/// Apply one edit onto published average (full node or selected hands).
pub fn applyEditToAverage(
    game: compile.CompiledGame,
    average: []f32,
    edit: StrategyEdit,
) ApplyError!void {
    if (edit.infoset_id >= game.nodes.len) return error.UnknownNode;
    const node = game.nodes[edit.infoset_id];
    if (node.kind != .decision) return error.NotDecision;
    const turn: i32 = edit.turn;
    const river: i32 = edit.river;
    if (edit.kind == .full_node) {
        if (node.player < 0) return error.NotDecision;
        const n_hands: usize = @intCast(@max(game.hands.nHands(@intCast(node.player)), 0));
        var hand: usize = 0;
        while (hand < n_hands) : (hand += 1) {
            setAverageStrategyRow(game, average, @intCast(edit.infoset_id), turn, river, hand, edit.probs) catch |err| {
                // Skip hands without an infoset on this board (card removal).
                if (err == error.NoInfoset) continue;
                return err;
            };
        }
        return;
    }
    for (edit.hand_indices) |hand| {
        try setAverageStrategyRow(game, average, @intCast(edit.infoset_id), turn, river, hand, edit.probs);
    }
}

pub fn applyEditSetToAverage(
    game: compile.CompiledGame,
    average: []f32,
    edits: *const StrategyEditSet,
) ApplyError!void {
    for (edits.entries.items) |edit| {
        try applyEditToAverage(game, average, edit);
    }
}

pub fn formatStrategyEdit(allocator: std.mem.Allocator, edit: StrategyEdit) ![]u8 {
    var out = std.ArrayList(u8).init(allocator);
    errdefer out.deinit();
    try out.writer().print("edit {d} at {d} {d} ", .{ edit.infoset_id, edit.turn, edit.river });
    if (edit.kind == .full_node) {
        try out.appendSlice("full");
    } else {
        try out.appendSlice("combos ");
        for (edit.hand_indices, 0..) |h, i| {
            if (i > 0) try out.append(',');
            try out.writer().print("{d}", .{h});
        }
    }
    try out.appendSlice(" probs");
    for (edit.probs) |p| {
        try out.writer().print(" {d}", .{p});
    }
    return try out.toOwnedSlice();
}

pub fn formatStrategyEditSet(allocator: std.mem.Allocator, edits: *const StrategyEditSet) ![]u8 {
    var keys = try allocator.alloc(node_lock.LockKey, edits.entries.items.len);
    defer allocator.free(keys);
    for (edits.entries.items, 0..) |edit, i| keys[i] = edit.key();
    std.mem.sort(node_lock.LockKey, keys, {}, struct {
        fn less(_: void, a: node_lock.LockKey, b: node_lock.LockKey) bool {
            if (a.infoset_id != b.infoset_id) return a.infoset_id < b.infoset_id;
            if (a.turn != b.turn) return a.turn < b.turn;
            return a.river < b.river;
        }
    }.less);

    var out = std.ArrayList(u8).init(allocator);
    errdefer out.deinit();
    for (keys) |key| {
        const edit = edits.findExactKey(key) orelse continue;
        const line = try formatStrategyEdit(allocator, edit.*);
        defer allocator.free(line);
        try out.appendSlice(line);
        try out.append('\n');
    }
    return try out.toOwnedSlice();
}

fn splitWs(allocator: std.mem.Allocator, line: []const u8) ![][]const u8 {
    var parts = std.ArrayList([]const u8).init(allocator);
    errdefer parts.deinit();
    var i: usize = 0;
    while (i < line.len) {
        while (i < line.len and (line[i] == ' ' or line[i] == '\t')) : (i += 1) {}
        if (i >= line.len) break;
        const start = i;
        while (i < line.len and line[i] != ' ' and line[i] != '\t') : (i += 1) {}
        try parts.append(line[start..i]);
    }
    return try parts.toOwnedSlice();
}

fn parseSize(text: []const u8) !usize {
    return std.fmt.parseInt(usize, text, 10);
}

fn parseCardIndex(text: []const u8) !i32 {
    const value = try std.fmt.parseInt(i32, text, 10);
    if (value < -1 or value > 51) return error.InvalidStrategyEditText;
    return value;
}

fn parseProb(text: []const u8) !f64 {
    return std.fmt.parseFloat(f64, text);
}

fn parseComboList(allocator: std.mem.Allocator, text: []const u8) ![]usize {
    if (text.len == 0) return &.{};
    var count: usize = 1;
    for (text) |ch| {
        if (ch == ',') count += 1;
    }
    var out = try allocator.alloc(usize, count);
    errdefer allocator.free(out);
    var start: usize = 0;
    var w: usize = 0;
    var i: usize = 0;
    while (i <= text.len) : (i += 1) {
        if (i == text.len or text[i] == ',') {
            const piece = text[start..i];
            if (piece.len != 0) {
                out[w] = try parseSize(piece);
                w += 1;
            }
            start = i + 1;
        }
    }
    if (w != out.len) {
        return try allocator.realloc(out, w);
    }
    return out;
}

pub fn parseStrategyEdit(allocator: std.mem.Allocator, line: []const u8) !StrategyEdit {
    const parts = try splitWs(allocator, line);
    defer allocator.free(parts);
    if (parts.len < 6 or !std.mem.eql(u8, parts[0], "edit")) return error.InvalidStrategyEditText;

    var edit = StrategyEdit{};
    errdefer edit.deinit(allocator);
    edit.infoset_id = try parseSize(parts[1]);
    if (!std.mem.eql(u8, parts[2], "at")) return error.InvalidStrategyEditText;
    edit.turn = @intCast(try parseCardIndex(parts[3]));
    edit.river = @intCast(try parseCardIndex(parts[4]));
    var index: usize = 5;
    if (std.mem.eql(u8, parts[index], "full")) {
        edit.kind = .full_node;
        index += 1;
    } else if (std.mem.eql(u8, parts[index], "combos")) {
        edit.kind = .selected_combos;
        index += 1;
        if (index >= parts.len) return error.InvalidStrategyEditText;
        if (!std.mem.eql(u8, parts[index], "probs")) {
            edit.hand_indices = try parseComboList(allocator, parts[index]);
            index += 1;
        }
    } else return error.InvalidStrategyEditText;

    if (index >= parts.len or !std.mem.eql(u8, parts[index], "probs")) return error.InvalidStrategyEditText;
    index += 1;
    const n = parts.len - index;
    if (n == 0) return error.InvalidStrategyEditText;
    var probs = try allocator.alloc(f64, n);
    errdefer allocator.free(probs);
    var p: usize = 0;
    while (index < parts.len) : ({
        index += 1;
        p += 1;
    }) {
        probs[p] = try parseProb(parts[index]);
    }
    if (!validateStrategyProbs(probs, @intCast(probs.len))) return error.InvalidStrategyEditText;
    edit.probs = probs;
    return edit;
}

pub fn parseStrategyEditSet(allocator: std.mem.Allocator, text: []const u8) !StrategyEditSet {
    var edits = StrategyEditSet.init(allocator);
    errdefer edits.deinit();
    var start: usize = 0;
    while (start < text.len) {
        const end = std.mem.indexOfScalarPos(u8, text, start, '\n') orelse text.len;
        const line = text[start..end];
        var nonempty = false;
        for (line) |ch| {
            if (ch != ' ' and ch != '\t') {
                nonempty = true;
                break;
            }
        }
        if (nonempty) {
            const edit = try parseStrategyEdit(allocator, line);
            try edits.upsert(edit);
        }
        if (end == text.len) break;
        start = end + 1;
    }
    return edits;
}

test "strategy edit set upsert erase hand" {
    var edits = StrategyEditSet.init(std.testing.allocator);
    defer edits.deinit();
    const probs = try makeStrategyProbs(std.testing.allocator, &[_]f64{ 0.2, 0.8 }, 2);
    defer std.testing.allocator.free(probs);
    try edits.upsert(.{
        .infoset_id = 0,
        .kind = .full_node,
        .probs = try std.testing.allocator.dupe(f64, probs),
    });
    try std.testing.expectEqual(@as(usize, 1), edits.size());

    const hands = try std.testing.allocator.dupe(usize, &[_]usize{ 0, 1 });
    try edits.upsert(.{
        .infoset_id = 0,
        .kind = .selected_combos,
        .hand_indices = hands,
        .probs = try std.testing.allocator.dupe(f64, &[_]f64{ 1.0, 0.0 }),
    });
    try std.testing.expect(edits.findExactKey(node_lock.makeLockKey(0, -1, -1)).?.kind == .selected_combos);
    try std.testing.expect(edits.eraseHand(node_lock.makeLockKey(0, -1, -1), 1));
    try std.testing.expectEqual(@as(usize, 1), edits.findExactKey(node_lock.makeLockKey(0, -1, -1)).?.hand_indices.len);
    try std.testing.expect(edits.eraseHand(node_lock.makeLockKey(0, -1, -1), 0));
    try std.testing.expect(edits.empty());
}

test "strategy edit text round trip" {
    var edits = StrategyEditSet.init(std.testing.allocator);
    defer edits.deinit();
    try edits.upsert(.{
        .infoset_id = 3,
        .turn = 12,
        .river = -1,
        .kind = .selected_combos,
        .hand_indices = try std.testing.allocator.dupe(usize, &[_]usize{ 1, 4 }),
        .probs = try std.testing.allocator.dupe(f64, &[_]f64{ 0.25, 0.75 }),
    });
    const text = try formatStrategyEditSet(std.testing.allocator, &edits);
    defer std.testing.allocator.free(text);
    var round = try parseStrategyEditSet(std.testing.allocator, text);
    defer round.deinit();
    try std.testing.expectEqual(@as(usize, 1), round.size());
    const got = round.findExactKey(node_lock.makeLockKey(3, 12, -1)).?;
    try std.testing.expect(got.kind == .selected_combos);
    try std.testing.expectEqual(@as(usize, 2), got.hand_indices.len);
    try std.testing.expectEqual(@as(usize, 1), got.hand_indices[0]);
    try std.testing.expectApproxEqAbs(@as(f64, 0.25), got.probs[0], 1e-12);
}

test "validate strategy probs rejects empty or bad sum" {
    try std.testing.expect(validateStrategyProbs(&[_]f64{ 0.25, 0.75 }, 2));
    try std.testing.expect(!validateStrategyProbs(&[_]f64{}, 2));
    try std.testing.expect(!validateStrategyProbs(&[_]f64{ 0.5, 0.4 }, 2));
    try std.testing.expect(!validateStrategyProbs(&[_]f64{ -0.1, 1.1 }, 2));
}
