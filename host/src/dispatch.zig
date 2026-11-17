//! Map IPC ops onto the app Session. Cancel fails pending jobs (D1).
const std = @import("std");
const poker_app = @import("poker_app");
const poker_engine = @import("poker_engine");
const ipc = @import("ipc.zig");
const workers = @import("workers.zig");
const equity_json = @import("equity_json.zig");
const equity_jobs = @import("equity_jobs.zig");
const categories_json = @import("categories_json.zig");
const compare_json = @import("compare_json.zig");
const study_reports = @import("study_reports.zig");
const locks_json = @import("locks_json.zig");
const strategy_edits_json = @import("strategy_edits_json.zig");
const format_study_bodies = @import("format_study_bodies.zig");
const node_lock = poker_engine.solve.node_lock;
const strategy_edit = poker_engine.solve.strategy_edit;

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

const BeginTask = struct {
    state: *HostState,
    request_id: []u8,
    job_id: ?[]u8,
    config: []u8,
};

const AnalysisKind = enum { values, equity, node, categories, line_card_report, value_bluffs_post_call };

const AnalysisTask = struct {
    state: *HostState,
    request_id: []u8,
    job_id: ?[]u8,
    op: []u8,
    body_json: []u8,
    kind: AnalysisKind,
    gen: u64,
};

const IoKind = enum { save, open };

const IoTask = struct {
    state: *HostState,
    request_id: []u8,
    job_id: ?[]u8,
    op: []u8,
    path: []u8,
    kind: IoKind,
    /// Save only: average-only Study export (omit regret/strategy_sum).
    study_only: bool = false,
};

const PreviewKind = enum { tree_preview, plan_memory };

const PreviewTask = struct {
    state: *HostState,
    request_id: []u8,
    job_id: ?[]u8,
    op: []u8,
    config: []u8,
    kind: PreviewKind,
    gen: u64,
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
    /// Serialize stdout frames from stdin loop + train/begin workers (R10 / ZR-120).
    stdout_mu: std.Thread.Mutex = .{},
    train_thread: ?std.Thread = null,
    train_running: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),
    /// Flop/turn compile off the stdin loop so Study can poll `status` (ZR-120).
    begin_thread: ?std.Thread = null,
    begin_running: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),
    /// ZR-151 / ZR-171: values/equity/node/categories off the stdin loop so Stop/status stay live.
    analysis_thread: ?std.Thread = null,
    /// Superseded analysis workers kept joinable (never detach). Bounded; joined on teardown.
    analysis_orphans: std.ArrayList(std.Thread),
    analysis_running: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),
    /// Bumped on each new analysis request; older workers reply `superseded`.
    analysis_gen: std.atomic.Value(u64) = std.atomic.Value(u64).init(0),
    /// ZR-151: Save/Open off the stdin loop (large PSOL must not starve control).
    io_thread: ?std.Thread = null,
    io_running: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),
    /// Tree preview / plan_memory off the stdin loop (large draft compile).
    preview_thread: ?std.Thread = null,
    preview_orphans: std.ArrayList(std.Thread),
    preview_running: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),
    /// Bumped on each new preview; older workers reply `superseded`.
    preview_gen: std.atomic.Value(u64) = std.atomic.Value(u64).init(0),
    /// Active begin/train job id (owned); null when idle. Stop/Pause match this only.
    active_job_id: ?[]u8 = null,
    job_mu: std.Thread.Mutex = .{},
    /// Serialize WorkerBudget mutations across stdin + analysis workers (ZR-180).
    budget_mu: std.Thread.Mutex = .{},
    /// Cross-thread status counter (Study cache invalidation). Atomic per ZR-180.
    status_generation: std.atomic.Value(u64) = std.atomic.Value(u64).init(1),
    last_cancelled: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),
    /// Absolute iteration target for the active/last train job (start_trained + job iters).
    train_iterations_requested: std.atomic.Value(i32) = std.atomic.Value(i32).init(0),
    /// Sticky async-train failure code (ZR-130 / Tiger Phase 2). Set when the
    /// post-admit worker hits a train fault; surfaced on `status` because short
    /// admit already replied on that request_id (no second solve reply).
    last_error: ?[]u8 = null,
    /// Standalone Equity calculator jobs (ZR-84); independent of Study Session.
    equity_jobs: equity_jobs.Manager,

    pub fn init(allocator: std.mem.Allocator, launch_id: []const u8) !HostState {
        var session = try poker_app.Session.init(allocator);
        errdefer session.deinit();
        return .{
            .allocator = allocator,
            .session = session,
            .budget = workers.WorkerBudget.initFromCpus(),
            .launch_id = try allocator.dupe(u8, launch_id),
            .pending = std.ArrayList([]u8).init(allocator),
            .cancelled_jobs = std.StringHashMap(void).init(allocator),
            .analysis_orphans = std.ArrayList(std.Thread).init(allocator),
            .preview_orphans = std.ArrayList(std.Thread).init(allocator),
            .equity_jobs = equity_jobs.Manager.init(allocator),
        };
    }

    pub fn deinit(self: *HostState) void {
        self.joinBegin();
        self.joinTrain();
        self.joinAnalysis();
        self.joinIo();
        self.joinPreview();
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
        self.clearLastError();
        self.pending.deinit();
        self.analysis_orphans.deinit();
        self.preview_orphans.deinit();
    }

    /// Clear sticky async-train error (fresh admit / successful train / teardown).
    pub fn clearLastError(self: *HostState) void {
        self.job_mu.lock();
        defer self.job_mu.unlock();
        if (self.last_error) |err| self.allocator.free(err);
        self.last_error = null;
    }

    /// Record a train-worker operating error for `status.last_error` (ZR-130).
    pub fn setLastError(self: *HostState, code: []const u8) void {
        self.job_mu.lock();
        defer self.job_mu.unlock();
        if (self.last_error) |prev| self.allocator.free(prev);
        self.last_error = self.allocator.dupe(u8, code) catch null;
        self.bumpStatusGeneration();
    }

    pub fn joinTrain(self: *HostState) void {
        if (self.train_thread) |t| {
            t.join();
            self.train_thread = null;
        }
    }

    pub fn joinBegin(self: *HostState) void {
        if (self.begin_thread) |t| {
            t.join();
            self.begin_thread = null;
        }
    }

    pub fn joinAnalysis(self: *HostState) void {
        if (self.analysis_thread) |t| {
            t.join();
            self.analysis_thread = null;
        }
        // Every superseded worker must be joined before HostState free (audit #3).
        for (self.analysis_orphans.items) |t| {
            t.join();
        }
        self.analysis_orphans.clearRetainingCapacity();
    }

    pub fn joinIo(self: *HostState) void {
        if (self.io_thread) |t| {
            t.join();
            self.io_thread = null;
        }
    }

    pub fn joinPreview(self: *HostState) void {
        if (self.preview_thread) |t| {
            t.join();
            self.preview_thread = null;
        }
        for (self.preview_orphans.items) |t| {
            t.join();
        }
        self.preview_orphans.clearRetainingCapacity();
    }

    pub fn bumpPreviewGen(self: *HostState) u64 {
        return self.preview_gen.fetchAdd(1, .acq_rel) + 1;
    }

    pub fn previewGenCurrent(self: *HostState, gen: u64) bool {
        return self.preview_gen.load(.acquire) == gen;
    }

    /// Park the prior preview join handle without blocking the stdin loop.
    pub fn retirePreviewThread(self: *HostState) void {
        if (self.preview_thread) |old_t| {
            self.preview_orphans.ensureUnusedCapacity(1) catch {
                // Bound exceeded: join synchronously so we never detach.
                old_t.join();
                self.preview_thread = null;
                return;
            };
            self.preview_orphans.appendAssumeCapacity(old_t);
            self.preview_thread = null;
        }
    }

    pub fn beginOrTrainBusy(self: *HostState) bool {
        return self.begin_running.load(.acquire) or self.train_running.load(.acquire);
    }

    /// Mint a generation for a new analysis request; older gens are superseded.
    pub fn bumpAnalysisGen(self: *HostState) u64 {
        return self.analysis_gen.fetchAdd(1, .acq_rel) + 1;
    }

    pub fn analysisGenCurrent(self: *HostState, gen: u64) bool {
        return self.analysis_gen.load(.acquire) == gen;
    }

    /// Park the prior analysis join handle without detach and **without joining
    /// on the stdin/admission path** in the common case. Joining here would stall
    /// cancel/status while EV finishes (ZR-151 / stop-close smoke).
    /// `joinAnalysis` / teardown joins the full orphan set. Gen checks make
    /// obsolete workers exit promptly.
    pub fn retireAnalysisThread(self: *HostState) void {
        if (self.analysis_thread) |old_t| {
            self.analysis_orphans.ensureUnusedCapacity(1) catch {
                // Extreme OOM only: join so the handle is not leaked. May briefly
                // stall Stop; never detach (HostState UAF on teardown).
                old_t.join();
                self.analysis_thread = null;
                return;
            };
            self.analysis_thread = null;
            self.analysis_orphans.appendAssumeCapacity(old_t);
        }
    }

    /// Only the current analysis generation may clear shared running / budget.
    /// A superseded worker must not flip `analysis_running` off while a newer
    /// request is live, or return WorkerBudget to training under that request.
    pub fn finishAnalysisSlot(self: *HostState, gen: u64) void {
        if (!self.analysisGenCurrent(gen)) return;
        self.analysis_running.store(false, .release);
        self.returnBudgetToTraining();
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
        self.cancelled_mu.lock();
        defer self.cancelled_mu.unlock();
        // Idempotent: re-Stop of the live id must not leak duplicate key allocations.
        if (self.cancelled_jobs.contains(job_id)) {
            self.last_cancelled.store(true, .release);
            self.bumpStatusGeneration();
            return;
        }
        const owned = try self.allocator.dupe(u8, job_id);
        errdefer self.allocator.free(owned);
        try self.cancelled_jobs.put(owned, {});
        self.last_cancelled.store(true, .release);
        self.bumpStatusGeneration();
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
        self.bumpStatusGeneration();
    }

    /// True when `job_id` is the live begin/train identity (under `job_mu`).
    pub fn matchesActiveJob(self: *HostState, job_id: []const u8) bool {
        self.job_mu.lock();
        defer self.job_mu.unlock();
        const active = self.active_job_id orelse return false;
        return std.mem.eql(u8, active, job_id);
    }

    /// Clear active identity only when it still names `job_id` (terminal transition).
    pub fn clearActiveJobIfMatch(self: *HostState, job_id: ?[]const u8) void {
        const want = job_id orelse return;
        self.job_mu.lock();
        defer self.job_mu.unlock();
        const active = self.active_job_id orelse return;
        if (!std.mem.eql(u8, active, want)) return;
        self.allocator.free(active);
        self.active_job_id = null;
        self.bumpStatusGeneration();
    }

    pub fn bumpStatusGeneration(self: *HostState) void {
        _ = self.status_generation.fetchAdd(1, .acq_rel);
    }

    pub fn prioritizeAnalysisBudget(self: *HostState, want: u32) void {
        self.budget_mu.lock();
        defer self.budget_mu.unlock();
        self.budget.prioritizeAnalysis(want);
    }

    pub fn returnBudgetToTraining(self: *HostState) void {
        self.budget_mu.lock();
        defer self.budget_mu.unlock();
        self.budget.returnToTraining();
    }

    pub fn snapshotBudget(self: *HostState) workers.WorkerBudget {
        self.budget_mu.lock();
        defer self.budget_mu.unlock();
        return self.budget;
    }

    /// Cores Study analysis may borrow (same IPC headroom as train).
    /// Wide-range flop root EV needs these for first-card chance parallelism.
    pub fn analysisThreadBudget(self: *HostState) u32 {
        const snap = self.snapshotBudget();
        return @max(workers.WorkerBudget.maxTrainThreads(snap.total), 1);
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
    return try ipc.unescapeJsonString(allocator, escaped);
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

fn bodyBoolField(body: []const u8, key: []const u8) ?bool {
    var needle_buf: [64]u8 = undefined;
    const needle = std.fmt.bufPrint(&needle_buf, "\"{s}\":", .{key}) catch return null;
    const start = std.mem.indexOf(u8, body, needle) orelse return null;
    var i = start + needle.len;
    while (i < body.len and (body[i] == ' ' or body[i] == '\t')) : (i += 1) {}
    if (std.mem.startsWith(u8, body[i..], "true")) return true;
    if (std.mem.startsWith(u8, body[i..], "false")) return false;
    return null;
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

/// Parse `[[a,b],[c,d]]` inner text (without outer brackets) into owned rows.
fn parseF64Array2D(allocator: std.mem.Allocator, text: []const u8) ![][]f64 {
    var rows = std.ArrayList([]f64).init(allocator);
    errdefer {
        for (rows.items) |row| allocator.free(row);
        rows.deinit();
    }
    var i: usize = 0;
    while (i < text.len) {
        while (i < text.len and (text[i] == ' ' or text[i] == '\t' or text[i] == ',' or text[i] == '\n' or text[i] == '\r')) : (i += 1) {}
        if (i >= text.len) break;
        if (text[i] != '[') return error.InvalidLockText;
        i += 1;
        const from = i;
        while (i < text.len and text[i] != ']') : (i += 1) {}
        if (i >= text.len) return error.InvalidLockText;
        const row = try parseF64Array(allocator, text[from..i]);
        try rows.append(row);
        i += 1;
    }
    return try rows.toOwnedSlice();
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

fn persistStrategyEditsText(state: *HostState, edits: *const strategy_edit.StrategyEditSet) !void {
    const text = try strategy_edit.formatStrategyEditSet(state.allocator, edits);
    defer state.allocator.free(text);
    try state.session.setStrategyEditsText(text);
}

fn replyStrategyEditsBody(state: *HostState, req: ipc.Envelope, edits: *const strategy_edit.StrategyEditSet) !ipc.Envelope {
    const body = strategy_edits_json.packStudyStrategyEditsBody(state.allocator, edits) catch |err| {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "strategy_edits_pack_failed", @errorName(err));
    };
    defer state.allocator.free(body);
    return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, body);
}

fn reapplyStrategyEdits(state: *HostState, edits: *const strategy_edit.StrategyEditSet) !void {
    // Restore CFR / baseline average, then overlay remaining edits.
    try state.session.restoreStrategyEditBaseline();
    if (edits.empty()) return;
    const game = state.session.game orelse return error.NothingPublished;
    const average = try state.session.publishedAverageMut();
    try strategy_edit.applyEditSetToAverage(game, average, edits);
    // restore already bumped once; bump again so Study drops stale EV/equity caches.
    try state.session.bumpPolicyRevision();
}

const LineLockExpandError = error{
    InvalidLockRow,
    OutOfMemory,
    InvalidAnalysis,
};

/// Build a board-local per-combo lock from the published strategy at one runout.
/// Pio line lock: each legal runout keeps the mix already stored there.
fn nodeLockFromPublishedRunout(
    allocator: std.mem.Allocator,
    game: poker_engine.game.compile.CompiledGame,
    published: poker_engine.solve.training_state.PublishedPolicy,
    infoset_id: usize,
    turn: i32,
    river: i32,
    hands: []const usize,
) LineLockExpandError!?node_lock.NodeLock {
    var page = try poker_engine.analysis.inspect.inspectNode(
        allocator,
        game,
        published,
        @intCast(infoset_id),
        turn,
        river,
    );
    defer page.deinit();
    if (page.player < 0 or page.n_actions == 0) return null;
    const n_actions: usize = page.n_actions;
    const n_hands: usize = if (page.n_hands > 0) @intCast(page.n_hands) else page.combos.len;

    // Keep only hands with a usable published mix at this runout (skip card-blocked /
    // zero rows). Returns null when nothing applies on this board.
    var kept_hands = std.ArrayList(usize).init(allocator);
    defer kept_hands.deinit();
    var kept_rows = std.ArrayList([]f64).init(allocator);
    defer {
        for (kept_rows.items) |row| allocator.free(row);
        kept_rows.deinit();
    }

    for (hands) |hand| {
        if (hand >= n_hands) continue;
        if (page.strategy.len < (hand + 1) * n_actions) continue;
        const src = page.strategy[hand * n_actions ..][0..n_actions];
        var sum: f64 = 0;
        for (src) |p| {
            if (std.math.isFinite(p) and p >= 0) sum += @floatCast(p);
        }
        if (!(sum > 0)) continue;
        var row = try allocator.alloc(f64, n_actions);
        errdefer allocator.free(row);
        for (src, 0..) |p, ai| {
            const v: f64 = if (std.math.isFinite(p) and p >= 0) @floatCast(p) else 0;
            row[ai] = v / sum;
        }
        try kept_hands.append(hand);
        try kept_rows.append(row);
    }
    if (kept_hands.items.len == 0) return null;

    const owned_hands = try allocator.dupe(usize, kept_hands.items);
    errdefer allocator.free(owned_hands);
    const combo_actions = try node_lock.makeComboActionRows(
        allocator,
        owned_hands,
        kept_rows.items,
        @intCast(n_actions),
    );

    return .{
        .infoset_id = infoset_id,
        .scope = .node,
        .turn = @intCast(turn),
        .river = @intCast(river),
        .kind = .selected_combos,
        .combo_indices = owned_hands,
        .combo_actions = combo_actions,
    };
}

fn upsertOneLineRunout(
    state: *HostState,
    locks: *node_lock.LockSet,
    game: poker_engine.game.compile.CompiledGame,
    published: poker_engine.solve.training_state.PublishedPolicy,
    infoset_id: usize,
    turn: i32,
    river: i32,
    hands: []const usize,
) LineLockExpandError!void {
    // Independent board-local edits stay independent: do not overwrite or merge
    // into an explicit (non-from_line) record when expanding a line lock.
    if (locks.findExact(infoset_id, turn, river)) |existing| {
        if (!existing.from_line) return;
    }
    const maybe = try nodeLockFromPublishedRunout(
        state.allocator,
        game,
        published,
        infoset_id,
        turn,
        river,
        hands,
    );
    var lock = maybe orelse return;
    errdefer lock.deinit(state.allocator);
    lock.from_line = true;
    try locks.mergeUpsert(lock);
}

fn upsertLineLockRunouts(
    state: *HostState,
    locks: *node_lock.LockSet,
    game: poker_engine.game.compile.CompiledGame,
    published: poker_engine.solve.training_state.PublishedPolicy,
    infoset_id: usize,
    hands: []const usize,
) LineLockExpandError!void {
    const node = game.nodes[infoset_id];
    // Drop any prior shared line record so findForRunout cannot reuse one mix.
    _ = locks.eraseKey(node_lock.lineLockKey(infoset_id));

    if (node.card_mode == 0) {
        try upsertOneLineRunout(state, locks, game, published, infoset_id, -1, -1, hands);
        return;
    }
    if (node.card_mode == 1) {
        for (game.runouts.mode1_cards) |c| {
            const turn: i32 = if (node.mode1_is_turn) c else -1;
            const river: i32 = if (node.mode1_is_turn) -1 else c;
            try upsertOneLineRunout(state, locks, game, published, infoset_id, turn, river, hands);
        }
        return;
    }
    // card_mode 2: every legal turn/river pair.
    var i: usize = 0;
    while (i < game.runouts.mode2_turn.len) : (i += 1) {
        try upsertOneLineRunout(
            state,
            locks,
            game,
            published,
            infoset_id,
            game.runouts.mode2_turn[i],
            game.runouts.mode2_river[i],
            hands,
        );
    }
}

/// Reverse of `upsertLineLockRunouts`: drop the shared line key and every
/// line-generated board-local record for this infoset. Explicit board-local
/// edits (including ones that overlapped a line expansion) are preserved.
fn eraseLineLockRunouts(locks: *node_lock.LockSet, infoset_id: usize) void {
    _ = locks.eraseKey(node_lock.lineLockKey(infoset_id));
    var i = locks.entries.items.len;
    while (i > 0) {
        i -= 1;
        const lock = locks.entries.items[i];
        if (lock.infoset_id == infoset_id and lock.scope == .node and lock.from_line) {
            locks.entries.items[i].deinit(locks.allocator);
            _ = locks.entries.swapRemove(i);
        }
    }
}

/// ZR-136: fat `put_lock` body extracted from `handle` (op discriminator stays in parent).
fn handlePutLock(state: *HostState, req: ipc.Envelope) !ipc.Envelope {
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
    const combo_probs_slice = bodyArraySlice(req.body_json, "combo_probs");
    const probs_slice = bodyArraySlice(req.body_json, "probs");
    if (combo_probs_slice == null and probs_slice == null) {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "probs or combo_probs required");
    }
    if (!std.mem.eql(u8, kind_text, "full") and !std.mem.eql(u8, kind_text, "selected")) {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "kind must be full or selected");
    }

    const n_hands: usize = if (page.n_hands > 0) @intCast(page.n_hands) else page.combos.len;

    // Line lock: expand into per-runout node locks from each runout's published
    // strategy. Never copy the browsed board's mix under a shared line key.
    if (std.mem.eql(u8, scope_text, "line")) {
        var hands: []usize = &.{};
        defer if (hands.len != 0) state.allocator.free(hands);
        if (combo_probs_slice != null or std.mem.eql(u8, kind_text, "selected")) {
            const hands_slice = bodyArraySlice(req.body_json, "hand_indices") orelse
                return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "hand_indices required for line lock mask");
            hands = parseUsizeArray(state.allocator, hands_slice) catch {
                return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "bad hand_indices");
            };
            if (hands.len == 0) {
                return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "hand_indices required for line lock mask");
            }
            for (hands) |hand| {
                if (hand >= n_hands) {
                    return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "hand index out of range");
                }
            }
        } else {
            // Full line lock: every combo.
            hands = try state.allocator.alloc(usize, n_hands);
            for (hands, 0..) |*h, i| h.* = i;
        }

        var locks = locks_json.parseSessionLocks(state.allocator, state.session.locks_text) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_locks", @errorName(err));
        };
        defer locks.deinit();
        upsertLineLockRunouts(state, &locks, lease.game, lease.published, located.node_index, hands) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "locks_persist_failed", @errorName(err));
        };
        persistLocksText(state, &locks) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "locks_persist_failed", @errorName(err));
        };
        return replyLocksBody(state, req, &locks);
    }

    var lock = node_lock.NodeLock{
        .infoset_id = located.node_index,
        .scope = .node,
        .turn = @intCast(located.turn),
        .river = @intCast(located.river),
    };
    errdefer lock.deinit(state.allocator);
    if (std.mem.eql(u8, kind_text, "full")) {
        lock.kind = .full_node;
    } else {
        lock.kind = .selected_combos;
    }

    if (combo_probs_slice) |cps| {
        // Per-combo mixes: hand_indices parallel to combo_probs rows.
        const hands_slice = bodyArraySlice(req.body_json, "hand_indices") orelse
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "hand_indices required with combo_probs");
        const hands = parseUsizeArray(state.allocator, hands_slice) catch {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "bad hand_indices");
        };
        errdefer state.allocator.free(hands);
        for (hands) |hand| {
            if (hand >= n_hands) {
                return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "hand index out of range");
            }
        }
        const rows = parseF64Array2D(state.allocator, cps) catch {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "bad combo_probs");
        };
        defer {
            for (rows) |row| state.allocator.free(row);
            state.allocator.free(rows);
        }
        if (rows.len != hands.len) {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "combo_probs length must match hand_indices");
        }
        for (rows) |row| {
            if (row.len != page.n_actions) {
                return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "combo_probs row length must match action arity");
            }
        }
        lock.combo_actions = node_lock.makeComboActionRows(state.allocator, hands, rows, @intCast(page.n_actions)) catch {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "invalid combo_probs rows");
        };
        lock.combo_indices = hands;
        // Per-combo list is the lock mask (even when kind was full).
        if (lock.kind == .full_node) lock.kind = .selected_combos;
    } else {
        const probs = parseF64Array(state.allocator, probs_slice.?) catch {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "bad probs");
        };
        defer state.allocator.free(probs);
        if (probs.len != page.n_actions) {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "probs length must match action arity");
        }
        if (lock.kind == .selected_combos) {
            const hands_slice = bodyArraySlice(req.body_json, "hand_indices") orelse "";
            const hands = parseUsizeArray(state.allocator, hands_slice) catch {
                return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "bad hand_indices");
            };
            for (hands) |hand| {
                if (hand >= n_hands) {
                    state.allocator.free(hands);
                    return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "hand index out of range");
                }
            }
            lock.combo_indices = hands;
        }
        lock.actions = node_lock.makeActionLockRow(state.allocator, probs, @intCast(page.n_actions)) catch {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "invalid lock row");
        };
    }

    var locks = locks_json.parseSessionLocks(state.allocator, state.session.locks_text) catch |err| {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_locks", @errorName(err));
    };
    defer locks.deinit();

    // Board-local selected put must not shadow a line lock: materialize the line
    // mask onto this board first, then merge the patch (A then B keeps A).
    const patch_merges = lock.kind == .selected_combos or lock.hasPerComboActions();
    if (lock.scope == .node and patch_merges) {
        const node_key = lock.key();
        if (locks.findExactKey(node_key) == null) {
            if (locks.find(lock.infoset_id)) |line| {
                var base = node_lock.materializeNodeFromLine(
                    state.allocator,
                    line.*,
                    lock.turn,
                    lock.river,
                    n_hands,
                ) catch |err| {
                    return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "locks_persist_failed", @errorName(err));
                };
                locks.upsert(base) catch |err| {
                    base.deinit(state.allocator);
                    return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "locks_persist_failed", @errorName(err));
                };
            }
        }
    }

    // Explicit board-local put owns the record — never tagged from_line.
    lock.from_line = false;
    locks.mergeUpsert(lock) catch |err| {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "locks_persist_failed", @errorName(err));
    };
    // LockSet now owns the NodeLock storage; neutralize errdefer.
    lock = .{};
    // mergeLockMasks defaults from_line=false; force-clear if an older full replace path kept a tag.
    for (locks.entries.items) |*entry| {
        if (entry.infoset_id == located.node_index and entry.scope == .node and
            entry.turn == @as(i8, @intCast(located.turn)) and entry.river == @as(i8, @intCast(located.river)))
        {
            entry.from_line = false;
            break;
        }
    }
    persistLocksText(state, &locks) catch |err| {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "locks_persist_failed", @errorName(err));
    };
    return replyLocksBody(state, req, &locks);
}

