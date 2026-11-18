const std = @import("std");
const chips = @import("chips.zig");
const payoff = @import("payoff.zig");

pub const IcmError = error{InvalidIcm};

pub const IcmConfig = struct {
    stacks: []const f64 = &.{},
    payouts: []const f64 = &.{},

    pub fn enabled(self: IcmConfig) bool {
        return self.stacks.len != 0;
    }

    pub fn validate(self: IcmConfig, pot: chips.Chip, effective_stack: chips.Chip) IcmError!void {
        if (!self.enabled()) return;
        if (self.stacks.len < 2) return error.InvalidIcm;
        // Solve configs must list only the remaining field (all stacks > 0) with
        // prizes for that field. Already-out seats must not appear as zeros —
        // seat-order bust assignment would steal their finishing place.
        try validateStartingStacks(self.stacks, self.payouts);
        if (pot < 0 or effective_stack < 0) return error.InvalidIcm;
        const need = 0.5 * chips.tenthsToChips(pot) + chips.tenthsToChips(effective_stack);
        if (self.stacks[0] < need or self.stacks[1] < need) return error.InvalidIcm;
    }
};

/// Nonnegative stacks/payouts for equity evaluation (post-hand zeros allowed).
pub fn validateInputs(stacks: []const f64, payouts: []const f64) IcmError!void {
    if (stacks.len == 0) return error.InvalidIcm;
    var total: f64 = 0;
    for (stacks) |s| {
        if (!(s >= 0.0) or !std.math.isFinite(s)) return error.InvalidIcm;
        total += s;
    }
    if (!(total > 0.0)) return error.InvalidIcm;
    for (payouts) |prize| {
        if (!(prize >= 0.0) or !std.math.isFinite(prize)) return error.InvalidIcm;
    }
}

/// Starting ICM for a solve: every seat still in must have a positive stack.
pub fn validateStartingStacks(stacks: []const f64, payouts: []const f64) IcmError!void {
    try validateInputs(stacks, payouts);
    for (stacks) |s| {
        if (!(s > 0.0)) return error.InvalidIcm;
    }
}

fn icmRecurse(
    stacks: []f64,
    alive: usize,
    payouts: []const f64,
    place: usize,
    weight: f64,
    equities: []f64,
) void {
    if (!(weight > 0.0) or alive == 0) return;
    var total: f64 = 0;
    for (stacks) |s| total += s;
    if (!(total > 0.0)) return;

    if (alive == 1) {
        var remaining: f64 = 0;
        var k = place;
        while (k < payouts.len) : (k += 1) remaining += payouts[k];
        if (remaining == 0.0) return;
        for (stacks, 0..) |s, i| {
            if (s > 0.0) {
                equities[i] += weight * remaining;
                return;
            }
        }
        return;
    }

    const prize: f64 = if (place < payouts.len) payouts[place] else 0.0;
    for (stacks, 0..) |s, i| {
        if (!(s > 0.0)) continue;
        const p_first = s / total;
        if (prize != 0.0) equities[i] += weight * p_first * prize;
        stacks[i] = 0.0;
        icmRecurse(stacks, alive - 1, payouts, place + 1, weight * p_first, equities);
        stacks[i] = s;
    }
}

/// Soft cap for stack-buffer ICM (final tables / satellite fields). Larger
/// tables fall back to the allocator path in `icmEquities` / `applyIcmTerminal`.
pub const max_stack_seats: usize = 16;

/// Zero seats in a post-hand stack vector busted on this hand and take places
/// from the bottom (last remaining prize). Starting solve configs must not
/// include already-out zeros — use `validateStartingStacks` / remaining-field
/// payouts instead. Contested places among positive stacks are
/// `payouts[0..contested_end)`.
fn icmEquitiesInto(stacks: []const f64, payouts: []const f64, work: []f64, equities: []f64) IcmError!void {
    try validateInputs(stacks, payouts);
    const n = stacks.len;
    if (work.len < n or equities.len < n) return error.InvalidIcm;
    @memcpy(work[0..n], stacks);
    @memset(equities[0..n], 0);
    var contested_end: usize = n;
    var alive: usize = 0;
    for (work[0..n], 0..) |s, i| {
        if (s > 0.0) {
            alive += 1;
        } else {
            // Assign the next worst place (from the end of the seat list).
            contested_end -= 1;
            if (contested_end < payouts.len) {
                equities[i] += payouts[contested_end];
            }
        }
    }
    if (alive == 0) return;
    const contested = if (contested_end <= payouts.len) payouts[0..contested_end] else payouts;
    icmRecurse(work[0..n], alive, contested, 0, 1.0, equities[0..n]);
}

