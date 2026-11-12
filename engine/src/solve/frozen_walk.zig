//! StreetBatch-style frozen CFR+ walk (C++ frozen_walk).
//! First-future-card chance steal when threads > 1 (C++ parallel_chance); nested chance stays serial.
//! Persistent chance worker pool (C++ Engine::workers_): lazy-start on first
//! dispatch so `*FrozenCtx` is already at its final address (init returns by value).
//! Replaces deal-by-deal chance expansion for flop/turn scale.
const std = @import("std");
const card = @import("../poker/card.zig");
const hand_eval = @import("../poker/hand_eval.zig");
const payoff = @import("../poker/payoff.zig");
const range_mod = @import("../poker/range.zig");
const compile = @import("../game/compile.zig");
const regret_matching = @import("regret_matching.zig");
const training_state = @import("training_state.zig");
const node_lock = @import("node_lock.zig");

pub const FrozenError = error{
    InvalidFrozen,
    OutOfMemory,
    ThreadQuotaExceeded,
    LockedMemoryLimitExceeded,
    SystemResources,
    Unexpected,
} || hand_eval.EvalError || payoff.PayoffError || training_state.TrainError;

/// Avoid importing analysis/ from solve/ (cycle). Same fields as EvaluationResult.
pub const FrozenEval = struct {
    u0: f64 = 0,
    u1: f64 = 0,
    br0: f64 = 0,
    br1: f64 = 0,
    nash_gap: f64 = 0,
    accuracy: f64 = 0,
};

const max_actions: usize = 8;
const max_depth: usize = 64;

const HandSupport = struct {
    compatible: i32 = 0,
    contain: [52]i32 = .{0} ** 52,
};

/// Packed showdown strength (C++ pack_rank): higher wins.
fn packRank(value: hand_eval.HandValue) u32 {
    var rank: u32 = @intFromEnum(value.category);
    var i: usize = 0;
    while (i < 5) : (i += 1) {
        rank = rank * 16 + @as(u32, @intCast(value.tiebreak[i]));
    }
    return rank;
}

fn runoutKey(turn: i32, river: i32) i32 {
    return (turn + 1) * 64 + (river + 1);
}

/// Immutable showdown facts for one runout (C++ Engine::RunoutRanks).
/// Order is rank then hand index over every indexed hand.
const RunoutRanks = struct {
    rank: [2][]u32 = .{ &.{}, &.{} },
    order: [2][]u16 = .{ &.{}, &.{} },
    pos: [2][]u16 = .{ &.{}, &.{} },
    worse_end: [2][]u16 = .{ &.{}, &.{} },
    better_begin: [2][]u16 = .{ &.{}, &.{} },
    /// Four opponent-list cuts per hero hand: a@L, b@L, a@U, b@U.
    card_cut: [2][]u16 = .{ &.{}, &.{} },
    card_pos: [2][]u16 = .{ &.{}, &.{} },
    card_off: [2][]u32 = .{ &.{}, &.{} },

    fn deinit(self: *RunoutRanks, allocator: std.mem.Allocator) void {
        inline for (0..2) |side| {
            if (self.rank[side].len != 0) allocator.free(self.rank[side]);
            if (self.order[side].len != 0) allocator.free(self.order[side]);
            if (self.pos[side].len != 0) allocator.free(self.pos[side]);
            if (self.worse_end[side].len != 0) allocator.free(self.worse_end[side]);
            if (self.better_begin[side].len != 0) allocator.free(self.better_begin[side]);
            if (self.card_cut[side].len != 0) allocator.free(self.card_cut[side]);
            if (self.card_pos[side].len != 0) allocator.free(self.card_pos[side]);
            if (self.card_off[side].len != 0) allocator.free(self.card_off[side]);
        }
        self.* = undefined;
    }
};

const Scratch = struct {
    pi0: []f64,
    pi1: []f64,
    ev0: []f64,
    ev1: []f64,
    aev0: []f64, // n_actions * n0
    aev1: []f64,
    slot_base: []i32,

    fn deinit(self: *Scratch, allocator: std.mem.Allocator) void {
        allocator.free(self.pi0);
        allocator.free(self.pi1);
        allocator.free(self.ev0);
        allocator.free(self.ev1);
        allocator.free(self.aev0);
        allocator.free(self.aev1);
        allocator.free(self.slot_base);
        self.* = undefined;
    }
};

/// Per-worker mutable buffers (C++ WorkerContext). Shared tables stay on FrozenCtx.
const WorkerLocal = struct {
    live0: []bool,
    live1: []bool,
    /// Compact live hand indexes for the current board (C++ BoardSupport::idx*).
    idx0: []u16,
    idx1: []u16,
    idx0_len: usize = 0,
    idx1_len: usize = 0,
    amount0: []f64,
    amount1: []f64,
    by_card0: [52]f64 = .{0} ** 52,
    by_card1: [52]f64 = .{0} ** 52,
    /// Showdown prefix scratch (C++ prefix_buf / ordered_buf / block_buf).
    prefix_buf: []f64,
    ordered_buf: []f64,
    block_buf: []f64,
    block_base: [52]u32 = .{0} ** 52,
    support_turn: i32 = -2,
    support_river: i32 = -2,
    scratch: [max_depth]Scratch = undefined,
    scratch_len: usize = 0,

    fn init(allocator: std.mem.Allocator, n0: usize, n1: usize) FrozenError!WorkerLocal {
        const wide = @max(n0, n1);
        // Compact card prefixes: one initial zero per card, then one weight per hole card.
        const block_cap = wide * 2 + 52;
        var w = WorkerLocal{
            .live0 = try allocator.alloc(bool, n0),
            .live1 = try allocator.alloc(bool, n1),
            .idx0 = try allocator.alloc(u16, n0),
            .idx1 = try allocator.alloc(u16, n1),
            .amount0 = try allocator.alloc(f64, n0),
            .amount1 = try allocator.alloc(f64, n1),
            .prefix_buf = try allocator.alloc(f64, wide + 1),
            .ordered_buf = try allocator.alloc(f64, wide),
            .block_buf = try allocator.alloc(f64, block_cap),
        };
        errdefer w.deinit(allocator);
        @memset(w.live0, true);
        @memset(w.live1, true);
        var d: usize = 0;
        while (d < max_depth) : (d += 1) {
            w.scratch[d] = .{
                .pi0 = try allocator.alloc(f64, n0),
                .pi1 = try allocator.alloc(f64, n1),
                .ev0 = try allocator.alloc(f64, n0),
                .ev1 = try allocator.alloc(f64, n1),
                .aev0 = try allocator.alloc(f64, max_actions * n0),
                .aev1 = try allocator.alloc(f64, max_actions * n1),
                .slot_base = try allocator.alloc(i32, @max(n0, n1)),
            };
            w.scratch_len = d + 1;
        }
        return w;
    }

    fn deinit(self: *WorkerLocal, allocator: std.mem.Allocator) void {
        var d: usize = 0;
        while (d < self.scratch_len) : (d += 1) {
            self.scratch[d].deinit(allocator);
        }
        allocator.free(self.live0);
        allocator.free(self.live1);
        allocator.free(self.idx0);
        allocator.free(self.idx1);
        allocator.free(self.amount0);
        allocator.free(self.amount1);
        allocator.free(self.prefix_buf);
        allocator.free(self.ordered_buf);
        allocator.free(self.block_buf);
        self.* = undefined;
    }

    fn resetSupport(self: *WorkerLocal) void {
        self.support_turn = -2;
        self.support_river = -2;
        self.idx0_len = 0;
        self.idx1_len = 0;
    }
};

const k_max_threads: u32 = 64;

