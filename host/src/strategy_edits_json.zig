//! Study-shaped strategy-edits JSON for host IPC CRUD.
//! Mirrors explorer `json_strategy_edits` / EngineClient `StrategyEditsPayload`.
const std = @import("std");
const poker_engine = @import("poker_engine");

const strategy_edit = poker_engine.solve.strategy_edit;
const node_lock = poker_engine.solve.node_lock;

pub const PackError = error{ OutOfMemory, InvalidStrategyEditText };

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
            else => {
                if (c < 0x20) {
                    const hexdigits = "0123456789abcdef";
                    const esc = [_]u8{ '\\', 'u', '0', '0', hexdigits[c >> 4], hexdigits[c & 0xf] };
                    list.appendSlice(&esc) catch return error.OutOfMemory;
                } else {
                    list.append(c) catch return error.OutOfMemory;
                }
            },
        }
    }
    list.append('"') catch return error.OutOfMemory;
}

/// Build Study `/strategy-edits`-compatible body JSON (caller frees).
pub fn packStudyStrategyEditsBody(allocator: std.mem.Allocator, edits: *const strategy_edit.StrategyEditSet) PackError![]u8 {
    var keys = allocator.alloc(node_lock.LockKey, edits.entries.items.len) catch return error.OutOfMemory;
    defer allocator.free(keys);
    for (edits.entries.items, 0..) |edit, i| keys[i] = edit.key();
    std.mem.sort(node_lock.LockKey, keys, {}, struct {
        fn less(_: void, a: node_lock.LockKey, b: node_lock.LockKey) bool {
            if (a.infoset_id != b.infoset_id) return a.infoset_id < b.infoset_id;
            if (a.turn != b.turn) return a.turn < b.turn;
            return a.river < b.river;
        }
    }.less);

    var list = std.ArrayList(u8).init(allocator);
    errdefer list.deinit();
    list.appendSlice("{\"edits\":[") catch return error.OutOfMemory;

    var first = true;
    for (keys) |key| {
        const edit = edits.findExactKey(key) orelse continue;
        if (!first) list.append(',') catch return error.OutOfMemory;
        first = false;

        const node_id = poker_engine.analysis.node_id.formatNodeId(
            allocator,
            @intCast(edit.infoset_id),
            edit.turn,
            edit.river,
        ) catch return error.OutOfMemory;
        defer allocator.free(node_id);

        list.appendSlice("{\"node_id\":") catch return error.OutOfMemory;
        try appendJsonString(&list, node_id);
        list.appendSlice(",\"infoset_id\":") catch return error.OutOfMemory;
        var id_buf: [32]u8 = undefined;
        const id_text = std.fmt.bufPrint(&id_buf, "{d}", .{edit.infoset_id}) catch return error.OutOfMemory;
        list.appendSlice(id_text) catch return error.OutOfMemory;
        list.appendSlice(",\"kind\":") catch return error.OutOfMemory;
        try appendJsonString(&list, if (edit.kind == .full_node) "full" else "selected");
        list.appendSlice(",\"hand_indices\":[") catch return error.OutOfMemory;
        for (edit.hand_indices, 0..) |hand, h| {
            if (h > 0) list.append(',') catch return error.OutOfMemory;
            var hand_buf: [32]u8 = undefined;
            const hand_text = std.fmt.bufPrint(&hand_buf, "{d}", .{hand}) catch return error.OutOfMemory;
            list.appendSlice(hand_text) catch return error.OutOfMemory;
        }
        list.appendSlice("],\"probs\":[") catch return error.OutOfMemory;
        for (edit.probs, 0..) |p, a| {
            if (a > 0) list.append(',') catch return error.OutOfMemory;
            try appendF64(&list, p);
        }
        list.appendSlice("]}") catch return error.OutOfMemory;
    }

    // Session overlays are persisted in `.psol` v4; Study still expects this flag.
    list.appendSlice("],\"persisted\":false}") catch return error.OutOfMemory;
    return list.toOwnedSlice() catch return error.OutOfMemory;
}

pub fn parseSessionStrategyEdits(allocator: std.mem.Allocator, text: []const u8) PackError!strategy_edit.StrategyEditSet {
    if (text.len == 0) return strategy_edit.StrategyEditSet.init(allocator);
    return strategy_edit.parseStrategyEditSet(allocator, text) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return error.InvalidStrategyEditText,
    };
}

test "pack empty strategy edits" {
    var edits = strategy_edit.StrategyEditSet.init(std.testing.allocator);
    defer edits.deinit();
    const body = try packStudyStrategyEditsBody(std.testing.allocator, &edits);
    defer std.testing.allocator.free(body);
    try std.testing.expectEqualStrings("{\"edits\":[],\"persisted\":false}", body);
}

test "pack full-node strategy edit Study shape" {
    var edits = strategy_edit.StrategyEditSet.init(std.testing.allocator);
    defer edits.deinit();
    try edits.upsert(.{
        .infoset_id = 0,
        .turn = -1,
        .river = -1,
        .kind = .full_node,
        .probs = try std.testing.allocator.dupe(f64, &[_]f64{ 0.25, 0.75 }),
    });
    const body = try packStudyStrategyEditsBody(std.testing.allocator, &edits);
    defer std.testing.allocator.free(body);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"node_id\":\"p0.t-1.r-1\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"kind\":\"full\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"probs\":[0.25,0.75]") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"persisted\":false") != null);
}
