//! Map IPC ops onto the app Session. Cancel fails pending jobs (D1).
const std = @import("std");
const poker_app = @import("poker_app");
const poker_engine = @import("poker_engine");
const ipc = @import("ipc.zig");
const workers = @import("workers.zig");
const equity_json = @import("equity_json.zig");
const equity_jobs = @import("equity_jobs.zig");
const categories_json = @import("categories_json.zig");
const locks_json = @import("locks_json.zig");
const node_lock = poker_engine.solve.node_lock;

const TrainTask = struct {
    state: *HostState,
    request_id: []u8,
    job_id: ?[]u8,
    op: []u8,
    iterations: i32,
    accuracy: f64,
    time_limit: f64,
    eval_every: i32,
};

pub const HostState = struct {
    allocator: std.mem.Allocator,
    session: poker_app.Session,
    budget: workers.WorkerBudget,
    launch_id: []u8 = &.{},
    pending: std.ArrayList([]u8),
    pending_mu: std.Thread.Mutex = .{},
    cancelled_jobs: std.StringHashMap(void),
    cancelled_mu: std.Thread.Mutex = .{},
    /// Serialize stdout frames from stdin loop + train worker (R10).
    stdout_mu: std.Thread.Mutex = .{},
    train_thread: ?std.Thread = null,
    train_running: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),
    /// Active train job id (owned); null when idle.
    active_job_id: ?[]u8 = null,
    job_mu: std.Thread.Mutex = .{},
    status_generation: u64 = 1,
    last_cancelled: bool = false,
    /// Standalone Equity calculator jobs (ZR-84); independent of Study Session.
    equity_jobs: equity_jobs.Manager,

    pub fn init(allocator: std.mem.Allocator, launch_id: []const u8) !HostState {
        return .{
            .allocator = allocator,
            .session = poker_app.Session.init(allocator),
            .budget = workers.WorkerBudget.initFromCpus(),
            .launch_id = try allocator.dupe(u8, launch_id),
            .pending = std.ArrayList([]u8).init(allocator),
            .cancelled_jobs = std.StringHashMap(void).init(allocator),
            .equity_jobs = equity_jobs.Manager.init(allocator),
        };
    }

    pub fn deinit(self: *HostState) void {
        self.joinTrain();
        self.equity_jobs.deinit();
        self.clearPending();
        self.session.deinit();
        if (self.launch_id.len != 0) self.allocator.free(self.launch_id);
        self.cancelled_mu.lock();
        var it = self.cancelled_jobs.keyIterator();
        while (it.next()) |key| self.allocator.free(key.*);
        self.cancelled_jobs.deinit();
        self.cancelled_mu.unlock();
        self.job_mu.lock();
        if (self.active_job_id) |jid| self.allocator.free(jid);
        self.active_job_id = null;
        self.job_mu.unlock();
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
        self.pending_mu.lock();
        defer self.pending_mu.unlock();
        for (self.pending.items) |id| self.allocator.free(id);
        self.pending.clearRetainingCapacity();
    }

    pub fn track(self: *HostState, request_id: []const u8) !void {
        const owned = try self.allocator.dupe(u8, request_id);
        errdefer self.allocator.free(owned);
        self.pending_mu.lock();
        defer self.pending_mu.unlock();
        try self.pending.append(owned);
    }

    pub fn untrack(self: *HostState, request_id: []const u8) void {
        self.pending_mu.lock();
        defer self.pending_mu.unlock();
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
        self.cancelled_mu.lock();
        defer self.cancelled_mu.unlock();
        try self.cancelled_jobs.put(owned, {});
        self.last_cancelled = true;
        self.status_generation += 1;
    }

    pub fn clearCancelled(self: *HostState, job_id: []const u8) void {
        self.cancelled_mu.lock();
        defer self.cancelled_mu.unlock();
        if (self.cancelled_jobs.fetchRemove(job_id)) |kv| {
            self.allocator.free(kv.key);
        }
    }

    pub fn isCancelled(self: *HostState, job_id: ?[]const u8) bool {
        if (job_id == null) return false;
        self.cancelled_mu.lock();
        defer self.cancelled_mu.unlock();
        return self.cancelled_jobs.contains(job_id.?);
    }

    pub fn setActiveJob(self: *HostState, job_id: ?[]const u8) !void {
        self.job_mu.lock();
        defer self.job_mu.unlock();
        if (self.active_job_id) |old| self.allocator.free(old);
        self.active_job_id = if (job_id) |j| try self.allocator.dupe(u8, j) else null;
        self.status_generation += 1;
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

/// Unescape a JSON string field (paths, etc.) — do not return raw escaped bytes (ZR-92).
fn bodyUnescapedStringField(allocator: std.mem.Allocator, body: []const u8, key: []const u8) !?[]u8 {
    const escaped = bodyStringField(body, key) orelse return null;
    return try unescapeJsonString(allocator, escaped);
}

fn unescapeJsonString(allocator: std.mem.Allocator, escaped: []const u8) ![]u8 {
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
                'r' => {
                    try raw.append('\r');
                    i += 1;
                    continue;
                },
                't' => {
                    try raw.append('\t');
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
                '/' => {
                    try raw.append('/');
                    i += 1;
                    continue;
                },
                'u' => {
                    // Decode a single \\uXXXX BMP code unit into UTF-8.
                    if (i + 5 >= escaped.len) break;
                    const hex = escaped[i + 2 .. i + 6];
                    const code = std.fmt.parseInt(u21, hex, 16) catch break;
                    var utf8_buf: [4]u8 = undefined;
                    const n = std.unicode.utf8Encode(code, &utf8_buf) catch break;
                    try raw.appendSlice(utf8_buf[0..n]);
                    i += 5;
                    continue;
                },
                else => {},
            }
        }
        try raw.append(escaped[i]);
    }
    return raw.toOwnedSlice();
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

fn bodyFloatField(body: []const u8, key: []const u8) ?f64 {
    var needle_buf: [64]u8 = undefined;
    const needle = std.fmt.bufPrint(&needle_buf, "\"{s}\":", .{key}) catch return null;
    const start = std.mem.indexOf(u8, body, needle) orelse return null;
    var i = start + needle.len;
    while (i < body.len and (body[i] == ' ' or body[i] == '\t')) : (i += 1) {}
    const from = i;
    while (i < body.len) : (i += 1) {
        const c = body[i];
        const ok = (c >= '0' and c <= '9') or c == '-' or c == '+' or c == '.' or c == 'e' or c == 'E';
        if (!ok) break;
    }
    if (from == i) return null;
    return std.fmt.parseFloat(f64, body[from..i]) catch null;
}

