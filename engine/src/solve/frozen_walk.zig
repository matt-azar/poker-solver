//! StreetBatch-style frozen CFR+ walk (C++ frozen_walk).
//! First-future-card chance steal when threads > 1 (C++ parallel_chance); nested chance stays serial.
//! Replaces deal-by-deal chance expansion for flop/turn scale.
const std = @import("std");
const card = @import("../poker/card.zig");
const hand_eval = @import("../poker/hand_eval.zig");
const payoff = @import("../poker/payoff.zig");
const range_mod = @import("../poker/range.zig");
const compile = @import("../game/compile.zig");
const regret_matching = @import("regret_matching.zig");
const training_state = @import("training_state.zig");

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

const RunoutRanks = struct {
    rank0: []u32,
    rank1: []u32,

    fn deinit(self: *RunoutRanks, allocator: std.mem.Allocator) void {
        allocator.free(self.rank0);
        allocator.free(self.rank1);
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
    amount0: []f64,
    amount1: []f64,
    by_card0: [52]f64 = .{0} ** 52,
    by_card1: [52]f64 = .{0} ** 52,
    support_turn: i32 = -2,
    support_river: i32 = -2,
    scratch: [max_depth]Scratch = undefined,
    scratch_len: usize = 0,

    fn init(allocator: std.mem.Allocator, n0: usize, n1: usize) FrozenError!WorkerLocal {
        var w = WorkerLocal{
            .live0 = try allocator.alloc(bool, n0),
            .live1 = try allocator.alloc(bool, n1),
            .amount0 = try allocator.alloc(f64, n0),
            .amount1 = try allocator.alloc(f64, n1),
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
        allocator.free(self.amount0);
        allocator.free(self.amount1);
        self.* = undefined;
    }

    fn resetSupport(self: *WorkerLocal) void {
        self.support_turn = -2;
        self.support_river = -2;
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
    ranks: std.AutoHashMap(i32, RunoutRanks),
    ranks_mu: std.Thread.Mutex = .{},
    threads: u32 = 1,
    workspace: WorkerLocal = undefined,
    workspace_ready: bool = false,
    extras: []WorkerLocal = &.{},
    result0: []f64 = &.{},
    result1: []f64 = &.{},

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
            .ranks = std.AutoHashMap(i32, RunoutRanks).init(allocator),
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
        }
        return ctx;
    }

    pub fn deinit(self: *FrozenCtx) void {
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
            entry.value_ptr.deinit(self.allocator);
        }
        self.ranks.deinit();
        self.allocator.free(self.support0);
        self.allocator.free(self.support1);
        self.allocator.free(self.twin0);
        self.allocator.free(self.twin1);
        self.* = undefined;
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
        var h: usize = 0;
        while (h < self.n0) : (h += 1) {
            w.live0[h] = self.handSupported(0, h, turn, river);
        }
        h = 0;
        while (h < self.n1) : (h += 1) {
            w.live1[h] = self.handSupported(1, h, turn, river);
        }
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
            here.slot_base[hand] = self.game.slots[@intCast(index)].base;
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

    fn ensureRanks(self: *FrozenCtx, turn: i32, river: i32) FrozenError!*const RunoutRanks {
        const key = runoutKey(turn, river);
        self.ranks_mu.lock();
        defer self.ranks_mu.unlock();
        if (self.ranks.getPtr(key)) |existing| return existing;

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

        var table = RunoutRanks{
            .rank0 = try self.allocator.alloc(u32, self.n0),
            .rank1 = try self.allocator.alloc(u32, self.n1),
        };
        errdefer table.deinit(self.allocator);
        @memset(table.rank0, 0);
        @memset(table.rank1, 0);

        var cards: [7]card.Card = undefined;
        @memcpy(cards[2..7], board);
        var h0: usize = 0;
        while (h0 < self.n0) : (h0 += 1) {
            if (self.handBlocksBoard(0, h0, turn, river)) continue;
            cards[0] = self.game.hands.hole_low[0][h0];
            cards[1] = self.game.hands.hole_high[0][h0];
            const value = hand_eval.evaluate(cards[0..7]) catch continue;
            table.rank0[h0] = packRank(value);
        }
        var h1: usize = 0;
        while (h1 < self.n1) : (h1 += 1) {
            if (self.handBlocksBoard(1, h1, turn, river)) continue;
            cards[0] = self.game.hands.hole_low[1][h1];
            cards[1] = self.game.hands.hole_high[1][h1];
            const value = hand_eval.evaluate(cards[0..7]) catch continue;
            table.rank1[h1] = packRank(value);
        }

        try self.ranks.put(key, table);
        return self.ranks.getPtr(key).?;
    }

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
    ) FrozenError!void {
        self.ensureBoardSupport(w, turn, river);
        @memset(ev0, 0);
        @memset(ev1, 0);

        if (node.folded >= 0) {
            const total0 = self.collectReach(w, 0, pi0, w.amount0, &w.by_card0);
            const total1 = self.collectReach(w, 1, pi1, w.amount1, &w.by_card1);
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
            var h0: usize = 0;
            while (h0 < self.n0) : (h0 += 1) {
                if (!w.live0[h0]) continue;
                const open = total1 - self.blockedReach(0, h0, &w.by_card1, w.amount1);
                ev0[h0] = paid.utility[0] * self.game.hands.range_w[0][h0] * self.joint_scale * open;
            }
            var h1: usize = 0;
            while (h1 < self.n1) : (h1 += 1) {
                if (!w.live1[h1]) continue;
                const open = total0 - self.blockedReach(1, h1, &w.by_card0, w.amount0);
                ev1[h1] = paid.utility[1] * self.game.hands.range_w[1][h1] * self.joint_scale * open;
            }
            return;
        }

        // Five-card showdown: evaluate each hand once per runout, then O(n0·n1)
        // packed-rank compares (avoids re-running evaluate in the inner loop).
        const ranks = try self.ensureRanks(turn, river);
        _ = self.collectReach(w, 0, pi0, w.amount0, null);
        _ = self.collectReach(w, 1, pi1, w.amount1, null);

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

        var h0: usize = 0;
        while (h0 < self.n0) : (h0 += 1) {
            if (!w.live0[h0]) continue;
            const r0 = ranks.rank0[h0];
            const rw0 = self.game.hands.range_w[0][h0];
            var h1: usize = 0;
            while (h1 < self.n1) : (h1 += 1) {
                if (!w.live1[h1]) continue;
                if (self.handsBlock(h0, h1)) continue;
                const r1 = ranks.rank1[h1];
                const u = if (r0 > r1) win_u else if (r0 < r1) lose_u else tie_u;
                const rw1 = self.game.hands.range_w[1][h1];
                ev0[h0] += u[0] * rw0 * self.joint_scale * w.amount1[h1];
                ev1[h1] += u[1] * rw1 * self.joint_scale * w.amount0[h0];
            }
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
        const node = self.game.nodes[node_index];
        const here = &w.scratch[depth];

        if (node.kind == .terminal) {
            try self.applyTerminal(w, node, turn, river, here.pi0, here.pi1, here.ev0, here.ev1);
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
                    child.pi0[h0] = here.pi0[h0] * self.state.?.sigma[b + action];
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
                    child.pi1[h1] = here.pi1[h1] * self.state.?.sigma[b + action];
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
        const node = self.game.nodes[node_index];
        const here = &w.scratch[depth];

        if (node.kind == .terminal) {
            try self.applyTerminal(w, node, turn, river, here.pi0, here.pi1, here.ev0, here.ev1);
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
            @memcpy(here.ev0, child.ev0);
            @memcpy(here.ev1, child.ev1);
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
                        child.pi0[h0] = here.pi0[h0] * sigma[b + action];
                    }
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
                        child.pi1[h1] = here.pi1[h1] * sigma[b + action];
                    }
                }
            }
            try self.responseWalk(w, node.child[action], turn, river, depth + 1, responding, sigma, serial_chance);
            @memcpy(here.aev0[action * self.n0 ..][0..self.n0], child.ev0);
            @memcpy(here.aev1[action * self.n1 ..][0..self.n1], child.ev1);
        }

        self.ensureBoardSupport(w, turn, river);
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
    }

    fn sumScratch(values: []const f64) f64 {
        var total: f64 = 0;
        for (values) |v| total += v;
        return total;
    }

    fn prepareResponseRoot(_: *FrozenCtx, w: *WorkerLocal) void {
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
    ) void {
        for (active_cards) |dealt| {
            const ev0_at = @as(usize, @intCast(dealt)) * self.n0;
            const ev1_at = @as(usize, @intCast(dealt)) * self.n1;
            var h0: usize = 0;
            while (h0 < self.n0) : (h0 += 1) {
                here.ev0[h0] += probability * self.result0[ev0_at + h0];
            }
            var h1: usize = 0;
            while (h1 < self.n1) : (h1 += 1) {
                here.ev1[h1] += probability * self.result1[ev1_at + h1];
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
            const ev0_at = @as(usize, @intCast(dealt)) * self.n0;
            const ev1_at = @as(usize, @intCast(dealt)) * self.n1;
            @memcpy(self.result0[ev0_at..][0..self.n0], child.ev0);
            @memcpy(self.result1[ev1_at..][0..self.n1], child.ev1);
        }
    }

    fn dispatchChanceWorkers(self: *FrozenCtx, job: *const ChanceJob) FrozenError!void {
        const workers = self.threads;
        var threads = try self.allocator.alloc(std.Thread, workers - 1);
        defer self.allocator.free(threads);
        var spawned: usize = 0;
        errdefer {
            // Best-effort: join anything already started.
            var i: usize = 0;
            while (i < spawned) : (i += 1) threads[i].join();
        }
        while (spawned < workers - 1) : (spawned += 1) {
            const idx = spawned + 1;
            threads[spawned] = try std.Thread.spawn(.{}, runChanceSteal, .{ idx, job });
        }
        runChanceSteal(0, job);
        for (threads) |t| t.join();
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
        self.reduceChildEv(here, ordered[0..n_ord], probability);
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
        self.reduceChildEv(here, ordered[0..n_ord], probability);
    }
};

