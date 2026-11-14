//! Study-shaped `node` / `values` JSON bodies for host IPC (D1: IPC outside engine).
//! Field order is a Study contract — keep parent writers sequential; helpers append fragments only.
const std = @import("std");
const poker_engine = @import("poker_engine");

const inspect = poker_engine.analysis.inspect;
const action_ev = poker_engine.analysis.action_ev;
const node_id = poker_engine.analysis.node_id;

fn appendJsonString(list: *std.ArrayList(u8), value: []const u8) !void {
    try list.append('"');
    for (value) |c| {
        switch (c) {
            '"' => try list.appendSlice("\\\""),
            '\\' => try list.appendSlice("\\\\"),
            '\n' => try list.appendSlice("\\n"),
            '\r' => try list.appendSlice("\\r"),
            '\t' => try list.appendSlice("\\t"),
            else => {
                if (c < 0x20) {
                    const hexdigits = "0123456789abcdef";
                    const esc = [_]u8{ '\\', 'u', '0', '0', hexdigits[c >> 4], hexdigits[c & 0xf] };
                    try list.appendSlice(&esc);
                } else {
                    try list.append(c);
                }
            },
        }
    }
    try list.append('"');
}

fn appendFloatArray(list: *std.ArrayList(u8), values: []const f32) !void {
    const w = list.writer();
    try w.writeAll("[");
    for (values, 0..) |value, i| {
        if (i > 0) try w.writeAll(",");
        try w.print("{d:.6}", .{@as(f64, @floatCast(value))});
    }
    try w.writeAll("]");
}

fn appendStringArray(list: *std.ArrayList(u8), values: []const []const u8) !void {
    const w = list.writer();
    try w.writeAll("[");
    for (values, 0..) |value, i| {
        if (i > 0) try w.writeAll(",");
        try appendJsonString(list, value);
    }
    try w.writeAll("]");
}

fn appendOpponentBlock(list: *std.ArrayList(u8), page: *const inspect.NodePage) !void {
    if (page.opponent_player < 0) return;
    const w = list.writer();
    try w.print(",\"opponent_player\":{d}", .{page.opponent_player});
    try w.writeAll(",\"opponent_combos\":");
    try appendStringArray(list, page.opponent_combos);
    try w.writeAll(",\"opponent_reach\":");
    try appendFloatArray(list, page.opponent_reach);
    try w.writeAll(",\"opponent_marginal\":");
    try appendFloatArray(list, page.opponent_marginal);
}

fn appendCards(list: *std.ArrayList(u8), cards: []const inspect.ChanceCard) !void {
    const w = list.writer();
    try w.writeAll(",\"cards\":[");
    for (cards, 0..) |row, i| {
        if (i > 0) try w.writeAll(",");
        try w.writeAll("{\"card\":");
        try appendJsonString(list, row.card);
        try w.writeAll(",\"child_id\":");
        try appendJsonString(list, row.child_id);
        try w.print(",\"weight\":{d:.6}}}", .{row.weight});
    }
    try w.writeAll("]");
}

fn appendStrategyMatrix(
    list: *std.ArrayList(u8),
    page: *const inspect.NodePage,
    n_actions: usize,
    n_hands: usize,
) !void {
    const w = list.writer();
    try w.writeAll(",\"strategy\":");
    if (page.kind != .decision or n_actions == 0 or page.strategy.len == 0) {
        try w.writeAll("null");
        return;
    }
    try w.writeAll("[");
    var hand: usize = 0;
    while (hand < n_hands) : (hand += 1) {
        if (hand > 0) try w.writeAll(",");
        try w.writeAll("[");
        var action: usize = 0;
        while (action < n_actions) : (action += 1) {
            if (action > 0) try w.writeAll(",");
            const idx = hand * n_actions + action;
            const value: f64 = if (idx < page.strategy.len) page.strategy[idx] else 0;
            try w.print("{d:.6}", .{value});
        }
        try w.writeAll("]");
    }
    try w.writeAll("]");
}

