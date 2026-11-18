//! Fat Study report ops: `line_card_report` + `value_bluffs_post_call`.
//! Cuts desktop multi-getNode / equity fan-out for Compare runouts and After-call.
const std = @import("std");
const poker_engine = @import("poker_engine");

const inspect = poker_engine.analysis.inspect;
const node_id = poker_engine.analysis.node_id;
const equity = poker_engine.analysis.equity;
const compile = poker_engine.game.compile;
const training_state = poker_engine.solve.training_state;
const frozen_walk = poker_engine.solve.frozen_walk;

pub const ReportError = error{
    UnknownNode,
    InvalidReport,
    OutOfMemory,
    WorkLimit,
    InvalidEquity,
    InvalidWeight,
};

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

fn startsWith(label: []const u8, prefix: []const u8) bool {
    return label.len >= prefix.len and std.mem.eql(u8, label[0..prefix.len], prefix);
}

fn isBettingAction(label: []const u8) bool {
    const t = std.mem.trim(u8, label, " \t");
    if (t.len == 0) return false;
    if (startsWith(t, "Bet") or startsWith(t, "Raise")) return true;
    // bare All-in / all-in
    if (t.len >= 5 and (t[0] == 'A' or t[0] == 'a')) {
        var lower_buf: [16]u8 = undefined;
        const n = @min(t.len, lower_buf.len);
        var i: usize = 0;
        while (i < n) : (i += 1) lower_buf[i] = std.ascii.toLower(t[i]);
        const low = lower_buf[0..n];
        return std.mem.eql(u8, low, "all-in") or std.mem.eql(u8, low, "allin") or std.mem.eql(u8, low, "all in");
    }
    return false;
}

fn isCallAction(label: []const u8) bool {
    const t = std.mem.trim(u8, label, " \t");
    if (t.len < 4) return false;
    var i: usize = 0;
    while (i < 4) : (i += 1) {
        if (std.ascii.toLower(t[i]) != "call"[i]) return false;
    }
    return t.len == 4 or t[4] == ' ' or t[4] == '\t';
}

fn parentLocated(
    game: compile.CompiledGame,
    node_index: u32,
    turn: i32,
    river: i32,
) ?node_id.ParsedNodeId {
    if (node_index >= game.nodes.len) return null;
    const node = game.nodes[node_index];
    if (node.parent < 0) return null;
    const parent = game.nodes[@intCast(node.parent)];
    var p_turn = turn;
    var p_river = river;
    if (parent.kind == .chance) {
        if (parent.deal_which == 1) {
            p_turn = -1;
            p_river = -1;
        } else if (game.board.len == 3) {
            p_river = -1;
        } else {
            p_turn = -1;
            p_river = -1;
        }
    }
    return .{
        .node_index = @intCast(node.parent),
        .turn = p_turn,
        .river = p_river,
    };
}

fn dealStreetFromBoardLen(board_len: usize) ?[]const u8 {
    if (board_len == 3) return "turn";
    if (board_len == 4) return "river";
    return null;
}

fn varyStreetFromDecisionBoardLen(board_len: usize) ?[]const u8 {
    if (board_len >= 5) return "river";
    if (board_len >= 4) return "turn";
    return null;
}

fn rewriteRunout(report_index: u32, chance_child: node_id.ParsedNodeId) node_id.ParsedNodeId {
    return .{
        .node_index = report_index,
        .turn = chance_child.turn,
        .river = chance_child.river,
    };
}

fn actionFrequencies(
    page: *const inspect.NodePage,
    out: []f64,
) void {
    @memset(out, 0);
    const n_actions = page.actions.len;
    const n_hands = page.combos.len;
    if (n_actions == 0 or n_actions > out.len or !page.reach_defined) return;
    if (page.marginal.len != n_hands) return;
    var mass: f64 = 0;
    var hand: usize = 0;
    while (hand < n_hands) : (hand += 1) {
        const m: f64 = @floatCast(page.marginal[hand]);
        if (!(m > 0)) continue;
        mass += m;
        if (n_actions == 1) {
            out[0] += m;
            continue;
        }
        var a: usize = 0;
        while (a < n_actions) : (a += 1) {
            const idx = hand * n_actions + a;
            const p: f64 = if (idx < page.strategy.len) @floatCast(page.strategy[idx]) else 0;
            out[a] += m * p;
        }
    }
    if (!(mass > 0)) return;
    var a: usize = 0;
    while (a < n_actions) : (a += 1) out[a] /= mass;
}

