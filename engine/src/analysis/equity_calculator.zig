//! Standalone multiway equity calculator (2–6 players).
//! Independent of Study node equity. Port of C++ `poker::holdem::calculate_equity`.
//! Equity = expected fractional pot ownership (k-way ties share 1/k).
const std = @import("std");
const card = @import("../poker/card.zig");
const range_mod = @import("../poker/range.zig");
const hand_eval = @import("../poker/hand_eval.zig");
const equity = @import("equity.zig");

pub const min_players: usize = 2;
pub const max_players: usize = 6;
pub const default_max_exact_deals: u64 = 5_000_000;
pub const auto_exact_threshold: u64 = 2_000_000;
pub const default_target_samples: u64 = 100_000;
pub const default_max_attempts: u64 = 5_000_000;
pub const model: []const u8 = "check-down";
pub const units: []const u8 = "fraction of the pot";
pub const method_version: []const u8 = "equity-calc-1";

pub const Method = enum {
    auto,
    exact,
    monte_carlo,

    pub fn name(self: Method) []const u8 {
        return switch (self) {
            .auto => "auto",
            .exact => "exact",
            .monte_carlo => "monte_carlo",
        };
    }

    pub fn parse(text: []const u8) CalcError!Method {
        if (std.ascii.eqlIgnoreCase(text, "auto")) return .auto;
        if (std.ascii.eqlIgnoreCase(text, "exact")) return .exact;
        if (std.mem.eql(u8, text, "monte_carlo") or std.mem.eql(u8, text, "monte-carlo") or
            std.ascii.eqlIgnoreCase(text, "MonteCarlo") or std.mem.eql(u8, text, "mc"))
            return .monte_carlo;
        return error.InvalidInput;
    }
};

pub const Failure = enum {
    invalid_input,
    invalid_weight,
    no_legal_joint,
    work_limit,
    sample_limit,
    cancelled,
    numerical_range,
};

pub const CalcError = error{
    InvalidInput,
    InvalidWeight,
    NoLegalJoint,
    WorkLimit,
    SampleLimit,
    Cancelled,
    NumericalRange,
    OutOfMemory,
};

pub const PlayerInput = struct {
    id: []const u8,
    range: range_mod.Range,
};

pub const Options = struct {
    method: Method = .auto,
    max_exact_deals: u64 = default_max_exact_deals,
    auto_exact_threshold: u64 = auto_exact_threshold,
    target_samples: u64 = default_target_samples,
    max_attempts: u64 = default_max_attempts,
    seed: u64 = 1,
    cancel_poll: ?*const fn (?*anyopaque) bool = null,
    cancel_context: ?*anyopaque = null,
    progress: ?*const fn (?*anyopaque, u64, u64) void = null,
    progress_context: ?*anyopaque = null,
};

pub const WorkEstimate = struct {
    legal_tuples: u64 = 0,
    completions_per_tuple: u64 = 0,
    exact_deals: u64 = 0,
    estimate_capped: bool = false,
};

pub const PlayerResult = struct {
    id: []const u8 = "",
    defined: bool = false,
    equity: f64 = 0,
    win: f64 = 0,
    tie: f64 = 0,
    loss: f64 = 0,
    equity_ci_low: f64 = std.math.nan(f64),
    equity_ci_high: f64 = std.math.nan(f64),
};

pub const Result = struct {
    allocator: std.mem.Allocator,
    joint_defined: bool = false,
    requested_method: Method = .auto,
    actual_method: Method = .exact,
    method_reason: []const u8 = "",
    exact_complete: bool = false,
    stopped: bool = false,
    work: WorkEstimate = .{},
    accepted_samples: u64 = 0,
    attempted_tuples: u64 = 0,
    seed: u64 = 0,
    method_version: []const u8 = method_version,
    elapsed_seconds: f64 = 0,
    players: []PlayerResult = &.{},
    owned_ids: bool = false,
    owned_reason: bool = false,

    pub fn deinit(self: *Result) void {
        if (self.owned_reason and self.method_reason.len != 0) {
            self.allocator.free(self.method_reason);
        }
        if (self.owned_ids) {
            for (self.players) |row| {
                if (row.id.len != 0) self.allocator.free(row.id);
            }
        }
        if (self.players.len != 0) self.allocator.free(self.players);
        self.* = .{ .allocator = self.allocator };
    }
};

const Accumulator = struct {
    sum: f64 = 0,
    compensation: f64 = 0,

    fn add(self: *Accumulator, amount: f64) void {
        const adjusted = amount - self.compensation;
        const next = self.sum + adjusted;
        self.compensation = (next - self.sum) - adjusted;
        self.sum = next;
    }

    fn total(self: Accumulator) f64 {
        return self.sum;
    }
};

const HandRef = struct {
    index: i32 = 0,
    card0: card.Card = 0,
    card1: card.Card = 0,
    weight: f64 = 0,
};

const PlayerHands = struct {
    id: []const u8,
    hands: []HandRef,
};

fn checkCancel(options: Options) CalcError!void {
    if (options.cancel_poll) |poll| {
        if (poll(options.cancel_context)) return error.Cancelled;
    }
}

