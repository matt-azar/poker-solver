//! Study-shaped locks JSON for host IPC CRUD (D1: IPC packaging outside engine).
//! Mirrors explorer `json_locks` / EngineClient `LocksPayload`.
const std = @import("std");
const poker_engine = @import("poker_engine");

const node_lock = poker_engine.solve.node_lock;

pub const PackError = error{ OutOfMemory, InvalidLockText };

fn appendF64(list: *std.ArrayList(u8), value: f64) PackError!void {
    var buf: [64]u8 = undefined;
    const rendered = std.fmt.bufPrint(&buf, "{d}", .{value}) catch return error.OutOfMemory;
    list.appendSlice(rendered) catch return error.OutOfMemory;
}

fn appendJsonString(list: *std.ArrayList(u8), value: []const u8) PackError!void {
    list.append('"') catch return error.OutOfMemory;
    for (value) |c| {
        switch (c) {
            '"' => list.appendSlice("\\\"") catch return error.OutOfMemory,
            '\\' => list.appendSlice("\\\\") catch return error.OutOfMemory,
            '\n' => list.appendSlice("\\n") catch return error.OutOfMemory,
            '\r' => list.appendSlice("\\r") catch return error.OutOfMemory,
            '\t' => list.appendSlice("\\t") catch return error.OutOfMemory,
            else => list.append(c) catch return error.OutOfMemory,
        }
    }
    list.append('"') catch return error.OutOfMemory;
}

/// Build Study `/locks`-compatible body JSON (caller frees).
pub fn packStudyLocksBody(allocator: std.mem.Allocator, locks: *const node_lock.LockSet) PackError![]u8 {
    var keys = allocator.alloc(node_lock.LockKey, locks.entries.items.len) catch return error.OutOfMemory;
    defer allocator.free(keys);
    for (locks.entries.items, 0..) |lock, i| keys[i] = lock.key();
    std.mem.sort(node_lock.LockKey, keys, {}, struct {
        fn less(_: void, a: node_lock.LockKey, b: node_lock.LockKey) bool {
            if (a.infoset_id != b.infoset_id) return a.infoset_id < b.infoset_id;
            if (a.turn != b.turn) return a.turn < b.turn;
            return a.river < b.river;
        }
    }.less);

    var list = std.ArrayList(u8).init(allocator);
    errdefer list.deinit();
    list.appendSlice("{\"locks\":[") catch return error.OutOfMemory;

    var first = true;
    for (keys) |key| {
        const lock = locks.findExactKey(key) orelse continue;
        if (!first) list.append(',') catch return error.OutOfMemory;
        first = false;

        const node_id = poker_engine.analysis.node_id.formatNodeId(
            allocator,
            @intCast(lock.infoset_id),
            lock.turn,
            lock.river,
        ) catch return error.OutOfMemory;
        defer allocator.free(node_id);

        list.appendSlice("{\"node_id\":") catch return error.OutOfMemory;
        try appendJsonString(&list, node_id);
        list.appendSlice(",\"infoset_id\":") catch return error.OutOfMemory;
        var id_buf: [32]u8 = undefined;
        const id_text = std.fmt.bufPrint(&id_buf, "{d}", .{lock.infoset_id}) catch return error.OutOfMemory;
        list.appendSlice(id_text) catch return error.OutOfMemory;
        list.appendSlice(",\"scope\":") catch return error.OutOfMemory;
        try appendJsonString(&list, if (lock.isLine()) "line" else "node");
        list.appendSlice(",\"kind\":") catch return error.OutOfMemory;
        try appendJsonString(&list, if (lock.kind == .full_node) "full" else "selected");
        list.appendSlice(",\"hand_indices\":[") catch return error.OutOfMemory;
        for (lock.combo_indices, 0..) |hand, h| {
            if (h > 0) list.append(',') catch return error.OutOfMemory;
            var hand_buf: [32]u8 = undefined;
            const hand_text = std.fmt.bufPrint(&hand_buf, "{d}", .{hand}) catch return error.OutOfMemory;
            list.appendSlice(hand_text) catch return error.OutOfMemory;
        }
        list.appendSlice("],\"probs\":[") catch return error.OutOfMemory;
        for (lock.actions.probs, 0..) |p, a| {
            if (a > 0) list.append(',') catch return error.OutOfMemory;
            try appendF64(&list, p);
        }
        list.appendSlice("]}") catch return error.OutOfMemory;
    }

    list.appendSlice("]}") catch return error.OutOfMemory;
    return list.toOwnedSlice() catch return error.OutOfMemory;
}

/// Parse Session `locks_text` into a LockSet (empty text → empty set).
pub fn parseSessionLocks(allocator: std.mem.Allocator, text: []const u8) PackError!node_lock.LockSet {
    if (text.len == 0) return node_lock.LockSet.init(allocator);
    return node_lock.parseLockSet(allocator, text) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return error.InvalidLockText,
    };
}

test "pack empty locks" {
    var locks = node_lock.LockSet.init(std.testing.allocator);
    defer locks.deinit();
    const body = try packStudyLocksBody(std.testing.allocator, &locks);
    defer std.testing.allocator.free(body);
    try std.testing.expectEqualStrings("{\"locks\":[]}", body);
}

test "pack full node lock Study shape" {
    var locks = node_lock.LockSet.init(std.testing.allocator);
    defer locks.deinit();
    const probs = try std.testing.allocator.dupe(f64, &[_]f64{ 0.25, 0.75 });
    defer std.testing.allocator.free(probs);
    const lock = node_lock.NodeLock{
        .infoset_id = 0,
        .turn = -1,
        .river = -1,
        .scope = .node,
        .kind = .full_node,
        .actions = try node_lock.makeActionLockRow(std.testing.allocator, probs, 2),
    };
    try locks.upsert(lock);
    const body = try packStudyLocksBody(std.testing.allocator, &locks);
    defer std.testing.allocator.free(body);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"node_id\":\"p0.t-1.r-1\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"scope\":\"node\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"kind\":\"full\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"probs\":[0.25,0.75]") != null);
}