fn bodyArraySlice(body: []const u8, key: []const u8) ?[]const u8 {
    var needle_buf: [64]u8 = undefined;
    const needle = std.fmt.bufPrint(&needle_buf, "\"{s}\":", .{key}) catch return null;
    const start = std.mem.indexOf(u8, body, needle) orelse return null;
    var i = start + needle.len;
    while (i < body.len and (body[i] == ' ' or body[i] == '\t')) : (i += 1) {}
    if (i >= body.len or body[i] != '[') return null;
    const from = i + 1;
    var depth: i32 = 1;
    i = from;
    while (i < body.len and depth > 0) : (i += 1) {
        if (body[i] == '[') depth += 1 else if (body[i] == ']') depth -= 1;
    }
    if (depth != 0) return null;
    return body[from .. i - 1];
}

fn parseF64Array(allocator: std.mem.Allocator, text: []const u8) ![]f64 {
    var list = std.ArrayList(f64).init(allocator);
    errdefer list.deinit();
    var i: usize = 0;
    while (i < text.len) {
        while (i < text.len and (text[i] == ' ' or text[i] == '\t' or text[i] == ',' or text[i] == '\n' or text[i] == '\r')) : (i += 1) {}
        if (i >= text.len) break;
        const from = i;
        while (i < text.len and text[i] != ',' and text[i] != ' ' and text[i] != '\t' and text[i] != '\n' and text[i] != '\r') : (i += 1) {}
        const value = try std.fmt.parseFloat(f64, text[from..i]);
        try list.append(value);
    }
    return try list.toOwnedSlice();
}

fn parseUsizeArray(allocator: std.mem.Allocator, text: []const u8) ![]usize {
    var list = std.ArrayList(usize).init(allocator);
    errdefer list.deinit();
    var i: usize = 0;
    while (i < text.len) {
        while (i < text.len and (text[i] == ' ' or text[i] == '\t' or text[i] == ',' or text[i] == '\n' or text[i] == '\r')) : (i += 1) {}
        if (i >= text.len) break;
        const from = i;
        while (i < text.len and text[i] != ',' and text[i] != ' ' and text[i] != '\t' and text[i] != '\n' and text[i] != '\r') : (i += 1) {}
        const value = try std.fmt.parseInt(usize, text[from..i], 10);
        try list.append(value);
    }
    return try list.toOwnedSlice();
}

fn persistLocksText(state: *HostState, locks: *const node_lock.LockSet) !void {
    const text = try node_lock.formatLockSet(state.allocator, locks);
    defer state.allocator.free(text);
    try state.session.setLocksText(text);
}

fn replyLocksBody(state: *HostState, req: ipc.Envelope, locks: *const node_lock.LockSet) !ipc.Envelope {
    const body = locks_json.packStudyLocksBody(state.allocator, locks) catch |err| {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "locks_pack_failed", @errorName(err));
    };
    defer state.allocator.free(body);
    return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, body);
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