fn reportProgress(options: Options, done: u64, total: u64) void {
    if (options.progress) |cb| cb(options.progress_context, done, total);
}

fn failMsg(comptime err: CalcError, _: []const u8) CalcError {
    return err;
}

fn validateBoardAndDead(board: []const card.Card, dead: []const card.Card) CalcError!void {
    const n = board.len;
    if (!(n == 0 or n == 3 or n == 4 or n == 5)) return error.InvalidInput;
    var seen: u64 = 0;
    for (board) |c| {
        if (!card.validCard(c)) return error.InvalidInput;
        const bit: u64 = @as(u64, 1) << @intCast(c);
        if ((seen & bit) != 0) return error.InvalidInput;
        seen |= bit;
    }
    for (dead) |c| {
        if (!card.validCard(c)) return error.InvalidInput;
        const bit: u64 = @as(u64, 1) << @intCast(c);
        if ((seen & bit) != 0) return error.InvalidInput;
        seen |= bit;
    }
}

fn validateWeights(range: range_mod.Range) CalcError!void {
    for (range.weights) |w| {
        if (!std.math.isFinite(w) or w < 0.0) return error.InvalidWeight;
    }
}

fn cardMask(cards: []const card.Card) u64 {
    var mask: u64 = 0;
    for (cards) |c| mask |= @as(u64, 1) << @intCast(c);
    return mask;
}

fn blockedBy(c0: card.Card, c1: card.Card, dead: u64) bool {
    const hand = (@as(u64, 1) << @intCast(c0)) | (@as(u64, 1) << @intCast(c1));
    return (hand & dead) != 0;
}

fn saturatingChoose(n: u64, k_in: u64) u64 {
    var k = k_in;
    if (k > n) return 0;
    if (k == 0 or k == n) return 1;
    if (k > n - k) k = n - k;
    var result: u64 = 1;
    var i: u64 = 1;
    while (i <= k) : (i += 1) {
        const numerator = n - k + i;
        const g = std.math.gcd(result, i);
        const reduced_result = result / g;
        const reduced_i = i / g;
        if (numerator > std.math.maxInt(u64) / reduced_result) return std.math.maxInt(u64);
        result = (reduced_result * numerator) / reduced_i;
    }
    return result;
}

fn saturatingMul(a: u64, b: u64) u64 {
    if (a == 0 or b == 0) return 0;
    if (a > std.math.maxInt(u64) / b) return std.math.maxInt(u64);
    return a * b;
}

fn completionsFor(board_count: usize, cards_removed: i32) u64 {
    const need: i32 = 5 - @as(i32, @intCast(board_count));
    if (need < 0) return 0;
    const remaining = 52 - cards_removed;
    if (remaining < need) return 0;
    return saturatingChoose(@intCast(remaining), @intCast(need));
}

fn collectHands(allocator: std.mem.Allocator, range: range_mod.Range, dead: u64) CalcError![]HandRef {
    var list = std.ArrayList(HandRef).init(allocator);
    errdefer list.deinit();
    var index: i32 = 0;
    while (index < card.combo_count) : (index += 1) {
        const weight = range.weights[@intCast(index)];
        if (!(weight > 0.0)) continue;
        const pair = range_mod.Range.comboCards(index) catch continue;
        if (blockedBy(pair[0], pair[1], dead)) continue;
        try list.append(.{
            .index = index,
            .card0 = pair[0],
            .card1 = pair[1],
            .weight = weight,
        });
    }
    return list.toOwnedSlice();
}

fn preparePlayers(
    allocator: std.mem.Allocator,
    players: []const PlayerInput,
    dead: u64,
) CalcError![]PlayerHands {
    if (players.len < min_players or players.len > max_players) return error.InvalidInput;
    var prepared = try allocator.alloc(PlayerHands, players.len);
    errdefer {
        for (prepared) |*row| {
            if (row.hands.len != 0) allocator.free(row.hands);
        }
        allocator.free(prepared);
    }
    for (players, 0..) |player, i| {
        if (player.id.len == 0) return error.InvalidInput;
        try validateWeights(player.range);
        prepared[i] = .{
            .id = player.id,
            .hands = try collectHands(allocator, player.range, dead),
        };
    }
    return prepared;
}

fn freePrepared(allocator: std.mem.Allocator, prepared: []PlayerHands) void {
    for (prepared) |row| {
        if (row.hands.len != 0) allocator.free(row.hands);
    }
    allocator.free(prepared);
}

fn sharesAny(c0: card.Card, c1: card.Card, used: u64) bool {
    return ((@as(u64, 1) << @intCast(c0)) & used) != 0 or ((@as(u64, 1) << @intCast(c1)) & used) != 0;
}

