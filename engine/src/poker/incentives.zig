//! Standalone incentive overlay (C++ apply_incentives). Path-fill at compile
//! time still lives in game/compile.zig; this module rematches unit fixtures.
const std = @import("std");
const payoff = @import("payoff.zig");

pub const IncentiveError = error{InvalidIncentive};

pub const IncentiveKind = enum { action_label_match, category_tag };

pub const IncentiveRule = struct {
    kind: IncentiveKind = .action_label_match,
    key: []const u8 = "",
    player: i32 = 0,
    delta: f64 = 0,
};

pub const IncentiveContext = struct {
    player: i32 = 0,
    action_label: []const u8 = "",
    tags: []const []const u8 = &.{},
};

fn validateRule(rule: IncentiveRule) IncentiveError!void {
    if (rule.player != 0 and rule.player != 1) return error.InvalidIncentive;
    if (!std.math.isFinite(rule.delta)) return error.InvalidIncentive;
}

fn validateContext(ctx: IncentiveContext) IncentiveError!void {
    if (ctx.player != 0 and ctx.player != 1) return error.InvalidIncentive;
}

fn ruleMatches(rule: IncentiveRule, ctx: IncentiveContext) bool {
    if (rule.player != ctx.player) return false;
    return switch (rule.kind) {
        .action_label_match => std.mem.eql(u8, rule.key, ctx.action_label),
        .category_tag => blk: {
            for (ctx.tags) |tag| {
                if (std.mem.eql(u8, tag, rule.key)) break :blk true;
            }
            break :blk false;
        },
    };
}

/// Copy base utilities and add every matching rule's delta to that rule's player.
pub fn applyIncentives(
    base: payoff.PlayerPayoff,
    rules: []const IncentiveRule,
    ctx: IncentiveContext,
) IncentiveError!payoff.PlayerPayoff {
    try validateContext(ctx);
    if (!std.math.isFinite(base.utility[0]) or !std.math.isFinite(base.utility[1])) {
        return error.InvalidIncentive;
    }
    var out = base;
    for (rules) |rule| {
        try validateRule(rule);
        if (!ruleMatches(rule, ctx)) continue;
        out.utility[@intCast(rule.player)] += rule.delta;
    }
    return out;
}

test "incentives identity with empty rules" {
    const base = payoff.PlayerPayoff{ .utility = .{ 10, -10 } };
    const out = try applyIncentives(base, &.{}, .{ .player = 0, .action_label = "b50", .tags = &.{"value"} });
    try std.testing.expectEqual(base.utility[0], out.utility[0]);
    try std.testing.expectEqual(base.utility[1], out.utility[1]);
}

test "ActionLabelMatch shifts only matched player" {
    const base = payoff.PlayerPayoff{ .utility = .{ 10, -10 } };
    const rules = [_]IncentiveRule{
        .{ .kind = .action_label_match, .key = "b75", .player = 0, .delta = 3.5 },
    };
    const hit = try applyIncentives(base, &rules, .{ .player = 0, .action_label = "b75", .tags = &.{"bluff"} });
    try std.testing.expectApproxEqAbs(@as(f64, 13.5), hit.utility[0], 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, -10.0), hit.utility[1], 1e-12);

    const miss_label = try applyIncentives(base, &rules, .{ .player = 0, .action_label = "b50", .tags = &.{"bluff"} });
    try std.testing.expectEqual(base.utility[0], miss_label.utility[0]);

    const miss_player = try applyIncentives(base, &rules, .{ .player = 1, .action_label = "b75", .tags = &.{"bluff"} });
    try std.testing.expectEqual(base.utility[0], miss_player.utility[0]);
}

test "CategoryTag shifts only matched player" {
    const base = payoff.PlayerPayoff{ .utility = .{ 10, -10 } };
    const rules = [_]IncentiveRule{
        .{ .kind = .category_tag, .key = "bluff", .player = 1, .delta = 2.0 },
    };
    const hit = try applyIncentives(base, &rules, .{ .player = 1, .action_label = "b33", .tags = &.{ "semi", "bluff" } });
    try std.testing.expectApproxEqAbs(@as(f64, 10.0), hit.utility[0], 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, -8.0), hit.utility[1], 1e-12);

    const miss = try applyIncentives(base, &rules, .{ .player = 1, .action_label = "b33", .tags = &.{"value"} });
    try std.testing.expectEqual(base.utility[0], miss.utility[0]);
    try std.testing.expectEqual(base.utility[1], miss.utility[1]);
}

test "multiple matching rules stack" {
    const base = payoff.PlayerPayoff{ .utility = .{ 10, -10 } };
    const rules = [_]IncentiveRule{
        .{ .kind = .action_label_match, .key = "b50", .player = 0, .delta = 1.0 },
        .{ .kind = .category_tag, .key = "bluff", .player = 0, .delta = 4.0 },
        .{ .kind = .category_tag, .key = "bluff", .player = 1, .delta = -2.0 },
        .{ .kind = .action_label_match, .key = "x", .player = 0, .delta = 9.0 },
    };
    const out = try applyIncentives(base, &rules, .{ .player = 0, .action_label = "b50", .tags = &.{ "bluff", "overbet" } });
    try std.testing.expectApproxEqAbs(@as(f64, 15.0), out.utility[0], 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, -10.0), out.utility[1], 1e-12);
}

test "separate acting contexts per seat" {
    const base = payoff.PlayerPayoff{ .utility = .{ 10, -10 } };
    const rules = [_]IncentiveRule{
        .{ .kind = .action_label_match, .key = "c", .player = 0, .delta = 1.0 },
        .{ .kind = .action_label_match, .key = "c", .player = 1, .delta = 2.0 },
    };
    const p0 = try applyIncentives(base, &rules, .{ .player = 0, .action_label = "c", .tags = &.{} });
    try std.testing.expectApproxEqAbs(@as(f64, 11.0), p0.utility[0], 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, -10.0), p0.utility[1], 1e-12);
    const p1 = try applyIncentives(base, &rules, .{ .player = 1, .action_label = "c", .tags = &.{} });
    try std.testing.expectApproxEqAbs(@as(f64, 10.0), p1.utility[0], 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, -8.0), p1.utility[1], 1e-12);
}

test "incentive rejects bad player" {
    const base = payoff.PlayerPayoff{ .utility = .{ 10, -10 } };
    const rules = [_]IncentiveRule{
        .{ .kind = .category_tag, .key = "x", .player = 2, .delta = 1.0 },
    };
    try std.testing.expectError(
        error.InvalidIncentive,
        applyIncentives(base, &rules, .{ .player = 0, .action_label = "c", .tags = &.{"x"} }),
    );
}