pub fn icmEquities(allocator: std.mem.Allocator, stacks: []const f64, payouts: []const f64) IcmError![]f64 {
    try validateInputs(stacks, payouts);
    if (stacks.len <= max_stack_seats) {
        var work_buf: [max_stack_seats]f64 = undefined;
        var eq_buf: [max_stack_seats]f64 = undefined;
        try icmEquitiesInto(stacks, payouts, work_buf[0..stacks.len], eq_buf[0..stacks.len]);
        const equities = allocator.alloc(f64, stacks.len) catch return error.InvalidIcm;
        @memcpy(equities, eq_buf[0..stacks.len]);
        return equities;
    }
    const work = allocator.alloc(f64, stacks.len) catch return error.InvalidIcm;
    defer allocator.free(work);
    const equities = allocator.alloc(f64, stacks.len) catch return error.InvalidIcm;
    try icmEquitiesInto(stacks, payouts, work, equities);
    return equities;
}

fn applyIcmTerminalWithPre(
    allocator: std.mem.Allocator,
    icm: IcmConfig,
    pre_eq: []const f64,
    chip_terminal: payoff.PlayerPayoff,
) IcmError!payoff.PlayerPayoff {
    if (!icm.enabled()) return chip_terminal;
    if (icm.stacks.len < 2 or pre_eq.len != icm.stacks.len) return error.InvalidIcm;
    try validateStartingStacks(icm.stacks, icm.payouts);
    if (!std.math.isFinite(chip_terminal.utility[0]) or !std.math.isFinite(chip_terminal.utility[1])) {
        return error.InvalidIcm;
    }

    if (icm.stacks.len <= max_stack_seats) {
        var post_buf: [max_stack_seats]f64 = undefined;
        var work_buf: [max_stack_seats]f64 = undefined;
        var post_eq_buf: [max_stack_seats]f64 = undefined;
        const n = icm.stacks.len;
        @memcpy(post_buf[0..n], icm.stacks);
        post_buf[0] += chip_terminal.utility[0];
        post_buf[1] += chip_terminal.utility[1];
        if (!(post_buf[0] >= 0.0) or !(post_buf[1] >= 0.0)) return error.InvalidIcm;

        var post_total: f64 = 0;
        for (post_buf[0..n]) |s| post_total += s;
        if (post_total > 0.0) {
            try icmEquitiesInto(post_buf[0..n], icm.payouts, work_buf[0..n], post_eq_buf[0..n]);
        } else {
            @memset(post_eq_buf[0..n], 0);
        }
        return .{
            .utility = .{
                post_eq_buf[0] - pre_eq[0],
                post_eq_buf[1] - pre_eq[1],
            },
        };
    }

    var post = allocator.dupe(f64, icm.stacks) catch return error.InvalidIcm;
    defer allocator.free(post);
    post[0] += chip_terminal.utility[0];
    post[1] += chip_terminal.utility[1];
    if (!(post[0] >= 0.0) or !(post[1] >= 0.0)) return error.InvalidIcm;

    var post_total: f64 = 0;
    for (post) |s| post_total += s;

    var post_eq: []f64 = undefined;
    if (post_total > 0.0) {
        post_eq = try icmEquities(allocator, post, icm.payouts);
    } else {
        post_eq = allocator.alloc(f64, icm.stacks.len) catch return error.InvalidIcm;
        @memset(post_eq, 0);
    }
    defer allocator.free(post_eq);

    return .{
        .utility = .{
            post_eq[0] - pre_eq[0],
            post_eq[1] - pre_eq[1],
        },
    };
}

/// Chip → ICM delta for seats 0/1. Allocation-free when `stacks.len <= max_stack_seats`
/// (production frozen CFR+ path); allocator only for oversized tables.
pub fn applyIcmTerminal(
    allocator: std.mem.Allocator,
    icm: IcmConfig,
    chip_terminal: payoff.PlayerPayoff,
) IcmError!payoff.PlayerPayoff {
    if (!icm.enabled()) return chip_terminal;
    if (icm.stacks.len < 2) return error.InvalidIcm;
    try validateStartingStacks(icm.stacks, icm.payouts);
    if (!std.math.isFinite(chip_terminal.utility[0]) or !std.math.isFinite(chip_terminal.utility[1])) {
        return error.InvalidIcm;
    }

    if (icm.stacks.len <= max_stack_seats) {
        var work_buf: [max_stack_seats]f64 = undefined;
        var pre_buf: [max_stack_seats]f64 = undefined;
        const n = icm.stacks.len;
        try icmEquitiesInto(icm.stacks, icm.payouts, work_buf[0..n], pre_buf[0..n]);
        return applyIcmTerminalWithPre(allocator, icm, pre_buf[0..n], chip_terminal);
    }

    const pre_eq = try icmEquities(allocator, icm.stacks, icm.payouts);
    defer allocator.free(pre_eq);
    return applyIcmTerminalWithPre(allocator, icm, pre_eq, chip_terminal);
}