fn countLegalTuples(players: []const PlayerHands, limit: u64, capped: *bool) u64 {
    capped.* = false;
    const n = players.len;
    var count: u64 = 0;

    const Walk = struct {
        fn go(
            depth: usize,
            used: u64,
            pls: []const PlayerHands,
            lim: u64,
            cap: *bool,
            cnt: *u64,
        ) void {
            if (cap.*) return;
            if (depth == pls.len) {
                if (cnt.* == std.math.maxInt(u64)) {
                    cap.* = true;
                    return;
                }
                cnt.* += 1;
                if (cnt.* > lim) cap.* = true;
                return;
            }
            for (pls[depth].hands) |hand| {
                if (cap.*) return;
                if (sharesAny(hand.card0, hand.card1, used)) continue;
                const next = used | (@as(u64, 1) << @intCast(hand.card0)) | (@as(u64, 1) << @intCast(hand.card1));
                go(depth + 1, next, pls, lim, cap, cnt);
            }
        }
    };
    _ = n;
    Walk.go(0, 0, players, limit, capped, &count);
    return count;
}

fn assignShares(
    values: []const hand_eval.HandValue,
    equity_share: []f64,
    win_event: []f64,
    tie_event: []f64,
    loss_event: []f64,
) void {
    const n = values.len;
    var best: usize = 0;
    var i: usize = 1;
    while (i < n) : (i += 1) {
        if (hand_eval.compareValues(values[best], values[i]) < 0) best = i;
    }
    var winners: usize = 0;
    i = 0;
    while (i < n) : (i += 1) {
        if (values[i].eql(values[best])) winners += 1;
    }
    const share = 1.0 / @as(f64, @floatFromInt(winners));
    i = 0;
    while (i < n) : (i += 1) {
        if (values[i].eql(values[best])) {
            equity_share[i] = share;
            if (winners == 1) {
                win_event[i] = 1.0;
                tie_event[i] = 0.0;
            } else {
                win_event[i] = 0.0;
                tie_event[i] = 1.0;
            }
            loss_event[i] = 0.0;
        } else {
            equity_share[i] = 0.0;
            win_event[i] = 0.0;
            tie_event[i] = 0.0;
            loss_event[i] = 1.0;
        }
    }
}

fn evaluateDeal(
    hands: []const *const HandRef,
    full_board: []const card.Card,
    equity_share: []f64,
    win_event: []f64,
    tie_event: []f64,
    loss_event: []f64,
) CalcError!void {
    var values: [max_players]hand_eval.HandValue = undefined;
    var cards7: [7]card.Card = undefined;
    @memcpy(cards7[2..][0..5], full_board[0..5]);
    for (hands, 0..) |hand, i| {
        cards7[0] = hand.card0;
        cards7[1] = hand.card1;
        values[i] = hand_eval.evaluate(cards7[0..7]) catch return error.InvalidInput;
    }
    assignShares(values[0..hands.len], equity_share, win_event, tie_event, loss_event);
}

const ExactBins = struct {
    equity: Accumulator = .{},
    win: Accumulator = .{},
    tie: Accumulator = .{},
    loss: Accumulator = .{},
    mass: Accumulator = .{},
};

fn enumerateCompletions(
    board: []const card.Card,
    dead: u64,
    options: Options,
    scored: *u64,
    accept: *const fn ([]const card.Card) CalcError!void,
) CalcError!void {
    var full: [5]card.Card = undefined;
    const board_count = board.len;
    @memcpy(full[0..board_count], board);
    var available: [52]card.Card = undefined;
    var available_count: usize = 0;
    var c: i32 = 0;
    while (c < card.deck_size) : (c += 1) {
        if ((dead & (@as(u64, 1) << @intCast(c))) == 0) {
            available[available_count] = c;
            available_count += 1;
        }
    }
    const need: i32 = 5 - @as(i32, @intCast(board_count));
    if (need == 0) {
        try accept(full[0..5]);
        scored.* += 1;
        if (scored.* % 64 == 0) try checkCancel(options);
        return;
    }
    if (need == 1) {
        var i: usize = 0;
        while (i < available_count) : (i += 1) {
            full[4] = available[i];
            try accept(full[0..5]);
            scored.* += 1;
            if (scored.* % 64 == 0) try checkCancel(options);
        }
        return;
    }
    const Choose = struct {
        fn go(
            start: usize,
            depth: i32,
            need_n: i32,
            board_n: usize,
            avail: []const card.Card,
            avail_n: usize,
            full_board: *[5]card.Card,
            opts: Options,
            scored_ptr: *u64,
            accept_fn: *const fn ([]const card.Card) CalcError!void,
        ) CalcError!void {
            if (depth == need_n) {
                try accept_fn(full_board[0..5]);
                scored_ptr.* += 1;
                if (scored_ptr.* % 64 == 0) try checkCancel(opts);
                return;
            }
            var i = start;
            while (i <= avail_n - @as(usize, @intCast(need_n - depth))) : (i += 1) {
                full_board[board_n + @as(usize, @intCast(depth))] = avail[i];
                try go(i + 1, depth + 1, need_n, board_n, avail, avail_n, full_board, opts, scored_ptr, accept_fn);
            }
        }
    };
    try Choose.go(0, 0, need, board_count, available[0..available_count], available_count, &full, options, scored, accept);
}

