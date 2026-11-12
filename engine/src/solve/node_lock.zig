//! Node / line lock model + text codec (C++ include/solver/node_lock.hpp).
//! Study overlay persistence uses this text in `.psol` v4. Row helpers
//! (`applyLockToStrategy` / `applyLockToStrategyF32`) overwrite regret-matched
//! σ; frozen CFR freeze/floorAndFreeze call the f32 helper (C++ `apply_freeze_range`).
const std = @import("std");

pub const lock_prob_sum_tolerance: f64 = 1e-12;

pub const LockKind = enum { full_node, selected_combos };
pub const LockScope = enum { node, line };

pub const ActionLockRow = struct {
    probs: []f64 = &.{},

    pub fn unlocked(self: ActionLockRow) bool {
        return self.probs.len == 0;
    }

    pub fn deinit(self: *ActionLockRow, allocator: std.mem.Allocator) void {
        if (self.probs.len != 0) allocator.free(self.probs);
        self.probs = &.{};
    }
};

pub const NodeLock = struct {
    infoset_id: usize = 0,
    turn: i8 = -1,
    river: i8 = -1,
    scope: LockScope = .node,
    kind: LockKind = .full_node,
    combo_indices: []usize = &.{},
    actions: ActionLockRow = .{},

    pub fn isLine(self: NodeLock) bool {
        return self.scope == .line;
    }

    pub fn key(self: NodeLock) LockKey {
        return makeLockKey(self.infoset_id, self.turn, self.river);
    }

    pub fn deinit(self: *NodeLock, allocator: std.mem.Allocator) void {
        if (self.combo_indices.len != 0) allocator.free(self.combo_indices);
        self.combo_indices = &.{};
        self.actions.deinit(allocator);
    }
};

pub const LockKey = struct {
    infoset_id: usize = 0,
    turn: i8 = -1,
    river: i8 = -1,

    pub fn isLine(self: LockKey) bool {
        return self.turn < 0 and self.river < 0;
    }

    pub fn eql(a: LockKey, b: LockKey) bool {
        return a.infoset_id == b.infoset_id and a.turn == b.turn and a.river == b.river;
    }
};

pub fn makeLockKey(infoset_id: usize, turn: i32, river: i32) LockKey {
    return .{
        .infoset_id = infoset_id,
        .turn = @intCast(turn),
        .river = @intCast(river),
    };
}

pub fn lineLockKey(infoset_id: usize) LockKey {
    return makeLockKey(infoset_id, -1, -1);
}

pub fn validateActionRow(probs: []const f64, action_count: i32) bool {
    if (probs.len == 0) return true;
    if (action_count < 0 or @as(usize, @intCast(action_count)) != probs.len) return false;
    var sum: f64 = 0;
    for (probs) |p| {
        if (!std.math.isFinite(p) or p < 0.0) return false;
        sum += p;
    }
    return @abs(sum - 1.0) <= lock_prob_sum_tolerance;
}

pub fn makeActionLockRow(allocator: std.mem.Allocator, probs: []const f64, action_count: i32) !ActionLockRow {
    if (!validateActionRow(probs, action_count)) return error.InvalidLockRow;
    if (probs.len == 0) return .{};
    const owned = try allocator.dupe(f64, probs);
    return .{ .probs = owned };
}

pub fn comboIsSelected(lock: NodeLock, combo_index: usize) bool {
    for (lock.combo_indices) |index| {
        if (index == combo_index) return true;
    }
    return false;
}

/// Locked probability for (combo, action), or null when free.
pub fn lockedProbability(lock: NodeLock, combo_index: usize, action: usize) ?f64 {
    if (lock.actions.unlocked()) return null;
    if (action >= lock.actions.probs.len) return null;
    if (lock.kind == .selected_combos and !comboIsSelected(lock, combo_index)) return null;
    return lock.actions.probs[action];
}

/// Overwrite `probs` from a lock when it applies. Returns true when applied.
pub fn applyLockToStrategy(probs: []f64, lock: ?*const NodeLock, combo_index: usize) !bool {
    const L = lock orelse return false;
    if (L.actions.unlocked()) return false;
    if (L.kind == .selected_combos and !comboIsSelected(L.*, combo_index)) return false;
    if (probs.len != L.actions.probs.len) return error.LockActionCountMismatch;
    @memcpy(probs, L.actions.probs);
    return true;
}