fn foldActionIndex(actions: []const []const u8) isize {
    for (actions, 0..) |label, i| {
        if (std.mem.eql(u8, label, "Fold")) return @intCast(i);
    }
    return -1;
}

/// Baseline subtracted from root-centered chips for local decision EV.
/// Prefer the Fold column when present (Fold → 0 even with path incentives);
/// otherwise use -local_offset so local = root + local_offset.
fn localEvBaseline(
    page: *const action_ev.ActionValues,
    hand: usize,
    n_actions: usize,
) f64 {
    const offset_baseline = -page.local_offset;
    const fold_idx = foldActionIndex(page.actions);
    if (fold_idx < 0) return offset_baseline;
    if (hand >= page.ev_defined.len or page.ev_defined[hand] == 0) return offset_baseline;
    const idx = hand * n_actions + @as(usize, @intCast(fold_idx));
    if (idx >= page.action_ev.len) return offset_baseline;
    return page.action_ev[idx];
}

fn appendActionEvMatrix(
    list: *std.ArrayList(u8),
    page: *const action_ev.ActionValues,
    n_actions: usize,
    n_hands: usize,
    /// When true, emit Fold≈0 / sunk-cost local chips; otherwise root-centered.
    local_basis: bool,
) !void {
    const w = list.writer();
    try w.writeAll(",\"action_ev\":[");
    var hand: usize = 0;
    while (hand < n_hands) : (hand += 1) {
        if (hand > 0) try w.writeAll(",");
        if (hand >= page.ev_defined.len or page.ev_defined[hand] == 0) {
            try w.writeAll("null");
            continue;
        }
        const baseline: f64 = if (local_basis) localEvBaseline(page, hand, n_actions) else 0;
        try w.writeAll("[");
        var action: usize = 0;
        while (action < n_actions) : (action += 1) {
            if (action > 0) try w.writeAll(",");
            const idx = hand * n_actions + action;
            const root: f64 = if (idx < page.action_ev.len) page.action_ev[idx] else 0;
            try w.print("{d:.6}", .{root - baseline});
        }
        try w.writeAll("]");
    }
    try w.writeAll("]");
}

fn appendMixedEv(
    list: *std.ArrayList(u8),
    page: *const action_ev.ActionValues,
    n_hands: usize,
    n_actions: usize,
    local_basis: bool,
) !void {
    const w = list.writer();
    try w.writeAll(",\"value\":[");
    var hand: usize = 0;
    while (hand < n_hands) : (hand += 1) {
        if (hand > 0) try w.writeAll(",");
        if (hand >= page.ev_defined.len or page.ev_defined[hand] == 0 or hand >= page.mixed_ev.len) {
            try w.writeAll("null");
            continue;
        }
        const baseline: f64 = if (local_basis) localEvBaseline(page, hand, n_actions) else 0;
        try w.print("{d:.6}", .{page.mixed_ev[hand] - baseline});
    }
    try w.writeAll("]");
}

/// Study matrix rank order (A…2) — must match desktop `RANKS`.
const study_ranks = "AKQJT98765432";

fn rankIndex(rank: u8) isize {
    return if (std.mem.indexOfScalar(u8, study_ranks, rank)) |i| @intCast(i) else -1;
}

const CellKey = struct {
    row: u8,
    col: u8,
    text: [3]u8 = undefined,
    text_len: u8 = 0,

    fn label(self: *const CellKey) []const u8 {
        return self.text[0..self.text_len];
    }
};

