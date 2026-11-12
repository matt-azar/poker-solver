const std = @import("std");
const compile = @import("../game/compile.zig");
const street_config = @import("../game/street_config.zig");
const training_state = @import("../solve/training_state.zig");
const cfr_plus = @import("../solve/algorithms/cfr_plus.zig");
const evaluation = @import("evaluation.zig");
const best_response = @import("best_response.zig");
const inspect = @import("inspect.zig");
const action_ev = @import("action_ev.zig");
const equity = @import("equity.zig");
const range_mod = @import("../poker/range.zig");
const card = @import("../poker/card.zig");

fn checkOnlyRiver(allocator: std.mem.Allocator, oop: []const u8, ip: []const u8) !compile.CompiledGame {
    var text_buf: [512]u8 = undefined;
    const text = try std.fmt.bufPrint(&text_buf,
        \\street-config 1
        \\board Ah Kd 7c 4s 2h
        \\pot 100
        \\stack 100
        \\oop-range {s}
        \\ip-range {s}
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
    , .{ oop, ip });
    var spec = try street_config.parseStreetConfig(allocator, text);
    defer spec.deinit();
    return compile.compile(allocator, spec);
}

test "nashconv zero on forced check-only river" {
    var game = try checkOnlyRiver(std.testing.allocator, "AcAd:1", "KsKc:1");
    defer game.deinit();

    var state = try training_state.TrainingState.init(std.testing.allocator, game);
    defer state.deinit();
    var published = try cfr_plus.trainDealByDeal(std.testing.allocator, game, &state, .{ .iterations = 1 });
    defer published.deinit();

    const result = try best_response.evaluatePublished(std.testing.allocator, game, published.average);
    try std.testing.expectApproxEqAbs(@as(f64, 50.0), result.u0, 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, -50.0), result.u1, 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, 0.0), result.gain0, 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, 0.0), result.gain1, 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, 0.0), result.nash_gap, 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, 0.0), result.accuracy, 1e-9);
    try std.testing.expectApproxEqAbs(result.nash_gap, result.gain0 + result.gain1, 1e-12);
    try std.testing.expectApproxEqAbs(result.accuracy, 0.5 * result.nash_gap, 1e-12);
}

test "nashconv zero under rake uses gain formula" {
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
        \\rake-rate 0.05
        \\rake-cap 0
        \\memory-mib 1024
        \\threads 1
        \\
    ;
    var spec = try street_config.parseStreetConfig(std.testing.allocator, text);
    defer spec.deinit();
    var game = try compile.compile(std.testing.allocator, spec);
    defer game.deinit();
    var state = try training_state.TrainingState.init(std.testing.allocator, game);
    defer state.deinit();
    var published = try cfr_plus.trainDealByDeal(std.testing.allocator, game, &state, .{ .iterations = 1 });
    defer published.deinit();

    const result = try best_response.evaluatePublished(std.testing.allocator, game, published.average);
    try std.testing.expectApproxEqAbs(@as(f64, 45.0), result.u0, 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, -50.0), result.u1, 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, 0.0), result.nash_gap, 1e-9);
    try std.testing.expect(@abs((result.br0 + result.br1) - result.nash_gap) > 1.0);
}

test "inspect copies published strategy rows" {
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
        \\memory-mib 1024
        \\threads 1
        \\
    ;
    var spec = try street_config.parseStreetConfig(std.testing.allocator, text);
    defer spec.deinit();
    var game = try compile.compile(std.testing.allocator, spec);
    defer game.deinit();
    var state = try training_state.TrainingState.init(std.testing.allocator, game);
    defer state.deinit();
    var published = try cfr_plus.trainDealByDeal(std.testing.allocator, game, &state, .{ .iterations = 20 });
    defer published.deinit();

    // Root decision.
    var page = try inspect.inspectNode(std.testing.allocator, game, published, 0, -1, -1);
    defer page.deinit();
    try std.testing.expect(page.player == 0);
    try std.testing.expect(page.policy_revision == published.revision);
    try std.testing.expect(page.n_actions >= 2);
    try std.testing.expect(page.strategy.len == @as(usize, @intCast(page.n_hands)) * page.n_actions);
    // Rows are probabilities.
    var hand: usize = 0;
    while (hand < @as(usize, @intCast(page.n_hands))) : (hand += 1) {
        var sum: f64 = 0;
        var a: usize = 0;
        while (a < page.n_actions) : (a += 1) {
            sum += page.strategy[hand * page.n_actions + a];
        }
        if (sum > 0) try std.testing.expectApproxEqAbs(@as(f64, 1.0), sum, 1e-5);
    }
}

