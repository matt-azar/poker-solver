//! Map IPC ops onto the app Session. Cancel fails pending jobs (D1).
const std = @import("std");
const poker_app = @import("poker_app");
const poker_engine = @import("poker_engine");
const ipc = @import("ipc.zig");
const workers = @import("workers.zig");

pub const HostState = struct {
    allocator: std.mem.Allocator,
    session: poker_app.Session,
    budget: workers.WorkerBudget,
    launch_id: []u8 = &.{},
    pending: std.ArrayList([]u8),
    cancelled_jobs: std.StringHashMap(void),

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
        self.clearPending();
        self.session.deinit();
        if (self.launch_id.len != 0) self.allocator.free(self.launch_id);
        var it = self.cancelled_jobs.keyIterator();
        while (it.next()) |key| self.allocator.free(key.*);
        self.cancelled_jobs.deinit();
        self.pending.deinit();
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
        const running = state.session.phase == .training or state.session.phase == .compiling;
        const paused = state.session.phase == .paused;
        var buf: [512]u8 = undefined;
        const body = if (state.session.solution_id == 0)
            try std.fmt.bufPrint(&buf, "{{\"running\":{},\"paused\":{},\"cancelled\":false,\"status_generation\":{d},\"solution_id\":null,\"job_id\":null,\"root_node_id\":null,\"phase\":\"{s}\",\"policy_revision\":{d},\"workers_training\":{d},\"workers_analysis\":{d},\"transport\":\"ipc\",\"sidecar\":\"solver-engine\"}}", .{
                running,
                paused,
                state.session.solution_id + state.session.policyRevision(),
                @tagName(state.session.phase),
                state.session.policyRevision(),
                state.budget.training,
                state.budget.analysis,
            })
        else
            try std.fmt.bufPrint(&buf, "{{\"running\":{},\"paused\":{},\"cancelled\":false,\"status_generation\":{d},\"solution_id\":\"s{d}\",\"job_id\":null,\"root_node_id\":\"p0\",\"phase\":\"{s}\",\"policy_revision\":{d},\"workers_training\":{d},\"workers_analysis\":{d},\"transport\":\"ipc\",\"sidecar\":\"solver-engine\"}}", .{
                running,
                paused,
                state.session.solution_id + state.session.policyRevision(),
                state.session.solution_id,
                @tagName(state.session.phase),
                state.session.policyRevision(),
                state.budget.training,
                state.budget.analysis,
            });
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

    if (std.mem.eql(u8, req.op, "solve")) {
        if (state.session.phase == .idle) {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_session", "call begin_config before solve");
        }
        const iterations = bodyIntField(req.body_json, "iterations") orelse 1;
        state.budget.returnToTraining();
        // D3: train uses the shared training worker budget (manual config may already set Session.threads).
        if (state.budget.training > 0) {
            state.session.setThreads(state.budget.training);
        }
        state.session.train(iterations) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "solve_failed", @errorName(err));
        };
        var buf: [160]u8 = undefined;
        const body = try std.fmt.bufPrint(&buf, "{{\"solution_id\":{d},\"policy_revision\":{d},\"trained\":{d}}}", .{
            state.session.solution_id,
            state.session.policyRevision(),
            if (state.session.published) |p| p.trained else 0,
        });
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
        var buf: [128]u8 = undefined;
        const body = try std.fmt.bufPrint(&buf, "{{\"solution_id\":{d},\"policy_revision\":{d}}}", .{
            state.session.solution_id,
            state.session.policyRevision(),
        });
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, body);
    }

    if (std.mem.eql(u8, req.op, "node")) {
        state.budget.prioritizeAnalysis(1);
        defer state.budget.returnToTraining();
        const game = state.session.game orelse
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "nothing_published", "no game");
        const published = state.session.published orelse
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "nothing_published", "no published policy");
        const node_index: u32 = @intCast(bodyIntField(req.body_json, "node_index") orelse 0);
        var page = poker_engine.analysis.inspect.inspectNode(state.allocator, game, published, node_index, -1, -1) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "inspect_failed", @errorName(err));
        };
        defer page.deinit();
        var buf: [192]u8 = undefined;
        const body = try std.fmt.bufPrint(&buf, "{{\"node_index\":{d},\"player\":{d},\"n_actions\":{d},\"n_hands\":{d},\"policy_revision\":{d}}}", .{
            page.node_index,
            page.player,
            page.n_actions,
            page.n_hands,
            page.policy_revision,
        });
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, body);
    }

    if (std.mem.eql(u8, req.op, "values")) {
        state.budget.prioritizeAnalysis(1);
        defer state.budget.returnToTraining();
        const game = state.session.game orelse
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "nothing_published", "no game");
        const published = state.session.published orelse
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "nothing_published", "no published policy");
        const node_index: u32 = @intCast(bodyIntField(req.body_json, "node_index") orelse 0);
        const t0 = std.time.nanoTimestamp();
        var page = poker_engine.analysis.action_ev.actionValues(state.allocator, game, published, node_index, -1, -1) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "values_failed", @errorName(err));
        };
        defer page.deinit();
        const elapsed_ns = std.time.nanoTimestamp() - t0;
        const elapsed_ms = @divTrunc(elapsed_ns, 1_000_000);
        // Summary page for Study latency (full hand×action tables are a follow-on).
        // Root uses frozen response_walk; see action_ev.actionValues.
        var buf: [448]u8 = undefined;
        const body = try std.fmt.bufPrint(&buf, "{{\"node_index\":{d},\"player\":{d},\"policy_revision\":{d},\"units\":\"chips\",\"utility_basis\":\"root_centered\",\"local_offset\":{d:.6},\"node_ev_defined\":{},\"node_ev\":{d:.6},\"n_hands\":{d},\"n_actions\":{d},\"elapsed_ms\":{d},\"solution_id\":\"s{d}\",\"engine\":\"frozen_response_walk\"}}", .{
            page.node_index,
            page.player,
            page.policy_revision,
            page.local_offset,
            page.node_ev_defined,
            page.node_ev,
            page.combos.len,
            page.actions.len,
            elapsed_ms,
            state.session.solution_id,
        });
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, body);
    }

    if (std.mem.eql(u8, req.op, "prioritize_analysis")) {
        const want: u32 = @intCast(@max(bodyIntField(req.body_json, "workers") orelse 1, 0));
        state.budget.prioritizeAnalysis(want);
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, "{\"ok\":true}");
    }

    return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "unknown_op", req.op);
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
