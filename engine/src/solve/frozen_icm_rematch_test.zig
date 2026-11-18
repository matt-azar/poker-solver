//! Frozen CFR+ must wrap terminals with correct ICM (paid bust place + cache).
//! Regression: chip-EV Call that is −EV under multiway ICM must Fold, not Call.
const std = @import("std");
const compile_mod = @import("../game/compile.zig");
const street_config = @import("../game/street_config.zig");
const training_state = @import("training_state.zig");
const frozen_walk = @import("frozen_walk.zig");
const traversal = @import("traversal.zig");
const node_lock = @import("node_lock.zig");
const inspect = @import("../analysis/inspect.zig");
const icm = @import("../poker/icm.zig");
const payoff = @import("../poker/payoff.zig");
const chips = @import("../poker/chips.zig");
const card = @import("../poker/card.zig");
const hand_eval = @import("../poker/hand_eval.zig");

fn bubbleConfig(allocator: std.mem.Allocator) !compile_mod.CompiledGame {
    // Pot 100 / stack 100. Stacks 150/9820/30, prizes 50/50/0.
    // Board Tc8d5c2h2s: AhKh loses to QQ/JJ/99, wins vs QhJs and 9h7d → 2/5 = 40%.
    // Chips: Call −30 vs Fold −50 (+20 to Call). Prize EV: Fold ≈ 38.463 vs Call ≈ 18.184.
    const text =
        \\street-config 1
        \\board Tc 8d 5c 2h 2s
        \\pot 100
        \\stack 100
        \\oop-range AhKh:1
        \\ip-range QcQs:1,JcJd:1,9c9d:1,QhJs:1,9h7d:1
        \\ip-river-bets 1
        \\first-to-act 0
        \\max-raises 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\icm-stacks 150 9820 30
        \\icm-payouts 50 50 0
        \\memory-mib 64
        \\threads 1
        \\
    ;
    var spec = try street_config.parseStreetConfig(allocator, text);
    defer spec.deinit();
    return compile_mod.compile(allocator, spec);
}

fn actionProb(page: inspect.NodePage, combo: []const u8, action_prefix: []const u8) !f64 {
    var hand_i: ?usize = null;
    for (page.combos, 0..) |c, i| {
        if (std.mem.eql(u8, c, combo)) hand_i = i;
    }
    try std.testing.expect(hand_i != null);
    var action_i: ?usize = null;
    for (page.actions, 0..) |label, i| {
        if (std.mem.startsWith(u8, label, action_prefix)) action_i = i;
    }
    try std.testing.expect(action_i != null);
    return @as(f64, page.strategy[hand_i.? * page.n_actions + action_i.?]);
}

fn findFacingShoveNode(game: compile_mod.CompiledGame) !u32 {
    try std.testing.expect(game.nodes[0].kind == .decision);
    try std.testing.expectEqual(@as(i32, 0), game.nodes[0].player);
    const after_check = game.nodes[0].child[0];
    try std.testing.expect(game.nodes[after_check].kind == .decision);
    try std.testing.expectEqual(@as(i32, 1), game.nodes[after_check].player);
    var bet_action: ?usize = null;
    for (game.nodes[after_check].action_labels[0..game.nodes[after_check].n_actions], 0..) |label, i| {
        if (std.mem.startsWith(u8, label, "Bet") or std.mem.startsWith(u8, label, "All")) {
            bet_action = i;
        }
    }
    try std.testing.expect(bet_action != null);
    const facing = game.nodes[after_check].child[bet_action.?];
    try std.testing.expect(game.nodes[facing].kind == .decision);
    try std.testing.expectEqual(@as(i32, 0), game.nodes[facing].player);
    try std.testing.expect(game.nodes[facing].n_actions >= 2);
    return facing;
}

fn showdownWins(hero: [2]card.Card, villain: [2]card.Card, board: [5]card.Card) !bool {
    const cmp = try hand_eval.compareShowdown(hero[0], hero[1], villain[0], villain[1], &board);
    return cmp > 0;
}

test "bubble fixture is exactly 40 percent equity for AhKh" {
    const board = [_]card.Card{
        try card.parseCard("Tc"),
        try card.parseCard("8d"),
        try card.parseCard("5c"),
        try card.parseCard("2h"),
        try card.parseCard("2s"),
    };
    const hero = [_]card.Card{ try card.parseCard("Ah"), try card.parseCard("Kh") };
    const villains = [_][2]card.Card{
        .{ try card.parseCard("Qc"), try card.parseCard("Qs") },
        .{ try card.parseCard("Jc"), try card.parseCard("Jd") },
        .{ try card.parseCard("9c"), try card.parseCard("9d") },
        .{ try card.parseCard("Qh"), try card.parseCard("Js") },
        .{ try card.parseCard("9h"), try card.parseCard("7d") },
    };
    var wins: usize = 0;
    for (villains) |v| {
        if (try showdownWins(hero, v, board)) wins += 1;
    }
    try std.testing.expectEqual(@as(usize, 2), wins);
    try std.testing.expectEqual(@as(usize, 5), villains.len);
}

