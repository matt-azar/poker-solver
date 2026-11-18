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
        try validateInputs(self.stacks, self.payouts);
        if (pot < 0 or effective_stack < 0) return error.InvalidIcm;
        const need = 0.5 * chips.tenthsToChips(pot) + chips.tenthsToChips(effective_stack);
        if (self.stacks[0] < need or self.stacks[1] < need) return error.InvalidIcm;
    }
};

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

fn icmEquitiesInto(stacks: []const f64, payouts: []const f64, work: []f64, equities: []f64) IcmError!void {
    try validateInputs(stacks, payouts);
    if (work.len < stacks.len or equities.len < stacks.len) return error.InvalidIcm;
    @memcpy(work[0..stacks.len], stacks);
    @memset(equities[0..stacks.len], 0);
    var alive: usize = 0;
    for (work[0..stacks.len]) |s| {
        if (s > 0.0) alive += 1;
    }
    icmRecurse(work[0..stacks.len], alive, payouts, 0, 1.0, equities[0..stacks.len]);
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
    const work = allocator.dupe(f64, stacks) catch return error.InvalidIcm;
    defer allocator.free(work);
    const equities = allocator.alloc(f64, stacks.len) catch return error.InvalidIcm;
    @memset(equities, 0);
    var alive: usize = 0;
    for (work) |s| {
        if (s > 0.0) alive += 1;
    }
    icmRecurse(work, alive, payouts, 0, 1.0, equities);
    return equities;
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
    try validateInputs(icm.stacks, icm.payouts);
    if (!std.math.isFinite(chip_terminal.utility[0]) or !std.math.isFinite(chip_terminal.utility[1])) {
        return error.InvalidIcm;
    }

    if (icm.stacks.len <= max_stack_seats) {
        var post_buf: [max_stack_seats]f64 = undefined;
        var work_buf: [max_stack_seats]f64 = undefined;
        var pre_buf: [max_stack_seats]f64 = undefined;
        var post_eq_buf: [max_stack_seats]f64 = undefined;
        const n = icm.stacks.len;
        @memcpy(post_buf[0..n], icm.stacks);
        post_buf[0] += chip_terminal.utility[0];
        post_buf[1] += chip_terminal.utility[1];
        if (!(post_buf[0] >= 0.0) or !(post_buf[1] >= 0.0)) return error.InvalidIcm;

        try icmEquitiesInto(icm.stacks, icm.payouts, work_buf[0..n], pre_buf[0..n]);

        var post_total: f64 = 0;
        for (post_buf[0..n]) |s| post_total += s;
        if (post_total > 0.0) {
            try icmEquitiesInto(post_buf[0..n], icm.payouts, work_buf[0..n], post_eq_buf[0..n]);
        } else {
            @memset(post_eq_buf[0..n], 0);
        }
        return .{
            .utility = .{
                post_eq_buf[0] - pre_buf[0],
                post_eq_buf[1] - pre_buf[1],
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

    const pre_eq = try icmEquities(allocator, icm.stacks, icm.payouts);
    defer allocator.free(pre_eq);
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

test "icm two-player bubble" {
    const stacks = [_]f64{ 1000, 1000 };
    const payouts = [_]f64{ 70, 30 };
    const eq = try icmEquities(std.testing.allocator, &stacks, &payouts);
    defer std.testing.allocator.free(eq);
    try std.testing.expectApproxEqAbs(@as(f64, 50.0), eq[0], 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, 50.0), eq[1], 1e-9);
}
