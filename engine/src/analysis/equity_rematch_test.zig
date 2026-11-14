//! Durable Zig pins vs tip C++ `tests/equity/test_equity.cpp` +
//! `tests/unit/test_equity_dist.cpp` Study check-down / histogram contracts.
const std = @import("std");
const card = @import("../poker/card.zig");
const range_mod = @import("../poker/range.zig");
const equity = @import("equity.zig");

fn sameComboLabel(got: []const u8, want: []const u8) bool {
    if (got.len != 4 or want.len != 4) return false;
    return (std.mem.eql(u8, got, want)) or
        (std.mem.eql(u8, got[0..2], want[2..4]) and std.mem.eql(u8, got[2..4], want[0..2]));
}

fn findCombo(rows: []const equity.ComboEquity, text: []const u8) ?*const equity.ComboEquity {
    for (rows) |*row| {
        if (sameComboLabel(row.combo, text)) return row;
    }
    return null;
}

fn comboOf(text: []const u8) !i32 {
    const r = try range_mod.Range.parse(text);
    var index: i32 = 0;
    while (index < card.combo_count) : (index += 1) {
        if (r.weights[@intCast(index)] > 0) return index;
    }
    return error.InvalidEquity;
}

fn boardOf(cards: []const []const u8) ![5]card.Card {
    var out: [5]card.Card = undefined;
    for (cards, 0..) |t, i| out[i] = try card.parseCard(t);
    return out;
}

test "study pair-runout packaging constants match C++" {
    try std.testing.expectEqual(@as(u64, 1_100_000), equity.default_max_pair_runouts);
    try std.testing.expectEqual(@as(u64, 51_369_120), equity.full_range_turn_pair_runouts);
    try std.testing.expectEqual(equity.full_range_turn_pair_runouts, equity.study_explorer_max_pair_runouts);
    try std.testing.expect(equity.study_explorer_max_pair_runouts > equity.default_max_pair_runouts);
}

test "wide flop work-limit rejects without O(n2*runouts) preflight" {
    // Full-ish ranges exceed Study's 51M pair-runout ceiling. Preflight must be
    // O(n0·n1) closed-form — nested runout counting historically stalled Study.
    const board = try boardOf(&.{ "Ah", "Kd", "7c" });
    const r0 = try range_mod.Range.parse("random");
    const r1 = try range_mod.Range.parse("random");
    const t0 = std.time.nanoTimestamp();
    const err = equity.showdownEquity(
        std.testing.allocator,
        board[0..3],
        r0,
        r1,
        equity.study_explorer_max_pair_runouts,
    );
    const elapsed_ns = std.time.nanoTimestamp() - t0;
    try std.testing.expectError(error.WorkLimit, err);
    // Generous bound: nested 1326²·1081 counting was ~30s; O(n²) should be <<1s.
    try std.testing.expect(elapsed_ns < 2 * std.time.ns_per_s);
}

test "river certainty AhAd vs 2c3d and royal board tie" {
    const board = try boardOf(&.{ "Kh", "Kd", "7c", "4s", "2h" });
    const r0 = try range_mod.Range.parse("AhAd");
    const r1 = try range_mod.Range.parse("2c3d");
    var eq = try equity.showdownEquity(std.testing.allocator, board[0..5], r0, r1, equity.default_max_pair_runouts);
    defer eq.deinit();
    try std.testing.expect(eq.joint_defined);
    try std.testing.expectEqual(@as(u64, 1), eq.pair_runouts);
    try std.testing.expectEqual(@as(f64, 1.0), eq.player0.equity);
    try std.testing.expectEqual(@as(f64, 1.0), eq.player0.win);
    try std.testing.expectEqual(@as(f64, 0.0), eq.player0.loss);
    try std.testing.expectEqual(@as(f64, 0.0), eq.player1.equity);
    try std.testing.expectEqual(@as(f64, 1.0), eq.player1.loss);
    const aces = findCombo(eq.player0.combos, "AhAd").?;
    const air = findCombo(eq.player1.combos, "2c3d").?;
    try std.testing.expect(aces.defined);
    try std.testing.expectEqual(@as(f64, 1.0), aces.equity);
    try std.testing.expect(air.defined);
    try std.testing.expectEqual(@as(f64, 0.0), air.equity);

    const royal = try boardOf(&.{ "Ah", "Kh", "Qh", "Jh", "Th" });
    var tied = try equity.showdownEquity(
        std.testing.allocator,
        royal[0..5],
        try range_mod.Range.parse("2c2d"),
        try range_mod.Range.parse("3c3d"),
        equity.default_max_pair_runouts,
    );
    defer tied.deinit();
    try std.testing.expect(tied.joint_defined);
    try std.testing.expectEqual(@as(f64, 0.0), tied.player0.win);
    try std.testing.expectEqual(@as(f64, 1.0), tied.player0.tie);
    try std.testing.expectEqual(@as(f64, 0.5), tied.player0.equity);
    try std.testing.expectEqual(@as(f64, 0.5), tied.player1.equity);
    try std.testing.expectApproxEqAbs(@as(f64, 1.0), tied.player0.equity + tied.player1.equity, 0.0);
}