/// ZR-136: sibling of `handlePutLock` (cheap extract with the put path).
fn handleDeleteLock(state: *HostState, req: ipc.Envelope) !ipc.Envelope {
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
        const scope_text = bodyStringField(req.body_json, "scope") orelse "node";
        if (!std.mem.eql(u8, scope_text, "node") and !std.mem.eql(u8, scope_text, "line")) {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "scope must be node or line");
        }
        const key = if (std.mem.eql(u8, scope_text, "line"))
            node_lock.lineLockKey(parsed.node_index)
        else
            node_lock.makeLockKey(parsed.node_index, parsed.turn, parsed.river);

        // Resolve hand count for full-node → selected conversion (unlock selected).
        var n_hands: usize = 0;
        if (state.session.borrowPublished()) |lease_val| {
            var lease = lease_val;
            defer lease.deinit();
            if (poker_engine.analysis.inspect.inspectNode(
                state.allocator,
                lease.game,
                lease.published,
                @intCast(parsed.node_index),
                if (key.scope == .line) @as(i32, -1) else parsed.turn,
                if (key.scope == .line) @as(i32, -1) else parsed.river,
            )) |page_val| {
                var page = page_val;
                defer page.deinit();
                n_hands = if (page.n_hands > 0) @intCast(page.n_hands) else page.combos.len;
            } else |_| {}
        } else |_| {}

        if (bodyIntField(req.body_json, "hand_index")) |hand_i32| {
            if (hand_i32 < 0) {
                return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "bad hand_index");
            }
            const hand_index: usize = @intCast(hand_i32);

            if (locks.findExactKey(key) != null) {
                if (!locks.eraseComboKey(key, hand_index, n_hands)) {
                    return ipc.makeErrorReply(
                        state.allocator,
                        req.request_id,
                        req.job_id,
                        req.op,
                        "invalid_request",
                        "combo not locked at this scope",
                    );
                }
            } else if (key.scope == .node) {
                // Board-local unlock against a line lock: materialize, then erase.
                const line = locks.find(parsed.node_index) orelse {
                    return replyLocksBody(state, req, &locks);
                };
                if (!node_lock.comboIsLocked(line.*, hand_index)) {
                    return replyLocksBody(state, req, &locks);
                }
                var override = node_lock.materializeNodeFromLine(
                    state.allocator,
                    line.*,
                    parsed.turn,
                    parsed.river,
                    n_hands,
                ) catch |err| {
                    return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "locks_persist_failed", @errorName(err));
                };
                locks.upsert(override) catch |err| {
                    override.deinit(state.allocator);
                    return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "locks_persist_failed", @errorName(err));
                };
                _ = locks.eraseComboKey(key, hand_index, n_hands);
            } else {
                return replyLocksBody(state, req, &locks);
            }
        } else {
            // Unlock whole record at this scope. Node ops stay board-local:
            // never delete a line lock when clearing a browsed board.
            if (key.scope == .node) {
                if (locks.findExactKey(key) != null) {
                    _ = locks.eraseKey(key);
                } else if (locks.find(parsed.node_index) != null) {
                    // Line covers this board — insert unlock-all sentinel.
                    const sentinel = node_lock.NodeLock{
                        .infoset_id = parsed.node_index,
                        .turn = @intCast(parsed.turn),
                        .river = @intCast(parsed.river),
                        .scope = .node,
                        .kind = .full_node,
                    };
                    locks.upsert(sentinel) catch |err| {
                        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "locks_persist_failed", @errorName(err));
                    };
                }
            } else {
                // Line unlock must clear the same expanded runout locks that
                // line lock created — not only a legacy shared line key.
                eraseLineLockRunouts(&locks, parsed.node_index);
            }
        }
    } else {
        locks.clear();
    }

    persistLocksText(state, &locks) catch |err| {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "locks_persist_failed", @errorName(err));
    };
    return replyLocksBody(state, req, &locks);
}

/// ZR-136: fat `put_strategy_edit` body extracted from `handle`.
fn handlePutStrategyEdit(state: *HostState, req: ipc.Envelope) !ipc.Envelope {
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
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "strategy edits apply only to decision nodes");
    }

    const kind_text = bodyStringField(req.body_json, "kind") orelse "selected";
    const probs_slice = bodyArraySlice(req.body_json, "probs") orelse
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "probs required");
    const probs = parseF64Array(state.allocator, probs_slice) catch {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "bad probs");
    };
    defer state.allocator.free(probs);
    if (probs.len != page.n_actions) {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "probs length must match action arity");
    }
    if (!strategy_edit.validateStrategyProbs(probs, @intCast(page.n_actions))) {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "invalid strategy probability row");
    }

    var edit = strategy_edit.StrategyEdit{
        .infoset_id = located.node_index,
        .turn = @intCast(located.turn),
        .river = @intCast(located.river),
    };
    errdefer edit.deinit(state.allocator);
    edit.probs = strategy_edit.makeStrategyProbs(state.allocator, probs, @intCast(page.n_actions)) catch {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "invalid strategy probability row");
    };
    if (std.mem.eql(u8, kind_text, "full")) {
        edit.kind = .full_node;
    } else if (std.mem.eql(u8, kind_text, "selected")) {
        edit.kind = .selected_combos;
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
            const supported = strategy_edit.handHasInfoset(
                lease.game,
                located.node_index,
                located.turn,
                located.river,
                hand,
            ) catch {
                state.allocator.free(hands);
                return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "hand index out of range");
            };
            if (!supported) {
                state.allocator.free(hands);
                return ipc.makeErrorReply(
                    state.allocator,
                    req.request_id,
                    req.job_id,
                    req.op,
                    "invalid_request",
                    "hand has no information set on this node",
                );
            }
        }
        edit.hand_indices = hands;
    } else {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "kind must be full or selected");
    }

    // Drop inspect lease before mutating published average / baseline.
    lease.deinit();

    state.session.ensureStrategyEditBaseline() catch |err| {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "nothing_published", @errorName(err));
    };

    var edits = strategy_edits_json.parseSessionStrategyEdits(state.allocator, state.session.strategy_edits_text) catch |err| {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_strategy_edits", @errorName(err));
    };
    defer edits.deinit();
    edits.upsert(edit) catch |err| {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", @errorName(err));
    };
    // Ownership transferred into the set.
    edit = .{};

    reapplyStrategyEdits(state, &edits) catch |err| {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "strategy_edits_apply_failed", @errorName(err));
    };
    persistStrategyEditsText(state, &edits) catch |err| {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "strategy_edits_persist_failed", @errorName(err));
    };
    return replyStrategyEditsBody(state, req, &edits);
}

/// ZR-136: sibling of `handlePutStrategyEdit` (cheap extract with the put path).
fn handleDeleteStrategyEdit(state: *HostState, req: ipc.Envelope) !ipc.Envelope {
    if (state.train_running.load(.acquire) or state.session.phase == .training) {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "busy", "a solve is already running");
    }
    if (state.session.solution_id == 0) {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "nothing_published", "no solution");
    }
    var edits = strategy_edits_json.parseSessionStrategyEdits(state.allocator, state.session.strategy_edits_text) catch |err| {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_strategy_edits", @errorName(err));
    };
    defer edits.deinit();

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
            if (edits.findExactKey(key)) |existing| {
                if (existing.kind == .full_node) {
                    return ipc.makeErrorReply(
                        state.allocator,
                        req.request_id,
                        req.job_id,
                        req.op,
                        "invalid_request",
                        "full-node strategy edits clear with node_id only; omit hand_index",
                    );
                }
            }
            _ = edits.eraseHand(key, hand_index);
        } else {
            _ = edits.eraseKey(key);
        }
    } else {
        edits.clear();
    }

    state.session.ensureStrategyEditBaseline() catch |err| {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "nothing_published", @errorName(err));
    };
    reapplyStrategyEdits(state, &edits) catch |err| {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "strategy_edits_apply_failed", @errorName(err));
    };
    persistStrategyEditsText(state, &edits) catch |err| {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "strategy_edits_persist_failed", @errorName(err));
    };
    return replyStrategyEditsBody(state, req, &edits);
}

/// ZR-137: fat `equity` body extracted from `handle` (op discriminator stays in parent).
fn handleEquity(state: *HostState, req: ipc.Envelope) !ipc.Envelope {
    // Sync path for unit tests. Product stdin loop uses `startEquity` (ZR-151).
    state.prioritizeAnalysisBudget(1);
    defer state.returnBudgetToTraining();
    const wait_ns: u64 = 30 * std.time.ns_per_s;
    var lease = borrowPublishedForAnalysis(state, wait_ns) catch |err| {
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
    var held_ctx = false;
    var page = computeStudyEquity(state, &lease, located, &held_ctx) catch |err| {
        if (held_ctx) state.session.releaseFrozenCtxForAnalysis();
        const code: []const u8 = switch (err) {
            error.WorkLimit => "work_limit",
            error.InvalidEquity => "invalid_equity",
            error.InvalidWeight => "invalid_weight",
            error.OutOfMemory => if (state.session.budget.limit() > 0) "budget_exceeded" else "oom",
        };
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, code, @errorName(err));
    };
    defer {
        page.deinit();
        if (held_ctx) state.session.releaseFrozenCtxForAnalysis();
    }
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

fn computeStudyEquity(
    state: *HostState,
    lease: *poker_app.PublishedLease,
    located: poker_engine.analysis.node_id.ParsedNodeId,
    held_ctx: *bool,
) poker_engine.analysis.equity.EquityError!poker_engine.analysis.equity.ShowdownEquity {
    held_ctx.* = false;
    if (state.session.acquireFrozenCtxForAnalysis()) |ctx| {
        held_ctx.* = true;
        return poker_engine.analysis.equity.checkdownEquityAtNodeOnCtx(
            state.session.allocator,
            ctx,
            lease.game,
            lease.published,
            located.node_index,
            located.turn,
            located.river,
            poker_engine.analysis.equity.study_warm_max_hand_runouts,
        );
    } else |_| {
        return poker_engine.analysis.equity.checkdownEquityAtNode(
            state.session.allocator,
            lease.game,
            lease.published,
            located.node_index,
            located.turn,
            located.river,
            poker_engine.analysis.equity.study_explorer_max_pair_runouts,
        );
    }
}

/// ZR-137: fat `categories` body extracted from `handle` (op discriminator stays in parent).
fn handleCategories(state: *HostState, req: ipc.Envelope) !ipc.Envelope {
    state.prioritizeAnalysisBudget(1);
    defer state.returnBudgetToTraining();
    // Categories sync path historically waited 120s; still bound mid-train, but
    // idle sessions fail immediately (ZR-170).
    const wait_ns: u64 = 120 * std.time.ns_per_s;
    var lease = borrowPublishedForAnalysis(state, wait_ns) catch |err| {
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
        state.session.allocator,
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
            error.OutOfMemory => if (state.session.budget.limit() > 0) "budget_exceeded" else "oom",
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

/// Parse Study solution tokens (`s12`) or bare decimals into a numeric id.
fn parseSolutionIdToken(text: []const u8) ?u64 {
    if (text.len == 0) return null;
    const digits = if (text.len >= 2 and (text[0] == 's' or text[0] == 'S')) text[1..] else text;
    if (digits.len == 0) return null;
    return std.fmt.parseInt(u64, digits, 10) catch null;
}

/// Dual-session Compare: inspect retained baseline vs current scenario at one node.
fn handleCompare(state: *HostState, req: ipc.Envelope) !ipc.Envelope {
    const baseline_token = bodyStringField(req.body_json, "baseline") orelse
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "baseline, scenario, and node_id are required");
    const scenario_token = bodyStringField(req.body_json, "scenario") orelse
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "baseline, scenario, and node_id are required");
    const baseline_id = parseSolutionIdToken(baseline_token) orelse
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "baseline, scenario, and node_id are required");
    const scenario_id = parseSolutionIdToken(scenario_token) orelse
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "baseline, scenario, and node_id are required");

    if (state.session.baseline_id == 0 or state.session.baseline_snapshot == null) {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "no_baseline", "no retained baseline (resolve-locked first)");
    }
    if (baseline_id != state.session.baseline_id) {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "expired_solution", "baseline solution expired");
    }
    if (scenario_id == 0 or scenario_id != state.session.solution_id) {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "expired_solution", "scenario solution expired");
    }

    var baseline_lease = state.session.borrowBaseline() catch |err| {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "expired_solution", @errorName(err));
    };
    defer baseline_lease.deinit();

    var scenario_lease = state.session.borrowPublished() catch |err| {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "nothing_published", @errorName(err));
    };
    defer scenario_lease.deinit();

    const located = resolveLocatedNode(scenario_lease.game, req.body_json) catch |err| {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "unknown_node", @errorName(err));
    };
    var owned_node_id: ?[]u8 = null;
    defer if (owned_node_id) |p| state.allocator.free(p);
    const node_id_text: []const u8 = if (bodyStringField(req.body_json, "node_id")) |text|
        text
    else blk: {
        const formatted = poker_engine.analysis.node_id.formatNodeId(
            state.allocator,
            located.node_index,
            located.turn,
            located.river,
        ) catch {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "compare_failed", "node_id");
        };
        owned_node_id = formatted;
        break :blk formatted;
    };

    var base_page = poker_engine.analysis.inspect.inspectNode(
        state.allocator,
        baseline_lease.game,
        baseline_lease.published,
        located.node_index,
        located.turn,
        located.river,
    ) catch |err| {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "compare_failed", @errorName(err));
    };
    defer base_page.deinit();

    var scen_page = poker_engine.analysis.inspect.inspectNode(
        state.allocator,
        scenario_lease.game,
        scenario_lease.published,
        located.node_index,
        located.turn,
        located.river,
    ) catch |err| {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "compare_failed", @errorName(err));
    };
    defer scen_page.deinit();

    if (base_page.kind != .decision or scen_page.kind != .decision) {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "compare requires a decision node");
    }
    if (base_page.n_actions != scen_page.n_actions) {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "arity_mismatch", "solutions disagree on action arity at node");
    }

    var locks_owned: ?node_lock.LockSet = null;
    defer if (locks_owned) |*owned| owned.deinit();
    if (state.session.locks_text.len != 0) {
        locks_owned = node_lock.parseLockSet(state.allocator, state.session.locks_text) catch null;
    }

    const scenario_value: f64 = if (state.session.has_metrics) state.session.metrics.value else 0;
    const scenario_nash: f64 = if (state.session.has_metrics) state.session.metrics.nash_gap else 0;

    const body = compare_json.packCompareBody(state.allocator, .{
        .baseline_id = baseline_id,
        .scenario_id = scenario_id,
        .node_id = node_id_text,
        .baseline_value = baseline_lease.value,
        .scenario_value = scenario_value,
        .baseline_nash_gap = baseline_lease.nash_gap,
        .scenario_nash_gap = scenario_nash,
        .baseline_page = &base_page,
        .scenario_page = &scen_page,
        .locks = if (locks_owned) |*owned| owned else null,
        .turn = located.turn,
        .river = located.river,
    }) catch |err| {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "compare_pack_failed", @errorName(err));
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
    // Snapshot under session + job locks (ZR-90 / ZR-155 / ZR-171).
    // Do NOT call BudgetAllocator.live/peak while holding session.mu — compile /
    // publish alloc storms take budget.mu, and nesting session→budget stalls the
    // IPC stdin loop's status replies under Windows flop build/train.
    state.session.mu.lock();
    const phase = state.session.phase;
    const solution_id = state.session.solution_id;
    const baseline_id = state.session.baseline_id;
    const policy_revision = state.session.policyRevision();
    const has_training = state.session.has_training;
    const can_continue = state.session.canContinue();
    const threads = state.session.threads;
    const terminal = state.session.last_terminal;
    const memory_budget_bytes = state.session.memory_budget_bytes;
    const has_metrics = state.session.has_metrics;
    const metrics = state.session.metrics;
    const accuracy_target = state.session.accuracy_target;
    const time_limit_seconds = state.session.time_limit_seconds;
    const gap_len = state.session.gap_series_len;
    var gap_buf: [poker_app.session.gap_series_capacity]poker_app.session.GapSeriesPoint = undefined;
    if (gap_len > 0) {
        @memcpy(gap_buf[0..gap_len], state.session.gap_series[0..gap_len]);
    }
    const runtime_opt = state.session.runtimeSeconds();
    var pot_chips: f64 = 0;
    var stack_chips: f64 = 0;
    if (state.session.game) |g| {
        pot_chips = poker_engine.poker.chips.tenthsToChips(g.pot);
        stack_chips = poker_engine.poker.chips.tenthsToChips(g.stack);
    }
    // Progress: committed CFR+ iterations only (ZR-145 / ZR-155). Browse-only
    // sessions without a trainer stamp fall back to published.trained.
    var iterations: i32 = state.session.last_committed_trained;
    if (state.session.training == null) {
        if (state.session.published) |published| {
            iterations = published.trained;
        }
    }
    state.session.mu.unlock();

    const allocated_bytes = state.session.allocatedBytes();
    const peak_allocated_bytes = state.session.peakAllocatedBytes();

    const begin_running = state.begin_running.load(.acquire);
    const train_running = state.train_running.load(.acquire);
    const running = begin_running or train_running or phase == .training or phase == .compiling;
    const paused = phase == .paused and !running;
    // While compile runs off-stdin, report compiling even though Session still
    // holds the prior solution until fail-closed install (ZR-120).
    const phase_name: []const u8 = if (begin_running) "compiling" else @tagName(phase);
    const iterations_requested = state.train_iterations_requested.load(.acquire);
    const time_limit_reached = terminal == .time_limit_reached;
    const budget_snap = state.snapshotBudget();

    // Copy owned strings under job_mu — train worker may free/replace them after unlock.
    var sticky_error_copy: ?[]u8 = null;
    defer if (sticky_error_copy) |c| allocator.free(c);
    var active_copy: ?[]u8 = null;
    defer if (active_copy) |c| allocator.free(c);

    state.job_mu.lock();
    const gen = state.status_generation.load(.acquire) + solution_id + policy_revision;
    if (state.last_error) |err| {
        sticky_error_copy = allocator.dupe(u8, err) catch {
            state.job_mu.unlock();
            return error.OutOfMemory;
        };
    }
    if (state.active_job_id) |jid| {
        active_copy = allocator.dupe(u8, jid) catch {
            state.job_mu.unlock();
            return error.OutOfMemory;
        };
    }
    state.job_mu.unlock();

    var cancelled = state.last_cancelled.load(.acquire) and !running;
    if (active_copy) |jid| {
        if (state.isCancelled(jid)) cancelled = true;
    }
    // ZR-130: sticky last_error marks failed even when Session errdefer kept
    // phase at `.published` (prior average still installed).
    const failed = (phase == .failed or sticky_error_copy != null) and !running;

    // Status honesty pairs (ZR-149): Continue implies resume-safe trainer;
    // peak covers live; failed idle snapshots are not "running".
    if (can_continue) std.debug.assert(has_training);
    if (!has_training) std.debug.assert(!can_continue);
    std.debug.assert(peak_allocated_bytes >= allocated_bytes);
    if (failed) std.debug.assert(!running);

    var list = std.ArrayList(u8).init(allocator);
    errdefer list.deinit();
    const w = list.writer();
    try w.writeAll("{\"running\":");
    try w.writeAll(if (running) "true" else "false");
    try w.writeAll(",\"paused\":");
    try w.writeAll(if (paused) "true" else "false");
    try w.writeAll(",\"cancelled\":");
    try w.writeAll(if (cancelled) "true" else "false");
    try w.writeAll(",\"failed\":");
    try w.writeAll(if (failed) "true" else "false");
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
    if (active_copy) |jid| {
        try w.writeAll(",\"job_id\":");
        try ipc.appendJsonString(&list, jid);
    } else {
        try w.writeAll(",\"job_id\":null");
    }
    try w.writeAll(",\"has_training\":");
    try w.writeAll(if (has_training) "true" else "false");
    try w.writeAll(",\"can_continue\":");
    try w.writeAll(if (can_continue) "true" else "false");
    // Sticky async-train code (null when clear). Desktop also reads legacy `error`.
    if (sticky_error_copy) |code| {
        try w.writeAll(",\"last_error\":");
        try ipc.appendJsonString(&list, code);
        try w.writeAll(",\"error\":");
        try ipc.appendJsonString(&list, code);
    } else {
        try w.writeAll(",\"last_error\":null,\"error\":\"\"");
    }
    try w.print(
        ",\"phase\":\"{s}\",\"iterations\":{d},\"iterations_requested\":{d},\"policy_revision\":{d},\"terminal_reason\":\"{s}\",\"workers_training\":{d},\"workers_analysis\":{d},\"threads\":{d},\"memory_budget_bytes\":{d},\"allocated_bytes\":{d},\"peak_allocated_bytes\":{d},\"engine_allocated\":{d},\"engine_peak\":{d},\"engine_heap_bytes\":{d}",
        .{
            phase_name,
            iterations,
            iterations_requested,
            policy_revision,
            @tagName(terminal),
            threads,
            budget_snap.analysis,
            threads,
            memory_budget_bytes,
            allocated_bytes,
            peak_allocated_bytes,
            allocated_bytes,
            peak_allocated_bytes,
            allocated_bytes,
        },
    );
    try w.writeAll(",\"time_limit_reached\":");
    try w.writeAll(if (time_limit_reached) "true" else "false");
    if (time_limit_seconds >= 0) {
        try w.print(",\"time_limit\":{d}", .{time_limit_seconds});
    } else {
        try w.writeAll(",\"time_limit\":null");
    }
    if (runtime_opt) |runtime| {
        try w.print(",\"runtime_seconds\":{d},\"runtime\":{d}", .{ runtime, runtime });
    } else {
        try w.writeAll(",\"runtime_seconds\":null,\"runtime\":null");
    }
    if (pot_chips > 0) {
        try w.print(",\"pot\":{d}", .{pot_chips});
    } else {
        try w.writeAll(",\"pot\":null");
    }
    if (stack_chips > 0) {
        try w.print(",\"stack\":{d}", .{stack_chips});
    } else {
        try w.writeAll(",\"stack\":null");
    }
    if (accuracy_target >= 0) {
        try w.print(",\"accuracy\":{d},\"accuracy_threshold\":{d}", .{ accuracy_target, accuracy_target });
    } else {
        try w.writeAll(",\"accuracy\":null,\"accuracy_threshold\":null");
    }
    if (has_metrics) {
        try w.print(
            ",\"value\":{d},\"player0_expected_utility\":{d},\"nash_gap\":{d},\"accuracy_chips\":{d},\"p1_best_response\":{d},\"p2_best_response\":{d}",
            .{ metrics.value, metrics.value, metrics.nash_gap, metrics.accuracy, metrics.br0, metrics.br1 },
        );
    } else {
        try w.writeAll(",\"value\":null,\"player0_expected_utility\":null,\"nash_gap\":null,\"accuracy_chips\":null,\"p1_best_response\":null,\"p2_best_response\":null");
    }
    try w.writeAll(",\"gap_series\":[");
    var gi: usize = 0;
    while (gi < gap_len) : (gi += 1) {
        if (gi > 0) try w.writeAll(",");
        const pt = gap_buf[gi];
        try w.print(
            "{{\"iterations\":{d},\"iteration\":{d},\"value\":{d},\"nash_gap\":{d},\"accuracy_chips\":{d}}}",
            .{ pt.iterations, pt.iterations, pt.value, pt.nash_gap, pt.accuracy_chips },
        );
    }
    try w.writeAll("],\"transport\":\"ipc\",\"sidecar\":\"solver-engine\"}");
    return try list.toOwnedSlice();
}

