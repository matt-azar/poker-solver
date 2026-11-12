//! Session-independent Equity calculator jobs for solver-engine IPC (ZR-84).
//! Mirrors legacy explorer `/api/equity/jobs` lifecycle; does not touch Study Session.
const std = @import("std");
const poker_engine = @import("poker_engine");
const card = poker_engine.poker.card;
const range_mod = poker_engine.poker.range;
const calc = poker_engine.analysis.equity_calculator;

pub const max_queued_jobs: usize = 4;
pub const max_retained_jobs: usize = 32;

pub const JobState = enum {
    queued,
    preparing,
    running,
    stopping,
    completed,
    stopped,
    cancelled,
    failed,

    pub fn name(self: JobState) []const u8 {
        return @tagName(self);
    }
};

pub const PlayerSpec = struct {
    id: []u8,
    range_text: []u8,
};

pub const JobRequest = struct {
    version: i32 = 1,
    client_revision: []u8 = &.{},
    players: []PlayerSpec = &.{},
    board: []card.Card = &.{},
    dead_cards: []card.Card = &.{},
    options: calc.Options = .{},

    pub fn deinit(self: *JobRequest, allocator: std.mem.Allocator) void {
        if (self.client_revision.len != 0) allocator.free(self.client_revision);
        for (self.players) |*p| {
            if (p.id.len != 0) allocator.free(p.id);
            if (p.range_text.len != 0) allocator.free(p.range_text);
        }
        if (self.players.len != 0) allocator.free(self.players);
        if (self.board.len != 0) allocator.free(self.board);
        if (self.dead_cards.len != 0) allocator.free(self.dead_cards);
        self.* = .{};
    }
};

pub const Snapshot = struct {
    id: []u8 = &.{},
    state: JobState = .queued,
    request: JobRequest = .{},
    result: ?calc.Result = null,
    error_message: []u8 = &.{},
    error_kind: []u8 = &.{},
    progress_done: u64 = 0,
    progress_total: u64 = 0,
    elapsed_seconds: f64 = 0,

    pub fn deinit(self: *Snapshot, allocator: std.mem.Allocator) void {
        if (self.id.len != 0) allocator.free(self.id);
        self.request.deinit(allocator);
        if (self.result) |*r| r.deinit();
        if (self.error_message.len != 0) allocator.free(self.error_message);
        if (self.error_kind.len != 0) allocator.free(self.error_kind);
        self.* = .{};
    }
};