fn actionsMatch(expected: []const []const u8, got: []const []const u8) bool {
    if (expected.len == 0) return true;
    if (expected.len != got.len) return false;
    for (expected, 0..) |label, i| {
        if (!std.mem.eql(u8, label, got[i])) return false;
    }
    return true;
}

/// Build Compare-runouts / line-card report JSON (caller frees).
pub fn buildLineCardReportBody(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    published: training_state.PublishedPolicy,
    report_located: node_id.ParsedNodeId,
    solution_id: u64,
    vary_street_opt: ?[]const u8,
) ReportError![]u8 {
    var report_page = inspect.inspectNode(
        allocator,
        game,
        published,
        report_located.node_index,
        report_located.turn,
        report_located.river,
    ) catch |err| {
        return switch (err) {
            error.OutOfMemory => error.OutOfMemory,
            else => error.InvalidReport,
        };
    };
    defer report_page.deinit();
    if (report_page.kind != .decision) return error.InvalidReport;

    const board_len = report_page.board.len;
    const vary_street = vary_street_opt orelse varyStreetFromDecisionBoardLen(board_len) orelse return error.InvalidReport;
    if (!std.mem.eql(u8, vary_street, "turn") and !std.mem.eql(u8, vary_street, "river")) {
        return error.InvalidReport;
    }

    // Walk parents for the deal-chance ancestor (board len before the card).
    var cursor = report_located;
    var chance_located: ?node_id.ParsedNodeId = null;
    var depth: usize = 0;
    while (depth < 64) : (depth += 1) {
        var page = inspect.inspectNode(
            allocator,
            game,
            published,
            cursor.node_index,
            cursor.turn,
            cursor.river,
        ) catch break;
        defer page.deinit();
        if (page.kind == .chance) {
            if (dealStreetFromBoardLen(page.board.len)) |dealing| {
                if (std.mem.eql(u8, dealing, vary_street)) {
                    chance_located = cursor;
                    break;
                }
            }
        }
        cursor = parentLocated(game, cursor.node_index, cursor.turn, cursor.river) orelse break;
    }
    const chance_loc = chance_located orelse return error.InvalidReport;

    var chance_page = inspect.inspectNode(
        allocator,
        game,
        published,
        chance_loc.node_index,
        chance_loc.turn,
        chance_loc.river,
    ) catch |err| {
        return switch (err) {
            error.OutOfMemory => error.OutOfMemory,
            else => error.InvalidReport,
        };
    };
    defer chance_page.deinit();
    if (chance_page.kind != .chance or chance_page.cards.len == 0) return error.InvalidReport;

    const report_node_id = try node_id.formatNodeId(
        allocator,
        report_located.node_index,
        report_located.turn,
        report_located.river,
    );
    defer allocator.free(report_node_id);
    const chance_node_id = try node_id.formatNodeId(
        allocator,
        chance_loc.node_index,
        chance_loc.turn,
        chance_loc.river,
    );
    defer allocator.free(chance_node_id);

    var list = std.ArrayList(u8).init(allocator);
    errdefer list.deinit();
    const w = list.writer();

    try w.writeAll("{\"pending\":false,\"kind\":\"line_card_report\",\"solution_id\":\"s");
    try w.print("{d}", .{solution_id});
    try w.writeAll("\",\"report_node_id\":");
    try appendJsonString(&list, report_node_id);
    try w.writeAll(",\"chance_node_id\":");
    try appendJsonString(&list, chance_node_id);
    try w.writeAll(",\"vary_street\":");
    try appendJsonString(&list, vary_street);
    try w.writeAll(",\"action_labels\":[");
    for (report_page.actions, 0..) |label, i| {
        if (i > 0) try w.writeAll(",");
        try appendJsonString(&list, label);
    }
    try w.writeAll("],\"rows\":[");

    var first_row = true;
    for (chance_page.cards) |card_row| {
        const child_parsed = node_id.parseNodeId(card_row.child_id) catch continue;
        const target = rewriteRunout(report_located.node_index, child_parsed);
        const target_id = node_id.formatNodeId(allocator, target.node_index, target.turn, target.river) catch continue;
        defer allocator.free(target_id);

        if (!first_row) try w.writeAll(",");
        first_row = false;
        try w.writeAll("{\"card\":");
        try appendJsonString(&list, card_row.card);
        try w.print(",\"deal_probability\":{d:.6}", .{card_row.weight});

        var resolved = inspect.inspectNode(
            allocator,
            game,
            published,
            target.node_index,
            target.turn,
            target.river,
        ) catch {
            try w.writeAll(",\"available\":false,\"reason\":\"Line unavailable on this card\",\"resolved_node_id\":null,\"joint\":null,\"player\":null,\"actions\":[],\"frequencies\":[]}");
            continue;
        };
        defer resolved.deinit();

        if (resolved.kind != .decision) {
            try w.writeAll(",\"available\":false,\"reason\":\"Not a decision on this card\",\"resolved_node_id\":");
            try appendJsonString(&list, target_id);
            try w.writeAll(",\"joint\":null,\"player\":null,\"actions\":[],\"frequencies\":[]}");
            continue;
        }

        const match = actionsMatch(report_page.actions, resolved.actions);
        const zero_reach = resolved.reach_defined and resolved.joint == 0;
        // Desktop keeps zero-reach rows available with a reason (still navigable).
        const available = match;
        try w.writeAll(",\"available\":");
        try w.writeAll(if (available) "true" else "false");
        try w.writeAll(",\"reason\":");
        if (!match) {
            try appendJsonString(&list, "Action set differs on this card");
        } else if (zero_reach) {
            try appendJsonString(&list, "Zero joint reach");
        } else {
            try w.writeAll("null");
        }
        try w.writeAll(",\"resolved_node_id\":");
        try appendJsonString(&list, target_id);
        if (resolved.reach_defined) {
            try w.print(",\"joint\":{d:.6}", .{resolved.joint});
        } else {
            try w.writeAll(",\"joint\":null");
        }
        if (resolved.player >= 0) {
            try w.print(",\"player\":{d}", .{resolved.player});
        } else {
            try w.writeAll(",\"player\":null");
        }
        try w.writeAll(",\"actions\":[");
        for (resolved.actions, 0..) |label, i| {
            if (i > 0) try w.writeAll(",");
            try appendJsonString(&list, label);
        }
        try w.writeAll("],\"frequencies\":[");
        var freqs: [16]f64 = undefined;
        if (resolved.actions.len <= freqs.len) {
            actionFrequencies(&resolved, freqs[0..resolved.actions.len]);
            for (0..resolved.actions.len) |i| {
                if (i > 0) try w.writeAll(",");
                try w.print("{d:.6}", .{freqs[i]});
            }
        }
        try w.writeAll("]}");
    }

    try w.writeAll("]}");
    return try list.toOwnedSlice();
}