fn unescapeConfig(allocator: std.mem.Allocator, escaped: []const u8) ![]u8 {
    // Same JSON unescape as paths (handles Windows CRLF fixtures: `\r\n`).
    var raw = try ipc.unescapeJsonString(allocator, escaped);
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

    // Job-control ops (cancel/pause) must stay reachable for idempotent Stop/Pause
    // of the live id; other ops still reject a sticky cancelled job_id.
    if (state.isCancelled(req.job_id) and
        !std.mem.eql(u8, req.op, "cancel") and
        !std.mem.eql(u8, req.op, "pause"))
    {
        return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "cancelled", "job cancelled");
    }

    if (std.mem.eql(u8, req.op, "ready")) {
        var list = std.ArrayList(u8).init(state.allocator);
        errdefer list.deinit();
        const w = list.writer();
        const budget = state.snapshotBudget();
        try w.print("{{\"protocol\":{d},\"sidecar\":\"solver-engine\",\"launch_id\":", .{ipc.protocol_version});
        try ipc.appendJsonString(&list, state.launch_id);
        try w.print(",\"workers\":{d}}}", .{budget.total});
        const body = try list.toOwnedSlice();
        defer state.allocator.free(body);
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
        // Job-scoped Stop: only the live begin/train identity may requestStop.
        // Stale cancel for a finished/unknown job must not kill train-current.
        if (req.job_id) |jid| {
            if (!state.matchesActiveJob(jid)) {
                return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, "{\"cancelled\":false,\"reason\":\"not_running\"}");
            }
            try state.cancelJob(jid);
            // Cooperative stop at the next iteration / compile boundary (ZR-90).
            state.session.requestStop();
            return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, "{\"cancelled\":true}");
        }
        return ipc.makeErrorReply(state.allocator, req.request_id, null, req.op, "invalid_request", "cancel requires job_id");
    }

    if (std.mem.eql(u8, req.op, "begin_config")) {
        // Sync path for unit tests. Product stdin loop uses `startBeginConfig`
        // so flop compile cannot starve status/control (ZR-120).
        if (state.beginOrTrainBusy()) {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "busy", "begin or train already running");
        }
        const escaped = bodyStringField(req.body_json, "config_text") orelse
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "config_text required");
        const config = try unescapeConfig(state.allocator, escaped);
        defer state.allocator.free(config);
        state.session.begin(config) catch |err| {
            const code: []const u8 = if (err == error.BudgetExceeded) "budget_exceeded" else "begin_failed";
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, code, @errorName(err));
        };
        state.last_cancelled.store(false, .release);
        state.train_iterations_requested.store(0, .release);
        var buf: [64]u8 = undefined;
        const body = try std.fmt.bufPrint(&buf, "{{\"solution_id\":{d}}}", .{state.session.solution_id});
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, body);
    }

    // ZR-83 / ZR-156: side-effect-free preview/plan — never begin_config /
    // clearSolution. Sync path for unit tests; product stdin uses startTreePreview /
    // startPlanMemory. Compile under a draft-derived BudgetAllocator (not Session).
    //
    // ZR-158: refuse while begin/train run so preview does not race train's heap.
    if (std.mem.eql(u8, req.op, "tree_preview")) {
        if (state.beginOrTrainBusy()) {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "busy", "begin or train already running");
        }
        const escaped = bodyStringField(req.body_json, "config_text") orelse
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "config_text required");
        const config = try unescapeConfig(state.allocator, escaped);
        defer state.allocator.free(config);
        var bundle = poker_app.plan_preview.compilePreview(state.allocator, config) catch |err| {
            const code: []const u8 = if (err == error.OutOfMemory) "budget_exceeded" else "invalid_config";
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, code, @errorName(err));
        };
        defer bundle.deinit();
        // One compile yields tree + nested memory plan.
        const body = poker_app.plan_preview.formatTreePreviewJson(state.allocator, &bundle) catch |err| {
            const code: []const u8 = if (err == error.OutOfMemory) "out_of_memory" else "invalid_config";
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, code, @errorName(err));
        };
        defer state.allocator.free(body);
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, body);
    }

    if (std.mem.eql(u8, req.op, "plan_memory")) {
        if (state.beginOrTrainBusy()) {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "busy", "begin or train already running");
        }
        const escaped = bodyStringField(req.body_json, "config_text") orelse
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "config_text required");
        const config = try unescapeConfig(state.allocator, escaped);
        defer state.allocator.free(config);
        var bundle = poker_app.plan_preview.compilePreview(state.allocator, config) catch |err| {
            const code: []const u8 = if (err == error.OutOfMemory) "budget_exceeded" else "invalid_config";
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, code, @errorName(err));
        };
        defer bundle.deinit();
        var list = std.ArrayList(u8).init(state.allocator);
        errdefer list.deinit();
        poker_app.plan_preview.formatMemoryPlanJson(&list, bundle.plan) catch |err| {
            const code: []const u8 = if (err == error.OutOfMemory) "out_of_memory" else "invalid_config";
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, code, @errorName(err));
        };
        const body = list.toOwnedSlice() catch |err| {
            const code: []const u8 = if (err == error.OutOfMemory) "out_of_memory" else "invalid_config";
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, code, @errorName(err));
        };
        defer state.allocator.free(body);
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, body);
    }

    if (std.mem.eql(u8, req.op, "pause")) {
        // Same job scope as cancel: a stale Pause must not latch pause on train-current.
        if (req.job_id) |jid| {
            if (!state.matchesActiveJob(jid)) {
                return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, "{\"paused\":false,\"reason\":\"not_running\"}");
            }
        } else if (state.beginOrTrainBusy()) {
            return ipc.makeErrorReply(state.allocator, req.request_id, null, req.op, "invalid_request", "pause requires job_id while begin/train is active");
        }
        state.session.pause() catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "pause_failed", @errorName(err));
        };
        state.bumpStatusGeneration();
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, "{\"phase\":\"paused\"}");
    }

    if (std.mem.eql(u8, req.op, "save")) {
        const path = (try bodyUnescapedStringField(state.allocator, req.body_json, "path")) orelse
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "path required");
        defer state.allocator.free(path);
        const study_only = bodyBoolField(req.body_json, "study_only") orelse false;
        state.session.saveWithOptions(path, .{ .study_only = study_only }) catch |err| {
            const mapped = mapSaveError(err);
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, mapped.code, mapped.message);
        };
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, "{\"saved\":true}");
    }

    if (std.mem.eql(u8, req.op, "open")) {
        if (state.beginOrTrainBusy()) {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "busy", "begin or train already running");
        }
        const path = (try bodyUnescapedStringField(state.allocator, req.body_json, "path")) orelse
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "path required");
        defer state.allocator.free(path);
        state.session.open(path) catch |err| {
            const mapped = mapOpenError(err);
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, mapped.code, mapped.message);
        };
        state.last_cancelled.store(false, .release);
        try state.setActiveJob(null);
        // Same Study status shape as `status` so EngineClient.open can decodeStatusPayload.
        const body = try formatStatusBody(state.allocator, state);
        defer state.allocator.free(body);
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, body);
    }

    if (std.mem.eql(u8, req.op, "node")) {
        state.prioritizeAnalysisBudget(1);
        defer state.returnBudgetToTraining();
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
        const body = format_study_bodies.formatNodeBody(state.allocator, &page, located, lease.solution_id) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "inspect_failed", @errorName(err));
        };
        defer state.allocator.free(body);
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, body);
    }

    if (std.mem.eql(u8, req.op, "values")) {
        // Sync path for unit tests. Product stdin loop uses `startValues` (ZR-151).
        const threads = state.analysisThreadBudget();
        state.prioritizeAnalysisBudget(threads);
        defer state.returnBudgetToTraining();
        // Bounded wait for mid-train first publish (R10). Idle skips the wait (ZR-170).
        const wait_ns: u64 = 30 * std.time.ns_per_s;
        var lease = borrowPublishedForAnalysis(state, wait_ns) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "nothing_published", @errorName(err));
        };
        defer lease.deinit();
        return buildValuesReply(state, req.request_id, req.job_id, req.body_json, &lease, threads) catch |err| {
            const code: []const u8 = switch (err) {
                error.UnknownNode => "unknown_node",
                error.OutOfMemory => if (state.session.budget.limit() > 0) "budget_exceeded" else "oom",
                else => "values_failed",
            };
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, code, @errorName(err));
        };
    }

    if (std.mem.eql(u8, req.op, "prioritize_analysis")) {
        const want: u32 = @intCast(@max(bodyIntField(req.body_json, "workers") orelse 1, 0));
        state.prioritizeAnalysisBudget(want);
        return ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, "{\"ok\":true}");
    }

    if (std.mem.eql(u8, req.op, "equity")) {
        return handleEquity(state, req);
    }

    // Study Categories — sync path for unit tests. Product stdin uses startCategories (ZR-171).
    if (std.mem.eql(u8, req.op, "categories")) {
        return handleCategories(state, req);
    }

    // Dual-session Compare (baseline vs scenario). Sync — does not bump analysis gen
    // so Study node/values/equity are not superseded by a Compare workspace refresh.
    if (std.mem.eql(u8, req.op, "compare")) {
        return handleCompare(state, req);
    }

    // Fat Study reports (Compare runouts / Value-Bluffs after-call). Product uses start* off stdin.
    if (std.mem.eql(u8, req.op, "line_card_report")) {
        state.prioritizeAnalysisBudget(1);
        defer state.returnBudgetToTraining();
        const wait_ns: u64 = 30 * std.time.ns_per_s;
        var lease = borrowPublishedForAnalysis(state, wait_ns) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "nothing_published", @errorName(err));
        };
        defer lease.deinit();
        return buildLineCardReportReply(state, req.request_id, req.job_id, req.body_json, &lease) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "line_card_report_failed", @errorName(err));
        };
    }
    if (std.mem.eql(u8, req.op, "value_bluffs_post_call")) {
        state.prioritizeAnalysisBudget(1);
        defer state.returnBudgetToTraining();
        const wait_ns: u64 = 30 * std.time.ns_per_s;
        var lease = borrowPublishedForAnalysis(state, wait_ns) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "nothing_published", @errorName(err));
        };
        defer lease.deinit();
        return buildValueBluffsPostCallReply(state, req.request_id, req.job_id, req.body_json, &lease) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "value_bluffs_post_call_failed", @errorName(err));
        };
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
        return handlePutLock(state, req);
    }

    if (std.mem.eql(u8, req.op, "delete_lock")) {
        return handleDeleteLock(state, req);
    }

    // Study strategy-edits CRUD over Session.strategy_edits_text + published average overlays.
    if (std.mem.eql(u8, req.op, "list_strategy_edits")) {
        if (state.session.solution_id == 0) {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "nothing_published", "no solution");
        }
        var edits = strategy_edits_json.parseSessionStrategyEdits(state.allocator, state.session.strategy_edits_text) catch |err| {
            return ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_strategy_edits", @errorName(err));
        };
        defer edits.deinit();
        return replyStrategyEditsBody(state, req, &edits);
    }

    if (std.mem.eql(u8, req.op, "put_strategy_edit")) {
        return handlePutStrategyEdit(state, req);
    }

    if (std.mem.eql(u8, req.op, "delete_strategy_edit")) {
        return handleDeleteStrategyEdit(state, req);
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
        state.bumpStatusGeneration();
        state.allocator.free(task.request_id);
        if (task.job_id) |j| {
            // Allow a fresh job id after stop; sticky cancel only while in-flight.
            state.clearCancelled(j);
            state.clearActiveJobIfMatch(j);
            state.allocator.free(j);
        }
        state.allocator.free(task.op);
        state.allocator.destroy(task);
    }

    // ZR-171: always use trainGated so Study footer gets Acc/EV/ETA samples even
    // for iteration-only jobs (accuracy ≤ 0). Accuracy/time early-stop still honor
    // positive targets. Admission already replied (ZR-106); faults → sticky last_error.
    state.session.trainGated(task.iterations, task.accuracy, task.eval_every, task.time_limit) catch |err| {
        state.setLastError(@errorName(err));
        return;
    };
    state.clearLastError();
}

/// ZR-106 short-admit JSON (Study polls `status` for completion).
fn formatTrainAdmitBody(buf: []u8, solution_id: u64, threads: u32) ![]u8 {
    return std.fmt.bufPrint(
        buf,
        "{{\"accepted\":true,\"running\":true,\"solution_id\":{d},\"async\":true,\"threads\":{d}}}",
        .{ solution_id, threads },
    );
}

fn writeTrainAdmitReply(state: *HostState, req: ipc.Envelope) !void {
    var buf: [192]u8 = undefined;
    const body = try formatTrainAdmitBody(&buf, state.session.solution_id, state.session.threads);
    var reply = try ipc.makeReply(state.allocator, req.request_id, req.job_id, req.op, body);
    defer reply.deinit();
    try state.writeReply(reply);
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

    if (state.begin_running.load(.acquire)) {
        var err_reply = try ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "busy", "begin_config still compiling");
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

fn spawnTrainWorker(state: *HostState, req: ipc.Envelope) !enum { ok, replied } {
    const iterations = bodyIntField(req.body_json, "iterations") orelse 1;
    const accuracy = bodyFloatField(req.body_json, "accuracy") orelse 0;
    const time_limit = bodyFloatField(req.body_json, "time_limit") orelse -1;
    // Study Settings "Samples" = desired EV/gap refresh count. Cap cadence at 10
    // iters so the footer never waits longer (DESKTOP_UI / ZR-171). When Samples
    // is omitted (IPC smoke / gate-bench), default to publish_every (10) so
    // progress sampling aligns with ZR-133 strategy cadence — not every iter.
    // Explicit `eval_every` still wins when callers set it.
    const samples = bodyIntField(req.body_json, "samples");
    const job_iters: i32 = if (iterations < 1) 1 else iterations;
    const eval_every = bodyIntField(req.body_json, "eval_every") orelse blk: {
        if (samples) |s| {
            const refresh_count: i32 = if (s < 1) 1 else s;
            const period = @divTrunc(job_iters + refresh_count - 1, refresh_count);
            break :blk @max(@as(i32, 1), @min(@as(i32, 10), period));
        }
        break :blk @max(@as(i32, 1), state.session.publish_every);
    };
    state.returnBudgetToTraining();
    // Honor config threads; never raise above Session/config (ZR-91). Cap by host
    // budget so MT flop train cannot pin every core and starve the IPC stdin loop
    // (Windows installed Study: status-poll-hung while sidecar is CPU-hot).
    const budget_snap = state.snapshotBudget();
    const train_cap = if (budget_snap.training > 0)
        budget_snap.training
    else
        workers.WorkerBudget.maxTrainThreads(budget_snap.total);
    if (state.session.threads > train_cap) {
        state.session.setThreads(train_cap);
    }
    state.session.clearControlFlags();
    state.last_cancelled.store(false, .release);
    // Fresh job: drop sticky train fault so status is not still "failed".
    state.clearLastError();
    try state.setActiveJob(req.job_id);

    // Absolute target for Study progress: start_trained + this job's iterations.
    state.session.mu.lock();
    const start_trained: i32 = if (state.session.training) |*training| training.trained else 0;
    state.session.mu.unlock();
    state.train_iterations_requested.store(start_trained + job_iters, .release);

    // Stage owned strings in a block so mid-OOM cannot leak, then transfer to task
    // (same pattern as startBeginConfig / startAnalysis — ZR-180).
    const task = blk: {
        const request_id = try state.allocator.dupe(u8, req.request_id);
        errdefer state.allocator.free(request_id);
        const job_id: ?[]u8 = if (req.job_id) |j| try state.allocator.dupe(u8, j) else null;
        errdefer if (job_id) |j| state.allocator.free(j);
        const op = try state.allocator.dupe(u8, req.op);
        errdefer state.allocator.free(op);
        const created = try state.allocator.create(TrainTask);
        created.* = .{
            .state = state,
            .request_id = request_id,
            .job_id = job_id,
            .op = op,
            .iterations = iterations,
            .accuracy = accuracy,
            .time_limit = time_limit,
            .eval_every = eval_every,
        };
        break :blk created;
    };
    var worker_owns_task = false;
    errdefer if (!worker_owns_task) {
        state.allocator.free(task.request_id);
        if (task.job_id) |j| state.allocator.free(j);
        state.allocator.free(task.op);
        state.allocator.destroy(task);
    };

    state.train_running.store(true, .release);
    state.train_thread = std.Thread.spawn(.{}, trainWorker, .{task}) catch |err| {
        state.train_running.store(false, .release);
        state.clearActiveJobIfMatch(req.job_id);
        state.allocator.free(task.request_id);
        if (task.job_id) |j| state.allocator.free(j);
        state.allocator.free(task.op);
        state.allocator.destroy(task);
        worker_owns_task = true;
        state.untrack(req.request_id);
        var err_reply = try ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "solve_failed", @errorName(err));
        defer err_reply.deinit();
        try state.writeReply(err_reply);
        return .replied;
    };
    worker_owns_task = true;
    return .ok;
}