pub const Manager = struct {
    allocator: std.mem.Allocator,
    mu: std.Thread.Mutex = .{},
    cv: std.Thread.Condition = .{},
    thread: ?std.Thread = null,
    started: bool = false,
    stop: bool = false,
    next_id: u64 = 1,
    queue: std.ArrayList([]const u8),
    jobs: std.StringHashMap(Snapshot),
    current_id: []const u8 = "",
    cancel_current: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),

    pub fn init(allocator: std.mem.Allocator) Manager {
        return .{
            .allocator = allocator,
            .queue = std.ArrayList([]const u8).init(allocator),
            .jobs = std.StringHashMap(Snapshot).init(allocator),
        };
    }

    pub fn deinit(self: *Manager) void {
        self.shutdown();
        self.mu.lock();
        defer self.mu.unlock();
        var it = self.jobs.iterator();
        while (it.next()) |entry| {
            entry.value_ptr.deinit(self.allocator);
            // HashMap keys are owned separately from Snapshot.id.
            self.allocator.free(entry.key_ptr.*);
        }
        self.jobs.deinit();
        self.queue.clearRetainingCapacity();
        self.queue.deinit();
    }

    fn ensureStartedLocked(self: *Manager) !void {
        if (self.started) return;
        self.started = true;
        self.stop = false;
        self.thread = try std.Thread.spawn(.{}, threadMain, .{self});
    }

    fn pruneLocked(self: *Manager) void {
        while (self.jobs.count() > max_retained_jobs) {
            var oldest: ?[]const u8 = null;
            var it = self.jobs.iterator();
            while (it.next()) |entry| {
                if (std.mem.eql(u8, entry.key_ptr.*, self.current_id)) continue;
                switch (entry.value_ptr.state) {
                    .queued, .preparing, .running, .stopping => continue,
                    else => {
                        oldest = entry.key_ptr.*;
                        break;
                    },
                }
            }
            if (oldest == null) break;
            if (self.jobs.fetchRemove(oldest.?)) |kv| {
                var snap = kv.value;
                snap.deinit(self.allocator);
                self.allocator.free(kv.key);
            }
        }
    }

    pub fn enqueue(self: *Manager, request: JobRequest) ![]const u8 {
        if (request.players.len < 2 or request.players.len > 6) return error.InvalidInput;
        const board_n = request.board.len;
        if (!(board_n == 0 or board_n == 3 or board_n == 4 or board_n == 5)) return error.InvalidInput;

        self.mu.lock();
        defer self.mu.unlock();
        if (self.queue.items.len >= max_queued_jobs) return error.QueueFull;
        try self.ensureStartedLocked();

        const id = try std.fmt.allocPrint(self.allocator, "eq{d}", .{self.next_id});
        self.next_id += 1;
        errdefer self.allocator.free(id);

        const snap = Snapshot{
            .id = try self.allocator.dupe(u8, id),
            .state = .queued,
            .request = request,
        };
        try self.jobs.put(id, snap);
        try self.queue.append(id);
        self.cv.signal();
        return id;
    }

    pub fn statusJson(self: *Manager, allocator: std.mem.Allocator, id: []const u8) !?[]u8 {
        self.mu.lock();
        defer self.mu.unlock();
        const snap = self.jobs.getPtr(id) orelse return null;
        return try packStatus(allocator, snap, true);
    }

    pub fn cancel(self: *Manager, id: []const u8) bool {
        self.mu.lock();
        defer self.mu.unlock();
        const snap = self.jobs.getPtr(id) orelse return false;
        switch (snap.state) {
            .completed, .stopped, .failed, .cancelled => return true,
            .queued => {
                var i: usize = 0;
                while (i < self.queue.items.len) {
                    if (std.mem.eql(u8, self.queue.items[i], id)) {
                        _ = self.queue.orderedRemove(i);
                        break;
                    }
                    i += 1;
                }
                snap.state = .cancelled;
                if (snap.error_message.len != 0) self.allocator.free(snap.error_message);
                if (snap.error_kind.len != 0) self.allocator.free(snap.error_kind);
                snap.error_message = self.allocator.dupe(u8, "cancelled before start") catch &.{};
                snap.error_kind = self.allocator.dupe(u8, "cancelled") catch &.{};
                return true;
            },
            else => {
                snap.state = .stopping;
                if (std.mem.eql(u8, self.current_id, id)) {
                    self.cancel_current.store(true, .release);
                }
                return true;
            },
        }
    }

    pub fn shutdown(self: *Manager) void {
        {
            self.mu.lock();
            if (!self.started) {
                self.mu.unlock();
                return;
            }
            self.stop = true;
            self.cancel_current.store(true, .release);
            self.cv.broadcast();
            self.mu.unlock();
        }
        if (self.thread) |t| {
            t.join();
            self.thread = null;
        }
        self.mu.lock();
        self.started = false;
        self.mu.unlock();
    }

    fn threadMain(self: *Manager) void {
        while (true) {
            var job_id: []const u8 = undefined;
            var request_copy: JobRequest = undefined;
            {
                self.mu.lock();
                while (!self.stop and self.queue.items.len == 0) {
                    self.cv.wait(&self.mu);
                }
                if (self.stop and self.queue.items.len == 0) {
                    self.mu.unlock();
                    return;
                }
                if (self.queue.items.len == 0) {
                    self.mu.unlock();
                    continue;
                }
                job_id = self.queue.orderedRemove(0);
                const snap = self.jobs.getPtr(job_id) orelse {
                    self.mu.unlock();
                    continue;
                };
                if (snap.state == .cancelled) {
                    self.mu.unlock();
                    continue;
                }
                self.current_id = job_id;
                self.cancel_current.store(false, .release);
                snap.state = .preparing;
                request_copy = cloneRequest(self.allocator, snap.request) catch {
                    snap.state = .failed;
                    snap.error_message = self.allocator.dupe(u8, "oom cloning request") catch &.{};
                    snap.error_kind = self.allocator.dupe(u8, "failed") catch &.{};
                    self.current_id = "";
                    self.mu.unlock();
                    continue;
                };
                snap.state = .running;
                self.mu.unlock();
            }

            const started = std.time.nanoTimestamp();
            var options = request_copy.options;
            options.cancel_poll = cancelPoll;
            options.cancel_context = self;
            options.progress = progressCb;
            options.progress_context = self;

            var inputs = self.allocator.alloc(calc.PlayerInput, request_copy.players.len) catch {
                self.failJob(job_id, "oom preparing players", "failed");
                request_copy.deinit(self.allocator);
                continue;
            };
            defer self.allocator.free(inputs);
            var prepared_ok = true;
            for (request_copy.players, 0..) |p, i| {
                const parsed = range_mod.Range.parse(p.range_text) catch {
                    prepared_ok = false;
                    self.failJob(job_id, "invalid range", "invalid_input");
                    break;
                };
                inputs[i] = .{ .id = p.id, .range = parsed };
            }
            if (!prepared_ok) {
                request_copy.deinit(self.allocator);
                self.clearCurrent();
                continue;
            }

            const calc_result = calc.calculateEquity(
                self.allocator,
                inputs,
                request_copy.board,
                request_copy.dead_cards,
                options,
            );
            const ended = std.time.nanoTimestamp();
            request_copy.deinit(self.allocator);

            if (calc_result) |result| {
                self.mu.lock();
                defer self.mu.unlock();
                const snap = self.jobs.getPtr(job_id) orelse {
                    var tmp = result;
                    tmp.deinit();
                    self.current_id = "";
                    self.cancel_current.store(false, .release);
                    continue;
                };
                if (snap.result) |*old| old.deinit();
                snap.result = result;
                snap.elapsed_seconds = @as(f64, @floatFromInt(ended - started)) / 1e9;
                if (result.stopped or snap.state == .stopping) {
                    snap.state = .stopped;
                } else {
                    snap.state = .completed;
                }
                snap.progress_done = if (result.exact_complete) result.work.exact_deals else result.accepted_samples;
                snap.progress_total = snap.progress_done;
                self.current_id = "";
                self.cancel_current.store(false, .release);
                self.pruneLocked();
            } else |err| {
                const kind: []const u8 = switch (err) {
                    error.Cancelled => "cancelled",
                    error.WorkLimit => "work_limit",
                    error.SampleLimit => "sample_limit",
                    error.InvalidWeight => "invalid_weight",
                    error.NumericalRange => "numerical_range",
                    error.NoLegalJoint => "no_legal_joint",
                    error.InvalidInput => "invalid_input",
                    error.OutOfMemory => "failed",
                };
                const state: JobState = if (err == error.Cancelled) .cancelled else .failed;
                self.mu.lock();
                defer self.mu.unlock();
                if (self.jobs.getPtr(job_id)) |snap| {
                    snap.state = state;
                    if (snap.error_message.len != 0) self.allocator.free(snap.error_message);
                    if (snap.error_kind.len != 0) self.allocator.free(snap.error_kind);
                    snap.error_message = self.allocator.dupe(u8, @errorName(err)) catch &.{};
                    snap.error_kind = self.allocator.dupe(u8, kind) catch &.{};
                }
                self.current_id = "";
                self.cancel_current.store(false, .release);
                self.pruneLocked();
            }
        }
    }

    fn clearCurrent(self: *Manager) void {
        self.mu.lock();
        defer self.mu.unlock();
        self.current_id = "";
        self.cancel_current.store(false, .release);
    }

    fn failJob(self: *Manager, id: []const u8, message: []const u8, kind: []const u8) void {
        self.mu.lock();
        defer self.mu.unlock();
        if (self.jobs.getPtr(id)) |snap| {
            snap.state = .failed;
            if (snap.error_message.len != 0) self.allocator.free(snap.error_message);
            if (snap.error_kind.len != 0) self.allocator.free(snap.error_kind);
            snap.error_message = self.allocator.dupe(u8, message) catch &.{};
            snap.error_kind = self.allocator.dupe(u8, kind) catch &.{};
        }
        self.current_id = "";
        self.cancel_current.store(false, .release);
    }
};

