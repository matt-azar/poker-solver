//! Map IPC ops onto the app Session. Cancel fails pending jobs (D1).
const std = @import("std");
const poker_app = @import("poker_app");
const poker_engine = @import("poker_engine");
const ipc = @import("ipc.zig");
const workers = @import("workers.zig");
const equity_json = @import("equity_json.zig");

const TrainTask = struct {
    state: *HostState,
    request_id: []u8,
    job_id: ?[]u8,
    op: []u8,
    iterations: i32,
};

pub const HostState = struct {
    allocator: std.mem.Allocator,
    session: poker_app.Session,
    budget: workers.WorkerBudget,
    launch_id: []u8 = &.{},
    pending: std.ArrayList([]u8),
    cancelled_jobs: std.StringHashMap(void),
    /// Serialize stdout frames from stdin loop + train worker (R10).
    stdout_mu: std.Thread.Mutex = .{},
    train_thread: ?std.Thread = null,
    train_running: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),

    pub fn init(allocator: std.mem.Allocator, launch_id: []const u8) !HostState {
        return .{
            .allocator = allocator,
            .session = poker_app.Session.init(allocator),
            .budget = workers.WorkerBudget.initFromCpus(),
            .launch_id = try allocator.dupe(u8, launch_id),
            .pending = std.ArrayList([]u8).init(allocator),
            .cancelled_jobs = std.StringHashMap(void).init(allocator),
        };
    }

    pub fn deinit(self: *HostState) void {
        self.joinTrain();
        self.clearPending();
        self.session.deinit();
        if (self.launch_id.len != 0) self.allocator.free(self.launch_id);
        var it = self.cancelled_jobs.keyIterator();
        while (it.next()) |key| self.allocator.free(key.*);
        self.cancelled_jobs.deinit();
        self.pending.deinit();
    }

    pub fn joinTrain(self: *HostState) void {
        if (self.train_thread) |t| {
            t.join();
            self.train_thread = null;
        }
    }

    pub fn writeReply(self: *HostState, reply: ipc.Envelope) !void {
        self.stdout_mu.lock();
        defer self.stdout_mu.unlock();
        try ipc.writeFrame(self.allocator, std.io.getStdOut().writer(), reply);
    }

    pub fn clearPending(self: *HostState) void {
        for (self.pending.items) |id| self.allocator.free(id);
        self.pending.clearRetainingCapacity();
    }

    pub fn track(self: *HostState, request_id: []const u8) !void {
        const owned = try self.allocator.dupe(u8, request_id);
        try self.pending.append(owned);
    }

    pub fn untrack(self: *HostState, request_id: []const u8) void {
        var i: usize = 0;
        while (i < self.pending.items.len) {
            if (std.mem.eql(u8, self.pending.items[i], request_id)) {
                self.allocator.free(self.pending.items[i]);
                _ = self.pending.orderedRemove(i);
                return;
            }
            i += 1;
        }
    }

    pub fn cancelJob(self: *HostState, job_id: []const u8) !void {
        const owned = try self.allocator.dupe(u8, job_id);
        errdefer self.allocator.free(owned);
        try self.cancelled_jobs.put(owned, {});
    }

    pub fn isCancelled(self: *HostState, job_id: ?[]const u8) bool {
        if (job_id == null) return false;
        return self.cancelled_jobs.contains(job_id.?);
    }
};

fn bodyStringField(body: []const u8, key: []const u8) ?[]const u8 {
    var needle_buf: [64]u8 = undefined;
    const needle = std.fmt.bufPrint(&needle_buf, "\"{s}\":\"", .{key}) catch return null;
    const start = std.mem.indexOf(u8, body, needle) orelse return null;
    var i = start + needle.len;
    const from = i;
    while (i < body.len) : (i += 1) {
        if (body[i] == '\\') {
            i += 1;
            continue;
        }
        if (body[i] == '"') return body[from..i];
    }
    return null;
}

fn bodyIntField(body: []const u8, key: []const u8) ?i32 {
    var needle_buf: [64]u8 = undefined;
    const needle = std.fmt.bufPrint(&needle_buf, "\"{s}\":", .{key}) catch return null;
    const start = std.mem.indexOf(u8, body, needle) orelse return null;
    var i = start + needle.len;
    while (i < body.len and (body[i] == ' ' or body[i] == '\t')) : (i += 1) {}
    const from = i;
    while (i < body.len and ((body[i] >= '0' and body[i] <= '9') or body[i] == '-')) : (i += 1) {}
    return std.fmt.parseInt(i32, body[from..i], 10) catch null;
}