fn beginWorker(task: *BeginTask) void {
    const state = task.state;
    defer {
        state.untrack(task.request_id);
        state.begin_running.store(false, .release);
        state.bumpStatusGeneration();
        state.allocator.free(task.request_id);
        if (task.job_id) |j| {
            state.clearCancelled(j);
            state.clearActiveJobIfMatch(j);
            state.allocator.free(j);
        }
        state.allocator.free(task.config);
        state.allocator.destroy(task);
    }

    state.session.begin(task.config) catch |err| {
        const code: []const u8 = switch (err) {
            error.BudgetExceeded => "budget_exceeded",
            error.Cancelled => "cancelled",
            else => "begin_failed",
        };
        var err_reply = ipc.makeErrorReply(state.allocator, task.request_id, task.job_id, "begin_config", code, @errorName(err)) catch return;
        defer err_reply.deinit();
        // Intentional best-effort: worker exit must not panic if stdout is gone.
        state.writeReply(err_reply) catch {};
        return;
    };
    state.last_cancelled.store(false, .release);
    state.train_iterations_requested.store(0, .release);
    state.clearLastError();
    var buf: [64]u8 = undefined;
    const body = std.fmt.bufPrint(&buf, "{{\"solution_id\":{d}}}", .{state.session.solution_id}) catch return;
    var reply = ipc.makeReply(state.allocator, task.request_id, task.job_id, "begin_config", body) catch return;
    defer reply.deinit();
    // Intentional best-effort: same short-admit honesty as train — do not
    // escalate a late write failure into a worker abort after Session installed.
    state.writeReply(reply) catch {};
}

/// Compile street-config off the stdin loop so Study `status` stays live during flop tree
/// build (ZR-120). Reply shape matches sync `begin_config` (solution_id on success).
pub fn startBeginConfig(state: *HostState, req: ipc.Envelope) !void {
    try state.track(req.request_id);
    errdefer state.untrack(req.request_id);

    if (state.beginOrTrainBusy()) {
        var err_reply = try ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "busy", "begin or train already running");
        defer err_reply.deinit();
        state.untrack(req.request_id);
        try state.writeReply(err_reply);
        return;
    }
    state.session.mu.lock();
    const replace_busy = state.session.phase == .training or state.session.phase == .compiling;
    state.session.mu.unlock();
    if (replace_busy) {
        var err_reply = try ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "busy", "session busy");
        defer err_reply.deinit();
        state.untrack(req.request_id);
        try state.writeReply(err_reply);
        return;
    }

    const escaped = bodyStringField(req.body_json, "config_text") orelse {
        var err_reply = try ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "config_text required");
        defer err_reply.deinit();
        state.untrack(req.request_id);
        try state.writeReply(err_reply);
        return;
    };
    const config = unescapeConfig(state.allocator, escaped) catch |err| {
        var err_reply = try ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", @errorName(err));
        defer err_reply.deinit();
        state.untrack(req.request_id);
        try state.writeReply(err_reply);
        return;
    };
    var config_owned = true;
    errdefer if (config_owned) state.allocator.free(config);

    // Reap a prior begin worker handle before spawning another.
    state.joinBegin();

    const task = blk: {
        const request_id = try state.allocator.dupe(u8, req.request_id);
        errdefer state.allocator.free(request_id);
        const job_id: ?[]u8 = if (req.job_id) |j| try state.allocator.dupe(u8, j) else null;
        errdefer if (job_id) |j| state.allocator.free(j);
        const created = try state.allocator.create(BeginTask);
        created.* = .{
            .state = state,
            .request_id = request_id,
            .job_id = job_id,
            .config = config,
        };
        config_owned = false;
        break :blk created;
    };
    // Worker (or spawn-failure path below) owns the task allocation from here.
    var worker_owns_task = false;
    errdefer if (!worker_owns_task) {
        state.allocator.free(task.request_id);
        if (task.job_id) |j| state.allocator.free(j);
        state.allocator.free(task.config);
        state.allocator.destroy(task);
    };

    // Register compile identity before dispatch so Stop can cancel this begin.
    try state.setActiveJob(req.job_id);
    state.last_cancelled.store(false, .release);
    state.begin_running.store(true, .release);
    state.bumpStatusGeneration();
    state.begin_thread = std.Thread.spawn(.{}, beginWorker, .{task}) catch |err| {
        state.begin_running.store(false, .release);
        state.clearActiveJobIfMatch(req.job_id);
        state.allocator.free(task.request_id);
        if (task.job_id) |j| state.allocator.free(j);
        state.allocator.free(task.config);
        state.allocator.destroy(task);
        worker_owns_task = true;
        state.untrack(req.request_id);
        var err_reply = try ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "begin_failed", @errorName(err));
        defer err_reply.deinit();
        try state.writeReply(err_reply);
        return;
    };
    worker_owns_task = true;
}

/// Spawn background CFR+ train so the stdin loop can serve `values` mid-train (R10).
/// Writes a short admit reply immediately; Study polls `status` for completion (ZR-90/ZR-106).
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
    switch (try spawnTrainWorker(state, req)) {
        .replied => return,
        .ok => try writeTrainAdmitReply(state, req),
    }
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

    switch (try spawnTrainWorker(state, req)) {
        .replied => return,
        .ok => try writeTrainAdmitReply(state, req),
    }
}

fn analysisSupersededReply(state: *HostState, task: *AnalysisTask) void {
    var err_reply = ipc.makeErrorReply(
        state.allocator,
        task.request_id,
        task.job_id,
        task.op,
        "superseded",
        "analysis superseded by a newer node request",
    ) catch return;
    defer err_reply.deinit();
    state.writeReply(err_reply) catch {};
}

/// Borrow published policy for analysis.
///
/// Mid-train / mid-begin may race the first publish, so wait up to `wait_ns`
/// (ZR-151). Idle / paused / failed sessions have no pending publish — fail
/// immediately with `NothingPublished` instead of burning the full wait
/// (ZR-170 stress: idle `values` was a 30s no-op).
fn borrowPublishedForAnalysis(
    state: *HostState,
    wait_ns: u64,
) poker_app.session.SessionError!poker_app.PublishedLease {
    const phase = state.session.phase;
    const expect_publish = state.beginOrTrainBusy() or phase == .training or phase == .compiling;
    if (expect_publish) {
        return state.session.borrowPublishedWait(wait_ns);
    }
    return state.session.borrowPublished();
}

fn analysisWorker(task: *AnalysisTask) void {
    const state = task.state;
    var budget_held = false;
    defer {
        state.untrack(task.request_id);
        if (budget_held) {
            // Gen-scoped: superseded workers must not clear shared budget/running.
            state.finishAnalysisSlot(task.gen);
        } else if (state.analysisGenCurrent(task.gen)) {
            // Never borrowed budget (early supersede / nothing_published) but still
            // own the running slot if we are current.
            state.analysis_running.store(false, .release);
        }
        state.allocator.free(task.request_id);
        if (task.job_id) |j| state.allocator.free(j);
        state.allocator.free(task.op);
        state.allocator.free(task.body_json);
        state.allocator.destroy(task);
    }

    if (!state.analysisGenCurrent(task.gen)) {
        analysisSupersededReply(state, task);
        return;
    }

    const analysis_threads = state.analysisThreadBudget();
    state.prioritizeAnalysisBudget(analysis_threads);
    budget_held = true;

    // Bound the policy wait so a hung publish cannot pin analysis forever; the
    // stdin loop stays free for Stop/status either way (ZR-151). Idle sessions
    // skip the wait (ZR-170).
    const wait_ns: u64 = 30 * std.time.ns_per_s;
    var lease = borrowPublishedForAnalysis(state, wait_ns) catch |err| {
        if (!state.analysisGenCurrent(task.gen)) {
            analysisSupersededReply(state, task);
            return;
        }
        var err_reply = ipc.makeErrorReply(state.allocator, task.request_id, task.job_id, task.op, "nothing_published", @errorName(err)) catch return;
        defer err_reply.deinit();
        state.writeReply(err_reply) catch {};
        return;
    };

    if (!state.analysisGenCurrent(task.gen)) {
        lease.deinit();
        analysisSupersededReply(state, task);
        return;
    }

    var reply = switch (task.kind) {
        .values => buildValuesReply(state, task.request_id, task.job_id, task.body_json, &lease, analysis_threads) catch |err| blk: {
            break :blk ipc.makeErrorReply(state.allocator, task.request_id, task.job_id, task.op, "values_failed", @errorName(err)) catch {
                lease.deinit();
                return;
            };
        },
        .equity => buildEquityReply(state, task.request_id, task.job_id, task.body_json, &lease) catch |err| blk: {
            break :blk ipc.makeErrorReply(state.allocator, task.request_id, task.job_id, task.op, "equity_failed", @errorName(err)) catch {
                lease.deinit();
                return;
            };
        },
        .node => buildNodeReply(state, task.request_id, task.job_id, task.body_json, &lease) catch |err| blk: {
            break :blk ipc.makeErrorReply(state.allocator, task.request_id, task.job_id, task.op, "inspect_failed", @errorName(err)) catch {
                lease.deinit();
                return;
            };
        },
        .categories => buildCategoriesReply(state, task.request_id, task.job_id, task.body_json, &lease) catch |err| blk: {
            const code: []const u8 = if (err == error.OutOfMemory and state.session.budget.limit() > 0)
                "budget_exceeded"
            else if (err == error.WorkLimit)
                "work_limit"
            else if (err == error.InvalidWeight)
                "invalid_weight"
            else
                "categories_failed";
            break :blk ipc.makeErrorReply(state.allocator, task.request_id, task.job_id, task.op, code, @errorName(err)) catch {
                lease.deinit();
                return;
            };
        },
        .line_card_report => buildLineCardReportReply(state, task.request_id, task.job_id, task.body_json, &lease) catch |err| blk: {
            break :blk ipc.makeErrorReply(state.allocator, task.request_id, task.job_id, task.op, "line_card_report_failed", @errorName(err)) catch {
                lease.deinit();
                return;
            };
        },
        .value_bluffs_post_call => buildValueBluffsPostCallReply(state, task.request_id, task.job_id, task.body_json, &lease) catch |err| blk: {
            break :blk ipc.makeErrorReply(state.allocator, task.request_id, task.job_id, task.op, "value_bluffs_post_call_failed", @errorName(err)) catch {
                lease.deinit();
                return;
            };
        },
    };
    // Reply body is owned JSON — release the publish lease before the blocking
    // stdout write so publish/replace is not held behind a large frame (audit #3).
    lease.deinit();
    defer reply.deinit();

    if (!state.analysisGenCurrent(task.gen)) {
        analysisSupersededReply(state, task);
        return;
    }
    state.writeReply(reply) catch {};
}

fn buildValuesReply(
    state: *HostState,
    request_id: []const u8,
    job_id: ?[]const u8,
    body_json: []const u8,
    lease: *poker_app.PublishedLease,
    threads: u32,
) !ipc.Envelope {
    const located = try resolveLocatedNode(lease.game, body_json);
    const t0 = std.time.nanoTimestamp();
    // Post-solve: reuse Session FrozenCtx ranks (avoid rebuilding flop/turn tables).
    // Starting-board decisions (root + facing) share the warm path — deal-by-deal
    // on wide flop Root x never finishes in time for Study overlays.
    // Mid-train / no warm ctx: fall back to a private eval ctx (#384 threaded walk).
    var page: poker_engine.analysis.action_ev.ActionValues = undefined;
    var held_ctx = false;
    if (located.turn < 0 and located.river < 0) {
        if (state.session.acquireFrozenCtxForAnalysis()) |ctx| {
            held_ctx = true;
            const serial_chance = ctx.threads <= 1;
            page = poker_engine.analysis.action_ev.actionValuesFrozenOnCtx(
                state.session.allocator,
                ctx,
                lease.game,
                lease.published,
                located.node_index,
                serial_chance,
            ) catch |err| {
                state.session.releaseFrozenCtxForAnalysis();
                return err;
            };
        } else |_| {
            page = try poker_engine.analysis.action_ev.actionValuesWithThreads(
                state.session.allocator,
                lease.game,
                lease.published,
                located.node_index,
                located.turn,
                located.river,
                threads,
            );
        }
    } else {
        page = try poker_engine.analysis.action_ev.actionValuesWithThreads(
            state.session.allocator,
            lease.game,
            lease.published,
            located.node_index,
            located.turn,
            located.river,
            threads,
        );
    }
    defer {
        page.deinit();
        if (held_ctx) state.session.releaseFrozenCtxForAnalysis();
    }
    const elapsed_ns = std.time.nanoTimestamp() - t0;
    const elapsed_ms = @divTrunc(elapsed_ns, 1_000_000);

    // Inspect marginal for 169-cell EV aggregates (Study groupEv hotspot).
    var marginal_owned: ?[]f32 = null;
    defer if (marginal_owned) |m| state.allocator.free(m);
    {
        var insp = poker_engine.analysis.inspect.inspectNode(
            state.allocator,
            lease.game,
            lease.published,
            located.node_index,
            located.turn,
            located.river,
        ) catch null;
        if (insp) |*node_page| {
            defer node_page.deinit();
            if (node_page.reach_defined and node_page.marginal.len != 0) {
                marginal_owned = format_study_bodies.marginalForValuesCombos(
                    state.allocator,
                    page.combos,
                    node_page.combos,
                    node_page.marginal,
                ) catch null;
            }
        }
    }

    const body = try format_study_bodies.formatValuesBody(
        state.allocator,
        &page,
        located,
        lease.solution_id,
        elapsed_ms,
        state.train_running.load(.acquire),
        marginal_owned,
    );
    defer state.allocator.free(body);
    return ipc.makeReply(state.allocator, request_id, job_id, "values", body);
}

fn buildEquityReply(
    state: *HostState,
    request_id: []const u8,
    job_id: ?[]const u8,
    body_json: []const u8,
    lease: *poker_app.PublishedLease,
) !ipc.Envelope {
    // Reuse handleEquity shape via a temporary envelope — keep packing local.
    const located = resolveLocatedNode(lease.game, body_json) catch |err| {
        const code: []const u8 = switch (err) {
            error.UnknownNode => "unknown_node",
            error.OutOfMemory => "oom",
        };
        return ipc.makeErrorReply(state.allocator, request_id, job_id, "equity", code, @errorName(err));
    };
    const node_id_text = try poker_engine.analysis.node_id.formatNodeId(
        state.allocator,
        located.node_index,
        located.turn,
        located.river,
    );
    defer state.allocator.free(node_id_text);
    const t0 = std.time.nanoTimestamp();
    var held_ctx = false;
    var page = computeStudyEquity(state, lease, located, &held_ctx) catch |err| {
        if (held_ctx) state.session.releaseFrozenCtxForAnalysis();
        const code: []const u8 = switch (err) {
            error.WorkLimit => "work_limit",
            error.InvalidEquity => "invalid_equity",
            error.InvalidWeight => "invalid_weight",
            error.OutOfMemory => if (state.session.budget.limit() > 0) "budget_exceeded" else "oom",
        };
        return ipc.makeErrorReply(state.allocator, request_id, job_id, "equity", code, @errorName(err));
    };
    defer {
        page.deinit();
        if (held_ctx) state.session.releaseFrozenCtxForAnalysis();
    }
    const elapsed_ns = std.time.nanoTimestamp() - t0;
    const elapsed_ms: i64 = @intCast(@divTrunc(elapsed_ns, 1_000_000));
    const query_seconds: f64 = @as(f64, @floatFromInt(elapsed_ns)) / 1e9;
    const body = try equity_json.packStudyEquityBody(state.allocator, .{
        .solution_id = lease.solution_id,
        .node_id = node_id_text,
        .node_index = located.node_index,
        .policy_revision = state.session.policyRevision(),
        .status_generation = state.session.solution_id + state.session.policyRevision(),
        .query_seconds = query_seconds,
        .elapsed_ms = elapsed_ms,
        .live_under_train = state.train_running.load(.acquire),
        .page = &page,
    });
    defer state.allocator.free(body);
    return ipc.makeReply(state.allocator, request_id, job_id, "equity", body);
}

fn buildCategoriesReply(
    state: *HostState,
    request_id: []const u8,
    job_id: ?[]const u8,
    body_json: []const u8,
    lease: *poker_app.PublishedLease,
) !ipc.Envelope {
    const located = try resolveLocatedNode(lease.game, body_json);
    const node_id_text = try poker_engine.analysis.node_id.formatNodeId(
        state.allocator,
        located.node_index,
        located.turn,
        located.river,
    );
    defer state.allocator.free(node_id_text);
    const t0 = std.time.nanoTimestamp();
    const report = try poker_engine.analysis.categories.categoriesAtNode(
        state.session.allocator,
        lease.game,
        lease.published,
        located.node_index,
        located.turn,
        located.river,
    );
    const elapsed_ns = std.time.nanoTimestamp() - t0;
    const query_seconds: f64 = @as(f64, @floatFromInt(elapsed_ns)) / 1e9;
    const body = try categories_json.packStudyCategoriesBody(state.allocator, .{
        .solution_id = lease.solution_id,
        .node_id = node_id_text,
        .policy_revision = state.session.policyRevision(),
        .query_seconds = query_seconds,
        .report = &report,
    });
    defer state.allocator.free(body);
    return ipc.makeReply(state.allocator, request_id, job_id, "categories", body);
}

fn buildNodeReply(
    state: *HostState,
    request_id: []const u8,
    job_id: ?[]const u8,
    body_json: []const u8,
    lease: *poker_app.PublishedLease,
) !ipc.Envelope {
    const located = try resolveLocatedNode(lease.game, body_json);
    var page = try poker_engine.analysis.inspect.inspectNode(
        state.allocator,
        lease.game,
        lease.published,
        located.node_index,
        located.turn,
        located.river,
    );
    defer page.deinit();
    const body = try format_study_bodies.formatNodeBody(state.allocator, &page, located, lease.solution_id);
    defer state.allocator.free(body);
    return ipc.makeReply(state.allocator, request_id, job_id, "node", body);
}

fn startAnalysis(state: *HostState, req: ipc.Envelope, kind: AnalysisKind) !void {
    try state.track(req.request_id);
    errdefer state.untrack(req.request_id);

    // Coalesce: bump gen so any in-flight older analysis replies superseded.
    const gen = state.bumpAnalysisGen();

    const request_id = try state.allocator.dupe(u8, req.request_id);
    errdefer state.allocator.free(request_id);
    const job_id: ?[]u8 = if (req.job_id) |j| try state.allocator.dupe(u8, j) else null;
    errdefer if (job_id) |j| state.allocator.free(j);
    const op = try state.allocator.dupe(u8, req.op);
    errdefer state.allocator.free(op);
    const body_json = try state.allocator.dupe(u8, req.body_json);
    errdefer state.allocator.free(body_json);

    const task = try state.allocator.create(AnalysisTask);
    errdefer state.allocator.destroy(task);
    task.* = .{
        .state = state,
        .request_id = request_id,
        .job_id = job_id,
        .op = op,
        .body_json = body_json,
        .kind = kind,
        .gen = gen,
    };

    // Park prior join handle (bounded orphans) — never detach (audit #3).
    state.retireAnalysisThread();

    state.analysis_running.store(true, .release);
    state.analysis_thread = std.Thread.spawn(.{}, analysisWorker, .{task}) catch |err| {
        state.analysis_running.store(false, .release);
        state.allocator.free(task.request_id);
        if (task.job_id) |j| state.allocator.free(j);
        state.allocator.free(task.op);
        state.allocator.free(task.body_json);
        state.allocator.destroy(task);
        state.untrack(req.request_id);
        var err_reply = try ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "host_error", @errorName(err));
        defer err_reply.deinit();
        try state.writeReply(err_reply);
        return;
    };
}

pub fn startValues(state: *HostState, req: ipc.Envelope) !void {
    try startAnalysis(state, req, .values);
}

pub fn startEquity(state: *HostState, req: ipc.Envelope) !void {
    try startAnalysis(state, req, .equity);
}

pub fn startNode(state: *HostState, req: ipc.Envelope) !void {
    try startAnalysis(state, req, .node);
}

pub fn startCategories(state: *HostState, req: ipc.Envelope) !void {
    try startAnalysis(state, req, .categories);
}

pub fn startLineCardReport(state: *HostState, req: ipc.Envelope) !void {
    try startAnalysis(state, req, .line_card_report);
}

pub fn startValueBluffsPostCall(state: *HostState, req: ipc.Envelope) !void {
    try startAnalysis(state, req, .value_bluffs_post_call);
}

fn buildLineCardReportReply(
    state: *HostState,
    request_id: []const u8,
    job_id: ?[]const u8,
    body_json: []const u8,
    lease: *poker_app.PublishedLease,
) !ipc.Envelope {
    const located = try resolveLocatedNode(lease.game, body_json);
    const vary = bodyStringField(body_json, "vary_street");
    const body = try study_reports.buildLineCardReportBody(
        state.allocator,
        lease.game,
        lease.published,
        located,
        lease.solution_id,
        vary,
    );
    defer state.allocator.free(body);
    return ipc.makeReply(state.allocator, request_id, job_id, "line_card_report", body);
}

fn buildValueBluffsPostCallReply(
    state: *HostState,
    request_id: []const u8,
    job_id: ?[]const u8,
    body_json: []const u8,
    lease: *poker_app.PublishedLease,
) !ipc.Envelope {
    const located = try resolveLocatedNode(lease.game, body_json);
    const min_bet = bodyFloatField(body_json, "min_bet_freq") orelse 0.01;
    // Prefer warm FrozenCtx (same as Study equity); cold pair path mid-train.
    var held_ctx = false;
    const warm_ctx: ?*poker_engine.solve.frozen_walk.FrozenCtx = blk: {
        if (state.session.acquireFrozenCtxForAnalysis()) |ctx| {
            held_ctx = true;
            break :blk ctx;
        } else |_| break :blk null;
    };
    defer if (held_ctx) state.session.releaseFrozenCtxForAnalysis();
    const body = try study_reports.buildValueBluffsPostCallBody(
        state.allocator,
        lease.game,
        lease.published,
        located,
        lease.solution_id,
        min_bet,
        warm_ctx,
    );
    defer state.allocator.free(body);
    return ipc.makeReply(state.allocator, request_id, job_id, "value_bluffs_post_call", body);
}