/// Map a 4-char combo (`AhKd`) onto the 13×13 Study cell (same rules as desktop groupHands).
fn comboCellKey(combo: []const u8) ?CellKey {
    if (combo.len < 4) return null;
    const high = rankIndex(combo[0]);
    const low = rankIndex(combo[2]);
    if (high < 0 or low < 0) return null;
    const suited = combo[1] == combo[3];
    var row: i32 = @intCast(high);
    var column: i32 = @intCast(low);
    if (combo[0] != combo[2] and suited) {
        row = @intCast(@min(high, low));
        column = @intCast(@max(high, low));
    } else if (combo[0] != combo[2]) {
        row = @intCast(@max(high, low));
        column = @intCast(@min(high, low));
    }
    var key = CellKey{ .row = @intCast(row), .col = @intCast(column) };
    if (combo[0] == combo[2]) {
        key.text[0] = study_ranks[@intCast(row)];
        key.text[1] = study_ranks[@intCast(column)];
        key.text_len = 2;
    } else if (row < column) {
        key.text[0] = study_ranks[@intCast(row)];
        key.text[1] = study_ranks[@intCast(column)];
        key.text[2] = 's';
        key.text_len = 3;
    } else {
        key.text[0] = study_ranks[@intCast(column)];
        key.text[1] = study_ranks[@intCast(row)];
        key.text[2] = 'o';
        key.text_len = 3;
    }
    return key;
}

fn cellIndex(row: u8, col: u8) usize {
    return @as(usize, row) * 13 + @as(usize, col);
}

/// Posterior-weighted 169-cell EV aggregates (same math as desktop `groupEv`).
fn appendCellEvAggregates(
    allocator: std.mem.Allocator,
    list: *std.ArrayList(u8),
    page: *const action_ev.ActionValues,
    n_actions: usize,
    n_hands: usize,
    marginal: []const f32,
    local_basis: bool,
    field_name: []const u8,
) !void {
    if (marginal.len != n_hands or n_actions == 0) return;

    const n_cells: usize = 13 * 13;
    var mass = try allocator.alloc(f64, n_cells);
    defer allocator.free(mass);
    @memset(mass, 0);
    var mixed = try allocator.alloc(f64, n_cells);
    defer allocator.free(mixed);
    @memset(mixed, 0);
    var action_sum = try allocator.alloc(f64, n_cells * n_actions);
    defer allocator.free(action_sum);
    @memset(action_sum, 0);
    var labels = try allocator.alloc(CellKey, n_cells);
    defer allocator.free(labels);
    var labeled = try allocator.alloc(u8, n_cells);
    defer allocator.free(labeled);
    @memset(labeled, 0);
    var defined_ok = try allocator.alloc(u8, n_cells);
    defer allocator.free(defined_ok);
    @memset(defined_ok, 1);

    var hand: usize = 0;
    while (hand < n_hands) : (hand += 1) {
        const m: f64 = @floatCast(marginal[hand]);
        if (!(m > 0)) continue;
        const key = comboCellKey(page.combos[hand]) orelse continue;
        const ci = cellIndex(key.row, key.col);
        if (labeled[ci] == 0) {
            labels[ci] = key;
            labeled[ci] = 1;
        }
        if (hand >= page.ev_defined.len or page.ev_defined[hand] == 0) {
            // Match desktop groupEv: any undefined hand in a positive-mass cell → null.
            defined_ok[ci] = 0;
            continue;
        }
        const baseline: f64 = if (local_basis) localEvBaseline(page, hand, n_actions) else 0;
        mass[ci] += m;
        mixed[ci] += m * (page.mixed_ev[hand] - baseline);
        var a: usize = 0;
        while (a < n_actions) : (a += 1) {
            const idx = hand * n_actions + a;
            const root: f64 = if (idx < page.action_ev.len) page.action_ev[idx] else 0;
            action_sum[ci * n_actions + a] += m * (root - baseline);
        }
    }

    const w = list.writer();
    try w.writeAll(",\"");
    try w.writeAll(field_name);
    try w.writeAll("\":[");
    var first = true;
    var ci: usize = 0;
    while (ci < n_cells) : (ci += 1) {
        if (!(mass[ci] > 0) or defined_ok[ci] == 0 or labeled[ci] == 0) continue;
        if (!first) try w.writeAll(",");
        first = false;
        const key = labels[ci];
        try w.print("{{\"row\":{d},\"col\":{d},\"text\":", .{ key.row, key.col });
        try appendJsonString(list, key.label());
        try w.print(",\"mixed\":{d:.6},\"action\":[", .{mixed[ci] / mass[ci]});
        var a: usize = 0;
        while (a < n_actions) : (a += 1) {
            if (a > 0) try w.writeAll(",");
            try w.print("{d:.6}", .{action_sum[ci * n_actions + a] / mass[ci]});
        }
        try w.writeAll("]}");
    }
    try w.writeAll("]");
}

