//! Study Categories at a selected node: reach-weighted made-hand composition.
const std = @import("std");
const card = @import("../poker/card.zig");
const range_mod = @import("../poker/range.zig");
const hand_categories = @import("../poker/hand_categories.zig");
const compile = @import("../game/compile.zig");
const training_state = @import("../solve/training_state.zig");
const equity = @import("equity.zig");

pub const CategoriesAtNodeError = equity.EquityError || hand_categories.CategoriesError;

fn boardThroughNode(
    game: compile.CompiledGame,
    turn: i32,
    river: i32,
    out: *[5]card.Card,
) CategoriesAtNodeError![]const card.Card {
    var n: usize = 0;
    for (game.board) |c| {
        if (n >= out.len) return error.InvalidCategories;
        out[n] = c;
        n += 1;
    }
    if (turn >= 0) {
        if (n >= out.len) return error.InvalidCategories;
        out[n] = @intCast(turn);
        n += 1;
    }
    if (river >= 0) {
        if (n >= out.len) return error.InvalidCategories;
        out[n] = @intCast(river);
        n += 1;
    }
    if (n != 3 and n != 4 and n != 5) return error.InvalidCategories;
    return out[0..n];
}

/// Reach-weighted category composition on the board through `node_index`.
/// Five-card boards return made-hand mass; shorter boards return available=false.
pub fn categoriesAtNode(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    published: training_state.PublishedPolicy,
    node_index: u32,
    turn: i32,
    river: i32,
) CategoriesAtNodeError!hand_categories.CategoryComposition {
    var owned_sigma: ?[]f32 = null;
    defer if (owned_sigma) |buf| allocator.free(buf);
    const sigma: []const f32 = blk: {
        if (published.average.len != 0) break :blk published.average;
        var uniform = training_state.TrainingState.init(allocator, game) catch return error.OutOfMemory;
        defer uniform.deinit();
        owned_sigma = allocator.dupe(f32, uniform.sigma) catch return error.OutOfMemory;
        break :blk owned_sigma.?;
    };

    const reach = try equity.replayReachWeights(allocator, game, sigma, node_index, turn, river);
    defer {
        allocator.free(reach.q0);
        allocator.free(reach.q1);
    }

    var r0 = range_mod.Range{};
    var r1 = range_mod.Range{};
    for (game.hands.combos[0], 0..) |combo, i| {
        if (i < reach.q0.len and reach.q0[i] > 0 and std.math.isFinite(reach.q0[i])) {
            r0.weights[@intCast(combo)] = reach.q0[i];
        }
    }
    for (game.hands.combos[1], 0..) |combo, i| {
        if (i < reach.q1.len and reach.q1[i] > 0 and std.math.isFinite(reach.q1[i])) {
            r1.weights[@intCast(combo)] = reach.q1[i];
        }
    }

    var board_buf: [5]card.Card = undefined;
    const board = try boardThroughNode(game, turn, river, &board_buf);
    return hand_categories.categoryComposition(board, r0, r1);
}