fn formatStatusBody(allocator: std.mem.Allocator, state: *HostState) ![]u8 {
    // Snapshot under session + job locks (ZR-90).
    state.session.mu.lock();
    const phase = state.session.phase;
    const solution_id = state.session.solution_id;
    const baseline_id = state.session.baseline_id;
    const policy_revision = state.session.policyRevision();
    const has_training = state.session.has_training;
    const can_continue = state.session.canContinue();
    const threads = state.session.threads;
    const terminal = state.session.last_terminal;
    state.session.mu.unlock();

    const train_running = state.train_running.load(.acquire);
    const running = train_running or phase == .training or phase == .compiling;
    const paused = phase == .paused and !running;

    state.job_mu.lock();
    const active = state.active_job_id;
    const gen = state.status_generation + solution_id + policy_revision;
    state.job_mu.unlock();

    var cancelled = state.last_cancelled and !running;
    if (active) |jid| {
        if (state.isCancelled(jid)) cancelled = true;
    }

    var list = std.ArrayList(u8).init(allocator);
    errdefer list.deinit();
    const w = list.writer();
    try w.writeAll("{\"running\":");
    try w.writeAll(if (running) "true" else "false");
    try w.writeAll(",\"paused\":");
    try w.writeAll(if (paused) "true" else "false");
    try w.writeAll(",\"cancelled\":");
    try w.writeAll(if (cancelled) "true" else "false");
    try w.print(",\"status_generation\":{d}", .{gen});
    if (solution_id == 0) {
        try w.writeAll(",\"solution_id\":null,\"root_node_id\":null");
    } else {
        try w.print(",\"solution_id\":\"s{d}\",\"root_node_id\":\"p0.t-1.r-1\"", .{solution_id});
    }
    if (baseline_id == 0) {
        try w.writeAll(",\"baseline_solution_id\":null");
    } else {
        try w.print(",\"baseline_solution_id\":\"s{d}\"", .{baseline_id});
    }
    if (active) |jid| {
        try w.print(",\"job_id\":\"{s}\"", .{jid});
    } else {
        try w.writeAll(",\"job_id\":null");
    }
    try w.writeAll(",\"has_training\":");
    try w.writeAll(if (has_training) "true" else "false");
    try w.writeAll(",\"can_continue\":");
    try w.writeAll(if (can_continue) "true" else "false");
    try w.print(",\"phase\":\"{s}\",\"policy_revision\":{d},\"terminal_reason\":\"{s}\",\"workers_training\":{d},\"workers_analysis\":{d},\"threads\":{d},\"transport\":\"ipc\",\"sidecar\":\"solver-engine\"}}", .{
        @tagName(phase),
        policy_revision,
        @tagName(terminal),
        threads,
        state.budget.analysis,
        threads,
    });
    return try list.toOwnedSlice();
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

    if (page.opponent_player >= 0) {
        try w.print(",\"opponent_player\":{d}", .{page.opponent_player});
        try w.writeAll(",\"opponent_combos\":");
        try appendStringArray(&list, page.opponent_combos);
        try w.writeAll(",\"opponent_reach\":");
        try appendFloatArray(&list, page.opponent_reach);
        try w.writeAll(",\"opponent_marginal\":");
        try appendFloatArray(&list, page.opponent_marginal);
    }

    try w.writeAll(",\"cards\":[");
    for (page.cards, 0..) |row, i| {
        if (i > 0) try w.writeAll(",");
        try w.writeAll("{\"card\":");
        try appendJsonString(&list, row.card);
        try w.writeAll(",\"child_id\":");
        try appendJsonString(&list, row.child_id);
        try w.print(",\"weight\":{d:.6}}}", .{row.weight});
    }
    try w.writeAll("]");

    try w.writeAll(",\"strategy\":");
    if (page.kind != .decision or n_actions == 0 or page.strategy.len == 0) {
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
    // Same JSON unescape as paths (handles Windows CRLF fixtures: `\r\n`).
    var raw = try unescapeJsonString(allocator, escaped);
    errdefer allocator.free(raw);
    if (raw.len == 0 or raw[raw.len - 1] != '\n') {
        const grown = try allocator.realloc(raw, raw.len + 1);
        grown[grown.len - 1] = '\n';
        raw = grown;
    }
    return raw;
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

    if (std.mem.eql(u8, req.op, "get_config")) {
        if (state.session.solution_id == 0 or state.session.config_text.len == 0) {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "nothing_published", "no solution config");
        }
        // Escape config text as a JSON string value.
        var list = std.ArrayList(u8).init(state.allocator);
        errdefer list.deinit();
        const w = list.writer();
        try w.writeAll("{\"street_config_text\":");
        try std.json.stringify(state.session.config_text, .{}, w);
        try w.writeAll("}");
        const body = try list.toOwnedSlice();
        defer state.allocator.free(body);
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, body);
    }

    if (std.mem.eql(u8, req.op, "cancel")) {
        if (req.job_id) |jid| {
            try state.cancelJob(jid);
            // Cooperative stop at the next iteration boundary (ZR-90).
            state.session.requestStop();
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
            const code: []const u8 = if (err == error.BudgetExceeded) "budget_exceeded" else "begin_failed";
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, code, @errorName(err));
        };
        state.last_cancelled = false;
        var buf: [64]u8 = undefined;
        const body = try std.fmt.bufPrint(&buf, "{{\"solution_id\":{d}}}", .{state.session.solution_id});
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, body);
    }

    // ZR-83: side-effect-free preview/plan — never begin_config / clearSolution.
    if (std.mem.eql(u8, req.op, "tree_preview")) {
        const escaped = bodyStringField(req.body_json, "config_text") orelse
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "config_text required");
        const config = try unescapeConfig(state.allocator, escaped);
        defer state.allocator.free(config);
        const body = poker_app.plan_preview.treePreviewJson(state.allocator, config) catch |err| {
            const code: []const u8 = if (err == error.OutOfMemory) "out_of_memory" else "invalid_config";
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, code, @errorName(err));
        };
        defer state.allocator.free(body);
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, body);
    }

    if (std.mem.eql(u8, req.op, "plan_memory")) {
        const escaped = bodyStringField(req.body_json, "config_text") orelse
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "config_text required");
        const config = try unescapeConfig(state.allocator, escaped);
        defer state.allocator.free(config);
        const body = poker_app.plan_preview.planMemoryJson(state.allocator, config) catch |err| {
            const code: []const u8 = if (err == error.OutOfMemory) "out_of_memory" else "invalid_config";
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, code, @errorName(err));
        };
        defer state.allocator.free(body);
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, body);
    }

    if (std.mem.eql(u8, req.op, "pause")) {
        state.session.pause() catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "pause_failed", @errorName(err));
        };
        state.status_generation += 1;
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, "{\"phase\":\"paused\"}");
    }

    if (std.mem.eql(u8, req.op, "save")) {
        const path = (try bodyUnescapedStringField(state.allocator, req.body_json, "path")) orelse
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "path required");
        defer state.allocator.free(path);
        state.session.save(path) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "save_failed", @errorName(err));
        };
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, "{\"saved\":true}");
    }

    if (std.mem.eql(u8, req.op, "open")) {
        const path = (try bodyUnescapedStringField(state.allocator, req.body_json, "path")) orelse
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "path required");
        defer state.allocator.free(path);
        state.session.open(path) catch |err| {
            const code: []const u8 = switch (err) {
                error.InvalidStrategy => "invalid_strategy",
                error.Busy => "busy",
                else => "open_failed",
            };
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, code, @errorName(err));
        };
        state.last_cancelled = false;
        try state.setActiveJob(null);
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
        // Reach-weighted node check-down (audit P0-2 / ZR-95): board through the
        // selected node + both players' strategy-conditioned reach.
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
        var page = poker_engine.analysis.equity.checkdownEquityAtNode(
            state.allocator,
            lease.game,
            lease.published,
            located.node_index,
            located.turn,
            located.river,
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

    // Study Categories (made-hand on five-card boards; short boards → available=false).
    if (std.mem.eql(u8, req.op, "categories")) {
        state.budget.prioritizeAnalysis(1);
        defer state.budget.returnToTraining();
        const wait_ns: u64 = 120 * std.time.ns_per_s;
        var lease = state.session.borrowPublishedWait(wait_ns) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "nothing_published", @errorName(err));
        };
        defer lease.deinit();
        const located = resolveLocatedNode(lease.game, req.body_json) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "unknown_node", @errorName(err));
        };
        const node_id_text = poker_engine.analysis.node_id.formatNodeId(
            state.allocator,
            located.node_index,
            located.turn,
            located.river,
        ) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "categories_failed", @errorName(err));
        };
        defer state.allocator.free(node_id_text);
        const t0 = std.time.nanoTimestamp();
        const report = poker_engine.analysis.categories.categoriesAtNode(
            state.allocator,
            lease.game,
            lease.published,
            located.node_index,
            located.turn,
            located.river,
        ) catch |err| {
            const code: []const u8 = switch (err) {
                error.InvalidEquity, error.InvalidCategories => "invalid_categories",
                error.InvalidWeight => "invalid_weight",
                error.WorkLimit => "work_limit",
                error.OutOfMemory => "oom",
            };
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, code, @errorName(err));
        };
        const elapsed_ns = std.time.nanoTimestamp() - t0;
        const query_seconds: f64 = @as(f64, @floatFromInt(elapsed_ns)) / 1e9;
        const body = categories_json.packStudyCategoriesBody(state.allocator, .{
            .solution_id = lease.solution_id,
            .node_id = node_id_text,
            .policy_revision = state.session.policyRevision(),
            .query_seconds = query_seconds,
            .report = &report,
        }) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "categories_pack_failed", @errorName(err));
        };
        defer state.allocator.free(body);
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, body);
    }

    // Study locks CRUD over Session.locks_text (node_lock codec).
    // resolve_locked is async (main.zig → startResolveLocked), like solve.
    if (std.mem.eql(u8, req.op, "list_locks")) {
        if (state.session.solution_id == 0) {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "nothing_published", "no solution");
        }
        var locks = locks_json.parseSessionLocks(state.allocator, state.session.locks_text) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_locks", @errorName(err));
        };
        defer locks.deinit();
        return replyLocksBody(state, req, &locks);
    }

    if (std.mem.eql(u8, req.op, "put_lock")) {
        if (state.train_running.load(.acquire) or state.session.phase == .training) {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "busy", "a solve is already running");
        }
        var lease = state.session.borrowPublished() catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "nothing_published", @errorName(err));
        };
        defer lease.deinit();

        const node_id_text = bodyStringField(req.body_json, "node_id") orelse
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "node_id required");
        const located = poker_engine.analysis.node_id.locateNode(lease.game, node_id_text) catch |err| {
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
        if (page.player < 0 or page.n_actions == 0) {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "locks apply only to decision nodes");
        }

        const kind_text = bodyStringField(req.body_json, "kind") orelse "full";
        const scope_text = bodyStringField(req.body_json, "scope") orelse "node";
        if (!std.mem.eql(u8, scope_text, "node") and !std.mem.eql(u8, scope_text, "line")) {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "scope must be node or line");
        }
        const probs_slice = bodyArraySlice(req.body_json, "probs") orelse
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "probs required");
        const probs = parseF64Array(state.allocator, probs_slice) catch {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "bad probs");
        };
        defer state.allocator.free(probs);
        if (probs.len != page.n_actions) {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "probs length must match action arity");
        }

        var lock = node_lock.NodeLock{
            .infoset_id = located.node_index,
        };
        errdefer lock.deinit(state.allocator);
        if (std.mem.eql(u8, scope_text, "line")) {
            lock.scope = .line;
            lock.turn = -1;
            lock.river = -1;
        } else {
            lock.scope = .node;
            lock.turn = @intCast(located.turn);
            lock.river = @intCast(located.river);
        }
        if (std.mem.eql(u8, kind_text, "full")) {
            lock.kind = .full_node;
        } else if (std.mem.eql(u8, kind_text, "selected")) {
            lock.kind = .selected_combos;
            const hands_slice = bodyArraySlice(req.body_json, "hand_indices") orelse "";
            const hands = parseUsizeArray(state.allocator, hands_slice) catch {
                return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "bad hand_indices");
            };
            const n_hands: usize = if (page.n_hands > 0) @intCast(page.n_hands) else page.combos.len;
            for (hands) |hand| {
                if (hand >= n_hands) {
                    state.allocator.free(hands);
                    return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "hand index out of range");
                }
            }
            // Ownership transfers to lock (and then LockSet); do not free `hands` separately.
            lock.combo_indices = hands;
        } else {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "kind must be full or selected");
        }
        lock.actions = node_lock.makeActionLockRow(state.allocator, probs, @intCast(page.n_actions)) catch {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "invalid lock row");
        };

        var locks = locks_json.parseSessionLocks(state.allocator, state.session.locks_text) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_locks", @errorName(err));
        };
        defer locks.deinit();
        locks.upsert(lock) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "locks_persist_failed", @errorName(err));
        };
        // LockSet now owns the NodeLock storage; neutralize errdefer.
        lock = .{};
        persistLocksText(state, &locks) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "locks_persist_failed", @errorName(err));
        };
        return replyLocksBody(state, req, &locks);
    }

    if (std.mem.eql(u8, req.op, "delete_lock")) {
        if (state.train_running.load(.acquire) or state.session.phase == .training) {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "busy", "a solve is already running");
        }
        if (state.session.solution_id == 0) {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "nothing_published", "no solution");
        }
        var locks = locks_json.parseSessionLocks(state.allocator, state.session.locks_text) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_locks", @errorName(err));
        };
        defer locks.deinit();

        if (bodyStringField(req.body_json, "node_id")) |node_id_text| {
            const parsed = poker_engine.analysis.node_id.parseNodeId(node_id_text) catch {
                return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "bad node_id");
            };
            const key = node_lock.makeLockKey(parsed.node_index, parsed.turn, parsed.river);
            if (bodyIntField(req.body_json, "hand_index")) |hand_i32| {
                if (hand_i32 < 0) {
                    return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "bad hand_index");
                }
                const hand_index: usize = @intCast(hand_i32);
                if (locks.findExactKey(key)) |existing| {
                    if (existing.kind == .full_node) {
                        return ipc.makeErrorReply(
                            state.allocator,
                            req.request_id,
                            req.job_id,
                            req.op,
                            "invalid_request",
                            "full-node locks unlock with node_id only; omit hand_index",
                        );
                    }
                }
                _ = locks.eraseComboKey(key, hand_index);
            } else {
                _ = locks.eraseKey(key);
            }
        } else {
            locks.clear();
        }

        persistLocksText(state, &locks) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "locks_persist_failed", @errorName(err));
        };
        return replyLocksBody(state, req, &locks);
    }

    // Standalone Equity calculator jobs (no Study session). Distinct from Study `equity`.
    if (std.mem.eql(u8, req.op, "start_equity_job")) {
        var request = equity_jobs.parseJobRequest(state.allocator, req.body_json) catch |err| {
            const code = if (err == error.InvalidInput or err == error.InvalidWeight) "invalid_request" else "equity_job_failed";
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, code, @errorName(err));
        };
        const job_id = state.equity_jobs.enqueue(request) catch |err| {
            request.deinit(state.allocator);
            const code = if (err == error.QueueFull) "busy" else "invalid_request";
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, code, @errorName(err));
        };
        // enqueue took ownership of request; job_id is owned by the manager map key.
        var buf: [96]u8 = undefined;
        const body = try std.fmt.bufPrint(&buf, "{{\"job_id\":\"{s}\",\"state\":\"queued\"}}", .{job_id});
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, body);
    }

    if (std.mem.eql(u8, req.op, "get_equity_job")) {
        const job_id = bodyStringField(req.body_json, "job_id") orelse
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "job_id required");
        const status = try state.equity_jobs.statusJson(state.allocator, job_id);
        if (status == null) {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "unknown_job", "equity job not found");
        }
        defer state.allocator.free(status.?);
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, status.?);
    }

    if (std.mem.eql(u8, req.op, "cancel_equity_job")) {
        const job_id = bodyStringField(req.body_json, "job_id") orelse
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "job_id required");
        if (!state.equity_jobs.cancel(job_id)) {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "unknown_job", "equity job not found");
        }
        const status = try state.equity_jobs.statusJson(state.allocator, job_id);
        if (status == null) {
            return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, "{\"cancelled\":true}");
        }
        defer state.allocator.free(status.?);
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, status.?);
    }

    return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "unknown_op", req.op);
}

