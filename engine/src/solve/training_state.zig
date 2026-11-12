const std = @import("std");
const compile = @import("../game/compile.zig");
const regret_matching = @import("regret_matching.zig");

pub const TrainError = error{InvalidTrain, OutOfMemory};

/// Mutable CFR tables. `sigma` is trainer-exclusive (D2).
pub const TrainingState = struct {
    allocator: std.mem.Allocator,
    regret: []f32 = &.{},
    strategy_sum: []f32 = &.{},
    sigma: []f32 = &.{},
    trained: i32 = 0,
    policy_revision: u64 = 0,

    pub fn init(allocator: std.mem.Allocator, game: compile.CompiledGame) TrainError!TrainingState {
        const n: usize = @intCast(@max(game.table_entries, 0));
        var state = TrainingState{ .allocator = allocator };
        if (n == 0) return state;
        state.regret = allocator.alloc(f32, n) catch return error.OutOfMemory;
        errdefer allocator.free(state.regret);
        state.strategy_sum = allocator.alloc(f32, n) catch return error.OutOfMemory;
        errdefer allocator.free(state.strategy_sum);
        state.sigma = allocator.alloc(f32, n) catch return error.OutOfMemory;
        @memset(state.regret, 0);
        @memset(state.strategy_sum, 0);
        @memset(state.sigma, 0);
        freezeSigma(game, &state);
        return state;
    }

    pub fn deinit(self: *TrainingState) void {
        if (self.regret.len != 0) self.allocator.free(self.regret);
        if (self.strategy_sum.len != 0) self.allocator.free(self.strategy_sum);
        if (self.sigma.len != 0) self.allocator.free(self.sigma);
        self.* = .{ .allocator = self.allocator };
    }
};

pub const PublishedPolicy = struct {
    allocator: std.mem.Allocator,
    /// Normalized average strategy over the same layout as TrainingState tables.
    average: []f32 = &.{},
    revision: u64 = 0,
    trained: i32 = 0,

    pub fn deinit(self: *PublishedPolicy) void {
        if (self.average.len != 0) self.allocator.free(self.average);
        self.* = .{ .allocator = self.allocator };
    }
};

pub fn freezeSigma(game: compile.CompiledGame, state: *TrainingState) void {
    for (game.slots) |slot| {
        const node = game.nodes[@intCast(slot.node)];
        const n: usize = node.n_actions;
        const base: usize = @intCast(slot.base);
        regret_matching.regretMatching(state.regret[base .. base + n], state.sigma[base .. base + n]);
    }
}

pub fn floorPlayer(game: compile.CompiledGame, state: *TrainingState, player: i32) void {
    for (game.slots) |slot| {
        const node = game.nodes[@intCast(slot.node)];
        if (node.player != player) continue;
        const n: usize = node.n_actions;
        const base: usize = @intCast(slot.base);
        regret_matching.floorRegrets(state.regret[base .. base + n]);
    }
}

pub fn floorAndFreeze(game: compile.CompiledGame, state: *TrainingState, player: i32) void {
    floorPlayer(game, state, player);
    freezeSigma(game, state);
}

/// After a completed iteration: materialize stable average-policy revision (D2).
pub fn publishAverage(allocator: std.mem.Allocator, game: compile.CompiledGame, state: *TrainingState) TrainError!PublishedPolicy {
    state.policy_revision += 1;
    var published = PublishedPolicy{
        .allocator = allocator,
        .revision = state.policy_revision,
        .trained = state.trained,
    };
    if (state.strategy_sum.len == 0) {
        published.average = &.{};
        return published;
    }
    published.average = allocator.alloc(f32, state.strategy_sum.len) catch return error.OutOfMemory;
    @memset(published.average, 0);
    for (game.slots) |slot| {
        const node = game.nodes[@intCast(slot.node)];
        const n: usize = node.n_actions;
        const base: usize = @intCast(slot.base);
        regret_matching.normalizeAverage(
            state.strategy_sum[base .. base + n],
            published.average[base .. base + n],
        );
    }
    return published;
}