fn resolveLocatedNode(
    game: poker_engine.game.CompiledGame,
    body_json: []const u8,
) poker_engine.analysis.node_id.NodeIdError!poker_engine.analysis.node_id.ParsedNodeId {
    if (bodyStringField(body_json, "node_id")) |text| {
        return poker_engine.analysis.node_id.locateNode(game, text);
    }
    const node_index: u32 = @intCast(bodyIntField(body_json, "node_index") orelse 0);
    const turn = bodyIntField(body_json, "turn") orelse -1;
    const river = bodyIntField(body_json, "river") orelse -1;
    if (node_index >= game.nodes.len) return error.UnknownNode;
    var buf: [64]u8 = undefined;
    const text = std.fmt.bufPrint(&buf, "p{d}.t{d}.r{d}", .{ node_index, turn, river }) catch return error.UnknownNode;
    return poker_engine.analysis.node_id.locateNode(game, text);
}

fn formatStatusBody(allocator: std.mem.Allocator, state: *const HostState) ![]u8 {
    const running = state.session.phase == .training or state.session.phase == .compiling;
    const paused = state.session.phase == .paused;
    var list = std.ArrayList(u8).init(allocator);
    errdefer list.deinit();
    const w = list.writer();
    try w.writeAll("{\"running\":");
    try w.writeAll(if (running) "true" else "false");
    try w.writeAll(",\"paused\":");
    try w.writeAll(if (paused) "true" else "false");
    try w.writeAll(",\"cancelled\":false");
    try w.print(",\"status_generation\":{d}", .{state.session.solution_id + state.session.policyRevision()});
    if (state.session.solution_id == 0) {
        try w.writeAll(",\"solution_id\":null,\"job_id\":null,\"root_node_id\":null");
    } else {
        try w.print(",\"solution_id\":\"s{d}\",\"job_id\":null,\"root_node_id\":\"p0.t-1.r-1\"", .{state.session.solution_id});
    }
    try w.print(",\"phase\":\"{s}\",\"policy_revision\":{d},\"workers_training\":{d},\"workers_analysis\":{d},\"transport\":\"ipc\",\"sidecar\":\"solver-engine\"}}", .{
        @tagName(state.session.phase),
        state.session.policyRevision(),
        state.budget.training,
        state.budget.analysis,
    });
    return try list.toOwnedSlice();
}