fn trainWorker(task: *TrainTask) void {
    const state = task.state;
    defer {
        state.untrack(task.request_id);
        state.train_running.store(false, .release);
        state.status_generation += 1;
        state.allocator.free(task.request_id);
        if (task.job_id) |j| {
            // Allow a fresh job id after stop; sticky cancel only while in-flight.
            state.clearCancelled(j);
            state.allocator.free(j);
        }
        state.allocator.free(task.op);
        state.allocator.destroy(task);
    }

    const use_gated = task.accuracy > 0 or task.time_limit >= 0;
    const train_result = if (use_gated)
        state.session.trainGated(task.iterations, task.accuracy, task.eval_every, task.time_limit)
    else
        state.session.train(task.iterations);

    var reply: ipc.Envelope = undefined;
    if (train_result) |_| {
        var buf: [320]u8 = undefined;
        const trained: i32 = if (state.session.published) |p| p.trained else 0;
        const body = std.fmt.bufPrint(&buf, "{{\"solution_id\":{d},\"policy_revision\":{d},\"trained\":{d},\"terminal_reason\":\"{s}\",\"async\":true,\"threads\":{d}}}", .{
            state.session.solution_id,
            state.session.policyRevision(),
            trained,
            @tagName(state.session.last_terminal),
            state.session.threads,
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

fn admitTrainJob(state: *HostState, req: ipc.Envelope) !enum { ok, replied } {
    // Stale cancelled id: reject only while that cancel is still sticky mid-flight.
    // After a worker finishes it clears the id so a fresh mint can reuse names.
    if (state.isCancelled(req.job_id) and state.train_running.load(.acquire)) {
        var err_reply = try ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "cancelled", "job cancelled");
        defer err_reply.deinit();
        try state.writeReply(err_reply);
        return .replied;
    }
    if (req.job_id) |jid| state.clearCancelled(jid);

    if (state.session.phase == .idle) {
        var err_reply = try ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_session", "call begin_config before solve");
        defer err_reply.deinit();
        try state.writeReply(err_reply);
        return .replied;
    }

    if (!state.session.has_training) {
        var err_reply = try ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "cannot_continue", "browse-only solution has no trainer state");
        defer err_reply.deinit();
        try state.writeReply(err_reply);
        return .replied;
    }

    if (state.train_running.load(.acquire)) {
        var err_reply = try ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "busy", "train already running");
        defer err_reply.deinit();
        try state.writeReply(err_reply);
        return .replied;
    }
    // Reap a finished worker before starting another.
    state.joinTrain();
    return .ok;
}

fn spawnTrainWorker(state: *HostState, req: ipc.Envelope) !void {
    const iterations = bodyIntField(req.body_json, "iterations") orelse 1;
    const accuracy = bodyFloatField(req.body_json, "accuracy") orelse 0;
    const time_limit = bodyFloatField(req.body_json, "time_limit") orelse -1;
    // C++ resolve-locked `samples` mapped to eval chunking; honor as eval_every when set.
    const samples = bodyIntField(req.body_json, "samples");
    const eval_every = bodyIntField(req.body_json, "eval_every") orelse (samples orelse 20);
    state.budget.returnToTraining();
    // Honor config threads; never raise above Session/config (ZR-91). Cap by host budget.
    if (state.budget.training > 0 and state.session.threads > state.budget.training) {
        state.session.setThreads(state.budget.training);
    }
    state.session.clearControlFlags();
    state.last_cancelled = false;
    try state.setActiveJob(req.job_id);

    const task = try state.allocator.create(TrainTask);
    errdefer state.allocator.destroy(task);
    task.* = .{
        .state = state,
        .request_id = try state.allocator.dupe(u8, req.request_id),
        .job_id = if (req.job_id) |j| try state.allocator.dupe(u8, j) else null,
        .op = try state.allocator.dupe(u8, req.op),
        .iterations = iterations,
        .accuracy = accuracy,
        .time_limit = time_limit,
        .eval_every = eval_every,
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

/// Spawn background CFR+ train so the stdin loop can serve `values` mid-train (R10).
/// Does not write a sync reply; the worker emits the solve reply when finished.
pub fn startSolve(state: *HostState, req: ipc.Envelope) !void {
    try state.track(req.request_id);
    errdefer state.untrack(req.request_id);

    switch (try admitTrainJob(state, req)) {
        .replied => {
            state.untrack(req.request_id);
            return;
        },
        .ok => {},
    }
    try spawnTrainWorker(state, req);
}

/// Study Resolve Locked: stamp baseline, mint new solution id, optional reset, then train under locks.
pub fn startResolveLocked(state: *HostState, req: ipc.Envelope) !void {
    try state.track(req.request_id);
    errdefer state.untrack(req.request_id);

    switch (try admitTrainJob(state, req)) {
        .replied => {
            state.untrack(req.request_id);
            return;
        },
        .ok => {},
    }

    const warm_start = (bodyIntField(req.body_json, "warm_start") orelse 0) != 0;
    state.session.prepareResolveLocked(warm_start) catch |err| {
        const code: []const u8 = switch (err) {
            error.Busy => "busy",
            error.NothingPublished => "nothing_published",
            error.InvalidSession => "cannot_continue",
            else => "resolve_locked_failed",
        };
        var err_reply = try ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, code, @errorName(err));
        defer err_reply.deinit();
        state.untrack(req.request_id);
        try state.writeReply(err_reply);
        return;
    };

    try spawnTrainWorker(state, req);
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
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"reach_defined\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"children\":[") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"reach\":[") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"marginal\":[") != null);
    // Root river with bets usually has strategy rows; either 2D array or null (check-only).
    try std.testing.expect(
        std.mem.indexOf(u8, reply.body_json, "\"strategy\":[") != null or
            std.mem.indexOf(u8, reply.body_json, "\"strategy\":null") != null,
    );

    // First action child must be a navigable Study id (path nav / ActionNavBar).
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"children\":[\"p") != null);

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