fn ioWorker(task: *IoTask) void {
    const state = task.state;
    defer {
        state.untrack(task.request_id);
        state.io_running.store(false, .release);
        state.allocator.free(task.request_id);
        if (task.job_id) |j| state.allocator.free(j);
        state.allocator.free(task.op);
        state.allocator.free(task.path);
        state.allocator.destroy(task);
    }

    switch (task.kind) {
        .save => {
            state.session.saveWithOptions(task.path, .{ .study_only = task.study_only }) catch |err| {
                const mapped = mapSaveError(err);
                var err_reply = ipc.makeErrorReply(state.allocator, task.request_id, task.job_id, task.op, mapped.code, mapped.message) catch return;
                defer err_reply.deinit();
                state.writeReply(err_reply) catch {};
                return;
            };
            var reply = ipc.makeReply(state.allocator, task.request_id, task.job_id, task.op, "{\"saved\":true}") catch return;
            defer reply.deinit();
            state.writeReply(reply) catch {};
        },
        .open => {
            state.session.open(task.path) catch |err| {
                const mapped = mapOpenError(err);
                var err_reply = ipc.makeErrorReply(state.allocator, task.request_id, task.job_id, task.op, mapped.code, mapped.message) catch return;
                defer err_reply.deinit();
                state.writeReply(err_reply) catch {};
                return;
            };
            state.last_cancelled.store(false, .release);
            state.setActiveJob(null) catch {};
            const body = formatStatusBody(state.allocator, state) catch return;
            defer state.allocator.free(body);
            var reply = ipc.makeReply(state.allocator, task.request_id, task.job_id, task.op, body) catch return;
            defer reply.deinit();
            state.writeReply(reply) catch {};
        },
    }
}

fn startIo(state: *HostState, req: ipc.Envelope, kind: IoKind, path: []u8, study_only: bool) !void {
    // Caller transferred path ownership. Free on every early-exit before worker owns it.
    var path_owned = true;
    errdefer if (path_owned) state.allocator.free(path);

    try state.track(req.request_id);
    errdefer state.untrack(req.request_id);

    // Serialize Save/Open: reject if busy rather than block Stop on the stdin loop.
    if (state.io_running.load(.acquire)) {
        var err_reply = try ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "busy", "save or open already running");
        defer err_reply.deinit();
        state.untrack(req.request_id);
        try state.writeReply(err_reply);
        return;
    }
    state.joinIo();

    const request_id = try state.allocator.dupe(u8, req.request_id);
    errdefer state.allocator.free(request_id);
    const job_id: ?[]u8 = if (req.job_id) |j| try state.allocator.dupe(u8, j) else null;
    errdefer if (job_id) |j| state.allocator.free(j);
    const op = try state.allocator.dupe(u8, req.op);
    errdefer state.allocator.free(op);

    const task = try state.allocator.create(IoTask);
    errdefer state.allocator.destroy(task);
    task.* = .{
        .state = state,
        .request_id = request_id,
        .job_id = job_id,
        .op = op,
        .path = path,
        .kind = kind,
        .study_only = study_only,
    };
    path_owned = false;

    state.io_running.store(true, .release);
    state.io_thread = std.Thread.spawn(.{}, ioWorker, .{task}) catch |err| {
        state.io_running.store(false, .release);
        state.allocator.free(task.request_id);
        if (task.job_id) |j| state.allocator.free(j);
        state.allocator.free(task.op);
        state.allocator.free(task.path);
        state.allocator.destroy(task);
        state.untrack(req.request_id);
        var err_reply = try ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "host_error", @errorName(err));
        defer err_reply.deinit();
        try state.writeReply(err_reply);
        return;
    };
}

fn mapSaveError(err: anyerror) struct { code: []const u8, message: []const u8 } {
    return switch (err) {
        error.BudgetExceeded => .{
            .code = "budget_exceeded",
            .message = "Save exceeded the memory budget",
        },
        error.PsolTooLarge => .{
            .code = "psol_too_large",
            .message = "Solution file exceeds the 4 GiB save limit",
        },
        error.Busy => .{
            .code = "busy",
            .message = "Engine is busy; wait for the current job to finish",
        },
        error.NothingPublished => .{
            .code = "nothing_published",
            .message = "Nothing to save — solve first",
        },
        else => .{
            .code = "save_failed",
            .message = @errorName(err),
        },
    };
}

fn mapOpenError(err: anyerror) struct { code: []const u8, message: []const u8 } {
    return switch (err) {
        error.InvalidStrategy => .{ .code = "invalid_strategy", .message = @errorName(err) },
        error.Busy => .{ .code = "busy", .message = @errorName(err) },
        error.BudgetExceeded => .{ .code = "budget_exceeded", .message = @errorName(err) },
        error.PsolTooLarge => .{
            .code = "psol_too_large",
            .message = "Solution file exceeds the 4 GiB open limit",
        },
        error.IncompatibleSave => .{
            .code = "incompatible_save",
            .message = "Incompatible save: reopened tree/strategy does not match this checkpoint. Rebuild the tree in Study (0.1.6 allow-all-in / oversize rules diverged from current DS-26).",
        },
        else => .{ .code = "open_failed", .message = @errorName(err) },
    };
}

pub fn startSave(state: *HostState, req: ipc.Envelope) !void {
    const path = (try bodyUnescapedStringField(state.allocator, req.body_json, "path")) orelse {
        var err_reply = try ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "path required");
        defer err_reply.deinit();
        try state.writeReply(err_reply);
        return;
    };
    const study_only = bodyBoolField(req.body_json, "study_only") orelse false;
    try startIo(state, req, .save, path, study_only);
}

pub fn startOpen(state: *HostState, req: ipc.Envelope) !void {
    if (state.beginOrTrainBusy()) {
        var err_reply = try ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "busy", "begin or train already running");
        defer err_reply.deinit();
        try state.writeReply(err_reply);
        return;
    }
    const path = (try bodyUnescapedStringField(state.allocator, req.body_json, "path")) orelse {
        var err_reply = try ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "path required");
        defer err_reply.deinit();
        try state.writeReply(err_reply);
        return;
    };
    try startIo(state, req, .open, path, false);
}

fn previewWorker(task: *PreviewTask) void {
    const state = task.state;
    defer {
        state.untrack(task.request_id);
        // Only the live generation clears the running flag.
        if (state.previewGenCurrent(task.gen)) {
            state.preview_running.store(false, .release);
        }
        state.allocator.free(task.request_id);
        if (task.job_id) |j| state.allocator.free(j);
        state.allocator.free(task.op);
        state.allocator.free(task.config);
        state.allocator.destroy(task);
    }

    if (!state.previewGenCurrent(task.gen)) {
        var err_reply = ipc.makeErrorReply(state.allocator, task.request_id, task.job_id, task.op, "superseded", "newer preview request") catch return;
        defer err_reply.deinit();
        state.writeReply(err_reply) catch {};
        return;
    }

    var bundle = poker_app.plan_preview.compilePreview(state.allocator, task.config) catch |err| {
        if (!state.previewGenCurrent(task.gen)) {
            var err_reply = ipc.makeErrorReply(state.allocator, task.request_id, task.job_id, task.op, "superseded", "newer preview request") catch return;
            defer err_reply.deinit();
            state.writeReply(err_reply) catch {};
            return;
        }
        const code: []const u8 = if (err == error.OutOfMemory) "budget_exceeded" else "invalid_config";
        var err_reply = ipc.makeErrorReply(state.allocator, task.request_id, task.job_id, task.op, code, @errorName(err)) catch return;
        defer err_reply.deinit();
        state.writeReply(err_reply) catch {};
        return;
    };
    defer bundle.deinit();

    if (!state.previewGenCurrent(task.gen)) {
        var err_reply = ipc.makeErrorReply(state.allocator, task.request_id, task.job_id, task.op, "superseded", "newer preview request") catch return;
        defer err_reply.deinit();
        state.writeReply(err_reply) catch {};
        return;
    }

    const body = blk: {
        switch (task.kind) {
            .tree_preview => {
                // One compile → tree nodes + nested memory plan.
                break :blk poker_app.plan_preview.formatTreePreviewJson(state.allocator, &bundle) catch |err| {
                    const code: []const u8 = if (err == error.OutOfMemory) "out_of_memory" else "invalid_config";
                    var err_reply = ipc.makeErrorReply(state.allocator, task.request_id, task.job_id, task.op, code, @errorName(err)) catch return;
                    defer err_reply.deinit();
                    state.writeReply(err_reply) catch {};
                    return;
                };
            },
            .plan_memory => {
                var list = std.ArrayList(u8).init(state.allocator);
                errdefer list.deinit();
                poker_app.plan_preview.formatMemoryPlanJson(&list, bundle.plan) catch |err| {
                    const code: []const u8 = if (err == error.OutOfMemory) "out_of_memory" else "invalid_config";
                    var err_reply = ipc.makeErrorReply(state.allocator, task.request_id, task.job_id, task.op, code, @errorName(err)) catch return;
                    defer err_reply.deinit();
                    state.writeReply(err_reply) catch {};
                    return;
                };
                break :blk list.toOwnedSlice() catch |err| {
                    const code: []const u8 = if (err == error.OutOfMemory) "out_of_memory" else "invalid_config";
                    var err_reply = ipc.makeErrorReply(state.allocator, task.request_id, task.job_id, task.op, code, @errorName(err)) catch return;
                    defer err_reply.deinit();
                    state.writeReply(err_reply) catch {};
                    return;
                };
            },
        }
    };
    defer state.allocator.free(body);

    if (!state.previewGenCurrent(task.gen)) {
        var err_reply = ipc.makeErrorReply(state.allocator, task.request_id, task.job_id, task.op, "superseded", "newer preview request") catch return;
        defer err_reply.deinit();
        state.writeReply(err_reply) catch {};
        return;
    }

    var reply = ipc.makeReply(state.allocator, task.request_id, task.job_id, task.op, body) catch return;
    defer reply.deinit();
    state.writeReply(reply) catch {};
}

fn startPreview(state: *HostState, req: ipc.Envelope, kind: PreviewKind) !void {
    try state.track(req.request_id);
    errdefer state.untrack(req.request_id);

    if (state.beginOrTrainBusy()) {
        var err_reply = try ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "busy", "begin or train already running");
        defer err_reply.deinit();
        state.untrack(req.request_id);
        try state.writeReply(err_reply);
        return;
    }

    const escaped = bodyStringField(req.body_json, "config_text") orelse {
        var err_reply = try ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", "config_text required");
        defer err_reply.deinit();
        state.untrack(req.request_id);
        try state.writeReply(err_reply);
        return;
    };
    const config = unescapeConfig(state.allocator, escaped) catch |err| {
        var err_reply = try ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "invalid_request", @errorName(err));
        defer err_reply.deinit();
        state.untrack(req.request_id);
        try state.writeReply(err_reply);
        return;
    };
    var config_owned = true;
    errdefer if (config_owned) state.allocator.free(config);

    // Supersede any in-flight preview (newer draft wins).
    state.retirePreviewThread();
    const gen = state.bumpPreviewGen();

    const task = blk: {
        const request_id = try state.allocator.dupe(u8, req.request_id);
        errdefer state.allocator.free(request_id);
        const job_id: ?[]u8 = if (req.job_id) |j| try state.allocator.dupe(u8, j) else null;
        errdefer if (job_id) |j| state.allocator.free(j);
        const op = try state.allocator.dupe(u8, req.op);
        errdefer state.allocator.free(op);
        const created = try state.allocator.create(PreviewTask);
        created.* = .{
            .state = state,
            .request_id = request_id,
            .job_id = job_id,
            .op = op,
            .config = config,
            .kind = kind,
            .gen = gen,
        };
        config_owned = false;
        break :blk created;
    };
    var worker_owns_task = false;
    errdefer if (!worker_owns_task) {
        state.allocator.free(task.request_id);
        if (task.job_id) |j| state.allocator.free(j);
        state.allocator.free(task.op);
        state.allocator.free(task.config);
        state.allocator.destroy(task);
    };

    state.preview_running.store(true, .release);
    state.preview_thread = std.Thread.spawn(.{}, previewWorker, .{task}) catch |err| {
        state.preview_running.store(false, .release);
        state.allocator.free(task.request_id);
        if (task.job_id) |j| state.allocator.free(j);
        state.allocator.free(task.op);
        state.allocator.free(task.config);
        state.allocator.destroy(task);
        worker_owns_task = true;
        state.untrack(req.request_id);
        var err_reply = try ipc.makeErrorReply(state.allocator, req.request_id, req.job_id, req.op, "host_error", @errorName(err));
        defer err_reply.deinit();
        try state.writeReply(err_reply);
        return;
    };
    worker_owns_task = true;
}

pub fn startTreePreview(state: *HostState, req: ipc.Envelope) !void {
    try startPreview(state, req, .tree_preview);
}

pub fn startPlanMemory(state: *HostState, req: ipc.Envelope) !void {
    try startPreview(state, req, .plan_memory);
}

test "ZR-151 analysis gen coalesce marks older gens stale" {
    var state = try HostState.init(std.testing.allocator, "analysis-gen");
    defer state.deinit();
    const g1 = state.bumpAnalysisGen();
    try std.testing.expect(state.analysisGenCurrent(g1));
    const g2 = state.bumpAnalysisGen();
    try std.testing.expect(state.analysisGenCurrent(g2));
    try std.testing.expect(!state.analysisGenCurrent(g1));
}

test "preview gen supersedes stale drafts" {
    var state = try HostState.init(std.testing.allocator, "preview-gen");
    defer state.deinit();
    const g1 = state.bumpPreviewGen();
    try std.testing.expect(state.previewGenCurrent(g1));
    const g2 = state.bumpPreviewGen();
    try std.testing.expect(state.previewGenCurrent(g2));
    try std.testing.expect(!state.previewGenCurrent(g1));
}

test "superseded analysis finish does not clear live slot or train job" {
    // Audit #3: a dead/superseded worker must not flip analysis_running off or
    // return WorkerBudget while a newer analysis owns the slot — and must not
    // disturb an unrelated in-flight train identity.
    var state = try HostState.init(std.testing.allocator, "analysis-slot");
    defer state.deinit();

    try state.setActiveJob("train-current");
    state.train_running.store(true, .release);
    state.analysis_running.store(true, .release);
    state.prioritizeAnalysisBudget(1);
    try std.testing.expect(state.budget.analysis > 0);

    const stale_gen = state.bumpAnalysisGen();
    const live_gen = state.bumpAnalysisGen();
    try std.testing.expect(state.analysisGenCurrent(live_gen));
    try std.testing.expect(!state.analysisGenCurrent(stale_gen));

    // Superseded worker exits — shared slot must stay live for live_gen.
    state.finishAnalysisSlot(stale_gen);
    try std.testing.expect(state.analysis_running.load(.acquire));
    try std.testing.expect(state.budget.analysis > 0);
    try std.testing.expect(state.train_running.load(.acquire));
    try std.testing.expect(state.matchesActiveJob("train-current"));

    // Current generation may clear the analysis slot without touching train.
    state.finishAnalysisSlot(live_gen);
    try std.testing.expect(!state.analysis_running.load(.acquire));
    try std.testing.expectEqual(@as(u32, 0), state.budget.analysis);
    try std.testing.expect(state.train_running.load(.acquire));
    try std.testing.expect(state.matchesActiveJob("train-current"));
}

test "retireAnalysisThread parks orphans joinable without detach" {
    var state = try HostState.init(std.testing.allocator, "analysis-orphans");
    defer state.deinit();

    const Gate = struct {
        release: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),
        fn worker(self: *@This()) void {
            while (!self.release.load(.acquire)) {
                std.Thread.sleep(1 * std.time.ns_per_ms);
            }
        }
    };
    var gate1: Gate = .{};
    var gate2: Gate = .{};

    state.analysis_thread = try std.Thread.spawn(.{}, Gate.worker, .{&gate1});
    state.retireAnalysisThread();
    try std.testing.expect(state.analysis_thread == null);
    try std.testing.expectEqual(@as(usize, 1), state.analysis_orphans.items.len);

    state.analysis_thread = try std.Thread.spawn(.{}, Gate.worker, .{&gate2});
    state.retireAnalysisThread();
    try std.testing.expectEqual(@as(usize, 2), state.analysis_orphans.items.len);

    gate1.release.store(true, .release);
    gate2.release.store(true, .release);
    state.joinAnalysis();
    try std.testing.expectEqual(@as(usize, 0), state.analysis_orphans.items.len);
    try std.testing.expect(state.analysis_thread == null);
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

test "node flop root reach uses range-weight scale not 1/n deal mass" {
    // ZR-121: flop12 unit-weight fixture — deal-joint max was ~1/12; must be >0.9.
    const config =
        \\street-config 1
        \\board Ah Kd 7c
        \\pot 100
        \\stack 100
        \\oop-range 2s2h:1,3s3h:1,4s4h:1,5s5h:1,6s6h:1,8s8h:1,9s9h:1,TsTh:1,JsJh:1,QsQh:1,KsKh:1,AsAc:1
        \\ip-range 2s2h:1,3s3h:1,4s4h:1,5s5h:1,6s6h:1,8s8h:1,9s9h:1,TsTh:1,JsJh:1,QsQh:1,KsKh:1,AsAc:1
        \\first-to-act 0
        \\max-raises 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 256
        \\threads 1
        \\oop-bets 0.5
        \\ip-bets 0.5
        \\
    ;
    var state = try HostState.init(std.testing.allocator, "node-flop-reach");
    defer state.deinit();
    try state.session.begin(config);
    try state.session.train(1);

    var req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "flop-reach"),
        .op = try std.testing.allocator.dupe(u8, "node"),
        .body_json = try std.testing.allocator.dupe(u8, "{\"node_id\":\"p0.t-1.r-1\"}"),
    };
    defer req.deinit();
    var reply = try handle(&state, req);
    defer reply.deinit();
    try std.testing.expect(reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"reach_defined\":true") != null);
    // Optional PR2: posterior action mix on flop root (Check/Bet).
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"action_frequencies\":[") != null);
    const reach_key = "\"reach\":[";
    const reach_at = std.mem.indexOf(u8, reply.body_json, reach_key) orelse unreachable;
    const after = reply.body_json[reach_at + reach_key.len ..];
    const end = std.mem.indexOfScalar(u8, after, ']') orelse unreachable;
    const slice = after[0..end];
    var max_r: f64 = 0;
    var sum_r: f64 = 0;
    var live: usize = 0;
    var it = std.mem.tokenizeScalar(u8, slice, ',');
    while (it.next()) |tok| {
        const v = std.fmt.parseFloat(f64, tok) catch continue;
        if (v > max_r) max_r = v;
        if (v > 0) {
            live += 1;
            sum_r += v;
        }
    }
    try std.testing.expect(live >= 12);
    try std.testing.expect(max_r > 0.9);
    const mean_live = sum_r / @as(f64, @floatFromInt(live));
    try std.testing.expect(mean_live > 0.9);
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
    // ZR-105: root unit-weight hands must report range-weight reach ≈ 1, not deal mass ≪ 1.
    {
        const reach_key = "\"reach\":[";
        const reach_at = std.mem.indexOf(u8, reply.body_json, reach_key) orelse unreachable;
        const after = reply.body_json[reach_at + reach_key.len ..];
        const end = std.mem.indexOfScalar(u8, after, ']') orelse unreachable;
        const slice = after[0..end];
        var max_r: f64 = 0;
        var it = std.mem.tokenizeScalar(u8, slice, ',');
        while (it.next()) |tok| {
            const v = std.fmt.parseFloat(f64, tok) catch continue;
            if (v > max_r) max_r = v;
        }
        try std.testing.expect(max_r > 0.9);
    }
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

    // No active begin/train job after sync train — cancel must not requestStop.
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
    try std.testing.expect(std.mem.indexOf(u8, cancel_reply.body_json, "\"cancelled\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, cancel_reply.body_json, "\"reason\":\"not_running\"") != null);
    try std.testing.expect(!state.session.stop_requested.load(.acquire));

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

test "study_only save round-trips browse-only status on flop" {
    const config =
        \\street-config 1
        \\board Ah Kd 7c
        \\pot 100
        \\stack 100
        \\oop-range AcAd:1
        \\ip-range KsKc:1
        \\oop-flop-bets 0.5
        \\ip-flop-bets 
        \\oop-turn-bets 
        \\ip-turn-bets 
        \\oop-river-bets 
        \\ip-river-bets 
        \\first-to-act 0
        \\max-raises 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 256
        \\threads 1
        \\
    ;
    var state = try HostState.init(std.testing.allocator, "study-only-save");
    defer state.deinit();
    try state.session.begin(config);
    try state.session.train(1);
    try std.testing.expect(state.session.has_training);

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const abs = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(abs);
    const tmp_path = try std.fs.path.join(std.testing.allocator, &.{ abs, "study-only.psol" });
    defer std.testing.allocator.free(tmp_path);
    const path_json = try std.fmt.allocPrint(std.testing.allocator, "{s}", .{std.json.fmt(tmp_path, .{})});
    defer std.testing.allocator.free(path_json);

    var save_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "study-save"),
        .op = try std.testing.allocator.dupe(u8, "save"),
        .body_json = try std.fmt.allocPrint(
            std.testing.allocator,
            "{{\"path\":{s},\"study_only\":true}}",
            .{path_json},
        ),
    };
    defer save_req.deinit();
    var save_reply = try handle(&state, save_req);
    defer save_reply.deinit();
    try std.testing.expect(save_reply.ok);
    // Live session still resumable after Study-only export.
    try std.testing.expect(state.session.has_training);
    try std.testing.expect(state.session.canContinue());

    var open_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "study-open"),
        .op = try std.testing.allocator.dupe(u8, "open"),
        .body_json = try std.fmt.allocPrint(std.testing.allocator, "{{\"path\":{s}}}", .{path_json}),
    };
    defer open_req.deinit();
    var open_reply = try handle(&state, open_req);
    defer open_reply.deinit();
    try std.testing.expect(open_reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, open_reply.body_json, "\"has_training\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, open_reply.body_json, "\"can_continue\":false") != null);
}

