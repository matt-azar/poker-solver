//! Node / line lock model + text codec (C++ include/solver/node_lock.hpp).
//! Study overlay persistence uses this text in `.psol` v4. Row helpers
//! (`applyLockToStrategy` / `applyLockToStrategyF32`) overwrite regret-matched
//! σ; frozen CFR freeze/floorAndFreeze call the f32 helper (C++ `apply_freeze_range`).
//!
//! Pio-style locks freeze each combo's own action mix. Prefer
//! `combo_indices` + `combo_actions` (parallel per-combo rows). Legacy shared
//! `actions` still forces one mix onto every locked combo.
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
    /// Legacy shared mix applied to every locked combo when `combo_actions` is empty.
    actions: ActionLockRow = .{},
    /// Per-combo mixes parallel to `combo_indices`. When non-empty, length must
    /// equal `combo_indices.len`; listed combos use their own row.
    combo_actions: []ActionLockRow = &.{},

    pub fn isLine(self: NodeLock) bool {
        return self.scope == .line;
    }

    pub fn key(self: NodeLock) LockKey {
        return makeScopedLockKey(self.infoset_id, self.turn, self.river, self.scope);
    }

    pub fn hasPerComboActions(self: NodeLock) bool {
        return self.combo_actions.len != 0;
    }

    /// Fully unlocked node sentinel (board-local clear while a line lock remains).
    pub fn isUnlockAllSentinel(self: NodeLock) bool {
        return self.scope == .node and self.kind == .full_node and self.actions.unlocked() and !self.hasPerComboActions();
    }

    pub fn deinit(self: *NodeLock, allocator: std.mem.Allocator) void {
        if (self.combo_indices.len != 0) allocator.free(self.combo_indices);
        self.combo_indices = &.{};
        self.actions.deinit(allocator);
        if (self.combo_actions.len != 0) {
            for (self.combo_actions) |*row| row.deinit(allocator);
            allocator.free(self.combo_actions);
            self.combo_actions = &.{};
        }
    }
};

pub const LockKey = struct {
    infoset_id: usize = 0,
    turn: i8 = -1,
    river: i8 = -1,
    /// Distinguishes flop-root node locks (`at -1 -1`) from line locks (`line`).
    scope: LockScope = .node,

    pub fn isLine(self: LockKey) bool {
        return self.scope == .line;
    }

    pub fn eql(a: LockKey, b: LockKey) bool {
        return a.infoset_id == b.infoset_id and a.turn == b.turn and a.river == b.river and a.scope == b.scope;
    }
};

pub fn makeScopedLockKey(infoset_id: usize, turn: i32, river: i32, scope: LockScope) LockKey {
    return .{
        .infoset_id = infoset_id,
        .turn = @intCast(turn),
        .river = @intCast(river),
        .scope = scope,
    };
}

/// Node-scoped key for an exact board (including flop-root `t-1.r-1`).
pub fn makeLockKey(infoset_id: usize, turn: i32, river: i32) LockKey {
    return makeScopedLockKey(infoset_id, turn, river, .node);
}