fn emptyPlayers(allocator: std.mem.Allocator, players: []const PlayerHands) CalcError![]PlayerResult {
    const out = try allocator.alloc(PlayerResult, players.len);
    for (players, 0..) |p, i| {
        out[i] = .{ .id = try allocator.dupe(u8, p.id), .defined = false };
    }
    return out;
}

/// Exact accumulate context: evaluate one completed board into weighted bins.
const ExactDealCtx = struct {
    bins: []ExactBins,
    pick: []const *const HandRef,
    equity_share: []f64,
    win_event: []f64,
    tie_event: []f64,
    loss_event: []f64,
    deals_done: *u64,
    total: u64,
    options: Options,
    n: usize,
    weight: f64,

    fn accept(self: *@This(), full_board: []const card.Card) CalcError!void {
        try evaluateDeal(self.pick[0..self.n], full_board, self.equity_share, self.win_event, self.tie_event, self.loss_event);
        var i: usize = 0;
        while (i < self.n) : (i += 1) {
            self.bins[i].equity.add(self.weight * self.equity_share[i]);
            self.bins[i].win.add(self.weight * self.win_event[i]);
            self.bins[i].tie.add(self.weight * self.tie_event[i]);
            self.bins[i].loss.add(self.weight * self.loss_event[i]);
            self.bins[i].mass.add(self.weight);
        }
        reportProgress(self.options, self.deals_done.*, self.total);
    }
};

/// Fn-pointer trampoline for `enumerateCompletions` (cannot capture mutable ctx).
const ExactAcceptState = struct {
    var current: ?*ExactDealCtx = null;
    fn acceptFn(full_board: []const card.Card) CalcError!void {
        return current.?.accept(full_board);
    }
};

fn exactEnumerateAtPick(
    board_cards: []const card.Card,
    used: u64,
    opts: Options,
    deals: *u64,
    ctx: *ExactDealCtx,
) CalcError!void {
    ExactAcceptState.current = ctx;
    defer ExactAcceptState.current = null;
    try enumerateCompletions(board_cards, used, opts, deals, ExactAcceptState.acceptFn);
}

fn exactWalkHands(
    depth: usize,
    used: u64,
    weight: f64,
    pls: []const PlayerHands,
    board_cards: []const card.Card,
    opts: Options,
    bins_ptr: []ExactBins,
    pick_buf: *[max_players]*const HandRef,
    eq: *[max_players]f64,
    wn: *[max_players]f64,
    ti: *[max_players]f64,
    ls: *[max_players]f64,
    deals: *u64,
    tot: u64,
) CalcError!void {
    try checkCancel(opts);
    if (depth == pls.len) {
        var ctx = ExactDealCtx{
            .bins = bins_ptr,
            .pick = pick_buf[0..pls.len],
            .equity_share = eq[0..pls.len],
            .win_event = wn[0..pls.len],
            .tie_event = ti[0..pls.len],
            .loss_event = ls[0..pls.len],
            .deals_done = deals,
            .total = tot,
            .options = opts,
            .n = pls.len,
            .weight = weight,
        };
        try exactEnumerateAtPick(board_cards, used, opts, deals, &ctx);
        return;
    }
    for (pls[depth].hands) |*hand| {
        if (sharesAny(hand.card0, hand.card1, used)) continue;
        pick_buf[depth] = hand;
        const next = used | (@as(u64, 1) << @intCast(hand.card0)) | (@as(u64, 1) << @intCast(hand.card1));
        const next_weight = weight * hand.weight;
        if (!std.math.isFinite(next_weight) or next_weight < 0.0) return error.NumericalRange;
        if (!(next_weight > 0.0)) continue;
        try exactWalkHands(depth + 1, next, next_weight, pls, board_cards, opts, bins_ptr, pick_buf, eq, wn, ti, ls, deals, tot);
    }
}

fn finishExactResult(
    allocator: std.mem.Allocator,
    players: []const PlayerHands,
    bins: []const ExactBins,
    work: WorkEstimate,
    requested: Method,
    options: Options,
) CalcError!Result {
    const n = players.len;
    var result = Result{ .allocator = allocator, .owned_ids = true };
    errdefer result.deinit();
    result.requested_method = requested;
    result.actual_method = .exact;
    result.method_reason = "exact enumeration completed";
    result.exact_complete = true;
    result.work = work;
    result.seed = options.seed;

    const mass = if (n > 0) bins[0].mass.total() else 0.0;
    if (!(mass > 0.0) or !std.math.isFinite(mass)) {
        result.joint_defined = false;
        result.players = try emptyPlayers(allocator, players);
        return result;
    }

    result.joint_defined = true;
    result.players = try allocator.alloc(PlayerResult, n);
    for (players, 0..) |p, i| {
        const eq = bins[i].equity.total() / mass;
        const wn = bins[i].win.total() / mass;
        const ti = bins[i].tie.total() / mass;
        const ls = bins[i].loss.total() / mass;
        if (!std.math.isFinite(eq) or !std.math.isFinite(wn) or !std.math.isFinite(ti) or !std.math.isFinite(ls))
            return error.NumericalRange;
        result.players[i] = .{
            .id = try allocator.dupe(u8, p.id),
            .defined = true,
            .equity = eq,
            .win = wn,
            .tie = ti,
            .loss = ls,
        };
    }
    return result;
}