test "node chance after check-check returns cards for river deal" {
    // Empty size fields (no trailing space) → check-only turn line → river chance.
    const config =
        \\street-config 1
        \\board Ah Kh Qh Jh
        \\pot 100
        \\stack 200
        \\oop-range AsQs:1
        \\ip-range 2d2h:1
        \\oop-bets
        \\ip-bets
        \\oop-raises
        \\ip-raises
        \\oop-river-bets 0.5
        \\ip-river-bets 0.5
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
    var state = try HostState.init(std.testing.allocator, "node-chance");
    defer state.deinit();
    try state.session.begin(config);
    try state.session.train(1);

    var root_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "nr"),
        .op = try std.testing.allocator.dupe(u8, "node"),
        .body_json = try std.testing.allocator.dupe(u8, "{\"node_id\":\"p0.t-1.r-1\"}"),
    };
    defer root_req.deinit();
    var root_reply = try handle(&state, root_req);
    defer root_reply.deinit();
    try std.testing.expect(root_reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, root_reply.body_json, "\"reach_defined\":true") != null);
    // Empty bet arrays → check-only root; child after Check should exist.
    try std.testing.expect(std.mem.indexOf(u8, root_reply.body_json, "\"children\":[\"p") != null);

    // Locate the chance node id from children[0] of the IP check response path:
    // p0 Check → p1 (IP) Check → chance. Fetch p1 then its check child.
    const p1_start = std.mem.indexOf(u8, root_reply.body_json, "\"children\":[\"") orelse return error.TestUnexpectedResult;
    const p1_id_start = p1_start + "\"children\":[\"".len;
    const p1_id_end = std.mem.indexOfPos(u8, root_reply.body_json, p1_id_start, "\"") orelse return error.TestUnexpectedResult;
    const p1_id = root_reply.body_json[p1_id_start..p1_id_end];

    var p1_body = std.ArrayList(u8).init(std.testing.allocator);
    defer p1_body.deinit();
    try p1_body.writer().print("{{\"node_id\":\"{s}\"}}", .{p1_id});
    var p1_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "np1"),
        .op = try std.testing.allocator.dupe(u8, "node"),
        .body_json = try p1_body.toOwnedSlice(),
    };
    defer p1_req.deinit();
    var p1_reply = try handle(&state, p1_req);
    defer p1_reply.deinit();
    try std.testing.expect(p1_reply.ok);

    const ch_start = std.mem.indexOf(u8, p1_reply.body_json, "\"children\":[\"") orelse return error.TestUnexpectedResult;
    const ch_id_start = ch_start + "\"children\":[\"".len;
    const ch_id_end = std.mem.indexOfPos(u8, p1_reply.body_json, ch_id_start, "\"") orelse return error.TestUnexpectedResult;
    const chance_id = p1_reply.body_json[ch_id_start..ch_id_end];

    var ch_body = std.ArrayList(u8).init(std.testing.allocator);
    defer ch_body.deinit();
    try ch_body.writer().print("{{\"node_id\":\"{s}\"}}", .{chance_id});
    var ch_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "nch"),
        .op = try std.testing.allocator.dupe(u8, "node"),
        .body_json = try ch_body.toOwnedSlice(),
    };
    defer ch_req.deinit();
    var ch_reply = try handle(&state, ch_req);
    defer ch_reply.deinit();
    try std.testing.expect(ch_reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, ch_reply.body_json, "\"kind\":\"chance\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, ch_reply.body_json, "\"cards\":[") != null);
    try std.testing.expect(std.mem.indexOf(u8, ch_reply.body_json, "\"child_id\":\"p") != null);
    try std.testing.expect(std.mem.indexOf(u8, ch_reply.body_json, "\"reach_defined\":true") != null);
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
    try std.testing.expect(state.session.has_training);
    try std.testing.expect(state.session.training != null);

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
    // JSON-escape the path — raw `{s}` breaks on Windows (`\t` in `\tmp`).
    const path_json = try std.fmt.allocPrint(std.testing.allocator, "{s}", .{std.json.fmt(tmp_path, .{})});
    defer std.testing.allocator.free(path_json);
    var save_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "s1"),
        .op = try std.testing.allocator.dupe(u8, "save"),
        .body_json = try std.fmt.allocPrint(std.testing.allocator, "{{\"path\":{s}}}", .{path_json}),
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
        .body_json = try std.fmt.allocPrint(std.testing.allocator, "{{\"path\":{s}}}", .{path_json}),
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
    try std.testing.expect(std.mem.indexOf(u8, open_reply.body_json, "\"cancelled\":") != null);
    try std.testing.expect(std.mem.indexOf(u8, open_reply.body_json, "\"can_continue\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, open_reply.body_json, "\"has_training\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, open_reply.body_json, "\"status_generation\":") != null);
    try std.testing.expect(std.mem.indexOf(u8, open_reply.body_json, "\"solution_id\":\"s") != null);
}

