//! Study-shaped Compare JSON for the host IPC `compare` op (C++ `/api/compare`).
const std = @import("std");
const poker_engine = @import("poker_engine");

const inspect = poker_engine.analysis.inspect;
const node_lock = poker_engine.solve.node_lock;

pub const PackError = error{OutOfMemory};

fn appendF64(list: *std.ArrayList(u8), value: f64) PackError!void {
    var buf: [64]u8 = undefined;
    const rendered = std.fmt.bufPrint(&buf, "{d:.6}", .{value}) catch return error.OutOfMemory;
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

pub const PackArgs = struct {
    baseline_id: u64,
    scenario_id: u64,
    node_id: []const u8,
    baseline_value: f64,
    scenario_value: f64,
    baseline_nash_gap: f64,
    scenario_nash_gap: f64,
    baseline_page: *const inspect.NodePage,
    scenario_page: *const inspect.NodePage,
    /// Optional LockSet for scenario locked-hand marks (null = none locked).
    locks: ?*const node_lock.LockSet = null,
    turn: i32 = -1,
    river: i32 = -1,
};

fn handIsLocked(
    locks: ?*const node_lock.LockSet,
    node_index: u32,
    turn: i32,
    river: i32,
    hand: usize,
) bool {
    const set = locks orelse return false;
    const lock = set.findForRunout(@intCast(node_index), turn, river) orelse return false;
    if (lock.actions.unlocked()) return false;
    if (lock.kind == .full_node) return true;
    return node_lock.comboIsSelected(lock.*, hand);
}

/// Build Study ComparePayload-compatible body JSON (caller frees).
pub fn packCompareBody(allocator: std.mem.Allocator, args: PackArgs) PackError![]u8 {
    var list = std.ArrayList(u8).init(allocator);
    errdefer list.deinit();

    const base = args.baseline_page;
    const scen = args.scenario_page;
    const n_actions: usize = @intCast(base.n_actions);
    const hand_count = @min(@as(usize, @intCast(@max(base.n_hands, 0))), @as(usize, @intCast(@max(scen.n_hands, 0))));

    try list.appendSlice("{\"baseline_id\":");
    var id_buf: [32]u8 = undefined;
    {
        const text = std.fmt.bufPrint(&id_buf, "s{d}", .{args.baseline_id}) catch return error.OutOfMemory;
        try appendJsonString(&list, text);
    }
    try list.appendSlice(",\"scenario_id\":");
    {
        const text = std.fmt.bufPrint(&id_buf, "s{d}", .{args.scenario_id}) catch return error.OutOfMemory;
        try appendJsonString(&list, text);
    }
    try list.appendSlice(",\"node_id\":");
    try appendJsonString(&list, args.node_id);
    try list.appendSlice(",\"baseline_value\":");
    try appendF64(&list, args.baseline_value);
    try list.appendSlice(",\"scenario_value\":");
    try appendF64(&list, args.scenario_value);
    try list.appendSlice(",\"value_delta\":");
    try appendF64(&list, args.scenario_value - args.baseline_value);
    try list.appendSlice(",\"baseline_nash_gap\":");
    try appendF64(&list, args.baseline_nash_gap);
    try list.appendSlice(",\"scenario_nash_gap\":");
    try appendF64(&list, args.scenario_nash_gap);
    try list.appendSlice(",\"actions\":[");
    for (base.actions, 0..) |label, i| {
        if (i != 0) try list.append(',');
        try appendJsonString(&list, label);
    }
    try list.appendSlice("],\"hands\":[");

    var hand: usize = 0;
    while (hand < hand_count) : (hand += 1) {
        if (hand != 0) try list.append(',');
        const combo = if (hand < scen.combos.len) scen.combos[hand] else if (hand < base.combos.len) base.combos[hand] else "??";
        try list.appendSlice("{\"combo\":");
        try appendJsonString(&list, combo);
        try list.appendSlice(",\"locked\":");
        try list.appendSlice(if (handIsLocked(args.locks, base.node_index, args.turn, args.river, hand)) "true" else "false");
        try list.appendSlice(",\"baseline\":[");
        var a: usize = 0;
        while (a < n_actions) : (a += 1) {
            if (a != 0) try list.append(',');
            const idx = hand * n_actions + a;
            const p: f64 = if (idx < base.strategy.len) base.strategy[idx] else 0;
            try appendF64(&list, p);
        }
        try list.appendSlice("],\"scenario\":[");
        a = 0;
        while (a < n_actions) : (a += 1) {
            if (a != 0) try list.append(',');
            const idx = hand * n_actions + a;
            const p: f64 = if (idx < scen.strategy.len) scen.strategy[idx] else 0;
            try appendF64(&list, p);
        }
        try list.appendSlice("],\"delta\":[");
        a = 0;
        while (a < n_actions) : (a += 1) {
            if (a != 0) try list.append(',');
            const idx = hand * n_actions + a;
            const bp: f64 = if (idx < base.strategy.len) base.strategy[idx] else 0;
            const sp: f64 = if (idx < scen.strategy.len) scen.strategy[idx] else 0;
            try appendF64(&list, sp - bp);
        }
        try list.appendSlice("]}");
    }
    try list.appendSlice("]}");
    return list.toOwnedSlice() catch return error.OutOfMemory;
}
