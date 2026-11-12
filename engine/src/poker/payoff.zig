const std = @import("std");
const chips = @import("chips.zig");

pub const PayoffError = error{InvalidPayoff};

pub const PlayerPayoff = struct {
    utility: [2]f64 = .{ 0, 0 },
};

pub const RakeConfig = struct {
    rate: f64 = 0,
    cap: f64 = 0,

    pub fn valid(self: RakeConfig) bool {
        return self.rate >= 0.0 and self.rate <= 1.0 and self.cap >= 0.0 and std.math.isFinite(self.rate) and std.math.isFinite(self.cap);
    }

    pub fn validate(self: RakeConfig) PayoffError!void {
        if (!self.valid()) return error.InvalidPayoff;
    }
};

/// Whole-chip rake taken from pot_chips before winner attribution.
pub fn collectRake(pot_chips: f64, rake: RakeConfig) f64 {
    if (!(pot_chips > 0.0) or !(rake.rate > 0.0)) return 0.0;
    var taken = @floor(rake.rate * pot_chips);
    if (rake.cap > 0.0 and taken > rake.cap) taken = rake.cap;
    if (taken > pot_chips) taken = pot_chips;
    return taken;
}

/// Root-centered chip terminals. `initial_pot` / contrib are tenths.
/// `folded` is -1 at showdown, else the folding seat. `showdown` is >0 if P0
/// wins, <0 if P0 loses, 0 on a tie (ignored on fold).
pub fn chipTerminal(
    initial_pot: chips.Chip,
    contrib0: chips.Chip,
    contrib1: chips.Chip,
    folded: i32,
    showdown: i32,
    rake: RakeConfig,
) PayoffError!PlayerPayoff {
    if (initial_pot <= 0) return error.InvalidPayoff;
    if (contrib0 < 0 or contrib1 < 0) return error.InvalidPayoff;
    if (folded != -1 and folded != 0 and folded != 1) return error.InvalidPayoff;
    try rake.validate();

    const pot = chips.tenthsToChips(initial_pot);
    const c0 = chips.tenthsToChips(contrib0);
    const c1 = chips.tenthsToChips(contrib1);
    const half_pot = pot * 0.5;
    var payoff = PlayerPayoff{};
    var player0_wins = false;
    var player1_wins = false;

    if (folded == 0) {
        payoff.utility[0] = -(half_pot + c0);
        player1_wins = true;
    } else if (folded == 1) {
        payoff.utility[0] = half_pot + c1;
        player0_wins = true;
    } else {
        if (contrib0 != contrib1) return error.InvalidPayoff;
        if (showdown > 0) {
            payoff.utility[0] = half_pot + c1;
            player0_wins = true;
        } else if (showdown < 0) {
            payoff.utility[0] = -(half_pot + c0);
            player1_wins = true;
        } else {
            payoff.utility[0] = 0.0;
        }
    }
    payoff.utility[1] = -payoff.utility[0];

    const pot_chips = pot + c0 + c1;
    const taken = collectRake(pot_chips, rake);
    if (taken == 0.0) return payoff;
    if (player0_wins) {
        payoff.utility[0] -= taken;
    } else if (player1_wins) {
        payoff.utility[1] -= taken;
    } else {
        const half_rake = taken * 0.5;
        payoff.utility[0] -= half_rake;
        payoff.utility[1] -= half_rake;
    }
    return payoff;
}

test "fold IP wins pot/2 for OOP" {
    const p = try chipTerminal(1000, 1000, 0, 1, 0, .{});
    try std.testing.expectApproxEqAbs(@as(f64, 50.0), p.utility[0], 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, -50.0), p.utility[1], 1e-12);
}

test "showdown win" {
    const p = try chipTerminal(1000, 1000, 1000, -1, 1, .{});
    try std.testing.expectApproxEqAbs(@as(f64, 150.0), p.utility[0], 1e-12);
}

test "rake on fold win" {
    const rake = RakeConfig{ .rate = 0.05, .cap = 0 };
    const p = try chipTerminal(1000, 1000, 0, 1, 0, rake);
    // pot chips 200, rake 10 → (40, -50)
    try std.testing.expectApproxEqAbs(@as(f64, 40.0), p.utility[0], 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, -50.0), p.utility[1], 1e-12);
}

test "rake on tie" {
    const rake = RakeConfig{ .rate = 0.05, .cap = 0 };
    const p = try chipTerminal(1000, 0, 0, -1, 0, rake);
    try std.testing.expectApproxEqAbs(@as(f64, -2.5), p.utility[0], 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, -2.5), p.utility[1], 1e-12);
}