test "board blockers turn completions and card overlap" {
    const flop = try boardOf(&.{ "Ah", "Kd", "7c" });
    var flop_eq = try equity.showdownEquity(
        std.testing.allocator,
        flop[0..3],
        try range_mod.Range.parse("2c2d"),
        try range_mod.Range.parse("9c9d,AhAs"),
        equity.default_max_pair_runouts,
    );
    defer flop_eq.deinit();
    try std.testing.expectEqual(@as(u64, 990), flop_eq.pair_runouts);
    const blocked = findCombo(flop_eq.player1.combos, "AhAs").?;
    try std.testing.expect(!blocked.defined);
    const nines = findCombo(flop_eq.player1.combos, "9c9d").?;
    try std.testing.expect(nines.defined);
    try std.testing.expectApproxEqAbs(@as(f64, 1.0), flop_eq.player0.equity + flop_eq.player1.equity, 1e-12);

    const turn = try boardOf(&.{ "Ah", "Kd", "7c", "2s" });
    var turn_eq = try equity.showdownEquity(
        std.testing.allocator,
        turn[0..4],
        try range_mod.Range.parse("3c3d"),
        try range_mod.Range.parse("9c9d"),
        equity.default_max_pair_runouts,
    );
    defer turn_eq.deinit();
    try std.testing.expectEqual(@as(u64, 44), turn_eq.pair_runouts);
    try std.testing.expect(turn_eq.joint_defined);
    try std.testing.expectApproxEqAbs(@as(f64, 1.0), turn_eq.player0.equity + turn_eq.player1.equity, 1e-12);
    // 3c3d wins only on the two remaining threes (3h/3s) → 2/44.
    try std.testing.expectApproxEqAbs(@as(f64, 2.0 / 44.0), turn_eq.player0.equity, 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, 42.0 / 44.0), turn_eq.player1.equity, 1e-12);

    const river = try boardOf(&.{ "Qc", "Jd", "2c", "8h", "5s" });
    var overlap = try equity.showdownEquity(
        std.testing.allocator,
        river[0..5],
        try range_mod.Range.parse("AhAd"),
        try range_mod.Range.parse("AhAc,9c9d"),
        equity.default_max_pair_runouts,
    );
    defer overlap.deinit();
    try std.testing.expectEqual(@as(u64, 1), overlap.pair_runouts);
    const suited = findCombo(overlap.player1.combos, "AhAc").?;
    try std.testing.expect(!suited.defined);
    try std.testing.expect(findCombo(overlap.player1.combos, "9c9d").?.defined);
}

test "work limit rejects before evaluation" {
    const flop = try boardOf(&.{ "Ah", "Kd", "7c" });
    const err = equity.showdownEquity(
        std.testing.allocator,
        flop[0..3],
        try range_mod.Range.parse("2c2d"),
        try range_mod.Range.parse("9c9d"),
        989,
    );
    try std.testing.expectError(error.WorkLimit, err);

    var ok = try equity.showdownEquity(
        std.testing.allocator,
        flop[0..3],
        try range_mod.Range.parse("2c2d"),
        try range_mod.Range.parse("9c9d"),
        990,
    );
    defer ok.deinit();
    try std.testing.expectEqual(@as(u64, 990), ok.pair_runouts);
}