fn formatNodeBody(
    allocator: std.mem.Allocator,
    page: *const poker_engine.analysis.inspect.NodePage,
    located: poker_engine.analysis.node_id.ParsedNodeId,
    solution_id: u64,
) ![]u8 {
    var list = std.ArrayList(u8).init(allocator);
    errdefer list.deinit();
    const w = list.writer();

    const node_id_text = try poker_engine.analysis.node_id.formatNodeId(
        allocator,
        located.node_index,
        located.turn,
        located.river,
    );
    defer allocator.free(node_id_text);

    const n_actions: usize = page.actions.len;
    const n_hands: usize = page.combos.len;

    try w.writeAll("{\"solution_id\":\"s");
    try w.print("{d}", .{solution_id});
    try w.writeAll("\",\"node_id\":");
    try appendJsonString(&list, node_id_text);
    try w.print(",\"node_index\":{d},\"kind\":\"decision\",\"player\":{d},\"policy_revision\":{d}", .{
        page.node_index,
        page.player,
        page.policy_revision,
    });
    try w.print(",\"n_actions\":{d},\"n_hands\":{d},\"reach_defined\":false", .{ n_actions, n_hands });

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
    try w.writeAll("],\"strategy\":");
    if (n_actions == 0 or page.strategy.len == 0) {
        // Implicit σ=1 (n_actions <= 1) — no stored rows; Study treats null as absent.
        try w.writeAll("null");
    } else {
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
    try w.writeAll("}");
    return try list.toOwnedSlice();
}

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

fn formatValuesBody(
    allocator: std.mem.Allocator,
    page: *const poker_engine.analysis.action_ev.ActionValues,
    located: poker_engine.analysis.node_id.ParsedNodeId,
    solution_id: u64,
    elapsed_ms: i128,
    live_under_train: bool,
) ![]u8 {
    var list = std.ArrayList(u8).init(allocator);
    errdefer list.deinit();
    const w = list.writer();

    const node_id_text = try poker_engine.analysis.node_id.formatNodeId(
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
    try w.writeAll("],\"action_ev\":[");
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
    try w.writeAll("],\"value\":[");
    hand = 0;
    while (hand < n_hands) : (hand += 1) {
        if (hand > 0) try w.writeAll(",");
        if (hand >= page.ev_defined.len or page.ev_defined[hand] == 0 or hand >= page.mixed_ev.len) {
            try w.writeAll("null");
            continue;
        }
        try w.print("{d:.6}", .{page.mixed_ev[hand]});
    }
    try w.writeAll("]}");
    return try list.toOwnedSlice();
}

fn unescapeConfig(allocator: std.mem.Allocator, escaped: []const u8) ![]u8 {
    var raw = std.ArrayList(u8).init(allocator);
    errdefer raw.deinit();
    var i: usize = 0;
    while (i < escaped.len) : (i += 1) {
        if (escaped[i] == '\\' and i + 1 < escaped.len) {
            switch (escaped[i + 1]) {
                'n' => {
                    try raw.append('\n');
                    i += 1;
                    continue;
                },
                '\\' => {
                    try raw.append('\\');
                    i += 1;
                    continue;
                },
                '"' => {
                    try raw.append('"');
                    i += 1;
                    continue;
                },
                else => {},
            }
        }
        try raw.append(escaped[i]);
    }
    if (raw.items.len == 0 or raw.items[raw.items.len - 1] != '\n') try raw.append('\n');
    return raw.toOwnedSlice();
}

pub fn handle(state: *HostState, req: ipc.Envelope) !ipc.Envelope {
    try state.track(req.request_id);
    defer state.untrack(req.request_id);

    if (state.isCancelled(req.job_id)) {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "cancelled", "job cancelled");
    }

    if (std.mem.eql(u8, req.op, "ready")) {
        var buf: [320]u8 = undefined;
        const body = try std.fmt.bufPrint(&buf, "{{\"protocol\":{d},\"sidecar\":\"solver-engine\",\"launch_id\":\"{s}\",\"workers\":{d}}}", .{
            ipc.protocol_version,
            state.launch_id,
            state.budget.total,
        });
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, body);
    }

    if (std.mem.eql(u8, req.op, "status")) {
        // Study-compatible flags (decodeStatusPayload) + Zig session fields.
        const body = try formatStatusBody(state.allocator, state);
        defer state.allocator.free(body);
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, body);
    }

    if (std.mem.eql(u8, req.op, "cancel")) {
        if (req.job_id) |jid| {
            try state.cancelJob(jid);
            return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, "{\"cancelled\":true}");
        }
        return ipc.makeErrorReply(state.allocator, req.request_id, null, req.op, "invalid_request", "cancel requires job_id");
    }

    if (std.mem.eql(u8, req.op, "begin_config")) {
        const escaped = bodyStringField(req.body_json, "config_text") orelse
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "config_text required");
        const config = try unescapeConfig(state.allocator, escaped);
        defer state.allocator.free(config);
        state.session.begin(config) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "begin_failed", @errorName(err));
        };
        var buf: [64]u8 = undefined;
        const body = try std.fmt.bufPrint(&buf, "{{\"solution_id\":{d}}}", .{state.session.solution_id});
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, body);
    }

    if (std.mem.eql(u8, req.op, "pause")) {
        state.session.pause() catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "pause_failed", @errorName(err));
        };
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, "{\"phase\":\"paused\"}");
    }

    if (std.mem.eql(u8, req.op, "save")) {
        const path = bodyStringField(req.body_json, "path") orelse
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "path required");
        state.session.save(path) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "save_failed", @errorName(err));
        };
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, "{\"saved\":true}");
    }

    if (std.mem.eql(u8, req.op, "open")) {
        const path = bodyStringField(req.body_json, "path") orelse
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "path required");
        state.session.open(path) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "open_failed", @errorName(err));
        };
        // Same Study status shape as `status` so EngineClient.open can decodeStatusPayload.
        const body = try formatStatusBody(state.allocator, state);
        defer state.allocator.free(body);
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, body);
    }

    if (std.mem.eql(u8, req.op, "node")) {
        state.budget.prioritizeAnalysis(1);
        defer state.budget.returnToTraining();
        var lease = state.session.borrowPublished() catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "nothing_published", @errorName(err));
        };
        defer lease.deinit();
        const located = resolveLocatedNode(lease.game, req.body_json) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "unknown_node", @errorName(err));
        };
        var page = poker_engine.analysis.inspect.inspectNode(
            state.allocator,
            lease.game,
            lease.published,
            located.node_index,
            located.turn,
            located.river,
        ) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "inspect_failed", @errorName(err));
        };
        defer page.deinit();
        const body = formatNodeBody(state.allocator, &page, located, lease.solution_id) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "inspect_failed", @errorName(err));
        };
        defer state.allocator.free(body);
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, body);
    }

    if (std.mem.eql(u8, req.op, "values")) {
        state.budget.prioritizeAnalysis(1);
        defer state.budget.returnToTraining();
        // Wait briefly for mid-train publish when solve just started (R10).
        const wait_ns: u64 = 120 * std.time.ns_per_s;
        var lease = state.session.borrowPublishedWait(wait_ns) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "nothing_published", @errorName(err));
        };
        defer lease.deinit();
        const located = resolveLocatedNode(lease.game, req.body_json) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "unknown_node", @errorName(err));
        };
        const t0 = std.time.nanoTimestamp();
        var page = poker_engine.analysis.action_ev.actionValues(
            state.allocator,
            lease.game,
            lease.published,
            located.node_index,
            located.turn,
            located.river,
        ) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "values_failed", @errorName(err));
        };
        defer page.deinit();
        const elapsed_ns = std.time.nanoTimestamp() - t0;
        const elapsed_ms = @divTrunc(elapsed_ns, 1_000_000);
        const body = formatValuesBody(
            state.allocator,
            &page,
            located,
            lease.solution_id,
            elapsed_ms,
            state.train_running.load(.acquire),
        ) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "values_failed", @errorName(err));
        };
        defer state.allocator.free(body);
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, body);
    }

    if (std.mem.eql(u8, req.op, "prioritize_analysis")) {
        const want: u32 = @intCast(@max(bodyIntField(req.body_json, "workers") orelse 1, 0));
        state.budget.prioritizeAnalysis(want);
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, "{\"ok\":true}");
    }

    if (std.mem.eql(u8, req.op, "equity")) {
        state.budget.prioritizeAnalysis(1);
        defer state.budget.returnToTraining();
        const wait_ns: u64 = 120 * std.time.ns_per_s;
        var lease = state.session.borrowPublishedWait(wait_ns) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "nothing_published", @errorName(err));
        };
        defer lease.deinit();
        // Accept Study node_id / node_index for identity; math is still starting-range
        // check-down on the compiled board (strategy-reach residual).
        const located = resolveLocatedNode(lease.game, req.body_json) catch |err| {
            const code: []const u8 = switch (err) {
                error.UnknownNode => "unknown_node",
                error.OutOfMemory => "oom",
            };
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, code, @errorName(err));
        };
        const node_id_text = poker_engine.analysis.node_id.formatNodeId(
            state.allocator,
            located.node_index,
            located.turn,
            located.river,
        ) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "equity_pack_failed", @errorName(err));
        };
        defer state.allocator.free(node_id_text);
        const t0 = std.time.nanoTimestamp();
        var page = poker_engine.analysis.equity.checkdownEquity(
            state.allocator,
            lease.game,
            poker_engine.analysis.equity.study_explorer_max_pair_runouts,
        ) catch |err| {
            const code: []const u8 = switch (err) {
                error.WorkLimit => "work_limit",
                error.InvalidEquity => "invalid_equity",
                error.InvalidWeight => "invalid_weight",
                error.OutOfMemory => "oom",
            };
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, code, @errorName(err));
        };
        defer page.deinit();
        const elapsed_ns = std.time.nanoTimestamp() - t0;
        const elapsed_ms: i64 = @intCast(@divTrunc(elapsed_ns, 1_000_000));
        const query_seconds: f64 = @as(f64, @floatFromInt(elapsed_ns)) / 1e9;
        const body = equity_json.packStudyEquityBody(state.allocator, .{
            .solution_id = lease.solution_id,
            .node_id = node_id_text,
            .node_index = located.node_index,
            .policy_revision = state.session.policyRevision(),
            .status_generation = state.session.solution_id + state.session.policyRevision(),
            .query_seconds = query_seconds,
            .elapsed_ms = elapsed_ms,
            .live_under_train = state.train_running.load(.acquire),
            .page = &page,
        }) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "equity_pack_failed", @errorName(err));
        };
        defer state.allocator.free(body);
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, body);
    }

    return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "unknown_op", req.op);
}

