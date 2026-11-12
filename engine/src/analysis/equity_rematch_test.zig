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
        \\allow-all-in 0
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
