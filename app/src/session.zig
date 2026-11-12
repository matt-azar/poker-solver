const std = @import("std");
const poker_engine = @import("poker_engine");
const poker_formats = @import("poker_formats");

pub const SessionError = error{
    InvalidSession,
    Busy,
    NothingPublished,
    OpenFailed,
    OutOfMemory,
} || poker_formats.OpenError || poker_engine.game.street_config.ConfigError || poker_engine.game.compile.CompileError || poker_engine.solve.training_state.TrainError || poker_engine.solve.cfr_plus.CfrError || poker_engine.solve.frozen_walk.FrozenError;

pub const Phase = enum {
    idle,
    compiling,
    training,
    paused,
    published,
    failed,
};

pub const Metrics = poker_formats.Metrics;

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
    metrics: Metrics = .{},
    has_metrics: bool = false,
    frozen: bool = false,

    pub fn init(allocator: std.mem.Allocator) Session {
        return .{ .allocator = allocator };
    }

    pub fn deinit(self: *Session) void {
        self.clearSolution();
        self.* = .{ .allocator = self.allocator };
    }

    fn clearSolution(self: *Session) void {
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
        if (self.locks_text.len != 0) {
            self.allocator.free(self.locks_text);
            self.locks_text = &.{};
        }
        if (self.strategy_edits_text.len != 0) {
            self.allocator.free(self.strategy_edits_text);
            self.strategy_edits_text = &.{};
        }
        self.metrics = .{};
        self.has_metrics = false;
        self.frozen = false;
        self.phase = .idle;
    }

    /// Begin a new solve from street-config text. On failure, prior solution is kept.
    pub fn begin(self: *Session, config_text: []const u8) SessionError!void {
        if (self.phase == .training or self.phase == .compiling) return error.Busy;

        var spec = try poker_engine.game.parseStreetConfig(self.allocator, config_text);
        defer spec.deinit();
        var game = try poker_engine.game.compile.compile(self.allocator, spec);
        errdefer game.deinit();
        var training = try poker_engine.solve.training_state.TrainingState.init(self.allocator, game);
        errdefer training.deinit();
        const owned_config = self.allocator.dupe(u8, config_text) catch return error.OutOfMemory;
        errdefer self.allocator.free(owned_config);

        // Install only after compile+train tables succeed (fail-closed).
        self.clearSolution();
        self.config_text = owned_config;
        self.game = game;
        self.training = training;
        self.solution_id = self.next_id;
        self.next_id += 1;
        self.baseline_id = 0;
        // Ready to train; not yet published. Open may still replace (fail-closed).
        self.phase = .paused;
    }

    pub fn train(self: *Session, iterations: i32) SessionError!void {
        if (self.phase != .paused and self.phase != .published) {
            return error.InvalidSession;
        }
        const game = self.game orelse return error.InvalidSession;
        const state = &(self.training orelse return error.InvalidSession);
        self.phase = .training;
        // StreetBatch-style frozen CFR+ (C++ train_frozen_cfr_plus_iterations).
        const published = try poker_engine.solve.frozen_walk.trainFrozenCfrPlus(
            self.allocator,
            game,
            state,
            iterations,
        );
        if (self.published) |*old| old.deinit();
        self.published = published;
        self.phase = .published;
    }

    pub fn pause(self: *Session) SessionError!void {
        if (self.phase != .published and self.phase != .training) return error.InvalidSession;
        if (self.published == null) return error.NothingPublished;
        self.phase = .paused;
    }

    pub fn setLocksText(self: *Session, text: []const u8) SessionError!void {
        const owned = self.allocator.dupe(u8, text) catch return error.OutOfMemory;
        if (self.locks_text.len != 0) self.allocator.free(self.locks_text);
        self.locks_text = owned;
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

        doc.slot_actions = self.allocator.alloc(u16, game.slots.len) catch return error.OutOfMemory;
        for (game.slots, 0..) |slot, i| {
            doc.slot_actions[i] = game.nodes[@intCast(slot.node)].n_actions;
        }
        doc.average = self.allocator.dupe(f32, published.average) catch return error.OutOfMemory;

        if (self.training) |state| {
            if (state.regret.len != 0) {
                doc.trained = state.trained;
                doc.regret = self.allocator.dupe(f32, state.regret) catch return error.OutOfMemory;
                doc.strategy_sum = self.allocator.dupe(f32, state.strategy_sum) catch return error.OutOfMemory;
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
        var doc = try self.buildDocument();
        defer doc.deinit();
        try poker_formats.writeFile(self.allocator, path, doc);
    }

    /// Open for study (and optional resume). Fail-closed: on error prior session unchanged.
    pub fn open(self: *Session, path: []const u8) SessionError!void {
        if (self.phase == .training or self.phase == .compiling) return error.Busy;

        var doc = poker_formats.readFile(self.allocator, path) catch |err| {
            return err;
        };
        defer doc.deinit();

        var spec = try poker_engine.game.parseStreetConfig(self.allocator, doc.config_text);
        defer spec.deinit();
        var game = try poker_engine.game.compile.compile(self.allocator, spec);
        errdefer game.deinit();

        // Logical index must match compile (combo order + slot arities).
        if (doc.oop_combos.len != game.hands.combos[0].len) return error.InvalidPsol;
        if (doc.ip_combos.len != game.hands.combos[1].len) return error.InvalidPsol;
        if (!std.mem.eql(i32, doc.oop_combos, game.hands.combos[0])) return error.InvalidPsol;
        if (!std.mem.eql(i32, doc.ip_combos, game.hands.combos[1])) return error.InvalidPsol;
        if (doc.slot_actions.len != game.slots.len) return error.InvalidPsol;
        for (game.slots, 0..) |slot, i| {
            if (doc.slot_actions[i] != game.nodes[@intCast(slot.node)].n_actions) return error.InvalidPsol;
        }
        if (doc.average.len != @as(usize, @intCast(game.table_entries))) return error.InvalidPsol;

        var training = try poker_engine.solve.training_state.TrainingState.init(self.allocator, game);
        errdefer training.deinit();
        if (doc.hasTraining()) {
            if (doc.regret.len != training.regret.len) return error.InvalidPsol;
            @memcpy(training.regret, doc.regret);
            @memcpy(training.strategy_sum, doc.strategy_sum);
            training.trained = doc.trained;
            poker_engine.solve.training_state.freezeSigma(game, &training);
        }

        var published = poker_engine.solve.training_state.PublishedPolicy{
            .allocator = self.allocator,
            .average = self.allocator.dupe(f32, doc.average) catch return error.OutOfMemory,
            .revision = 1,
            .trained = doc.trained,
        };
        errdefer published.deinit();
        training.policy_revision = 1;

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
        self.locks_text = owned_locks;
        self.strategy_edits_text = owned_edits;
        self.frozen = doc.frozen;
        self.metrics = doc.metrics;
        self.has_metrics = doc.has_metrics;
        self.solution_id = self.next_id;
        self.next_id += 1;
        self.baseline_id = 0;
        self.phase = .published;
    }

    pub fn policyRevision(self: Session) u64 {
        if (self.published) |p| return p.revision;
        return 0;
    }
};