pub const FrozenCtx = struct {
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    /// Required for CFR+ train walks; null for evaluation-only contexts.
    state: ?*training_state.TrainingState,
    n0: usize,
    n1: usize,
    joint_scale: f64,
    support0: []HandSupport,
    support1: []HandSupport,
    /// Opponent hand with the same combo, or -1 (C++ twin_hand).
    twin0: []i32,
    twin1: []i32,
    /// Heap-stable tables: HashMap stores pointers so rehash under MT cannot
    /// invalidate `*const RunoutRanks` still in use by other workers (UAF).
    ranks: std.AutoHashMap(i32, *RunoutRanks),
    ranks_mu: std.Thread.Mutex = .{},
    threads: u32 = 1,
    workspace: WorkerLocal = undefined,
    workspace_ready: bool = false,
    extras: []WorkerLocal = &.{},
    result0: []f64 = &.{},
    result1: []f64 = &.{},
    /// Set after a successful `ensureAllRanksReady` so Acc-stop `train(1)` / eval
    /// can reuse Session-owned ctx without rebuilding runout tables.
    ranks_ready: bool = false,
    /// Persistent chance workers (C++ `Engine::workers_`). Spawn once per
    /// FrozenCtx lifetime; wake/join per chance instead of `Thread.spawn` each
    /// dispatch. Stopped in `deinit` / Session `begin`. Slots stay separate.
    pool_threads: []std.Thread = &.{},
    pool_mu: std.Thread.Mutex = .{},
    pool_work_cv: std.Thread.Condition = .{},
    pool_done_cv: std.Thread.Condition = .{},
    pool_epoch: u64 = 0,
    pool_finished: u32 = 0,
    pool_stop: bool = false,
    pool_job: ?*const ChanceJob = null,
    /// Non-owning. When set, freeze / floorAndFreeze replace RM with locked rows
    /// (C++ Engine::locks_). Null keeps unlocked freeze bit-identical.
    locks: ?*const node_lock.LockSet = null,

    pub fn init(allocator: std.mem.Allocator, game: compile.CompiledGame, state: *training_state.TrainingState) FrozenError!FrozenCtx {
        return initCommon(allocator, game, state, 1);
    }

    pub fn initThreaded(
        allocator: std.mem.Allocator,
        game: compile.CompiledGame,
        state: *training_state.TrainingState,
        threads: u32,
    ) FrozenError!FrozenCtx {
        return initCommon(allocator, game, state, threads);
    }

    pub fn initEval(allocator: std.mem.Allocator, game: compile.CompiledGame) FrozenError!FrozenCtx {
        return initCommon(allocator, game, null, 1);
    }

    pub fn initEvalThreaded(allocator: std.mem.Allocator, game: compile.CompiledGame, threads: u32) FrozenError!FrozenCtx {
        return initCommon(allocator, game, null, threads);
    }

    fn clampThreads(threads: u32) u32 {
        if (threads < 1) return 1;
        return @min(threads, k_max_threads);
    }

    fn initCommon(
        allocator: std.mem.Allocator,
        game: compile.CompiledGame,
        state: ?*training_state.TrainingState,
        threads_in: u32,
    ) FrozenError!FrozenCtx {
        const n0: usize = @intCast(game.hands.nHands(0));
        const n1: usize = @intCast(game.hands.nHands(1));
        if (n0 == 0 or n1 == 0) return error.InvalidFrozen;
        if (game.hands.joint_mass <= 0) return error.InvalidFrozen;
        const threads = clampThreads(threads_in);
        var ctx = FrozenCtx{
            .allocator = allocator,
            .game = game,
            .state = state,
            .n0 = n0,
            .n1 = n1,
            .joint_scale = 1.0 / game.hands.joint_mass,
            .support0 = try allocator.alloc(HandSupport, n0),
            .support1 = try allocator.alloc(HandSupport, n1),
            .twin0 = try allocator.alloc(i32, n0),
            .twin1 = try allocator.alloc(i32, n1),
            .ranks = std.AutoHashMap(i32, *RunoutRanks).init(allocator),
            .threads = threads,
        };
        errdefer ctx.deinit();
        @memset(ctx.support0, .{});
        @memset(ctx.support1, .{});
        try ctx.buildSupport();
        try ctx.buildTwins();
        ctx.workspace = try WorkerLocal.init(allocator, n0, n1);
        ctx.workspace_ready = true;
        if (threads > 1) {
            ctx.extras = try allocator.alloc(WorkerLocal, threads - 1);
            var i: usize = 0;
            errdefer {
                var j: usize = 0;
                while (j < i) : (j += 1) ctx.extras[j].deinit(allocator);
                allocator.free(ctx.extras);
                ctx.extras = &.{};
            }
            while (i < threads - 1) : (i += 1) {
                ctx.extras[i] = try WorkerLocal.init(allocator, n0, n1);
            }
            ctx.result0 = try allocator.alloc(f64, 52 * n0);
            ctx.result1 = try allocator.alloc(f64, 52 * n1);
            // Chance pool starts lazily on first dispatch: FrozenCtx is returned
            // by value from init, so spawning here would pin a dangling `self`.
        }
        return ctx;
    }

    pub fn deinit(self: *FrozenCtx) void {
        // Join pool before freeing WorkerLocal scratch workers still touch.
        self.stopChancePool();
        if (self.result0.len != 0) self.allocator.free(self.result0);
        if (self.result1.len != 0) self.allocator.free(self.result1);
        if (self.extras.len != 0) {
            for (self.extras) |*extra| extra.deinit(self.allocator);
            self.allocator.free(self.extras);
        }
        if (self.workspace_ready) {
            self.workspace.deinit(self.allocator);
            self.workspace_ready = false;
        }
        var it = self.ranks.iterator();
        while (it.next()) |entry| {
            entry.value_ptr.*.deinit(self.allocator);
            self.allocator.destroy(entry.value_ptr.*);
        }
        self.ranks.deinit();
        self.allocator.free(self.support0);
        self.allocator.free(self.support1);
        self.allocator.free(self.twin0);
        self.allocator.free(self.twin1);
        self.* = undefined;
    }

    fn startChancePool(self: *FrozenCtx) FrozenError!void {
        if (self.threads <= 1) return;
        const n: usize = self.threads - 1;
        self.pool_threads = try self.allocator.alloc(std.Thread, n);
        errdefer {
            self.allocator.free(self.pool_threads);
            self.pool_threads = &.{};
        }
        var spawned: usize = 0;
        errdefer {
            self.pool_mu.lock();
            self.pool_stop = true;
            self.pool_mu.unlock();
            self.pool_work_cv.broadcast();
            var i: usize = 0;
            while (i < spawned) : (i += 1) self.pool_threads[i].join();
            self.allocator.free(self.pool_threads);
            self.pool_threads = &.{};
            self.pool_stop = false;
        }
        while (spawned < n) : (spawned += 1) {
            const idx = spawned + 1;
            self.pool_threads[spawned] = try std.Thread.spawn(.{}, chancePoolMain, .{ self, idx });
        }
    }

    fn stopChancePool(self: *FrozenCtx) void {
        if (self.pool_threads.len == 0) return;
        self.pool_mu.lock();
        self.pool_stop = true;
        self.pool_mu.unlock();
        self.pool_work_cv.broadcast();
        for (self.pool_threads) |t| t.join();
        self.allocator.free(self.pool_threads);
        self.pool_threads = &.{};
        self.pool_job = null;
        self.pool_finished = 0;
        self.pool_epoch = 0;
        self.pool_stop = false;
    }

    fn chancePoolMain(self: *FrozenCtx, worker_index: usize) void {
        var seen: u64 = 0;
        while (true) {
            self.pool_mu.lock();
            while (!self.pool_stop and self.pool_epoch == seen) {
                self.pool_work_cv.wait(&self.pool_mu);
            }
            if (self.pool_stop) {
                self.pool_mu.unlock();
                return;
            }
            seen = self.pool_epoch;
            const job = self.pool_job.?;
            self.pool_mu.unlock();

            runChanceSteal(worker_index, job);

            self.pool_mu.lock();
            self.pool_finished += 1;
            const done = self.pool_finished == self.threads - 1;
            if (done) self.pool_done_cv.signal();
            self.pool_mu.unlock();
        }
    }

    fn workerAt(self: *FrozenCtx, index: usize) *WorkerLocal {
        if (index == 0) return &self.workspace;
        return &self.extras[index - 1];
    }

    fn buildTwins(self: *FrozenCtx) FrozenError!void {
        @memset(self.twin0, -1);
        @memset(self.twin1, -1);
        var h0: usize = 0;
        while (h0 < self.n0) : (h0 += 1) {
            const combo = self.game.hands.combos[0][h0];
            const opp = self.game.hands.combo_to_hand[1][@intCast(combo)];
            self.twin0[h0] = opp;
        }
        var h1: usize = 0;
        while (h1 < self.n1) : (h1 += 1) {
            const combo = self.game.hands.combos[1][h1];
            const opp = self.game.hands.combo_to_hand[0][@intCast(combo)];
            self.twin1[h1] = opp;
        }
    }
    fn buildSupport(self: *FrozenCtx) FrozenError!void {
        inline for (0..2) |player| {
            const rows = if (player == 0) self.support0 else self.support1;
            const count = if (player == 0) self.n0 else self.n1;
            const opp = 1 - player;
            const opp_count = if (opp == 0) self.n0 else self.n1;
            var hand: usize = 0;
            while (hand < count) : (hand += 1) {
                const c0 = self.game.hands.hole_low[player][hand];
                const c1 = self.game.hands.hole_high[player][hand];
                var other: usize = 0;
                while (other < opp_count) : (other += 1) {
                    const d0 = self.game.hands.hole_low[opp][other];
                    const d1 = self.game.hands.hole_high[opp][other];
                    if (d0 == c0 or d0 == c1 or d1 == c0 or d1 == c1) continue;
                    rows[hand].compatible += 1;
                    rows[hand].contain[@intCast(d0)] += 1;
                    rows[hand].contain[@intCast(d1)] += 1;
                }
            }
        }
    }

    fn handBlocksBoard(self: *const FrozenCtx, player: usize, hand: usize, turn: i32, river: i32) bool {
        const c0 = self.game.hands.hole_low[player][hand];
        const c1 = self.game.hands.hole_high[player][hand];
        for (self.game.board) |b| {
            if (b == c0 or b == c1) return true;
        }
        if (turn >= 0 and (turn == c0 or turn == c1)) return true;
        if (river >= 0 and (river == c0 or river == c1)) return true;
        return false;
    }

    fn compatibleOn(self: *const FrozenCtx, player: usize, hand: usize, turn: i32, river: i32) i32 {
        const row = if (player == 0) self.support0[hand] else self.support1[hand];
        var blocked: i32 = 0;
        if (turn >= 0) blocked += row.contain[@intCast(turn)];
        if (river >= 0) blocked += row.contain[@intCast(river)];
        if (turn >= 0 and river >= 0) {
            const pair = range_mod.Range.comboIndex(turn, river) catch {
                return row.compatible - blocked;
            };
            if (self.game.hands.combo_to_hand[1 - player][@intCast(pair)] >= 0) blocked -= 1;
        }
        return row.compatible - blocked;
    }

    /// C++ hand_supported: board-live and at least one compatible opponent.
    fn handSupported(self: *const FrozenCtx, player: usize, hand: usize, turn: i32, river: i32) bool {
        if (self.game.hands.range_w[player][hand] <= 0) return false;
        if (self.handBlocksBoard(player, hand, turn, river)) return false;
        return self.compatibleOn(player, hand, turn, river) > 0;
    }

    fn ensureBoardSupport(self: *FrozenCtx, w: *WorkerLocal, turn: i32, river: i32) void {
        if (w.support_turn == turn and w.support_river == river) return;
        var n0_live: usize = 0;
        var h: usize = 0;
        while (h < self.n0) : (h += 1) {
            const live = self.handSupported(0, h, turn, river);
            w.live0[h] = live;
            if (live) {
                w.idx0[n0_live] = @intCast(h);
                n0_live += 1;
            }
        }
        w.idx0_len = n0_live;
        var n1_live: usize = 0;
        h = 0;
        while (h < self.n1) : (h += 1) {
            const live = self.handSupported(1, h, turn, river);
            w.live1[h] = live;
            if (live) {
                w.idx1[n1_live] = @intCast(h);
                n1_live += 1;
            }
        }
        w.idx1_len = n1_live;
        w.support_turn = turn;
        w.support_river = river;
    }

    fn cardReachesPair(self: *FrozenCtx, w: *WorkerLocal, turn: i32, river: i32, pi0: []const f64, pi1: []const f64) bool {
        self.ensureBoardSupport(w, turn, river);
        var h: usize = 0;
        while (h < self.n0) : (h += 1) {
            if (pi0[h] > 0 and w.live0[h]) return true;
        }
        h = 0;
        while (h < self.n1) : (h += 1) {
            if (pi1[h] > 0 and w.live1[h]) return true;
        }
        return false;
    }
    fn fillActorSlotBases(self: *FrozenCtx, w: *WorkerLocal, here: *Scratch, node: compile.Node, turn: i32, river: i32) FrozenError!void {
        const player: usize = @intCast(node.player);
        const hands = if (player == 0) self.n0 else self.n1;
        const live = if (player == 0) w.live0 else w.live1;
        var hand: usize = 0;
        while (hand < hands) : (hand += 1) {
            if (!live[hand]) {
                here.slot_base[hand] = -1;
                continue;
            }
            const key = self.game.cardKey(node, @intCast(hand), turn, river) catch return error.InvalidFrozen;
            if (key < 0 or @as(usize, @intCast(key)) >= node.slot_of.len) return error.InvalidFrozen;
            const index = node.slot_of[@intCast(key)];
            if (index < 0) return error.InvalidFrozen;
            // ZR-125: slot table index must be in range before reading base.
            std.debug.assert(@as(usize, @intCast(index)) < self.game.slots.len);
            const base = self.game.slots[@intCast(index)].base;
            if (self.state) |st| {
                const b: usize = @intCast(base);
                std.debug.assert(b + node.n_actions <= st.sigma.len);
            }
            here.slot_base[hand] = base;
        }
    }

    fn collectReach(
        self: *FrozenCtx,
        w: *WorkerLocal,
        player: usize,
        pi: []const f64,
        amount: []f64,
        by_card: ?*[52]f64,
    ) f64 {
        const hands = if (player == 0) self.n0 else self.n1;
        const live = if (player == 0) w.live0 else w.live1;
        const weights = self.game.hands.range_w[player];
        @memset(amount, 0);
        if (by_card) |bc| @memset(bc, 0);
        var total: f64 = 0;
        var hand: usize = 0;
        while (hand < hands) : (hand += 1) {
            if (!live[hand] or pi[hand] == 0) continue;
            const mass = pi[hand] * weights[hand];
            amount[hand] = mass;
            total += mass;
            if (by_card) |bc| {
                const c0 = self.game.hands.hole_low[player][hand];
                const c1 = self.game.hands.hole_high[player][hand];
                bc[@intCast(c0)] += mass;
                bc[@intCast(c1)] += mass;
            }
        }
        return total;
    }

    fn blockedReach(self: *const FrozenCtx, hero: usize, hand: usize, by_card: *const [52]f64, opp_amount: []const f64) f64 {
        const c0 = self.game.hands.hole_low[hero][hand];
        const c1 = self.game.hands.hole_high[hero][hand];
        var blocked = by_card[@intCast(c0)] + by_card[@intCast(c1)];
        // Twin hand: same combo on opponent (subtract double-count).
        const combo = range_mod.Range.comboIndex(c0, c1) catch return blocked;
        const opp = 1 - hero;
        const opp_hand = self.game.hands.combo_to_hand[opp][@intCast(combo)];
        if (opp_hand >= 0) {
            blocked -= opp_amount[@intCast(opp_hand)];
        }
        return blocked;
    }

    fn handsBlock(self: *const FrozenCtx, h0: usize, h1: usize) bool {
        const a0 = self.game.hands.hole_low[0][h0];
        const a1 = self.game.hands.hole_high[0][h0];
        const b0 = self.game.hands.hole_low[1][h1];
        const b1 = self.game.hands.hole_high[1][h1];
        return a0 == b0 or a0 == b1 or a1 == b0 or a1 == b1;
    }

    fn listCut(table: *const RunoutRanks, opponent: usize, card_id: i32, order_end: i32) FrozenError!u16 {
        const begin = table.card_off[opponent][@intCast(card_id)];
        const end = table.card_off[opponent][@intCast(card_id + 1)];
        var lower = begin;
        var upper = end;
        const target: u16 = @intCast(order_end);
        while (lower < upper) {
            const mid = lower + (upper - lower) / 2;
            if (table.card_pos[opponent][mid] < target) {
                lower = mid + 1;
            } else {
                upper = mid;
            }
        }
        const cut = lower - begin;
        if (cut > 65535) return error.InvalidFrozen;
        return @intCast(cut);
    }

    fn fillShowdown(self: *FrozenCtx, table: *RunoutRanks) FrozenError!void {
        inline for (0..2) |side| {
            const hands = if (side == 0) self.n0 else self.n1;
            table.order[side] = try self.allocator.alloc(u16, hands);
            table.pos[side] = try self.allocator.alloc(u16, hands);
            table.card_off[side] = try self.allocator.alloc(u32, 53);
            table.card_pos[side] = try self.allocator.alloc(u16, hands * 2);
            var hand: usize = 0;
            while (hand < hands) : (hand += 1) {
                table.order[side][hand] = @intCast(hand);
            }
            // Sort by rank ascending, then hand index (C++ fill_showdown).
            std.mem.sort(u16, table.order[side], table.rank[side], struct {
                fn lessThan(ranks: []u32, a: u16, b: u16) bool {
                    const ra = ranks[a];
                    const rb = ranks[b];
                    if (ra != rb) return ra < rb;
                    return a < b;
                }
            }.lessThan);
            var counts: [52]u32 = .{0} ** 52;
            var index: usize = 0;
            while (index < hands) : (index += 1) {
                const h: usize = table.order[side][index];
                table.pos[side][h] = @intCast(index);
                counts[@intCast(self.game.hands.hole_low[side][h])] += 1;
                counts[@intCast(self.game.hands.hole_high[side][h])] += 1;
            }
            table.card_off[side][0] = 0;
            var card_i: usize = 0;
            while (card_i < 52) : (card_i += 1) {
                table.card_off[side][card_i + 1] = table.card_off[side][card_i] + counts[card_i];
            }
            if (table.card_off[side][52] != hands * 2) return error.InvalidFrozen;
            var cursor: [52]u32 = undefined;
            card_i = 0;
            while (card_i < 52) : (card_i += 1) {
                cursor[card_i] = table.card_off[side][card_i];
            }
            index = 0;
            while (index < hands) : (index += 1) {
                const h: usize = table.order[side][index];
                const first: usize = @intCast(self.game.hands.hole_low[side][h]);
                const second: usize = @intCast(self.game.hands.hole_high[side][h]);
                table.card_pos[side][cursor[first]] = @intCast(index);
                cursor[first] += 1;
                table.card_pos[side][cursor[second]] = @intCast(index);
                cursor[second] += 1;
            }
        }

        inline for (0..2) |hero| {
            const opponent: usize = 1 - hero;
            const hero_hands = if (hero == 0) self.n0 else self.n1;
            const opp_hands = if (opponent == 0) self.n0 else self.n1;
            table.worse_end[hero] = try self.allocator.alloc(u16, hero_hands);
            table.better_begin[hero] = try self.allocator.alloc(u16, hero_hands);
            table.card_cut[hero] = try self.allocator.alloc(u16, hero_hands * 4);
            var hand: usize = 0;
            while (hand < hero_hands) : (hand += 1) {
                const rank = table.rank[hero][hand];
                // First opponent order index with rank >= hero rank.
                var lower: i32 = 0;
                var upper: i32 = @intCast(opp_hands);
                while (lower < upper) {
                    const mid = lower + @divTrunc(upper - lower, 2);
                    const opp_hand = table.order[opponent][@intCast(mid)];
                    if (table.rank[opponent][opp_hand] < rank) {
                        lower = mid + 1;
                    } else {
                        upper = mid;
                    }
                }
                const worse = lower;
                lower = 0;
                upper = @intCast(opp_hands);
                while (lower < upper) {
                    const mid = lower + @divTrunc(upper - lower, 2);
                    const opp_hand = table.order[opponent][@intCast(mid)];
                    if (table.rank[opponent][opp_hand] <= rank) {
                        lower = mid + 1;
                    } else {
                        upper = mid;
                    }
                }
                const better = lower;
                const c0 = self.game.hands.hole_low[hero][hand];
                const c1 = self.game.hands.hole_high[hero][hand];
                table.worse_end[hero][hand] = @intCast(worse);
                table.better_begin[hero][hand] = @intCast(better);
                const cut_at = hand * 4;
                table.card_cut[hero][cut_at] = try listCut(table, opponent, c0, worse);
                table.card_cut[hero][cut_at + 1] = try listCut(table, opponent, c1, worse);
                table.card_cut[hero][cut_at + 2] = try listCut(table, opponent, c0, better);
                table.card_cut[hero][cut_at + 3] = try listCut(table, opponent, c1, better);
            }
        }
    }

    /// Fill every five-card runout rank/showdown table on the calling thread
    /// before a multithreaded pass (C++ `ensure_ranks`). Workers then only read.
    /// Idempotent once `ranks_ready` — Acc-stop reuses a Session-owned ctx.
    pub fn ensureAllRanksReady(self: *FrozenCtx) FrozenError!void {
        if (self.ranks_ready) return;
        var dead: [52]bool = .{false} ** 52;
        for (self.game.board) |c| dead[@intCast(c)] = true;
        if (self.game.board.len == 5) {
            _ = try self.ensureRanks(-1, -1);
            self.ranks_ready = true;
            return;
        }
        if (self.game.board.len == 4) {
            var river: i32 = 0;
            while (river < 52) : (river += 1) {
                if (dead[@intCast(river)]) continue;
                _ = try self.ensureRanks(-1, river);
            }
            self.ranks_ready = true;
            return;
        }
        if (self.game.board.len != 3) return error.InvalidFrozen;
        var turn: i32 = 0;
        while (turn < 52) : (turn += 1) {
            if (dead[@intCast(turn)]) continue;
            var river: i32 = 0;
            while (river < 52) : (river += 1) {
                if (dead[@intCast(river)] or river == turn) continue;
                _ = try self.ensureRanks(turn, river);
            }
        }
        self.ranks_ready = true;
    }

    fn ensureRanks(self: *FrozenCtx, turn: i32, river: i32) FrozenError!*const RunoutRanks {
        const key = runoutKey(turn, river);
        // Fast path: published tables are immutable; pointer stays valid across rehash.
        {
            self.ranks_mu.lock();
            defer self.ranks_mu.unlock();
            if (self.ranks.get(key)) |existing| return existing;
        }

        var board_buf: [5]card.Card = undefined;
        var board_len: usize = 0;
        for (self.game.board) |c| {
            board_buf[board_len] = c;
            board_len += 1;
        }
        if (turn >= 0) {
            board_buf[board_len] = turn;
            board_len += 1;
        }
        if (river >= 0) {
            board_buf[board_len] = river;
            board_len += 1;
        }
        if (board_len != 5) return error.InvalidFrozen;
        const board = board_buf[0..board_len];

        // Build off-lock so other workers can keep reading published tables.
        var owned = true;
        const table = try self.allocator.create(RunoutRanks);
        errdefer if (owned) {
            table.deinit(self.allocator);
            self.allocator.destroy(table);
        };
        table.* = .{};
        table.rank[0] = try self.allocator.alloc(u32, self.n0);
        table.rank[1] = try self.allocator.alloc(u32, self.n1);
        @memset(table.rank[0], 0);
        @memset(table.rank[1], 0);

        var cards: [7]card.Card = undefined;
        @memcpy(cards[2..7], board);
        var h0: usize = 0;
        while (h0 < self.n0) : (h0 += 1) {
            if (self.handBlocksBoard(0, h0, turn, river)) continue;
            cards[0] = self.game.hands.hole_low[0][h0];
            cards[1] = self.game.hands.hole_high[0][h0];
            const value = hand_eval.evaluate(cards[0..7]) catch continue;
            table.rank[0][h0] = packRank(value);
        }
        var h1: usize = 0;
        while (h1 < self.n1) : (h1 += 1) {
            if (self.handBlocksBoard(1, h1, turn, river)) continue;
            cards[0] = self.game.hands.hole_low[1][h1];
            cards[1] = self.game.hands.hole_high[1][h1];
            const value = hand_eval.evaluate(cards[0..7]) catch continue;
            table.rank[1][h1] = packRank(value);
        }
        try self.fillShowdown(table);

        self.ranks_mu.lock();
        defer self.ranks_mu.unlock();
        // Another worker may have won the insert while we filled.
        if (self.ranks.get(key)) |existing| {
            table.deinit(self.allocator);
            self.allocator.destroy(table);
            owned = false;
            return existing;
        }
        try self.ranks.put(key, table);
        owned = false;
        return table;
    }

    fn differenceIsStable(total: f64, removed: f64, difference: f64) bool {
        if (!std.math.isFinite(total) or !std.math.isFinite(removed) or !std.math.isFinite(difference)) {
            return false;
        }
        if (difference < 0.0) return false;
        if (difference == 0.0) return total == 0.0 and removed == 0.0;
        const scale = @max(total, @abs(removed));
        return difference > scale * 1e-3;
    }

    fn sharesHole(self: *const FrozenCtx, hero: usize, hero_hand: usize, opponent: usize, opponent_hand: usize) bool {
        const c0 = self.game.hands.hole_low[hero][hero_hand];
        const c1 = self.game.hands.hole_high[hero][hero_hand];
        const o0 = self.game.hands.hole_low[opponent][opponent_hand];
        const o1 = self.game.hands.hole_high[opponent][opponent_hand];
        return c0 == o0 or c0 == o1 or c1 == o0 or c1 == o1;
    }

    fn directRankMasses(
        self: *const FrozenCtx,
        table: *const RunoutRanks,
        hero: usize,
        hand: usize,
        opp_amount: []const f64,
        worse_mass: *f64,
        better_mass: *f64,
        tie_mass: ?*f64,
    ) void {
        const opponent: usize = 1 - hero;
        const worse = table.worse_end[hero][hand];
        const after_tie = table.better_begin[hero][hand];
        worse_mass.* = 0;
        better_mass.* = 0;
        if (tie_mass) |tm| tm.* = 0;
        var other: usize = 0;
        while (other < opp_amount.len) : (other += 1) {
            const piece = opp_amount[other];
            if (!(piece > 0.0) or self.sharesHole(hero, hand, opponent, other)) continue;
            const at = table.pos[opponent][other];
            if (at < worse) {
                worse_mass.* += piece;
            } else if (at >= after_tie) {
                better_mass.* += piece;
            } else if (tie_mass) |tm| {
                tm.* += piece;
            }
        }
    }

    fn orderReach(
        self: *const FrozenCtx,
        w: *WorkerLocal,
        player: usize,
        amount: []const f64,
        table: *const RunoutRanks,
    ) FrozenError!void {
        const hands = amount.len;
        if (table.order[player].len != hands) return error.InvalidFrozen;
        if (table.card_off[player].len != 53) return error.InvalidFrozen;
        if (table.card_off[player][52] != hands * 2) return error.InvalidFrozen;
        if (w.prefix_buf.len < hands + 1 or w.ordered_buf.len < hands) return error.InvalidFrozen;
        if (w.block_buf.len < hands * 2 + 52) return error.InvalidFrozen;

        const order = table.order[player];
        const prefix = w.prefix_buf;
        const ordered = w.ordered_buf;
        prefix[0] = 0;
        var running: f64 = 0;
        var index: usize = 0;
        while (index < hands) : (index += 1) {
            const piece = amount[order[index]];
            ordered[index] = piece;
            running += piece;
            prefix[index + 1] = running;
        }

        const block = w.block_buf;
        const card_off = table.card_off[player];
        const card_pos = table.card_pos[player];
        var card_i: usize = 0;
        while (card_i < 52) : (card_i += 1) {
            const begin = card_off[card_i];
            const end = card_off[card_i + 1];
            const base = begin + @as(u32, @intCast(card_i));
            w.block_base[card_i] = base;
            block[base] = 0;
            var total: f64 = 0;
            var at = begin;
            while (at < end) : (at += 1) {
                total += ordered[card_pos[at]];
                block[base + (at - begin) + 1] = total;
            }
        }
        _ = self;
    }

    fn showdownSide(
        self: *FrozenCtx,
        w: *WorkerLocal,
        hero: usize,
        table: *const RunoutRanks,
        win_pay: f64,
        lose_pay: f64,
        tie_pay: f64,
        opp_amount: []const f64,
        ev: []f64,
        stable: bool,
    ) FrozenError!void {
        const opp: usize = 1 - hero;
        try self.orderReach(w, opp, opp_amount, table);
        const opp_hands = opp_amount.len;
        var amount_total: f64 = 0;
        if (stable) {
            for (opp_amount) |piece| {
                if (piece > 0.0) amount_total += piece;
            }
        }
        const need_ties = tie_pay != 0.0;
        const live_idx = if (hero == 0) w.idx0[0..w.idx0_len] else w.idx1[0..w.idx1_len];
        @memset(ev, 0);
        const prefix = w.prefix_buf;
        const block = w.block_buf;
        const block_base = &w.block_base;
        const worse_end = table.worse_end[hero];
        const better_begin = table.better_begin[hero];
        const card_cut = table.card_cut[hero];
        const card_off = table.card_off[opp];
        const pos = table.pos[opp];
        const twins = if (hero == 0) self.twin0 else self.twin1;
        const weights = self.game.hands.range_w[hero];
        const low_pay = if (hero == 0) win_pay else lose_pay;
        const high_pay = if (hero == 0) lose_pay else win_pay;
        const scale = self.joint_scale;
        const prefix_end = prefix[opp_hands];

        for (live_idx) |hand_u| {
            const hand: usize = hand_u;
            const worse: i32 = worse_end[hand];
            const after_tie: i32 = better_begin[hand];
            const c0: usize = @intCast(self.game.hands.hole_low[hero][hand]);
            const c1: usize = @intCast(self.game.hands.hole_high[hero][hand]);
            const cut_at = hand * 4;
            const cut0_worse: u32 = card_cut[cut_at];
            const cut1_worse: u32 = card_cut[cut_at + 1];
            const cut0_better: u32 = card_cut[cut_at + 2];
            const cut1_better: u32 = card_cut[cut_at + 3];
            const base0 = block_base[c0];
            const base1 = block_base[c1];
            const len0 = card_off[c0 + 1] - card_off[c0];
            const len1 = card_off[c1 + 1] - card_off[c1];
            const b0_0 = block[base0];
            const b0_w = block[base0 + cut0_worse];
            const b0_b = block[base0 + cut0_better];
            const b0_l = block[base0 + len0];
            const b1_0 = block[base1];
            const b1_w = block[base1 + cut1_worse];
            const b1_b = block[base1 + cut1_better];
            const b1_l = block[base1 + len1];
            const twin = twins[hand];
            const add_hand: i32 = if (twin >= 0 and opp_amount[@intCast(twin)] != 0.0) twin else -1;
            const add_at: i32 = if (add_hand >= 0) @intCast(pos[@intCast(add_hand)]) else -1;
            const add_piece: f64 = if (add_hand >= 0) opp_amount[@intCast(add_hand)] else 0.0;

            var worse_mass = prefix[@intCast(worse)] - (b0_w - b0_0) - (b1_w - b1_0);
            if (add_at >= 0 and add_at < worse) worse_mass += add_piece;
            var better_mass = prefix_end - prefix[@intCast(after_tie)] - (b0_l - b0_b) - (b1_l - b1_b);
            if (add_at >= after_tie and add_at < @as(i32, @intCast(opp_hands))) better_mass += add_piece;
            var tie_mass: f64 = 0;
            if (need_ties) {
                tie_mass = prefix[@intCast(after_tie)] - prefix[@intCast(worse)] - (b0_b - b0_w) - (b1_b - b1_w);
                if (add_at >= worse and add_at < after_tie) tie_mass += add_piece;
            }
            if (stable) {
                const worse_ok = differenceIsStable(amount_total, amount_total - worse_mass, worse_mass);
                const better_ok = differenceIsStable(amount_total, amount_total - better_mass, better_mass);
                const tie_ok = !need_ties or differenceIsStable(amount_total, amount_total - tie_mass, tie_mass);
                if (!worse_ok or !better_ok or !tie_ok) {
                    self.directRankMasses(
                        table,
                        hero,
                        hand,
                        opp_amount,
                        &worse_mass,
                        &better_mass,
                        if (need_ties) &tie_mass else null,
                    );
                }
            }
            var weighted = low_pay * worse_mass + high_pay * better_mass;
            if (need_ties) weighted += tie_pay * tie_mass;
            ev[hand] = weights[hand] * scale * weighted;
        }
    }

    /// `needed_player`: -1 both seats; 0 only ev0; 1 only ev1.
    /// Unilateral BR eval only consumes the responding seat's utility, so skip the
    /// other showdown/fold side (C++ still computes both; Zig may skip).
    fn applyTerminal(
        self: *FrozenCtx,
        w: *WorkerLocal,
        node: compile.Node,
        turn: i32,
        river: i32,
        pi0: []const f64,
        pi1: []const f64,
        ev0: []f64,
        ev1: []f64,
        stable: bool,
        needed_player: i32,
    ) FrozenError!void {
        self.ensureBoardSupport(w, turn, river);
        const need0 = needed_player < 0 or needed_player == 0;
        const need1 = needed_player < 0 or needed_player == 1;
        // Always clear both: unused side must stay zero so chance/decision
        // reductions never accumulate stale scratch from a prior card.
        @memset(ev0, 0);
        @memset(ev1, 0);

        if (node.folded >= 0) {
            var paid = try payoff.chipTerminal(
                self.game.pot,
                node.contrib[0],
                node.contrib[1],
                node.folded,
                0,
                self.game.rake,
            );
            paid.utility[0] += node.incentive_u0;
            paid.utility[1] += node.incentive_u1;
            if (need0) {
                const total1 = self.collectReach(w, 1, pi1, w.amount1, &w.by_card1);
                for (w.idx0[0..w.idx0_len]) |h0u| {
                    const h0: usize = h0u;
                    const open = total1 - self.blockedReach(0, h0, &w.by_card1, w.amount1);
                    ev0[h0] = paid.utility[0] * self.game.hands.range_w[0][h0] * self.joint_scale * open;
                }
            }
            if (need1) {
                const total0 = self.collectReach(w, 0, pi0, w.amount0, &w.by_card0);
                for (w.idx1[0..w.idx1_len]) |h1u| {
                    const h1: usize = h1u;
                    const open = total0 - self.blockedReach(1, h1, &w.by_card0, w.amount0);
                    ev1[h1] = paid.utility[1] * self.game.hands.range_w[1][h1] * self.joint_scale * open;
                }
            }
            return;
        }

        // Ordered prefix/block showdown (C++ showdown_side) — O(n) per side, not O(n0·n1).
        const ranks = try self.ensureRanks(turn, river);
        // Each hero side only needs opponent amounts.
        if (need0) _ = self.collectReach(w, 1, pi1, w.amount1, null);
        if (need1) _ = self.collectReach(w, 0, pi0, w.amount0, null);

        const win_u = blk: {
            const p = try payoff.chipTerminal(self.game.pot, node.contrib[0], node.contrib[1], -1, 1, self.game.rake);
            break :blk [2]f64{ p.utility[0] + node.incentive_u0, p.utility[1] + node.incentive_u1 };
        };
        const lose_u = blk: {
            const p = try payoff.chipTerminal(self.game.pot, node.contrib[0], node.contrib[1], -1, -1, self.game.rake);
            break :blk [2]f64{ p.utility[0] + node.incentive_u0, p.utility[1] + node.incentive_u1 };
        };
        const tie_u = blk: {
            const p = try payoff.chipTerminal(self.game.pot, node.contrib[0], node.contrib[1], -1, 0, self.game.rake);
            break :blk [2]f64{ p.utility[0] + node.incentive_u0, p.utility[1] + node.incentive_u1 };
        };

        if (need0) {
            try self.showdownSide(w, 0, ranks, win_u[0], lose_u[0], tie_u[0], w.amount1, ev0, stable);
        }
        // Pass player-1 utilities: showdownSide swaps win/lose for hero 1.
        if (need1) {
            try self.showdownSide(w, 1, ranks, win_u[1], lose_u[1], tie_u[1], w.amount0, ev1, stable);
        }
    }

    pub fn walk(
        self: *FrozenCtx,
        w: *WorkerLocal,
        node_index: u32,
        turn: i32,
        river: i32,
        depth: usize,
        updating: i32,
        weight_iter: f64,
        serial_chance: bool,
    ) FrozenError!void {
        if (depth >= max_depth) return error.InvalidFrozen;
        // ZR-125: child indexes must stay inside the compiled tree.
        std.debug.assert(node_index < self.game.nodes.len);
        const node = self.game.nodes[node_index];
        const here = &w.scratch[depth];

        if (node.kind == .terminal) {
            // Train path: stable=false (C++ frozen_walk); both seats.
            try self.applyTerminal(w, node, turn, river, here.pi0, here.pi1, here.ev0, here.ev1, false, -1);
            return;
        }

        if (node.kind == .chance) {
            if (!serial_chance and self.threads > 1) {
                try self.parallelChance(w, node, turn, river, depth, updating, weight_iter);
                return;
            }
            @memset(here.ev0, 0);
            @memset(here.ev1, 0);
            var dead: [52]bool = .{false} ** 52;
            for (self.game.board) |c| dead[@intCast(c)] = true;
            if (turn >= 0) dead[@intCast(turn)] = true;
            if (river >= 0) dead[@intCast(river)] = true;
            // Match C++: 52 - board - 4 hole cards, then minus dealt turn/river.
            var denom: i32 = 52 - @as(i32, @intCast(self.game.board.len)) - 4;
            if (turn >= 0) denom -= 1;
            if (river >= 0) denom -= 1;
            if (denom <= 0) return error.InvalidFrozen;
            const probability = 1.0 / @as(f64, @floatFromInt(denom));
            const child = &w.scratch[depth + 1];
            var c: i32 = 0;
            while (c < 52) : (c += 1) {
                if (dead[@intCast(c)]) continue;
                var next_turn = turn;
                var next_river = river;
                if (node.deal_which == 1) next_turn = c else next_river = c;
                if (!self.cardReachesPair(w, next_turn, next_river, here.pi0, here.pi1)) continue;
                var h0: usize = 0;
                while (h0 < self.n0) : (h0 += 1) {
                    child.pi0[h0] = if (w.live0[h0]) here.pi0[h0] else 0;
                }
                var h1: usize = 0;
                while (h1 < self.n1) : (h1 += 1) {
                    child.pi1[h1] = if (w.live1[h1]) here.pi1[h1] else 0;
                }
                try self.walk(w, node.child[0], next_turn, next_river, depth + 1, updating, weight_iter, true);
                h0 = 0;
                while (h0 < self.n0) : (h0 += 1) here.ev0[h0] += probability * child.ev0[h0];
                h1 = 0;
                while (h1 < self.n1) : (h1 += 1) here.ev1[h1] += probability * child.ev1[h1];
            }
            return;
        }

        self.ensureBoardSupport(w, turn, river);
        const child = &w.scratch[depth + 1];
        if (node.n_actions <= 1) {
            if (node.player == 0) {
                var h0: usize = 0;
                while (h0 < self.n0) : (h0 += 1) {
                    child.pi0[h0] = if (w.live0[h0]) here.pi0[h0] else 0;
                }
                @memcpy(child.pi1, here.pi1);
            } else {
                @memcpy(child.pi0, here.pi0);
                var h1: usize = 0;
                while (h1 < self.n1) : (h1 += 1) {
                    child.pi1[h1] = if (w.live1[h1]) here.pi1[h1] else 0;
                }
            }
            try self.walk(w, node.child[0], turn, river, depth + 1, updating, weight_iter, serial_chance);
            self.ensureBoardSupport(w, turn, river);
            @memcpy(here.ev0, child.ev0);
            @memcpy(here.ev1, child.ev1);
            var z0: usize = 0;
            while (z0 < self.n0) : (z0 += 1) {
                if (!w.live0[z0]) here.ev0[z0] = 0;
            }
            var z1: usize = 0;
            while (z1 < self.n1) : (z1 += 1) {
                if (!w.live1[z1]) here.ev1[z1] = 0;
            }
            return;
        }

        if (node.n_actions > max_actions) return error.InvalidFrozen;
        try self.fillActorSlotBases(w, here, node, turn, river);
        const n_act: usize = node.n_actions;

        var action: usize = 0;
        while (action < n_act) : (action += 1) {
            if (node.player == 0) {
                var h0: usize = 0;
                while (h0 < self.n0) : (h0 += 1) {
                    const base = here.slot_base[h0];
                    if (base < 0) {
                        child.pi0[h0] = 0;
                        continue;
                    }
                    const b: usize = @intCast(base);
                    // ZR-125: σ ≥ 0 ⇒ own-reach stays non-negative (rematch invariant).
                    std.debug.assert(self.state.?.sigma[b + action] >= 0);
                    child.pi0[h0] = here.pi0[h0] * self.state.?.sigma[b + action];
                    std.debug.assert(child.pi0[h0] >= 0);
                }
                @memcpy(child.pi1, here.pi1);
            } else {
                @memcpy(child.pi0, here.pi0);
                var h1: usize = 0;
                while (h1 < self.n1) : (h1 += 1) {
                    const base = here.slot_base[h1];
                    if (base < 0) {
                        child.pi1[h1] = 0;
                        continue;
                    }
                    const b: usize = @intCast(base);
                    std.debug.assert(self.state.?.sigma[b + action] >= 0);
                    child.pi1[h1] = here.pi1[h1] * self.state.?.sigma[b + action];
                    std.debug.assert(child.pi1[h1] >= 0);
                }
            }
            try self.walk(w, node.child[action], turn, river, depth + 1, updating, weight_iter, serial_chance);
            if (node.player == 0) {
                @memcpy(here.aev0[action * self.n0 ..][0..self.n0], child.ev0);
                if (action == 0) {
                    @memcpy(here.ev1, child.ev1);
                } else {
                    var h1: usize = 0;
                    while (h1 < self.n1) : (h1 += 1) here.ev1[h1] += child.ev1[h1];
                }
            } else {
                @memcpy(here.aev1[action * self.n1 ..][0..self.n1], child.ev1);
                if (action == 0) {
                    @memcpy(here.ev0, child.ev0);
                } else {
                    var h0: usize = 0;
                    while (h0 < self.n0) : (h0 += 1) here.ev0[h0] += child.ev0[h0];
                }
            }
        }

        self.ensureBoardSupport(w, turn, river);
        if (node.player == 0) {
            var h0: usize = 0;
            while (h0 < self.n0) : (h0 += 1) {
                if (!w.live0[h0]) {
                    here.ev0[h0] = 0;
                    continue;
                }
                const base = here.slot_base[h0];
                if (base < 0) {
                    here.ev0[h0] = 0;
                    continue;
                }
                const b: usize = @intCast(base);
                const row = self.state.?.sigma[b .. b + n_act];
                var mix: f64 = 0;
                action = 0;
                while (action < n_act) : (action += 1) {
                    mix += row[action] * here.aev0[action * self.n0 + h0];
                }
                here.ev0[h0] = mix;
                if (updating < 0 or updating == 0) {
                    regret_matching.accumulateAverage(
                        self.state.?.strategy_sum[b .. b + n_act],
                        row,
                        weight_iter * here.pi0[h0],
                    );
                    action = 0;
                    while (action < n_act) : (action += 1) {
                        const instant = here.aev0[action * self.n0 + h0] - mix;
                        self.state.?.regret[b + action] += @floatCast(instant);
                    }
                }
            }
            var h1: usize = 0;
            while (h1 < self.n1) : (h1 += 1) {
                if (!w.live1[h1]) here.ev1[h1] = 0;
            }
        } else {
            var h0: usize = 0;
            while (h0 < self.n0) : (h0 += 1) {
                if (!w.live0[h0]) here.ev0[h0] = 0;
            }
            var h1: usize = 0;
            while (h1 < self.n1) : (h1 += 1) {
                if (!w.live1[h1]) {
                    here.ev1[h1] = 0;
                    continue;
                }
                const base = here.slot_base[h1];
                if (base < 0) {
                    here.ev1[h1] = 0;
                    continue;
                }
                const b: usize = @intCast(base);
                const row = self.state.?.sigma[b .. b + n_act];
                var mix: f64 = 0;
                action = 0;
                while (action < n_act) : (action += 1) {
                    mix += row[action] * here.aev1[action * self.n1 + h1];
                }
                here.ev1[h1] = mix;
                if (updating < 0 or updating == 1) {
                    regret_matching.accumulateAverage(
                        self.state.?.strategy_sum[b .. b + n_act],
                        row,
                        weight_iter * here.pi1[h1],
                    );
                    action = 0;
                    while (action < n_act) : (action += 1) {
                        const instant = here.aev1[action * self.n1 + h1] - mix;
                        self.state.?.regret[b + action] += @floatCast(instant);
                    }
                }
            }
        }
    }

    /// C++ `response_walk`: on-profile (`responding == -1`) or unilateral BR.
    pub fn responseWalk(
        self: *FrozenCtx,
        w: *WorkerLocal,
        node_index: u32,
        turn: i32,
        river: i32,
        depth: usize,
        responding: i32,
        sigma: []const f32,
        serial_chance: bool,
    ) FrozenError!void {
        if (depth >= max_depth) return error.InvalidFrozen;
        // ZR-125: child indexes must stay inside the compiled tree.
        std.debug.assert(node_index < self.game.nodes.len);
        const node = self.game.nodes[node_index];
        const here = &w.scratch[depth];

        if (node.kind == .terminal) {
            // Match C++ response_walk: stable=false. Pass responding so unilateral
            // BR can skip the unused seat's showdown/fold side.
            try self.applyTerminal(w, node, turn, river, here.pi0, here.pi1, here.ev0, here.ev1, false, responding);
            return;
        }

        if (node.kind == .chance) {
            if (!serial_chance and self.threads > 1) {
                try self.parallelResponseChance(w, node, turn, river, depth, responding, sigma);
                return;
            }
            @memset(here.ev0, 0);
            @memset(here.ev1, 0);
            var dead: [52]bool = .{false} ** 52;
            for (self.game.board) |c| dead[@intCast(c)] = true;
            if (turn >= 0) dead[@intCast(turn)] = true;
            if (river >= 0) dead[@intCast(river)] = true;
            var denom: i32 = 52 - @as(i32, @intCast(self.game.board.len)) - 4;
            if (turn >= 0) denom -= 1;
            if (river >= 0) denom -= 1;
            if (denom <= 0) return error.InvalidFrozen;
            const probability = 1.0 / @as(f64, @floatFromInt(denom));
            const child = &w.scratch[depth + 1];
            var c: i32 = 0;
            while (c < 52) : (c += 1) {
                if (dead[@intCast(c)]) continue;
                var next_turn = turn;
                var next_river = river;
                if (node.deal_which == 1) next_turn = c else next_river = c;
                if (!self.cardReachesPair(w, next_turn, next_river, here.pi0, here.pi1)) continue;
                var h0: usize = 0;
                while (h0 < self.n0) : (h0 += 1) {
                    child.pi0[h0] = if (w.live0[h0]) here.pi0[h0] else 0;
                }
                var h1: usize = 0;
                while (h1 < self.n1) : (h1 += 1) {
                    child.pi1[h1] = if (w.live1[h1]) here.pi1[h1] else 0;
                }
                try self.responseWalk(w, node.child[0], next_turn, next_river, depth + 1, responding, sigma, true);
                if (responding < 0 or responding == 0) {
                    h0 = 0;
                    while (h0 < self.n0) : (h0 += 1) here.ev0[h0] += probability * child.ev0[h0];
                }
                if (responding < 0 or responding == 1) {
                    h1 = 0;
                    while (h1 < self.n1) : (h1 += 1) here.ev1[h1] += probability * child.ev1[h1];
                }
            }
            return;
        }

        self.ensureBoardSupport(w, turn, river);
        const child = &w.scratch[depth + 1];
        if (node.n_actions <= 1) {
            if (node.player == 0) {
                var h0: usize = 0;
                while (h0 < self.n0) : (h0 += 1) {
                    child.pi0[h0] = if (self.handSupported(0, h0, turn, river)) here.pi0[h0] else 0;
                }
                @memcpy(child.pi1, here.pi1);
            } else {
                @memcpy(child.pi0, here.pi0);
                var h1: usize = 0;
                while (h1 < self.n1) : (h1 += 1) {
                    child.pi1[h1] = if (self.handSupported(1, h1, turn, river)) here.pi1[h1] else 0;
                }
            }
            try self.responseWalk(w, node.child[0], turn, river, depth + 1, responding, sigma, serial_chance);
            if (responding < 0 or responding == 0) {
                @memcpy(here.ev0, child.ev0);
            } else {
                @memset(here.ev0, 0);
            }
            if (responding < 0 or responding == 1) {
                @memcpy(here.ev1, child.ev1);
            } else {
                @memset(here.ev1, 0);
            }
            return;
        }

        if (node.n_actions > max_actions) return error.InvalidFrozen;
        try self.fillActorSlotBases(w, here, node, turn, river);
        const n_act: usize = node.n_actions;
        const choosing = node.player == responding;

        var action: usize = 0;
        while (action < n_act) : (action += 1) {
            if (node.player == 0) {
                var h0: usize = 0;
                while (h0 < self.n0) : (h0 += 1) {
                    const base = here.slot_base[h0];
                    if (base < 0) {
                        child.pi0[h0] = 0;
                        continue;
                    }
                    if (choosing) {
                        child.pi0[h0] = here.pi0[h0];
                    } else {
                        const b: usize = @intCast(base);
                        // ZR-125: σ ≥ 0 ⇒ own-reach stays non-negative.
                        std.debug.assert(sigma[b + action] >= 0);
                        child.pi0[h0] = here.pi0[h0] * sigma[b + action];
                    }
                    std.debug.assert(child.pi0[h0] >= 0);
                }
                @memcpy(child.pi1, here.pi1);
            } else {
                @memcpy(child.pi0, here.pi0);
                var h1: usize = 0;
                while (h1 < self.n1) : (h1 += 1) {
                    const base = here.slot_base[h1];
                    if (base < 0) {
                        child.pi1[h1] = 0;
                        continue;
                    }
                    if (choosing) {
                        child.pi1[h1] = here.pi1[h1];
                    } else {
                        const b: usize = @intCast(base);
                        std.debug.assert(sigma[b + action] >= 0);
                        child.pi1[h1] = here.pi1[h1] * sigma[b + action];
                    }
                    std.debug.assert(child.pi1[h1] >= 0);
                }
            }
            try self.responseWalk(w, node.child[action], turn, river, depth + 1, responding, sigma, serial_chance);
            // Unilateral BR only keeps the responding seat's action EVs.
            if (responding < 0 or responding == 0) {
                @memcpy(here.aev0[action * self.n0 ..][0..self.n0], child.ev0);
            }
            if (responding < 0 or responding == 1) {
                @memcpy(here.aev1[action * self.n1 ..][0..self.n1], child.ev1);
            }
        }

        self.ensureBoardSupport(w, turn, river);
        if (responding < 0 or responding == 0) {
            var h0: usize = 0;
            while (h0 < self.n0) : (h0 += 1) {
                if (!w.live0[h0]) {
                    here.ev0[h0] = 0;
                    continue;
                }
                if (node.player == 0 and responding == 0) {
                    var best: usize = 0;
                    action = 1;
                    while (action < n_act) : (action += 1) {
                        if (here.aev0[action * self.n0 + h0] > here.aev0[best * self.n0 + h0]) best = action;
                    }
                    here.ev0[h0] = here.aev0[best * self.n0 + h0];
                } else if (node.player == 0) {
                    const base = here.slot_base[h0];
                    if (base < 0) {
                        here.ev0[h0] = 0;
                        continue;
                    }
                    const b: usize = @intCast(base);
                    const row = sigma[b .. b + n_act];
                    var mix: f64 = 0;
                    action = 0;
                    while (action < n_act) : (action += 1) {
                        mix += row[action] * here.aev0[action * self.n0 + h0];
                    }
                    here.ev0[h0] = mix;
                } else if (responding == 1) {
                    here.ev0[h0] = 0;
                } else {
                    var mix: f64 = 0;
                    action = 0;
                    while (action < n_act) : (action += 1) {
                        mix += here.aev0[action * self.n0 + h0];
                    }
                    here.ev0[h0] = mix;
                }
            }
        } else {
            @memset(here.ev0, 0);
        }
        if (responding < 0 or responding == 1) {
            var h1: usize = 0;
            while (h1 < self.n1) : (h1 += 1) {
                if (!w.live1[h1]) {
                    here.ev1[h1] = 0;
                    continue;
                }
                if (node.player == 1 and responding == 1) {
                    var best: usize = 0;
                    action = 1;
                    while (action < n_act) : (action += 1) {
                        if (here.aev1[action * self.n1 + h1] > here.aev1[best * self.n1 + h1]) best = action;
                    }
                    here.ev1[h1] = here.aev1[best * self.n1 + h1];
                } else if (node.player == 1) {
                    const base = here.slot_base[h1];
                    if (base < 0) {
                        here.ev1[h1] = 0;
                        continue;
                    }
                    const b: usize = @intCast(base);
                    const row = sigma[b .. b + n_act];
                    var mix: f64 = 0;
                    action = 0;
                    while (action < n_act) : (action += 1) {
                        mix += row[action] * here.aev1[action * self.n1 + h1];
                    }
                    here.ev1[h1] = mix;
                } else if (responding == 0) {
                    here.ev1[h1] = 0;
                } else {
                    var mix: f64 = 0;
                    action = 0;
                    while (action < n_act) : (action += 1) {
                        mix += here.aev1[action * self.n1 + h1];
                    }
                    here.ev1[h1] = mix;
                }
            }
        } else {
            @memset(here.ev1, 0);
        }
    }

    fn sumScratch(values: []const f64) f64 {
        var total: f64 = 0;
        for (values) |v| total += v;
        return total;
    }

    pub fn prepareResponseRoot(_: *FrozenCtx, w: *WorkerLocal) void {
        @memset(w.scratch[0].pi0, 1.0);
        @memset(w.scratch[0].pi1, 1.0);
        w.resetSupport();
    }

    fn chanceDenom(self: *const FrozenCtx, turn: i32, river: i32) FrozenError!i32 {
        var denom: i32 = 52 - @as(i32, @intCast(self.game.board.len)) - 4;
        if (turn >= 0) denom -= 1;
        if (river >= 0) denom -= 1;
        if (denom <= 0) return error.InvalidFrozen;
        return denom;
    }

    fn collectActiveCards(
        self: *FrozenCtx,
        w: *WorkerLocal,
        node: compile.Node,
        turn: i32,
        river: i32,
        pi0: []const f64,
        pi1: []const f64,
        active_cards: *[52]i32,
    ) FrozenError!usize {
        var dead: [52]bool = .{false} ** 52;
        for (self.game.board) |c| dead[@intCast(c)] = true;
        if (turn >= 0) dead[@intCast(turn)] = true;
        if (river >= 0) dead[@intCast(river)] = true;
        var count: usize = 0;
        var c: i32 = 0;
        while (c < 52) : (c += 1) {
            if (dead[@intCast(c)]) continue;
            var next_turn = turn;
            var next_river = river;
            if (node.deal_which == 1) next_turn = c else next_river = c;
            if (!self.cardReachesPair(w, next_turn, next_river, pi0, pi1)) continue;
            active_cards[count] = c;
            count += 1;
        }
        return count;
    }

    fn reduceChildEv(
        self: *const FrozenCtx,
        here: *Scratch,
        active_cards: []const i32,
        probability: f64,
        needed_player: i32,
    ) void {
        const need0 = needed_player < 0 or needed_player == 0;
        const need1 = needed_player < 0 or needed_player == 1;
        for (active_cards) |dealt| {
            if (need0) {
                const ev0_at = @as(usize, @intCast(dealt)) * self.n0;
                var h0: usize = 0;
                while (h0 < self.n0) : (h0 += 1) {
                    here.ev0[h0] += probability * self.result0[ev0_at + h0];
                }
            }
            if (need1) {
                const ev1_at = @as(usize, @intCast(dealt)) * self.n1;
                var h1: usize = 0;
                while (h1 < self.n1) : (h1 += 1) {
                    here.ev1[h1] += probability * self.result1[ev1_at + h1];
                }
            }
        }
    }

    const ChanceJob = struct {
        engine: *FrozenCtx,
        next_index: *std.atomic.Value(usize),
        active_cards: []const i32,
        child_node: u32,
        turn: i32,
        river: i32,
        depth: usize,
        deal_which: i32,
        pi0: []const f64,
        pi1: []const f64,
        updating: i32,
        weight_iter: f64,
        responding: i32,
        sigma: []const f32,
        mode: enum { train, response },
        err_mu: *std.Thread.Mutex,
        first_err: *?FrozenError,
    };

    fn recordErr(job: *const ChanceJob, err: FrozenError) void {
        job.err_mu.lock();
        defer job.err_mu.unlock();
        if (job.first_err.* == null) job.first_err.* = err;
    }

    fn runChanceSteal(worker_index: usize, job: *const ChanceJob) void {
        const self = job.engine;
        const w = self.workerAt(worker_index);
        const child = &w.scratch[job.depth];
        while (true) {
            const index = job.next_index.fetchAdd(1, .monotonic);
            if (index >= job.active_cards.len) break;
            const dealt = job.active_cards[index];
            var next_turn = job.turn;
            var next_river = job.river;
            if (job.deal_which == 1) next_turn = dealt else next_river = dealt;
            self.ensureBoardSupport(w, next_turn, next_river);
            var h0: usize = 0;
            while (h0 < self.n0) : (h0 += 1) {
                child.pi0[h0] = if (w.live0[h0]) job.pi0[h0] else 0;
            }
            var h1: usize = 0;
            while (h1 < self.n1) : (h1 += 1) {
                child.pi1[h1] = if (w.live1[h1]) job.pi1[h1] else 0;
            }
            const walk_err = switch (job.mode) {
                .train => self.walk(w, job.child_node, next_turn, next_river, job.depth, job.updating, job.weight_iter, true),
                .response => self.responseWalk(w, job.child_node, next_turn, next_river, job.depth, job.responding, job.sigma, true),
            };
            walk_err catch |err| {
                recordErr(job, err);
                return;
            };
            const need0 = job.mode == .train or job.responding < 0 or job.responding == 0;
            const need1 = job.mode == .train or job.responding < 0 or job.responding == 1;
            if (need0) {
                const ev0_at = @as(usize, @intCast(dealt)) * self.n0;
                @memcpy(self.result0[ev0_at..][0..self.n0], child.ev0);
            }
            if (need1) {
                const ev1_at = @as(usize, @intCast(dealt)) * self.n1;
                @memcpy(self.result1[ev1_at..][0..self.n1], child.ev1);
            }
        }
    }

    fn ensureChancePool(self: *FrozenCtx) FrozenError!void {
        if (self.threads <= 1) return;
        if (self.pool_threads.len != 0) return;
        try self.startChancePool();
    }

    fn dispatchChanceWorkers(self: *FrozenCtx, job: *const ChanceJob) FrozenError!void {
        // Persistent pool: wake workers for this job (C++ dispatch_chance).
        // Lazy-start once FrozenCtx lives at a stable address (Session field or
        // caller's stack after by-value init return).
        if (self.threads <= 1) {
            runChanceSteal(0, job);
            if (job.first_err.*) |err| return err;
            return;
        }
        try self.ensureChancePool();
        {
            self.pool_mu.lock();
            defer self.pool_mu.unlock();
            self.pool_job = job;
            self.pool_finished = 0;
            self.pool_epoch += 1;
        }
        self.pool_work_cv.broadcast();

        runChanceSteal(0, job);

        {
            self.pool_mu.lock();
            defer self.pool_mu.unlock();
            while (self.pool_finished != self.threads - 1) {
                self.pool_done_cv.wait(&self.pool_mu);
            }
            self.pool_job = null;
        }
        if (job.first_err.*) |err| return err;
    }

    fn parallelChance(
        self: *FrozenCtx,
        w: *WorkerLocal,
        node: compile.Node,
        turn: i32,
        river: i32,
        depth: usize,
        updating: i32,
        weight_iter: f64,
    ) FrozenError!void {
        const here = &w.scratch[depth];
        @memset(here.ev0, 0);
        @memset(here.ev1, 0);
        const denom = try self.chanceDenom(turn, river);
        const probability = 1.0 / @as(f64, @floatFromInt(denom));
        var active_cards: [52]i32 = undefined;
        const active_count = try self.collectActiveCards(w, node, turn, river, here.pi0, here.pi1, &active_cards);
        if (active_count == 0) return;
        var next_index = std.atomic.Value(usize).init(0);
        var err_mu: std.Thread.Mutex = .{};
        var first_err: ?FrozenError = null;
        const job = ChanceJob{
            .engine = self,
            .next_index = &next_index,
            .active_cards = active_cards[0..active_count],
            .child_node = node.child[0],
            .turn = turn,
            .river = river,
            .depth = depth + 1,
            .deal_which = node.deal_which,
            .pi0 = here.pi0,
            .pi1 = here.pi1,
            .updating = updating,
            .weight_iter = weight_iter,
            .responding = -1,
            .sigma = &.{},
            .mode = .train,
            .err_mu = &err_mu,
            .first_err = &first_err,
        };
        try self.dispatchChanceWorkers(&job);
        // Reduce in ascending card order (parity with C++).
        var ordered: [52]i32 = undefined;
        var n_ord: usize = 0;
        var dealt_i: i32 = 0;
        while (dealt_i < 52) : (dealt_i += 1) {
            for (active_cards[0..active_count]) |a| {
                if (a == dealt_i) {
                    ordered[n_ord] = dealt_i;
                    n_ord += 1;
                    break;
                }
            }
        }
        self.reduceChildEv(here, ordered[0..n_ord], probability, -1);
    }

    fn parallelResponseChance(
        self: *FrozenCtx,
        w: *WorkerLocal,
        node: compile.Node,
        turn: i32,
        river: i32,
        depth: usize,
        responding: i32,
        sigma: []const f32,
    ) FrozenError!void {
        const here = &w.scratch[depth];
        @memset(here.ev0, 0);
        @memset(here.ev1, 0);
        const denom = try self.chanceDenom(turn, river);
        const probability = 1.0 / @as(f64, @floatFromInt(denom));
        var active_cards: [52]i32 = undefined;
        const active_count = try self.collectActiveCards(w, node, turn, river, here.pi0, here.pi1, &active_cards);
        if (active_count == 0) return;
        var next_index = std.atomic.Value(usize).init(0);
        var err_mu: std.Thread.Mutex = .{};
        var first_err: ?FrozenError = null;
        const job = ChanceJob{
            .engine = self,
            .next_index = &next_index,
            .active_cards = active_cards[0..active_count],
            .child_node = node.child[0],
            .turn = turn,
            .river = river,
            .depth = depth + 1,
            .deal_which = node.deal_which,
            .pi0 = here.pi0,
            .pi1 = here.pi1,
            .updating = -1,
            .weight_iter = 0,
            .responding = responding,
            .sigma = sigma,
            .mode = .response,
            .err_mu = &err_mu,
            .first_err = &first_err,
        };
        try self.dispatchChanceWorkers(&job);
        var ordered: [52]i32 = undefined;
        var n_ord: usize = 0;
        var dealt_i: i32 = 0;
        while (dealt_i < 52) : (dealt_i += 1) {
            for (active_cards[0..active_count]) |a| {
                if (a == dealt_i) {
                    ordered[n_ord] = dealt_i;
                    n_ord += 1;
                    break;
                }
            }
        }
        self.reduceChildEv(here, ordered[0..n_ord], probability, responding);
    }
};