fn appendRootCenteredDual(
    allocator: std.mem.Allocator,
    list: *std.ArrayList(u8),
    page: *const action_ev.ActionValues,
    n_actions: usize,
    n_hands: usize,
    marginal: ?[]const f32,
) !void {
    // Dual columns so Settings Global can flip without refetch / reverse-shift.
    const w = list.writer();
    try w.writeAll(",\"root_centered\":{");
    if (page.node_ev_defined) {
        try w.print("\"node_ev\":{d:.6}", .{page.node_ev});
    } else {
        try w.writeAll("\"node_ev\":null");
    }
    try appendActionEvMatrix(list, page, n_actions, n_hands, false);
    try appendMixedEv(list, page, n_hands, n_actions, false);
    if (marginal) |m| {
        try appendCellEvAggregates(allocator, list, page, n_actions, n_hands, m, false, "cell_ev");
    }
    try w.writeAll("}");
}

fn appendActionFrequencies(
    list: *std.ArrayList(u8),
    page: *const inspect.NodePage,
    n_actions: usize,
    n_hands: usize,
) !void {
    if (page.kind != .decision or n_actions == 0 or !page.reach_defined) return;
    if (page.marginal.len != n_hands) return;
    if (page.strategy.len == 0 and n_actions > 1) return;

    var totals = [_]f64{0} ** 16;
    if (n_actions > totals.len) return;
    var mass: f64 = 0;
    var hand: usize = 0;
    while (hand < n_hands) : (hand += 1) {
        const m: f64 = @floatCast(page.marginal[hand]);
        if (!(m > 0)) continue;
        mass += m;
        if (n_actions == 1) {
            totals[0] += m;
            continue;
        }
        var a: usize = 0;
        while (a < n_actions) : (a += 1) {
            const idx = hand * n_actions + a;
            const p: f64 = if (idx < page.strategy.len) @floatCast(page.strategy[idx]) else 0;
            totals[a] += m * p;
        }
    }
    const w = list.writer();
    try w.writeAll(",\"action_frequencies\":[");
    var a: usize = 0;
    while (a < n_actions) : (a += 1) {
        if (a > 0) try w.writeAll(",");
        const freq: f64 = if (mass > 0) totals[a] / mass else 0;
        try w.print("{d:.6}", .{freq});
    }
    try w.writeAll("]");
}

