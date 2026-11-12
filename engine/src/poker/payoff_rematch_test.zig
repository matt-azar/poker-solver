//! Terminal-payoff rematch pins vs tip C++ `test_payoff.cpp` / `test_rake.cpp`.
//! Numbers are ChipPayoff::terminal / collect() fixtures (tenths in, chips out).
const std = @import("std");
const payoff = @import("payoff.zig");

test "chip terminal fold / call / raise / lose / tie pins" {
    // IP folds facing Bet 100: ChipPayoff::terminal(1000, 1000, 0, 1, 0) → (50, -50)
    {
        const p = try payoff.chipTerminal(1000, 1000, 0, 1, 0, .{});
        try std.testing.expectApproxEqAbs(@as(f64, 50.0), p.utility[0], 1e-12);
        try std.testing.expectApproxEqAbs(@as(f64, -50.0), p.utility[1], 1e-12);
    }
    // Called win: (1000, 1000, 1000, -1, 1) → (150, -150)
    {
        const p = try payoff.chipTerminal(1000, 1000, 1000, -1, 1, .{});
        try std.testing.expectApproxEqAbs(@as(f64, 150.0), p.utility[0], 1e-12);
        try std.testing.expectApproxEqAbs(@as(f64, -150.0), p.utility[1], 1e-12);
    }
    // OOP folds after Raise to 400: (1000, 1000, 4000, 0, 0) → (-150, 150)
    {
        const p = try payoff.chipTerminal(1000, 1000, 4000, 0, 0, .{});
        try std.testing.expectApproxEqAbs(@as(f64, -150.0), p.utility[0], 1e-12);
        try std.testing.expectApproxEqAbs(@as(f64, 150.0), p.utility[1], 1e-12);
    }
    // Showdown lose: (1000, 0, 0, -1, -1) → (-50, 50)
    {
        const p = try payoff.chipTerminal(1000, 0, 0, -1, -1, .{});
        try std.testing.expectApproxEqAbs(@as(f64, -50.0), p.utility[0], 1e-12);
        try std.testing.expectApproxEqAbs(@as(f64, 50.0), p.utility[1], 1e-12);
    }
    // Showdown tie: (1000, 0, 0, -1, 0) → (0, 0)
    {
        const p = try payoff.chipTerminal(1000, 0, 0, -1, 0, .{});
        try std.testing.expectApproxEqAbs(@as(f64, 0.0), p.utility[0], 1e-12);
        try std.testing.expectApproxEqAbs(@as(f64, 0.0), p.utility[1], 1e-12);
    }
    // Unequal contrib at showdown rejected.
    try std.testing.expectError(error.InvalidPayoff, payoff.chipTerminal(1000, 500, 1000, -1, 1, .{}));
}

test "collectRake whole-chip floor + cap pins" {
    const uncapped = payoff.RakeConfig{ .rate = 0.05, .cap = 0 };
    try std.testing.expectApproxEqAbs(@as(f64, 10.0), payoff.collectRake(200.0, uncapped), 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, 9.0), payoff.collectRake(199.0, uncapped), 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, 0.0), payoff.collectRake(0.0, uncapped), 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, 0.0), payoff.collectRake(100.0, .{}), 1e-12);

    const capped = payoff.RakeConfig{ .rate = 0.05, .cap = 5.0 };
    try std.testing.expectApproxEqAbs(@as(f64, 5.0), payoff.collectRake(200.0, capped), 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, 4.0), payoff.collectRake(80.0, capped), 1e-12);

    const full = payoff.RakeConfig{ .rate = 1.0, .cap = 0 };
    try std.testing.expectApproxEqAbs(@as(f64, 123.0), payoff.collectRake(123.0, full), 1e-12);
}

test "rake validation rejects out of range" {
    try std.testing.expectError(error.InvalidPayoff, (payoff.RakeConfig{ .rate = -0.1, .cap = 0 }).validate());
    try std.testing.expectError(error.InvalidPayoff, (payoff.RakeConfig{ .rate = 1.1, .cap = 0 }).validate());
    try std.testing.expectError(error.InvalidPayoff, (payoff.RakeConfig{ .rate = 0.05, .cap = -1 }).validate());
    try std.testing.expectError(
        error.InvalidPayoff,
        payoff.chipTerminal(1000, 0, 0, -1, 1, .{ .rate = 2.0, .cap = 0 }),
    );
    try (payoff.RakeConfig{}).validate();
    try (payoff.RakeConfig{ .rate = 0, .cap = 0 }).validate();
    try (payoff.RakeConfig{ .rate = 1.0, .cap = 10 }).validate();
}