/// CFR+ frozen schedule matching C++ train_frozen_cfr_plus_iterations.
pub fn trainFrozenCfrPlus(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    state: *training_state.TrainingState,
    iterations: i32,
) FrozenError!training_state.PublishedPolicy {
    return trainFrozenCfrPlusThreaded(allocator, game, state, iterations, 1);
}

pub fn trainFrozenCfrPlusThreaded(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    state: *training_state.TrainingState,
    iterations: i32,
    threads: u32,
) FrozenError!training_state.PublishedPolicy {
    if (iterations < 1) return error.InvalidFrozen;
    var ctx = try FrozenCtx.initThreaded(allocator, game, state, threads);
    defer ctx.deinit();
    const w = &ctx.workspace;
    var published = training_state.PublishedPolicy{ .allocator = allocator };
    var step: i32 = 0;
    while (step < iterations) : (step += 1) {
        state.trained += 1;
        const weight_iter: f64 = @floatFromInt(state.trained);
        training_state.freezeSigma(game, state);
        @memset(w.scratch[0].pi0, 1.0);
        @memset(w.scratch[0].pi1, 1.0);
        w.resetSupport();
        try ctx.walk(w, 0, -1, -1, 0, 0, weight_iter, false);
        training_state.floorAndFreeze(game, state, 0);
        @memset(w.scratch[0].pi0, 1.0);
        @memset(w.scratch[0].pi1, 1.0);
        w.resetSupport();
        try ctx.walk(w, 0, -1, -1, 0, 1, weight_iter, false);
        training_state.floorPlayer(game, state, 1);
        if (published.average.len != 0) published.deinit();
        published = try training_state.publishAverage(allocator, game, state);
    }
    return published;
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

    var ctx = try FrozenCtx.initEvalThreaded(allocator, game, threads);
    defer ctx.deinit();
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
    var published = try trainFrozenCfrPlus(std.testing.allocator, game, &state, 5);
    defer published.deinit();
    try std.testing.expect(published.trained == 5);
    const eval = try evaluatePublishedFrozen(std.testing.allocator, game, published.average);
    try std.testing.expect(eval.nash_gap >= 0);
    try std.testing.expectApproxEqAbs(eval.accuracy, 0.5 * eval.nash_gap, 1e-12);

    // 4-thread path should match 1-thread even when chance steal is a no-op (river).
    var state4 = try training_state.TrainingState.init(std.testing.allocator, game);
    defer state4.deinit();
    var published4 = try trainFrozenCfrPlusThreaded(std.testing.allocator, game, &state4, 5, 4);
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
    var pub1 = try trainFrozenCfrPlusThreaded(std.testing.allocator, game, &state1, 2, 1);
    defer pub1.deinit();
    var state4 = try training_state.TrainingState.init(std.testing.allocator, game);
    defer state4.deinit();
    var pub4 = try trainFrozenCfrPlusThreaded(std.testing.allocator, game, &state4, 2, 4);
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