fn runExact(
    allocator: std.mem.Allocator,
    players: []const PlayerHands,
    board: []const card.Card,
    known_dead: u64,
    options: Options,
    work: WorkEstimate,
    requested: Method,
) CalcError!Result {
    if (work.exact_deals > options.max_exact_deals or work.estimate_capped) return error.WorkLimit;

    const n = players.len;
    const bins = try allocator.alloc(ExactBins, n);
    defer allocator.free(bins);
    @memset(bins, .{});

    var pick: [max_players]*const HandRef = undefined;
    var equity_share: [max_players]f64 = undefined;
    var win_event: [max_players]f64 = undefined;
    var tie_event: [max_players]f64 = undefined;
    var loss_event: [max_players]f64 = undefined;
    var deals_done: u64 = 0;

    try exactWalkHands(
        0,
        known_dead,
        1.0,
        players,
        board,
        options,
        bins,
        &pick,
        &equity_share,
        &win_event,
        &tie_event,
        &loss_event,
        &deals_done,
        work.exact_deals,
    );

    return finishExactResult(allocator, players, bins, work, requested, options);
}

const SplitMix64 = struct {
    state: u64,

    fn next(self: *SplitMix64) u64 {
        self.state +%= 0x9e3779b97f4a7c15;
        var z = self.state;
        z = (z ^ (z >> 30)) *% 0xbf58476d1ce4e5b9;
        z = (z ^ (z >> 27)) *% 0x94d049bb133111eb;
        return z ^ (z >> 31);
    }

    fn uniform(self: *SplitMix64) f64 {
        return @as(f64, @floatFromInt(self.next() >> 11)) * (1.0 / 9007199254740992.0);
    }

    fn uniformInt(self: *SplitMix64, n: i32) i32 {
        if (n <= 0) return 0;
        return @intCast(self.next() % @as(u64, @intCast(n)));
    }
};

const WeightedSampler = struct {
    hands: []*const HandRef,
    cumulative: []f64,
    total: f64,

    fn init(allocator: std.mem.Allocator, source: []const HandRef) CalcError!WeightedSampler {
        var hands = try allocator.alloc(*const HandRef, source.len);
        errdefer allocator.free(hands);
        var cumulative = try allocator.alloc(f64, source.len);
        errdefer allocator.free(cumulative);
        var total: f64 = 0;
        var count: usize = 0;
        for (source) |*hand| {
            if (!(hand.weight > 0.0)) continue;
            total += hand.weight;
            hands[count] = hand;
            cumulative[count] = total;
            count += 1;
        }
        return .{
            .hands = try allocator.realloc(hands, count),
            .cumulative = try allocator.realloc(cumulative, count),
            .total = total,
        };
    }

    fn deinit(self: *WeightedSampler, allocator: std.mem.Allocator) void {
        if (self.hands.len != 0) allocator.free(self.hands);
        if (self.cumulative.len != 0) allocator.free(self.cumulative);
        self.* = .{ .hands = &.{}, .cumulative = &.{}, .total = 0 };
    }

    fn sample(self: WeightedSampler, rng: *SplitMix64) ?*const HandRef {
        if (self.hands.len == 0 or !(self.total > 0.0)) return null;
        const draw = rng.uniform() * self.total;
        var lo: usize = 0;
        var hi: usize = self.cumulative.len;
        while (lo < hi) {
            const mid = lo + (hi - lo) / 2;
            if (self.cumulative[mid] < draw) lo = mid + 1 else hi = mid;
        }
        const index = @min(lo, self.hands.len - 1);
        return self.hands[index];
    }
};

/// Sample one conflict-free hole-card tuple and a random board completion.
/// Returns false when a sampled hand collides with used cards.
fn sampleMonteCarloDeal(
    samplers: []const WeightedSampler,
    board: []const card.Card,
    known_dead: u64,
    rng: *SplitMix64,
    pick: *[max_players]*const HandRef,
    full: *[5]card.Card,
) bool {
    const n = samplers.len;
    var used = known_dead;
    var i: usize = 0;
    while (i < n) : (i += 1) {
        const hand = samplers[i].sample(rng);
        if (hand == null or sharesAny(hand.?.card0, hand.?.card1, used)) return false;
        pick[i] = hand.?;
        used |= (@as(u64, 1) << @intCast(hand.?.card0)) | (@as(u64, 1) << @intCast(hand.?.card1));
    }

    const board_count = board.len;
    @memcpy(full[0..board_count], board);
    var available: [52]card.Card = undefined;
    var available_count: usize = 0;
    var c: i32 = 0;
    while (c < card.deck_size) : (c += 1) {
        if ((used & (@as(u64, 1) << @intCast(c))) == 0) {
            available[available_count] = c;
            available_count += 1;
        }
    }
    const need: i32 = 5 - @as(i32, @intCast(board_count));
    var j: i32 = 0;
    while (j < need) : (j += 1) {
        const pick_i = rng.uniformInt(@intCast(available_count - @as(usize, @intCast(j))));
        const chosen = available[@intCast(pick_i)];
        available[@intCast(pick_i)] = available[available_count - 1 - @as(usize, @intCast(j))];
        full[board_count + @as(usize, @intCast(j))] = chosen;
    }
    return true;
}