/// CFR+ frozen schedule matching C++ train_frozen_cfr_plus_iterations.
/// Optional mid-train publish hook (Study live node-EV / R10).
/// Receives ownership of each completed-iteration `PublishedPolicy`.
pub const PublishHook = *const fn (*anyopaque, training_state.PublishedPolicy) anyerror!void;

/// Cooperative stop/pause check at a complete-iteration boundary (ZR-90).
/// Return true to leave the loop before starting the next iteration.
pub const StopHook = *const fn (*anyopaque) bool;

pub fn trainFrozenCfrPlus(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    state: *training_state.TrainingState,
    iterations: i32,
    locks: ?*const node_lock.LockSet,
) FrozenError!training_state.PublishedPolicy {
    return trainFrozenCfrPlusThreaded(allocator, game, state, iterations, 1, null, null, null, null, locks);
}

/// Train on a caller-owned ctx (Session-persistent ranks / scratch).
/// Ensures ranks once; does not create or destroy the ctx.
pub fn trainFrozenCfrPlusOnCtx(
    ctx: *FrozenCtx,
    state: *training_state.TrainingState,
    iterations: i32,
    publish_hook: ?PublishHook,
    publish_ctx: ?*anyopaque,
    stop_hook: ?StopHook,
    stop_ctx: ?*anyopaque,
) FrozenError!training_state.PublishedPolicy {
    if (iterations < 1) return error.InvalidFrozen;
    ctx.state = state;
    try ctx.ensureAllRanksReady();
    const game = ctx.game;
    const allocator = ctx.allocator;
    const w = &ctx.workspace;
    var published = training_state.PublishedPolicy{ .allocator = allocator };
    var step: i32 = 0;
    const slot_threads = ctx.threads;
    while (step < iterations) : (step += 1) {
        if (stop_hook) |hook| {
            const sctx = stop_ctx orelse return error.InvalidFrozen;
            if (hook(sctx)) break;
        }
        state.trained += 1;
        const weight_iter: f64 = @floatFromInt(state.trained);
        // PoolJob::Slots: static partition when threads > 1 (D3 worker budget).
        try training_state.freezeSigmaThreaded(allocator, game, state, slot_threads, ctx.locks);
        @memset(w.scratch[0].pi0, 1.0);
        @memset(w.scratch[0].pi1, 1.0);
        w.resetSupport();
        try ctx.walk(w, 0, -1, -1, 0, 0, weight_iter, false);
        try training_state.floorAndFreezeThreaded(allocator, game, state, 0, slot_threads, ctx.locks);
        @memset(w.scratch[0].pi0, 1.0);
        @memset(w.scratch[0].pi1, 1.0);
        w.resetSupport();
        try ctx.walk(w, 0, -1, -1, 0, 1, weight_iter, false);
        try training_state.floorPlayerThreaded(allocator, game, state, 1, slot_threads);
        const next = try training_state.publishAverageThreaded(allocator, game, state, slot_threads);
        if (publish_hook) |hook| {
            const hook_ctx = publish_ctx orelse return error.InvalidFrozen;
            const rev = next.revision;
            const trained = next.trained;
            // Hook takes ownership of `next` (Session install / reader-lease swap).
            hook(hook_ctx, next) catch return error.InvalidFrozen;
            // Return value carries revision/trained only when hooked (average lives in Session).
            if (published.average.len != 0) published.deinit();
            published = .{
                .allocator = allocator,
                .average = &.{},
                .revision = rev,
                .trained = trained,
            };
        } else {
            if (published.average.len != 0) published.deinit();
            published = next;
        }
    }
    return published;
}

