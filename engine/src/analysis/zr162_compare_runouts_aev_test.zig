//! ZR-162: Compare-runouts EV must stay defined when some hero hands are
//! removed by the query river (card collision). Equity already stays defined;
//! deal-by-deal action EV incorrectly cleared `node_ev_defined` for those rivers.
const std = @import("std");
const card = @import("../poker/card.zig");
const compile = @import("../game/compile.zig");
const street_config = @import("../game/street_config.zig");
const training_state = @import("../solve/training_state.zig");
const action_ev = @import("action_ev.zig");
const equity = @import("equity.zig");
const node_id = @import("node_id.zig");

fn turnBoardRiverRootConfig(allocator: std.mem.Allocator) !compile.CompiledGame {
    // Owner-shaped board Ah Ks 7s 9s + river vary. Premium-ish range so Q/K/A
    // rivers collide with hole cards while 2–J often do not — the Compare
    // truncation pattern (Equity OK, EV blank from selected broadway rank up).
    const text =
        \\street-config 1
        \\board Ah Ks 7s 9s
        \\pot 100
        \\stack 100
        \\oop-range QcQd:1,KcKd:1,AcAd:1,2c2d:1
        \\ip-range JcJd:1,TcTd:1,3c3d:1
        \\oop-bets 0.5
        \\ip-bets 0.5
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
    var spec = try street_config.parseStreetConfig(allocator, text);
    defer spec.deinit();
    return compile.compile(allocator, spec);
}

fn findRiverRoot(game: compile.CompiledGame) !u32 {
    const root = game.nodes[0];
    try std.testing.expect(root.kind == .decision);
    var check0: ?u32 = null;
    var a: usize = 0;
    while (a < root.n_actions) : (a += 1) {
        if (std.mem.startsWith(u8, root.action_labels[a], "Check")) {
            check0 = root.child[a];
            break;
        }
    }
    const after_oop = check0 orelse return error.TestUnexpectedResult;
    const ip = game.nodes[after_oop];
    var check1: ?u32 = null;
    a = 0;
    while (a < ip.n_actions) : (a += 1) {
        if (std.mem.startsWith(u8, ip.action_labels[a], "Check")) {
            check1 = ip.child[a];
            break;
        }
    }
    const chance_idx = check1 orelse return error.TestUnexpectedResult;
    try std.testing.expect(game.nodes[chance_idx].kind == .chance);
    return game.nodes[chance_idx].child[0];
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

fn locateRiver(game: compile.CompiledGame, river_root: u32, river: i32) !node_id.ParsedNodeId {
    var buf: [64]u8 = undefined;
    const id = try std.fmt.bufPrint(&buf, "p{d}.t-1.r{d}", .{ river_root, river });
    return node_id.locateNode(game, id);
}

test "ZR-162 river card-removal keeps node_ev_defined (Q/K/A)" {
    var game = try turnBoardRiverRootConfig(std.testing.allocator);
    defer game.deinit();
    try std.testing.expectEqual(@as(usize, 4), game.board.len);
    const river_root = try findRiverRoot(game);
    try std.testing.expect(game.nodes[river_root].card_mode == 1);
    try std.testing.expect(game.nodes[river_root].player == 0);
    var published = try uniformPublished(std.testing.allocator, game);
    defer published.deinit();

    // Rivers that collide with OOP hole cards in this fixture.
    const colliding = [_][]const u8{ "Qc", "Qd", "Kc", "Kd", "Ac", "Ad", "2c", "2d" };
    for (colliding) |label| {
        const river = try card.parseCard(label);
        const located = try locateRiver(game, river_root, river);

        var page = try action_ev.actionValues(
            std.testing.allocator,
            game,
            published,
            located.node_index,
            located.turn,
            located.river,
        );
        defer page.deinit();
        try std.testing.expect(page.reach_defined);
        try std.testing.expect(page.node_ev_defined);
        try std.testing.expect(std.math.isFinite(page.node_ev));

        // Colliding hero hand stays undefined; survivors keep per-hand EV.
        var any_defined: bool = false;
        var any_undefined: bool = false;
        for (page.ev_defined) |flag| {
            if (flag != 0) any_defined = true else any_undefined = true;
        }
        try std.testing.expect(any_defined);
        try std.testing.expect(any_undefined);

        var eq = try equity.checkdownEquityAtNode(
            std.testing.allocator,
            game,
            published,
            located.node_index,
            located.turn,
            located.river,
            equity.study_explorer_max_pair_runouts,
        );
        defer eq.deinit();
        try std.testing.expect(eq.joint_defined);
    }
}

test "ZR-162 actionValues defined for every legal river" {
    var game = try turnBoardRiverRootConfig(std.testing.allocator);
    defer game.deinit();
    const river_root = try findRiverRoot(game);
    var published = try uniformPublished(std.testing.allocator, game);
    defer published.deinit();

    var failed_aev: usize = 0;
    var failed_eq: usize = 0;
    var ok_aev: usize = 0;
    var c: i32 = 0;
    while (c < 52) : (c += 1) {
        var on_board = false;
        for (game.board) |b| {
            if (b == c) on_board = true;
        }
        if (on_board) continue;

        const located = locateRiver(game, river_root, c) catch {
            failed_aev += 1;
            failed_eq += 1;
            continue;
        };

        var page = action_ev.actionValues(
            std.testing.allocator,
            game,
            published,
            located.node_index,
            located.turn,
            located.river,
        ) catch {
            failed_aev += 1;
            continue;
        };
        defer page.deinit();
        if (!page.node_ev_defined) {
            failed_aev += 1;
        } else {
            ok_aev += 1;
        }

        var eq = equity.checkdownEquityAtNode(
            std.testing.allocator,
            game,
            published,
            located.node_index,
            located.turn,
            located.river,
            equity.study_explorer_max_pair_runouts,
        ) catch {
            failed_eq += 1;
            continue;
        };
        defer eq.deinit();
        if (!eq.joint_defined) failed_eq += 1;
    }
    try std.testing.expectEqual(@as(usize, 0), failed_aev);
    try std.testing.expectEqual(@as(usize, 0), failed_eq);
    try std.testing.expect(ok_aev >= 40);
}