test "tree_preview and plan_memory leave begun session unchanged" {
    const config =
        \\street-config 1
        \\board Ah Kd 7c
        \\pot 100
        \\stack 100
        \\oop-range AcAd:1
        \\ip-range 2c3d:1
        \\first-to-act 0
        \\max-raises 0
        \\allow-all-in 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 64
        \\threads 1
        \\
    ;
    var state = try HostState.init(std.testing.allocator, "preview");
    defer state.deinit();
    try state.session.begin(config);
    const prior_id = state.session.solution_id;
    const prior_phase = state.session.phase;

    var preview_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "tp1"),
        .op = try std.testing.allocator.dupe(u8, "tree_preview"),
        .body_json = try std.fmt.allocPrint(std.testing.allocator, "{{\"config_text\":{s}}}", .{std.json.fmt(config, .{})}),
    };
    defer preview_req.deinit();
    var preview_reply = try handle(&state, preview_req);
    defer preview_reply.deinit();
    try std.testing.expect(preview_reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, preview_reply.body_json, "\"nodes\":[") != null);
    try std.testing.expect(std.mem.indexOf(u8, preview_reply.body_json, "\"path\":\"\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, preview_reply.body_json, "\"compact\":\"c\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, preview_reply.body_json, "\"plan\":{") != null);
    try std.testing.expect(std.mem.indexOf(u8, preview_reply.body_json, "\"dry_run\":true") != null);
    try std.testing.expectEqual(prior_id, state.session.solution_id);
    try std.testing.expectEqual(prior_phase, state.session.phase);

    var plan_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "pm1"),
        .op = try std.testing.allocator.dupe(u8, "plan_memory"),
        .body_json = try std.fmt.allocPrint(std.testing.allocator, "{{\"config_text\":{s}}}", .{std.json.fmt(config, .{})}),
    };
    defer plan_req.deinit();
    var plan_reply = try handle(&state, plan_req);
    defer plan_reply.deinit();
    try std.testing.expect(plan_reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, plan_reply.body_json, "\"estimated_peak_bytes\":") != null);
    try std.testing.expect(std.mem.indexOf(u8, plan_reply.body_json, "\"fits_budget\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, plan_reply.body_json, "\"decision_nodes\":6") != null);
    // Nested plan on tree_preview matches standalone plan_memory numbers.
    try std.testing.expect(std.mem.indexOf(u8, preview_reply.body_json, plan_reply.body_json) != null);
    try std.testing.expectEqual(prior_id, state.session.solution_id);
    try std.testing.expectEqual(prior_phase, state.session.phase);

    var missing: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "tp-miss"),
        .op = try std.testing.allocator.dupe(u8, "tree_preview"),
        .body_json = try std.testing.allocator.dupe(u8, "{}"),
    };
    defer missing.deinit();
    var missing_reply = try handle(&state, missing);
    defer missing_reply.deinit();
    try std.testing.expect(!missing_reply.ok);
    try std.testing.expect(std.mem.eql(u8, missing_reply.error_code orelse "", "invalid_request"));

    var bad: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "tp-bad"),
        .op = try std.testing.allocator.dupe(u8, "tree_preview"),
        .body_json = try std.testing.allocator.dupe(u8, "{\"config_text\":\"not-a-config\\n\"}"),
    };
    defer bad.deinit();
    var bad_reply = try handle(&state, bad);
    defer bad_reply.deinit();
    try std.testing.expect(!bad_reply.ok);
    try std.testing.expect(std.mem.eql(u8, bad_reply.error_code orelse "", "invalid_config"));
    try std.testing.expectEqual(prior_id, state.session.solution_id);
}

