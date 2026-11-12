//! Public-tree arity / label pins vs tip C++ plan-only dumps (parity dig 2026-11-12).
//! Decision lines match C++ `public_tree()` display labels exactly on these fixtures.
const std = @import("std");
const street_config = @import("street_config.zig");
const compile = @import("compile.zig");

// ZR-94 apply / unapplied-report pins (separate file; pulled in via this suite).
comptime {
    _ = @import("tree_edit_apply_test.zig");
}

fn decisionFingerprint(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
) ![]const u8 {
    var list = std.ArrayList(u8).init(allocator);
    errdefer list.deinit();
    for (game.nodes) |node| {
        if (node.kind != .decision) continue;
        const path_disp = if (node.path.len == 0) "-" else node.path;
        try list.writer().print("D path={s} player={d} street={d} n={d}", .{
            path_disp,
            node.player,
            node.street,
            node.n_actions,
        });
        var a: usize = 0;
        while (a < node.n_actions) : (a += 1) {
            try list.writer().print(" |{s}", .{node.action_labels[a]});
        }
        try list.append('\n');
    }
    return list.toOwnedSlice();
}

fn expectFingerprint(path: []const u8, expected: []const u8, expected_decisions: usize) !void {
    const text = try std.fs.cwd().readFileAlloc(std.testing.allocator, path, 1024 * 1024);
    defer std.testing.allocator.free(text);
    var spec = try street_config.parseStreetConfig(std.testing.allocator, text);
    defer spec.deinit();
    var game = try compile.compile(std.testing.allocator, spec);
    defer game.deinit();

    var decisions: usize = 0;
    for (game.nodes) |node| {
        if (node.kind == .decision) decisions += 1;
    }
    try std.testing.expectEqual(expected_decisions, decisions);

    const got = try decisionFingerprint(std.testing.allocator, game);
    defer std.testing.allocator.free(got);
    try std.testing.expectEqualStrings(expected, got);
}

test "tree shape flop-check-down matches C++ public_tree" {
    const expected =
        \\D path=- player=0 street=0 n=1 |Check
        \\D path=Check player=1 street=0 n=1 |Check
        \\D path=Check/Check player=0 street=1 n=1 |Check
        \\D path=Check/Check/Check player=1 street=1 n=1 |Check
        \\D path=Check/Check/Check/Check player=0 street=2 n=1 |Check
        \\D path=Check/Check/Check/Check/Check player=1 street=2 n=1 |Check
        \\
    ;
    try expectFingerprint("configs/templates/flop-check-down.txt", expected, 6);
}

test "tree shape river_gate_smoke matches C++ public_tree" {
    const expected =
        \\D path=- player=0 street=0 n=2 |Check |Bet 100 all-in
        \\D path=Check player=1 street=0 n=2 |Check |Bet 100 all-in
        \\D path=Check/Bet 100 all-in player=0 street=0 n=2 |Fold |Call all-in
        \\D path=Bet 100 all-in player=1 street=0 n=2 |Fold |Call all-in
        \\
    ;
    try expectFingerprint("benchmarks/study/configs/river_gate_smoke.txt", expected, 4);
}

test "tree shape turn-probe matches C++ public_tree" {
    const expected =
        \\D path=- player=0 street=0 n=2 |Check |Bet 50
        \\D path=Check player=1 street=0 n=2 |Check |Bet 50
        \\D path=Check/Check player=0 street=1 n=2 |Check |Bet 50
        \\D path=Check/Check/Check player=1 street=1 n=2 |Check |Bet 50
        \\D path=Check/Check/Check/Bet 50 player=0 street=1 n=2 |Fold |Call
        \\D path=Check/Check/Bet 50 player=1 street=1 n=2 |Fold |Call
        \\D path=Check/Bet 50 player=0 street=0 n=2 |Fold |Call
        \\D path=Check/Bet 50/Call player=0 street=1 n=1 |Check
        \\D path=Check/Bet 50/Call/Check player=1 street=1 n=1 |Check
        \\D path=Bet 50 player=1 street=0 n=2 |Fold |Call
        \\D path=Bet 50/Call player=0 street=1 n=1 |Check
        \\D path=Bet 50/Call/Check player=1 street=1 n=1 |Check
        \\
    ;
    try expectFingerprint("configs/templates/turn-probe.txt", expected, 12);
}

test "tree shape flop-small-bet root arity + decision count" {
    const text = try std.fs.cwd().readFileAlloc(
        std.testing.allocator,
        "configs/templates/flop-small-bet.txt",
        1024 * 1024,
    );
    defer std.testing.allocator.free(text);
    var spec = try street_config.parseStreetConfig(std.testing.allocator, text);
    defer spec.deinit();
    var game = try compile.compile(std.testing.allocator, spec);
    defer game.deinit();

    var decisions: usize = 0;
    for (game.nodes) |node| {
        if (node.kind == .decision) decisions += 1;
    }
    try std.testing.expectEqual(@as(usize, 44), decisions);
    try std.testing.expectEqual(@as(usize, 93), game.nodes.len);
    const root = game.nodes[0];
    try std.testing.expect(root.kind == .decision);
    try std.testing.expectEqual(@as(u8, 2), root.n_actions);
    try std.testing.expectEqualStrings("Check", root.action_labels[0]);
    try std.testing.expectEqualStrings("Bet 33", root.action_labels[1]);
}

test "tree shape force root check edit matches C++" {
    // Same body as flop-small-bet + tree-edit force - c (C++ dig matched 31 decisions).
    const text =
        \\street-config 1
        \\board Ah Kd 7c
        \\pot 100
        \\stack 100
        \\oop-range AcAd:1
        \\ip-range 2c3d:1
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
        \\oop-bets 0.33
        \\ip-bets 0.33
        \\oop-raises 1
        \\ip-raises 1
        \\tree-edit force - c
        \\
    ;
    var spec = try street_config.parseStreetConfig(std.testing.allocator, text);
    defer spec.deinit();
    var game = try compile.compile(std.testing.allocator, spec);
    defer game.deinit();

    var decisions: usize = 0;
    for (game.nodes) |node| {
        if (node.kind == .decision) decisions += 1;
    }
    try std.testing.expectEqual(@as(usize, 31), decisions);
    try std.testing.expectEqual(@as(usize, 66), game.nodes.len);
    const root = game.nodes[0];
    try std.testing.expectEqual(@as(u8, 1), root.n_actions);
    try std.testing.expectEqualStrings("Check", root.action_labels[0]);
}