/// Study `node` reply body. Field order is contract-sensitive — do not reorder keys.
pub fn formatNodeBody(
    allocator: std.mem.Allocator,
    page: *const inspect.NodePage,
    located: node_id.ParsedNodeId,
    solution_id: u64,
) ![]u8 {
    var list = std.ArrayList(u8).init(allocator);
    errdefer list.deinit();
    const w = list.writer();

    const node_id_text = try node_id.formatNodeId(
        allocator,
        located.node_index,
        located.turn,
        located.river,
    );
    defer allocator.free(node_id_text);

    const n_actions: usize = page.actions.len;
    const n_hands: usize = page.combos.len;
    const kind_text: []const u8 = switch (page.kind) {
        .decision => "decision",
        .chance => "chance",
        .terminal => "terminal",
    };

    try w.writeAll("{\"solution_id\":\"s");
    try w.print("{d}", .{solution_id});
    try w.writeAll("\",\"node_id\":");
    try appendJsonString(&list, node_id_text);
    try w.print(",\"node_index\":{d},\"kind\":\"{s}\"", .{ page.node_index, kind_text });
    if (page.player >= 0) {
        try w.print(",\"player\":{d}", .{page.player});
    } else {
        try w.writeAll(",\"player\":null");
    }
    try w.print(",\"policy_revision\":{d}", .{page.policy_revision});
    try w.print(",\"n_actions\":{d},\"n_hands\":{d},\"reach_defined\":{}", .{
        if (page.kind == .decision) n_actions else 0,
        n_hands,
        page.reach_defined,
    });
    try w.print(",\"pot\":{d:.6},\"stack\":{d:.6},\"to_call\":{d:.6},\"joint\":{d:.6}", .{
        page.pot,
        page.stack,
        page.to_call,
        page.joint,
    });
    try w.print(",\"stacks\":[{d:.6},{d:.6}],\"contrib\":[{d:.6},{d:.6}]", .{
        page.stacks[0],
        page.stacks[1],
        page.contrib[0],
        page.contrib[1],
    });
    try w.writeAll(",\"board\":");
    try appendStringArray(&list, page.board);
    try w.writeAll(",\"parent_id\":");
    if (page.parent_id) |pid| {
        try appendJsonString(&list, pid);
    } else {
        try w.writeAll("null");
    }

    try w.writeAll(",\"actions\":");
    try appendStringArray(&list, page.actions);
    try w.writeAll(",\"children\":");
    try appendStringArray(&list, page.children);
    try w.writeAll(",\"combos\":");
    try appendStringArray(&list, page.combos);
    try w.writeAll(",\"reach\":");
    try appendFloatArray(&list, page.reach);
    try w.writeAll(",\"marginal\":");
    try appendFloatArray(&list, page.marginal);

    try appendOpponentBlock(&list, page);
    try appendCards(&list, page.cards);
    try appendStrategyMatrix(&list, page, n_actions, n_hands);
    try appendActionFrequencies(&list, page, n_actions, n_hands);

    try w.writeAll("}");
    return try list.toOwnedSlice();
}

/// Study `values` reply body. Field order is contract-sensitive — do not reorder keys.
/// `marginal` (acting-seat posterior, aligned with `page.combos`) enables 169-cell EV aggregates.
pub fn formatValuesBody(
    allocator: std.mem.Allocator,
    page: *const action_ev.ActionValues,
    located: node_id.ParsedNodeId,
    solution_id: u64,
    elapsed_ms: i128,
    live_under_train: bool,
    marginal: ?[]const f32,
) ![]u8 {
    var list = std.ArrayList(u8).init(allocator);
    errdefer list.deinit();
    const w = list.writer();

    const node_id_text = try node_id.formatNodeId(
        allocator,
        located.node_index,
        located.turn,
        located.river,
    );
    defer allocator.free(node_id_text);

    const engine_tag: []const u8 = if (located.node_index == 0 and located.turn < 0 and located.river < 0)
        "frozen_response_walk"
    else
        "deal_by_deal";

    const n_actions = page.actions.len;
    const n_hands = page.combos.len;

    try w.writeAll("{\"pending\":false,\"solution_id\":\"s");
    try w.print("{d}", .{solution_id});
    try w.writeAll("\",\"node_id\":");
    try appendJsonString(&list, node_id_text);
    try w.print(",\"node_index\":{d},\"player\":{d},\"policy_revision\":{d}", .{
        page.node_index,
        page.player,
        page.policy_revision,
    });
    // Primary action_ev / value / node_ev are local decision EV (Fold≈0).
    // Dual root_centered{} keeps Global Settings toggle refetch-free.
    try w.writeAll(",\"units\":\"chips\",\"utility_basis\":\"local\"");
    try w.print(",\"local_offset\":{d:.6},\"reach_defined\":{}", .{ page.local_offset, page.reach_defined });
    try w.print(",\"node_ev_defined\":{}", .{page.node_ev_defined});
    if (page.node_ev_defined) {
        // Match desktop withEvBasis: node_ev_local = node_ev_root + local_offset.
        try w.print(",\"node_ev\":{d:.6}", .{page.node_ev + page.local_offset});
    } else {
        try w.writeAll(",\"node_ev\":null");
    }
    try w.print(",\"n_hands\":{d},\"n_actions\":{d},\"elapsed_ms\":{d}", .{
        n_hands,
        n_actions,
        elapsed_ms,
    });
    try w.writeAll(",\"engine\":\"");
    try w.writeAll(engine_tag);
    try w.print("\",\"live_under_train\":{}", .{live_under_train});

    try w.writeAll(",\"actions\":[");
    for (page.actions, 0..) |label, i| {
        if (i > 0) try w.writeAll(",");
        try appendJsonString(&list, label);
    }
    try w.writeAll("],\"combos\":[");
    for (page.combos, 0..) |label, i| {
        if (i > 0) try w.writeAll(",");
        try appendJsonString(&list, label);
    }
    try w.writeAll("],\"ev_defined\":[");
    for (page.ev_defined, 0..) |defined, i| {
        if (i > 0) try w.writeAll(",");
        try w.writeAll(if (defined != 0) "true" else "false");
    }
    try w.writeAll("]");

    try appendActionEvMatrix(&list, page, n_actions, n_hands, true);
    try appendMixedEv(&list, page, n_hands, n_actions, true);
    if (marginal) |m| {
        try appendCellEvAggregates(allocator, &list, page, n_actions, n_hands, m, true, "cell_ev");
    }
    try appendRootCenteredDual(allocator, &list, page, n_actions, n_hands, marginal);

    try w.writeAll("}");
    return try list.toOwnedSlice();
}

