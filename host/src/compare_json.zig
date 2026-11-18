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

/// True when the scenario lock set constrains `hand` at this board/runout.
/// Uses `comboIsLocked` so empty shared `actions` with valid per-combo rows
/// still count as locked (whole-node freeze / line expansion).
fn handIsLocked(
    locks: ?*const node_lock.LockSet,
    node_index: u32,
    turn: i32,
    river: i32,
    hand: usize,
) bool {
    const set = locks orelse return false;
    const lock = set.findForRunout(@intCast(node_index), turn, river) orelse return false;
    return node_lock.comboIsLocked(lock.*, hand);
}

fn handWeight(page: *const inspect.NodePage, hand: usize) f64 {
    if (hand < page.marginal.len) {
        const w = page.marginal[hand];
        if (std.math.isFinite(w) and w > 0) return @floatCast(w);
    }
    if (hand < page.reach.len) {
        const w = page.reach[hand];
        if (std.math.isFinite(w) and w > 0) return @floatCast(w);
    }
    return 1.0;
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
    try list.appendSlice(",\"units\":\"chips\"");
    try list.appendSlice(",\"utility_basis\":\"root_oop\"");
    try list.appendSlice(",\"player\":");
    {
        const text = std.fmt.bufPrint(&id_buf, "{d}", .{scen.player}) catch return error.OutOfMemory;
        try list.appendSlice(text);
    }
    try list.appendSlice(",\"pot\":");
    try appendF64(&list, scen.pot);
    try list.appendSlice(",\"board\":[");
    for (scen.board, 0..) |card, i| {
        if (i != 0) try list.append(',');
        try appendJsonString(&list, card);
    }
    try list.appendSlice("],\"baseline_value\":");
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

    // Weighted action aggregates — each strategy uses its own node weights.
    var base_mass: f64 = 0;
    var scen_mass: f64 = 0;
    var base_totals = try allocator.alloc(f64, n_actions);
    defer allocator.free(base_totals);
    var scen_totals = try allocator.alloc(f64, n_actions);
    defer allocator.free(scen_totals);
    @memset(base_totals, 0);
    @memset(scen_totals, 0);

    var hand: usize = 0;
    while (hand < hand_count) : (hand += 1) {
        if (hand != 0) try list.append(',');
        const combo = if (hand < scen.combos.len) scen.combos[hand] else if (hand < base.combos.len) base.combos[hand] else "??";
        const locked = handIsLocked(args.locks, base.node_index, args.turn, args.river, hand);
        const bw = handWeight(base, hand);
        const sw = handWeight(scen, hand);
        try list.appendSlice("{\"combo\":");
        try appendJsonString(&list, combo);
        try list.appendSlice(",\"locked\":");
        try list.appendSlice(if (locked) "true" else "false");
        try list.appendSlice(",\"baseline_weight\":");
        try appendF64(&list, bw);
        try list.appendSlice(",\"scenario_weight\":");
        try appendF64(&list, sw);
        try list.appendSlice(",\"baseline\":[");
        var a: usize = 0;
        while (a < n_actions) : (a += 1) {
            if (a != 0) try list.append(',');
            const idx = hand * n_actions + a;
            const p: f64 = if (idx < base.strategy.len) @floatCast(base.strategy[idx]) else 0;
            try appendF64(&list, p);
            if (bw > 0) {
                base_totals[a] += bw * p;
            }
        }
        if (bw > 0) base_mass += bw;
        try list.appendSlice("],\"scenario\":[");
        a = 0;
        while (a < n_actions) : (a += 1) {
            if (a != 0) try list.append(',');
            const idx = hand * n_actions + a;
            const p: f64 = if (idx < scen.strategy.len) @floatCast(scen.strategy[idx]) else 0;
            try appendF64(&list, p);
            if (sw > 0) {
                scen_totals[a] += sw * p;
            }
        }
        if (sw > 0) scen_mass += sw;
        try list.appendSlice("],\"delta\":[");
        a = 0;
        while (a < n_actions) : (a += 1) {
            if (a != 0) try list.append(',');
            const idx = hand * n_actions + a;
            const bp: f64 = if (idx < base.strategy.len) @floatCast(base.strategy[idx]) else 0;
            const sp: f64 = if (idx < scen.strategy.len) @floatCast(scen.strategy[idx]) else 0;
            try appendF64(&list, sp - bp);
        }
        try list.appendSlice("]}");
    }
    try list.appendSlice("],\"action_summary\":[");
    {
        var action_i: usize = 0;
        while (action_i < n_actions) : (action_i += 1) {
            if (action_i != 0) try list.append(',');
            const label = if (action_i < base.actions.len) base.actions[action_i] else "";
            const bp: f64 = if (base_mass > 0) base_totals[action_i] / base_mass else 0;
            const sp: f64 = if (scen_mass > 0) scen_totals[action_i] / scen_mass else 0;
            try list.appendSlice("{\"action\":");
            try appendJsonString(&list, label);
            try list.appendSlice(",\"baseline\":");
            try appendF64(&list, bp);
            try list.appendSlice(",\"scenario\":");
            try appendF64(&list, sp);
            try list.appendSlice(",\"delta\":");
            try appendF64(&list, sp - bp);
            try list.append('}');
        }
    }
    try list.appendSlice("]}");
    return list.toOwnedSlice() catch return error.OutOfMemory;
}