fn cancelPoll(ctx: ?*anyopaque) bool {
    const self: *Manager = @ptrCast(@alignCast(ctx.?));
    return self.cancel_current.load(.acquire);
}

fn progressCb(ctx: ?*anyopaque, done: u64, total: u64) void {
    const self: *Manager = @ptrCast(@alignCast(ctx.?));
    self.mu.lock();
    defer self.mu.unlock();
    if (self.jobs.getPtr(self.current_id)) |snap| {
        snap.progress_done = done;
        snap.progress_total = total;
    }
}

fn cloneRequest(allocator: std.mem.Allocator, src: JobRequest) !JobRequest {
    var dst = JobRequest{
        .version = src.version,
        .client_revision = try allocator.dupe(u8, src.client_revision),
        .options = src.options,
    };
    errdefer dst.deinit(allocator);
    dst.players = try allocator.alloc(PlayerSpec, src.players.len);
    for (dst.players) |*p| p.* = .{ .id = &.{}, .range_text = &.{} };
    for (src.players, 0..) |p, i| {
        dst.players[i] = .{
            .id = try allocator.dupe(u8, p.id),
            .range_text = try allocator.dupe(u8, p.range_text),
        };
    }
    dst.board = try allocator.dupe(card.Card, src.board);
    dst.dead_cards = try allocator.dupe(card.Card, src.dead_cards);
    return dst;
}

