//! Single-thread StreetBatch-style frozen CFR+ walk (C++ frozen_walk).
//! Replaces deal-by-deal chance expansion for flop/turn scale.
const std = @import("std");
const card = @import("../poker/card.zig");
const hand_eval = @import("../poker/hand_eval.zig");
const payoff = @import("../poker/payoff.zig");
const range_mod = @import("../poker/range.zig");
const compile = @import("../game/compile.zig");
const regret_matching = @import("regret_matching.zig");
const training_state = @import("training_state.zig");

pub const FrozenError = error{ InvalidFrozen, OutOfMemory } || hand_eval.EvalError || payoff.PayoffError || training_state.TrainError;

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
    live0: []bool,
    live1: []bool,
    /// Opponent hand with the same combo, or -1 (C++ twin_hand).
    twin0: []i32,
    twin1: []i32,
    amount0: []f64,
    amount1: []f64,
    by_card0: [52]f64 = .{0} ** 52,
    by_card1: [52]f64 = .{0} ** 52,
    support_turn: i32 = -2,
    support_river: i32 = -2,
    ranks: std.AutoHashMap(i32, RunoutRanks),
    scratch: [max_depth]Scratch = undefined,
    scratch_len: usize = 0,

    pub fn init(allocator: std.mem.Allocator, game: compile.CompiledGame, state: *training_state.TrainingState) FrozenError!FrozenCtx {
        return initCommon(allocator, game, state);
    }

    pub fn initEval(allocator: std.mem.Allocator, game: compile.CompiledGame) FrozenError!FrozenCtx {
        return initCommon(allocator, game, null);
    }

    fn initCommon(allocator: std.mem.Allocator, game: compile.CompiledGame, state: ?*training_state.TrainingState) FrozenError!FrozenCtx {
        const n0: usize = @intCast(game.hands.nHands(0));
        const n1: usize = @intCast(game.hands.nHands(1));
        if (n0 == 0 or n1 == 0) return error.InvalidFrozen;
        if (game.hands.joint_mass <= 0) return error.InvalidFrozen;
        var ctx = FrozenCtx{
            .allocator = allocator,
            .game = game,
            .state = state,
            .n0 = n0,
            .n1 = n1,
            .joint_scale = 1.0 / game.hands.joint_mass,
            .support0 = try allocator.alloc(HandSupport, n0),
            .support1 = try allocator.alloc(HandSupport, n1),
            .live0 = try allocator.alloc(bool, n0),
            .live1 = try allocator.alloc(bool, n1),
            .twin0 = try allocator.alloc(i32, n0),
            .twin1 = try allocator.alloc(i32, n1),
            .amount0 = try allocator.alloc(f64, n0),
            .amount1 = try allocator.alloc(f64, n1),
            .ranks = std.AutoHashMap(i32, RunoutRanks).init(allocator),
        };
        errdefer ctx.deinit();
        @memset(ctx.support0, .{});
        @memset(ctx.support1, .{});
        try ctx.buildSupport();
        try ctx.buildTwins();
        @memset(ctx.live0, true);
        @memset(ctx.live1, true);
        var d: usize = 0;
        while (d < max_depth) : (d += 1) {
            ctx.scratch[d] = .{
                .pi0 = try allocator.alloc(f64, n0),
                .pi1 = try allocator.alloc(f64, n1),
                .ev0 = try allocator.alloc(f64, n0),
                .ev1 = try allocator.alloc(f64, n1),
                .aev0 = try allocator.alloc(f64, max_actions * n0),
                .aev1 = try allocator.alloc(f64, max_actions * n1),
                .slot_base = try allocator.alloc(i32, @max(n0, n1)),
            };
            ctx.scratch_len = d + 1;
        }
        return ctx;
    }
    pub fn deinit(self: *FrozenCtx) void {
        var d: usize = 0;
        while (d < self.scratch_len) : (d += 1) {
            self.scratch[d].deinit(self.allocator);
        }
        var it = self.ranks.iterator();
        while (it.next()) |entry| {
            entry.value_ptr.deinit(self.allocator);
        }
        self.ranks.deinit();
        self.allocator.free(self.support0);
        self.allocator.free(self.support1);
        self.allocator.free(self.live0);
        self.allocator.free(self.live1);
        self.allocator.free(self.twin0);
        self.allocator.free(self.twin1);
        self.allocator.free(self.amount0);
        self.allocator.free(self.amount1);
        self.* = undefined;
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

    fn ensureBoardSupport(self: *FrozenCtx, turn: i32, river: i32) void {
        if (self.support_turn == turn and self.support_river == river) return;
        var h: usize = 0;
        while (h < self.n0) : (h += 1) {
            self.live0[h] = self.handSupported(0, h, turn, river);
        }
        h = 0;
        while (h < self.n1) : (h += 1) {
            self.live1[h] = self.handSupported(1, h, turn, river);
        }
        self.support_turn = turn;
        self.support_river = river;
    }

    fn cardReachesPair(self: *FrozenCtx, turn: i32, river: i32, pi0: []const f64, pi1: []const f64) bool {
        self.ensureBoardSupport(turn, river);
        var h: usize = 0;
        while (h < self.n0) : (h += 1) {
            if (pi0[h] > 0 and self.live0[h]) return true;
        }
        h = 0;
        while (h < self.n1) : (h += 1) {
            if (pi1[h] > 0 and self.live1[h]) return true;
        }
        return false;
    }
    fn fillActorSlotBases(self: *FrozenCtx, here: *Scratch, node: compile.Node, turn: i32, river: i32) FrozenError!void {
        const player: usize = @intCast(node.player);
        const hands = if (player == 0) self.n0 else self.n1;
        const live = if (player == 0) self.live0 else self.live1;
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
        player: usize,
        pi: []const f64,
        amount: []f64,
        by_card: ?*[52]f64,
    ) f64 {
        const hands = if (player == 0) self.n0 else self.n1;
        const live = if (player == 0) self.live0 else self.live1;
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
        node: compile.Node,
        turn: i32,
        river: i32,
        pi0: []const f64,
        pi1: []const f64,
        ev0: []f64,
        ev1: []f64,
    ) FrozenError!void {
        self.ensureBoardSupport(turn, river);
        @memset(ev0, 0);
        @memset(ev1, 0);

        if (node.folded >= 0) {
            const total0 = self.collectReach(0, pi0, self.amount0, &self.by_card0);
            const total1 = self.collectReach(1, pi1, self.amount1, &self.by_card1);
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
                if (!self.live0[h0]) continue;
                const open = total1 - self.blockedReach(0, h0, &self.by_card1, self.amount1);
                ev0[h0] = paid.utility[0] * self.game.hands.range_w[0][h0] * self.joint_scale * open;
            }
            var h1: usize = 0;
            while (h1 < self.n1) : (h1 += 1) {
                if (!self.live1[h1]) continue;
                const open = total0 - self.blockedReach(1, h1, &self.by_card0, self.amount0);
                ev1[h1] = paid.utility[1] * self.game.hands.range_w[1][h1] * self.joint_scale * open;
            }
            return;
        }

        // Five-card showdown: evaluate each hand once per runout, then O(n0·n1)
        // packed-rank compares (avoids re-running evaluate in the inner loop).
        const ranks = try self.ensureRanks(turn, river);
        _ = self.collectReach(0, pi0, self.amount0, null);
        _ = self.collectReach(1, pi1, self.amount1, null);

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
            if (!self.live0[h0]) continue;
            const r0 = ranks.rank0[h0];
            const rw0 = self.game.hands.range_w[0][h0];
            var h1: usize = 0;
            while (h1 < self.n1) : (h1 += 1) {
                if (!self.live1[h1]) continue;
                if (self.handsBlock(h0, h1)) continue;
                const r1 = ranks.rank1[h1];
                const u = if (r0 > r1) win_u else if (r0 < r1) lose_u else tie_u;
                const rw1 = self.game.hands.range_w[1][h1];
                ev0[h0] += u[0] * rw0 * self.joint_scale * self.amount1[h1];
                ev1[h1] += u[1] * rw1 * self.joint_scale * self.amount0[h0];
            }
        }
    }
    pub fn walk(
        self: *FrozenCtx,
        node_index: u32,
        turn: i32,
        river: i32,
        depth: usize,
        updating: i32,
        weight_iter: f64,
    ) FrozenError!void {
        if (depth >= max_depth) return error.InvalidFrozen;
        const node = self.game.nodes[node_index];
        const here = &self.scratch[depth];

        if (node.kind == .terminal) {
            try self.applyTerminal(node, turn, river, here.pi0, here.pi1, here.ev0, here.ev1);
            return;
        }

        if (node.kind == .chance) {
            @memset(here.ev0, 0);
            @memset(here.ev1, 0);
            var dead: [52]bool = .{false} ** 52;
            for (self.game.board) |c| dead[@intCast(c)] = true;
            if (turn >= 0) dead[@intCast(turn)] = true;
            if (river >= 0) dead[@intCast(river)] = true;
            // Mark holes? Chance doesn't know deals — denom is board-only like C++.
            // Match C++: 52 - board - 4 hole cards, then minus dealt turn/river.
            var denom: i32 = 52 - @as(i32, @intCast(self.game.board.len)) - 4;
            if (turn >= 0) denom -= 1;
            if (river >= 0) denom -= 1;
            if (denom <= 0) return error.InvalidFrozen;
            const probability = 1.0 / @as(f64, @floatFromInt(denom));
            const child = &self.scratch[depth + 1];
            var c: i32 = 0;
            while (c < 52) : (c += 1) {
                if (dead[@intCast(c)]) continue;
                var next_turn = turn;
                var next_river = river;
                if (node.deal_which == 1) next_turn = c else next_river = c;
                if (!self.cardReachesPair(next_turn, next_river, here.pi0, here.pi1)) continue;
                var h0: usize = 0;
                while (h0 < self.n0) : (h0 += 1) {
                    child.pi0[h0] = if (self.live0[h0]) here.pi0[h0] else 0;
                }
                var h1: usize = 0;
                while (h1 < self.n1) : (h1 += 1) {
                    child.pi1[h1] = if (self.live1[h1]) here.pi1[h1] else 0;
                }
                try self.walk(node.child[0], next_turn, next_river, depth + 1, updating, weight_iter);
                h0 = 0;
                while (h0 < self.n0) : (h0 += 1) here.ev0[h0] += probability * child.ev0[h0];
                h1 = 0;
                while (h1 < self.n1) : (h1 += 1) here.ev1[h1] += probability * child.ev1[h1];
            }
            return;
        }

        self.ensureBoardSupport(turn, river);
        const child = &self.scratch[depth + 1];
        if (node.n_actions <= 1) {
            if (node.player == 0) {
                var h0: usize = 0;
                while (h0 < self.n0) : (h0 += 1) {
                    child.pi0[h0] = if (self.live0[h0]) here.pi0[h0] else 0;
                }
                @memcpy(child.pi1, here.pi1);
            } else {
                @memcpy(child.pi0, here.pi0);
                var h1: usize = 0;
                while (h1 < self.n1) : (h1 += 1) {
                    child.pi1[h1] = if (self.live1[h1]) here.pi1[h1] else 0;
                }
            }
            try self.walk(node.child[0], turn, river, depth + 1, updating, weight_iter);
            self.ensureBoardSupport(turn, river);
            @memcpy(here.ev0, child.ev0);
            @memcpy(here.ev1, child.ev1);
            var z0: usize = 0;
            while (z0 < self.n0) : (z0 += 1) {
                if (!self.live0[z0]) here.ev0[z0] = 0;
            }
            var z1: usize = 0;
            while (z1 < self.n1) : (z1 += 1) {
                if (!self.live1[z1]) here.ev1[z1] = 0;
            }
            return;
        }

        if (node.n_actions > max_actions) return error.InvalidFrozen;
        try self.fillActorSlotBases(here, node, turn, river);
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
            try self.walk(node.child[action], turn, river, depth + 1, updating, weight_iter);
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

        self.ensureBoardSupport(turn, river);
        if (node.player == 0) {
            var h0: usize = 0;
            while (h0 < self.n0) : (h0 += 1) {
                if (!self.live0[h0]) {
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
                if (!self.live1[h1]) here.ev1[h1] = 0;
            }
        } else {
            var h0: usize = 0;
            while (h0 < self.n0) : (h0 += 1) {
                if (!self.live0[h0]) here.ev0[h0] = 0;
            }
            var h1: usize = 0;
            while (h1 < self.n1) : (h1 += 1) {
                if (!self.live1[h1]) {
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
        node_index: u32,
        turn: i32,
        river: i32,
        depth: usize,
        responding: i32,
        sigma: []const f32,
    ) FrozenError!void {
        if (depth >= max_depth) return error.InvalidFrozen;
        const node = self.game.nodes[node_index];
        const here = &self.scratch[depth];

        if (node.kind == .terminal) {
            try self.applyTerminal(node, turn, river, here.pi0, here.pi1, here.ev0, here.ev1);
            return;
        }

        if (node.kind == .chance) {
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
            const child = &self.scratch[depth + 1];
            var c: i32 = 0;
            while (c < 52) : (c += 1) {
                if (dead[@intCast(c)]) continue;
                var next_turn = turn;
                var next_river = river;
                if (node.deal_which == 1) next_turn = c else next_river = c;
                if (!self.cardReachesPair(next_turn, next_river, here.pi0, here.pi1)) continue;
                var h0: usize = 0;
                while (h0 < self.n0) : (h0 += 1) {
                    child.pi0[h0] = if (self.live0[h0]) here.pi0[h0] else 0;
                }
                var h1: usize = 0;
                while (h1 < self.n1) : (h1 += 1) {
                    child.pi1[h1] = if (self.live1[h1]) here.pi1[h1] else 0;
                }
                try self.responseWalk(node.child[0], next_turn, next_river, depth + 1, responding, sigma);
                h0 = 0;
                while (h0 < self.n0) : (h0 += 1) here.ev0[h0] += probability * child.ev0[h0];
                h1 = 0;
                while (h1 < self.n1) : (h1 += 1) here.ev1[h1] += probability * child.ev1[h1];
            }
            return;
        }

        self.ensureBoardSupport(turn, river);
        const child = &self.scratch[depth + 1];
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
            try self.responseWalk(node.child[0], turn, river, depth + 1, responding, sigma);
            @memcpy(here.ev0, child.ev0);
            @memcpy(here.ev1, child.ev1);
            return;
        }

        if (node.n_actions > max_actions) return error.InvalidFrozen;
        try self.fillActorSlotBases(here, node, turn, river);
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
            try self.responseWalk(node.child[action], turn, river, depth + 1, responding, sigma);
            @memcpy(here.aev0[action * self.n0 ..][0..self.n0], child.ev0);
            @memcpy(here.aev1[action * self.n1 ..][0..self.n1], child.ev1);
        }

        self.ensureBoardSupport(turn, river);
        var h0: usize = 0;
        while (h0 < self.n0) : (h0 += 1) {
            if (!self.live0[h0]) {
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
            if (!self.live1[h1]) {
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

    pub fn prepareResponseRoot(self: *FrozenCtx) void {
        @memset(self.scratch[0].pi0, 1.0);
        @memset(self.scratch[0].pi1, 1.0);
        self.support_turn = -2;
    }
};
/// CFR+ frozen schedule matching C++ train_frozen_cfr_plus_iterations.
pub fn trainFrozenCfrPlus(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    state: *training_state.TrainingState,
    iterations: i32,
) FrozenError!training_state.PublishedPolicy {
    if (iterations < 1) return error.InvalidFrozen;
    var ctx = try FrozenCtx.init(allocator, game, state);
    defer ctx.deinit();
    var published = training_state.PublishedPolicy{ .allocator = allocator };
    var step: i32 = 0;
    while (step < iterations) : (step += 1) {
        state.trained += 1;
        const weight_iter: f64 = @floatFromInt(state.trained);
        training_state.freezeSigma(game, state);
        @memset(ctx.scratch[0].pi0, 1.0);
        @memset(ctx.scratch[0].pi1, 1.0);
        ctx.support_turn = -2;
        try ctx.walk(0, -1, -1, 0, 0, weight_iter);
        training_state.floorAndFreeze(game, state, 0);
        @memset(ctx.scratch[0].pi0, 1.0);
        @memset(ctx.scratch[0].pi1, 1.0);
        ctx.support_turn = -2;
        try ctx.walk(0, -1, -1, 0, 1, weight_iter);
        training_state.floorPlayer(game, state, 1);
        if (published.average.len != 0) published.deinit();
        published = try training_state.publishAverage(allocator, game, state);
    }
    return published;
}

/// Frozen evaluate_profile: on-path + unilateral BR → NashConv / Accuracy.
/// Matches C++ `StreetBatchSolver::Engine::evaluate_profile` (single-thread).
pub fn evaluatePublishedFrozen(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    average: []const f32,
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

    var ctx = try FrozenCtx.initEval(allocator, game);
    defer ctx.deinit();

    ctx.prepareResponseRoot();
    try ctx.responseWalk(0, -1, -1, 0, -1, sigma);
    const util0 = FrozenCtx.sumScratch(ctx.scratch[0].ev0);
    const util1 = FrozenCtx.sumScratch(ctx.scratch[0].ev1);

    ctx.prepareResponseRoot();
    try ctx.responseWalk(0, -1, -1, 0, 0, sigma);
    const br_util0 = FrozenCtx.sumScratch(ctx.scratch[0].ev0);

    ctx.prepareResponseRoot();
    try ctx.responseWalk(0, -1, -1, 0, 1, sigma);
    const br_util1 = FrozenCtx.sumScratch(ctx.scratch[0].ev1);

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
}