pub fn trainFrozenCfrPlusThreaded(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    state: *training_state.TrainingState,
    iterations: i32,
    threads: u32,
    publish_hook: ?PublishHook,
    publish_ctx: ?*anyopaque,
    stop_hook: ?StopHook,
    stop_ctx: ?*anyopaque,
    locks: ?*const node_lock.LockSet,
) FrozenError!training_state.PublishedPolicy {
    if (iterations < 1) return error.InvalidFrozen;
    var ctx = try FrozenCtx.initThreaded(allocator, game, state, threads);
    defer ctx.deinit();
    ctx.locks = locks;
    return trainFrozenCfrPlusOnCtx(&ctx, state, iterations, publish_hook, publish_ctx, stop_hook, stop_ctx);
}

/// Evaluate on a caller-owned ctx (reuses Session ranks). Match C++ evaluate_profile.
pub fn evaluatePublishedFrozenOnCtx(
    ctx: *FrozenCtx,
    average: []const f32,
) FrozenError!FrozenEval {
    const game = ctx.game;
    const allocator = ctx.allocator;
    var owned: ?[]f32 = null;
    defer if (owned) |buf| allocator.free(buf);
    var sigma = average;
    if (average.len == 0) {
        var uniform = try training_state.TrainingState.init(allocator, game);
        defer uniform.deinit();
        owned = try allocator.dupe(f32, uniform.sigma);
        sigma = owned.?;
    } else if (average.len != @as(usize, @intCast(@max(game.table_entries, 0)))) {
        return error.InvalidFrozen;
    }

    try ctx.ensureAllRanksReady();
    const w = &ctx.workspace;

    ctx.prepareResponseRoot(w);
    try ctx.responseWalk(w, 0, -1, -1, 0, -1, sigma, false);
    const util0 = FrozenCtx.sumScratch(w.scratch[0].ev0);
    const util1 = FrozenCtx.sumScratch(w.scratch[0].ev1);

    ctx.prepareResponseRoot(w);
    try ctx.responseWalk(w, 0, -1, -1, 0, 0, sigma, false);
    const br_util0 = FrozenCtx.sumScratch(w.scratch[0].ev0);

    ctx.prepareResponseRoot(w);
    try ctx.responseWalk(w, 0, -1, -1, 0, 1, sigma, false);
    const br_util1 = FrozenCtx.sumScratch(w.scratch[0].ev1);

    const nash_gap = (br_util0 - util0) + (br_util1 - util1);
    return .{
        .u0 = util0,
        .u1 = util1,
        .br0 = br_util0,
        .br1 = br_util1,
        .nash_gap = nash_gap,
        .accuracy = 0.5 * nash_gap,
    };
}