/// Align inspect marginal onto values combo order (usually identical PrivateHandIndex order).
pub fn marginalForValuesCombos(
    allocator: std.mem.Allocator,
    values_combos: []const []const u8,
    inspect_combos: []const []const u8,
    inspect_marginal: []const f32,
) !?[]f32 {
    if (inspect_marginal.len != inspect_combos.len or values_combos.len == 0) return null;
    if (inspect_combos.len == values_combos.len) {
        var same = true;
        for (values_combos, 0..) |combo, i| {
            if (!std.mem.eql(u8, combo, inspect_combos[i])) {
                same = false;
                break;
            }
        }
        if (same) {
            return try allocator.dupe(f32, inspect_marginal);
        }
    }
    // Fallback: match by combo string (O(n·m); tiny vs EV walk).
    var out = try allocator.alloc(f32, values_combos.len);
    @memset(out, 0);
    for (values_combos, 0..) |combo, vi| {
        for (inspect_combos, 0..) |ic, ii| {
            if (std.mem.eql(u8, combo, ic)) {
                out[vi] = inspect_marginal[ii];
                break;
            }
        }
    }
    return out;
}

test "formatValuesBody emits local primary and root_centered dual" {
    const allocator = std.testing.allocator;
    var page = action_ev.ActionValues{
        .allocator = allocator,
        .node_index = 1,
        .player = 0,
        .policy_revision = 1,
        .local_offset = 50,
        .reach_defined = true,
        .node_ev_defined = true,
        .node_ev = -50,
    };
    defer page.deinit();

    page.actions = try allocator.alloc([]const u8, 2);
    page.actions[0] = try allocator.dupe(u8, "Fold");
    page.actions[1] = try allocator.dupe(u8, "Call");
    page.combos = try allocator.alloc([]const u8, 1);
    page.combos[0] = try allocator.dupe(u8, "AhAd");
    page.ev_defined = try allocator.alloc(u8, 1);
    page.ev_defined[0] = 1;
    page.action_ev = try allocator.alloc(f64, 2);
    page.action_ev[0] = -50;
    page.action_ev[1] = -25;
    page.mixed_ev = try allocator.alloc(f64, 1);
    page.mixed_ev[0] = -50;

    const located = node_id.ParsedNodeId{ .node_index = 1, .turn = -1, .river = -1 };
    const body = try formatValuesBody(allocator, &page, located, 1, 0, false, null);
    defer allocator.free(body);

    try std.testing.expect(std.mem.indexOf(u8, body, "\"utility_basis\":\"local\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"local_offset\":50.000000") != null);
    // Local primary: Fold → 0, Call → 25, mixed → 0, node_ev → 0.
    try std.testing.expect(std.mem.indexOf(u8, body, "\"node_ev\":0.000000") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"action_ev\":[[0.000000,25.000000]]") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"value\":[0.000000]") != null);
    // Dual root keeps original chips for Global toggle.
    try std.testing.expect(std.mem.indexOf(u8, body, "\"root_centered\":{\"node_ev\":-50.000000,\"action_ev\":[[-50.000000,-25.000000]],\"value\":[-50.000000]}") != null);
}