fn accumulateMonteCarloDeal(
    n: usize,
    pick: []const *const HandRef,
    full_board: []const card.Card,
    equity_share: []f64,
    win_event: []f64,
    tie_event: []f64,
    loss_event: []f64,
    equity_sum: *[max_players]Accumulator,
    win_sum: *[max_players]Accumulator,
    tie_sum: *[max_players]Accumulator,
    loss_sum: *[max_players]Accumulator,
    equity_sq: *[max_players]Accumulator,
) CalcError!void {
    try evaluateDeal(pick[0..n], full_board, equity_share[0..n], win_event[0..n], tie_event[0..n], loss_event[0..n]);
    var i: usize = 0;
    while (i < n) : (i += 1) {
        equity_sum[i].add(equity_share[i]);
        win_sum[i].add(win_event[i]);
        tie_sum[i].add(tie_event[i]);
        loss_sum[i].add(loss_event[i]);
        equity_sq[i].add(equity_share[i] * equity_share[i]);
    }
}

fn finishMonteCarloResult(
    allocator: std.mem.Allocator,
    players: []const PlayerHands,
    requested: Method,
    reason: []const u8,
    work: WorkEstimate,
    options: Options,
    accepted: u64,
    attempted: u64,
    stopped: bool,
    equity_sum: *const [max_players]Accumulator,
    win_sum: *const [max_players]Accumulator,
    tie_sum: *const [max_players]Accumulator,
    loss_sum: *const [max_players]Accumulator,
    equity_sq: *const [max_players]Accumulator,
) CalcError!Result {
    const n = players.len;
    var result = Result{
        .allocator = allocator,
        .requested_method = requested,
        .actual_method = .monte_carlo,
        .method_reason = reason,
        .exact_complete = false,
        .stopped = stopped,
        .work = work,
        .accepted_samples = accepted,
        .attempted_tuples = attempted,
        .seed = options.seed,
        .owned_ids = true,
    };
    errdefer result.deinit();

    if (accepted == 0) {
        if (attempted >= options.max_attempts) return error.SampleLimit;
        result.joint_defined = false;
        result.players = try emptyPlayers(allocator, players);
        return result;
    }

    result.joint_defined = true;
    result.players = try allocator.alloc(PlayerResult, n);
    const samples: f64 = @floatFromInt(accepted);
    const z: f64 = 1.959963984540054;
    var i: usize = 0;
    while (i < n) : (i += 1) {
        const eq = equity_sum[i].total() / samples;
        const mean_sq = equity_sq[i].total() / samples;
        const variance = @max(0.0, mean_sq - eq * eq);
        const se = @sqrt(variance / samples);
        result.players[i] = .{
            .id = try allocator.dupe(u8, players[i].id),
            .defined = true,
            .equity = eq,
            .win = win_sum[i].total() / samples,
            .tie = tie_sum[i].total() / samples,
            .loss = loss_sum[i].total() / samples,
            .equity_ci_low = std.math.clamp(eq - z * se, 0.0, 1.0),
            .equity_ci_high = std.math.clamp(eq + z * se, 0.0, 1.0),
        };
    }
    return result;
}