test "stale cancel does not requestStop on train-current" {
    // Audit finding #2: cancel must match active_job_id; a finished job's Stop
    // must never latch stop_requested against a newer live train.
    var state = try HostState.init(std.testing.allocator, "job-scoped-stop");
    defer state.deinit();

    try state.setActiveJob("train-current");
    state.train_running.store(true, .release);
    defer state.train_running.store(false, .release);
    state.session.clearControlFlags();

    var stale: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "stop-stale"),
        .job_id = try std.testing.allocator.dupe(u8, "job-finished"),
        .op = try std.testing.allocator.dupe(u8, "cancel"),
        .body_json = try std.testing.allocator.dupe(u8, "null"),
    };
    defer stale.deinit();
    var stale_reply = try handle(&state, stale);
    defer stale_reply.deinit();
    try std.testing.expect(stale_reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, stale_reply.body_json, "\"cancelled\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, stale_reply.body_json, "\"reason\":\"not_running\"") != null);
    try std.testing.expect(!state.session.stop_requested.load(.acquire));
    try std.testing.expect(!state.isCancelled("job-finished"));
    try std.testing.expect(state.matchesActiveJob("train-current"));

    var live: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "stop-live"),
        .job_id = try std.testing.allocator.dupe(u8, "train-current"),
        .op = try std.testing.allocator.dupe(u8, "cancel"),
        .body_json = try std.testing.allocator.dupe(u8, "null"),
    };
    defer live.deinit();
    var live_reply = try handle(&state, live);
    defer live_reply.deinit();
    try std.testing.expect(live_reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, live_reply.body_json, "\"cancelled\":true") != null);
    try std.testing.expect(state.session.stop_requested.load(.acquire));
    try std.testing.expect(state.isCancelled("train-current"));

    // Idempotent while the same job is still active.
    var again: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "stop-again"),
        .job_id = try std.testing.allocator.dupe(u8, "train-current"),
        .op = try std.testing.allocator.dupe(u8, "cancel"),
        .body_json = try std.testing.allocator.dupe(u8, "null"),
    };
    defer again.deinit();
    var again_reply = try handle(&state, again);
    defer again_reply.deinit();
    try std.testing.expect(again_reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, again_reply.body_json, "\"cancelled\":true") != null);

    // Terminal clear: completed id becomes not_running and must not re-stop.
    state.clearActiveJobIfMatch("train-current");
    state.session.clearControlFlags();
    var done: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "stop-done"),
        .job_id = try std.testing.allocator.dupe(u8, "train-current"),
        .op = try std.testing.allocator.dupe(u8, "cancel"),
        .body_json = try std.testing.allocator.dupe(u8, "null"),
    };
    defer done.deinit();
    var done_reply = try handle(&state, done);
    defer done_reply.deinit();
    try std.testing.expect(done_reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, done_reply.body_json, "\"reason\":\"not_running\"") != null);
    try std.testing.expect(!state.session.stop_requested.load(.acquire));
}

test "stale pause does not latch pause on train-current" {
    var state = try HostState.init(std.testing.allocator, "job-scoped-pause");
    defer state.deinit();

    try state.setActiveJob("train-current");
    state.train_running.store(true, .release);
    defer state.train_running.store(false, .release);
    // Pretend mid-train so Session.pause latches without needing a full begin.
    state.session.mu.lock();
    state.session.phase = .training;
    state.session.mu.unlock();
    state.session.clearControlFlags();

    var stale: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "pause-stale"),
        .job_id = try std.testing.allocator.dupe(u8, "job-finished"),
        .op = try std.testing.allocator.dupe(u8, "pause"),
        .body_json = try std.testing.allocator.dupe(u8, "null"),
    };
    defer stale.deinit();
    var stale_reply = try handle(&state, stale);
    defer stale_reply.deinit();
    try std.testing.expect(stale_reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, stale_reply.body_json, "\"paused\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, stale_reply.body_json, "\"reason\":\"not_running\"") != null);
    try std.testing.expect(!state.session.pause_requested.load(.acquire));

    var live: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "pause-live"),
        .job_id = try std.testing.allocator.dupe(u8, "train-current"),
        .op = try std.testing.allocator.dupe(u8, "pause"),
        .body_json = try std.testing.allocator.dupe(u8, "null"),
    };
    defer live.deinit();
    var live_reply = try handle(&state, live);
    defer live_reply.deinit();
    try std.testing.expect(live_reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, live_reply.body_json, "\"phase\":\"paused\"") != null);
    try std.testing.expect(state.session.pause_requested.load(.acquire));
}

test "tree_preview refuses while train running (ZR-158)" {
    const config =
        \\street-config 1
        \\board Ah Kd 7c
        \\pot 100
        \\stack 100
        \\oop-range AcAd:1
        \\ip-range 2c3d:1
        \\first-to-act 0
        \\max-raises 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 64
        \\threads 1
        \\
    ;
    var state = try HostState.init(std.testing.allocator, "preview-busy");
    defer state.deinit();
    try state.session.begin(config);
    state.train_running.store(true, .release);
    defer state.train_running.store(false, .release);

    var preview_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "tp-busy"),
        .op = try std.testing.allocator.dupe(u8, "tree_preview"),
        .body_json = try std.fmt.allocPrint(std.testing.allocator, "{{\"config_text\":{s}}}", .{std.json.fmt(config, .{})}),
    };
    defer preview_req.deinit();
    var preview_reply = try handle(&state, preview_req);
    defer preview_reply.deinit();
    try std.testing.expect(!preview_reply.ok);
    try std.testing.expectEqualStrings("busy", preview_reply.error_code orelse "");

    var plan_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "pm-busy"),
        .op = try std.testing.allocator.dupe(u8, "plan_memory"),
        .body_json = try std.fmt.allocPrint(std.testing.allocator, "{{\"config_text\":{s}}}", .{std.json.fmt(config, .{})}),
    };
    defer plan_req.deinit();
    var plan_reply = try handle(&state, plan_req);
    defer plan_reply.deinit();
    try std.testing.expect(!plan_reply.ok);
    try std.testing.expectEqualStrings("busy", plan_reply.error_code orelse "");
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

test "budget reject preserves prior published solution" {
    const small =
        \\street-config 1
        \\board Ah Kd 7c 4s 2h
        \\pot 100
        \\stack 100
        \\oop-range AcAd:1
        \\ip-range KsKc:1
        \\first-to-act 0
        \\max-raises 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 64
        \\threads 1
        \\
    ;
    var state = try HostState.init(std.testing.allocator, "budget-keep");
    defer state.deinit();
    try state.session.begin(small);
    try state.session.train(1);
    const prior_id = state.session.solution_id;
    const prior_rev = state.session.policyRevision();
    const prior_live = state.session.allocatedBytes();

    const config_raw = try std.fs.cwd().readFileAlloc(
        std.testing.allocator,
        "benchmarks/study/configs/smoke_resource_flop.txt",
        64 * 1024,
    );
    defer std.testing.allocator.free(config_raw);
    var config_buf = std.ArrayList(u8).init(std.testing.allocator);
    defer config_buf.deinit();
    for (config_raw) |c| {
        if (c != '\r') try config_buf.append(c);
    }
    if (config_buf.items.len == 0 or config_buf.items[config_buf.items.len - 1] != '\n') {
        try config_buf.append('\n');
    }
    const config = config_buf.items;
    var req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "b-keep"),
        .op = try std.testing.allocator.dupe(u8, "begin_config"),
        .body_json = try std.fmt.allocPrint(std.testing.allocator, "{{\"config_text\":{s}}}", .{std.json.fmt(config, .{})}),
    };
    defer req.deinit();
    var reply = try handle(&state, req);
    defer reply.deinit();
    try std.testing.expect(!reply.ok);
    try std.testing.expect(std.mem.eql(u8, reply.error_code orelse "", "budget_exceeded"));
    try std.testing.expectEqual(prior_id, state.session.solution_id);
    try std.testing.expectEqual(prior_rev, state.session.policyRevision());
    try std.testing.expect(state.session.phase == .published);
    try std.testing.expectEqual(prior_live, state.session.allocatedBytes());
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
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"utility_basis\":\"local\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"root_centered\":{") != null);
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

test "values flop solve returns local utility_basis and dual root_centered" {
    // Matt: stack verification must include flop solves, not river-only dumps.
    // Flop root is Check/Bet (no Fold); local columns use local_offset shift.
    const config =
        \\street-config 1
        \\board Ah Kd 7c
        \\pot 100
        \\stack 100
        \\oop-range 2s2h:1,3s3h:1,4s4h:1,5s5h:1,6s6h:1,8s8h:1,9s9h:1,TsTh:1,JsJh:1,QsQh:1,KsKh:1,AsAc:1
        \\ip-range 2s2h:1,3s3h:1,4s4h:1,5s5h:1,6s6h:1,8s8h:1,9s9h:1,TsTh:1,JsJh:1,QsQh:1,KsKh:1,AsAc:1
        \\first-to-act 0
        \\max-raises 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 256
        \\threads 1
        \\oop-bets 0.5
        \\ip-bets 0.5
        \\
    ;
    var state = try HostState.init(std.testing.allocator, "values-flop-local");
    defer state.deinit();
    try state.session.begin(config);
    try state.session.train(1);

    var req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "v-flop"),
        .op = try std.testing.allocator.dupe(u8, "values"),
        .body_json = try std.testing.allocator.dupe(u8, "{\"node_id\":\"p0.t-1.r-1\"}"),
    };
    defer req.deinit();
    var reply = try handle(&state, req);
    defer reply.deinit();
    try std.testing.expect(reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"utility_basis\":\"local\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"root_centered\":{") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"engine\":\"frozen_response_walk\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"Check\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"local_offset\":") != null);
    // Primary action_ev present; dual block also carries action_ev for Global.
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"action_ev\":[") != null);
    // Flop 169-cell EV aggregates (PR2 hotspot) on local + dual root.
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"cell_ev\":[") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"text\":\"") != null);
}

test "values flop Root-x facing uses frozen walk not deal-by-deal" {
    // UI-35: after complete flop solve at Root x (IP faces OOP Check), Study EV
    // overlays must settle via warm FrozenCtx — deal-by-deal never finishes wide.
    const config =
        \\street-config 1
        \\board Qh 7h 7d
        \\pot 5
        \\stack 100
        \\oop-range 2s2h:1,3s3h:1,4s4h:1,5s5h:1,6s6h:1,8s8h:1,9s9h:1,TsTh:1,JsJh:1,QsQh:1,KsKh:1,AsAc:1
        \\ip-range 2s2h:1,3s3h:1,4s4h:1,5s5h:1,6s6h:1,8s8h:1,9s9h:1,TsTh:1,JsJh:1,QsQh:1,KsKh:1,AsAc:1
        \\first-to-act 0
        \\max-raises 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 256
        \\threads 1
        \\oop-bets 0.5
        \\ip-bets 0.5
        \\
    ;
    var state = try HostState.init(std.testing.allocator, "values-flop-facing");
    defer state.deinit();
    try state.session.begin(config);
    try state.session.train(1);

    var id_buf: [64]u8 = undefined;
    var body_buf: [96]u8 = undefined;
    const body: []const u8 = blk: {
        var lease = try state.session.borrowPublishedWait(1 * std.time.ns_per_s);
        defer lease.deinit();
        const game = lease.game;
        const root_node = game.nodes[0];
        var check0: ?u32 = null;
        var a: usize = 0;
        while (a < root_node.n_actions) : (a += 1) {
            if (std.mem.startsWith(u8, root_node.action_labels[a], "Check")) {
                check0 = root_node.child[a];
                break;
            }
        }
        const facing = check0 orelse return error.TestUnexpectedResult;
        try std.testing.expect(game.nodes[facing].player == 1);
        const facing_id = try std.fmt.bufPrint(&id_buf, "p{d}.t-1.r-1", .{facing});
        break :blk try std.fmt.bufPrint(&body_buf, "{{\"node_id\":\"{s}\"}}", .{facing_id});
    };

    var req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "v-facing"),
        .op = try std.testing.allocator.dupe(u8, "values"),
        .body_json = try std.testing.allocator.dupe(u8, body),
    };
    defer req.deinit();
    var reply = try handle(&state, req);
    defer reply.deinit();
    try std.testing.expect(reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"engine\":\"frozen_response_walk\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"engine\":\"deal_by_deal\"") == null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"pending\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"action_ev\":[") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"cell_ev\":[") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"player\":1") != null);
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

test "line lock expands per runout without copying browsed mix" {
    // Turn board; river decisions. Same combo opposite pure actions on two rivers.
    const config =
        \\street-config 1
        \\board Ah Kh Qh Jh
        \\pot 100
        \\stack 100
        \\oop-range AsQs:1,2d2h:1
        \\ip-range AsQs:1,2d2h:1
        \\oop-river-bets 1
        \\first-to-act 0
        \\max-raises 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 64
        \\threads 1
        \\
    ;
    const river_a: i32 = 20; // 7c
    const river_b: i32 = 21; // 7d
    var state = try HostState.init(std.testing.allocator, "line-lock-runouts");
    defer state.deinit();
    try state.session.begin(config);
    try state.session.train(1);

    const game = state.session.game orelse return error.TestUnexpectedResult;
    var infoset: usize = 0;
    for (game.nodes, 0..) |node, i| {
        if (node.kind == .decision and node.player == 0 and node.n_actions >= 2) {
            infoset = i;
            break;
        }
    }
    const node = game.nodes[infoset];
    try std.testing.expect(node.card_mode == 1);

    // Force opposite pure actions for combo 0 on the two rivers.
    const avg = try state.session.publishedAverageMut();
    {
        const key = try game.cardKey(node, 0, -1, river_a);
        const slot_i = node.slot_of[@intCast(key)];
        try std.testing.expect(slot_i >= 0);
        const base: usize = @intCast(game.slots[@intCast(slot_i)].base);
        avg[base] = 1;
        avg[base + 1] = 0;
    }
    {
        const key = try game.cardKey(node, 0, -1, river_b);
        const slot_i = node.slot_of[@intCast(key)];
        try std.testing.expect(slot_i >= 0);
        const base: usize = @intCast(game.slots[@intCast(slot_i)].base);
        avg[base] = 0;
        avg[base + 1] = 1;
    }

    // Request carries river_a's mix for both combos — must not overwrite river_b.
    var node_id_buf: [64]u8 = undefined;
    const node_id = try std.fmt.bufPrint(&node_id_buf, "p{d}.t-1.r{d}", .{ infoset, river_a });
    var body_buf: [256]u8 = undefined;
    const body = try std.fmt.bufPrint(
        &body_buf,
        "{{\"node_id\":\"{s}\",\"kind\":\"selected\",\"scope\":\"line\",\"hand_indices\":[0],\"probs\":[1,0],\"combo_probs\":[[1,0]]}}",
        .{node_id},
    );
    var put_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "ll-put"),
        .op = try std.testing.allocator.dupe(u8, "put_lock"),
        .body_json = try std.testing.allocator.dupe(u8, body),
    };
    defer put_req.deinit();
    var put_reply = try handle(&state, put_req);
    defer put_reply.deinit();
    try std.testing.expect(put_reply.ok);

    var locks = try locks_json.parseSessionLocks(std.testing.allocator, state.session.locks_text);
    defer locks.deinit();
    try std.testing.expect(locks.find(infoset) == null); // no shared line mix
    const lock_a = locks.findExact(infoset, -1, river_a).?;
    const lock_b = locks.findExact(infoset, -1, river_b).?;
    try std.testing.expectEqual(@as(f64, 1.0), node_lock.lockedProbability(lock_a.*, 0, 0).?);
    try std.testing.expectEqual(@as(f64, 0.0), node_lock.lockedProbability(lock_a.*, 0, 1).?);
    try std.testing.expectEqual(@as(f64, 0.0), node_lock.lockedProbability(lock_b.*, 0, 0).?);
    try std.testing.expectEqual(@as(f64, 1.0), node_lock.lockedProbability(lock_b.*, 0, 1).?);

    // Line unlock must reverse the expanded runout locks (not only a shared key).
    var del_body_buf: [128]u8 = undefined;
    const del_body = try std.fmt.bufPrint(
        &del_body_buf,
        "{{\"node_id\":\"{s}\",\"scope\":\"line\"}}",
        .{node_id},
    );
    var del_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "ll-del"),
        .op = try std.testing.allocator.dupe(u8, "delete_lock"),
        .body_json = try std.testing.allocator.dupe(u8, del_body),
    };
    defer del_req.deinit();
    var del_reply = try handle(&state, del_req);
    defer del_reply.deinit();
    try std.testing.expect(del_reply.ok);

    var after = try locks_json.parseSessionLocks(std.testing.allocator, state.session.locks_text);
    defer after.deinit();
    try std.testing.expect(after.find(infoset) == null);
    try std.testing.expect(after.findExact(infoset, -1, river_a) == null);
    try std.testing.expect(after.findExact(infoset, -1, river_b) == null);
    // No leftover board-local records for this infoset.
    for (after.entries.items) |lock| {
        try std.testing.expect(lock.infoset_id != infoset);
    }
}

test "line unlock preserves independent board-local lock" {
    // Explicit river lock, then line lock at the same betting node, then line unlock
    // must leave the original river lock intact (including save/reopen).
    const config =
        \\street-config 1
        \\board Ah Kh Qh Jh
        \\pot 100
        \\stack 100
        \\oop-range AsQs:1,2d2h:1
        \\ip-range AsQs:1,2d2h:1
        \\oop-river-bets 1
        \\first-to-act 0
        \\max-raises 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 64
        \\threads 1
        \\
    ;
    const river_a: i32 = 20; // 7c
    const river_b: i32 = 21; // 7d
    var state = try HostState.init(std.testing.allocator, "line-unlock-keep-local");
    defer state.deinit();
    try state.session.begin(config);
    try state.session.train(1);

    const game = state.session.game orelse return error.TestUnexpectedResult;
    var infoset: usize = 0;
    for (game.nodes, 0..) |node, i| {
        if (node.kind == .decision and node.player == 0 and node.n_actions >= 2) {
            infoset = i;
            break;
        }
    }

    var node_id_buf: [64]u8 = undefined;
    const node_id_a = try std.fmt.bufPrint(&node_id_buf, "p{d}.t-1.r{d}", .{ infoset, river_a });

    // Explicit board-local lock on river_a.
    var body_a: [256]u8 = undefined;
    const put_a_body = try std.fmt.bufPrint(
        &body_a,
        "{{\"node_id\":\"{s}\",\"kind\":\"full\",\"scope\":\"node\",\"probs\":[0.25,0.75]}}",
        .{node_id_a},
    );
    var put_a: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "keep-a"),
        .op = try std.testing.allocator.dupe(u8, "put_lock"),
        .body_json = try std.testing.allocator.dupe(u8, put_a_body),
    };
    defer put_a.deinit();
    var put_a_reply = try handle(&state, put_a);
    defer put_a_reply.deinit();
    try std.testing.expect(put_a_reply.ok);

    // Line lock across runouts (must not erase the explicit river_a record).
    var body_line: [256]u8 = undefined;
    const put_line_body = try std.fmt.bufPrint(
        &body_line,
        "{{\"node_id\":\"{s}\",\"kind\":\"selected\",\"scope\":\"line\",\"hand_indices\":[0],\"probs\":[1,0],\"combo_probs\":[[1,0]]}}",
        .{node_id_a},
    );
    var put_line: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "keep-line"),
        .op = try std.testing.allocator.dupe(u8, "put_lock"),
        .body_json = try std.testing.allocator.dupe(u8, put_line_body),
    };
    defer put_line.deinit();
    var put_line_reply = try handle(&state, put_line);
    defer put_line_reply.deinit();
    try std.testing.expect(put_line_reply.ok);

    {
        var locks = try locks_json.parseSessionLocks(std.testing.allocator, state.session.locks_text);
        defer locks.deinit();
        const lock_a = locks.findExact(infoset, -1, river_a).?;
        try std.testing.expect(!lock_a.from_line);
        try std.testing.expectEqual(@as(f64, 0.25), node_lock.lockedProbability(lock_a.*, 0, 0).?);
        try std.testing.expectEqual(@as(f64, 0.75), node_lock.lockedProbability(lock_a.*, 0, 1).?);
        const lock_b = locks.findExact(infoset, -1, river_b).?;
        try std.testing.expect(lock_b.from_line);
    }

    var del_body_buf: [128]u8 = undefined;
    const del_body = try std.fmt.bufPrint(
        &del_body_buf,
        "{{\"node_id\":\"{s}\",\"scope\":\"line\"}}",
        .{node_id_a},
    );
    var del_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "keep-del"),
        .op = try std.testing.allocator.dupe(u8, "delete_lock"),
        .body_json = try std.testing.allocator.dupe(u8, del_body),
    };
    defer del_req.deinit();
    var del_reply = try handle(&state, del_req);
    defer del_reply.deinit();
    try std.testing.expect(del_reply.ok);

    {
        var after = try locks_json.parseSessionLocks(std.testing.allocator, state.session.locks_text);
        defer after.deinit();
        try std.testing.expect(after.findExact(infoset, -1, river_b) == null);
        const lock_a = after.findExact(infoset, -1, river_a).?;
        try std.testing.expect(!lock_a.from_line);
        try std.testing.expectEqual(@as(f64, 0.25), node_lock.lockedProbability(lock_a.*, 0, 0).?);
        try std.testing.expectEqual(@as(f64, 0.75), node_lock.lockedProbability(lock_a.*, 0, 1).?);
    }

    // Save / reopen must preserve the explicit river lock (from_line round-trips).
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const abs = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(abs);
    const path = try std.fs.path.join(std.testing.allocator, &.{ abs, "keep_local.psol" });
    defer std.testing.allocator.free(path);
    try state.session.save(path);

    var other = try HostState.init(std.testing.allocator, "line-unlock-reopen");
    defer other.deinit();
    try other.session.open(path);
    var reopened = try locks_json.parseSessionLocks(std.testing.allocator, other.session.locks_text);
    defer reopened.deinit();
    const re_a = reopened.findExact(infoset, -1, river_a).?;
    try std.testing.expect(!re_a.from_line);
    try std.testing.expectEqual(@as(f64, 0.25), node_lock.lockedProbability(re_a.*, 0, 0).?);
    try std.testing.expectEqual(@as(f64, 0.75), node_lock.lockedProbability(re_a.*, 0, 1).?);
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
    try std.testing.expect(state.session.baseline_snapshot != null);
    try std.testing.expectEqual(prior_id, state.session.baseline_snapshot.?.solution_id);
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
    // Original baseline snapshot survives a second resolve-locked.
    try std.testing.expect(state.session.baseline_snapshot != null);
    try std.testing.expectEqual(prior_id, state.session.baseline_snapshot.?.solution_id);
}