fn betFrequency(row: []const f32, actions: []const []const u8) f64 {
    var sum: f64 = 0;
    const n = @min(row.len, actions.len);
    var i: usize = 0;
    while (i < n) : (i += 1) {
        if (!isBettingAction(actions[i])) continue;
        const p: f64 = @floatCast(row[i]);
        if (p > 0) sum += p;
    }
    return sum;
}

fn topBettingActionIndex(row: []const f32, actions: []const []const u8) isize {
    var best: isize = -1;
    var best_p: f64 = -1;
    const n = @min(row.len, actions.len);
    var i: usize = 0;
    while (i < n) : (i += 1) {
        if (!isBettingAction(actions[i])) continue;
        const p: f64 = @floatCast(row[i]);
        if (p > best_p) {
            best_p = p;
            best = @intCast(i);
        }
    }
    return best;
}

fn callActionIndex(actions: []const []const u8) isize {
    for (actions, 0..) |label, i| {
        if (isCallAction(label)) return @intCast(i);
    }
    return -1;
}

fn comboKey(combo: []const u8, buf: *[4]u8) []const u8 {
    // Desktop canonicalize is richer; exact label match is enough for report join.
    if (combo.len >= 4) {
        @memcpy(buf[0..4], combo[0..4]);
        return buf[0..4];
    }
    return combo;
}

