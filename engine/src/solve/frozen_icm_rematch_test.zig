//! Frozen CFR+ must wrap terminals with ICM (same as kernel / deal-by-deal).
//! Regression: chip-EV call that is −EV under multiway ICM must Fold, not Call.
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

fn bubbleConfig(allocator: std.mem.Allocator) !compile_mod.CompiledGame {
    // Pot 100 / stack 100. ICM stacks leave OOP covering pot/2+stack (=150) but
    // busting on a lost call. AK vs {QQ,JJ,99,77,66} = 2/5 = 40% equity on this board:
    // chips prefer Call (~+20), ICM prefers Fold (~−12 prize) — see docs/auxiliary/payoffs/ICM.md.
    const text =
        \\street-config 1
        \\board Tc 8d 5c 2h 2s
        \\pot 100
        \\stack 100
        \\oop-range AhKh:1
        \\ip-range QhQs:1,JhJd:1,9h9d:1,7h7d:1,6h6d:1
        \\ip-river-bets 1
        \\first-to-act 0
        \\max-raises 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\icm-stacks 150 1500 8350
        \\icm-payouts 50 30 20
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
    // Root: OOP Check → IP Bet → OOP Fold/Call decision.
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

test "chip call is +EV while ICM fold is +EV on bubble pin" {
    // Pins the economic setup independent of the solver walk.
    const stacks = [_]f64{ 150, 1500, 8350 };
    const payouts = [_]f64{ 50, 30, 20 };
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
    const equity: f64 = 0.4;
    const chip_call = equity * win_chips.utility[0] + (1.0 - equity) * lose_chips.utility[0];
    const icm_call = equity * win_icm.utility[0] + (1.0 - equity) * lose_icm.utility[0];
    try std.testing.expect(chip_call > fold_chips.utility[0] + 1.0);
    try std.testing.expect(icm_call < fold_icm.utility[0] - 1.0);
}

test "frozen eval matches deal-by-deal under ICM" {
    var game = try bubbleConfig(std.testing.allocator);
    defer game.deinit();
    try std.testing.expect(game.icm_stacks.len == 3);

    var state = try training_state.TrainingState.init(std.testing.allocator, game);
    defer state.deinit();
    // Uniform published average (no train) — isolates the terminal wrap.
    const frozen_u = try frozen_walk.evaluatePublishedFrozen(std.testing.allocator, game, state.sigma);
    const deal_u = try traversal.rootValue(std.testing.allocator, game, state.sigma);
    try std.testing.expectApproxEqAbs(deal_u, frozen_u.u0, 1e-7);
}

test "frozen CFR+ folds chip-+EV call under multiway ICM" {
    var game = try bubbleConfig(std.testing.allocator);
    defer game.deinit();
    const facing = try findFacingShoveNode(game);
    const ip_bet_node = game.nodes[facing].parent;
    try std.testing.expect(ip_bet_node >= 0);

    // Lock IP to always pot-bet after OOP's check so hero faces the shove every deal.
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
    // Without ICM wrap, chip EV trains toward Call; with ICM, Fold must dominate.
    try std.testing.expect(fold_p > 0.9);
    try std.testing.expect(call_p < 0.1);
}