pub fn lineLockKey(infoset_id: usize) LockKey {
    return makeScopedLockKey(infoset_id, -1, -1, .line);
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

/// Build parallel per-combo action rows. `rows[i]` belongs to `combo_indices[i]`.
pub fn makeComboActionRows(
    allocator: std.mem.Allocator,
    combo_indices: []const usize,
    rows: []const []const f64,
    action_count: i32,
) ![]ActionLockRow {
    if (combo_indices.len != rows.len) return error.InvalidLockRow;
    if (combo_indices.len == 0) return &.{};
    var out = try allocator.alloc(ActionLockRow, rows.len);
    errdefer {
        for (out[0..]) |*row| row.deinit(allocator);
        allocator.free(out);
    }
    var i: usize = 0;
    while (i < rows.len) : (i += 1) {
        out[i] = try makeActionLockRow(allocator, rows[i], action_count);
        if (out[i].unlocked()) return error.InvalidLockRow;
    }
    return out;
}

pub fn comboIsSelected(lock: NodeLock, combo_index: usize) bool {
    for (lock.combo_indices) |index| {
        if (index == combo_index) return true;
    }
    return false;
}

fn comboRowIndex(lock: NodeLock, combo_index: usize) ?usize {
    for (lock.combo_indices, 0..) |index, i| {
        if (index == combo_index) return i;
    }
    return null;
}

/// True when this lock constrains `combo_index` (mask only; ignores empty rows).
pub fn comboIsLocked(lock: NodeLock, combo_index: usize) bool {
    if (lock.isUnlockAllSentinel()) return false;
    if (lock.hasPerComboActions()) {
        if (comboRowIndex(lock, combo_index)) |idx| {
            return !lock.combo_actions[idx].unlocked();
        }
        // full_node with shared fallback keeps unlisted locked.
        if (lock.kind == .full_node and !lock.actions.unlocked()) return true;
        return false;
    }
    if (lock.actions.unlocked()) return false;
    if (lock.kind == .selected_combos and !comboIsSelected(lock, combo_index)) return false;
    return true;
}

/// Locked probability row for a combo, or null when free.
pub fn lockedActionRow(lock: NodeLock, combo_index: usize) ?[]const f64 {
    if (lock.hasPerComboActions()) {
        if (comboRowIndex(lock, combo_index)) |idx| {
            const row = lock.combo_actions[idx];
            if (row.unlocked()) return null;
            return row.probs;
        }
        // full_node + partial combo_actions: unlisted still use shared actions.
        if (lock.kind == .full_node and !lock.actions.unlocked()) return lock.actions.probs;
        return null;
    }
    if (lock.actions.unlocked()) return null;
    if (lock.kind == .selected_combos and !comboIsSelected(lock, combo_index)) return null;
    return lock.actions.probs;
}

/// Locked probability for (combo, action), or null when free.
pub fn lockedProbability(lock: NodeLock, combo_index: usize, action: usize) ?f64 {
    const row = lockedActionRow(lock, combo_index) orelse return null;
    if (action >= row.len) return null;
    return row[action];
}

/// Overwrite `probs` from a lock when it applies. Returns true when applied.
pub fn applyLockToStrategy(probs: []f64, lock: ?*const NodeLock, combo_index: usize) !bool {
    const L = lock orelse return false;
    const row = lockedActionRow(L.*, combo_index) orelse return false;
    if (probs.len != row.len) return error.LockActionCountMismatch;
    @memcpy(probs, row);
    return true;
}

/// f32 σ tables (TrainingState / StreetBatch). Same contract as C++ float overload.
pub fn applyLockToStrategyF32(probs: []f32, lock: ?*const NodeLock, combo_index: usize) !bool {
    const L = lock orelse return false;
    const row = lockedActionRow(L.*, combo_index) orelse return false;
    if (probs.len != row.len) return error.LockActionCountMismatch;
    for (probs, row) |*dst, src| {
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

    /// Replace-or-insert at `lock.key()` (no merge).
    pub fn upsert(self: *LockSet, lock: NodeLock) !void {
        if (lock.hasPerComboActions() and lock.combo_actions.len != lock.combo_indices.len) {
            return error.InvalidLockRow;
        }
        const key = lock.key();
        if (self.findIndex(key)) |idx| {
            self.entries.items[idx].deinit(self.allocator);
            self.entries.items[idx] = lock;
            return;
        }
        try self.entries.append(lock);
    }

    /// Merge selected / per-combo `patch` into the record at the same key.
    /// Full-node shared patches replace. Selected patches union into the mask
    /// (locking A then B keeps A). Caller transfers ownership of `patch`.
    pub fn mergeUpsert(self: *LockSet, patch: NodeLock) !void {
        if (patch.hasPerComboActions() and patch.combo_actions.len != patch.combo_indices.len) {
            return error.InvalidLockRow;
        }
        // Full shared replace, or unlock-all sentinel, or empty selected → upsert.
        const patch_is_mask_merge = patch.kind == .selected_combos or patch.hasPerComboActions();
        if (!patch_is_mask_merge) {
            return self.upsert(patch);
        }
        const key = patch.key();
        const idx = self.findIndex(key) orelse {
            try self.entries.append(patch);
            return;
        };
        const existing = &self.entries.items[idx];
        // Merge patch combos into existing; patch rows win on conflict.
        const merged = try mergeLockMasks(self.allocator, existing.*, patch);
        existing.deinit(self.allocator);
        var doomed = patch;
        doomed.deinit(self.allocator);
        self.entries.items[idx] = merged;
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

    /// Remove one combo from the mask at `key`. Full-node shared locks become
    /// selected with every hand except `combo_index` when `n_hands` is known;
    /// pass `n_hands=0` only when the lock already lists combos / per-combo rows.
    pub fn eraseComboKey(self: *LockSet, key: LockKey, combo_index: usize, n_hands: usize) bool {
        const idx = self.findIndex(key) orelse return false;
        const lock = &self.entries.items[idx];
        // Per-combo rows: remove that combo from the parallel arrays.
        if (lock.hasPerComboActions()) {
            const at = comboRowIndex(lock.*, combo_index) orelse return false;
            const old_idx = lock.combo_indices;
            const old_rows = lock.combo_actions;
            if (old_idx.len == 1) {
                // Last combo → unlock-all sentinel for node scope; delete for line.
                if (lock.scope == .node) {
                    lock.deinit(self.allocator);
                    self.entries.items[idx] = .{
                        .infoset_id = key.infoset_id,
                        .turn = key.turn,
                        .river = key.river,
                        .scope = .node,
                        .kind = .full_node,
                    };
                    return true;
                }
                lock.deinit(self.allocator);
                _ = self.entries.swapRemove(idx);
                return true;
            }
            var next_idx = self.allocator.alloc(usize, old_idx.len - 1) catch return false;
            errdefer self.allocator.free(next_idx);
            var next_rows = self.allocator.alloc(ActionLockRow, old_rows.len - 1) catch {
                self.allocator.free(next_idx);
                return false;
            };
            var w: usize = 0;
            for (old_idx, 0..) |c, i| {
                if (i == at) {
                    old_rows[i].deinit(self.allocator);
                    continue;
                }
                next_idx[w] = c;
                next_rows[w] = old_rows[i];
                w += 1;
            }
            self.allocator.free(old_idx);
            self.allocator.free(old_rows);
            lock.combo_indices = next_idx;
            lock.combo_actions = next_rows;
            lock.kind = .selected_combos;
            return true;
        }
        if (lock.kind == .full_node and !lock.actions.unlocked()) {
            // Convert shared full-node → selected mask minus the unlocked combo.
            if (n_hands == 0 or combo_index >= n_hands) return false;
            const shared = lock.actions.probs;
            const keep_n = n_hands - 1;
            if (keep_n == 0) {
                if (lock.scope == .node) {
                    lock.actions.deinit(self.allocator);
                    lock.* = .{
                        .infoset_id = key.infoset_id,
                        .turn = key.turn,
                        .river = key.river,
                        .scope = .node,
                        .kind = .full_node,
                    };
                    return true;
                }
                lock.deinit(self.allocator);
                _ = self.entries.swapRemove(idx);
                return true;
            }
            var next_idx = self.allocator.alloc(usize, keep_n) catch return false;
            errdefer self.allocator.free(next_idx);
            var row_slices = self.allocator.alloc([]const f64, keep_n) catch {
                self.allocator.free(next_idx);
                return false;
            };
            defer self.allocator.free(row_slices);
            var w: usize = 0;
            var h: usize = 0;
            while (h < n_hands) : (h += 1) {
                if (h == combo_index) continue;
                next_idx[w] = h;
                row_slices[w] = shared;
                w += 1;
            }
            const rows = makeComboActionRows(self.allocator, next_idx, row_slices, @intCast(shared.len)) catch {
                self.allocator.free(next_idx);
                return false;
            };
            lock.actions.deinit(self.allocator);
            if (lock.combo_indices.len != 0) self.allocator.free(lock.combo_indices);
            lock.kind = .selected_combos;
            lock.combo_indices = next_idx;
            lock.combo_actions = rows;
            return true;
        }
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
            if (lock.scope == .node) {
                lock.deinit(self.allocator);
                self.entries.items[idx] = .{
                    .infoset_id = key.infoset_id,
                    .turn = key.turn,
                    .river = key.river,
                    .scope = .node,
                    .kind = .full_node,
                };
                return true;
            }
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
        return self.eraseComboKey(lineLockKey(infoset_id), combo_index, 0);
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

    /// Exact node board first (including flop-root `t-1.r-1`), else line.
    pub fn findForRunout(self: *const LockSet, infoset_id: usize, turn: i32, river: i32) ?*const NodeLock {
        if (self.findExactKey(makeLockKey(infoset_id, turn, river))) |exact| {
            if (exact.isUnlockAllSentinel()) return exact; // board-local clear
            return exact;
        }
        return self.findExactKey(lineLockKey(infoset_id));
    }

    pub fn clear(self: *LockSet) void {
        for (self.entries.items) |*lock| lock.deinit(self.allocator);
        self.entries.clearRetainingCapacity();
    }
};

const ComboRowRef = struct { combo: usize, probs: []const f64 };

/// Union two lock masks at the same key. `patch` rows win on combo conflict.
fn mergeLockMasks(allocator: std.mem.Allocator, base: NodeLock, patch: NodeLock) !NodeLock {
    var map = std.AutoHashMap(usize, []const f64).init(allocator);
    defer map.deinit();

    // Seed from base.
    if (base.hasPerComboActions()) {
        for (base.combo_indices) |c| {
            if (lockedActionRow(base, c)) |row| try map.put(c, row);
        }
    } else if (base.kind == .selected_combos and !base.actions.unlocked()) {
        for (base.combo_indices) |c| try map.put(c, base.actions.probs);
    }

    // Patch overwrites / adds.
    if (patch.hasPerComboActions()) {
        for (patch.combo_indices) |c| {
            if (lockedActionRow(patch, c)) |row| try map.put(c, row);
        }
    } else if (patch.kind == .selected_combos and !patch.actions.unlocked()) {
        for (patch.combo_indices) |c| try map.put(c, patch.actions.probs);
    }

    var out = NodeLock{
        .infoset_id = patch.infoset_id,
        .turn = patch.turn,
        .river = patch.river,
        .scope = patch.scope,
        .kind = .selected_combos,
    };
    errdefer out.deinit(allocator);

    if (map.count() == 0) {
        if (base.kind == .full_node and !base.actions.unlocked()) {
            out.kind = .full_node;
            out.actions = try makeActionLockRow(allocator, base.actions.probs, @intCast(base.actions.probs.len));
            return out;
        }
        return out;
    }

    var entries = try allocator.alloc(ComboRowRef, map.count());
    defer allocator.free(entries);
    var it = map.iterator();
    var w: usize = 0;
    while (it.next()) |entry| {
        entries[w] = .{ .combo = entry.key_ptr.*, .probs = entry.value_ptr.* };
        w += 1;
    }
    std.mem.sort(ComboRowRef, entries, {}, struct {
        fn less(_: void, a: ComboRowRef, b: ComboRowRef) bool {
            return a.combo < b.combo;
        }
    }.less);

    var indices = try allocator.alloc(usize, entries.len);
    errdefer allocator.free(indices);
    var row_bufs = try allocator.alloc([]const f64, entries.len);
    defer allocator.free(row_bufs);
    for (entries, 0..) |e, i| {
        indices[i] = e.combo;
        row_bufs[i] = e.probs;
    }
    out.combo_indices = indices;
    out.combo_actions = try makeComboActionRows(allocator, indices, row_bufs, @intCast(row_bufs[0].len));

    if (base.kind == .full_node and !base.actions.unlocked() and !base.hasPerComboActions()) {
        out.actions = try makeActionLockRow(allocator, base.actions.probs, @intCast(base.actions.probs.len));
        out.kind = .full_node;
    }
    return out;
}

/// Copy every locked combo from `src` into a new node-scoped lock at (turn, river).
pub fn materializeNodeFromLine(
    allocator: std.mem.Allocator,
    line: NodeLock,
    turn: i32,
    river: i32,
    n_hands: usize,
) !NodeLock {
    var out = NodeLock{
        .infoset_id = line.infoset_id,
        .turn = @intCast(turn),
        .river = @intCast(river),
        .scope = .node,
        .kind = .selected_combos,
    };
    errdefer out.deinit(allocator);

    if (line.hasPerComboActions()) {
        const indices = try allocator.dupe(usize, line.combo_indices);
        errdefer allocator.free(indices);
        var row_bufs = try allocator.alloc([]const f64, line.combo_actions.len);
        defer allocator.free(row_bufs);
        for (line.combo_actions, 0..) |row, i| row_bufs[i] = row.probs;
        out.combo_indices = indices;
        out.combo_actions = try makeComboActionRows(allocator, indices, row_bufs, @intCast(row_bufs[0].len));
        return out;
    }
    if (line.kind == .selected_combos and !line.actions.unlocked()) {
        out.combo_indices = try allocator.dupe(usize, line.combo_indices);
        out.actions = try makeActionLockRow(allocator, line.actions.probs, @intCast(line.actions.probs.len));
        return out;
    }
    if (line.kind == .full_node and !line.actions.unlocked()) {
        if (n_hands == 0) {
            out.kind = .full_node;
            out.actions = try makeActionLockRow(allocator, line.actions.probs, @intCast(line.actions.probs.len));
            return out;
        }
        var indices = try allocator.alloc(usize, n_hands);
        errdefer allocator.free(indices);
        var row_bufs = try allocator.alloc([]const f64, n_hands);
        defer allocator.free(row_bufs);
        var h: usize = 0;
        while (h < n_hands) : (h += 1) {
            indices[h] = h;
            row_bufs[h] = line.actions.probs;
        }
        out.combo_indices = indices;
        out.combo_actions = try makeComboActionRows(allocator, indices, row_bufs, @intCast(line.actions.probs.len));
        return out;
    }
    // Unlocked line → unlock-all node sentinel.
    out.kind = .full_node;
    return out;
}

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
    if (lock.hasPerComboActions()) {
        // Per-combo always encodes the locked combo list + rows.
        try out.appendSlice("combos ");
        for (lock.combo_indices, 0..) |c, i| {
            if (i > 0) try out.append(',');
            try out.writer().print("{d}", .{c});
        }
        try out.appendSlice(" combo_probs");
        for (lock.combo_actions, 0..) |row, ri| {
            if (ri > 0) try out.appendSlice(" ;");
            for (row.probs) |p| {
                try out.writer().print(" {d}", .{p});
            }
        }
    } else if (lock.kind == .full_node) {
        try out.appendSlice("full");
        if (!lock.actions.unlocked()) {
            try out.appendSlice(" probs");
            for (lock.actions.probs) |p| {
                try out.writer().print(" {d}", .{p});
            }
        }
    } else {
        try out.appendSlice("combos ");
        for (lock.combo_indices, 0..) |c, i| {
            if (i > 0) try out.append(',');
            try out.writer().print("{d}", .{c});
        }
        if (!lock.actions.unlocked()) {
            try out.appendSlice(" probs");
            for (lock.actions.probs) |p| {
                try out.writer().print(" {d}", .{p});
            }
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
            if (@intFromEnum(a.scope) != @intFromEnum(b.scope)) return @intFromEnum(a.scope) < @intFromEnum(b.scope);
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
        if (!std.mem.eql(u8, parts[index], "probs") and !std.mem.eql(u8, parts[index], "combo_probs")) {
            lock.combo_indices = try parseComboList(allocator, parts[index]);
            index += 1;
        }
    } else return error.InvalidLockText;

    if (index < parts.len) {
        if (std.mem.eql(u8, parts[index], "combo_probs")) {
            index += 1;
            if (lock.combo_indices.len == 0) return error.InvalidLockText;
            // Groups separated by `;` tokens: combo_probs 1 0 ; 0 1
            var groups = std.ArrayList([]f64).init(allocator);
            defer {
                for (groups.items) |g| allocator.free(g);
                groups.deinit();
            }
            var cur = std.ArrayList(f64).init(allocator);
            defer cur.deinit();
            while (index < parts.len) : (index += 1) {
                if (std.mem.eql(u8, parts[index], ";")) {
                    if (cur.items.len == 0) return error.InvalidLockText;
                    try groups.append(try allocator.dupe(f64, cur.items));
                    cur.clearRetainingCapacity();
                    continue;
                }
                try cur.append(try parseProb(parts[index]));
            }
            if (cur.items.len == 0) return error.InvalidLockText;
            try groups.append(try allocator.dupe(f64, cur.items));
            if (groups.items.len != lock.combo_indices.len) return error.InvalidLockText;
            const n_actions: i32 = @intCast(groups.items[0].len);
            for (groups.items) |g| {
                if (g.len != @as(usize, @intCast(n_actions))) return error.InvalidLockText;
            }
            lock.combo_actions = try makeComboActionRows(allocator, lock.combo_indices, groups.items, n_actions);
            // Per-combo encoding is the mask; kind stays selected unless caller said full
            // before combos (full + combo_probs is not a text form — combos path only).
        } else if (std.mem.eql(u8, parts[index], "probs")) {
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
        } else return error.InvalidLockText;
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