test "begin_config rejects 1 MiB flop resource fixture" {
    const config_raw = try std.fs.cwd().readFileAlloc(
        std.testing.allocator,
        "benchmarks/study/configs/smoke_resource_flop.txt",
        64 * 1024,
    );
    defer std.testing.allocator.free(config_raw);
    // Normalize CRLF checkouts so JSON round-trip matches Linux fixtures.
    var config_buf = std.ArrayList(u8).init(std.testing.allocator);
    defer config_buf.deinit();
    for (config_raw) |c| {
        if (c != '\r') try config_buf.append(c);
    }
    if (config_buf.items.len == 0 or config_buf.items[config_buf.items.len - 1] != '\n') {
        try config_buf.append('\n');
    }
    const config = config_buf.items;
    var state = try HostState.init(std.testing.allocator, "budget");
    defer state.deinit();
    var req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "b1"),
        .op = try std.testing.allocator.dupe(u8, "begin_config"),
        .body_json = try std.fmt.allocPrint(std.testing.allocator, "{{\"config_text\":{s}}}", .{std.json.fmt(config, .{})}),
    };
    defer req.deinit();
    var reply = try handle(&state, req);
    defer reply.deinit();
    if (reply.ok or !std.mem.eql(u8, reply.error_code orelse "", "budget_exceeded")) {
        std.debug.print("budget test reply ok={any} code={s} msg={s}\n", .{
            reply.ok,
            reply.error_code orelse "",
            reply.error_message orelse "",
        });
    }
    try std.testing.expect(!reply.ok);
    try std.testing.expect(std.mem.eql(u8, reply.error_code orelse "", "budget_exceeded"));
}

test "equity at non-root decision uses reach-weighted node board" {
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
    var state = try HostState.init(std.testing.allocator, "equity-node");
    defer state.deinit();
    try state.session.begin(config);
    try state.session.train(1);

    var req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "eq-node"),
        .op = try std.testing.allocator.dupe(u8, "equity"),
        .body_json = try std.testing.allocator.dupe(u8, "{\"node_id\":\"p1.t-1.r-1\"}"),
    };
    defer req.deinit();
    var reply = try handle(&state, req);
    defer reply.deinit();
    try std.testing.expect(reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"kind\":\"equity\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"node_id\":\"p1.t-1.r-1\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"defined\":true") != null);
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

test "locks list put delete Study CRUD" {
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
    var state = try HostState.init(std.testing.allocator, "locks-crud");
    defer state.deinit();
    try state.session.begin(config);
    try state.session.train(1);

    var list_empty: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "l0"),
        .op = try std.testing.allocator.dupe(u8, "list_locks"),
        .body_json = try std.testing.allocator.dupe(u8, "null"),
    };
    defer list_empty.deinit();
    var empty_reply = try handle(&state, list_empty);
    defer empty_reply.deinit();
    try std.testing.expect(empty_reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, empty_reply.body_json, "\"locks\":[]") != null);

    var put_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "l1"),
        .op = try std.testing.allocator.dupe(u8, "put_lock"),
        .body_json = try std.testing.allocator.dupe(u8, "{\"node_id\":\"p0.t-1.r-1\",\"kind\":\"full\",\"scope\":\"node\",\"probs\":[0.4,0.6]}"),
    };
    defer put_req.deinit();
    var put_reply = try handle(&state, put_req);
    defer put_reply.deinit();
    try std.testing.expect(put_reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, put_reply.body_json, "\"node_id\":\"p0.t-1.r-1\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, put_reply.body_json, "\"kind\":\"full\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, put_reply.body_json, "\"scope\":\"node\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, put_reply.body_json, "0.4") != null);
    try std.testing.expect(state.session.locks_text.len > 0);

    var list_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "l2"),
        .op = try std.testing.allocator.dupe(u8, "list_locks"),
        .body_json = try std.testing.allocator.dupe(u8, "null"),
    };
    defer list_req.deinit();
    var list_reply = try handle(&state, list_req);
    defer list_reply.deinit();
    try std.testing.expect(list_reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, list_reply.body_json, "\"locks\":[{") != null);

    var del_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "l3"),
        .op = try std.testing.allocator.dupe(u8, "delete_lock"),
        .body_json = try std.testing.allocator.dupe(u8, "{\"node_id\":\"p0.t-1.r-1\"}"),
    };
    defer del_req.deinit();
    var del_reply = try handle(&state, del_req);
    defer del_reply.deinit();
    try std.testing.expect(del_reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, del_reply.body_json, "\"locks\":[]") != null);
}