test "compare dual-session flop baseline vs resolve-locked scenario" {
    // Flop coverage: lock root → resolve-locked → compare strategy/EV at root.
    const config =
        \\street-config 1
        \\board Ah Kd 7c
        \\pot 100
        \\stack 100
        \\oop-range AcAd:1,KsKh:1
        \\ip-range QcQd:1,JcJh:1
        \\oop-flop-bets 0.5
        \\ip-flop-bets 
        \\oop-turn-bets 
        \\ip-turn-bets 
        \\oop-river-bets 
        \\ip-river-bets 
        \\first-to-act 0
        \\max-raises 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 256
        \\threads 1
        \\
    ;
    var state = try HostState.init(std.testing.allocator, "compare-flop");
    defer state.deinit();
    try state.session.begin(config);
    try state.session.train(3);
    const prior_id = state.session.solution_id;

    var put_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "cmp-put"),
        .op = try std.testing.allocator.dupe(u8, "put_lock"),
        .body_json = try std.testing.allocator.dupe(u8, "{\"node_id\":\"p0.t-1.r-1\",\"kind\":\"full\",\"scope\":\"node\",\"probs\":[1,0]}"),
    };
    defer put_req.deinit();
    var put_reply = try handle(&state, put_req);
    defer put_reply.deinit();
    try std.testing.expect(put_reply.ok);

    try state.session.prepareResolveLocked(false);
    try state.session.train(2);
    const scenario_id = state.session.solution_id;
    try std.testing.expect(scenario_id != prior_id);
    try std.testing.expect(state.session.baseline_snapshot != null);

    var body_buf: [128]u8 = undefined;
    const body = try std.fmt.bufPrint(
        &body_buf,
        "{{\"baseline\":\"s{d}\",\"scenario\":\"s{d}\",\"node_id\":\"p0.t-1.r-1\"}}",
        .{ prior_id, scenario_id },
    );
    var cmp_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "cmp-1"),
        .op = try std.testing.allocator.dupe(u8, "compare"),
        .body_json = try std.testing.allocator.dupe(u8, body),
    };
    defer cmp_req.deinit();
    var cmp_reply = try handle(&state, cmp_req);
    defer cmp_reply.deinit();
    try std.testing.expect(cmp_reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, cmp_reply.body_json, "\"value_delta\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, cmp_reply.body_json, "\"locked\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, cmp_reply.body_json, "\"hands\":[") != null);
    var baseline_id_buf: [32]u8 = undefined;
    const baseline_id_needle = try std.fmt.bufPrint(&baseline_id_buf, "\"baseline_id\":\"s{d}\"", .{prior_id});
    try std.testing.expect(std.mem.indexOf(u8, cmp_reply.body_json, baseline_id_needle) != null);
    var scenario_id_buf: [32]u8 = undefined;
    const scenario_id_needle = try std.fmt.bufPrint(&scenario_id_buf, "\"scenario_id\":\"s{d}\"", .{scenario_id});
    try std.testing.expect(std.mem.indexOf(u8, cmp_reply.body_json, scenario_id_needle) != null);
}

test "status body exposes iterations and requested target" {
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
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 256
        \\threads 1
        \\
    ;
    var state = try HostState.init(std.testing.allocator, "status-iters");
    defer state.deinit();
    try state.session.begin(config);
    state.train_iterations_requested.store(7, .release);
    try state.session.train(3);

    const status_body = try formatStatusBody(std.testing.allocator, &state);
    defer std.testing.allocator.free(status_body);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"iterations\":3") != null);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"iterations_requested\":7") != null);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"phase\":\"published\"") != null);
    try std.testing.expectEqual(@as(i32, 3), state.session.last_committed_trained);
}

test "status body publishes progress metrics after trainGated (ZR-171)" {
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
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 256
        \\threads 1
        \\
    ;
    var state = try HostState.init(std.testing.allocator, "status-progress");
    defer state.deinit();
    try state.session.begin(config);
    state.train_iterations_requested.store(4, .release);
    // Iteration-only job (accuracy ≤ 0) must still record EV/gap for the footer.
    state.session.publish_every = 10;
    try state.session.trainGated(4, -1.0, 1, -1.0);

    const status_body = try formatStatusBody(std.testing.allocator, &state);
    defer std.testing.allocator.free(status_body);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"iterations\":4") != null);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"nash_gap\":") != null);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"accuracy_chips\":") != null);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"runtime_seconds\":") != null);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"engine_allocated\":") != null);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"gap_series\":[") != null);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"pot\":100") != null);
    try std.testing.expect(state.session.has_metrics);
    try std.testing.expect(state.session.gap_series_len >= 1);
    // Progress samples must not turn every eval into a revision bump (ZR-133).
    const rev = state.session.policyRevision();
    try std.testing.expect(rev >= 2);
    try std.testing.expect(rev < 4);
}

test "status copies last_error; iterations use committed count" {
    // ZR-155: formatStatusBody must not borrow last_error across job_mu unlock.
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
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 256
        \\threads 1
        \\
    ;
    var state = try HostState.init(std.testing.allocator, "status-race");
    defer state.deinit();
    try state.session.begin(config);
    try state.session.train(2);
    try std.testing.expectEqual(@as(i32, 2), state.session.last_committed_trained);

    // Concurrent mutator: free/replace sticky strings while status is formatted.
    const RaceCtx = struct {
        state: *HostState,
        stop: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),

        fn run(self: *@This()) void {
            var i: usize = 0;
            while (!self.stop.load(.acquire)) : (i += 1) {
                if (i % 2 == 0) {
                    self.state.setLastError("RaceA");
                } else {
                    self.state.clearLastError();
                    self.state.setLastError("RaceB");
                }
                self.state.job_mu.lock();
                if (self.state.active_job_id) |old| self.state.allocator.free(old);
                self.state.active_job_id = self.state.allocator.dupe(u8, if (i % 2 == 0) "job-a" else "job-b") catch null;
                self.state.job_mu.unlock();
                std.Thread.yield() catch {};
            }
        }
    };
    var race = RaceCtx{ .state = &state };
    const thr = try std.Thread.spawn(.{}, RaceCtx.run, .{&race});
    defer {
        race.stop.store(true, .release);
        thr.join();
    }

    var n: usize = 0;
    while (n < 64) : (n += 1) {
        const body = try formatStatusBody(std.testing.allocator, &state);
        defer std.testing.allocator.free(body);
        try std.testing.expect(std.mem.indexOf(u8, body, "\"iterations\":2") != null);
        // Body must be well-formed JSON-ish regardless of concurrent clears.
        try std.testing.expect(std.mem.indexOf(u8, body, "\"last_error\":") != null);
        try std.testing.expect(std.mem.indexOf(u8, body, "\"job_id\":") != null);
    }
}

test "status reports compiling while begin_running" {
    var state = try HostState.init(std.testing.allocator, "begin-running");
    defer state.deinit();
    state.begin_running.store(true, .release);
    const status_body = try formatStatusBody(std.testing.allocator, &state);
    defer std.testing.allocator.free(status_body);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"running\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"phase\":\"compiling\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"iterations\":0") != null);
}

test "admit rejects while begin compiling" {
    // ZR-125 / ZR-120: solve must not race an in-flight begin_config.
    // Do not call admitTrainJob's busy branch here — it writeReply()s to stdout
    // and can deadlock under `zig build test` (pipe not drained). Pin the same
    // gates the busy branch uses: has_training + begin_running ⇒ compiling status.
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
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 256
        \\threads 1
        \\
    ;
    var state = try HostState.init(std.testing.allocator, "admit-busy-begin");
    defer state.deinit();
    try state.session.begin(config);
    try std.testing.expect(state.session.has_training);

    var ok_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "adm-ok"),
        .job_id = try std.testing.allocator.dupe(u8, "j-ok"),
        .op = try std.testing.allocator.dupe(u8, "solve"),
        .body_json = try std.testing.allocator.dupe(u8, "{\"iterations\":1}"),
    };
    defer ok_req.deinit();
    // .ok path does not write stdout — pin the idle admit gate.
    try std.testing.expect((try admitTrainJob(&state, ok_req)) == .ok);

    state.begin_running.store(true, .release);
    try std.testing.expect(state.beginOrTrainBusy());
    try std.testing.expect(state.begin_running.load(.acquire));
    try std.testing.expect(!state.train_running.load(.acquire));
    const status_body = try formatStatusBody(std.testing.allocator, &state);
    defer std.testing.allocator.free(status_body);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"phase\":\"compiling\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"running\":true") != null);
}

test "short-admit body shape and continue iterations_requested target" {
    // ZR-125: ZR-106 admit JSON + ZR-120 absolute iterations_requested on continue.
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
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 256
        \\threads 1
        \\
    ;
    var state = try HostState.init(std.testing.allocator, "admit-iters-target");
    defer state.deinit();
    try state.session.begin(config);
    try state.session.train(3);

    var buf: [192]u8 = undefined;
    const admit_body = try formatTrainAdmitBody(&buf, state.session.solution_id, state.session.threads);
    try std.testing.expect(std.mem.indexOf(u8, admit_body, "\"accepted\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, admit_body, "\"running\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, admit_body, "\"async\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, admit_body, "\"solution_id\":") != null);
    try std.testing.expect(std.mem.indexOf(u8, admit_body, "\"threads\":") != null);

    // Mirror spawnTrainWorker absolute-target math for a continue of 5.
    state.session.mu.lock();
    const start_trained: i32 = if (state.session.training) |*training| training.trained else 0;
    state.session.mu.unlock();
    try std.testing.expectEqual(@as(i32, 3), start_trained);
    const job_iters: i32 = 5;
    state.train_iterations_requested.store(start_trained + job_iters, .release);
    state.train_running.store(true, .release);

    const status_body = try formatStatusBody(std.testing.allocator, &state);
    defer std.testing.allocator.free(status_body);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"iterations\":3") != null);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"iterations_requested\":8") != null);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"running\":true") != null);
}

test "status publishes failed flag when session phase is failed" {
    // ZR-125 / ZR-123: desktop recovery maps phase=failed via status.failed.
    var state = try HostState.init(std.testing.allocator, "status-failed");
    defer state.deinit();
    state.session.phase = .failed;
    const status_body = try formatStatusBody(std.testing.allocator, &state);
    defer std.testing.allocator.free(status_body);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"failed\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"phase\":\"failed\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"running\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"last_error\":null") != null);
}

test "forced train failure surfaces sticky last_error on status" {
    // ZR-130 / Tiger Phase 2: async train faults must not write a second solve
    // reply; sticky last_error on status carries the Zig error name instead.
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
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 256
        \\threads 1
        \\
    ;
    var state = try HostState.init(std.testing.allocator, "train-last-error");
    defer state.deinit();
    try state.session.begin(config);
    try state.session.train(1);

    // Mirror trainWorker catch path: force InvalidSession, record sticky code.
    state.session.phase = .idle;
    const train_err = state.session.train(1);
    try std.testing.expectError(error.InvalidSession, train_err);
    state.setLastError(@errorName(error.InvalidSession));

    const status_body = try formatStatusBody(std.testing.allocator, &state);
    defer std.testing.allocator.free(status_body);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"last_error\":\"InvalidSession\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"error\":\"InvalidSession\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"failed\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"running\":false") != null);

    // Fresh admit clears sticky fault so Study is not stuck failed forever.
    state.clearLastError();
    const cleared = try formatStatusBody(std.testing.allocator, &state);
    defer std.testing.allocator.free(cleared);
    try std.testing.expect(std.mem.indexOf(u8, cleared, "\"last_error\":null") != null);
    try std.testing.expect(std.mem.indexOf(u8, cleared, "\"failed\":false") != null);
}

test "cadence publish OOM soft-skips without sticky last_error (ZR-164)" {
    // Soft BudgetExceeded on cadence must complete train without StrategyPublishFailed
    // sticky brick (desktop phaseFromStatus maps any last_error → failed).
    const config =
        \\street-config 1
        \\board Ah Kd 7c 4s 2h
        \\pot 100
        \\stack 100
        \\oop-range AcAd:1
        \\ip-range KsKc:1
        \\first-to-act 0
        \\max-raises 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 1024
        \\threads 1
        \\
    ;
    var state = try HostState.init(std.testing.allocator, "zr164-soft-publish");
    defer state.deinit();
    try state.session.begin(config);
    try state.session.train(1);

    state.session.publish_every = 1;
    state.session.inject_publish_oom = true;
    // Mirrors trainWorker success path: soft-skip returns ok → clearLastError.
    try state.session.train(1);
    state.clearLastError();
    const status_body = try formatStatusBody(std.testing.allocator, &state);
    defer std.testing.allocator.free(status_body);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"last_error\":null") != null);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"failed\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"can_continue\":true") != null);
    try std.testing.expectEqual(@as(u32, 1), state.session.publish_skips);
    try std.testing.expectEqual(@as(i32, 1), state.session.last_published_trained);
    try std.testing.expectEqual(@as(i32, 2), state.session.training.?.trained);
}

test "publish failure keeps can_continue; mid-pass clears it" {
    // ZR-145: StrategyPublishFailed ≠ mid-pass InvalidFrozen for Continue gates.
    const config =
        \\street-config 1
        \\board Ah Kd 7c 4s 2h
        \\pot 100
        \\stack 100
        \\oop-range AcAd:1
        \\ip-range KsKc:1
        \\first-to-act 0
        \\max-raises 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 1024
        \\threads 1
        \\
    ;
    var state = try HostState.init(std.testing.allocator, "zr145-publish-vs-midpass");
    defer state.deinit();
    try state.session.begin(config);
    try state.session.train(1);

    state.session.publish_every = 1;
    state.session.inject_publish_fault = true;
    const pub_err = state.session.train(1);
    try std.testing.expectError(error.StrategyPublishFailed, pub_err);
    state.setLastError(@errorName(error.StrategyPublishFailed));
    const status_body = try formatStatusBody(std.testing.allocator, &state);
    defer std.testing.allocator.free(status_body);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"last_error\":\"StrategyPublishFailed\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"can_continue\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, status_body, "\"has_training\":true") != null);
    try std.testing.expect(state.session.canContinue());

    state.clearLastError();
    state.session.inject_mid_pass_fault = true;
    const mid_err = state.session.train(1);
    try std.testing.expectError(error.InvalidFrozen, mid_err);
    state.setLastError(@errorName(error.InvalidFrozen));
    const mid_body = try formatStatusBody(std.testing.allocator, &state);
    defer std.testing.allocator.free(mid_body);
    try std.testing.expect(std.mem.indexOf(u8, mid_body, "\"last_error\":\"InvalidFrozen\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, mid_body, "\"can_continue\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, mid_body, "\"has_training\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, mid_body, "\"phase\":\"published\"") != null);
    try std.testing.expect(!state.session.canContinue());
}

test "strategy edits list put delete Study CRUD" {
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
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 256
        \\threads 1
        \\
    ;
    var state = try HostState.init(std.testing.allocator, "strategy-edits-crud");
    defer state.deinit();
    try state.session.begin(config);
    try state.session.train(1);

    var list_empty: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "e0"),
        .op = try std.testing.allocator.dupe(u8, "list_strategy_edits"),
        .body_json = try std.testing.allocator.dupe(u8, "null"),
    };
    defer list_empty.deinit();
    var empty_reply = try handle(&state, list_empty);
    defer empty_reply.deinit();
    try std.testing.expect(empty_reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, empty_reply.body_json, "\"edits\":[]") != null);

    // Capture root strategy for hand 0 before edit.
    var node_before: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "e-node0"),
        .op = try std.testing.allocator.dupe(u8, "node"),
        .body_json = try std.testing.allocator.dupe(u8, "{\"node_id\":\"p0.t-1.r-1\"}"),
    };
    defer node_before.deinit();
    var before_reply = try handle(&state, node_before);
    defer before_reply.deinit();
    try std.testing.expect(before_reply.ok);

    var put_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "e1"),
        .op = try std.testing.allocator.dupe(u8, "put_strategy_edit"),
        .body_json = try std.testing.allocator.dupe(u8, "{\"node_id\":\"p0.t-1.r-1\",\"kind\":\"full\",\"probs\":[0.0,1.0]}"),
    };
    defer put_req.deinit();
    var put_reply = try handle(&state, put_req);
    defer put_reply.deinit();
    try std.testing.expect(put_reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, put_reply.body_json, "\"node_id\":\"p0.t-1.r-1\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, put_reply.body_json, "\"kind\":\"full\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, put_reply.body_json, "\"persisted\":false") != null);
    try std.testing.expect(state.session.strategy_edits_text.len > 0);

    var node_after: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "e-node1"),
        .op = try std.testing.allocator.dupe(u8, "node"),
        .body_json = try std.testing.allocator.dupe(u8, "{\"node_id\":\"p0.t-1.r-1\"}"),
    };
    defer node_after.deinit();
    var after_reply = try handle(&state, node_after);
    defer after_reply.deinit();
    try std.testing.expect(after_reply.ok);
    // Full-node edit forces action 1 mass — strategy table should mention 1.
    try std.testing.expect(std.mem.indexOf(u8, after_reply.body_json, "\"strategy\":") != null);

    var del_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "e2"),
        .op = try std.testing.allocator.dupe(u8, "delete_strategy_edit"),
        .body_json = try std.testing.allocator.dupe(u8, "{\"node_id\":\"p0.t-1.r-1\"}"),
    };
    defer del_req.deinit();
    var del_reply = try handle(&state, del_req);
    defer del_reply.deinit();
    try std.testing.expect(del_reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, del_reply.body_json, "\"edits\":[]") != null);
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

fn digExtractF64After(hay: []const u8, key: []const u8) ?f64 {
    const idx = std.mem.indexOf(u8, hay, key) orelse return null;
    var i = idx + key.len;
    while (i < hay.len and (hay[i] == ' ' or hay[i] == ':' or hay[i] == '"')) : (i += 1) {}
    var end = i;
    while (end < hay.len and ((hay[end] >= '0' and hay[end] <= '9') or hay[end] == '.' or hay[end] == 'e' or hay[end] == 'E' or hay[end] == '+' or hay[end] == '-')) : (end += 1) {}
    if (end == i) return null;
    return std.fmt.parseFloat(f64, hay[i..end]) catch null;
}

test "ZR-116 dig: node equity root vs navigated differs on reach fixture" {
    // Same ZR-95 pin: AsQs vs 2d2h on AhKhQhJh; check→check→Ac → OOP ~100% vs root ~18%.
    const config =
        \\street-config 1
        \\board Ah Kh Qh Jh
        \\pot 100
        \\stack 200
        \\oop-range AsQs:1
        \\ip-range 2d2h:1
        \\oop-bets 0.5
        \\ip-bets 0.5
        \\oop-turn-bets 0.5
        \\ip-turn-bets 0.5
        \\oop-river-bets 0.5
        \\ip-river-bets 0.5
        \\first-to-act 0
        \\max-raises 1
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 256
        \\threads 1
        \\
    ;
    var state = try HostState.init(std.testing.allocator, "zr116-eq-nav");
    defer state.deinit();
    try state.session.begin(config);
    try state.session.train(1);

    var root_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "eq-root"),
        .op = try std.testing.allocator.dupe(u8, "equity"),
        .body_json = try std.testing.allocator.dupe(u8, "{\"node_id\":\"p0.t-1.r-1\"}"),
    };
    defer root_req.deinit();
    var root_reply = try handle(&state, root_req);
    defer root_reply.deinit();
    try std.testing.expect(root_reply.ok);
    const root_eq = digExtractF64After(root_reply.body_json, "\"oop_equity\"") orelse return error.TestUnexpectedResult;
    try std.testing.expectApproxEqAbs(@as(f64, 2.0 / 11.0), root_eq, 1e-4);

    // Locate check→check→Ac river decision via tree walk (same as rematch pin).
    var lease = try state.session.borrowPublishedWait(1 * std.time.ns_per_s);
    defer lease.deinit();
    const game = lease.game;
    const root_node = game.nodes[0];
    var check0: ?u32 = null;
    var a: usize = 0;
    while (a < root_node.n_actions) : (a += 1) {
        if (std.mem.eql(u8, root_node.action_labels[a], "Check")) {
            check0 = root_node.child[a];
            break;
        }
    }
    const after_oop = check0 orelse return error.TestUnexpectedResult;
    const ip_node = game.nodes[after_oop];
    var check1: ?u32 = null;
    a = 0;
    while (a < ip_node.n_actions) : (a += 1) {
        if (std.mem.eql(u8, ip_node.action_labels[a], "Check")) {
            check1 = ip_node.child[a];
            break;
        }
    }
    const chance_idx = check1 orelse return error.TestUnexpectedResult;
    const ac = try poker_engine.poker.card.parseCard("Ac");
    var id_buf: [64]u8 = undefined;
    const river_id = try std.fmt.bufPrint(&id_buf, "p{d}.t-1.r{d}", .{ game.nodes[chance_idx].child[0], ac });
    var body_buf: [96]u8 = undefined;
    const body = try std.fmt.bufPrint(&body_buf, "{{\"node_id\":\"{s}\"}}", .{river_id});

    var nav_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "eq-nav"),
        .op = try std.testing.allocator.dupe(u8, "equity"),
        .body_json = try std.testing.allocator.dupe(u8, body),
    };
    defer nav_req.deinit();
    var nav_reply = try handle(&state, nav_req);
    defer nav_reply.deinit();
    try std.testing.expect(nav_reply.ok);
    const nav_eq = digExtractF64After(nav_reply.body_json, "\"oop_equity\"") orelse return error.TestUnexpectedResult;
    try std.testing.expectApproxEqAbs(@as(f64, 1.0), nav_eq, 1e-4);
    try std.testing.expect(@abs(nav_eq - root_eq) > 0.5);

    // Unknown node → typed error (not hang / 501).
    var bad: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "eq-bad"),
        .op = try std.testing.allocator.dupe(u8, "equity"),
        .body_json = try std.testing.allocator.dupe(u8, "{\"node_id\":\"p999.t-1.r-1\"}"),
    };
    defer bad.deinit();
    var bad_reply = try handle(&state, bad);
    defer bad_reply.deinit();
    try std.testing.expect(!bad_reply.ok);
    try std.testing.expect(std.mem.eql(u8, bad_reply.error_code orelse "", "unknown_node"));
}

