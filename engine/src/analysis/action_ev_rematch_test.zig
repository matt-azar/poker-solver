//! Action-EV rematch pins vs tip C++ `tests/unit/test_action_ev.cpp`
//! (`test_river_bluff_fixture`, `test_local_offset_includes_street_contrib_after_call`,
//! flop→turn card_mode≠0 reach conditioning).
const std = @import("std");
const compile = @import("../game/compile.zig");
const street_config = @import("../game/street_config.zig");
const training_state = @import("../solve/training_state.zig");
const range_mod = @import("../poker/range.zig");
const card = @import("../poker/card.zig");
const action_ev = @import("action_ev.zig");

fn sameComboLabel(got: []const u8, a: []const u8, b: []const u8) bool {
    // comboText may emit either suit order for pairs / unordered labels.
    if (got.len != 4 or a.len != 2 or b.len != 2) return false;
    const g0 = got[0..2];
    const g1 = got[2..4];
    return (std.mem.eql(u8, g0, a) and std.mem.eql(u8, g1, b)) or
        (std.mem.eql(u8, g0, b) and std.mem.eql(u8, g1, a));
}

fn findHand(combos: []const []const u8, c0: []const u8, c1: []const u8) ?usize {
    for (combos, 0..) |label, i| {
        if (sameComboLabel(label, c0, c1)) return i;
    }
    return null;
}

fn findAction(actions: []const []const u8, prefix: []const u8) ?usize {
    for (actions, 0..) |label, i| {
        if (std.mem.startsWith(u8, label, prefix)) return i;
    }
    return null;
}

fn findGameHand(game: compile.CompiledGame, player: usize, c0: []const u8, c1: []const u8) !usize {
    const want = try range_mod.Range.comboIndex(try card.parseCard(c0), try card.parseCard(c1));
    for (game.hands.combos[player], 0..) |combo, i| {
        if (combo == want) return i;
    }
    return error.TestUnexpectedResult;
}

fn pageAction(page: action_ev.ActionValues, hand: usize, action: usize) f64 {
    return page.action_ev[hand * page.actions.len + action];
}

fn uniformPublished(allocator: std.mem.Allocator, game: compile.CompiledGame) !training_state.PublishedPolicy {
    var state = try training_state.TrainingState.init(allocator, game);
    defer state.deinit();
    var published = training_state.PublishedPolicy{
        .allocator = allocator,
        .revision = 1,
        .trained = 0,
    };
    if (state.sigma.len == 0) return published;
    published.average = try allocator.dupe(f32, state.sigma);
    return published;
}

const NamedProb = struct { prefix: []const u8, p: f32 };

fn setNamedAverage(
    game: compile.CompiledGame,
    average: []f32,
    node_index: u32,
    hand: usize,
    turn: i32,
    river: i32,
    named: []const NamedProb,
) !void {
    const node = game.nodes[node_index];
    if (node.kind != .decision or node.n_actions <= 1) return error.TestUnexpectedResult;
    const key = try game.cardKey(node, @intCast(hand), turn, river);
    if (key < 0 or @as(usize, @intCast(key)) >= node.slot_of.len) return error.TestUnexpectedResult;
    const slot_i = node.slot_of[@intCast(key)];
    if (slot_i < 0) return error.TestUnexpectedResult;
    const base: usize = @intCast(game.slots[@intCast(slot_i)].base);
    @memset(average[base .. base + node.n_actions], 0);
    for (named) |item| {
        const action = findAction(node.action_labels[0..node.n_actions], item.prefix) orelse return error.TestUnexpectedResult;
        average[base + action] = item.p;
    }
}

fn riverBluffConfig(allocator: std.mem.Allocator) !compile.CompiledGame {
    const text =
        \\street-config 1
        \\board Kh Kd 7c 4s 2h
        \\pot 100
        \\stack 100
        \\oop-range KcKs:1,2c3d:1
        \\ip-range AhAd:1
        \\oop-river-bets 1
        \\first-to-act 0
        \\max-raises 1
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
    var spec = try street_config.parseStreetConfig(allocator, text);
    defer spec.deinit();
    return compile.compile(allocator, spec);
}

