//! CFR+ algorithm (D9): pass order, regret flooring, averaging.
//! Product ships CFR+ only until further notice.
const std = @import("std");
const compile = @import("../../game/compile.zig");
const training_state = @import("../training_state.zig");
const traversal = @import("../traversal.zig");

pub const name = "cfr_plus";
pub const phase = "phase-3";

pub const CfrError = training_state.TrainError || traversal.TravError;

pub const TrainConfig = struct {
    /// Number of alternating player updates (each counts as one trained step).
    iterations: i32 = 1,
    /// Linear CFR+ weighting: weight = max(trained, 0). Matches C++ TrainConfig default path.
    linear_weighting: bool = true,
};

/// One alternating-update CFR+ iteration over all deals (C++ TrainCfrPlusDealByDeal).
/// Sequence: freeze → update OOP → floor+freeze → update IP → floor+freeze → trained++ → publish.
pub fn trainDealByDeal(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    state: *training_state.TrainingState,
    config: TrainConfig,
) CfrError!training_state.PublishedPolicy {
    if (game.nodes.len == 0) return error.InvalidTrain;
    var published = training_state.PublishedPolicy{ .allocator = allocator };
    var step: i32 = 0;
    while (step < config.iterations) : (step += 1) {
        const weight: f64 = if (config.linear_weighting)
            @floatFromInt(@max(state.trained, 0))
        else
            1.0;

        training_state.freezeSigma(game, state);
        for (game.deals) |deal| {
            _ = try traversal.cfrDeal(
                allocator,
                game,
                state,
                0,
                1.0,
                1.0,
                deal.probability,
                deal,
                -1,
                -1,
                0,
                weight,
            );
        }
        training_state.floorAndFreeze(game, state, 0);

        for (game.deals) |deal| {
            _ = try traversal.cfrDeal(
                allocator,
                game,
                state,
                0,
                1.0,
                1.0,
                deal.probability,
                deal,
                -1,
                -1,
                1,
                weight,
            );
        }
        training_state.floorAndFreeze(game, state, 1);

        state.trained += 1;
        if (published.average.len != 0) published.deinit();
        published = try training_state.publishAverage(allocator, game, state);
    }
    return published;
}

/// Expected OOP utility under the published average strategy.
pub fn evaluatePublished(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    published: training_state.PublishedPolicy,
) CfrError!f64 {
    if (published.average.len == 0) {
        var uniform = try training_state.TrainingState.init(allocator, game);
        defer uniform.deinit();
        return traversal.rootValue(allocator, game, uniform.sigma);
    }
    return traversal.rootValue(allocator, game, published.average);
}

test "cfr+ river pot-bet trains and publishes" {
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
    var spec = try @import("../../game/street_config.zig").parseStreetConfig(std.testing.allocator, text);
    defer spec.deinit();
    var game = try compile.compile(std.testing.allocator, spec);
    defer game.deinit();

    try std.testing.expect(game.deals.len >= 1);
    try std.testing.expect(game.table_entries > 0);

    var state = try training_state.TrainingState.init(std.testing.allocator, game);
    defer state.deinit();

    var published = try trainDealByDeal(std.testing.allocator, game, &state, .{ .iterations = 40 });
    defer published.deinit();

    try std.testing.expect(published.trained == 40);
    try std.testing.expect(published.average.len == state.strategy_sum.len);
    try std.testing.expect(published.revision >= 1);

    const value = try evaluatePublished(std.testing.allocator, game, published);
    try std.testing.expect(@abs(value) < 200.0);
}

test "one-action infosets stay implicit" {
    const text =
        \\street-config 1
        \\board Ah Kh Qh Jh Th
        \\pot 100
        \\stack 1
        \\oop-range AsKs:1
        \\ip-range 2c2d:1
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
    var spec = try @import("../../game/street_config.zig").parseStreetConfig(std.testing.allocator, text);
    defer spec.deinit();
    var game = try compile.compile(std.testing.allocator, spec);
    defer game.deinit();
    for (game.nodes) |node| {
        if (node.kind == .decision and node.n_actions <= 1) {
            try std.testing.expect(node.slot_of.len == 0);
        }
    }
}

test "incentive path-fill affects published evaluation" {
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
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 1024
        \\threads 1
        \\incentive label 0 Check 10
        \\
    ;
    var spec = try @import("../../game/street_config.zig").parseStreetConfig(std.testing.allocator, text);
    defer spec.deinit();
    var game = try compile.compile(std.testing.allocator, spec);
    defer game.deinit();

    var saw_incentive = false;
    for (game.nodes) |node| {
        if (node.kind == .terminal and (node.incentive_u0 != 0 or node.incentive_u1 != 0)) {
            saw_incentive = true;
        }
    }
    try std.testing.expect(saw_incentive);

    var state = try training_state.TrainingState.init(std.testing.allocator, game);
    defer state.deinit();
    var published = try trainDealByDeal(std.testing.allocator, game, &state, .{ .iterations = 5 });
    defer published.deinit();
    const value = try evaluatePublished(std.testing.allocator, game, published);
    // Check/check AA vs KK on this board: AA wins pot; plus OOP Check incentive once.
    try std.testing.expect(value > 50.0);
}