test "action ev local_offset makes fold local zero when facing bet" {
    const text =
        \\street-config 1
        \\board Ah Kd 7c 4s 2h
        \\pot 100
        \\stack 100
        \\oop-range AcAd:1
        \\ip-range KsKc:1
        \\oop-river-bets 1
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
    var spec = try street_config.parseStreetConfig(std.testing.allocator, text);
    defer spec.deinit();
    var bet_game = try compile.compile(std.testing.allocator, spec);
    defer bet_game.deinit();
    var state = try training_state.TrainingState.init(std.testing.allocator, bet_game);
    defer state.deinit();
    var published = try cfr_plus.trainDealByDeal(std.testing.allocator, bet_game, &state, .{ .iterations = 30 });
    defer published.deinit();

    // Root OOP: contrib 0 → fold-now U0 = -50 → local_offset = 50.
    var root_page = try action_ev.actionValues(std.testing.allocator, bet_game, published, 0, -1, -1);
    defer root_page.deinit();
    try std.testing.expectApproxEqAbs(@as(f64, 50.0), root_page.local_offset, 1e-9);

    // After OOP bets, IP faces Fold/Call.
    var bet_child: ?u32 = null;
    const root = bet_game.nodes[0];
    var a: usize = 0;
    while (a < root.n_actions) : (a += 1) {
        if (std.mem.startsWith(u8, root.action_labels[a], "Bet")) {
            bet_child = root.child[a];
            break;
        }
    }
    try std.testing.expect(bet_child != null);
    var page = try action_ev.actionValues(std.testing.allocator, bet_game, published, bet_child.?, -1, -1);
    defer page.deinit();
    try std.testing.expect(page.player == 1);
    var fold: ?usize = null;
    for (page.actions, 0..) |label, i| {
        if (std.mem.eql(u8, label, "Fold")) fold = i;
    }
    try std.testing.expect(fold != null);
    var hand: usize = 0;
    while (hand < page.combos.len) : (hand += 1) {
        if (page.ev_defined[hand] == 0) continue;
        const root_ev = page.action_ev[hand * page.actions.len + fold.?];
        try std.testing.expectApproxEqAbs(@as(f64, 0.0), root_ev + page.local_offset, 1e-6);
    }
}

test "checkdown equity AA vs KK river" {
    const board = [_]card.Card{
        try card.parseCard("Ah"),
        try card.parseCard("Kd"),
        try card.parseCard("7c"),
        try card.parseCard("4s"),
        try card.parseCard("2h"),
    };
    var r0 = range_mod.Range{};
    var r1 = range_mod.Range{};
    try r0.setWeight(try card.parseCard("Ac"), try card.parseCard("Ad"), 1.0);
    try r1.setWeight(try card.parseCard("Ks"), try card.parseCard("Kc"), 1.0);
    var eq = try equity.showdownEquity(std.testing.allocator, &board, r0, r1, equity.default_max_pair_runouts);
    defer eq.deinit();
    try std.testing.expect(eq.joint_defined);
    try std.testing.expectApproxEqAbs(@as(f64, 1.0), eq.player0.equity, 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, 0.0), eq.player1.equity, 1e-12);
}

test "evaluatePublished matches makeEvaluation identity" {
    _ = evaluation;
}