fn installRiverBluff(
    game: compile.CompiledGame,
    average: []f32,
    air_shove: f32,
    ip_call: f32,
) !u32 {
    const nuts = try findGameHand(game, 0, "Kc", "Ks");
    const air = try findGameHand(game, 0, "2c", "3d");
    const aces = try findGameHand(game, 1, "Ah", "Ad");
    try setNamedAverage(game, average, 0, nuts, -1, -1, &.{
        .{ .prefix = "Check", .p = 0.0 },
        .{ .prefix = "Bet", .p = 1.0 },
    });
    try setNamedAverage(game, average, 0, air, -1, -1, &.{
        .{ .prefix = "Check", .p = 1.0 - air_shove },
        .{ .prefix = "Bet", .p = air_shove },
    });
    const root = game.nodes[0];
    const bet = findAction(root.action_labels[0..root.n_actions], "Bet") orelse return error.TestUnexpectedResult;
    const facing: u32 = root.child[bet];
    try setNamedAverage(game, average, facing, aces, -1, -1, &.{
        .{ .prefix = "Fold", .p = 1.0 - ip_call },
        .{ .prefix = "Call", .p = ip_call },
    });
    return facing;
}

test "river bluff fixture action-EV rematch pins" {
    var game = try riverBluffConfig(std.testing.allocator);
    defer game.deinit();
    var published = try uniformPublished(std.testing.allocator, game);
    defer published.deinit();
    const facing = try installRiverBluff(game, published.average, 0.5, 0.5);

    // Rematch uses deal-by-deal conditional EV (C++ StreetBatch oracle semantics).
    // Root frozen response_walk aev is a Study latency path — not this pin.
    var page = try action_ev.actionValuesDealByDeal(std.testing.allocator, game, published, 0, -1, -1);
    defer page.deinit();
    const nuts = findHand(page.combos, "Kc", "Ks") orelse return error.TestUnexpectedResult;
    const air = findHand(page.combos, "2c", "3d") orelse return error.TestUnexpectedResult;
    const check = findAction(page.actions, "Check") orelse return error.TestUnexpectedResult;
    const shove = findAction(page.actions, "Bet") orelse return error.TestUnexpectedResult;
    try std.testing.expect(page.ev_defined[nuts] == 1);
    try std.testing.expect(page.ev_defined[air] == 1);
    try std.testing.expectApproxEqAbs(@as(f64, 50.0), pageAction(page, nuts, check), 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, 100.0), pageAction(page, nuts, shove), 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, -50.0), pageAction(page, air, check), 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, -50.0), pageAction(page, air, shove), 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, 100.0), page.mixed_ev[nuts], 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, -50.0), page.mixed_ev[air], 1e-9);
    try std.testing.expect(page.node_ev_defined);
    try std.testing.expectApproxEqAbs(@as(f64, 25.0), page.node_ev, 1e-9);
    try std.testing.expect(page.reach_defined);

    var response = try action_ev.actionValuesDealByDeal(std.testing.allocator, game, published, facing, -1, -1);
    defer response.deinit();
    const aces = findHand(response.combos, "Ah", "Ad") orelse return error.TestUnexpectedResult;
    const fold = findAction(response.actions, "Fold") orelse return error.TestUnexpectedResult;
    const call = findAction(response.actions, "Call") orelse return error.TestUnexpectedResult;
    try std.testing.expect(response.player == 1);
    try std.testing.expect(response.ev_defined[aces] == 1);
    try std.testing.expectApproxEqAbs(@as(f64, -50.0), pageAction(response, aces, fold), 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, -50.0), pageAction(response, aces, call), 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, 50.0), response.local_offset, 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, 0.0), pageAction(response, aces, fold) + response.local_offset, 1e-9);
}