/// Frozen evaluate_profile: on-path + unilateral BR → NashConv / Accuracy.
/// Matches C++ `StreetBatchSolver::Engine::evaluate_profile`.
pub fn evaluatePublishedFrozen(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    average: []const f32,
) FrozenError!FrozenEval {
    return evaluatePublishedFrozenThreaded(allocator, game, average, 1);
}

pub fn evaluatePublishedFrozenThreaded(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    average: []const f32,
    threads: u32,
) FrozenError!FrozenEval {
    var ctx = try FrozenCtx.initEvalThreaded(allocator, game, threads);
    defer ctx.deinit();
    return evaluatePublishedFrozenOnCtx(&ctx, average);
}

test "frozen river smoke trains" {
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
    var spec = try @import("../game/street_config.zig").parseStreetConfig(std.testing.allocator, text);
    defer spec.deinit();
    var game = try compile.compile(std.testing.allocator, spec);
    defer game.deinit();
    var state = try training_state.TrainingState.init(std.testing.allocator, game);
    defer state.deinit();
    var published = try trainFrozenCfrPlus(std.testing.allocator, game, &state, 5, null);
    defer published.deinit();
    try std.testing.expect(published.trained == 5);
    const eval = try evaluatePublishedFrozen(std.testing.allocator, game, published.average);
    try std.testing.expect(eval.nash_gap >= 0);
    try std.testing.expectApproxEqAbs(eval.accuracy, 0.5 * eval.nash_gap, 1e-12);

    // 4-thread path should match 1-thread even when chance steal is a no-op (river).
    var state4 = try training_state.TrainingState.init(std.testing.allocator, game);
    defer state4.deinit();
    var published4 = try trainFrozenCfrPlusThreaded(std.testing.allocator, game, &state4, 5, 4, null, null, null, null, null);
    defer published4.deinit();
    try std.testing.expectEqual(published.trained, published4.trained);
    const eval4 = try evaluatePublishedFrozenThreaded(std.testing.allocator, game, published4.average, 4);
    try std.testing.expectApproxEqAbs(eval.u0, eval4.u0, 1e-9);
    try std.testing.expectApproxEqAbs(eval.nash_gap, eval4.nash_gap, 1e-9);
}