test "resolve_locked stamps baseline, mints solution id, trains under lock" {
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
    var state = try HostState.init(std.testing.allocator, "resolve-locked");
    defer state.deinit();
    try state.session.begin(config);
    try state.session.train(2);
    const prior_id = state.session.solution_id;
    const prior_trained = state.session.training.?.trained;

    var put_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "rl-put"),
        .op = try std.testing.allocator.dupe(u8, "put_lock"),
        .body_json = try std.testing.allocator.dupe(u8, "{\"node_id\":\"p0.t-1.r-1\",\"kind\":\"full\",\"scope\":\"node\",\"probs\":[1,0]}"),
    };
    defer put_req.deinit();
    var put_reply = try handle(&state, put_req);
    defer put_reply.deinit();
    try std.testing.expect(put_reply.ok);

    // startResolveLocked writes via writeReply (stdout); exercise Session prepare
    // + train directly for the reset path, then verify status baseline encoding.
    try state.session.prepareResolveLocked(false);
    try std.testing.expect(state.session.baseline_id == prior_id);
    try std.testing.expect(state.session.solution_id != prior_id);
    try std.testing.expect(state.session.training.?.trained == 0);
    try std.testing.expect(prior_trained >= 2);
    try state.session.train(2);
    try std.testing.expect(state.session.training.?.trained >= 2);
    try std.testing.expect(state.session.phase == .published);

    const status_body = try formatStatusBody(std.testing.allocator, &state);
    defer std.testing.allocator.free(status_body);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"baseline_solution_id\":\"s") != null);
    var baseline_buf: [32]u8 = undefined;
    const baseline_needle = try std.fmt.bufPrint(&baseline_buf, "\"baseline_solution_id\":\"s{d}\"", .{prior_id});
    try std.testing.expect(std.mem.indexOf(u8, status_body, baseline_needle) != null);

    // Warm-start path keeps iteration count and still bumps id once.
    const mid_id = state.session.solution_id;
    const mid_trained = state.session.training.?.trained;
    try state.session.prepareResolveLocked(true);
    try std.testing.expect(state.session.baseline_id == prior_id);
    try std.testing.expect(state.session.solution_id != mid_id);
    try std.testing.expect(state.session.training.?.trained == mid_trained);
}

test "equity calculator jobs start get complete without session" {
    var state = try HostState.init(std.testing.allocator, "eq-jobs");
    defer state.deinit();

    const body =
        \\{"version":1,"client_revision":"r-test","method":"exact","target_samples":1000,"seed":1,"board":["2c","3d","7h","9s","Jc"],"dead_cards":[],"players":[{"id":"p1","range":"AsAd"},{"id":"p2","range":"KcKd"}]}
    ;
    var start_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "eq-start"),
        .op = try std.testing.allocator.dupe(u8, "start_equity_job"),
        .body_json = try std.testing.allocator.dupe(u8, body),
    };
    defer start_req.deinit();
    var start_reply = try handle(&state, start_req);
    defer start_reply.deinit();
    try std.testing.expect(start_reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, start_reply.body_json, "\"job_id\":\"eq1\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, start_reply.body_json, "\"state\":\"queued\"") != null);

    var completed = false;
    var attempt: usize = 0;
    while (attempt < 200) : (attempt += 1) {
        std.Thread.sleep(5 * std.time.ns_per_ms);
        var get_req: ipc.Envelope = .{
            .allocator = std.testing.allocator,
            .kind = .request,
            .request_id = try std.testing.allocator.dupe(u8, "eq-get"),
            .op = try std.testing.allocator.dupe(u8, "get_equity_job"),
            .body_json = try std.testing.allocator.dupe(u8, "{\"job_id\":\"eq1\"}"),
        };
        defer get_req.deinit();
        var get_reply = try handle(&state, get_req);
        defer get_reply.deinit();
        try std.testing.expect(get_reply.ok);
        if (std.mem.indexOf(u8, get_reply.body_json, "\"state\":\"completed\"") != null) {
            try std.testing.expect(std.mem.indexOf(u8, get_reply.body_json, "\"result\":") != null);
            try std.testing.expect(std.mem.indexOf(u8, get_reply.body_json, "\"model\":\"check-down\"") != null);
            try std.testing.expect(std.mem.indexOf(u8, get_reply.body_json, "\"joint_defined\":true") != null);
            completed = true;
            break;
        }
        if (std.mem.indexOf(u8, get_reply.body_json, "\"state\":\"failed\"") != null) {
            std.debug.print("equity job failed: {s}\n", .{get_reply.body_json});
            try std.testing.expect(false);
        }
    }
    try std.testing.expect(completed);
}

test "categories dispatch river made-hand Study shape" {
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
    var state = try HostState.init(std.testing.allocator, "categories-smoke");
    defer state.deinit();
    try state.session.begin(text);
    try state.session.train(1);

    var req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "r-cat"),
        .op = try std.testing.allocator.dupe(u8, "categories"),
        .body_json = try std.testing.allocator.dupe(u8, "{\"node_id\":\"p0.t-1.r-1\"}"),
    };
    defer req.deinit();
    var reply = try handle(&state, req);
    defer reply.deinit();
    try std.testing.expect(reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"kind\":\"categories\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"model\":\"made-hand\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"available\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"exclusive\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"node_id\":\"p0.t-1.r-1\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"oop\":") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"ip\":") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"categories\":[") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "four of a kind") != null);
}