test "chip call is +EV while ICM fold is +EV on bubble pin" {
    const stacks = [_]f64{ 150, 9820, 30 };
    const payouts = [_]f64{ 50, 50, 0 };
    const cfg = icm.IcmConfig{ .stacks = &stacks, .payouts = &payouts };
    const fold_chips = try payoff.chipTerminal(chips.chipUnits(100), 0, chips.chipUnits(100), 0, 0, .{});
    const win_chips = try payoff.chipTerminal(chips.chipUnits(100), chips.chipUnits(100), chips.chipUnits(100), -1, 1, .{});
    const lose_chips = try payoff.chipTerminal(chips.chipUnits(100), chips.chipUnits(100), chips.chipUnits(100), -1, -1, .{});
    try std.testing.expectApproxEqAbs(@as(f64, -50.0), fold_chips.utility[0], 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, 150.0), win_chips.utility[0], 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, -150.0), lose_chips.utility[0], 1e-9);

    const fold_icm = try icm.applyIcmTerminal(std.testing.allocator, cfg, fold_chips);
    const win_icm = try icm.applyIcmTerminal(std.testing.allocator, cfg, win_chips);
    const lose_icm = try icm.applyIcmTerminal(std.testing.allocator, cfg, lose_chips);

    const pre = try icm.icmEquities(std.testing.allocator, &stacks, &payouts);
    defer std.testing.allocator.free(pre);
    const fold_prize = pre[0] + fold_icm.utility[0];
    const call_prize = pre[0] + 0.4 * win_icm.utility[0] + 0.6 * lose_icm.utility[0];
    try std.testing.expectApproxEqAbs(@as(f64, 38.463042975079084), fold_prize, 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, 18.183623598066927), call_prize, 1e-9);

    const chip_call = 0.4 * win_chips.utility[0] + 0.6 * lose_chips.utility[0];
    try std.testing.expectApproxEqAbs(@as(f64, -30.0), chip_call, 1e-9);
    try std.testing.expect(chip_call > fold_chips.utility[0] + 19.0);
    try std.testing.expect(call_prize < fold_prize - 1.0);
}

test "frozen eval matches deal-by-deal under ICM" {
    var game = try bubbleConfig(std.testing.allocator);
    defer game.deinit();
    try std.testing.expect(game.icm_stacks.len == 3);

    var state = try training_state.TrainingState.init(std.testing.allocator, game);
    defer state.deinit();
    const frozen_u = try frozen_walk.evaluatePublishedFrozen(std.testing.allocator, game, state.sigma);
    const deal_u = try traversal.rootValue(std.testing.allocator, game, state.sigma);
    try std.testing.expectApproxEqAbs(deal_u, frozen_u.u0, 1e-7);
}

test "FrozenCtx warms distinct ICM terminal payoffs before walk" {
    var game = try bubbleConfig(std.testing.allocator);
    defer game.deinit();
    var state = try training_state.TrainingState.init(std.testing.allocator, game);
    defer state.deinit();
    var ctx = try frozen_walk.FrozenCtx.init(std.testing.allocator, game, &state);
    defer ctx.deinit();
    try std.testing.expect(ctx.icm_cache.active);
    try std.testing.expect(ctx.icm_cache.miss_count > 0);
    try std.testing.expect(ctx.icm_cache.pre_eq.len == 3);
    // Second warm of the same fold/showdown chips must hit.
    const before = ctx.icm_cache.miss_count;
    for (game.nodes) |node| {
        if (node.kind != .terminal) continue;
        if (node.folded >= 0) {
            const chips_pay = try payoff.chipTerminal(game.pot, node.contrib[0], node.contrib[1], node.folded, 0, game.rake);
            try std.testing.expect(ctx.icm_cache.get(chips_pay) != null);
        } else {
            inline for (.{ @as(i32, 1), @as(i32, -1), @as(i32, 0) }) |outcome| {
                const chips_pay = try payoff.chipTerminal(game.pot, node.contrib[0], node.contrib[1], -1, outcome, game.rake);
                try std.testing.expect(ctx.icm_cache.get(chips_pay) != null);
            }
        }
    }
    try std.testing.expectEqual(before, ctx.icm_cache.miss_count);
}

test "frozen CFR+ folds chip-+EV call under multiway ICM" {
    var game = try bubbleConfig(std.testing.allocator);
    defer game.deinit();
    const facing = try findFacingShoveNode(game);
    const ip_bet_node = game.nodes[facing].parent;
    try std.testing.expect(ip_bet_node >= 0);

    var locks = node_lock.LockSet.init(std.testing.allocator);
    defer locks.deinit();
    const ip_node = game.nodes[@intCast(ip_bet_node)];
    try std.testing.expectEqual(@as(i32, 1), ip_node.player);
    var bet_row = try std.testing.allocator.alloc(f64, ip_node.n_actions);
    defer std.testing.allocator.free(bet_row);
    @memset(bet_row, 0);
    var bet_i: ?usize = null;
    for (ip_node.action_labels[0..ip_node.n_actions], 0..) |label, i| {
        if (std.mem.startsWith(u8, label, "Bet") or std.mem.startsWith(u8, label, "All")) bet_i = i;
    }
    try std.testing.expect(bet_i != null);
    bet_row[bet_i.?] = 1.0;
    try locks.upsert(.{
        .infoset_id = @intCast(ip_bet_node),
        .kind = .full_node,
        .actions = try node_lock.makeActionLockRow(std.testing.allocator, bet_row, ip_node.n_actions),
    });

    var state = try training_state.TrainingState.init(std.testing.allocator, game);
    defer state.deinit();
    var published = try frozen_walk.trainFrozenCfrPlus(std.testing.allocator, game, &state, 200, &locks);
    defer published.deinit();

    var page = try inspect.inspectNode(std.testing.allocator, game, published, facing, -1, -1);
    defer page.deinit();
    const fold_p = try actionProb(page, "AhKh", "Fold");
    const call_p = try actionProb(page, "AhKh", "Call");
    try std.testing.expect(fold_p > 0.9);
    try std.testing.expect(call_p < 0.1);
}