/// Pre-hand equity once + distinct chip-terminal → ICM deltas for the frozen walk.
/// Keys are exact chip utilities (bit pattern); warm all tree terminals before train.
pub const TerminalCache = struct {
    allocator: std.mem.Allocator = undefined,
    cfg: IcmConfig = .{},
    pre_eq: []f64 = &.{},
    map: std.AutoHashMap(u128, payoff.PlayerPayoff) = undefined,
    active: bool = false,
    /// Distinct post-equity computations (misses). Hits reuse `map`.
    miss_count: usize = 0,

    fn packKey(util0: f64, util1: f64) u128 {
        const a: u64 = @bitCast(util0);
        const b: u64 = @bitCast(util1);
        return (@as(u128, a) << 64) | b;
    }

    pub fn init(allocator: std.mem.Allocator, cfg: IcmConfig) IcmError!TerminalCache {
        if (!cfg.enabled()) return .{};
        if (cfg.stacks.len < 2) return error.InvalidIcm;
        try validateStartingStacks(cfg.stacks, cfg.payouts);
        const pre = try icmEquities(allocator, cfg.stacks, cfg.payouts);
        errdefer allocator.free(pre);
        var map = std.AutoHashMap(u128, payoff.PlayerPayoff).init(allocator);
        errdefer map.deinit();
        return .{
            .allocator = allocator,
            .cfg = cfg,
            .pre_eq = pre,
            .map = map,
            .active = true,
        };
    }

    pub fn deinit(self: *TerminalCache) void {
        if (!self.active) return;
        self.map.deinit();
        if (self.pre_eq.len != 0) self.allocator.free(self.pre_eq);
        self.* = .{};
    }

    /// Warm / single-threaded insert path.
    pub fn apply(self: *TerminalCache, chip_terminal: payoff.PlayerPayoff) IcmError!payoff.PlayerPayoff {
        if (!self.active) return chip_terminal;
        const key = packKey(chip_terminal.utility[0], chip_terminal.utility[1]);
        if (self.map.get(key)) |cached| return cached;
        const paid = try applyIcmTerminalWithPre(self.allocator, self.cfg, self.pre_eq, chip_terminal);
        self.map.put(key, paid) catch return error.InvalidIcm;
        self.miss_count += 1;
        return paid;
    }

    /// Read-only lookup for the MT walk after `warmIcmTerminalCache`.
    pub fn get(self: *const TerminalCache, chip_terminal: payoff.PlayerPayoff) ?payoff.PlayerPayoff {
        if (!self.active) return null;
        return self.map.get(packKey(chip_terminal.utility[0], chip_terminal.utility[1]));
    }

    /// Hit the cache, or compute with pre-equity without mutating the shared map.
    pub fn getOrCompute(self: *const TerminalCache, chip_terminal: payoff.PlayerPayoff) IcmError!payoff.PlayerPayoff {
        if (!self.active) return chip_terminal;
        if (self.get(chip_terminal)) |cached| return cached;
        return applyIcmTerminalWithPre(self.allocator, self.cfg, self.pre_eq, chip_terminal);
    }
};

test "icm two-player bubble" {
    const stacks = [_]f64{ 1000, 1000 };
    const payouts = [_]f64{ 70, 30 };
    const eq = try icmEquities(std.testing.allocator, &stacks, &payouts);
    defer std.testing.allocator.free(eq);
    try std.testing.expectApproxEqAbs(@as(f64, 50.0), eq[0], 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, 50.0), eq[1], 1e-9);
}

test "TerminalCache reuses pre-equity and distinct chip terminals" {
    const stacks = [_]f64{ 1000, 1000, 1000 };
    const payouts = [_]f64{ 50, 30, 20 };
    const cfg = IcmConfig{ .stacks = &stacks, .payouts = &payouts };
    var cache = try TerminalCache.init(std.testing.allocator, cfg);
    defer cache.deinit();
    try std.testing.expect(cache.active);
    try std.testing.expect(cache.pre_eq.len == 3);

    const win = payoff.PlayerPayoff{ .utility = .{ 100, -100 } };
    const lose = payoff.PlayerPayoff{ .utility = .{ -100, 100 } };
    const direct_win = try applyIcmTerminal(std.testing.allocator, cfg, win);
    const cached_win = try cache.apply(win);
    try std.testing.expectApproxEqAbs(direct_win.utility[0], cached_win.utility[0], 1e-12);
    try std.testing.expectApproxEqAbs(direct_win.utility[1], cached_win.utility[1], 1e-12);
    try std.testing.expectEqual(@as(usize, 1), cache.miss_count);

    const again = try cache.apply(win);
    try std.testing.expectEqual(@as(usize, 1), cache.miss_count);
    try std.testing.expectApproxEqAbs(cached_win.utility[0], again.utility[0], 0);

    _ = try cache.apply(lose);
    try std.testing.expectEqual(@as(usize, 2), cache.miss_count);
    try std.testing.expect(cache.get(win) != null);
    try std.testing.expect(cache.get(lose) != null);
}