/// f32 σ tables (TrainingState / StreetBatch). Same contract as C++ float overload.
pub fn applyLockToStrategyF32(probs: []f32, lock: ?*const NodeLock, combo_index: usize) !bool {
    const L = lock orelse return false;
    if (L.actions.unlocked()) return false;
    if (L.kind == .selected_combos and !comboIsSelected(L.*, combo_index)) return false;
    if (probs.len != L.actions.probs.len) return error.LockActionCountMismatch;
    for (probs, L.actions.probs) |*dst, src| {
        dst.* = @floatCast(src);
    }
    return true;
}

pub const LockSet = struct {
    allocator: std.mem.Allocator,
    entries: std.ArrayList(NodeLock),

    pub fn init(allocator: std.mem.Allocator) LockSet {
        return .{ .allocator = allocator, .entries = std.ArrayList(NodeLock).init(allocator) };
    }

    pub fn deinit(self: *LockSet) void {
        for (self.entries.items) |*lock| lock.deinit(self.allocator);
        self.entries.deinit();
    }

    pub fn empty(self: *const LockSet) bool {
        return self.entries.items.len == 0;
    }

    pub fn size(self: *const LockSet) usize {
        return self.entries.items.len;
    }

    fn findIndex(self: *const LockSet, key: LockKey) ?usize {
        for (self.entries.items, 0..) |lock, i| {
            if (LockKey.eql(lock.key(), key)) return i;
        }
        return null;
    }

    pub fn upsert(self: *LockSet, lock: NodeLock) !void {
        const key = lock.key();
        if (self.findIndex(key)) |idx| {
            self.entries.items[idx].deinit(self.allocator);
            self.entries.items[idx] = lock;
            return;
        }
        try self.entries.append(lock);
    }

    pub fn eraseKey(self: *LockSet, key: LockKey) bool {
        const idx = self.findIndex(key) orelse return false;
        self.entries.items[idx].deinit(self.allocator);
        _ = self.entries.swapRemove(idx);
        return true;
    }

    pub fn erase(self: *LockSet, infoset_id: usize) bool {
        return self.eraseKey(lineLockKey(infoset_id));
    }

    pub fn eraseExact(self: *LockSet, infoset_id: usize, turn: i32, river: i32) bool {
        return self.eraseKey(makeLockKey(infoset_id, turn, river));
    }

    pub fn eraseComboKey(self: *LockSet, key: LockKey, combo_index: usize) bool {
        const idx = self.findIndex(key) orelse return false;
        const lock = &self.entries.items[idx];
        if (lock.kind != .selected_combos) return false;
        var found: ?usize = null;
        for (lock.combo_indices, 0..) |c, i| {
            if (c == combo_index) {
                found = i;
                break;
            }
        }
        const at = found orelse return false;
        const old = lock.combo_indices;
        if (old.len == 1) {
            lock.deinit(self.allocator);
            _ = self.entries.swapRemove(idx);
            return true;
        }
        var next = self.allocator.alloc(usize, old.len - 1) catch return false;
        var w: usize = 0;
        for (old, 0..) |c, i| {
            if (i == at) continue;
            next[w] = c;
            w += 1;
        }
        self.allocator.free(old);
        lock.combo_indices = next;
        return true;
    }

    pub fn eraseCombo(self: *LockSet, infoset_id: usize, combo_index: usize) bool {
        return self.eraseComboKey(lineLockKey(infoset_id), combo_index);
    }

    pub fn findExactKey(self: *const LockSet, key: LockKey) ?*const NodeLock {
        const idx = self.findIndex(key) orelse return null;
        return &self.entries.items[idx];
    }

    pub fn findExact(self: *const LockSet, infoset_id: usize, turn: i32, river: i32) ?*const NodeLock {
        return self.findExactKey(makeLockKey(infoset_id, turn, river));
    }

    pub fn find(self: *const LockSet, infoset_id: usize) ?*const NodeLock {
        return self.findExactKey(lineLockKey(infoset_id));
    }

    pub fn findForRunout(self: *const LockSet, infoset_id: usize, turn: i32, river: i32) ?*const NodeLock {
        if (self.findExact(infoset_id, turn, river)) |exact| return exact;
        if (turn >= 0 or river >= 0) return self.findExactKey(lineLockKey(infoset_id));
        return null;
    }

    pub fn clear(self: *LockSet) void {
        for (self.entries.items) |*lock| lock.deinit(self.allocator);
        self.entries.clearRetainingCapacity();
    }
};