test "handIsLocked counts per-combo rows with empty shared actions" {
    const allocator = std.testing.allocator;
    var locks = node_lock.LockSet.init(allocator);
    defer locks.deinit();

    const indices = try allocator.dupe(usize, &[_]usize{ 0, 1 });
    errdefer allocator.free(indices);
    const rows = [_][]const f64{ &.{ 1.0, 0.0 }, &.{ 0.0, 1.0 } };
    const combo_actions = try node_lock.makeComboActionRows(allocator, indices, &rows, 2);
    // Empty shared `actions` — the whole-node freeze path stores only combo_actions.
    try locks.upsert(.{
        .infoset_id = 0,
        .turn = -1,
        .river = -1,
        .scope = .node,
        .kind = .selected_combos,
        .combo_indices = indices,
        .combo_actions = combo_actions,
    });

    try std.testing.expect(handIsLocked(&locks, 0, -1, -1, 0));
    try std.testing.expect(handIsLocked(&locks, 0, -1, -1, 1));
    try std.testing.expect(!handIsLocked(&locks, 0, -1, -1, 2));
    try std.testing.expect(!handIsLocked(null, 0, -1, -1, 0));
}

test "packCompareBody marks per-combo locks and emits action_summary" {
    const allocator = std.testing.allocator;
    var locks = node_lock.LockSet.init(allocator);
    defer locks.deinit();

    const indices = try allocator.dupe(usize, &[_]usize{0});
    errdefer allocator.free(indices);
    const rows = [_][]const f64{&.{ 1.0, 0.0 }};
    const combo_actions = try node_lock.makeComboActionRows(allocator, indices, &rows, 2);
    try locks.upsert(.{
        .infoset_id = 0,
        .turn = -1,
        .river = -1,
        .scope = .node,
        .kind = .selected_combos,
        .combo_indices = indices,
        .combo_actions = combo_actions,
    });

    const check = try allocator.dupe(u8, "Check");
    defer allocator.free(check);
    const bet = try allocator.dupe(u8, "Bet 50");
    defer allocator.free(bet);
    const actions = try allocator.alloc([]const u8, 2);
    defer allocator.free(actions);
    actions[0] = check;
    actions[1] = bet;

    const combo0 = try allocator.dupe(u8, "AcAd");
    defer allocator.free(combo0);
    const combos = try allocator.alloc([]const u8, 1);
    defer allocator.free(combos);
    combos[0] = combo0;

    const strategy = try allocator.alloc(f32, 2);
    defer allocator.free(strategy);
    strategy[0] = 0.4;
    strategy[1] = 0.6;

    const marginal = try allocator.alloc(f32, 1);
    defer allocator.free(marginal);
    marginal[0] = 1.0;

    const card0 = try allocator.dupe(u8, "Ah");
    defer allocator.free(card0);
    const card1 = try allocator.dupe(u8, "Kd");
    defer allocator.free(card1);
    const card2 = try allocator.dupe(u8, "7c");
    defer allocator.free(card2);
    const board = try allocator.alloc([]const u8, 3);
    defer allocator.free(board);
    board[0] = card0;
    board[1] = card1;
    board[2] = card2;

    var page = inspect.NodePage{
        .allocator = allocator,
        .node_index = 0,
        .player = 0,
        .actions = actions,
        .combos = combos,
        .strategy = strategy,
        .n_actions = 2,
        .n_hands = 1,
        .marginal = marginal,
        .pot = 100,
        .board = board,
    };

    const body = try packCompareBody(allocator, .{
        .baseline_id = 1,
        .scenario_id = 2,
        .node_id = "p0.t-1.r-1",
        .baseline_value = 1.5,
        .scenario_value = 2.0,
        .baseline_nash_gap = 0.1,
        .scenario_nash_gap = 0.05,
        .baseline_page = &page,
        .scenario_page = &page,
        .locks = &locks,
        .turn = -1,
        .river = -1,
    });
    defer allocator.free(body);

    try std.testing.expect(std.mem.indexOf(u8, body, "\"locked\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"action_summary\":[") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"utility_basis\":\"root_oop\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"board\":[\"Ah\",\"Kd\",\"7c\"]") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"baseline_weight\":1.000000") != null);
}