fn runMonteCarlo(
    allocator: std.mem.Allocator,
    players: []const PlayerHands,
    board: []const card.Card,
    known_dead: u64,
    options: Options,
    work: WorkEstimate,
    requested: Method,
    reason: []const u8,
    allow_partial_stop: bool,
) CalcError!Result {
    const n = players.len;
    var samplers = try allocator.alloc(WeightedSampler, n);
    defer {
        for (samplers) |*s| s.deinit(allocator);
        allocator.free(samplers);
    }
    for (players, 0..) |player, i| {
        samplers[i] = try WeightedSampler.init(allocator, player.hands);
        if (samplers[i].hands.len == 0) {
            var empty = Result{
                .allocator = allocator,
                .requested_method = requested,
                .actual_method = .monte_carlo,
                .method_reason = reason,
                .work = work,
                .seed = options.seed,
                .joint_defined = false,
                .owned_ids = true,
            };
            empty.players = try emptyPlayers(allocator, players);
            return empty;
        }
    }

    var rng = SplitMix64{ .state = options.seed };
    var pick: [max_players]*const HandRef = undefined;
    var equity_share: [max_players]f64 = undefined;
    var win_event: [max_players]f64 = undefined;
    var tie_event: [max_players]f64 = undefined;
    var loss_event: [max_players]f64 = undefined;
    var equity_sum: [max_players]Accumulator = [_]Accumulator{.{}} ** max_players;
    var win_sum: [max_players]Accumulator = [_]Accumulator{.{}} ** max_players;
    var tie_sum: [max_players]Accumulator = [_]Accumulator{.{}} ** max_players;
    var loss_sum: [max_players]Accumulator = [_]Accumulator{.{}} ** max_players;
    var equity_sq: [max_players]Accumulator = [_]Accumulator{.{}} ** max_players;
    var full: [5]card.Card = undefined;

    var accepted: u64 = 0;
    var attempted: u64 = 0;
    var stopped = false;

    while (accepted < options.target_samples and attempted < options.max_attempts) {
        if (options.cancel_poll) |poll| {
            if (poll(options.cancel_context)) {
                if (allow_partial_stop and accepted > 0) {
                    stopped = true;
                    break;
                }
                return error.Cancelled;
            }
        }

        attempted += 1;
        if (!sampleMonteCarloDeal(samplers, board, known_dead, &rng, &pick, &full)) continue;
        try accumulateMonteCarloDeal(
            n,
            pick[0..n],
            full[0..5],
            equity_share[0..n],
            win_event[0..n],
            tie_event[0..n],
            loss_event[0..n],
            &equity_sum,
            &win_sum,
            &tie_sum,
            &loss_sum,
            &equity_sq,
        );
        accepted += 1;
        if (accepted % 256 == 0) reportProgress(options, accepted, options.target_samples);
    }

    return finishMonteCarloResult(
        allocator,
        players,
        requested,
        reason,
        work,
        options,
        accepted,
        attempted,
        stopped,
        &equity_sum,
        &win_sum,
        &tie_sum,
        &loss_sum,
        &equity_sq,
    );
}

fn tryHuPostflopFastPath(
    allocator: std.mem.Allocator,
    inputs: []const PlayerInput,
    board: []const card.Card,
    dead: []const card.Card,
    options: Options,
) CalcError!?Result {
    if (inputs.len != 2 or board.len < 3 or board.len > 5 or dead.len != 0) return null;
    var eq = equity.showdownEquity(allocator, board, inputs[0].range, inputs[1].range, options.max_exact_deals) catch |err| {
        return switch (err) {
            error.WorkLimit => null,
            error.InvalidWeight => error.InvalidWeight,
            error.InvalidEquity => error.InvalidInput,
            error.OutOfMemory => error.OutOfMemory,
        };
    };
    defer eq.deinit();

    var out = Result{
        .allocator = allocator,
        .requested_method = options.method,
        .actual_method = .exact,
        .method_reason = "exact heads-up postflop fast path",
        .exact_complete = true,
        .joint_defined = eq.joint_defined,
        .work = .{
            .legal_tuples = 0,
            .completions_per_tuple = 0,
            .exact_deals = eq.pair_runouts,
            .estimate_capped = false,
        },
        .seed = options.seed,
        .owned_ids = true,
    };
    errdefer out.deinit();
    out.players = try allocator.alloc(PlayerResult, 2);
    out.players[0] = .{
        .id = try allocator.dupe(u8, inputs[0].id),
        .defined = eq.player0.defined,
        .equity = eq.player0.equity,
        .win = eq.player0.win,
        .tie = eq.player0.tie,
        .loss = eq.player0.loss,
    };
    out.players[1] = .{
        .id = try allocator.dupe(u8, inputs[1].id),
        .defined = eq.player1.defined,
        .equity = eq.player1.equity,
        .win = eq.player1.win,
        .tie = eq.player1.tie,
        .loss = eq.player1.loss,
    };
    return out;
}

pub fn estimateWork(
    allocator: std.mem.Allocator,
    players: []const PlayerInput,
    board: []const card.Card,
    dead_cards: []const card.Card,
) CalcError!WorkEstimate {
    try validateBoardAndDead(board, dead_cards);
    const dead = cardMask(board) | cardMask(dead_cards);
    const prepared = try preparePlayers(allocator, players, dead);
    defer freePrepared(allocator, prepared);
    const hole_cards: i32 = @intCast(prepared.len * 2);
    const removed = hole_cards + @as(i32, @intCast(board.len)) + @as(i32, @intCast(dead_cards.len));
    var work = WorkEstimate{
        .completions_per_tuple = completionsFor(board.len, removed),
    };
    var capped = false;
    work.legal_tuples = countLegalTuples(prepared, 2_000_000, &capped);
    work.estimate_capped = capped;
    work.exact_deals = if (capped) std.math.maxInt(u64) else saturatingMul(work.legal_tuples, work.completions_per_tuple);
    return work;
}

