//! Warm FrozenCtx workspace exclusivity (IPC audit §5).
//! `actionValuesFrozenOnCtx` must own private mutable scratch so overlapping
//! holders of the same Session-warm ctx cannot corrupt each other's walks.
const std = @import("std");
const compile = @import("../game/compile.zig");
const street_config = @import("../game/street_config.zig");
const training_state = @import("../solve/training_state.zig");
const frozen_walk = @import("../solve/frozen_walk.zig");
const action_ev = @import("action_ev.zig");

fn riverFixture(allocator: std.mem.Allocator) !compile.CompiledGame {
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

fn poisonWorkspace(ctx: *frozen_walk.FrozenCtx) void {
    const w = &ctx.workspace;
    const sentinel: f64 = 42.0;
    var d: usize = 0;
    while (d < w.scratch_len) : (d += 1) {
        @memset(w.scratch[d].pi0, sentinel);
        @memset(w.scratch[d].pi1, sentinel);
        @memset(w.scratch[d].ev0, sentinel);
        @memset(w.scratch[d].ev1, sentinel);
        @memset(w.scratch[d].aev0, sentinel);
        @memset(w.scratch[d].aev1, sentinel);
    }
    @memset(w.amount0, sentinel);
    @memset(w.amount1, sentinel);
    w.support_turn = -7;
    w.support_river = -7;
}

fn workspaceStillPoisoned(ctx: *const frozen_walk.FrozenCtx) bool {
    const w = &ctx.workspace;
    const sentinel: f64 = 42.0;
    var d: usize = 0;
    while (d < w.scratch_len) : (d += 1) {
        for (w.scratch[d].pi0) |v| if (v != sentinel) return false;
        for (w.scratch[d].pi1) |v| if (v != sentinel) return false;
        for (w.scratch[d].ev0) |v| if (v != sentinel) return false;
        for (w.scratch[d].ev1) |v| if (v != sentinel) return false;
        for (w.scratch[d].aev0) |v| if (v != sentinel) return false;
        for (w.scratch[d].aev1) |v| if (v != sentinel) return false;
    }
    for (w.amount0) |v| if (v != sentinel) return false;
    for (w.amount1) |v| if (v != sentinel) return false;
    if (w.support_turn != -7 or w.support_river != -7) return false;
    return true;
}

test "OnCtx does not mutate shared FrozenCtx.workspace" {
    // Would fail if actionValuesFrozenOnCtx still wrote &ctx.workspace.
    var game = try riverFixture(std.testing.allocator);
    defer game.deinit();
    var published = try uniformPublished(std.testing.allocator, game);
    defer published.deinit();

    var ctx = try frozen_walk.FrozenCtx.initEval(std.testing.allocator, game);
    defer ctx.deinit();
    try ctx.ensureAllRanksReady();
    poisonWorkspace(&ctx);

    var page = try action_ev.actionValuesFrozenOnCtx(
        std.testing.allocator,
        &ctx,
        game,
        published,
        0,
        true,
    );
    defer page.deinit();

    try std.testing.expect(page.reach_defined);
    try std.testing.expect(workspaceStillPoisoned(&ctx));
}

const ConcurrentJob = struct {
    ctx: *frozen_walk.FrozenCtx,
    game: compile.CompiledGame,
    published: training_state.PublishedPolicy,
    page: ?action_ev.ActionValues = null,
    failed: bool = false,
};

fn concurrentOnCtxWorker(job: *ConcurrentJob) void {
    const page = action_ev.actionValuesFrozenOnCtx(
        std.testing.allocator,
        job.ctx,
        job.game,
        job.published,
        0,
        true,
    ) catch {
        job.failed = true;
        return;
    };
    job.page = page;
}

test "concurrent OnCtx on shared FrozenCtx matches sequential baseline" {
    // Two overlapping warm walks must not share mutable scratch. Failures show
    // up as torn / disagreeing Q_i vs a solo baseline (or a worker error).
    var game = try riverFixture(std.testing.allocator);
    defer game.deinit();
    var published = try uniformPublished(std.testing.allocator, game);
    defer published.deinit();

    var ctx = try frozen_walk.FrozenCtx.initEval(std.testing.allocator, game);
    defer ctx.deinit();
    try ctx.ensureAllRanksReady();

    var baseline = try action_ev.actionValuesFrozenOnCtx(
        std.testing.allocator,
        &ctx,
        game,
        published,
        0,
        true,
    );
    defer baseline.deinit();

    var job_a = ConcurrentJob{ .ctx = &ctx, .game = game, .published = published };
    var job_b = ConcurrentJob{ .ctx = &ctx, .game = game, .published = published };
    const t_a = try std.Thread.spawn(.{}, concurrentOnCtxWorker, .{&job_a});
    const t_b = try std.Thread.spawn(.{}, concurrentOnCtxWorker, .{&job_b});
    t_a.join();
    t_b.join();
    defer if (job_a.page) |*p| p.deinit();
    defer if (job_b.page) |*p| p.deinit();

    try std.testing.expect(!job_a.failed);
    try std.testing.expect(!job_b.failed);
    const a = job_a.page orelse return error.TestUnexpectedResult;
    const b = job_b.page orelse return error.TestUnexpectedResult;

    try std.testing.expectEqual(baseline.action_ev.len, a.action_ev.len);
    try std.testing.expectEqual(baseline.action_ev.len, b.action_ev.len);
    try std.testing.expectEqual(baseline.mixed_ev.len, a.mixed_ev.len);
    try std.testing.expectEqual(baseline.mixed_ev.len, b.mixed_ev.len);
    for (baseline.action_ev, a.action_ev, b.action_ev) |want, got_a, got_b| {
        try std.testing.expectApproxEqAbs(want, got_a, 1e-9);
        try std.testing.expectApproxEqAbs(want, got_b, 1e-9);
    }
    for (baseline.mixed_ev, a.mixed_ev, b.mixed_ev) |want, got_a, got_b| {
        try std.testing.expectApproxEqAbs(want, got_a, 1e-9);
        try std.testing.expectApproxEqAbs(want, got_b, 1e-9);
    }
    try std.testing.expectApproxEqAbs(baseline.node_ev, a.node_ev, 1e-9);
    try std.testing.expectApproxEqAbs(baseline.node_ev, b.node_ev, 1e-9);
}
