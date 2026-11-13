const std = @import("std");
const poker_engine = @import("poker_engine");
const poker_formats = @import("poker_formats");
const budget_allocator = @import("budget_allocator.zig");

pub const BudgetAllocator = budget_allocator.BudgetAllocator;

pub const SessionError = error{
    InvalidSession,
    Busy,
    NothingPublished,
    OpenFailed,
    OutOfMemory,
    BudgetExceeded,
    InvalidStrategy,
    /// Cooperative Stop during begin/compile (ZR-151). Prior solution kept.
    Cancelled,
    /// Average install failed after a committed CFR+ iteration (ZR-145).
    /// Trainer tables remain resumable; distinct from mid-pass corruption.
    StrategyPublishFailed,
} || poker_formats.OpenError || poker_engine.game.street_config.ConfigError || poker_engine.game.compile.CompileError || poker_engine.solve.training_state.TrainError || poker_engine.solve.cfr_plus.CfrError || poker_engine.solve.frozen_walk.FrozenError;

pub const Phase = enum {
    idle,
    compiling,
    training,
    paused,
    published,
    failed,
};

/// Why the latest train loop returned (ZR-90).
pub const TrainTerminal = enum {
    completed,
    paused,
    cancelled,
    accuracy_reached,
    time_limit_reached,
};

pub const Metrics = poker_formats.Metrics;

/// One EV/gap sample for Study status `gap_series` (ZR-171).
pub const GapSeriesPoint = struct {
    iterations: i32 = 0,
    value: f64 = 0,
    nash_gap: f64 = 0,
    accuracy_chips: f64 = 0,
};

pub const gap_series_capacity: usize = 32;

/// Reader lease over the current published average (Study values under train).
/// Holds `readers` until `release` / `deinit`; train publish waits for quiet.
pub const PublishedLease = struct {
    session: ?*Session = null,
    game: poker_engine.game.compile.CompiledGame,
    /// Borrowed view — valid until `release`. Do not deinit.
    published: poker_engine.solve.training_state.PublishedPolicy,
    solution_id: u64 = 0,

    pub fn release(self: *PublishedLease) void {
        if (self.session) |sess| {
            sess.releaseReader();
            self.session = null;
        }
    }

    pub fn deinit(self: *PublishedLease) void {
        self.release();
    }
};