test "frozen flop multithread matches serial" {
    const text =
        \\street-config 1
        \\board Ah Kd 7c
        \\pot 100
        \\stack 100
        \\oop-range QcQd:1
        \\ip-range JcJd:1
        \\first-to-act 0
        \\max-raises 0
        \\allow-all-in 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 1024
        \\threads 1
        \\
    ;
    var spec = try @import("../game/street_config.zig").parseStreetConfig(std.testing.allocator, text);
    defer spec.deinit();
    var game = try compile.compile(std.testing.allocator, spec);
    defer game.deinit();
    var state1 = try training_state.TrainingState.init(std.testing.allocator, game);
    defer state1.deinit();
    var pub1 = try trainFrozenCfrPlusThreaded(std.testing.allocator, game, &state1, 2, 1, null, null, null, null, null);
    defer pub1.deinit();
    var state4 = try training_state.TrainingState.init(std.testing.allocator, game);
    defer state4.deinit();
    var pub4 = try trainFrozenCfrPlusThreaded(std.testing.allocator, game, &state4, 2, 4, null, null, null, null, null);
    defer pub4.deinit();
    try std.testing.expectEqual(pub1.average.len, pub4.average.len);
    // Strict float parity after ordered EV reduce (C++ parallel_chance).
    for (pub1.average, pub4.average) |a, b| {
        try std.testing.expectApproxEqAbs(@as(f64, a), @as(f64, b), 1e-5);
    }
    const e1 = try evaluatePublishedFrozenThreaded(std.testing.allocator, game, pub1.average, 1);
    const e4 = try evaluatePublishedFrozenThreaded(std.testing.allocator, game, pub4.average, 4);
    try std.testing.expectApproxEqAbs(e1.u0, e4.u0, 1e-9);
    try std.testing.expectApproxEqAbs(e1.nash_gap, e4.nash_gap, 1e-9);
}