fn trainWorker(task: *TrainTask) void {
    const state = task.state;
    defer {
        state.untrack(task.request_id);
        state.train_running.store(false, .release);
        state.allocator.free(task.request_id);
        if (task.job_id) |j| state.allocator.free(j);
        state.allocator.free(task.op);
        state.allocator.destroy(task);
    }

    var reply: ipc.Envelope = undefined;
    if (state.session.train(task.iterations)) |_| {
        var buf: [192]u8 = undefined;
        const trained: i32 = if (state.session.published) |p| p.trained else 0;
        const body = std.fmt.bufPrint(&buf, "{{\"solution_id\":{d},\"policy_revision\":{d},\"trained\":{d},\"async\":true}}", .{
            state.session.solution_id,
            state.session.policyRevision(),
            trained,
        }) catch {
            reply = ipc.makeErrorReply(state.allocator, task.request_id, task.job_id, task.op, "solve_failed", "format") catch return;
            defer reply.deinit();
            state.writeReply(reply) catch {};
            return;
        };
        reply = ipc.makeReply(state.allocator, task.request_id, task.job_id, task.op, body) catch {
            reply = ipc.makeErrorReply(state.allocator, task.request_id, task.job_id, task.op, "solve_failed", "oom") catch return;
            defer reply.deinit();
            state.writeReply(reply) catch {};
            return;
        };
    } else |err| {
        reply = ipc.makeErrorReply(state.allocator, task.request_id, task.job_id, task.op, "solve_failed", @errorName(err)) catch return;
    }
    defer reply.deinit();
    state.writeReply(reply) catch {};
}