test "equity distribution ten buckets Study histogram" {
    const empty = try equity.equityDistribution(&.{}, &.{});
    try std.testing.expectEqual(@as(usize, 10), empty.len);
    try std.testing.expectApproxEqAbs(@as(f64, 0.0), empty[0].lo, 1e-15);
    try std.testing.expectApproxEqAbs(@as(f64, 0.1), empty[0].hi, 1e-15);

    const single = try equity.equityDistribution(&.{0.42}, &.{3.0});
    try std.testing.expectApproxEqAbs(@as(f64, 3.0), single[4].weight, 1e-15);

    const edges = try equity.equityDistribution(&.{ 0.0, 1.0 }, &.{ 2.0, 5.0 });
    try std.testing.expectApproxEqAbs(@as(f64, 2.0), edges[0].weight, 1e-15);
    try std.testing.expectApproxEqAbs(@as(f64, 5.0), edges[9].weight, 1e-15);

    const bounds = try equity.equityDistribution(&.{ 0.1, 0.9, 0.099999999999, 1.5, -0.2 }, &.{ 1, 1, 1, 1, 1 });
    try std.testing.expectApproxEqAbs(@as(f64, 2.0), bounds[0].weight, 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, 1.0), bounds[1].weight, 1e-15);
    try std.testing.expectApproxEqAbs(@as(f64, 2.0), bounds[9].weight, 1e-15);

    try std.testing.expectError(error.InvalidWeight, equity.equityDistribution(&.{0.5}, &.{-1.0}));
    try std.testing.expectError(error.InvalidEquity, equity.equityDistribution(&.{0.5}, &.{}));
}

test "checkdownEquity on compiled river matches showdownEquity" {
    const compile = @import("../game/compile.zig");
    const street_config = @import("../game/street_config.zig");
    const text =
        \\street-config 1
        \\board Ah Kd 7c 4s 2h
        \\pot 100
        \\stack 100
        \\oop-range AcAd:1,KsKc:0.5
        \\ip-range QsQc:1,JsJc:0.25
        \\first-to-act 0
        \\max-raises 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 64
        \\threads 1
        \\
    ;
    var cfg = try street_config.parseStreetConfig(std.testing.allocator, text);
    defer cfg.deinit();
    var game = try compile.compile(std.testing.allocator, cfg);
    defer game.deinit();

    var native = try equity.checkdownEquity(std.testing.allocator, game, equity.default_max_pair_runouts);
    defer native.deinit();
    var enum_eq = try equity.showdownEquity(
        std.testing.allocator,
        game.board,
        try range_mod.Range.parse("AcAd:1,KsKc:0.5"),
        try range_mod.Range.parse("QsQc:1,JsJc:0.25"),
        equity.default_max_pair_runouts,
    );
    defer enum_eq.deinit();
    try std.testing.expect(native.joint_defined);
    try std.testing.expectApproxEqAbs(enum_eq.player0.equity, native.player0.equity, 1e-9);
    try std.testing.expectApproxEqAbs(enum_eq.player1.equity, native.player1.equity, 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, 1.0), native.player0.equity + native.player1.equity, 1e-9);

    _ = try comboOf("AcAd");
}