test "river bluff pure air-check facing EV rematch" {
    var game = try riverBluffConfig(std.testing.allocator);
    defer game.deinit();
    var published = try uniformPublished(std.testing.allocator, game);
    defer published.deinit();
    const facing = try installRiverBluff(game, published.average, 0.0, 0.0);

    var forced = try action_ev.actionValuesDealByDeal(std.testing.allocator, game, published, facing, -1, -1);
    defer forced.deinit();
    const aces = findHand(forced.combos, "Ah", "Ad") orelse return error.TestUnexpectedResult;
    const fold = findAction(forced.actions, "Fold") orelse return error.TestUnexpectedResult;
    const call = findAction(forced.actions, "Call") orelse return error.TestUnexpectedResult;
    try std.testing.expect(forced.ev_defined[aces] == 1);
    try std.testing.expectApproxEqAbs(@as(f64, -50.0), pageAction(forced, aces, fold), 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, -150.0), pageAction(forced, aces, call), 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, -50.0), forced.mixed_ev[aces], 1e-9);
}

test "local_offset includes street contrib after bet+call" {
    // Root pot 100. OOP bets half-pot (50), IP calls → both contrib 50.
    // Next-street decision local_offset must be half_pot + actor_contrib = 100 (#184).
    const text =
        \\street-config 1
        \\board Kh 7d 2c
        \\pot 100
        \\stack 1000
        \\oop-range AhAd:1
        \\ip-range KcKd:1
        \\oop-bets 0.5
        \\ip-bets 0.5
        \\oop-turn-bets 0.5
        \\ip-turn-bets 0.5
        \\first-to-act 0
        \\max-raises 1
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
    var spec = try street_config.parseStreetConfig(std.testing.allocator, text);
    defer spec.deinit();
    var game = try compile.compile(std.testing.allocator, spec);
    defer game.deinit();

    const root = game.nodes[0];
    const bet = findAction(root.action_labels[0..root.n_actions], "Bet") orelse return error.TestUnexpectedResult;
    const facing_idx: u32 = root.child[bet];
    const facing = game.nodes[facing_idx];
    try std.testing.expect(facing.player == 1);
    // Contrib is tenths: 50 chips → 500.
    try std.testing.expectEqual(@as(i32, 500), facing.contrib[0]);
    try std.testing.expectEqual(@as(i32, 0), facing.contrib[1]);
    const call = findAction(facing.action_labels[0..facing.n_actions], "Call") orelse return error.TestUnexpectedResult;

    var cursor: u32 = facing.child[call];
    while (true) {
        const node = game.nodes[cursor];
        if (node.kind == .decision) break;
        if (node.kind == .chance) {
            cursor = node.child[0];
            continue;
        }
        return error.TestUnexpectedResult;
    }
    const turn_decision = game.nodes[cursor];
    try std.testing.expect(turn_decision.kind == .decision);
    try std.testing.expectEqual(@as(i32, 500), turn_decision.contrib[0]);
    try std.testing.expectEqual(@as(i32, 500), turn_decision.contrib[1]);

    var published = try uniformPublished(std.testing.allocator, game);
    defer published.deinit();
    const oop = try findGameHand(game, 0, "Ah", "Ad");
    const ip = try findGameHand(game, 1, "Kc", "Kd");
    try setNamedAverage(game, published.average, 0, oop, -1, -1, &.{.{ .prefix = "Bet", .p = 1.0 }});
    try setNamedAverage(game, published.average, facing_idx, ip, -1, -1, &.{.{ .prefix = "Call", .p = 1.0 }});

    // Pick a concrete turn card for deal-by-deal (card_mode ≠ 0 at next street).
    var blocked: [52]bool = .{false} ** 52;
    for (game.board) |c| blocked[@intCast(c)] = true;
    blocked[@intCast(game.hands.hole_low[0][oop])] = true;
    blocked[@intCast(game.hands.hole_high[0][oop])] = true;
    blocked[@intCast(game.hands.hole_low[1][ip])] = true;
    blocked[@intCast(game.hands.hole_high[1][ip])] = true;
    var turn_card: i32 = -1;
    var c: i32 = 0;
    while (c < 52) : (c += 1) {
        if (!blocked[@intCast(c)]) {
            turn_card = c;
            break;
        }
    }
    try std.testing.expect(turn_card >= 0);

    var page = try action_ev.actionValues(std.testing.allocator, game, published, cursor, turn_card, -1);
    defer page.deinit();
    try std.testing.expectApproxEqAbs(@as(f64, 100.0), page.local_offset, 1e-9);
    if (findAction(page.actions, "Fold")) |fold| {
        var hand: usize = 0;
        while (hand < page.combos.len) : (hand += 1) {
            if (page.ev_defined[hand] == 0) continue;
            try std.testing.expectApproxEqAbs(@as(f64, 0.0), pageAction(page, hand, fold) + page.local_offset, 1e-6);
        }
    }
}