/// Spawn background CFR+ train so the stdin loop can serve `values` mid-train (R10).
/// Does not write a sync reply; the worker emits the solve reply when finished.
pub fn startSolve(state: *HostState, req: ipc.Envelope) !void {
    try state.track(req.request_id);
    errdefer state.untrack(req.request_id);

    if (state.isCancelled(req.job_id)) {
        var err_reply = try ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "cancelled", "job cancelled");
        defer err_reply.deinit();
        state.untrack(req.request_id);
        try state.writeReply(err_reply);
        return;
    }

    if (state.session.phase == .idle) {
        var err_reply = try ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_session", "call begin_config before solve");
        defer err_reply.deinit();
        state.untrack(req.request_id);
        try state.writeReply(err_reply);
        return;
    }

    if (state.train_running.load(.acquire)) {
        var err_reply = try ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "busy", "train already running");
        defer err_reply.deinit();
        state.untrack(req.request_id);
        try state.writeReply(err_reply);
        return;
    }
    // Reap a finished worker before starting another.
    state.joinTrain();

    const iterations = bodyIntField(req.body_json, "iterations") orelse 1;
    state.budget.returnToTraining();
    // D3: train uses the shared training worker budget (manual config may already set Session.threads).
    if (state.budget.training > 0) {
        state.session.setThreads(state.budget.training);
    }

    const task = try state.allocator.create(TrainTask);
    errdefer state.allocator.destroy(task);
    task.* = .{
        .state = state,
        .request_id = try state.allocator.dupe(u8, req.request_id),
        .job_id = if (req.job_id) |j| try state.allocator.dupe(u8, j) else null,
        .op = try state.allocator.dupe(u8, req.op),
        .iterations = iterations,
    };
    errdefer {
        state.allocator.free(task.request_id);
        if (task.job_id) |j| state.allocator.free(j);
        state.allocator.free(task.op);
    }

    state.train_running.store(true, .release);
    state.train_thread = std.Thread.spawn(.{}, trainWorker, .{task}) catch |err| {
        state.train_running.store(false, .release);
        state.allocator.free(task.request_id);
        if (task.job_id) |j| state.allocator.free(j);
        state.allocator.free(task.op);
        state.allocator.destroy(task);
        state.untrack(req.request_id);
        var err_reply = try ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "solve_failed", @errorName(err));
        defer err_reply.deinit();
        try state.writeReply(err_reply);
        return;
    };
}