fn appendEscaped(w: anytype, text: []const u8) !void {
    try w.writeByte('"');
    for (text) |c| {
        if (c == '"' or c == '\\') try w.writeByte('\\');
        if (c == '\n') {
            try w.writeAll("\\n");
            continue;
        }
        try w.writeByte(c);
    }
    try w.writeByte('"');
}

fn appendCardArray(w: anytype, cards: []const card.Card) !void {
    try w.writeByte('[');
    for (cards, 0..) |c, i| {
        if (i != 0) try w.writeByte(',');
        var buf: [2]u8 = undefined;
        const text = card.formatCard(c, &buf) catch "??";
        try appendEscaped(w, text);
    }
    try w.writeByte(']');
}

fn appendNumOrNull(w: anytype, defined: bool, value: f64) !void {
    if (!defined or !std.math.isFinite(value)) {
        try w.writeAll("null");
    } else {
        try w.print("{d}", .{value});
    }
}

fn packResult(w: anytype, result: calc.Result, board: []const card.Card, dead: []const card.Card) !void {
    try w.writeAll("{\"model\":\"");
    try w.writeAll(calc.model);
    try w.writeAll("\",\"units\":\"");
    try w.writeAll(calc.units);
    try w.writeAll("\",\"method_version\":");
    try appendEscaped(w, result.method_version);
    try w.writeAll(",\"requested_method\":");
    try appendEscaped(w, result.requested_method.name());
    try w.writeAll(",\"actual_method\":");
    try appendEscaped(w, result.actual_method.name());
    try w.writeAll(",\"method_reason\":");
    try appendEscaped(w, result.method_reason);
    try w.print(
        ",\"joint_defined\":{},\"exact_complete\":{},\"stopped\":{},\"legal_tuples\":{d},\"completions_per_tuple\":{d},\"exact_deals\":{d},\"estimate_capped\":{},\"accepted_samples\":{d},\"attempted_tuples\":{d},\"seed\":{d},\"elapsed_seconds\":{d},\"board\":",
        .{
            result.joint_defined,
            result.exact_complete,
            result.stopped,
            result.work.legal_tuples,
            result.work.completions_per_tuple,
            result.work.exact_deals,
            result.work.estimate_capped,
            result.accepted_samples,
            result.attempted_tuples,
            result.seed,
            result.elapsed_seconds,
        },
    );
    try appendCardArray(w, board);
    try w.writeAll(",\"dead_cards\":");
    try appendCardArray(w, dead);
    try w.writeAll(",\"players\":[");
    for (result.players, 0..) |player, i| {
        if (i != 0) try w.writeByte(',');
        try w.writeAll("{\"id\":");
        try appendEscaped(w, player.id);
        try w.print(",\"defined\":{},\"equity\":", .{player.defined});
        try appendNumOrNull(w, player.defined, player.equity);
        try w.writeAll(",\"win\":");
        try appendNumOrNull(w, player.defined, player.win);
        try w.writeAll(",\"tie\":");
        try appendNumOrNull(w, player.defined, player.tie);
        try w.writeAll(",\"loss\":");
        try appendNumOrNull(w, player.defined, player.loss);
        try w.writeAll(",\"equity_ci_low\":");
        try appendNumOrNull(w, player.defined and std.math.isFinite(player.equity_ci_low), player.equity_ci_low);
        try w.writeAll(",\"equity_ci_high\":");
        try appendNumOrNull(w, player.defined and std.math.isFinite(player.equity_ci_high), player.equity_ci_high);
        try w.writeByte('}');
    }
    try w.writeAll("]}");
}