pub fn formatNodeLock(allocator: std.mem.Allocator, lock: NodeLock) ![]u8 {
    var out = std.ArrayList(u8).init(allocator);
    errdefer out.deinit();
    try out.writer().print("lock {d}", .{lock.infoset_id});
    if (lock.scope == .line) {
        try out.appendSlice(" line");
    } else {
        try out.writer().print(" at {d} {d}", .{ lock.turn, lock.river });
    }
    try out.append(' ');
    if (lock.kind == .full_node) {
        try out.appendSlice("full");
    } else {
        try out.appendSlice("combos ");
        for (lock.combo_indices, 0..) |c, i| {
            if (i > 0) try out.append(',');
            try out.writer().print("{d}", .{c});
        }
    }
    if (!lock.actions.unlocked()) {
        try out.appendSlice(" probs");
        for (lock.actions.probs) |p| {
            try out.writer().print(" {d}", .{p});
        }
    }
    return try out.toOwnedSlice();
}

pub fn formatLockSet(allocator: std.mem.Allocator, locks: *const LockSet) ![]u8 {
    var keys = try allocator.alloc(LockKey, locks.entries.items.len);
    defer allocator.free(keys);
    for (locks.entries.items, 0..) |lock, i| keys[i] = lock.key();
    std.mem.sort(LockKey, keys, {}, struct {
        fn less(_: void, a: LockKey, b: LockKey) bool {
            if (a.infoset_id != b.infoset_id) return a.infoset_id < b.infoset_id;
            if (a.turn != b.turn) return a.turn < b.turn;
            return a.river < b.river;
        }
    }.less);

    var out = std.ArrayList(u8).init(allocator);
    errdefer out.deinit();
    for (keys) |key| {
        const lock = locks.findExactKey(key) orelse continue;
        const line = try formatNodeLock(allocator, lock.*);
        defer allocator.free(line);
        try out.appendSlice(line);
        try out.append('\n');
    }
    return try out.toOwnedSlice();
}

fn parseSize(text: []const u8) !usize {
    return std.fmt.parseInt(usize, text, 10);
}

fn parseCardIndex(text: []const u8) !i32 {
    const value = try std.fmt.parseInt(i32, text, 10);
    if (value < -1 or value > 51) return error.InvalidLockText;
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

pub fn parseNodeLock(allocator: std.mem.Allocator, line: []const u8) !NodeLock {
    const parts = try splitWs(allocator, line);
    defer allocator.free(parts);
    if (parts.len < 3 or !std.mem.eql(u8, parts[0], "lock")) return error.InvalidLockText;

    var lock = NodeLock{};
    errdefer lock.deinit(allocator);
    lock.infoset_id = try parseSize(parts[1]);
    var index: usize = 2;
    if (index < parts.len and std.mem.eql(u8, parts[index], "at")) {
        if (index + 2 >= parts.len) return error.InvalidLockText;
        lock.scope = .node;
        lock.turn = @intCast(try parseCardIndex(parts[index + 1]));
        lock.river = @intCast(try parseCardIndex(parts[index + 2]));
        index += 3;
    } else if (index < parts.len and std.mem.eql(u8, parts[index], "line")) {
        lock.scope = .line;
        lock.turn = -1;
        lock.river = -1;
        index += 1;
    } else {
        // Legacy without at|line → line-wide (prior Explorer).
        lock.scope = .line;
        lock.turn = -1;
        lock.river = -1;
    }
    if (index >= parts.len) return error.InvalidLockText;
    if (std.mem.eql(u8, parts[index], "full")) {
        lock.kind = .full_node;
        index += 1;
    } else if (std.mem.eql(u8, parts[index], "combos")) {
        lock.kind = .selected_combos;
        index += 1;
        if (index >= parts.len) return error.InvalidLockText;
        if (!std.mem.eql(u8, parts[index], "probs")) {
            lock.combo_indices = try parseComboList(allocator, parts[index]);
            index += 1;
        }
    } else return error.InvalidLockText;

    if (index < parts.len) {
        if (!std.mem.eql(u8, parts[index], "probs")) return error.InvalidLockText;
        index += 1;
        const n = parts.len - index;
        var probs = try allocator.alloc(f64, n);
        errdefer allocator.free(probs);
        var p: usize = 0;
        while (index < parts.len) : ({
            index += 1;
            p += 1;
        }) {
            probs[p] = try parseProb(parts[index]);
        }
        lock.actions = try makeActionLockRow(allocator, probs, @intCast(probs.len));
        allocator.free(probs);
    }
    return lock;
}

pub fn parseLockSet(allocator: std.mem.Allocator, text: []const u8) !LockSet {
    var locks = LockSet.init(allocator);
    errdefer locks.deinit();
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
            const lock = try parseNodeLock(allocator, line);
            try locks.upsert(lock);
        }
        if (end == text.len) break;
        start = end + 1;
    }
    return locks;
}