test "ready dispatch" {
    var state = try HostState.init(std.testing.allocator, "launch-1");
    defer state.deinit();
    var req = try ipc.makeReply(std.testing.allocator, "r1", null, "ready", "null");
    // Reuse makeReply then tweak kind — build request manually.
    req.deinit();
    req = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "r1"),
        .op = try std.testing.allocator.dupe(u8, "ready"),
        .body_json = try std.testing.allocator.dupe(u8, "null"),
    };
    defer req.deinit();
    var reply = try handle(&state, req);
    defer reply.deinit();
    try std.testing.expect(reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "solver-engine") != null);
}

test "node accepts Study node_id and returns strategy tables" {
    const config =
        \\street-config 1
        \\board Ah Kh Qh Jh 2c
        \\pot 100
        \\stack 100
        \\oop-range AsQs:1,2d2h:1
        \\ip-range AsQs:1,2d2h:1
        \\oop-river-bets 1
        \\ip-river-bets 1
        \\first-to-act 0
        \\max-raises 0
        \\allow-all-in 1
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 256
        \\threads 1
        \\
    ;
    var state = try HostState.init(std.testing.allocator, "node-inspect");
    defer state.deinit();
    try state.session.begin(config);
    try state.session.train(1);

    var req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "n1"),
        .op = try std.testing.allocator.dupe(u8, "node"),
        .body_json = try std.testing.allocator.dupe(u8, "{\"node_id\":\"p0.t-1.r-1\"}"),
    };
    defer req.deinit();
    var reply = try handle(&state, req);
    defer reply.deinit();
    try std.testing.expect(reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"node_id\":\"p0.t-1.r-1\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"actions\":[") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"combos\":[") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"kind\":\"decision\"") != null);
    // Root river with bets usually has strategy rows; either 2D array or null (check-only).
    try std.testing.expect(
        std.mem.indexOf(u8, reply.body_json, "\"strategy\":[") != null or
            std.mem.indexOf(u8, reply.body_json, "\"strategy\":null") != null,
    );

    var bad: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "n2"),
        .op = try std.testing.allocator.dupe(u8, "node"),
        .body_json = try std.testing.allocator.dupe(u8, "{\"node_id\":\"p999.t-1.r-1\"}"),
    };
    defer bad.deinit();
    var bad_reply = try handle(&state, bad);
    defer bad_reply.deinit();
    try std.testing.expect(!bad_reply.ok);
    try std.testing.expect(std.mem.eql(u8, bad_reply.error_code orelse "", "unknown_node"));
}

test "pause cancel and status-shaped open reply" {
    const config =
        \\street-config 1
        \\board Ah Kh Qh Jh 2c
        \\pot 100
        \\stack 100
        \\oop-range AsQs:1,2d2h:1
        \\ip-range AsQs:1,2d2h:1
        \\oop-river-bets 
        \\ip-river-bets 
        \\first-to-act 0
        \\max-raises 0
        \\allow-all-in 1
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 256
        \\threads 1
        \\
    ;
    var state = try HostState.init(std.testing.allocator, "lifecycle");
    defer state.deinit();
    try state.session.begin(config);
    try state.session.train(1);

    var pause_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "p1"),
        .op = try std.testing.allocator.dupe(u8, "pause"),
        .body_json = try std.testing.allocator.dupe(u8, "null"),
    };
    defer pause_req.deinit();
    var pause_reply = try handle(&state, pause_req);
    defer pause_reply.deinit();
    try std.testing.expect(pause_reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, pause_reply.body_json, "\"phase\":\"paused\"") != null);

    var cancel_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "c1"),
        .job_id = try std.testing.allocator.dupe(u8, "j-study"),
        .op = try std.testing.allocator.dupe(u8, "cancel"),
        .body_json = try std.testing.allocator.dupe(u8, "null"),
    };
    defer cancel_req.deinit();
    var cancel_reply = try handle(&state, cancel_req);
    defer cancel_reply.deinit();
    try std.testing.expect(cancel_reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, cancel_reply.body_json, "\"cancelled\":true") != null);

    // Save + open round-trip for status-shaped open body (portable tmpDir — Windows CI has no /tmp).
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const abs = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(abs);
    const tmp_path = try std.fs.path.join(std.testing.allocator, &.{ abs, "slice-a-open.psol" });
    defer std.testing.allocator.free(tmp_path);
    var save_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "s1"),
        .op = try std.testing.allocator.dupe(u8, "save"),
        .body_json = try std.fmt.allocPrint(std.testing.allocator, "{{\"path\":\"{s}\"}}", .{tmp_path}),
    };
    defer save_req.deinit();
    var save_reply = try handle(&state, save_req);
    defer save_reply.deinit();
    if (!save_reply.ok) {
        std.debug.print("save failed code={s} msg={s} path={s}\n", .{
            save_reply.error_code orelse "",
            save_reply.error_message orelse "",
            tmp_path,
        });
    }
    try std.testing.expect(save_reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, save_reply.body_json, "\"saved\":true") != null);

    var open_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "o1"),
        .op = try std.testing.allocator.dupe(u8, "open"),
        .body_json = try std.fmt.allocPrint(std.testing.allocator, "{{\"path\":\"{s}\"}}", .{tmp_path}),
    };
    defer open_req.deinit();
    var open_reply = try handle(&state, open_req);
    defer open_reply.deinit();
    if (!open_reply.ok) {
        std.debug.print("open failed code={s} msg={s}\n", .{
            open_reply.error_code orelse "",
            open_reply.error_message orelse "",
        });
    }
    try std.testing.expect(open_reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, open_reply.body_json, "\"running\":") != null);
    try std.testing.expect(std.mem.indexOf(u8, open_reply.body_json, "\"paused\":") != null);
    try std.testing.expect(std.mem.indexOf(u8, open_reply.body_json, "\"cancelled\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, open_reply.body_json, "\"status_generation\":") != null);
    try std.testing.expect(std.mem.indexOf(u8, open_reply.body_json, "\"solution_id\":\"s") != null);
}