pub fn packStatus(allocator: std.mem.Allocator, snap: *const Snapshot, include_result: bool) ![]u8 {
    var list = std.ArrayList(u8).init(allocator);
    errdefer list.deinit();
    const w = list.writer();
    try w.writeAll("{\"job_id\":");
    try appendEscaped(w, snap.id);
    try w.writeAll(",\"state\":");
    try appendEscaped(w, snap.state.name());
    try w.writeAll(",\"client_revision\":");
    try appendEscaped(w, snap.request.client_revision);
    try w.print(
        ",\"progress_done\":{d},\"progress_total\":{d},\"elapsed_seconds\":{d}",
        .{ snap.progress_done, snap.progress_total, snap.elapsed_seconds },
    );
    if (snap.error_message.len != 0) {
        try w.writeAll(",\"error\":");
        try appendEscaped(w, snap.error_message);
        try w.writeAll(",\"error_kind\":");
        try appendEscaped(w, snap.error_kind);
    }
    if (include_result and (snap.state == .completed or snap.state == .stopped)) {
        if (snap.result) |result| {
            try w.writeAll(",\"result\":");
            try packResult(w, result, snap.request.board, snap.request.dead_cards);
        }
    } else if (snap.state == .running or snap.state == .preparing) {
        try w.writeAll(",\"requested_method\":");
        try appendEscaped(w, snap.request.options.method.name());
    }
    try w.writeByte('}');
    return list.toOwnedSlice();
}

const ParsedBody = struct {
    version: i32 = 1,
    client_revision: []const u8 = "",
    method: []const u8 = "auto",
    target_samples: u64 = calc.default_target_samples,
    max_exact_deals: u64 = calc.default_max_exact_deals,
    auto_exact_threshold: u64 = calc.auto_exact_threshold,
    max_attempts: u64 = calc.default_max_attempts,
    seed: u64 = 1,
    board: []const []const u8 = &.{},
    dead_cards: []const []const u8 = &.{},
    players: []const struct {
        id: []const u8,
        range: []const u8,
    } = &.{},
};

pub fn parseJobRequest(allocator: std.mem.Allocator, body_json: []const u8) !JobRequest {
    var parsed = try std.json.parseFromSlice(ParsedBody, allocator, body_json, .{
        .ignore_unknown_fields = true,
        .allocate = .alloc_always,
    });
    defer parsed.deinit();
    const body = parsed.value;

    var request = JobRequest{
        .version = body.version,
        .client_revision = try allocator.dupe(u8, body.client_revision),
        .options = .{
            .method = try calc.Method.parse(body.method),
            .target_samples = body.target_samples,
            .max_exact_deals = body.max_exact_deals,
            .auto_exact_threshold = body.auto_exact_threshold,
            .max_attempts = body.max_attempts,
            .seed = body.seed,
        },
    };
    errdefer request.deinit(allocator);

    request.board = try allocator.alloc(card.Card, body.board.len);
    for (body.board, 0..) |text, i| {
        request.board[i] = card.parseCard(text) catch return error.InvalidInput;
    }
    request.dead_cards = try allocator.alloc(card.Card, body.dead_cards.len);
    for (body.dead_cards, 0..) |text, i| {
        request.dead_cards[i] = card.parseCard(text) catch return error.InvalidInput;
    }

    if (body.players.len == 0) return error.InvalidInput;
    request.players = try allocator.alloc(PlayerSpec, body.players.len);
    for (request.players) |*p| p.* = .{ .id = &.{}, .range_text = &.{} };
    for (body.players, 0..) |p, i| {
        if (p.id.len == 0 or p.range.len == 0) return error.InvalidInput;
        // Validate range parse early.
        _ = range_mod.Range.parse(p.range) catch return error.InvalidInput;
        request.players[i] = .{
            .id = try allocator.dupe(u8, p.id),
            .range_text = try allocator.dupe(u8, p.range),
        };
    }
    return request;
}

test "pack status includes completed result shape" {
    var snap = Snapshot{
        .id = try std.testing.allocator.dupe(u8, "eq1"),
        .state = .completed,
        .request = .{
            .client_revision = try std.testing.allocator.dupe(u8, "r1"),
        },
        .elapsed_seconds = 0.01,
    };
    defer snap.deinit(std.testing.allocator);
    const board = try calc.parseCards(std.testing.allocator, "2c 3d 7h 9s Jc");
    defer std.testing.allocator.free(board);
    const players = [_]calc.PlayerInput{
        .{ .id = "a", .range = try range_mod.Range.parse("AsAd") },
        .{ .id = "b", .range = try range_mod.Range.parse("KcKd") },
    };
    snap.request.board = try std.testing.allocator.dupe(card.Card, board);
    snap.result = try calc.calculateEquity(std.testing.allocator, &players, board, &.{}, .{ .method = .exact });
    const json = try packStatus(std.testing.allocator, &snap, true);
    defer std.testing.allocator.free(json);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"job_id\":\"eq1\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"state\":\"completed\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"result\":") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"model\":\"check-down\"") != null);
}