test "ZR-116 dig: categories river made-hand; flop/turn draws available" {
    const river =
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
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 256
        \\threads 1
        \\
    ;
    var river_state = try HostState.init(std.testing.allocator, "zr116-cat-r");
    defer river_state.deinit();
    try river_state.session.begin(river);
    try river_state.session.train(1);
    var river_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "cat-r"),
        .op = try std.testing.allocator.dupe(u8, "categories"),
        .body_json = try std.testing.allocator.dupe(u8, "{\"node_id\":\"p0.t-1.r-1\"}"),
    };
    defer river_req.deinit();
    var river_reply = try handle(&river_state, river_req);
    defer river_reply.deinit();
    try std.testing.expect(river_reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, river_reply.body_json, "\"available\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, river_reply.body_json, "\"model\":\"made-hand\"") != null);

    const flop =
        \\street-config 1
        \\board Ah Kd 7c
        \\pot 100
        \\stack 100
        \\oop-range AsQs:1,2d2h:1
        \\ip-range AsQs:1,2d2h:1
        \\oop-flop-bets 0.5
        \\ip-flop-bets 0.5
        \\first-to-act 0
        \\max-raises 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 256
        \\threads 1
        \\
    ;
    var flop_state = try HostState.init(std.testing.allocator, "zr116-cat-f");
    defer flop_state.deinit();
    try flop_state.session.begin(flop);
    try flop_state.session.train(1);
    var flop_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "cat-f"),
        .op = try std.testing.allocator.dupe(u8, "categories"),
        .body_json = try std.testing.allocator.dupe(u8, "{\"node_id\":\"p0.t-1.r-1\"}"),
    };
    defer flop_req.deinit();
    var flop_reply = try handle(&flop_state, flop_req);
    defer flop_reply.deinit();
    try std.testing.expect(flop_reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, flop_reply.body_json, "\"available\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, flop_reply.body_json, "\"model\":\"draws\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, flop_reply.body_json, "\"exclusive\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, flop_reply.body_json, "flush draw") != null);

    const turn =
        \\street-config 1
        \\board Ah Kd 7c 2s
        \\pot 100
        \\stack 100
        \\oop-range AsQs:1,2d2h:1
        \\ip-range AsQs:1,2d2h:1
        \\oop-bets 0.5
        \\ip-bets 0.5
        \\first-to-act 0
        \\max-raises 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 256
        \\threads 1
        \\
    ;
    var turn_state = try HostState.init(std.testing.allocator, "zr116-cat-t");
    defer turn_state.deinit();
    try turn_state.session.begin(turn);
    try turn_state.session.train(1);
    var turn_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "cat-t"),
        .op = try std.testing.allocator.dupe(u8, "categories"),
        .body_json = try std.testing.allocator.dupe(u8, "{\"node_id\":\"p0.t-1.r-1\"}"),
    };
    defer turn_req.deinit();
    var turn_reply = try handle(&turn_state, turn_req);
    defer turn_reply.deinit();
    try std.testing.expect(turn_reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, turn_reply.body_json, "\"available\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, turn_reply.body_json, "\"model\":\"draws\"") != null);
}

test "ZR-116 dig: equity calculator invalid board + cancel under busy" {
    var state = try HostState.init(std.testing.allocator, "zr116-eq-jobs");
    defer state.deinit();

    // Garbage card → invalid_request (sync reject).
    {
        const body =
            \\{"version":1,"client_revision":"bad-card","method":"exact","target_samples":100,"seed":1,"board":["Zz"],"dead_cards":[],"players":[{"id":"p1","range":"AsAd"},{"id":"p2","range":"KcKd"}]}
        ;
        var req: ipc.Envelope = .{
            .allocator = std.testing.allocator,
            .kind = .request,
            .request_id = try std.testing.allocator.dupe(u8, "bad-card"),
            .op = try std.testing.allocator.dupe(u8, "start_equity_job"),
            .body_json = try std.testing.allocator.dupe(u8, body),
        };
        defer req.deinit();
        var reply = try handle(&state, req);
        defer reply.deinit();
        try std.testing.expect(!reply.ok);
        try std.testing.expect(std.mem.eql(u8, reply.error_code orelse "", "invalid_request"));
    }

    // Two-card board → invalid_request at enqueue.
    {
        const body =
            \\{"version":1,"client_revision":"bad-len","method":"exact","target_samples":100,"seed":1,"board":["2c","3d"],"dead_cards":[],"players":[{"id":"p1","range":"AsAd"},{"id":"p2","range":"KcKd"}]}
        ;
        var req: ipc.Envelope = .{
            .allocator = std.testing.allocator,
            .kind = .request,
            .request_id = try std.testing.allocator.dupe(u8, "bad-len"),
            .op = try std.testing.allocator.dupe(u8, "start_equity_job"),
            .body_json = try std.testing.allocator.dupe(u8, body),
        };
        defer req.deinit();
        var reply = try handle(&state, req);
        defer reply.deinit();
        try std.testing.expect(!reply.ok);
        try std.testing.expect(std.mem.eql(u8, reply.error_code orelse "", "invalid_request"));
    }

    // Duplicate board cards → job fails with invalid_input (not crash).
    {
        const body =
            \\{"version":1,"client_revision":"dup","method":"exact","target_samples":100,"seed":1,"board":["2c","3d","7h","9s","2c"],"dead_cards":[],"players":[{"id":"p1","range":"AsAd"},{"id":"p2","range":"KcKd"}]}
        ;
        var start_req: ipc.Envelope = .{
            .allocator = std.testing.allocator,
            .kind = .request,
            .request_id = try std.testing.allocator.dupe(u8, "dup-start"),
            .op = try std.testing.allocator.dupe(u8, "start_equity_job"),
            .body_json = try std.testing.allocator.dupe(u8, body),
        };
        defer start_req.deinit();
        var start_reply = try handle(&state, start_req);
        defer start_reply.deinit();
        try std.testing.expect(start_reply.ok);
        const job_id_start = std.mem.indexOf(u8, start_reply.body_json, "\"job_id\":\"") orelse return error.TestUnexpectedResult;
        const id_slice = start_reply.body_json[job_id_start + 10 ..];
        const id_end = std.mem.indexOfScalar(u8, id_slice, '"') orelse return error.TestUnexpectedResult;
        const job_id = id_slice[0..id_end];
        var failed = false;
        var attempt: usize = 0;
        while (attempt < 200) : (attempt += 1) {
            std.Thread.sleep(5 * std.time.ns_per_ms);
            var get_body_buf: [64]u8 = undefined;
            const get_body = try std.fmt.bufPrint(&get_body_buf, "{{\"job_id\":\"{s}\"}}", .{job_id});
            var get_req: ipc.Envelope = .{
                .allocator = std.testing.allocator,
                .kind = .request,
                .request_id = try std.testing.allocator.dupe(u8, "dup-get"),
                .op = try std.testing.allocator.dupe(u8, "get_equity_job"),
                .body_json = try std.testing.allocator.dupe(u8, get_body),
            };
            defer get_req.deinit();
            var get_reply = try handle(&state, get_req);
            defer get_reply.deinit();
            try std.testing.expect(get_reply.ok);
            if (std.mem.indexOf(u8, get_reply.body_json, "\"state\":\"failed\"") != null) {
                try std.testing.expect(std.mem.indexOf(u8, get_reply.body_json, "invalid_input") != null);
                failed = true;
                break;
            }
            if (std.mem.indexOf(u8, get_reply.body_json, "\"state\":\"completed\"") != null) {
                try std.testing.expect(false);
            }
        }
        try std.testing.expect(failed);
    }

    // Fill queue to busy, cancel one queued job, enqueue succeeds again.
    {
        const slow =
            \\{"version":1,"client_revision":"busy","method":"monte_carlo","target_samples":5000000,"max_attempts":50000000,"seed":1,"board":[],"dead_cards":[],"players":[{"id":"p1","range":"random"},{"id":"p2","range":"random"}]}
        ;
        var ids: [5][16]u8 = undefined;
        var id_lens: [5]usize = undefined;
        var n: usize = 0;
        while (n < 5) : (n += 1) {
            var start_req: ipc.Envelope = .{
                .allocator = std.testing.allocator,
                .kind = .request,
                .request_id = try std.testing.allocator.dupe(u8, "busy-start"),
                .op = try std.testing.allocator.dupe(u8, "start_equity_job"),
                .body_json = try std.testing.allocator.dupe(u8, slow),
            };
            defer start_req.deinit();
            var start_reply = try handle(&state, start_req);
            defer start_reply.deinit();
            if (!start_reply.ok) {
                try std.testing.expect(std.mem.eql(u8, start_reply.error_code orelse "", "busy"));
                break;
            }
            const job_id_start = std.mem.indexOf(u8, start_reply.body_json, "\"job_id\":\"") orelse return error.TestUnexpectedResult;
            const id_slice = start_reply.body_json[job_id_start + 10 ..];
            const id_end = std.mem.indexOfScalar(u8, id_slice, '"') orelse return error.TestUnexpectedResult;
            @memcpy(ids[n][0..id_end], id_slice[0..id_end]);
            id_lens[n] = id_end;
        }
        try std.testing.expect(n >= 4);

        // One more start should be busy (queue full while one may be running).
        {
            var busy_req: ipc.Envelope = .{
                .allocator = std.testing.allocator,
                .kind = .request,
                .request_id = try std.testing.allocator.dupe(u8, "busy-again"),
                .op = try std.testing.allocator.dupe(u8, "start_equity_job"),
                .body_json = try std.testing.allocator.dupe(u8, slow),
            };
            defer busy_req.deinit();
            var busy_reply = try handle(&state, busy_req);
            defer busy_reply.deinit();
            try std.testing.expect(!busy_reply.ok);
            try std.testing.expect(std.mem.eql(u8, busy_reply.error_code orelse "", "busy"));
        }

        // Cancel last accepted queued id → frees a slot.
        const cancel_id = ids[n - 1][0..id_lens[n - 1]];
        var cancel_body_buf: [64]u8 = undefined;
        const cancel_body = try std.fmt.bufPrint(&cancel_body_buf, "{{\"job_id\":\"{s}\"}}", .{cancel_id});
        var cancel_req: ipc.Envelope = .{
            .allocator = std.testing.allocator,
            .kind = .request,
            .request_id = try std.testing.allocator.dupe(u8, "busy-cancel"),
            .op = try std.testing.allocator.dupe(u8, "cancel_equity_job"),
            .body_json = try std.testing.allocator.dupe(u8, cancel_body),
        };
        defer cancel_req.deinit();
        var cancel_reply = try handle(&state, cancel_req);
        defer cancel_reply.deinit();
        try std.testing.expect(cancel_reply.ok);

        var after_req: ipc.Envelope = .{
            .allocator = std.testing.allocator,
            .kind = .request,
            .request_id = try std.testing.allocator.dupe(u8, "busy-after"),
            .op = try std.testing.allocator.dupe(u8, "start_equity_job"),
            .body_json = try std.testing.allocator.dupe(u8, slow),
        };
        defer after_req.deinit();
        var after_reply = try handle(&state, after_req);
        defer after_reply.deinit();
        try std.testing.expect(after_reply.ok);

        // Cancel running (first) job — must return ok and progress to cancelled/stopped.
        const run_id = ids[0][0..id_lens[0]];
        var run_cancel_buf: [64]u8 = undefined;
        const run_cancel_body = try std.fmt.bufPrint(&run_cancel_buf, "{{\"job_id\":\"{s}\"}}", .{run_id});
        var run_cancel_req: ipc.Envelope = .{
            .allocator = std.testing.allocator,
            .kind = .request,
            .request_id = try std.testing.allocator.dupe(u8, "run-cancel"),
            .op = try std.testing.allocator.dupe(u8, "cancel_equity_job"),
            .body_json = try std.testing.allocator.dupe(u8, run_cancel_body),
        };
        defer run_cancel_req.deinit();
        var run_cancel_reply = try handle(&state, run_cancel_req);
        defer run_cancel_reply.deinit();
        try std.testing.expect(run_cancel_reply.ok);

        var terminal = false;
        var attempt: usize = 0;
        while (attempt < 400) : (attempt += 1) {
            std.Thread.sleep(10 * std.time.ns_per_ms);
            var get_body_buf: [64]u8 = undefined;
            const get_body = try std.fmt.bufPrint(&get_body_buf, "{{\"job_id\":\"{s}\"}}", .{run_id});
            var get_req: ipc.Envelope = .{
                .allocator = std.testing.allocator,
                .kind = .request,
                .request_id = try std.testing.allocator.dupe(u8, "run-get"),
                .op = try std.testing.allocator.dupe(u8, "get_equity_job"),
                .body_json = try std.testing.allocator.dupe(u8, get_body),
            };
            defer get_req.deinit();
            var get_reply = try handle(&state, get_req);
            defer get_reply.deinit();
            try std.testing.expect(get_reply.ok);
            if (std.mem.indexOf(u8, get_reply.body_json, "\"state\":\"cancelled\"") != null or
                std.mem.indexOf(u8, get_reply.body_json, "\"state\":\"stopped\"") != null or
                std.mem.indexOf(u8, get_reply.body_json, "\"state\":\"stopping\"") != null)
            {
                // stopping is transitional; wait for cancelled/stopped when possible
                if (std.mem.indexOf(u8, get_reply.body_json, "\"state\":\"stopping\"") == null) {
                    terminal = true;
                    break;
                }
            }
        }
        try std.testing.expect(terminal);

        // Drain remaining heavy jobs so HostState.deinit cannot hang on worker join.
        var drain_i: usize = 0;
        while (drain_i < n) : (drain_i += 1) {
            const id = ids[drain_i][0..id_lens[drain_i]];
            var buf: [64]u8 = undefined;
            const body = try std.fmt.bufPrint(&buf, "{{\"job_id\":\"{s}\"}}", .{id});
            var req: ipc.Envelope = .{
                .allocator = std.testing.allocator,
                .kind = .request,
                .request_id = try std.testing.allocator.dupe(u8, "drain-cancel"),
                .op = try std.testing.allocator.dupe(u8, "cancel_equity_job"),
                .body_json = try std.testing.allocator.dupe(u8, body),
            };
            defer req.deinit();
            var reply = try handle(&state, req);
            defer reply.deinit();
            try std.testing.expect(reply.ok);
        }
        std.Thread.sleep(50 * std.time.ns_per_ms);
    }
}

test "line_card_report flop solve turn compare has rows" {
    // Flop tree → check-check → turn chance → first card decision → compare turn cards.
    const config =
        \\street-config 1
        \\board Ah Kd 7c
        \\pot 100
        \\stack 100
        \\oop-range 2s2h:1,3s3h:1,AsAc:1
        \\ip-range 2s2h:1,3s3h:1,AsAc:1
        \\first-to-act 0
        \\max-raises 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 256
        \\threads 1
        \\oop-bets
        \\ip-bets
        \\oop-raises
        \\ip-raises
        \\oop-turn-bets
        \\ip-turn-bets
        \\oop-river-bets 0.5
        \\ip-river-bets 0.5
        \\
    ;
    var state = try HostState.init(std.testing.allocator, "line-card-flop");
    defer state.deinit();
    try state.session.begin(config);
    try state.session.train(1);

    // Root Check child.
    var root_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "lc-root"),
        .op = try std.testing.allocator.dupe(u8, "node"),
        .body_json = try std.testing.allocator.dupe(u8, "{\"node_id\":\"p0.t-1.r-1\"}"),
    };
    defer root_req.deinit();
    var root_reply = try handle(&state, root_req);
    defer root_reply.deinit();
    try std.testing.expect(root_reply.ok);
    const p1_start = std.mem.indexOf(u8, root_reply.body_json, "\"children\":[\"") orelse return error.TestUnexpectedResult;
    const p1_id_start = p1_start + "\"children\":[\"".len;
    const p1_id_end = std.mem.indexOfPos(u8, root_reply.body_json, p1_id_start, "\"") orelse return error.TestUnexpectedResult;
    const p1_id = root_reply.body_json[p1_id_start..p1_id_end];

    var p1_body: [96]u8 = undefined;
    const p1_json = try std.fmt.bufPrint(&p1_body, "{{\"node_id\":\"{s}\"}}", .{p1_id});
    var p1_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "lc-p1"),
        .op = try std.testing.allocator.dupe(u8, "node"),
        .body_json = try std.testing.allocator.dupe(u8, p1_json),
    };
    defer p1_req.deinit();
    var p1_reply = try handle(&state, p1_req);
    defer p1_reply.deinit();
    try std.testing.expect(p1_reply.ok);
    // IP Check → chance.
    const ch_start = std.mem.indexOf(u8, p1_reply.body_json, "\"children\":[\"") orelse return error.TestUnexpectedResult;
    const ch_id_start = ch_start + "\"children\":[\"".len;
    const ch_id_end = std.mem.indexOfPos(u8, p1_reply.body_json, ch_id_start, "\"") orelse return error.TestUnexpectedResult;
    const chance_id = p1_reply.body_json[ch_id_start..ch_id_end];

    var ch_body: [96]u8 = undefined;
    const ch_json = try std.fmt.bufPrint(&ch_body, "{{\"node_id\":\"{s}\"}}", .{chance_id});
    var ch_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "lc-ch"),
        .op = try std.testing.allocator.dupe(u8, "node"),
        .body_json = try std.testing.allocator.dupe(u8, ch_json),
    };
    defer ch_req.deinit();
    var ch_reply = try handle(&state, ch_req);
    defer ch_reply.deinit();
    try std.testing.expect(ch_reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, ch_reply.body_json, "\"kind\":\"chance\"") != null);
    // First chance card child → turn decision.
    const card_key = "\"child_id\":\"";
    const card_at = std.mem.indexOf(u8, ch_reply.body_json, card_key) orelse return error.TestUnexpectedResult;
    const card_id_start = card_at + card_key.len;
    const card_id_end = std.mem.indexOfPos(u8, ch_reply.body_json, card_id_start, "\"") orelse return error.TestUnexpectedResult;
    const turn_decision_id = ch_reply.body_json[card_id_start..card_id_end];

    var report_body: [128]u8 = undefined;
    const report_json = try std.fmt.bufPrint(&report_body, "{{\"node_id\":\"{s}\",\"vary_street\":\"turn\"}}", .{turn_decision_id});
    var report_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "lc-report"),
        .op = try std.testing.allocator.dupe(u8, "line_card_report"),
        .body_json = try std.testing.allocator.dupe(u8, report_json),
    };
    defer report_req.deinit();
    var report_reply = try handle(&state, report_req);
    defer report_reply.deinit();
    try std.testing.expect(report_reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, report_reply.body_json, "\"kind\":\"line_card_report\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, report_reply.body_json, "\"vary_street\":\"turn\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, report_reply.body_json, "\"rows\":[") != null);
    try std.testing.expect(std.mem.indexOf(u8, report_reply.body_json, "\"frequencies\":[") != null);
}

test "value_bluffs_post_call flop bet returns hands shape" {
    const config =
        \\street-config 1
        \\board Ah Kd 7c
        \\pot 100
        \\stack 100
        \\oop-range 2s2h:1,3s3h:1,AsAc:1,KsKh:1
        \\ip-range 2s2h:1,3s3h:1,AsAc:1,KsKh:1
        \\first-to-act 0
        \\max-raises 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 256
        \\threads 1
        \\oop-bets 0.5
        \\ip-bets 0.5
        \\
    ;
    var state = try HostState.init(std.testing.allocator, "vb-post-call-flop");
    defer state.deinit();
    try state.session.begin(config);
    try state.session.train(2);

    var req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "vb1"),
        .op = try std.testing.allocator.dupe(u8, "value_bluffs_post_call"),
        .body_json = try std.testing.allocator.dupe(u8, "{\"node_id\":\"p0.t-1.r-1\",\"min_bet_freq\":0.01}"),
    };
    defer req.deinit();
    var reply = try handle(&state, req);
    defer reply.deinit();
    try std.testing.expect(reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"kind\":\"value_bluffs_post_call\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"hands\":[") != null);
    try std.testing.expect(std.mem.indexOf(u8, reply.body_json, "\"call_node_ids\":[") != null);
}

test "wide flop equity and value_bluffs_post_call return numbers" {
    // Same ~496-combo fixture: warm equity + After Call must both succeed.
    const config =
        \\street-config 1
        \\board Ah Kd 7c
        \\pot 100
        \\stack 100
        \\oop-range 22+,A2s+,K2s+,Q2s+,J2s+,T6s+,96s+,86s+,75s+,65s,54s,A2o+,K8o+,Q9o+,J9o,T8o,98o,87o
        \\ip-range 22+,A2s+,K2s+,Q2s+,J2s+,T6s+,96s+,86s+,75s+,65s,54s,A2o+,K8o+,Q9o+,J9o,T8o,98o,87o
        \\first-to-act 0
        \\max-raises 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 3072
        \\threads 1
        \\oop-bets 0.5
        \\ip-bets 0.5
        \\
    ;

    var state = try HostState.init(std.testing.allocator, "wide-flop-eq-vb");
    defer state.deinit();
    try state.session.begin(config);
    try state.session.train(1);

    const game = state.session.game orelse return error.TestUnexpectedResult;
    const n0 = game.hands.combos[0].len;
    const n1 = game.hands.combos[1].len;
    try std.testing.expect(n0 >= 470 and n0 <= 520);
    try std.testing.expect(n1 >= 470 and n1 <= 520);

    var eq_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "wide-eq"),
        .op = try std.testing.allocator.dupe(u8, "equity"),
        .body_json = try std.testing.allocator.dupe(u8, "{\"node_id\":\"p0.t-1.r-1\"}"),
    };
    defer eq_req.deinit();
    var eq_reply = try handle(&state, eq_req);
    defer eq_reply.deinit();
    try std.testing.expect(eq_reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, eq_reply.body_json, "work_limit") == null);
    try std.testing.expect(std.mem.indexOf(u8, eq_reply.body_json, "\"equity\":") != null);
    try std.testing.expect(std.mem.indexOf(u8, eq_reply.body_json, "\"oop_hands\":[") != null);

    var vb_req: ipc.Envelope = .{
        .allocator = std.testing.allocator,
        .kind = .request,
        .request_id = try std.testing.allocator.dupe(u8, "wide-vb"),
        .op = try std.testing.allocator.dupe(u8, "value_bluffs_post_call"),
        .body_json = try std.testing.allocator.dupe(u8, "{\"node_id\":\"p0.t-1.r-1\",\"min_bet_freq\":0.01}"),
    };
    defer vb_req.deinit();
    var vb_reply = try handle(&state, vb_req);
    defer vb_reply.deinit();
    try std.testing.expect(vb_reply.ok);
    try std.testing.expect(std.mem.indexOf(u8, vb_reply.body_json, "work_limit") == null);
    try std.testing.expect(std.mem.indexOf(u8, vb_reply.body_json, "\"kind\":\"value_bluffs_post_call\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, vb_reply.body_json, "\"hands\":[") != null);
    try std.testing.expect(std.mem.indexOf(u8, vb_reply.body_json, "\"equity\":") != null);
}