test "formatValuesBody flop Check/Bet uses local_offset when Fold absent" {
    // Flop roots are typically Check/Bet — local = root + local_offset (baseline = -offset).
    const allocator = std.testing.allocator;
    var page = action_ev.ActionValues{
        .allocator = allocator,
        .node_index = 0,
        .player = 0,
        .policy_revision = 1,
        .local_offset = 50,
        .reach_defined = true,
        .node_ev_defined = true,
        .node_ev = 0,
    };
    defer page.deinit();

    page.actions = try allocator.alloc([]const u8, 2);
    page.actions[0] = try allocator.dupe(u8, "Check");
    page.actions[1] = try allocator.dupe(u8, "Bet 50");
    page.combos = try allocator.alloc([]const u8, 1);
    page.combos[0] = try allocator.dupe(u8, "AsAc");
    page.ev_defined = try allocator.alloc(u8, 1);
    page.ev_defined[0] = 1;
    page.action_ev = try allocator.alloc(f64, 2);
    page.action_ev[0] = -10;
    page.action_ev[1] = 10;
    page.mixed_ev = try allocator.alloc(f64, 1);
    page.mixed_ev[0] = 0;

    const located = node_id.ParsedNodeId{ .node_index = 0, .turn = -1, .river = -1 };
    const marginal = [_]f32{1.0};
    const body = try formatValuesBody(allocator, &page, located, 1, 0, false, &marginal);
    defer allocator.free(body);

    try std.testing.expect(std.mem.indexOf(u8, body, "\"utility_basis\":\"local\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"engine\":\"frozen_response_walk\"") != null);
    // local Check=40, Bet=60, mixed=50, node_ev=50.
    try std.testing.expect(std.mem.indexOf(u8, body, "\"action_ev\":[[40.000000,60.000000]]") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"value\":[50.000000]") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"node_ev\":50.000000") != null);
    // AA cell (row0,col0) local aggregate.
    try std.testing.expect(std.mem.indexOf(u8, body, "\"cell_ev\":[{\"row\":0,\"col\":0,\"text\":\"AA\",\"mixed\":50.000000,\"action\":[40.000000,60.000000]}]") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"root_centered\":{\"node_ev\":0.000000,\"action_ev\":[[-10.000000,10.000000]],\"value\":[0.000000],\"cell_ev\":[{\"row\":0,\"col\":0,\"text\":\"AA\",\"mixed\":0.000000,\"action\":[-10.000000,10.000000]}]}") != null);
}

test "comboCellKey maps pairs suited offsuit like desktop groupHands" {
    const aa = comboCellKey("AhAd").?;
    try std.testing.expect(aa.row == 0 and aa.col == 0);
    try std.testing.expectEqualStrings("AA", aa.label());
    const aks = comboCellKey("AhKh").?;
    try std.testing.expect(aks.row == 0 and aks.col == 1);
    try std.testing.expectEqualStrings("AKs", aks.label());
    const ako = comboCellKey("AhKd").?;
    try std.testing.expect(ako.row == 1 and ako.col == 0);
    try std.testing.expectEqualStrings("AKo", ako.label());
}