test "node equity pins turn root 18.1818 and Ac river 100 (audit P0-2)" {
    const compile = @import("../game/compile.zig");
    const street_config = @import("../game/street_config.zig");
    const training_state = @import("../solve/training_state.zig");
    const node_id = @import("node_id.zig");

    const text =
        \\street-config 1
        \\board Ah Kh Qh Jh
        \\pot 100
        \\stack 200
        \\oop-range AsQs:1
        \\ip-range 2d2h:1
        \\oop-bets 0.5
        \\ip-bets 0.5
        \\oop-turn-bets 0.5
        \\ip-turn-bets 0.5
        \\oop-river-bets 0.5
        \\ip-river-bets 0.5
        \\first-to-act 0
        \\max-raises 1
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 256
        \\threads 1
        \\
    ;
    var cfg = try street_config.parseStreetConfig(std.testing.allocator, text);
    defer cfg.deinit();
    var game = try compile.compile(std.testing.allocator, cfg);
    defer game.deinit();

    var root = try equity.checkdownEquity(std.testing.allocator, game, equity.study_explorer_max_pair_runouts);
    defer root.deinit();
    try std.testing.expect(root.joint_defined);
    try std.testing.expectApproxEqAbs(@as(f64, 2.0 / 11.0), root.player0.equity, 1e-9);

    const empty_pub = training_state.PublishedPolicy{ .allocator = std.testing.allocator };
    var at_root = try equity.checkdownEquityAtNode(
        std.testing.allocator,
        game,
        empty_pub,
        0,
        -1,
        -1,
        equity.study_explorer_max_pair_runouts,
    );
    defer at_root.deinit();
    try std.testing.expectApproxEqAbs(root.player0.equity, at_root.player0.equity, 1e-12);

    // Fresh river solve on Ac: OOP aces full → 100%.
    const river_text =
        \\street-config 1
        \\board Ah Kh Qh Jh Ac
        \\pot 100
        \\stack 200
        \\oop-range AsQs:1
        \\ip-range 2d2h:1
        \\oop-river-bets 0.5
        \\ip-river-bets 0.5
        \\first-to-act 0
        \\max-raises 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 64
        \\threads 1
        \\
    ;
    var river_cfg = try street_config.parseStreetConfig(std.testing.allocator, river_text);
    defer river_cfg.deinit();
    var river_game = try compile.compile(std.testing.allocator, river_cfg);
    defer river_game.deinit();
    var river_root = try equity.checkdownEquity(std.testing.allocator, river_game, equity.default_max_pair_runouts);
    defer river_root.deinit();
    try std.testing.expect(river_root.joint_defined);
    try std.testing.expectApproxEqAbs(@as(f64, 1.0), river_root.player0.equity, 1e-12);

    // Same turn tree: check→check→Ac river decision must report 100%, not root 18.18%.
    const root_node = game.nodes[0];
    try std.testing.expect(root_node.kind == .decision);
    var check0: ?u32 = null;
    var a: usize = 0;
    while (a < root_node.n_actions) : (a += 1) {
        if (std.mem.eql(u8, root_node.action_labels[a], "Check")) {
            check0 = root_node.child[a];
            break;
        }
    }
    const after_oop = check0 orelse return error.TestUnexpectedResult;
    const ip_node = game.nodes[after_oop];
    try std.testing.expect(ip_node.kind == .decision);
    var check1: ?u32 = null;
    a = 0;
    while (a < ip_node.n_actions) : (a += 1) {
        if (std.mem.eql(u8, ip_node.action_labels[a], "Check")) {
            check1 = ip_node.child[a];
            break;
        }
    }
    const chance_idx = check1 orelse return error.TestUnexpectedResult;
    try std.testing.expect(game.nodes[chance_idx].kind == .chance);

    const ac = try card.parseCard("Ac");
    var buf: [64]u8 = undefined;
    const river_id = try std.fmt.bufPrint(&buf, "p{d}.t-1.r{d}", .{ game.nodes[chance_idx].child[0], ac });
    const located = try node_id.locateNode(game, river_id);

    var at_ac = try equity.checkdownEquityAtNode(
        std.testing.allocator,
        game,
        empty_pub,
        located.node_index,
        located.turn,
        located.river,
        equity.study_explorer_max_pair_runouts,
    );
    defer at_ac.deinit();
    try std.testing.expect(at_ac.joint_defined);
    try std.testing.expectApproxEqAbs(@as(f64, 1.0), at_ac.player0.equity, 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, 0.0), at_ac.player1.equity, 1e-9);
    try std.testing.expect(at_ac.player0.combos.len >= 1);
    try std.testing.expect(at_ac.player0.combos[0].input_weight > 0);
}