pub fn calculateEquity(
    allocator: std.mem.Allocator,
    players: []const PlayerInput,
    board: []const card.Card,
    dead_cards: []const card.Card,
    options: Options,
) CalcError!Result {
    const started = std.time.nanoTimestamp();
    try validateBoardAndDead(board, dead_cards);
    const dead = cardMask(board) | cardMask(dead_cards);
    const prepared = try preparePlayers(allocator, players, dead);
    defer freePrepared(allocator, prepared);
    try checkCancel(options);

    const work = try estimateWork(allocator, players, board, dead_cards);

    var actual = options.method;
    var reason: []const u8 = undefined;
    if (options.method == .auto) {
        if (!work.estimate_capped and work.exact_deals <= options.auto_exact_threshold and work.exact_deals <= options.max_exact_deals) {
            actual = .exact;
            reason = "auto selected exact (work estimate within threshold)";
        } else {
            actual = .monte_carlo;
            reason = "auto selected monte_carlo (work estimate above exact threshold)";
        }
    } else if (options.method == .exact) {
        actual = .exact;
        reason = "exact requested";
    } else {
        actual = .monte_carlo;
        reason = "monte_carlo requested";
    }

    if (actual == .exact) {
        if (try tryHuPostflopFastPath(allocator, players, board, dead_cards, options)) |fast| {
            var result = fast;
            const ended = std.time.nanoTimestamp();
            result.elapsed_seconds = @as(f64, @floatFromInt(ended - started)) / 1e9;
            result.requested_method = options.method;
            result.method_reason = reason;
            return result;
        }
    }

    var result = if (actual == .exact)
        try runExact(allocator, prepared, board, dead, options, work, options.method)
    else
        try runMonteCarlo(
            allocator,
            prepared,
            board,
            dead,
            options,
            work,
            options.method,
            reason,
            options.method != .exact,
        );
    const ended = std.time.nanoTimestamp();
    result.elapsed_seconds = @as(f64, @floatFromInt(ended - started)) / 1e9;
    result.method_version = method_version;
    if (actual == .exact) result.method_reason = reason;
    return result;
}

pub fn parseCards(allocator: std.mem.Allocator, text: []const u8) CalcError![]card.Card {
    var list = std.ArrayList(card.Card).init(allocator);
    errdefer list.deinit();
    var cursor: usize = 0;
    while (cursor < text.len) {
        while (cursor < text.len and (text[cursor] == ' ' or text[cursor] == ',' or text[cursor] == '\t')) : (cursor += 1) {}
        if (cursor >= text.len) break;
        var end = cursor;
        while (end < text.len and text[end] != ' ' and text[end] != ',' and text[end] != '\t') : (end += 1) {}
        const c = card.parseCard(text[cursor..end]) catch return error.InvalidInput;
        try list.append(c);
        cursor = end;
    }
    return list.toOwnedSlice();
}

fn failureName(_: Failure) []const u8 {
    return "failed";
}

test "river certainty" {
    const board = try parseCards(std.testing.allocator, "2c 3d 7h 9s Jc");
    defer std.testing.allocator.free(board);
    const players = [_]PlayerInput{
        .{ .id = "a", .range = try range_mod.Range.parse("AsAd") },
        .{ .id = "b", .range = try range_mod.Range.parse("KcKd") },
    };
    var result = try calculateEquity(std.testing.allocator, &players, board, &.{}, .{ .method = .exact });
    defer result.deinit();
    try std.testing.expect(result.joint_defined and result.exact_complete);
    try std.testing.expectApproxEqAbs(@as(f64, 1.0), result.players[0].equity, 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, 0.0), result.players[1].equity, 1e-12);
}

test "royal flush three-way tie" {
    const board = try parseCards(std.testing.allocator, "As Ks Qs Js Ts");
    defer std.testing.allocator.free(board);
    const players = [_]PlayerInput{
        .{ .id = "a", .range = try range_mod.Range.parse("2c2d") },
        .{ .id = "b", .range = try range_mod.Range.parse("3c3d") },
        .{ .id = "c", .range = try range_mod.Range.parse("4c4d") },
    };
    var result = try calculateEquity(std.testing.allocator, &players, board, &.{}, .{ .method = .exact });
    defer result.deinit();
    try std.testing.expect(result.joint_defined);
    try std.testing.expectApproxEqAbs(1.0 / 3.0, result.players[0].equity, 1e-12);
    try std.testing.expectApproxEqAbs(1.0 / 3.0, result.players[1].equity, 1e-12);
    try std.testing.expectApproxEqAbs(1.0 / 3.0, result.players[2].equity, 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, 1.0), result.players[0].tie, 1e-12);
}

test "monte carlo river seed stable" {
    const board = try parseCards(std.testing.allocator, "2c 3d 7h 9s Jc");
    defer std.testing.allocator.free(board);
    const players = [_]PlayerInput{
        .{ .id = "a", .range = try range_mod.Range.parse("AsAd,KsKd") },
        .{ .id = "b", .range = try range_mod.Range.parse("QsQd,JsJd") },
    };
    var a = try calculateEquity(std.testing.allocator, &players, board, &.{}, .{
        .method = .monte_carlo,
        .target_samples = 2_000,
        .seed = 42,
    });
    defer a.deinit();
    var b = try calculateEquity(std.testing.allocator, &players, board, &.{}, .{
        .method = .monte_carlo,
        .target_samples = 2_000,
        .seed = 42,
    });
    defer b.deinit();
    try std.testing.expect(a.joint_defined and b.joint_defined);
    try std.testing.expectApproxEqAbs(a.players[0].equity, b.players[0].equity, 1e-15);
}