test "root local_offset is half pot with zero contrib" {
    var game = try riverBluffConfig(std.testing.allocator);
    defer game.deinit();
    var published = try uniformPublished(std.testing.allocator, game);
    defer published.deinit();
    _ = try installRiverBluff(game, published.average, 0.5, 0.5);
    var page = try action_ev.actionValues(std.testing.allocator, game, published, 0, -1, -1);
    defer page.deinit();
    try std.testing.expectEqual(@as(i32, 0), game.nodes[0].contrib[0]);
    try std.testing.expectApproxEqAbs(@as(f64, 50.0), page.local_offset, 1e-9);
}

fn flopCheckOnlyTurnBluffConfig(allocator: std.mem.Allocator) !compile.CompiledGame {
    // Flop check-only (`oop-bets -` / `ip-bets -`), then turn pot-bet — same chip
    // numbers as river/turn bluff once turn=4s is fixed (C++ turn_bluff board).
    const text =
        \\street-config 1
        \\board Kh Kd 7c
        \\pot 100
        \\stack 100
        \\oop-range KcKs:1,2c3d:1
        \\ip-range AhAd:1
        \\oop-bets -
        \\ip-bets -
        \\oop-turn-bets 1
        \\first-to-act 0
        \\max-raises 1
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
    var spec = try street_config.parseStreetConfig(allocator, text);
    defer spec.deinit();
    return compile.compile(allocator, spec);
}

/// Walk chance + single-action decisions until the next multi-action decision.
fn firstMultiActionDecision(game: compile.CompiledGame, start: u32) !u32 {
    var cursor = start;
    var guard: usize = 0;
    while (guard < 16) : (guard += 1) {
        const node = game.nodes[cursor];
        if (node.kind == .terminal) return error.TestUnexpectedResult;
        if (node.kind == .decision and node.n_actions > 1) return cursor;
        cursor = node.child[0];
    }
    return error.TestUnexpectedResult;
}

fn installFlopTurnBluff(
    game: compile.CompiledGame,
    average: []f32,
    turn: i32,
    air_shove: f32,
    ip_call: f32,
) !struct { turn_root: u32, facing: u32 } {
    // Flop is check-only: walk root Check → IP Check → chance → turn OOP (card_mode 1).
    try std.testing.expect(game.nodes[0].n_actions <= 1);
    const turn_root = try firstMultiActionDecision(game, 0);
    const turn_node = game.nodes[turn_root];
    try std.testing.expect(turn_node.kind == .decision);
    try std.testing.expect(turn_node.player == 0);
    try std.testing.expect(turn_node.street == 1);
    try std.testing.expect(turn_node.card_mode == 1);
    try std.testing.expect(turn_node.mode1_is_turn);

    const nuts = try findGameHand(game, 0, "Kc", "Ks");
    const air = try findGameHand(game, 0, "2c", "3d");
    const aces = try findGameHand(game, 1, "Ah", "Ad");
    try setNamedAverage(game, average, turn_root, nuts, turn, -1, &.{
        .{ .prefix = "Check", .p = 0.0 },
        .{ .prefix = "Bet", .p = 1.0 },
    });
    try setNamedAverage(game, average, turn_root, air, turn, -1, &.{
        .{ .prefix = "Check", .p = 1.0 - air_shove },
        .{ .prefix = "Bet", .p = air_shove },
    });
    const bet = findAction(turn_node.action_labels[0..turn_node.n_actions], "Bet") orelse return error.TestUnexpectedResult;
    const facing: u32 = turn_node.child[bet];
    try std.testing.expect(game.nodes[facing].card_mode == 1);
    try setNamedAverage(game, average, facing, aces, turn, -1, &.{
        .{ .prefix = "Fold", .p = 1.0 - ip_call },
        .{ .prefix = "Call", .p = ip_call },
    });
    return .{ .turn_root = turn_root, .facing = facing };
}

