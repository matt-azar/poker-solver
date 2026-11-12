const std = @import("std");
const compile = @import("../game/compile.zig");
const regret_matching = @import("regret_matching.zig");
const node_lock = @import("node_lock.zig");

pub const TrainError = error{
    InvalidTrain,
    OutOfMemory,
    ThreadQuotaExceeded,
    LockedMemoryLimitExceeded,
    SystemResources,
    Unexpected,
    LockActionCountMismatch,
};

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
        try freezeSigma(game, &state, null);
        return state;
    }

    pub fn deinit(self: *TrainingState) void {
        if (self.regret.len != 0) self.allocator.free(self.regret);
        if (self.strategy_sum.len != 0) self.allocator.free(self.strategy_sum);
        if (self.sigma.len != 0) self.allocator.free(self.sigma);
        self.* = .{ .allocator = self.allocator };
    }

    /// Zero regrets / strategy sums and re-freeze σ (resolve-locked reset path).
    pub fn resetForResolve(
        self: *TrainingState,
        game: compile.CompiledGame,
        locks: ?*const node_lock.LockSet,
    ) TrainError!void {
        if (self.regret.len != 0) @memset(self.regret, 0);
        if (self.strategy_sum.len != 0) @memset(self.strategy_sum, 0);
        if (self.sigma.len != 0) @memset(self.sigma, 0);
        self.trained = 0;
        try freezeSigma(game, self, locks);
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

const SlotPass = enum {
    freeze,
    floor,
    floor_and_freeze,
    publish,
};

fn applyLockAfterMatch(
    state: *TrainingState,
    locks: ?*const node_lock.LockSet,
    slot: compile.Slot,
    n: usize,
    base: usize,
) TrainError!void {
    const set = locks orelse return;
    const lock = set.findForRunout(@intCast(slot.node), slot.turn, slot.river);
    _ = node_lock.applyLockToStrategyF32(state.sigma[base .. base + n], lock, slot.hand) catch |err| {
        return switch (err) {
            error.LockActionCountMismatch => error.LockActionCountMismatch,
        };
    };
    // ZR-125 / Tiger: after lock overwrite, σ row must still be a probability
    // (mirrors validateActionRow; f32 tolerance matches regret_matching).
    // std.debug.assert is a no-op under ReleaseFast.
    var sum: f64 = 0;
    for (state.sigma[base .. base + n]) |p| {
        std.debug.assert(std.math.isFinite(p));
        std.debug.assert(p >= 0);
        sum += p;
    }
    std.debug.assert(@abs(sum - 1.0) <= 1e-5);
}

fn applySlotRange(
    game: compile.CompiledGame,
    state: *TrainingState,
    pass: SlotPass,
    player: i32,
    begin: usize,
    end: usize,
    average: ?[]f32,
    locks: ?*const node_lock.LockSet,
) TrainError!void {
    var index = begin;
    while (index < end) : (index += 1) {
        const slot = game.slots[index];
        std.debug.assert(@as(usize, @intCast(slot.node)) < game.nodes.len);
        const node = game.nodes[@intCast(slot.node)];
        const n: usize = node.n_actions;
        const base: usize = @intCast(slot.base);
        // ZR-125: slot.base + n_actions must fit CFR table lengths (table_entries).
        std.debug.assert(base + n <= state.regret.len);
        std.debug.assert(base + n <= state.sigma.len);
        std.debug.assert(base + n <= state.strategy_sum.len);
        switch (pass) {
            .freeze => {
                regret_matching.regretMatching(state.regret[base .. base + n], state.sigma[base .. base + n]);
                try applyLockAfterMatch(state, locks, slot, n, base);
            },
            .floor => {
                if (player >= 0 and node.player != player) continue;
                regret_matching.floorRegrets(state.regret[base .. base + n]);
            },
            .floor_and_freeze => {
                // Match C++ apply_floor_and_freeze_range: floor updating seat, freeze all.
                if (player >= 0 and node.player == player) {
                    regret_matching.floorRegrets(state.regret[base .. base + n]);
                }
                regret_matching.regretMatching(state.regret[base .. base + n], state.sigma[base .. base + n]);
                try applyLockAfterMatch(state, locks, slot, n, base);
            },
            .publish => {
                const out = average orelse return;
                std.debug.assert(base + n <= out.len);
                regret_matching.normalizeAverage(
                    state.strategy_sum[base .. base + n],
                    out[base .. base + n],
                );
            },
        }
    }
}

const SlotJob = struct {
    game: compile.CompiledGame,
    state: *TrainingState,
    pass: SlotPass,
    player: i32,
    average: ?[]f32,
    locks: ?*const node_lock.LockSet,
    begins: []const usize,
    ends: []const usize,
    err: std.atomic.Value(u8) = std.atomic.Value(u8).init(0),
};

fn runSlotWorker(worker: usize, job: *SlotJob) void {
    applySlotRange(
        job.game,
        job.state,
        job.pass,
        job.player,
        job.begins[worker],
        job.ends[worker],
        job.average,
        job.locks,
    ) catch {
        _ = job.err.store(1, .release);
    };
}

fn partitionSlots(total: usize, workers: u32, begins: []usize, ends: []usize) void {
    const w: usize = workers;
    const base = total / w;
    const remainder = total % w;
    var cursor: usize = 0;
    var worker: usize = 0;
    while (worker < w) : (worker += 1) {
        const count = base + @as(usize, if (worker < remainder) 1 else 0);
        begins[worker] = cursor;
        ends[worker] = cursor + count;
        cursor += count;
    }
}

/// C++ `PoolJob::Slots`: static partition of `game.slots` across `threads`.
/// Slots write disjoint regret/sigma/average spans — no atomics on table cells.
fn runSlotPassThreaded(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    state: *TrainingState,
    pass: SlotPass,
    player: i32,
    threads_in: u32,
    average: ?[]f32,
    locks: ?*const node_lock.LockSet,
) TrainError!void {
    const total = game.slots.len;
    if (total == 0) return;
    const threads: u32 = if (threads_in < 1) 1 else @min(threads_in, 64);
    if (threads <= 1) {
        try applySlotRange(game, state, pass, player, 0, total, average, locks);
        return;
    }

    var begins: [64]usize = undefined;
    var ends: [64]usize = undefined;
    partitionSlots(total, threads, begins[0..threads], ends[0..threads]);
    var job = SlotJob{
        .game = game,
        .state = state,
        .pass = pass,
        .player = player,
        .average = average,
        .locks = locks,
        .begins = begins[0..threads],
        .ends = ends[0..threads],
    };

    var thread_buf = try allocator.alloc(std.Thread, threads - 1);
    defer allocator.free(thread_buf);
    var spawned: usize = 0;
    errdefer {
        var i: usize = 0;
        while (i < spawned) : (i += 1) thread_buf[i].join();
    }
    while (spawned < threads - 1) : (spawned += 1) {
        const idx = spawned + 1;
        thread_buf[spawned] = try std.Thread.spawn(.{}, runSlotWorker, .{ idx, &job });
    }
    runSlotWorker(0, &job);
    for (thread_buf) |t| t.join();
    if (job.err.load(.acquire) != 0) return error.LockActionCountMismatch;
}

pub fn freezeSigma(game: compile.CompiledGame, state: *TrainingState, locks: ?*const node_lock.LockSet) TrainError!void {
    try applySlotRange(game, state, .freeze, -1, 0, game.slots.len, null, locks);
}

pub fn freezeSigmaThreaded(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    state: *TrainingState,
    threads: u32,
    locks: ?*const node_lock.LockSet,
) TrainError!void {
    try runSlotPassThreaded(allocator, game, state, .freeze, -1, threads, null, locks);
}

pub fn floorPlayer(game: compile.CompiledGame, state: *TrainingState, player: i32) TrainError!void {
    try applySlotRange(game, state, .floor, player, 0, game.slots.len, null, null);
}

pub fn floorPlayerThreaded(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    state: *TrainingState,
    player: i32,
    threads: u32,
) TrainError!void {
    try runSlotPassThreaded(allocator, game, state, .floor, player, threads, null, null);
}

pub fn floorAndFreeze(
    game: compile.CompiledGame,
    state: *TrainingState,
    player: i32,
    locks: ?*const node_lock.LockSet,
) TrainError!void {
    try applySlotRange(game, state, .floor_and_freeze, player, 0, game.slots.len, null, locks);
}

pub fn floorAndFreezeThreaded(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    state: *TrainingState,
    player: i32,
    threads: u32,
    locks: ?*const node_lock.LockSet,
) TrainError!void {
    try runSlotPassThreaded(allocator, game, state, .floor_and_freeze, player, threads, null, locks);
}

/// After a completed iteration: materialize stable average-policy revision (D2).
pub fn publishAverage(allocator: std.mem.Allocator, game: compile.CompiledGame, state: *TrainingState) TrainError!PublishedPolicy {
    return publishAverageThreaded(allocator, game, state, 1);
}

pub fn publishAverageThreaded(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    state: *TrainingState,
    threads: u32,
) TrainError!PublishedPolicy {
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
    try runSlotPassThreaded(allocator, game, state, .publish, -1, threads, published.average, null);
    return published;
}

/// Rewrite an existing average buffer from `strategy_sum` (strategy-edit restore).
/// Does not bump `policy_revision` — caller owns Study revision bookkeeping.
pub fn republishAverageInto(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    state: *TrainingState,
    average: []f32,
) TrainError!void {
    if (state.strategy_sum.len == 0) return;
    if (average.len != state.strategy_sum.len) return error.InvalidTrain;
    @memset(average, 0);
    try runSlotPassThreaded(allocator, game, state, .publish, -1, 1, average, null);
}

/// Normalize `strategy_sum` into a caller-owned buffer and bump `policy_revision`.
/// Prefer this over `publishAverageThreaded` when Session recycles snapshot buffers.
pub fn publishAverageIntoThreaded(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    state: *TrainingState,
    average: []f32,
    threads: u32,
) TrainError!void {
    state.policy_revision += 1;
    if (state.strategy_sum.len == 0) return;
    if (average.len != state.strategy_sum.len) return error.InvalidTrain;
    @memset(average, 0);
    try runSlotPassThreaded(allocator, game, state, .publish, -1, threads, average, null);
}

test "slot passes: 4-thread matches serial" {
    const text =
        \\street-config 1
        \\board Ah Kd 7c 2s
        \\pot 100
        \\stack 100
        \\oop-range QcQd:1,JcJd:1,TcTd:1
        \\ip-range 9c9d:1,8c8d:1,7c7d:1
        \\oop-bets 0.5
        \\ip-bets 0.5
        \\first-to-act 0
        \\max-raises 1
        \\allow-all-in 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 256
        \\threads 1
        \\
    ;
    var spec = try @import("../game/street_config.zig").parseStreetConfig(std.testing.allocator, text);
    defer spec.deinit();
    var game = try compile.compile(std.testing.allocator, spec);
    defer game.deinit();
    try std.testing.expect(game.slots.len > 8);

    var serial = try TrainingState.init(std.testing.allocator, game);
    defer serial.deinit();
    var threaded = try TrainingState.init(std.testing.allocator, game);
    defer threaded.deinit();

    // Seed identical non-trivial regrets so freeze/floor/publish exercise real work.
    for (serial.regret, 0..) |*r, i| {
        const v: f32 = @floatFromInt(@as(i32, @intCast(i % 17)) - 8);
        r.* = v;
        threaded.regret[i] = v;
    }

    try freezeSigma(game, &serial, null);
    try freezeSigmaThreaded(std.testing.allocator, game, &threaded, 4, null);
    for (serial.sigma, threaded.sigma) |a, b| {
        try std.testing.expectApproxEqAbs(@as(f64, a), @as(f64, b), 1e-7);
    }

    try floorAndFreeze(game, &serial, 0, null);
    try floorAndFreezeThreaded(std.testing.allocator, game, &threaded, 0, 4, null);
    for (serial.regret, threaded.regret) |a, b| {
        try std.testing.expectApproxEqAbs(@as(f64, a), @as(f64, b), 1e-7);
    }
    for (serial.sigma, threaded.sigma) |a, b| {
        try std.testing.expectApproxEqAbs(@as(f64, a), @as(f64, b), 1e-7);
    }

    try floorPlayer(game, &serial, 1);
    try floorPlayerThreaded(std.testing.allocator, game, &threaded, 1, 4);
    for (serial.regret, threaded.regret) |a, b| {
        try std.testing.expectApproxEqAbs(@as(f64, a), @as(f64, b), 1e-7);
    }

    // Accumulate fake strategy_sum so publish has mass.
    for (serial.strategy_sum, 0..) |*s, i| {
        const v = serial.sigma[i] * 3.0;
        s.* = v;
        threaded.strategy_sum[i] = v;
    }
    var pub1 = try publishAverage(std.testing.allocator, game, &serial);
    defer pub1.deinit();
    var pub4 = try publishAverageThreaded(std.testing.allocator, game, &threaded, 4);
    defer pub4.deinit();
    try std.testing.expectEqual(pub1.average.len, pub4.average.len);
    for (pub1.average, pub4.average) |a, b| {
        try std.testing.expectApproxEqAbs(@as(f64, a), @as(f64, b), 1e-7);
    }
}
