const std = @import("std");
const card = @import("../poker/card.zig");
const chips = @import("../poker/chips.zig");
const hand_eval = @import("../poker/hand_eval.zig");
const payoff = @import("../poker/payoff.zig");
const icm = @import("../poker/icm.zig");
const compile = @import("../game/compile.zig");

pub const KernelError = error{InvalidTerminal};

/// Full product terminal: chip+rake → optional ICM → path incentive deltas.
/// `showdown` is ignored when `folded >= 0`. When `folded < 0`, board must be
/// five cards and hole cards are compared.
pub fn terminalPayoff(
    allocator: std.mem.Allocator,
    pot: chips.Chip,
    contrib0: chips.Chip,
    contrib1: chips.Chip,
    folded: i32,
    board: []const card.Card,
    hole0: [2]card.Card,
    hole1: [2]card.Card,
    rake: payoff.RakeConfig,
    icm_cfg: icm.IcmConfig,
    incentive_u0: f64,
    incentive_u1: f64,
) KernelError!payoff.PlayerPayoff {
    var outcome: i32 = 0;
    if (folded < 0) {
        if (board.len != 5) return error.InvalidTerminal;
        outcome = hand_eval.compareShowdown(hole0[0], hole0[1], hole1[0], hole1[1], board) catch {
            return error.InvalidTerminal;
        };
    }
    const chips_pay = payoff.chipTerminal(pot, contrib0, contrib1, folded, outcome, rake) catch {
        return error.InvalidTerminal;
    };
    var paid = icm.applyIcmTerminal(allocator, icm_cfg, chips_pay) catch {
        return error.InvalidTerminal;
    };
    paid.utility[0] += incentive_u0;
    paid.utility[1] += incentive_u1;
    return paid;
}

/// Evaluate a terminal node of a compiled game for one hole-card deal.
pub fn terminalNodePayoff(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    node: compile.Node,
    hole0: [2]card.Card,
    hole1: [2]card.Card,
    turn: ?card.Card,
    river: ?card.Card,
) KernelError!payoff.PlayerPayoff {
    if (node.kind != .terminal) return error.InvalidTerminal;
    var board_buf: [5]card.Card = undefined;
    var count: usize = 0;
    for (game.board) |c| {
        board_buf[count] = c;
        count += 1;
    }
    if (turn) |t| {
        board_buf[count] = t;
        count += 1;
    }
    if (river) |r| {
        board_buf[count] = r;
        count += 1;
    }
    return terminalPayoff(
        allocator,
        game.pot,
        node.contrib[0],
        node.contrib[1],
        node.folded,
        board_buf[0..count],
        hole0,
        hole1,
        game.rake,
        game.icmConfig(),
        node.incentive_u0,
        node.incentive_u1,
    );
}

test "river check-down AA vs KK" {
    const board = [_]card.Card{
        try card.parseCard("Ah"),
        try card.parseCard("Kd"),
        try card.parseCard("7c"),
        try card.parseCard("4s"),
        try card.parseCard("2h"),
    };
    const paid = try terminalPayoff(
        std.testing.allocator,
        chips.chipUnits(100),
        0,
        0,
        -1,
        &board,
        .{ try card.parseCard("Ac"), try card.parseCard("Ad") },
        .{ try card.parseCard("Ks"), try card.parseCard("Kc") },
        .{},
        .{},
        0,
        0,
    );
    try std.testing.expectApproxEqAbs(@as(f64, 50.0), paid.utility[0], 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, -50.0), paid.utility[1], 1e-12);
}

test "fold with rake" {
    const paid = try terminalPayoff(
        std.testing.allocator,
        chips.chipUnits(100),
        chips.chipUnits(100),
        0,
        1,
        &.{},
        .{ 0, 1 },
        .{ 2, 3 },
        .{ .rate = 0.05, .cap = 0 },
        .{},
        0,
        0,
    );
    try std.testing.expectApproxEqAbs(@as(f64, 40.0), paid.utility[0], 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, -50.0), paid.utility[1], 1e-12);
}

test "compiled river terminal via kernel" {
    const text =
        \\street-config 1
        \\board Ah Kd 7c 4s 2h
        \\pot 100
        \\stack 100
        \\oop-range AcAd:1
        \\ip-range KsKc:1
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

    // Walk Check/Check to the terminal.
    var node_id: u32 = 0;
    var guards: usize = 0;
    while (game.nodes[node_id].kind == .decision and guards < 8) : (guards += 1) {
        const node = game.nodes[node_id];
        try std.testing.expectEqual(@as(u8, 1), node.n_actions);
        try std.testing.expectEqualStrings("Check", node.action_labels[0]);
        node_id = node.child[0];
    }
    try std.testing.expect(game.nodes[node_id].kind == .terminal);

    const paid = try terminalNodePayoff(
        std.testing.allocator,
        game,
        game.nodes[node_id],
        .{ try card.parseCard("Ac"), try card.parseCard("Ad") },
        .{ try card.parseCard("Ks"), try card.parseCard("Kc") },
        null,
        null,
    );
    try std.testing.expectApproxEqAbs(@as(f64, 50.0), paid.utility[0], 1e-12);
}