test "flop-scale turn bluff mode≠0 reach rematch pins" {
    // Same Q pins as river/turn bluff, but path includes card_mode=1 decisions so
    // deal-by-deal must weight q_opp with turn-keyed slots (ZR-53 residual).
    var game = try flopCheckOnlyTurnBluffConfig(std.testing.allocator);
    defer game.deinit();
    const turn = try card.parseCard("4s");
    var published = try uniformPublished(std.testing.allocator, game);
    defer published.deinit();
    const nodes = try installFlopTurnBluff(game, published.average, turn, 0.5, 0.5);

    var page = try action_ev.actionValuesDealByDeal(std.testing.allocator, game, published, nodes.turn_root, turn, -1);
    defer page.deinit();
    const nuts = findHand(page.combos, "Kc", "Ks") orelse return error.TestUnexpectedResult;
    const air = findHand(page.combos, "2c", "3d") orelse return error.TestUnexpectedResult;
    const check = findAction(page.actions, "Check") orelse return error.TestUnexpectedResult;
    const shove = findAction(page.actions, "Bet") orelse return error.TestUnexpectedResult;
    try std.testing.expect(page.ev_defined[nuts] == 1);
    try std.testing.expect(page.ev_defined[air] == 1);
    try std.testing.expectApproxEqAbs(@as(f64, 50.0), pageAction(page, nuts, check), 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, 100.0), pageAction(page, nuts, shove), 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, -50.0), pageAction(page, air, check), 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, -50.0), pageAction(page, air, shove), 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, 100.0), page.mixed_ev[nuts], 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, -50.0), page.mixed_ev[air], 1e-9);
    try std.testing.expect(page.node_ev_defined);
    try std.testing.expectApproxEqAbs(@as(f64, 25.0), page.node_ev, 1e-9);

    var response = try action_ev.actionValuesDealByDeal(std.testing.allocator, game, published, nodes.facing, turn, -1);
    defer response.deinit();
    const aces = findHand(response.combos, "Ah", "Ad") orelse return error.TestUnexpectedResult;
    const fold = findAction(response.actions, "Fold") orelse return error.TestUnexpectedResult;
    const call = findAction(response.actions, "Call") orelse return error.TestUnexpectedResult;
    try std.testing.expect(response.player == 1);
    try std.testing.expect(response.ev_defined[aces] == 1);
    try std.testing.expectApproxEqAbs(@as(f64, -50.0), pageAction(response, aces, fold), 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, -50.0), pageAction(response, aces, call), 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, 50.0), response.local_offset, 1e-9);
}

test "flop-scale pure air-check facing EV needs mode≠0 q_opp" {
    // Without opponentBettingReach on card_mode=1 path, Call averages Check mass → ~0
    // instead of −150 (same trap as river ZR-44, now on flop→turn).
    var game = try flopCheckOnlyTurnBluffConfig(std.testing.allocator);
    defer game.deinit();
    const turn = try card.parseCard("4s");
    var published = try uniformPublished(std.testing.allocator, game);
    defer published.deinit();
    const nodes = try installFlopTurnBluff(game, published.average, turn, 0.0, 0.0);

    var forced = try action_ev.actionValuesDealByDeal(std.testing.allocator, game, published, nodes.facing, turn, -1);
    defer forced.deinit();
    const aces = findHand(forced.combos, "Ah", "Ad") orelse return error.TestUnexpectedResult;
    const fold = findAction(forced.actions, "Fold") orelse return error.TestUnexpectedResult;
    const call = findAction(forced.actions, "Call") orelse return error.TestUnexpectedResult;
    try std.testing.expect(forced.ev_defined[aces] == 1);
    try std.testing.expectApproxEqAbs(@as(f64, -50.0), pageAction(forced, aces, fold), 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, -150.0), pageAction(forced, aces, call), 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, -50.0), forced.mixed_ev[aces], 1e-9);
}
