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
            else => try list.append(c),
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

fn appendActionEvMatrix(
    list: *std.ArrayList(u8),
    page: *const action_ev.ActionValues,
    n_actions: usize,
    n_hands: usize,
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
        try w.writeAll("[");
        var action: usize = 0;
        while (action < n_actions) : (action += 1) {
            if (action > 0) try w.writeAll(",");
            const idx = hand * n_actions + action;
            const value: f64 = if (idx < page.action_ev.len) page.action_ev[idx] else 0;
            try w.print("{d:.6}", .{value});
        }
        try w.writeAll("]");
    }
    try w.writeAll("]");
}

fn appendMixedEv(
    list: *std.ArrayList(u8),
    page: *const action_ev.ActionValues,
    n_hands: usize,
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
        try w.print("{d:.6}", .{page.mixed_ev[hand]});
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

    try w.writeAll("}");
    return try list.toOwnedSlice();
}

/// Study `values` reply body. Field order is contract-sensitive — do not reorder keys.
pub fn formatValuesBody(
    allocator: std.mem.Allocator,
    page: *const action_ev.ActionValues,
    located: node_id.ParsedNodeId,
    solution_id: u64,
    elapsed_ms: i128,
    live_under_train: bool,
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
    try w.writeAll(",\"units\":\"chips\",\"utility_basis\":\"root_centered\"");
    try w.print(",\"local_offset\":{d:.6},\"reach_defined\":{}", .{ page.local_offset, page.reach_defined });
    try w.print(",\"node_ev_defined\":{}", .{page.node_ev_defined});
    if (page.node_ev_defined) {
        try w.print(",\"node_ev\":{d:.6}", .{page.node_ev});
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

    try appendActionEvMatrix(&list, page, n_actions, n_hands);
    try appendMixedEv(&list, page, n_hands);

    try w.writeAll("}");
    return try list.toOwnedSlice();
}
