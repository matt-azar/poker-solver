//! Behavioral pins for tree-edit apply: compact paths, AddSize clamps, unapplied report.
const std = @import("std");
const street_config = @import("street_config.zig");
const compile = @import("compile.zig");

fn compileWithEdits(edits_block: []const u8) !compile.CompiledGame {
    var text_buf: [2048]u8 = undefined;
    const text = try std.fmt.bufPrint(&text_buf,
        \\street-config 1
        \\board Ah Kd 7c 2s
        \\pot 100
        \\stack 200
        \\oop-range QcQd:1
        \\ip-range JcJd:1
        \\first-to-act 0
        \\max-raises 1
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 64
        \\threads 1
        \\oop-bets 0.5
        \\ip-bets 0.5
        \\oop-raises -
        \\ip-raises -
        \\{s}
    , .{edits_block});
    var spec = try street_config.parseStreetConfig(std.testing.allocator, text);
    defer spec.deinit();
    return try compile.compile(std.testing.allocator, spec);
}

fn compileCustom(body: []const u8) !compile.CompiledGame {
    var spec = try street_config.parseStreetConfig(std.testing.allocator, body);
    defer spec.deinit();
    return try compile.compile(std.testing.allocator, spec);
}

fn findDecision(game: compile.CompiledGame, path: []const u8) ?compile.Node {
    for (game.nodes) |node| {
        if (node.kind != .decision) continue;
        const node_path = if (node.path.len == 0) "-" else node.path;
        const want = if (path.len == 0) "-" else path;
        if (std.mem.eql(u8, node_path, want)) return node;
    }
    return null;
}

fn hasLabel(node: compile.Node, label: []const u8) bool {
    var a: usize = 0;
    while (a < node.n_actions) : (a += 1) {
        if (std.mem.eql(u8, node.action_labels[a], label)) return true;
    }
    return false;
}

test "remove compact c b50 drops IP bet after Check" {
    // Study emits `remove c b50` for the IP node at path Check (not c/b50 — that is
    // the facing node after Check/Bet 50). Compact `c` must match display `Check`.
    var game = try compileWithEdits("tree-edit remove c b50\n");
    defer game.deinit();

    const root = findDecision(game, "").?;
    try std.testing.expect(hasLabel(root, "Bet 50"));

    const after_check = findDecision(game, "Check").?;
    try std.testing.expect(hasLabel(after_check, "Check"));
    try std.testing.expect(!hasLabel(after_check, "Bet 50"));
    try std.testing.expectEqual(@as(usize, 0), game.unapplied_tree_edits.len);
}

test "remove display Check path token still matches" {
    var game = try compileWithEdits("tree-edit remove Check b50\n");
    defer game.deinit();
    const after_check = findDecision(game, "Check").?;
    try std.testing.expect(!hasLabel(after_check, "Bet 50"));
    try std.testing.expectEqual(@as(usize, 0), game.unapplied_tree_edits.len);
}

test "compact deep path c/b50 matches Check/Bet 50 for force" {
    var game = try compileWithEdits("tree-edit force c/b50 call\n");
    defer game.deinit();
    const facing = findDecision(game, "Check/Bet 50").?;
    try std.testing.expectEqual(@as(u8, 1), facing.n_actions);
    try std.testing.expect(hasLabel(facing, "Call"));
    try std.testing.expectEqual(@as(usize, 0), game.unapplied_tree_edits.len);
}

test "add-size pot fraction injects Bet 33" {
    var game = try compileWithEdits("tree-edit add-size - 0.33\n");
    defer game.deinit();
    const root = findDecision(game, "").?;
    try std.testing.expectEqual(@as(u8, 3), root.n_actions);
    try std.testing.expect(hasLabel(root, "Check"));
    try std.testing.expect(hasLabel(root, "Bet 33"));
    try std.testing.expect(hasLabel(root, "Bet 50"));
    try std.testing.expectEqual(@as(usize, 0), game.unapplied_tree_edits.len);
}

test "add-size chips injects Bet 20" {
    var game = try compileWithEdits("tree-edit add-size - 20c\n");
    defer game.deinit();
    const root = findDecision(game, "").?;
    try std.testing.expectEqual(@as(u8, 3), root.n_actions);
    try std.testing.expect(hasLabel(root, "Bet 20"));
    try std.testing.expect(hasLabel(root, "Bet 50"));
}

test "add-size duplicate listed size is no-op and reported" {
    var game = try compileWithEdits("tree-edit add-size - 0.5\n");
    defer game.deinit();
    const root = findDecision(game, "").?;
    try std.testing.expectEqual(@as(u8, 2), root.n_actions);
    try std.testing.expectEqual(@as(usize, 1), game.unapplied_tree_edits.len);
    try std.testing.expectEqualStrings("add-size - 0.5", game.unapplied_tree_edits[0]);
    try std.testing.expectEqualStrings("duplicate", game.unapplied_tree_edit_reasons[0]);
}

test "add-size then force keeps injected size" {
    var game = try compileWithEdits(
        \\tree-edit add-size - 0.33
        \\tree-edit force - b33
        \\
    );
    defer game.deinit();
    const root = findDecision(game, "").?;
    try std.testing.expectEqual(@as(u8, 1), root.n_actions);
    try std.testing.expect(hasLabel(root, "Bet 33"));
    try std.testing.expect(!hasLabel(root, "Bet 50"));
    try std.testing.expect(!hasLabel(root, "Check"));
    try std.testing.expectEqual(@as(usize, 0), game.unapplied_tree_edits.len);
}

