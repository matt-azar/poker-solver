const std = @import("std");
const poker_engine = @import("poker_engine");
const poker_formats = @import("poker_formats");

pub const SessionError = error{
    InvalidSession,
    Busy,
    NothingPublished,
    OpenFailed,
    OutOfMemory,
    BudgetExceeded,
    InvalidStrategy,
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

    pub fn init(allocator: std.mem.Allocator) Session {
        return .{ .allocator = allocator };
    }

    pub fn canContinue(self: *const Session) bool {
        return self.has_training and self.published != null and
            (self.phase == .paused or self.phase == .published);
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
        self.* = .{ .allocator = self.allocator };
    }

    fn clearPublishCadence(self: *Session) void {
        self.iters_since_publish = 0;
        self.last_published_trained = 0;
        self.force_next_publish = false;
        if (self.average_spare) |buf| {
            self.allocator.free(buf);
            self.average_spare = null;
        }
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
        var ctx = try poker_engine.solve.frozen_walk.FrozenCtx.initThreaded(
            self.allocator,
            game,
            state,
            self.threads,
        );
        errdefer ctx.deinit();
        try ctx.ensureAllRanksReady();
        self.frozen_ctx = ctx;
        return &(self.frozen_ctx.?);
    }

    /// Begin a new solve from street-config text. On failure, prior solution is kept.
    pub fn begin(self: *Session, config_text: []const u8) SessionError!void {
        self.mu.lock();
        if (self.busyForReplace()) {
            self.mu.unlock();
            return error.Busy;
        }
        self.mu.unlock();

        var spec = try poker_engine.game.parseStreetConfig(self.allocator, config_text);
        defer spec.deinit();
        if (spec.memory_mib <= 0) return error.BudgetExceeded;
        const budget_bytes: u64 = @as(u64, @intCast(spec.memory_mib)) * 1024 * 1024;

        // Under a declared budget, construction OOM is a budget failure (Windows CI
        // may OOM during flop compile before the post-compile estimate runs).
        var game = poker_engine.game.compile.compile(self.allocator, spec) catch |err| {
            if (err == error.OutOfMemory) return error.BudgetExceeded;
            return err;
        };
        errdefer game.deinit();
        const estimated = estimateSolutionBytes(game);
        if (estimated > budget_bytes) return error.BudgetExceeded;

        var training = poker_engine.solve.training_state.TrainingState.init(self.allocator, game) catch |err| {
            if (err == error.OutOfMemory) return error.BudgetExceeded;
            return err;
        };
        errdefer training.deinit();
        const owned_config = self.allocator.dupe(u8, config_text) catch return error.BudgetExceeded;
        errdefer self.allocator.free(owned_config);
        const threads = clampThreads(spec.threads);

        // Install only after compile+train tables succeed (fail-closed).
        self.mu.lock();
        defer self.mu.unlock();
        if (self.busyForReplace()) return error.Busy;
        while (self.readers != 0) {
            self.quiet.wait(&self.mu);
        }
        self.clearSolution();
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
        while (self.readers != 0) {
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
        self.last_published_trained = next.trained;
        self.iters_since_publish = 0;
        self.force_next_publish = false;
        // Fresh CFR publish invalidates free-form overlays (C++ clear on solve).
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

    /// Materialize the exact average for the current `training.trained` and install it.
    /// Used by cadence publishes, Acc eval, save, and pause/stop/completion flushes.
    fn publishExactAverage(self: *Session) SessionError!void {
        const game = self.game orelse return error.InvalidSession;
        const state = &(self.training orelse return error.InvalidSession);
        const n = state.strategy_sum.len;
        const threads = if (self.threads < 1) @as(u32, 1) else self.threads;

        self.mu.lock();
        const buf = self.takeAverageBufferLocked(n) catch {
            self.mu.unlock();
            return error.OutOfMemory;
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
        ) catch return error.InvalidSession;

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

    /// After each completed CFR iteration: bump cadence counter; publish only on bound.
    fn onTrainIterDone(ctx: *anyopaque, trained: i32) anyerror!void {
        const self: *Session = @ptrCast(@alignCast(ctx));
        _ = trained;
        self.mu.lock();
        self.iters_since_publish += 1;
        const want = self.shouldPublishCadenceLocked();
        self.mu.unlock();
        if (!want) return;
        try self.publishExactAverage();
    }

    /// Durable recovery after a real train failure left `.failed` (ZR-123).
    /// Cooperative early stop/pause already returns `.paused` (#311); this path
    /// covers errdefer / hard train faults so Continue/Solve can restart when
    /// trainer state is still present — without requiring a full re-begin.
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
        self.mu.unlock();
        defer if (locks_snapshot.len != 0) self.allocator.free(locks_snapshot);
        errdefer {
            self.mu.lock();
            self.phase = if (self.published != null) .published else .failed;
            self.mu.unlock();
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
        var stub = try poker_engine.solve.frozen_walk.trainFrozenCfrPlusOnCtx(
            ctx,
            state,
            iterations,
            onTrainIterDone,
            self,
            shouldStopTrain,
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
            try self.ensurePublishedExact();
        }

        self.mu.lock();
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
        self.mu.unlock();
        self.clearControlFlags();
    }

    /// Accuracy / time gated train loop shared with gate-bench (ZR-91).
    /// Each step is `train(1)` so pause/stop still land on iteration boundaries.
    pub fn trainGated(
        self: *Session,
        max_iterations: i32,
        accuracy_pot_fraction: f64,
        eval_every: i32,
        time_limit_seconds: f64,
    ) SessionError!void {
        if (max_iterations < 1) return error.InvalidSession;
        const every: i32 = if (eval_every < 1) 1 else eval_every;
        const pot: f64 = if (self.game) |g| @floatFromInt(g.pot) else 0;
        const threshold_chips = if (accuracy_pot_fraction > 0 and pot > 0)
            accuracy_pot_fraction * pot
        else
            -1.0;
        const use_time = time_limit_seconds >= 0;
        const t0 = std.time.nanoTimestamp();
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
            try self.train(1);
            if (self.last_terminal == .cancelled or self.last_terminal == .paused) return;
            completed += 1;
            fresh_eval = false;

            if (@rem(completed, every) == 0 and threshold_chips >= 0) {
                // Acc must see the exact average for this completed iteration.
                try self.ensurePublishedExact();
                const published = self.published orelse return error.NothingPublished;
                const eval = try self.evaluateFrozen(published.average);
                fresh_eval = true;
                if (eval.accuracy <= threshold_chips) {
                    self.last_terminal = .accuracy_reached;
                    return;
                }
            }
            if (use_time) {
                const elapsed = @as(f64, @floatFromInt(std.time.nanoTimestamp() - t0)) / 1e9;
                if (elapsed >= time_limit_seconds) {
                    if (!fresh_eval and threshold_chips >= 0) {
                        try self.ensurePublishedExact();
                        if (self.published) |published| {
                            _ = try self.evaluateFrozen(published.average);
                        }
                    }
                    self.last_terminal = .time_limit_reached;
                    return;
                }
            }
        }
        try self.ensurePublishedExact();
        self.last_terminal = .completed;
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
        while (self.published == null) {
            const now = std.time.nanoTimestamp();
            if (now >= deadline) return error.NothingPublished;
            const remaining: u64 = @intCast(deadline - now);
            self.published_cv.timedWait(&self.mu, remaining) catch return error.NothingPublished;
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
        if (self.phase == .training) {
            // Cooperative: train loop stops at the next iteration boundary.
            self.pause_requested.store(true, .release);
            return;
        }
        if (self.phase != .published) return error.InvalidSession;
        if (self.published == null) return error.NothingPublished;
        self.phase = .paused;
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
        var doc = try self.buildDocument();
        defer doc.deinit();
        try poker_formats.writeFile(self.allocator, path, doc);
    }

    /// Open for study (and optional resume). Fail-closed: on error prior session unchanged.
    pub fn open(self: *Session, path: []const u8) SessionError!void {
        if (self.busyForReplace()) return error.Busy;

        var doc = poker_formats.readFile(self.allocator, path) catch |err| {
            return err;
        };
        defer doc.deinit();

        var spec = try poker_engine.game.parseStreetConfig(self.allocator, doc.config_text);
        defer spec.deinit();
        var game = try poker_engine.game.compile.compile(self.allocator, spec);
        errdefer game.deinit();

        // Logical index must match compile (combo order + PSOL hand-major slot arities).
        if (doc.oop_combos.len != game.hands.combos[0].len) return error.InvalidPsol;
        if (doc.ip_combos.len != game.hands.combos[1].len) return error.InvalidPsol;
        if (!std.mem.eql(i32, doc.oop_combos, game.hands.combos[0])) return error.InvalidPsol;
        if (!std.mem.eql(i32, doc.ip_combos, game.hands.combos[1])) return error.InvalidPsol;
        var layout = poker_engine.game.compile.buildPsolLayoutMap(self.allocator, game) catch return error.InvalidPsol;
        defer layout.deinit();
        if (doc.slot_actions.len != layout.psol_actions.len) return error.InvalidPsol;
        if (!std.mem.eql(u16, doc.slot_actions, layout.psol_actions)) return error.InvalidPsol;
        if (doc.average.len != @as(usize, @intCast(layout.psol_table_entries))) return error.InvalidPsol;

        const average_mem = self.allocator.alloc(f32, @intCast(game.table_entries)) catch return error.OutOfMemory;
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
            var tables = try poker_engine.solve.training_state.TrainingState.init(self.allocator, game);
            errdefer tables.deinit();
            if (doc.regret.len != @as(usize, @intCast(layout.psol_table_entries))) return error.InvalidPsol;
            if (doc.strategy_sum.len != doc.regret.len) return error.InvalidPsol;
            poker_engine.game.compile.copyTablePsolToMemory(game, layout, doc.regret, tables.regret) catch {
                return error.InvalidPsol;
            };
            poker_engine.game.compile.copyTablePsolToMemory(game, layout, doc.strategy_sum, tables.strategy_sum) catch {
                return error.InvalidPsol;
            };
            tables.trained = doc.trained;
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

        var published = poker_engine.solve.training_state.PublishedPolicy{
            .allocator = self.allocator,
            .average = average_mem,
            .revision = 1,
            .trained = doc.trained,
        };
        average_owned = false; // ownership moved into published
        errdefer published.deinit();

        const owned_config = self.allocator.dupe(u8, doc.config_text) catch return error.OutOfMemory;
        errdefer self.allocator.free(owned_config);
        const owned_locks = self.allocator.dupe(u8, doc.locks_text) catch return error.OutOfMemory;
        errdefer self.allocator.free(owned_locks);
        const owned_edits = self.allocator.dupe(u8, doc.strategy_edits_text) catch return error.OutOfMemory;
        errdefer self.allocator.free(owned_edits);

        // Install only after full validation.
        self.clearSolution();
        self.config_text = owned_config;
        self.game = game;
        self.training = training;
        self.published = published;
        self.last_published_trained = published.trained;
        self.iters_since_publish = 0;
        self.force_next_publish = false;
        self.locks_text = owned_locks;
        self.strategy_edits_text = owned_edits;
        self.frozen = doc.frozen;
        self.metrics = doc.metrics;
        self.has_metrics = doc.has_metrics;
        self.threads = clampThreads(spec.threads);
        self.has_training = want_training;
        self.memory_budget_bytes = if (spec.memory_mib > 0)
            @as(u64, @intCast(spec.memory_mib)) * 1024 * 1024
        else
            0;
        self.solution_id = self.next_id;
        self.next_id += 1;
        self.baseline_id = 0;
        self.clearControlFlags();
        self.last_terminal = .completed;
        self.phase = .published;
    }

    pub fn policyRevision(self: Session) u64 {
        if (self.published) |p| return p.revision;
        return 0;
    }
};