test "values accepts Study node_id and returns hand×action tables" {
    const config =
        \\street-config 1
        \\board Ah Kh Qh Jh 2c
        \\pot 100
        \\stack 100
        \\oop-range AsQs:1,2d2h:1
        \\ip-range AsQs:1,2d2h:1
        \\oop-river-bets 1
        \\ip-river-bets 1
        \\first-to-act 0
        \\max-raises 0
        \\allow-all-in 1
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 256
        \\threads 1
        \\
    ;
    var state = try HostState.init(std.testing.allocator, "values-node-id");
    defer state.deinit();
    try state.session.begin(config);
    try state.session.train(1);

    var req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "v1"),
        .op = try std.testing.allocator.dupe(u8, "values"),
        .body_json = try std.testing.allocator.dupe(u8, "{\"node_id\":\"p0.t-1.r-1\"}"),
    };
    defer req.deinit();
    var reply = try handle(&state, req);
    defer reply.deinit();
    try std.testing.expect(reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"node_id\":\"p0.t-1.r-1\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"action_ev\":[") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"combos\":[") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"value\":[") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"actions\":[") != null);

    var bad: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "v2"),
        .op = try std.testing.allocator.dupe(u8, "values"),
        .body_json = try std.testing.allocator.dupe(u8, "{\"node_id\":\"p999.t-1.r-1\"}"),
    };
    defer bad.deinit();
    var bad_reply = try handle(&state, bad);
    defer bad_reply.deinit();
    try std.testing.expect(!bad_reply.ok);
    try std.testing.expect(std.mem.eql(u8, bad_reply.error_code orelse "", "unknown_node"));
}

test "equity dispatch river smoke Study shape" {
    const text =
        \\street-config 1
        \\board Ah Kh Qh Jh 2c
        \\pot 100
        \\stack 100
        \\oop-range AsQs:1,2d2h:1
        \\ip-range AsQs:1,2d2h:1
        \\oop-river-bets 1
        \\ip-river-bets 1
        \\first-to-act 0
        \\max-raises 0
        \\allow-all-in 1
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 256
        \\threads 1
        \\
    ;
    var state = try HostState.init(std.testing.allocator, "equity-smoke");
    defer state.deinit();
    try state.session.begin(text);
    try state.session.train(2);

    var req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "r-eq"),
        .op = try std.testing.allocator.dupe(u8, "equity"),
        .body_json = try std.testing.allocator.dupe(u8, "{\"node_index\":0,\"node_id\":\"p0.t-1.r-1\"}"),
    };
    defer req.deinit();
    var reply = try handle(&state, req);
    defer reply.deinit();
    try std.testing.expect(reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"kind\":\"equity\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"model\":\"check-down\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"defined\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"oop_equity\":") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"ip_equity\":") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"equity_distribution\":[") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"ip_equity_distribution\":[") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"oop_hands\":[") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"ip_hands\":[") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"engine\":\"checkdown_equity\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "AsQs") != null);
}