test "add-size respects pot-cap clamp" {
    const body =
        \\street-config 1
        \\board Ah Kd 7c 2s
        \\pot 100
        \\stack 200
        \\oop-range QcQd:1
        \\ip-range JcJd:1
        \\first-to-act 0
        \\max-raises 1
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0.25
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 64
        \\threads 1
        \\oop-bets 0.5
        \\ip-bets 0.5
        \\oop-raises -
        \\ip-raises -
        \\tree-edit add-size - 1.0
        \\
    ;
    var game = try compileCustom(body);
    defer game.deinit();
    const root = findDecision(game, "").?;
    // Listed 0.5 and injected 1.0 both clamp to pot_cap 0.25 → Bet 25; dup → one bet.
    try std.testing.expect(hasLabel(root, "Bet 25"));
    try std.testing.expect(!hasLabel(root, "Bet 50"));
    try std.testing.expect(!hasLabel(root, "Bet 100"));
    // Injected amount clamped to same chip total as listed → duplicate report.
    try std.testing.expectEqual(@as(usize, 1), game.unapplied_tree_edits.len);
    try std.testing.expectEqualStrings("duplicate", game.unapplied_tree_edit_reasons[0]);
}

test "add-size min-raise rejection when facing" {
    // After Check/Bet 50, OOP faces to_call=50, last_raise=50. Inject raise-by 10 (< min).
    const body =
        \\street-config 1
        \\board Ah Kd 7c 2s
        \\pot 100
        \\stack 200
        \\oop-range QcQd:1
        \\ip-range JcJd:1
        \\first-to-act 0
        \\max-raises 1
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 64
        \\threads 1
        \\oop-bets 0.5
        \\ip-bets 0.5
        \\oop-raises -
        \\ip-raises -
        \\tree-edit add-size c/b50 10c
        \\
    ;
    var game = try compileCustom(body);
    defer game.deinit();
    const facing = findDecision(game, "Check/Bet 50").?;
    try std.testing.expect(hasLabel(facing, "Fold"));
    try std.testing.expect(hasLabel(facing, "Call"));
    try std.testing.expectEqual(@as(u8, 2), facing.n_actions);
    try std.testing.expectEqual(@as(usize, 1), game.unapplied_tree_edits.len);
    try std.testing.expectEqualStrings("illegal_size", game.unapplied_tree_edit_reasons[0]);
}

test "add-size all-in-threshold shove-up" {
    const body =
        \\street-config 1
        \\board Ah Kd 7c 2s
        \\pot 100
        \\stack 100
        \\oop-range QcQd:1
        \\ip-range JcJd:1
        \\first-to-act 0
        \\max-raises 1
        \\allow-three-bet 1
        \\all-in-threshold 0.8
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 64
        \\threads 1
        \\oop-bets -
        \\ip-bets -
        \\oop-raises -
        \\ip-raises -
        \\tree-edit add-size - 0.9
        \\
    ;
    var game = try compileCustom(body);
    defer game.deinit();
    const root = findDecision(game, "").?;
    try std.testing.expect(hasLabel(root, "Check"));
    // 0.9 * pot=90 crosses 0.8*stack → shove to Bet 100 all-in.
    try std.testing.expect(hasLabel(root, "Bet 100 all-in"));
    try std.testing.expectEqual(@as(usize, 0), game.unapplied_tree_edits.len);
}

test "unapplied report for unknown force and missing path" {
    var game = try compileWithEdits(
        \\tree-edit force - b999
        \\tree-edit remove c/b99 b99
        \\
    );
    defer game.deinit();
    try std.testing.expectEqual(@as(usize, 2), game.unapplied_tree_edits.len);
    try std.testing.expectEqualStrings("force - b999", game.unapplied_tree_edits[0]);
    try std.testing.expectEqualStrings("action_missing", game.unapplied_tree_edit_reasons[0]);
    try std.testing.expectEqualStrings("remove c/b99 b99", game.unapplied_tree_edits[1]);
    try std.testing.expectEqualStrings("never_matched_path", game.unapplied_tree_edit_reasons[1]);
}

test "all-in compact path token matches Bet N all-in" {
    const body =
        \\street-config 1
        \\board Ah Kd 7c
        \\pot 100
        \\stack 100
        \\oop-range AcAd:1
        \\ip-range 2c3d:1
        \\first-to-act 0
        \\max-raises 1
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 64
        \\threads 1
        \\oop-bets 1
        \\ip-bets 1
        \\oop-raises -
        \\ip-raises -
        \\tree-edit force b100ai call
        \\
    ;
    var game = try compileCustom(body);
    defer game.deinit();
    const facing = findDecision(game, "Bet 100 all-in").?;
    try std.testing.expectEqual(@as(u8, 1), facing.n_actions);
    try std.testing.expect(hasLabel(facing, "Call all-in") or hasLabel(facing, "Call"));
    try std.testing.expectEqual(@as(usize, 0), game.unapplied_tree_edits.len);
}