test "same board different lines reach-weight distinct ranges" {
    // Two OOP combos; IP one combo. After OOP Bet, only the betting mass remains for OOP.
    const compile = @import("../game/compile.zig");
    const street_config = @import("../game/street_config.zig");
    const training_state = @import("../solve/training_state.zig");
    const frozen_walk = @import("../solve/frozen_walk.zig");

    const text =
        \\street-config 1
        \\board Ah Kh Qh Jh Ac
        \\pot 100
        \\stack 200
        \\oop-range AsQs:1,2c2d:1
        \\ip-range 3c3d:1
        \\oop-river-bets 0.5
        \\ip-river-bets 0.5
        \\first-to-act 0
        \\max-raises 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 64
        \\threads 1
        \\
    ;
    var cfg = try street_config.parseStreetConfig(std.testing.allocator, text);
    defer cfg.deinit();
    var game = try compile.compile(std.testing.allocator, cfg);
    defer game.deinit();

    var state = try training_state.TrainingState.init(std.testing.allocator, game);
    defer state.deinit();
    var published = try frozen_walk.trainFrozenCfrPlus(std.testing.allocator, game, &state, 20, null);
    defer published.deinit();

    const root_node = game.nodes[0];
    const bet = blk: {
        var i: usize = 0;
        while (i < root_node.n_actions) : (i += 1) {
            if (std.mem.startsWith(u8, root_node.action_labels[i], "Bet")) break :blk i;
        }
        return error.TestUnexpectedResult;
    };
    const facing = root_node.child[bet];
    try std.testing.expect(game.nodes[facing].kind == .decision);
    try std.testing.expect(game.nodes[facing].player == 1);

    const empty = training_state.PublishedPolicy{ .allocator = std.testing.allocator };
    var at_root = try equity.checkdownEquityAtNode(
        std.testing.allocator,
        game,
        published,
        0,
        -1,
        -1,
        equity.default_max_pair_runouts,
    );
    defer at_root.deinit();
    var at_bet = try equity.checkdownEquityAtNode(
        std.testing.allocator,
        game,
        published,
        facing,
        -1,
        -1,
        equity.default_max_pair_runouts,
    );
    defer at_bet.deinit();
    try std.testing.expect(at_root.joint_defined);
    try std.testing.expect(at_bet.joint_defined);
    // Same five-card board, different reached OOP masses → aggregate equity must move.
    try std.testing.expect(@abs(at_root.player0.equity - at_bet.player0.equity) > 1e-6);
    _ = empty;
}

test "frozen OnCtx checkdown matches pair-enumeration at flop root" {
    const compile = @import("../game/compile.zig");
    const street_config = @import("../game/street_config.zig");
    const training_state = @import("../solve/training_state.zig");
    const frozen_walk = @import("../solve/frozen_walk.zig");
    const text =
        \\street-config 1
        \\board Ah Kd 7c
        \\pot 100
        \\stack 100
        \\oop-range AcAd:1,KsKc:1
        \\ip-range QsQc:1,JsJc:1
        \\first-to-act 0
        \\max-raises 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 64
        \\threads 1
        \\
    ;
    var cfg = try street_config.parseStreetConfig(std.testing.allocator, text);
    defer cfg.deinit();
    var game = try compile.compile(std.testing.allocator, cfg);
    defer game.deinit();

    const empty_pub = training_state.PublishedPolicy{ .allocator = std.testing.allocator };
    var pair = try equity.checkdownEquityAtNode(
        std.testing.allocator,
        game,
        empty_pub,
        0,
        -1,
        -1,
        equity.study_explorer_max_pair_runouts,
    );
    defer pair.deinit();

    var ctx = try frozen_walk.FrozenCtx.initEval(std.testing.allocator, game);
    defer ctx.deinit();
    try ctx.ensureAllRanksReady();
    var frozen = try equity.checkdownEquityAtNodeOnCtx(
        std.testing.allocator,
        &ctx,
        game,
        empty_pub,
        0,
        -1,
        -1,
        equity.study_explorer_max_pair_runouts,
    );
    defer frozen.deinit();

    try std.testing.expect(pair.joint_defined);
    try std.testing.expect(frozen.joint_defined);
    try std.testing.expectEqual(pair.pair_runouts, frozen.pair_runouts);
    try std.testing.expectApproxEqAbs(pair.player0.equity, frozen.player0.equity, 1e-9);
    try std.testing.expectApproxEqAbs(pair.player1.equity, frozen.player1.equity, 1e-9);
    const aa_pair = findCombo(pair.player0.combos, "AcAd").?;
    const aa_frozen = findCombo(frozen.player0.combos, "AcAd").?;
    try std.testing.expect(aa_pair.defined and aa_frozen.defined);
    try std.testing.expectApproxEqAbs(aa_pair.equity, aa_frozen.equity, 1e-9);
}