// Acc-stop / gate-bench calls train(1)+eval repeatedly; each call builds a fresh
// FrozenCtx and fills the runout rank cache under MT. By-value HashMap storage
// previously UAF'd when rehash invalidated `*const RunoutRanks` mid-showdown.
test "frozen flop multithread survives many train-eval cycles" {
    const text =
        \\street-config 1
        \\board Ah Kd 7c
        \\pot 100
        \\stack 100
        \\oop-range QcQd:1,JcJd:1
        \\ip-range TcTd:1,9c9d:1
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
        \\memory-mib 1024
        \\threads 1
        \\
    ;
    var spec = try @import("../game/street_config.zig").parseStreetConfig(std.testing.allocator, text);
    defer spec.deinit();
    var game = try compile.compile(std.testing.allocator, spec);
    defer game.deinit();
    var state = try training_state.TrainingState.init(std.testing.allocator, game);
    defer state.deinit();
    var last_acc: f64 = std.math.inf(f64);
    var cycle: i32 = 0;
    while (cycle < 40) : (cycle += 1) {
        var published = try trainFrozenCfrPlusThreaded(std.testing.allocator, game, &state, 1, 4, null, null, null, null, null);
        defer published.deinit();
        const eval = try evaluatePublishedFrozenThreaded(std.testing.allocator, game, published.average, 4);
        try std.testing.expect(eval.nash_gap >= 0);
        try std.testing.expectApproxEqAbs(eval.accuracy, 0.5 * eval.nash_gap, 1e-12);
        last_acc = eval.accuracy;
    }
    try std.testing.expect(state.trained == 40);
    try std.testing.expect(std.math.isFinite(last_acc));
}