test "raked chip terminals match C++ test_rake pins" {
    const rake = payoff.RakeConfig{ .rate = 0.05, .cap = 0 };
    // Fold win pot 200: (40, -50)
    {
        const p = try payoff.chipTerminal(1000, 1000, 0, 1, 0, rake);
        try std.testing.expectApproxEqAbs(@as(f64, 40.0), p.utility[0], 1e-12);
        try std.testing.expectApproxEqAbs(@as(f64, -50.0), p.utility[1], 1e-12);
        try std.testing.expectApproxEqAbs(@as(f64, -10.0), p.utility[0] + p.utility[1], 1e-12);
    }
    // Fold win with cap 5: (45, -50)
    {
        const p = try payoff.chipTerminal(1000, 1000, 0, 1, 0, .{ .rate = 0.05, .cap = 5.0 });
        try std.testing.expectApproxEqAbs(@as(f64, 45.0), p.utility[0], 1e-12);
        try std.testing.expectApproxEqAbs(@as(f64, -50.0), p.utility[1], 1e-12);
    }
    // Showdown win pot 300: (135, -150)
    {
        const p = try payoff.chipTerminal(1000, 1000, 1000, -1, 1, rake);
        try std.testing.expectApproxEqAbs(@as(f64, 135.0), p.utility[0], 1e-12);
        try std.testing.expectApproxEqAbs(@as(f64, -150.0), p.utility[1], 1e-12);
    }
    // Showdown lose: (-50, 45)
    {
        const p = try payoff.chipTerminal(1000, 0, 0, -1, -1, rake);
        try std.testing.expectApproxEqAbs(@as(f64, -50.0), p.utility[0], 1e-12);
        try std.testing.expectApproxEqAbs(@as(f64, 45.0), p.utility[1], 1e-12);
    }
    // Tie: (-2.5, -2.5)
    {
        const p = try payoff.chipTerminal(1000, 0, 0, -1, 0, rake);
        try std.testing.expectApproxEqAbs(@as(f64, -2.5), p.utility[0], 1e-12);
        try std.testing.expectApproxEqAbs(@as(f64, -2.5), p.utility[1], 1e-12);
    }
    // OOP folds into rake pot 600: (-150, 120)
    {
        const p = try payoff.chipTerminal(1000, 1000, 4000, 0, 0, rake);
        try std.testing.expectApproxEqAbs(@as(f64, -150.0), p.utility[0], 1e-12);
        try std.testing.expectApproxEqAbs(@as(f64, 120.0), p.utility[1], 1e-12);
    }
}

test "zero rake matches bare chipTerminal bit-for-bit class" {
    const cases = [_]struct { pot: i32, c0: i32, c1: i32, folded: i32, sd: i32, u0: f64 }{
        .{ .pot = 1000, .c0 = 1000, .c1 = 0, .folded = 1, .sd = 0, .u0 = 50.0 },
        .{ .pot = 1000, .c0 = 1000, .c1 = 1000, .folded = -1, .sd = 1, .u0 = 150.0 },
        .{ .pot = 1000, .c0 = 1000, .c1 = 4000, .folded = 0, .sd = 0, .u0 = -150.0 },
        .{ .pot = 1000, .c0 = 0, .c1 = 0, .folded = -1, .sd = -1, .u0 = -50.0 },
        .{ .pot = 1000, .c0 = 0, .c1 = 0, .folded = -1, .sd = 0, .u0 = 0.0 },
    };
    for (cases) |c| {
        const plain = try payoff.chipTerminal(c.pot, c.c0, c.c1, c.folded, c.sd, .{});
        const zero = try payoff.chipTerminal(c.pot, c.c0, c.c1, c.folded, c.sd, .{ .rate = 0, .cap = 0 });
        try std.testing.expectApproxEqAbs(c.u0, plain.utility[0], 1e-12);
        try std.testing.expectApproxEqAbs(-c.u0, plain.utility[1], 1e-12);
        try std.testing.expectEqual(plain.utility[0], zero.utility[0]);
        try std.testing.expectEqual(plain.utility[1], zero.utility[1]);
    }
}