/// Application-owned solution lifetime. Fail-closed on open/replace.
pub const Session = struct {
    /// Host/GPA for the budget wrapper itself (not charged).
    parent: std.mem.Allocator,
    /// Heap-stable so `allocator` stays valid when Session is moved by value.
    budget: *BudgetAllocator,
    /// Engine-owned heap: compile / tables / publish / analysis / checkpoint staging.
    allocator: std.mem.Allocator,
    phase: Phase = .idle,
    solution_id: u64 = 0,
    baseline_id: u64 = 0,
    next_id: u64 = 1,
    config_text: []u8 = &.{},
    game: ?poker_engine.game.compile.CompiledGame = null,
    training: ?poker_engine.solve.training_state.TrainingState = null,
    published: ?poker_engine.solve.training_state.PublishedPolicy = null,
    locks_text: []u8 = &.{},
    strategy_edits_text: []u8 = &.{},
    /// CFR / pre-edit baseline for strategy-edit restore (owned). Null until first edit
    /// or when train replaces the published policy.
    strategy_edit_baseline: ?[]f32 = null,
    metrics: Metrics = .{},
    has_metrics: bool = false,
    /// Wall clock when the active train job started (0 = none / frozen into cache).
    train_started_ns: i128 = 0,
    /// Frozen elapsed seconds after the job ends (<0 = unset).
    runtime_seconds_cached: f64 = -1,
    /// Bounded EV/gap history for Study footer ETA (ZR-171).
    gap_series_len: usize = 0,
    gap_series: [gap_series_capacity]GapSeriesPoint = [_]GapSeriesPoint{GapSeriesPoint{}} ** gap_series_capacity,
    /// Job Accuracy target as pot fraction (<0 = unset / iteration-only).
    accuracy_target: f64 = -1,
    /// Job wall-clock time limit seconds (<0 = unset).
    time_limit_seconds: f64 = -1,
    frozen: bool = false,
    /// Shared worker budget for frozen chance steal (D3). From config `threads` or host override.
    threads: u32 = 1,
    /// Persistent StreetBatch-style engine: ranks + worker scratch + chance pool
    /// survive Acc-stop `train(1)` / eval cycles (C++ Engine lifetime).
    /// Cleared on `begin` / deinit / thread-count change. Do not move after the
    /// chance pool has started (lazy on first parallel chance dispatch).
    frozen_ctx: ?poker_engine.solve.frozen_walk.FrozenCtx = null,
    /// Protects phase / published swap / reader count (mid-train Study browse).
    mu: std.Thread.Mutex = .{},
    readers: u32 = 0,
    quiet: std.Thread.Condition = .{},
    /// Signaled when a new policy_revision is installed (values waiters).
    published_cv: std.Thread.Condition = .{},
    /// True when training tables came from a real train or a checkpoint with flag_training.
    /// Browse-only opens leave this false so Continue stays disabled (ZR-96).
    has_training: bool = false,
    /// Cooperative control flags polled at iteration boundaries (ZR-90).
    stop_requested: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),
    pause_requested: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),
    last_terminal: TrainTerminal = .completed,
    /// Config memory budget in bytes (0 = unset / unlimited for legacy).
    memory_budget_bytes: u64 = 0,
    /// Study live strategy publish cadence (ZR-133 Change C).
    /// Iteration progress advances every train step; full average install is bounded.
    /// Default 10 matches Study EV/gap refresh ("at least every 10 iters").
    publish_every: i32 = 10,
    /// Completed iters since the last installed strategy snapshot (carries across train(1)).
    iters_since_publish: i32 = 0,
    /// `training.trained` value of the last installed snapshot (0 = never).
    last_published_trained: i32 = 0,
    /// Force a publish on the next completed iteration (e.g. after resolve-locked reset).
    force_next_publish: bool = false,
    /// Recycled average buffer after readers release (C++ ensure_average reuse).
    average_spare: ?[]f32 = null,
    /// True while an in-place average rewrite holds the live published buffer (ZR-164).
    /// Study `borrowPublished` waits until clear so readers never see a half-filled average.
    publishing_in_place: bool = false,
    /// Soft cadence/final publish skips under budget (ZR-164). Does not brick Solve.
    publish_skips: u32 = 0,
    /// Last fully completed CFR+ iteration (both player passes). Matches
    /// `training.trained` when clean; used to refuse resume after mid-pass faults (ZR-145).
    last_committed_trained: i32 = 0,
    /// True while an in-flight CFR+ iteration has mutated tables but not committed.
    cfr_pass_mutated: bool = false,
    /// Test fault injection: fail after OOP pass (partial tables) on the next train.
    inject_mid_pass_fault: bool = false,
    /// Test fault injection: fail the next strategy publish after a committed iter.
    inject_publish_fault: bool = false,
    /// Test fault injection: next cadence publish returns BudgetExceeded (soft-skip path).
    inject_publish_oom: bool = false,

    pub fn init(parent: std.mem.Allocator) SessionError!Session {
        const budget = parent.create(BudgetAllocator) catch return error.OutOfMemory;
        budget.* = BudgetAllocator.init(parent);
        return .{
            .parent = parent,
            .budget = budget,
            .allocator = budget.allocator(),
        };
    }

    /// Map allocator OOM to `BudgetExceeded` when a memory-mib ceiling is active.
    pub fn mapAllocErr(self: *const Session, err: anyerror) SessionError {
        if (err == error.OutOfMemory and self.budget.limit() > 0) return error.BudgetExceeded;
        if (err == error.OutOfMemory) return error.OutOfMemory;
        if (err == error.BudgetExceeded) return error.BudgetExceeded;
        return error.InvalidSession;
    }

    pub fn allocatedBytes(self: *const Session) u64 {
        return self.budget.live();
    }

    pub fn peakAllocatedBytes(self: *const Session) u64 {
        return self.budget.peak();
    }

    pub fn canContinue(self: *const Session) bool {
        const ok = self.has_training and self.published != null and
            (self.phase == .paused or self.phase == .published);
        // Negative space: Continue never without resume-safe trainer tables.
        if (!self.has_training) std.debug.assert(!ok);
        if (ok) {
            std.debug.assert(self.has_training);
            std.debug.assert(self.published != null);
        }
        return ok;
    }

    pub fn requestStop(self: *Session) void {
        self.stop_requested.store(true, .release);
    }

    pub fn requestPause(self: *Session) void {
        self.pause_requested.store(true, .release);
    }

    pub fn clearControlFlags(self: *Session) void {
        self.stop_requested.store(false, .release);
        self.pause_requested.store(false, .release);
    }

    fn shouldStopTrain(ctx: *anyopaque) bool {
        const self: *Session = @ptrCast(@alignCast(ctx));
        return self.stop_requested.load(.acquire) or self.pause_requested.load(.acquire);
    }

    fn shouldCancelCompile(ctx: ?*anyopaque) bool {
        const self: *Session = @ptrCast(@alignCast(ctx orelse return false));
        return self.stop_requested.load(.acquire);
    }

    fn busyForReplace(self: *const Session) bool {
        return self.phase == .training or self.phase == .compiling;
    }

    /// Rough peak for compiled game + training tables + one published average.
    fn estimateSolutionBytes(game: poker_engine.game.compile.CompiledGame) u64 {
        const te: u64 = @intCast(@max(game.table_entries, 0));
        const deal_bytes = game.deals.len * @sizeOf(poker_engine.game.compile.Deal);
        const slot_bytes = game.slots.len * @sizeOf(poker_engine.game.compile.Slot);
        const node_bytes = game.nodes.len * @sizeOf(poker_engine.game.compile.Node);
        // regret + strategy_sum + sigma + published average
        const table_bytes = te * @sizeOf(f32) * 4;
        // Conservative scratch / ranks / maps overhead for flop-scale trees.
        const overhead = te * 32 + game.deals.len * 16;
        return deal_bytes + slot_bytes + node_bytes + table_bytes + overhead;
    }

    /// f32 published averages (CFR normalizeAverage) need a looser sum check than
    /// f64 lock rows (`lock_prob_sum_tolerance` = 1e-12). Reject NaN/negatives and
    /// gross corruption; allow normal f32 rounding error so save→open continues.
    const average_row_sum_tolerance: f64 = 1e-5;

    fn validateAveragePolicy(
        game: poker_engine.game.compile.CompiledGame,
        average: []const f32,
    ) bool {
        if (average.len != @as(usize, @intCast(game.table_entries))) return false;
        for (game.slots) |slot| {
            const n_actions: usize = game.nodes[@intCast(slot.node)].n_actions;
            if (n_actions == 0) continue;
            const base: usize = @intCast(slot.base);
            if (base + n_actions > average.len) return false;
            var sum: f64 = 0;
            var a: usize = 0;
            while (a < n_actions) : (a += 1) {
                const p: f64 = average[base + a];
                if (!std.math.isFinite(p) or p < 0.0) return false;
                sum += p;
            }
            if (@abs(sum - 1.0) > average_row_sum_tolerance) return false;
        }
        return true;
    }

    pub fn deinit(self: *Session) void {
        self.mu.lock();
        while (self.readers != 0) {
            self.quiet.wait(&self.mu);
        }
        self.mu.unlock();
        self.clearSolution();
        const parent = self.parent;
        const budget = self.budget;
        parent.destroy(budget);
        self.* = undefined;
    }

    fn clearPublishCadence(self: *Session) void {
        self.iters_since_publish = 0;
        self.last_published_trained = 0;
        self.force_next_publish = false;
        self.last_committed_trained = 0;
        self.cfr_pass_mutated = false;
        self.inject_mid_pass_fault = false;
        self.inject_publish_fault = false;
        self.inject_publish_oom = false;
        self.publishing_in_place = false;
        self.publish_skips = 0;
        if (self.average_spare) |buf| {
            self.allocator.free(buf);
            self.average_spare = null;
        }
    }

    /// After a mid-pass train fault: keep the last published average browsable,
    /// but refuse Continue until an open checkpoint or fresh begin/solve (ZR-145).
    fn invalidateTrainerForResumeLocked(self: *Session) void {
        self.has_training = false;
        self.cfr_pass_mutated = false;
        self.inject_mid_pass_fault = false;
        self.inject_publish_fault = false;
        self.inject_publish_oom = false;
        std.debug.assert(!self.has_training);
        std.debug.assert(!self.cfr_pass_mutated);
        std.debug.assert(!self.canContinue());
    }

    fn clearSolution(self: *Session) void {
        // Drop frozen engine before game tables it references.
        if (self.frozen_ctx) |*ctx| {
            ctx.deinit();
            self.frozen_ctx = null;
        }
        if (self.config_text.len != 0) {
            self.allocator.free(self.config_text);
            self.config_text = &.{};
        }
        if (self.game) |*game| {
            game.deinit();
            self.game = null;
        }
        if (self.training) |*state| {
            state.deinit();
            self.training = null;
        }
        if (self.published) |*policy| {
            policy.deinit();
            self.published = null;
        }
        self.clearPublishCadence();
        if (self.locks_text.len != 0) {
            self.allocator.free(self.locks_text);
            self.locks_text = &.{};
        }
        if (self.strategy_edits_text.len != 0) {
            self.allocator.free(self.strategy_edits_text);
            self.strategy_edits_text = &.{};
        }
        self.clearStrategyEditBaseline();
        self.metrics = .{};
        self.has_metrics = false;
        self.clearProgressTracking();
        self.frozen = false;
        self.threads = 1;
        self.has_training = false;
        self.memory_budget_bytes = 0;
        self.last_terminal = .completed;
        self.clearControlFlags();
        self.phase = .idle;
    }

    fn clampThreads(threads: i32) u32 {
        if (threads < 1) return 1;
        return @intCast(@min(threads, 64));
    }

    /// Override worker count (host D3 budget). Clamped to 1..64.
    /// Recreates persistent frozen ctx on next train/eval if the count changes.
    pub fn setThreads(self: *Session, threads: u32) void {
        const next: u32 = if (threads < 1) 1 else @min(threads, 64);
        if (next != self.threads) {
            if (self.frozen_ctx) |*ctx| {
                ctx.deinit();
                self.frozen_ctx = null;
            }
        }
        self.threads = next;
    }

    /// Create or reuse Session-owned FrozenCtx (ranks filled once).
    fn ensureFrozenCtx(self: *Session) SessionError!*poker_engine.solve.frozen_walk.FrozenCtx {
        const game = self.game orelse return error.InvalidSession;
        const state = &(self.training orelse return error.InvalidSession);
        if (self.frozen_ctx) |*ctx| {
            if (ctx.threads == self.threads) {
                ctx.state = state;
                ctx.game = game;
                return ctx;
            }
            ctx.deinit();
            self.frozen_ctx = null;
        }
        var ctx = poker_engine.solve.frozen_walk.FrozenCtx.initThreaded(
            self.allocator,
            game,
            state,
            self.threads,
        ) catch |err| {
            if (err == error.OutOfMemory) return self.mapAllocErr(err);
            return err;
        };
        errdefer ctx.deinit();
        try ctx.ensureAllRanksReady();
        self.frozen_ctx = ctx;
        return &(self.frozen_ctx.?);
    }

    /// Begin a new solve from street-config text. On failure, prior solution is kept.
    /// Stop (`requestStop`) aborts at compile stage boundaries without installing (ZR-151).
    pub fn begin(self: *Session, config_text: []const u8) SessionError!void {
        self.mu.lock();
        if (self.busyForReplace()) {
            self.mu.unlock();
            return error.Busy;
        }
        const prior_phase = self.phase;
        // Mark compiling so Open/Save busy guards and status agree with begin_running.
        self.phase = .compiling;
        self.mu.unlock();
        errdefer {
            self.mu.lock();
            if (self.phase == .compiling) self.phase = prior_phase;
            self.mu.unlock();
        }

        if (self.stop_requested.load(.acquire)) {
            self.clearControlFlags();
            return error.Cancelled;
        }

        // Parse against parent so a tiny over-budget config cannot fail on the
        // street-config text itself when the session is already near its ceiling.
        var spec = try poker_engine.game.parseStreetConfig(self.parent, config_text);
        defer spec.deinit();
        if (spec.memory_mib <= 0) return error.BudgetExceeded;
        const budget_bytes: u64 = @as(u64, @intCast(spec.memory_mib)) * 1024 * 1024;

        // Shared memory-mib ceiling (ZR-156): do not raise to old+new. Hold the
        // prior solution until install; if old and new cannot coexist under
        // `budget_bytes`, refuse and keep the prior open.
        const prior_limit = self.budget.limit();
        const prior_budget_field = self.memory_budget_bytes;
        const old_live = self.budget.live();
        self.budget.setLimit(budget_bytes);
        errdefer {
            self.budget.setLimit(prior_limit);
            self.memory_budget_bytes = prior_budget_field;
        }
        // Prior alone already above the new ceiling → cannot stage a replacement.
        if (old_live > budget_bytes) return error.BudgetExceeded;

        // Under a declared budget, construction OOM is a budget failure (charge-
        // before-allocate during compile growth + tables). Cancel polls between
        // compile stages so Stop during flop tree build exits without install.
        var game = poker_engine.game.compile.compileCancelable(
            self.allocator,
            spec,
            shouldCancelCompile,
            self,
        ) catch |err| {
            if (err == error.Cancelled) {
                self.clearControlFlags();
                return error.Cancelled;
            }
            if (err == error.OutOfMemory) return error.BudgetExceeded;
            return err;
        };
        errdefer game.deinit();
        if (self.stop_requested.load(.acquire)) {
            game.deinit();
            self.clearControlFlags();
            return error.Cancelled;
        }
        const estimated = estimateSolutionBytes(game);
        if (estimated > budget_bytes) return error.BudgetExceeded;
        // Coexistence preflight: old live + new estimate must fit the shared ceiling.
        if (old_live > 0 and estimated > budget_bytes - old_live) return error.BudgetExceeded;

        var training = poker_engine.solve.training_state.TrainingState.init(self.allocator, game) catch |err| {
            if (err == error.OutOfMemory) return error.BudgetExceeded;
            return err;
        };
        errdefer training.deinit();
        if (self.stop_requested.load(.acquire)) {
            self.clearControlFlags();
            return error.Cancelled;
        }
        const owned_config = self.allocator.dupe(u8, config_text) catch return error.BudgetExceeded;
        errdefer self.allocator.free(owned_config);
        const threads = clampThreads(spec.threads);

        // Install only after compile+train tables succeed (fail-closed).
        self.mu.lock();
        defer self.mu.unlock();
        // `.compiling` is our own begin gate; treat other busy phases as conflict.
        if (self.phase != .compiling and self.busyForReplace()) return error.Busy;
        if (self.stop_requested.load(.acquire)) {
            self.clearControlFlags();
            return error.Cancelled;
        }
        while (self.readers != 0) {
            self.quiet.wait(&self.mu);
        }
        self.clearSolution();
        self.budget.setLimit(budget_bytes);
        self.config_text = owned_config;
        self.game = game;
        self.training = training;
        self.threads = threads;
        self.memory_budget_bytes = budget_bytes;
        self.has_training = true;
        self.solution_id = self.next_id;
        self.next_id += 1;
        self.baseline_id = 0;
        self.clearControlFlags();
        self.last_terminal = .completed;
        // Ready to train; not yet published. Open may still replace (fail-closed).
        self.phase = .paused;
        // Postconditions: fail-closed install left a resume-safe unpublished session.
        std.debug.assert(self.has_training);
        std.debug.assert(self.training != null);
        std.debug.assert(self.game != null);
        std.debug.assert(self.phase == .paused);
        std.debug.assert(self.memory_budget_bytes == budget_bytes);
        std.debug.assert(self.budget.limit() == budget_bytes);
        std.debug.assert(self.budget.live() <= budget_bytes);
        std.debug.assert(!self.cfr_pass_mutated);
        std.debug.assert(self.last_committed_trained == 0);
    }

    fn clearStrategyEditBaseline(self: *Session) void {
        if (self.strategy_edit_baseline) |buf| {
            self.allocator.free(buf);
            self.strategy_edit_baseline = null;
        }
    }

    fn recycleAverageBufferLocked(self: *Session, buf: []f32) void {
        if (buf.len == 0) return;
        if (self.average_spare) |spare| {
            if (spare.len == buf.len) {
                // Keep one matching spare; free the duplicate.
                self.allocator.free(buf);
                return;
            }
            self.allocator.free(spare);
        }
        self.average_spare = buf;
    }

    fn takeAverageBufferLocked(self: *Session, n: usize) error{OutOfMemory}![]f32 {
        if (n == 0) return &.{};
        if (self.average_spare) |spare| {
            if (spare.len == n) {
                self.average_spare = null;
                return spare;
            }
            self.allocator.free(spare);
            self.average_spare = null;
        }
        return self.allocator.alloc(f32, n) catch return error.OutOfMemory;
    }

    fn installPublishedLocked(self: *Session, next: poker_engine.solve.training_state.PublishedPolicy) void {
        // Caller holds `mu`. Wait until no Study readers hold the prior average.
        while (self.readers != 0 or self.publishing_in_place) {
            self.quiet.wait(&self.mu);
        }
        if (self.published) |*old| {
            // Recycle the prior average into the spare once readers have released.
            if (old.average.len != 0) {
                const recycled = old.average;
                old.average = &.{};
                old.deinit();
                self.recycleAverageBufferLocked(recycled);
            } else {
                old.deinit();
            }
        }
        self.published = next;
        // Fresh CFR publish invalidates free-form overlays (C++ clear on solve).
        self.notePublishedInstalledLocked(next.trained);
    }

    /// Bookkeeping shared by swap-install and in-place rewrite after a successful fill.
    fn notePublishedInstalledLocked(self: *Session, trained: i32) void {
        self.last_published_trained = trained;
        self.iters_since_publish = 0;
        self.force_next_publish = false;
        if (self.strategy_edits_text.len != 0) {
            self.allocator.free(self.strategy_edits_text);
            self.strategy_edits_text = &.{};
        }
        self.clearStrategyEditBaseline();
        self.published_cv.broadcast();
    }

    fn shouldPublishCadenceLocked(self: *const Session) bool {
        if (self.published == null) return true;
        if (self.force_next_publish) return true;
        if (self.publish_every <= 1) return true;
        return self.iters_since_publish >= self.publish_every;
    }

    /// True when a publish fault is soft (keep prior average + continue train).
    fn isSoftPublishPressure(err: anyerror) bool {
        return err == error.OutOfMemory or err == error.BudgetExceeded;
    }

    /// Soft-skip a cadence/final publish under memory pressure when a prior average
    /// remains browsable (ZR-164). Defers the next attempt by a full cadence window
    /// so we do not thrash alloc every subsequent iter.
    fn softSkipPublishLocked(self: *Session) void {
        std.debug.assert(self.published != null);
        self.iters_since_publish = 0;
        self.force_next_publish = false;
        self.publish_skips +%= 1;
        std.debug.assert(self.publish_skips > 0);
    }

    /// Materialize the exact average for the current `training.trained` and install it.
    /// Used by cadence publishes, Acc eval, save, and pause/stop/completion flushes.
    ///
    /// ZR-164: when a published buffer already exists and Study readers are quiet,
    /// rewrite it in place so flop cadence does not peak at old+new average under
    /// `memory-mib`. Otherwise allocate (spare reuse) then swap-install.
    fn publishExactAverage(self: *Session) SessionError!void {
        const game = self.game orelse return error.InvalidSession;
        const state = &(self.training orelse return error.InvalidSession);
        const n = state.strategy_sum.len;
        const threads = if (self.threads < 1) @as(u32, 1) else self.threads;

        self.mu.lock();
        if (self.inject_publish_oom) {
            self.inject_publish_oom = false;
            self.mu.unlock();
            return error.BudgetExceeded;
        }
        // Wait until quiet — required for in-place rewrite and for a stable swap.
        while (self.readers != 0 or self.publishing_in_place) {
            self.quiet.wait(&self.mu);
        }

        // Prefer in-place rewrite: no second `table_entries` f32 buffer (flop cadence).
        if (self.published) |*pub_policy| {
            if (pub_policy.average.len == n and n != 0) {
                const buf = pub_policy.average;
                self.publishing_in_place = true;
                std.debug.assert(self.publishing_in_place);
                std.debug.assert(self.readers == 0);
                self.mu.unlock();

                const fill_err = poker_engine.solve.training_state.publishAverageIntoThreaded(
                    self.allocator,
                    game,
                    state,
                    buf,
                    threads,
                );

                self.mu.lock();
                defer {
                    self.publishing_in_place = false;
                    self.quiet.broadcast();
                    self.mu.unlock();
                }
                fill_err catch |err| {
                    if (err == error.OutOfMemory) return self.mapAllocErr(err);
                    return error.InvalidSession;
                };
                while (self.readers != 0) {
                    self.quiet.wait(&self.mu);
                }
                const live = &(self.published orelse return error.InvalidSession);
                std.debug.assert(live.average.ptr == buf.ptr);
                live.revision = state.policy_revision;
                live.trained = state.trained;
                self.notePublishedInstalledLocked(state.trained);
                return;
            }
        }

        const buf = self.takeAverageBufferLocked(n) catch {
            self.mu.unlock();
            return self.mapAllocErr(error.OutOfMemory);
        };
        self.mu.unlock();
        errdefer {
            if (n != 0) {
                self.mu.lock();
                self.recycleAverageBufferLocked(buf);
                self.mu.unlock();
            }
        }

        poker_engine.solve.training_state.publishAverageIntoThreaded(
            self.allocator,
            game,
            state,
            buf,
            threads,
        ) catch |err| {
            if (err == error.OutOfMemory) return self.mapAllocErr(err);
            return error.InvalidSession;
        };

        const next = poker_engine.solve.training_state.PublishedPolicy{
            .allocator = self.allocator,
            .average = buf,
            .revision = state.policy_revision,
            .trained = state.trained,
        };
        self.mu.lock();
        defer self.mu.unlock();
        self.installPublishedLocked(next);
    }

    /// Force-install the exact average when trainer progress leads the published snapshot.
    pub fn ensurePublishedExact(self: *Session) SessionError!void {
        self.mu.lock();
        const trained: i32 = if (self.training) |state| state.trained else 0;
        const need = trained > 0 and (self.published == null or self.last_published_trained != trained);
        self.mu.unlock();
        if (!need) return;
        try self.publishExactAverage();
    }

    /// Ensure a restore baseline exists before mutating published average for edits.
    pub fn ensureStrategyEditBaseline(self: *Session) SessionError!void {
        self.mu.lock();
        defer self.mu.unlock();
        if (self.strategy_edit_baseline != null) return;
        const published = self.published orelse return error.NothingPublished;
        if (published.average.len == 0) return error.NothingPublished;
        // Prefer a clean CFR republish when trainer tables exist.
        if (self.has_training) {
            if (self.training) |*state| {
                if (self.game) |game| {
                    const owned = self.allocator.alloc(f32, published.average.len) catch return error.OutOfMemory;
                    errdefer self.allocator.free(owned);
                    @memcpy(owned, published.average);
                    poker_engine.solve.training_state.republishAverageInto(
                        self.allocator,
                        game,
                        state,
                        owned,
                    ) catch {
                        self.allocator.free(owned);
                        return error.InvalidSession;
                    };
                    self.strategy_edit_baseline = owned;
                    return;
                }
            }
        }
        const owned = self.allocator.dupe(f32, published.average) catch return error.OutOfMemory;
        self.strategy_edit_baseline = owned;
    }

    /// Restore published average from baseline (or strategy_sum) then bump revision.
    pub fn restoreStrategyEditBaseline(self: *Session) SessionError!void {
        self.mu.lock();
        defer self.mu.unlock();
        const published = &(self.published orelse return error.NothingPublished);
        if (published.average.len == 0) return error.NothingPublished;
        if (self.has_training) {
            if (self.training) |*state| {
                if (self.game) |game| {
                    poker_engine.solve.training_state.republishAverageInto(
                        self.allocator,
                        game,
                        state,
                        published.average,
                    ) catch return error.InvalidSession;
                    published.revision += 1;
                    self.published_cv.broadcast();
                    return;
                }
            }
        }
        const baseline = self.strategy_edit_baseline orelse return error.InvalidSession;
        if (baseline.len != published.average.len) return error.InvalidSession;
        @memcpy(published.average, baseline);
        published.revision += 1;
        self.published_cv.broadcast();
    }

    /// Bump published policy_revision after in-place average overlay writes.
    pub fn bumpPolicyRevision(self: *Session) SessionError!void {
        self.mu.lock();
        defer self.mu.unlock();
        const published = &(self.published orelse return error.NothingPublished);
        published.revision += 1;
        self.published_cv.broadcast();
    }

    /// Mutable view of published average (caller must not train/replace concurrently).
    pub fn publishedAverageMut(self: *Session) SessionError![]f32 {
        self.mu.lock();
        defer self.mu.unlock();
        const published = &(self.published orelse return error.NothingPublished);
        if (published.average.len == 0) return error.NothingPublished;
        return published.average;
    }

    /// After each committed CFR iteration: bump cadence counter; publish only on bound.
    fn onTrainIterDone(ctx: *anyopaque, trained: i32) anyerror!void {
        const self: *Session = @ptrCast(@alignCast(ctx));
        _ = trained;
        self.mu.lock();
        if (self.inject_publish_fault) {
            self.inject_publish_fault = false;
            self.mu.unlock();
            return error.StrategyPublishFailed;
        }
        self.iters_since_publish += 1;
        const want = self.shouldPublishCadenceLocked();
        const had_published = self.published != null;
        self.mu.unlock();
        if (!want) return;
        self.publishExactAverage() catch |err| {
            // ZR-164: cadence OOM must not abort train / sticky-brick Solve when a
            // prior average is still browsable. Defer and keep iterating.
            if (had_published and isSoftPublishPressure(err)) {
                self.mu.lock();
                self.softSkipPublishLocked();
                self.mu.unlock();
                return;
            }
            return error.StrategyPublishFailed;
        };
    }

    /// Stage hook: mark mutation window, inject mid-pass faults, stamp commit (ZR-145).
    fn onTrainStage(ctx: *anyopaque, stage: poker_engine.solve.frozen_walk.TrainStage) anyerror!void {
        const self: *Session = @ptrCast(@alignCast(ctx));
        self.mu.lock();
        defer self.mu.unlock();
        switch (stage) {
            .before_passes => {
                self.cfr_pass_mutated = true;
                std.debug.assert(self.cfr_pass_mutated);
            },
            .after_oop_pass => {
                // Mid-pass: mutation flag must still be set until commit.
                std.debug.assert(self.cfr_pass_mutated);
                if (self.inject_mid_pass_fault) {
                    self.inject_mid_pass_fault = false;
                    return error.InvalidFrozen;
                }
            },
            .committed => {
                if (self.training) |state| {
                    self.last_committed_trained = state.trained;
                    std.debug.assert(self.last_committed_trained == state.trained);
                }
                self.cfr_pass_mutated = false;
                std.debug.assert(!self.cfr_pass_mutated);
            },
        }
    }

    /// Durable recovery after a real train failure left `.failed` (ZR-123).
    /// Cooperative early stop/pause already returns `.paused` (#311); this path
    /// covers errdefer / hard train faults so Continue/Solve can restart when
    /// trainer state is still present — without requiring a full re-begin.
    /// Mid-pass corruption clears `has_training` (ZR-145) and refuses recovery.
    pub fn recoverTrainReady(self: *Session) SessionError!void {
        self.mu.lock();
        defer self.mu.unlock();
        if (self.phase == .paused or self.phase == .published) return;
        if (self.phase != .failed) return error.InvalidSession;
        if (!self.has_training or self.training == null or self.game == null) {
            return error.InvalidSession;
        }
        self.phase = if (self.published != null) .published else .paused;
        self.clearControlFlags();
    }

    pub fn train(self: *Session, iterations: i32) SessionError!void {
        self.mu.lock();
        // Recover sticky `.failed` before the ready-phase gate (ZR-123).
        // ZR-145: only when trainer tables are still resume-safe (`has_training`).
        if (self.phase == .failed) {
            if (!self.has_training or self.training == null or self.game == null) {
                self.mu.unlock();
                return error.InvalidSession;
            }
            self.phase = if (self.published != null) .published else .paused;
            self.clearControlFlags();
        }
        if (self.phase != .paused and self.phase != .published) {
            self.mu.unlock();
            return error.InvalidSession;
        }
        if (self.game == null) {
            self.mu.unlock();
            return error.InvalidSession;
        }
        if (!self.has_training) {
            self.mu.unlock();
            return error.InvalidSession;
        }
        const state = &(self.training orelse {
            self.mu.unlock();
            return error.InvalidSession;
        });
        // Snapshot lock overlay text under the session mutex (C++ SolveConfig::locks).
        const locks_snapshot: []u8 = if (self.locks_text.len != 0)
            (self.allocator.dupe(u8, self.locks_text) catch {
                self.mu.unlock();
                return error.OutOfMemory;
            })
        else
            &.{};
        // Do not clear stop/pause here — host admits a fresh job by clearing first;
        // mid-loop trainGated must observe flags set while the prior step ran.
        self.phase = .training;
        self.cfr_pass_mutated = false;
        self.mu.unlock();
        defer if (locks_snapshot.len != 0) self.allocator.free(locks_snapshot);
        errdefer |err| {
            self.mu.lock();
            defer self.mu.unlock();
            if (err == error.StrategyPublishFailed) {
                // Tables committed; prior published average stays browsable; Continue OK.
                if (self.training) |ts| self.last_committed_trained = ts.trained;
                self.cfr_pass_mutated = false;
                self.has_training = true;
                self.phase = if (self.published != null) .published else .paused;
                // Publish ≠ mid-pass: trainer stays resume-safe.
                std.debug.assert(self.has_training);
                std.debug.assert(!self.cfr_pass_mutated);
                std.debug.assert(self.training != null);
                if (self.published != null) std.debug.assert(self.canContinue());
            } else if (self.cfr_pass_mutated) {
                // Partial CFR+ mutation — browse last published only; need ckpt/begin.
                self.invalidateTrainerForResumeLocked();
                self.phase = if (self.published != null) .published else .failed;
                std.debug.assert(!self.has_training);
                std.debug.assert(!self.canContinue());
            } else {
                self.cfr_pass_mutated = false;
                self.phase = if (self.published != null) .published else .failed;
                std.debug.assert(!self.cfr_pass_mutated);
            }
        }

        var locks_owned: ?poker_engine.solve.node_lock.LockSet = null;
        defer if (locks_owned) |*owned| owned.deinit();
        if (locks_snapshot.len != 0) {
            locks_owned = poker_engine.solve.node_lock.parseLockSet(self.allocator, locks_snapshot) catch {
                return error.InvalidSession;
            };
        }

        // Persistent FrozenCtx: ranks / scratch survive Acc-stop train(1) cycles.
        const ctx = try self.ensureFrozenCtx();
        ctx.locks = if (locks_owned) |*owned| owned else null;
        defer ctx.locks = null;
        var stub = try poker_engine.solve.frozen_walk.trainFrozenCfrPlusOnCtxStaged(
            ctx,
            state,
            iterations,
            onTrainIterDone,
            self,
            shouldStopTrain,
            self,
            onTrainStage,
            self,
        );
        // Cadence may have deferred the last average; stub has no owned buffer.
        stub.deinit();

        const stopped = self.stop_requested.load(.acquire);
        const paused = self.pause_requested.load(.acquire);
        // Force exact publish on pause/stop, or when finishing a multi-iter batch.
        // Single-iter Acc `train(1)` carries cadence; trainGated / save force when needed.
        const force_final = stopped or paused or iterations != 1;
        if (force_final) {
            self.ensurePublishedExact() catch |err| {
                // ZR-164: completion/pause flush under budget keeps prior average +
                // completed train (no sticky StrategyPublishFailed brick).
                self.mu.lock();
                const keep = self.published != null and isSoftPublishPressure(err);
                if (keep) self.softSkipPublishLocked();
                self.mu.unlock();
                if (!keep) return error.StrategyPublishFailed;
            };
        }

        self.mu.lock();
        if (self.training) |ts| self.last_committed_trained = ts.trained;
        if (stopped) {
            self.last_terminal = .cancelled;
            // No publish yet: return to post-begin `.paused` so Solve/Continue can
            // restart without re-begin (ZR-106 short-admit + immediate Stop).
            self.phase = .paused;
        } else if (paused) {
            self.last_terminal = .paused;
            self.phase = .paused;
        } else {
            self.last_terminal = .completed;
            // Multi-iter / forced publish should have an average; train(1) mid-cadence
            // may still be unpublished until Acc/save/pause flushes.
            self.phase = if (self.published != null) .published else .paused;
        }
        self.has_training = true;
        self.cfr_pass_mutated = false;
        // Successful train exit: committed counters match trainer; mutation window closed.
        std.debug.assert(self.has_training);
        std.debug.assert(!self.cfr_pass_mutated);
        if (self.training) |ts| {
            std.debug.assert(self.last_committed_trained == ts.trained);
        }
        std.debug.assert(self.phase == .paused or self.phase == .published);
        self.mu.unlock();
        self.clearControlFlags();
    }

    /// Result of evaluating the exact average for the current trained iteration (ZR-153).
    pub const ExactIterEval = struct {
        trained: i32,
        eval: poker_engine.solve.frozen_walk.FrozenEval,
    };

    /// Pio Accuracy stop threshold in chip EV units (ZR-153).
    /// `pot_tenths` is `CompiledGame.pot` / StreetSpec pot (tenths-of-a-chip).
    /// When `is_fraction`, threshold = target × pot_chips; otherwise absolute chips.
    /// Returns -1 when Acc-stop is disarmed (non-positive pot for a fraction target).
    pub fn accuracyThresholdChips(pot_tenths: i32, target: f64, is_fraction: bool) f64 {
        if (!(target >= 0) or !std.math.isFinite(target)) return -1.0;
        if (!is_fraction) return target;
        const pot_chips = poker_engine.poker.chips.tenthsToChips(pot_tenths);
        if (!(pot_chips > 0)) return -1.0;
        return target * pot_chips;
    }

    /// True when measured Pio Accuracy chips meets the stop threshold.
    pub fn accuracyReached(accuracy_chips: f64, threshold_chips: f64) bool {
        return threshold_chips >= 0 and accuracy_chips <= threshold_chips;
    }

    /// Force-publish the exact average for `training.trained`, then evaluate it.
    /// Guarantees the returned policy matches the iteration being reported (no
    /// stale publish-cadence snapshot). Shared by Study `trainGated` and gate-bench.
    /// Bumps `policy_revision` when a publish is required — use only for Accuracy
    /// stop / exact reporting, not routine footer progress (ZR-133 / ZR-171).
    pub fn evaluateExactIteration(self: *Session) SessionError!ExactIterEval {
        try self.ensurePublishedExact();
        const published = self.published orelse return error.NothingPublished;
        const trained: i32 = if (self.training) |ts| ts.trained else published.trained;
        if (published.trained != trained) return error.InvalidSession;
        const eval = try self.evaluateFrozen(published.average);
        return .{ .trained = trained, .eval = eval };
    }

    /// Sample EV/gap from the current published average without forcing a publish.
    /// Footer Acc/ETA track the publish watermark (ZR-133: progress ≠ publish).
    fn recordProgressFromPublished(self: *Session) void {
        const published = self.published orelse return;
        const eval = self.evaluateFrozen(published.average) catch return;
        self.recordProgressEval(published.trained, eval);
    }

    fn clearProgressTracking(self: *Session) void {
        self.train_started_ns = 0;
        self.runtime_seconds_cached = -1;
        self.gap_series_len = 0;
        self.accuracy_target = -1;
        self.time_limit_seconds = -1;
    }

    fn freezeRuntime(self: *Session) void {
        if (self.train_started_ns == 0) return;
        const now = std.time.nanoTimestamp();
        const elapsed = if (now < self.train_started_ns)
            0.0
        else
            @as(f64, @floatFromInt(now - self.train_started_ns)) / 1e9;
        self.runtime_seconds_cached = elapsed;
        self.train_started_ns = 0;
    }

    fn recordEvalMetrics(self: *Session, eval: poker_engine.solve.frozen_walk.FrozenEval) void {
        self.setMetrics(.{
            .value = eval.u0,
            .br0 = eval.br0,
            .br1 = eval.br1,
            .nash_gap = eval.nash_gap,
            .accuracy = eval.accuracy,
        });
    }

    fn appendGapSeries(self: *Session, trained: i32, eval: poker_engine.solve.frozen_walk.FrozenEval) void {
        const point = GapSeriesPoint{
            .iterations = trained,
            .value = eval.u0,
            .nash_gap = eval.nash_gap,
            .accuracy_chips = eval.accuracy,
        };
        if (self.gap_series_len < self.gap_series.len) {
            self.gap_series[self.gap_series_len] = point;
            self.gap_series_len += 1;
            return;
        }
        var i: usize = 0;
        while (i + 1 < self.gap_series.len) : (i += 1) {
            self.gap_series[i] = self.gap_series[i + 1];
        }
        self.gap_series[self.gap_series.len - 1] = point;
    }

    fn recordProgressEval(self: *Session, trained: i32, eval: poker_engine.solve.frozen_walk.FrozenEval) void {
        self.recordEvalMetrics(eval);
        self.appendGapSeries(trained, eval);
    }

    /// Elapsed train seconds for Study status (null when no active/last job clock).
    pub fn runtimeSeconds(self: *const Session) ?f64 {
        if (self.train_started_ns != 0) {
            const now = std.time.nanoTimestamp();
            if (now < self.train_started_ns) return 0;
            return @as(f64, @floatFromInt(now - self.train_started_ns)) / 1e9;
        }
        if (self.runtime_seconds_cached >= 0) return self.runtime_seconds_cached;
        return null;
    }

    /// Accuracy / time / progress train loop shared with gate-bench (ZR-91 / ZR-153 / ZR-171).
    /// Each step is `train(1)` so pause/stop still land on iteration boundaries.
    /// Always records EV/gap samples on `eval_every` so Study footer Acc/ETA stay live
    /// even for iteration-only jobs (accuracy ≤ 0). Accuracy stop only when target > 0.
    pub fn trainGated(
        self: *Session,
        max_iterations: i32,
        accuracy_pot_fraction: f64,
        eval_every: i32,
        time_limit_seconds: f64,
    ) SessionError!void {
        if (max_iterations < 1) return error.InvalidSession;
        const every: i32 = if (eval_every < 1) 1 else eval_every;
        const pot_tenths: i32 = if (self.game) |g| g.pot else 0;
        // accuracy ≤ 0 means iteration/time-only — still eval for Study progress.
        const want_accuracy = accuracy_pot_fraction > 0;
        const threshold_chips = if (want_accuracy)
            accuracyThresholdChips(pot_tenths, accuracy_pot_fraction, true)
        else
            -1.0;
        const use_time = time_limit_seconds >= 0;
        self.accuracy_target = if (want_accuracy) accuracy_pot_fraction else -1;
        self.time_limit_seconds = if (use_time) time_limit_seconds else -1;
        // New job clock: Continue after pause keeps the same wall clock + series.
        if (self.train_started_ns == 0) {
            self.gap_series_len = 0;
            self.runtime_seconds_cached = -1;
            self.train_started_ns = std.time.nanoTimestamp();
        }
        const t0 = self.train_started_ns;
        var completed: i32 = 0;
        var fresh_eval = false;

        while (completed < max_iterations) {
            if (self.stop_requested.load(.acquire)) {
                self.last_terminal = .cancelled;
                self.mu.lock();
                // Keep trainer-ready `.paused` even with no published average yet.
                self.phase = .paused;
                self.mu.unlock();
                self.clearControlFlags();
                self.freezeRuntime();
                return;
            }
            if (self.pause_requested.load(.acquire)) {
                self.last_terminal = .paused;
                self.mu.lock();
                self.phase = .paused;
                self.mu.unlock();
                self.clearControlFlags();
                // Keep wall clock live across Pause → Continue (ZR-171).
                return;
            }
            try self.train(1);
            if (self.last_terminal == .cancelled) {
                self.freezeRuntime();
                return;
            }
            if (self.last_terminal == .paused) return;
            completed += 1;
            fresh_eval = false;
            // Note: train(1) leaves phase=.published between gated steps. pause()
            // must latch pause_requested even in that gap (ZR-178); do not flip
            // phase back to .training here — train(1) only admits paused/published.

            if (@rem(completed, every) == 0) {
                if (want_accuracy) {
                    // Accuracy stop must see the exact trained average (may publish).
                    const exact = try self.evaluateExactIteration();
                    self.recordProgressEval(exact.trained, exact.eval);
                    fresh_eval = true;
                    if (accuracyReached(exact.eval.accuracy, threshold_chips)) {
                        self.last_terminal = .accuracy_reached;
                        self.mu.lock();
                        self.phase = .published;
                        self.mu.unlock();
                        self.freezeRuntime();
                        return;
                    }
                } else {
                    // Iteration/time jobs: sample published watermark — do not
                    // force-publish (keeps ZR-133 cadence / Study continue rev).
                    self.recordProgressFromPublished();
                    fresh_eval = self.has_metrics;
                }
            }
            if (use_time) {
                const elapsed = @as(f64, @floatFromInt(std.time.nanoTimestamp() - t0)) / 1e9;
                if (elapsed >= time_limit_seconds) {
                    if (!fresh_eval) {
                        if (want_accuracy) {
                            const exact = try self.evaluateExactIteration();
                            self.recordProgressEval(exact.trained, exact.eval);
                        } else {
                            self.recordProgressFromPublished();
                        }
                    }
                    self.last_terminal = .time_limit_reached;
                    self.mu.lock();
                    self.phase = if (self.published != null) .published else .paused;
                    self.mu.unlock();
                    self.freezeRuntime();
                    return;
                }
            }
        }
        // Pause/stop may arrive after the last train(1) but before completion flush.
        if (self.stop_requested.load(.acquire)) {
            self.last_terminal = .cancelled;
            self.mu.lock();
            self.phase = .paused;
            self.mu.unlock();
            self.clearControlFlags();
            self.freezeRuntime();
            return;
        }
        if (self.pause_requested.load(.acquire)) {
            self.last_terminal = .paused;
            self.mu.lock();
            self.phase = .paused;
            self.mu.unlock();
            self.clearControlFlags();
            return;
        }
        self.ensurePublishedExact() catch |err| {
            // ZR-164: gated completion under publish pressure keeps prior average.
            self.mu.lock();
            const keep = self.published != null and isSoftPublishPressure(err);
            if (keep) self.softSkipPublishLocked();
            self.mu.unlock();
            if (!keep) {
                self.freezeRuntime();
                return err;
            }
        };
        if (!fresh_eval) {
            // Final sample on the completion-flush average (no extra publish).
            self.recordProgressFromPublished();
        }
        self.last_terminal = .completed;
        self.mu.lock();
        self.phase = if (self.published != null) .published else .paused;
        self.mu.unlock();
        self.freezeRuntime();
    }

    /// Frozen NashConv / Accuracy on the Session-owned engine (reuses ranks).
    pub fn evaluateFrozen(
        self: *Session,
        average: []const f32,
    ) SessionError!poker_engine.solve.frozen_walk.FrozenEval {
        const ctx = try self.ensureFrozenCtx();
        return poker_engine.solve.frozen_walk.evaluatePublishedFrozenOnCtx(ctx, average);
    }

    /// Borrow published policy for analysis. Safe while train continues (D2/D3).
    pub fn borrowPublished(self: *Session) SessionError!PublishedLease {
        self.mu.lock();
        defer self.mu.unlock();
        // Do not observe a half-rewritten in-place average (ZR-164).
        while (self.publishing_in_place) {
            self.quiet.wait(&self.mu);
        }
        const game = self.game orelse return error.NothingPublished;
        const published = self.published orelse return error.NothingPublished;
        self.readers += 1;
        return .{
            .session = self,
            .game = game,
            .published = published,
            .solution_id = self.solution_id,
        };
    }

    /// Wait until a published revision exists (or timeout_ns), then borrow.
    pub fn borrowPublishedWait(self: *Session, timeout_ns: u64) SessionError!PublishedLease {
        const deadline = std.time.nanoTimestamp() + @as(i128, @intCast(timeout_ns));
        self.mu.lock();
        defer self.mu.unlock();
        while (self.published == null or self.publishing_in_place) {
            const now = std.time.nanoTimestamp();
            if (now >= deadline) return error.NothingPublished;
            const remaining: u64 = @intCast(deadline - now);
            if (self.publishing_in_place) {
                self.quiet.timedWait(&self.mu, remaining) catch return error.NothingPublished;
            } else {
                self.published_cv.timedWait(&self.mu, remaining) catch return error.NothingPublished;
            }
        }
        const game = self.game orelse return error.NothingPublished;
        const published = self.published orelse return error.NothingPublished;
        self.readers += 1;
        return .{
            .session = self,
            .game = game,
            .published = published,
            .solution_id = self.solution_id,
        };
    }

    pub fn releaseReader(self: *Session) void {
        self.mu.lock();
        defer self.mu.unlock();
        if (self.readers > 0) self.readers -= 1;
        if (self.readers == 0) self.quiet.broadcast();
    }

    pub fn pause(self: *Session) SessionError!void {
        self.mu.lock();
        defer self.mu.unlock();
        // Always latch cooperative pause first. trainGated's train(1) steps finish
        // with phase=.published between iterations; treating that as an idle pause
        // (phase flip only, no flag) lets the gated loop keep burning the remaining
        // budget — zig-windows study-contract-smoke saw completed@2e6 instead of
        // paused (ZR-178).
        self.pause_requested.store(true, .release);
        if (self.phase == .training) {
            // Train loop observes the flag at the next iteration boundary.
            return;
        }
        if (self.phase == .paused) {
            // Idempotent: already paused (idle or mid-gate latch applied).
            return;
        }
        if (self.phase != .published) return error.InvalidSession;
        if (self.published == null) return error.NothingPublished;
        self.phase = .paused;
        self.last_terminal = .paused;
    }

    pub fn setLocksText(self: *Session, text: []const u8) SessionError!void {
        const owned = self.allocator.dupe(u8, text) catch return error.OutOfMemory;
        if (self.locks_text.len != 0) self.allocator.free(self.locks_text);
        self.locks_text = owned;
    }

    /// Prepare a locked re-solve (Study Resolve Locked).
    /// Stamps `baseline_id` from the prior solution when unset, mints a new
    /// `solution_id`, and optionally resets trainer tables (warm_start=false).
    /// Does not clone the baseline policy blob — Compare still needs a later
    /// dual-solution host path; status still reports the baseline id for UI.
    pub fn prepareResolveLocked(self: *Session, warm_start: bool) SessionError!void {
        self.mu.lock();
        defer self.mu.unlock();
        if (self.busyForReplace()) return error.Busy;
        if (self.phase != .paused and self.phase != .published) return error.InvalidSession;
        if (self.game == null) return error.InvalidSession;
        if (!self.has_training or self.training == null) return error.InvalidSession;
        if (self.solution_id == 0) return error.NothingPublished;

        if (!warm_start) {
            const game = self.game.?;
            const state = &(self.training orelse return error.InvalidSession);
            const locks_snapshot: []u8 = if (self.locks_text.len != 0)
                (self.allocator.dupe(u8, self.locks_text) catch return error.OutOfMemory)
            else
                &.{};
            defer if (locks_snapshot.len != 0) self.allocator.free(locks_snapshot);

            var locks_owned: ?poker_engine.solve.node_lock.LockSet = null;
            defer if (locks_owned) |*owned| owned.deinit();
            if (locks_snapshot.len != 0) {
                locks_owned = poker_engine.solve.node_lock.parseLockSet(self.allocator, locks_snapshot) catch {
                    return error.InvalidSession;
                };
            }
            state.resetForResolve(game, if (locks_owned) |*owned| owned else null) catch |err| {
                return switch (err) {
                    error.OutOfMemory => error.OutOfMemory,
                    error.LockActionCountMismatch,
                    error.InvalidTrain,
                    error.ThreadQuotaExceeded,
                    error.LockedMemoryLimitExceeded,
                    error.SystemResources,
                    error.Unexpected,
                    => error.InvalidSession,
                };
            };
            // Next train iter must publish a fresh average for the reset tables.
            self.iters_since_publish = 0;
            self.last_published_trained = 0;
            self.last_committed_trained = 0;
            self.cfr_pass_mutated = false;
            self.force_next_publish = true;
        }

        if (self.baseline_id == 0) {
            self.baseline_id = self.solution_id;
        }
        self.solution_id = self.next_id;
        self.next_id += 1;
        self.clearControlFlags();
        self.last_terminal = .completed;
        self.phase = .paused;
    }

    pub fn setStrategyEditsText(self: *Session, text: []const u8) SessionError!void {
        const owned = self.allocator.dupe(u8, text) catch return error.OutOfMemory;
        if (self.strategy_edits_text.len != 0) self.allocator.free(self.strategy_edits_text);
        self.strategy_edits_text = owned;
    }

    pub fn setMetrics(self: *Session, metrics: Metrics) void {
        self.metrics = metrics;
        self.has_metrics = true;
    }

    /// Free bulky PSOL table slices after they have been copied into Session-owned
    /// buffers so Open peak stays under the shared memory-mib ceiling (ZR-156).
    fn releaseDocTableStaging(doc: *poker_formats.Document) void {
        if (doc.average.len != 0) {
            doc.allocator.free(doc.average);
            doc.average = &.{};
        }
        if (doc.regret.len != 0) {
            doc.allocator.free(doc.regret);
            doc.regret = &.{};
        }
        if (doc.strategy_sum.len != 0) {
            doc.allocator.free(doc.strategy_sum);
            doc.strategy_sum = &.{};
        }
        if (doc.oop_combos.len != 0) {
            doc.allocator.free(doc.oop_combos);
            doc.oop_combos = &.{};
        }
        if (doc.ip_combos.len != 0) {
            doc.allocator.free(doc.ip_combos);
            doc.ip_combos = &.{};
        }
        if (doc.slot_actions.len != 0) {
            doc.allocator.free(doc.slot_actions);
            doc.slot_actions = &.{};
        }
    }

    fn buildDocument(self: *Session) SessionError!poker_formats.Document {
        const game = self.game orelse return error.InvalidSession;
        const published = self.published orelse return error.NothingPublished;

        var doc = poker_formats.Document{ .allocator = self.allocator };
        errdefer doc.deinit();
        doc.frozen = self.frozen;
        doc.config_text = self.allocator.dupe(u8, self.config_text) catch return error.OutOfMemory;
        doc.oop_combos = self.allocator.dupe(i32, game.hands.combos[0]) catch return error.OutOfMemory;
        doc.ip_combos = self.allocator.dupe(i32, game.hands.combos[1]) catch return error.OutOfMemory;

        // PSOL wire order stays decision→hand→runout; memory is runout-major.
        var layout = poker_engine.game.compile.buildPsolLayoutMap(self.allocator, game) catch return error.InvalidSession;
        defer layout.deinit();
        doc.slot_actions = self.allocator.dupe(u16, layout.psol_actions) catch return error.OutOfMemory;
        doc.average = self.allocator.alloc(f32, @intCast(layout.psol_table_entries)) catch return error.OutOfMemory;
        poker_engine.game.compile.copyTableMemoryToPsol(game, layout, published.average, doc.average) catch {
            return error.InvalidSession;
        };

        // Preserve browse-only: never invent training tables on save (ZR-96).
        // Degenerate check-only trees may have empty tables but still continue.
        if (self.has_training) {
            doc.has_training_flag = true;
            if (self.training) |state| {
                doc.trained = state.trained;
                doc.regret = self.allocator.alloc(f32, @intCast(layout.psol_table_entries)) catch return error.OutOfMemory;
                poker_engine.game.compile.copyTableMemoryToPsol(game, layout, state.regret, doc.regret) catch {
                    return error.InvalidSession;
                };
                doc.strategy_sum = self.allocator.alloc(f32, @intCast(layout.psol_table_entries)) catch return error.OutOfMemory;
                poker_engine.game.compile.copyTableMemoryToPsol(game, layout, state.strategy_sum, doc.strategy_sum) catch {
                    return error.InvalidSession;
                };
            }
        }
        if (self.locks_text.len != 0) {
            doc.locks_text = self.allocator.dupe(u8, self.locks_text) catch return error.OutOfMemory;
        }
        if (self.strategy_edits_text.len != 0) {
            doc.strategy_edits_text = self.allocator.dupe(u8, self.strategy_edits_text) catch return error.OutOfMemory;
        }
        if (self.has_metrics) {
            doc.metrics = self.metrics;
            doc.has_metrics = true;
        }
        return doc;
    }

    pub fn save(self: *Session, path: []const u8) SessionError!void {
        self.mu.lock();
        if (self.busyForReplace()) {
            self.mu.unlock();
            return error.Busy;
        }
        self.mu.unlock();
        // Checkpoint average must match the completed iteration being claimed.
        try self.ensurePublishedExact();
        std.debug.assert(self.published != null);
        if (self.training) |ts| {
            // Save claims the last committed iteration when trainer tables exist.
            std.debug.assert(self.last_committed_trained == ts.trained);
        }
        var doc = self.buildDocument() catch |err| {
            if (err == error.OutOfMemory) return self.mapAllocErr(err);
            return err;
        };
        defer doc.deinit();
        // Document / encode entry: config present; training lengths match average.
        std.debug.assert(doc.config_text.len > 0);
        if (doc.hasTraining()) {
            std.debug.assert(doc.regret.len == doc.average.len);
            std.debug.assert(doc.strategy_sum.len == doc.average.len);
        }
        poker_formats.writeFile(self.allocator, path, doc) catch |err| {
            if (err == error.OutOfMemory) return self.mapAllocErr(err);
            return err;
        };
    }

    /// Open for study (and optional resume). Fail-closed: on error prior session unchanged.
    pub fn open(self: *Session, path: []const u8) SessionError!void {
        if (self.busyForReplace()) return error.Busy;

        // Peek config on parent (street-config text only) to learn memory-mib
        // before charging the full streamed document against the shared ceiling.
        const peeked_config = poker_formats.peekConfigText(self.parent, path) catch |err| {
            return err;
        };
        defer self.parent.free(peeked_config);
        // If the peeked text is not street-config, re-stream on parent so callers
        // still see codec errors (InvalidPsol / Legacy) instead of a parse miss.
        var peeked_spec = poker_engine.game.parseStreetConfig(self.parent, peeked_config) catch {
            var probe = poker_formats.readFile(self.parent, path) catch |err| return err;
            probe.deinit();
            return error.InvalidPsol;
        };
        defer peeked_spec.deinit();
        if (peeked_spec.memory_mib <= 0) return error.BudgetExceeded;
        const budget_bytes: u64 = @as(u64, @intCast(peeked_spec.memory_mib)) * 1024 * 1024;

        // Shared memory-mib ceiling (ZR-156): charge Open staging + compile under
        // the declared budget. Do not raise to old+new; do not stage on parent.
        const prior_limit = self.budget.limit();
        const prior_budget_field = self.memory_budget_bytes;
        const old_live = self.budget.live();
        self.budget.setLimit(budget_bytes);
        errdefer {
            self.budget.setLimit(prior_limit);
            self.memory_budget_bytes = prior_budget_field;
        }
        if (old_live > budget_bytes) return error.BudgetExceeded;

        var doc = poker_formats.readFile(self.allocator, path) catch |err| {
            if (err == error.OutOfMemory) return error.BudgetExceeded;
            return err;
        };
        defer doc.deinit();

        var spec = try poker_engine.game.parseStreetConfig(self.parent, doc.config_text);
        defer spec.deinit();
        if (spec.memory_mib <= 0) return error.BudgetExceeded;
        if (@as(u64, @intCast(spec.memory_mib)) * 1024 * 1024 != budget_bytes) return error.InvalidPsol;

        var game = poker_engine.game.compile.compile(self.allocator, spec) catch |err| {
            if (err == error.OutOfMemory) return error.BudgetExceeded;
            return err;
        };
        errdefer game.deinit();

        // Logical index must match compile (combo order + PSOL hand-major slot arities).
        if (doc.oop_combos.len != game.hands.combos[0].len) return error.InvalidPsol;
        if (doc.ip_combos.len != game.hands.combos[1].len) return error.InvalidPsol;
        if (!std.mem.eql(i32, doc.oop_combos, game.hands.combos[0])) return error.InvalidPsol;
        if (!std.mem.eql(i32, doc.ip_combos, game.hands.combos[1])) return error.InvalidPsol;
        var layout = poker_engine.game.compile.buildPsolLayoutMap(self.allocator, game) catch |err| {
            if (err == error.OutOfMemory) return error.BudgetExceeded;
            return error.InvalidPsol;
        };
        defer layout.deinit();
        if (doc.slot_actions.len != layout.psol_actions.len) return error.InvalidPsol;
        if (!std.mem.eql(u16, doc.slot_actions, layout.psol_actions)) return error.InvalidPsol;
        if (doc.average.len != @as(usize, @intCast(layout.psol_table_entries))) return error.InvalidPsol;

        const estimated = estimateSolutionBytes(game);
        if (estimated > budget_bytes) return error.BudgetExceeded;
        // Coexistence: prior solution + new estimate must fit while both are live.
        if (old_live > 0 and estimated > budget_bytes - old_live) return error.BudgetExceeded;

        const doc_trained = doc.trained;
        const doc_frozen = doc.frozen;
        const doc_metrics = doc.metrics;
        const doc_has_metrics = doc.has_metrics;

        const average_mem = self.allocator.alloc(f32, @intCast(game.table_entries)) catch return error.BudgetExceeded;
        var average_owned = true;
        errdefer if (average_owned) self.allocator.free(average_mem);
        poker_engine.game.compile.copyTablePsolToMemory(game, layout, doc.average, average_mem) catch {
            return error.InvalidPsol;
        };
        // Reject invalid strategy rows before replacing the active solution (ZR-96).
        if (!validateAveragePolicy(game, average_mem)) return error.InvalidStrategy;

        const want_training = doc.hasTraining();
        var training: ?poker_engine.solve.training_state.TrainingState = null;
        errdefer if (training) |*owned| owned.deinit();
        if (want_training) {
            var tables = poker_engine.solve.training_state.TrainingState.init(self.allocator, game) catch |err| {
                if (err == error.OutOfMemory) return error.BudgetExceeded;
                return err;
            };
            errdefer tables.deinit();
            if (doc.regret.len != @as(usize, @intCast(layout.psol_table_entries))) return error.InvalidPsol;
            if (doc.strategy_sum.len != doc.regret.len) return error.InvalidPsol;
            poker_engine.game.compile.copyTablePsolToMemory(game, layout, doc.regret, tables.regret) catch {
                return error.InvalidPsol;
            };
            poker_engine.game.compile.copyTablePsolToMemory(game, layout, doc.strategy_sum, tables.strategy_sum) catch {
                return error.InvalidPsol;
            };
            tables.trained = doc_trained;
            var open_locks: ?poker_engine.solve.node_lock.LockSet = null;
            defer if (open_locks) |*owned| owned.deinit();
            if (doc.locks_text.len != 0) {
                open_locks = poker_engine.solve.node_lock.parseLockSet(self.allocator, doc.locks_text) catch {
                    return error.InvalidPsol;
                };
            }
            try poker_engine.solve.training_state.freezeSigma(
                game,
                &tables,
                if (open_locks) |*owned| owned else null,
            );
            tables.policy_revision = 1;
            training = tables;
        }

        // Drop bulky checkpoint staging before the fail-closed swap so peak is
        // old+new (shared ceiling), not old+doc+new.
        releaseDocTableStaging(&doc);

        var published = poker_engine.solve.training_state.PublishedPolicy{
            .allocator = self.allocator,
            .average = average_mem,
            .revision = 1,
            .trained = doc_trained,
        };
        average_owned = false; // ownership moved into published
        errdefer published.deinit();

        const owned_config = self.allocator.dupe(u8, doc.config_text) catch return error.BudgetExceeded;
        errdefer self.allocator.free(owned_config);
        const owned_locks = self.allocator.dupe(u8, doc.locks_text) catch return error.BudgetExceeded;
        errdefer self.allocator.free(owned_locks);
        const owned_edits = self.allocator.dupe(u8, doc.strategy_edits_text) catch return error.BudgetExceeded;
        errdefer self.allocator.free(owned_edits);

        // Install only after full validation.
        self.clearSolution();
        self.budget.setLimit(budget_bytes);
        self.config_text = owned_config;
        self.game = game;
        self.training = training;
        self.published = published;
        self.last_published_trained = published.trained;
        self.last_committed_trained = if (want_training) doc_trained else 0;
        self.cfr_pass_mutated = false;
        self.iters_since_publish = 0;
        self.force_next_publish = false;
        self.locks_text = owned_locks;
        self.strategy_edits_text = owned_edits;
        self.frozen = doc_frozen;
        self.metrics = doc_metrics;
        self.has_metrics = doc_has_metrics;
        self.threads = clampThreads(spec.threads);
        self.has_training = want_training;
        self.memory_budget_bytes = budget_bytes;
        self.solution_id = self.next_id;
        self.next_id += 1;
        self.baseline_id = 0;
        self.clearControlFlags();
        self.last_terminal = .completed;
        self.phase = .published;
        // Open postconditions: published browsable; commit counters match resume policy.
        std.debug.assert(self.published != null);
        std.debug.assert(self.phase == .published);
        std.debug.assert(self.budget.limit() == budget_bytes);
        std.debug.assert(self.budget.live() <= budget_bytes);
        std.debug.assert(!self.cfr_pass_mutated);
        if (want_training) {
            std.debug.assert(self.has_training);
            std.debug.assert(self.training != null);
            std.debug.assert(self.last_committed_trained == doc_trained);
            std.debug.assert(self.canContinue());
        } else {
            std.debug.assert(!self.has_training);
            std.debug.assert(self.training == null);
            std.debug.assert(self.last_committed_trained == 0);
            std.debug.assert(!self.canContinue());
        }
    }

    pub fn policyRevision(self: Session) u64 {
        if (self.published) |p| return p.revision;
        return 0;
    }
};