/// After-call equity join for Value/Bluffs Mode B (caller frees body).
/// When `ctx` is set, reuses warm FrozenCtx checkdown (same path as Study equity).
pub fn buildValueBluffsPostCallBody(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    published: training_state.PublishedPolicy,
    located: node_id.ParsedNodeId,
    solution_id: u64,
    min_bet_freq: f64,
    ctx: ?*frozen_walk.FrozenCtx,
) ReportError![]u8 {
    var hero = inspect.inspectNode(
        allocator,
        game,
        published,
        located.node_index,
        located.turn,
        located.river,
    ) catch |err| {
        return switch (err) {
            error.OutOfMemory => error.OutOfMemory,
            else => error.InvalidReport,
        };
    };
    defer hero.deinit();
    if (hero.kind != .decision or hero.actions.len == 0 or hero.combos.len == 0) {
        return error.InvalidReport;
    }

    const n_actions = hero.actions.len;
    const n_hands = hero.combos.len;
    // Fetch Call-child equity for every betting action so size toggles can
    // re-join after-call equity at a non-dominant size. Still join `hands`
    // by each combo's dominant size for back-compat.
    var fetch_action = try allocator.alloc(u8, n_actions);
    defer allocator.free(fetch_action);
    @memset(fetch_action, 0);
    {
        var ai: usize = 0;
        while (ai < n_actions) : (ai += 1) {
            if (isBettingAction(hero.actions[ai])) fetch_action[ai] = 1;
        }
    }

    // Per betting size: facing → Call → equity hands keyed by combo.
    const HandEq = struct { equity: f64, weight: f64, defined: bool = false };
    var by_action = try allocator.alloc(?[]HandEq, n_actions);
    defer {
        for (by_action) |slot| {
            if (slot) |rows| allocator.free(rows);
        }
        allocator.free(by_action);
    }
    @memset(by_action, null);

    var call_ids = std.ArrayList([]const u8).init(allocator);
    defer {
        for (call_ids.items) |id| allocator.free(id);
        call_ids.deinit();
    }
    var missing: usize = 0;

    var a: usize = 0;
    while (a < n_actions) : (a += 1) {
        if (fetch_action[a] == 0) continue;
        if (a >= hero.children.len or hero.children[a].len == 0) {
            missing += 1;
            continue;
        }
        const facing_id = hero.children[a];
        const facing_loc = node_id.locateNode(game, facing_id) catch {
            missing += 1;
            continue;
        };
        var facing = inspect.inspectNode(
            allocator,
            game,
            published,
            facing_loc.node_index,
            facing_loc.turn,
            facing_loc.river,
        ) catch {
            missing += 1;
            continue;
        };
        defer facing.deinit();
        const call_idx = callActionIndex(facing.actions);
        if (call_idx < 0 or @as(usize, @intCast(call_idx)) >= facing.children.len) {
            missing += 1;
            continue;
        }
        const call_id = facing.children[@intCast(call_idx)];
        const owned_call = try allocator.dupe(u8, call_id);
        try call_ids.append(owned_call);
        const call_loc = node_id.locateNode(game, call_id) catch {
            missing += 1;
            continue;
        };
        var page = (if (ctx) |warm|
            equity.checkdownEquityAtNodeOnCtx(
                allocator,
                warm,
                game,
                published,
                call_loc.node_index,
                call_loc.turn,
                call_loc.river,
                equity.study_warm_max_hand_runouts,
            )
        else
            equity.checkdownEquityAtNode(
                allocator,
                game,
                published,
                call_loc.node_index,
                call_loc.turn,
                call_loc.river,
                equity.study_explorer_max_pair_runouts,
            )) catch |err| {
            return switch (err) {
                error.OutOfMemory => error.OutOfMemory,
                error.WorkLimit => error.WorkLimit,
                error.InvalidWeight => error.InvalidWeight,
                else => error.InvalidEquity,
            };
        };
        defer page.deinit();

        const seat = if (hero.player == 1) page.player1 else page.player0;
        var rows = try allocator.alloc(HandEq, n_hands);
        for (rows) |*row| {
            row.* = .{ .equity = 0.0, .weight = 0.0, .defined = false };
        }
        // Map equity combos onto hero combo order.
        for (hero.combos, 0..) |hcombo, hi| {
            for (seat.combos) |erow| {
                if (!erow.defined) continue;
                if (std.mem.eql(u8, erow.combo, hcombo)) {
                    rows[hi] = .{ .equity = erow.equity, .weight = erow.input_weight, .defined = true };
                    break;
                }
            }
        }
        by_action[a] = rows;
    }

    // Join: each combo uses equity from its dominant betting size's Call child.
    // Also emit hands_by_action so the Study UI can re-join for size filters.
    var list = std.ArrayList(u8).init(allocator);
    errdefer list.deinit();
    const w = list.writer();
    const node_text = try node_id.formatNodeId(allocator, located.node_index, located.turn, located.river);
    defer allocator.free(node_text);

    try w.writeAll("{\"pending\":false,\"kind\":\"value_bluffs_post_call\",\"solution_id\":\"s");
    try w.print("{d}", .{solution_id});
    try w.writeAll("\",\"node_id\":");
    try appendJsonString(&list, node_text);
    try w.writeAll(",\"call_node_ids\":[");
    for (call_ids.items, 0..) |id, i| {
        if (i > 0) try w.writeAll(",");
        try appendJsonString(&list, id);
    }
    try w.print("],\"missing_call_count\":{d},\"hands_by_action\":[", .{missing});

    var first_action = true;
    a = 0;
    while (a < n_actions) : (a += 1) {
        const slot = by_action[a] orelse continue;
        if (!first_action) try w.writeAll(",");
        first_action = false;
        try w.print("{{\"action_index\":{d},\"hands\":[", .{a});
        var first_hand = true;
        var hi: usize = 0;
        while (hi < n_hands) : (hi += 1) {
            const he = slot[hi];
            if (!he.defined) continue;
            if (!first_hand) try w.writeAll(",");
            first_hand = false;
            try w.writeAll("{\"combo\":");
            try appendJsonString(&list, hero.combos[hi]);
            try w.print(",\"equity\":{d:.6},\"weight\":{d:.6}}}", .{ he.equity, he.weight });
        }
        try w.writeAll("]}");
    }

    try w.writeAll("],\"hands\":[");

    var first = true;
    var any = false;
    var hand: usize = 0;
    while (hand < n_hands) : (hand += 1) {
        const row = if (hero.strategy.len >= (hand + 1) * n_actions)
            hero.strategy[hand * n_actions .. hand * n_actions + n_actions]
        else
            &[_]f32{};
        if (!(betFrequency(row, hero.actions) >= min_bet_freq)) continue;
        const idx = topBettingActionIndex(row, hero.actions);
        if (idx < 0) continue;
        const slot = by_action[@intCast(idx)] orelse continue;
        const he = slot[hand];
        if (!he.defined) continue;
        if (!first) try w.writeAll(",");
        first = false;
        any = true;
        try w.writeAll("{\"combo\":");
        try appendJsonString(&list, hero.combos[hand]);
        try w.print(",\"equity\":{d:.6},\"weight\":{d:.6}}}", .{ he.equity, he.weight });
    }
    try w.writeAll("],\"error\":");
    if (!any) {
        try appendJsonString(&list, "No post-call equity hands for dominant bet sizes.");
    } else {
        try w.writeAll("null");
    }
    try w.writeAll("}");
    return try list.toOwnedSlice();
}

test "betting and call label helpers" {
    try std.testing.expect(isBettingAction("Bet 50"));
    try std.testing.expect(isBettingAction("Raise 100"));
    try std.testing.expect(isBettingAction("All-in"));
    try std.testing.expect(!isBettingAction("Check"));
    try std.testing.expect(isCallAction("Call"));
    try std.testing.expect(isCallAction("call 50"));
    try std.testing.expect(!isCallAction("Check"));
}
