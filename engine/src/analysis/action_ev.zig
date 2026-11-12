const std = @import("std");
const compile = @import("../game/compile.zig");
const payoff = @import("../poker/payoff.zig");
const icm = @import("../poker/icm.zig");
const range_mod = @import("../poker/range.zig");
const traversal = @import("../solve/traversal.zig");
const training_state = @import("../solve/training_state.zig");

pub const ActionEvError = error{ InvalidAnalysis, OutOfMemory };

/// Conditional action values for one decision under the published average (root-centered).
/// `local_offset = -U_actor(fold-now)` so Fold + offset → 0 under ordinary chip/ICM terminals.
pub const ActionValues = struct {
    allocator: std.mem.Allocator,
    node_index: u32 = 0,
    player: i32 = -1,
    policy_revision: u64 = 0,
    local_offset: f64 = 0,
    reach_defined: bool = false,
    node_ev_defined: bool = false,
    node_ev: f64 = 0,
    actions: [][]const u8 = &.{},
    combos: [][]const u8 = &.{},
    ev_defined: []u8 = &.{},
    /// Hand-major: hand * n_actions + action.
    action_ev: []f64 = &.{},
    mixed_ev: []f64 = &.{},

    pub fn deinit(self: *ActionValues) void {
        for (self.actions) |label| {
            if (label.len != 0) self.allocator.free(label);
        }
        if (self.actions.len != 0) self.allocator.free(self.actions);
        for (self.combos) |label| {
            if (label.len != 0) self.allocator.free(label);
        }
        if (self.combos.len != 0) self.allocator.free(self.combos);
        if (self.ev_defined.len != 0) self.allocator.free(self.ev_defined);
        if (self.action_ev.len != 0) self.allocator.free(self.action_ev);
        if (self.mixed_ev.len != 0) self.allocator.free(self.mixed_ev);
        self.* = .{ .allocator = self.allocator };
    }
};

fn foldNowUtility(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    node: compile.Node,
    actor: i32,
) ActionEvError!f64 {
    // Fold-now under chip+rake+ICM with current street contrib (no path incentives on Fold).
    const paid = payoff.chipTerminal(
        game.pot,
        node.contrib[0],
        node.contrib[1],
        actor,
        0,
        game.rake,
    ) catch return error.InvalidAnalysis;
    if (game.icm_stacks.len == 0) {
        return paid.utility[@intCast(actor)];
    }
    const modeled = icm.applyIcmTerminal(allocator, game.icmConfig(), paid) catch return error.InvalidAnalysis;
    return modeled.utility[@intCast(actor)];
}

fn resolveSigma(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    published: training_state.PublishedPolicy,
    owned: *?[]f32,
) ActionEvError![]const f32 {
    if (published.average.len != 0) return published.average;
    var uniform = training_state.TrainingState.init(allocator, game) catch return error.OutOfMemory;
    defer uniform.deinit();
    owned.* = allocator.dupe(f32, uniform.sigma) catch return error.OutOfMemory;
    return owned.*.?;
}

/// Deal-by-deal conditional action EV for a river/turn decision under published average.
pub fn actionValues(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    published: training_state.PublishedPolicy,
    node_index: u32,
    turn: i32,
    river: i32,
) ActionEvError!ActionValues {
    if (node_index >= game.nodes.len) return error.InvalidAnalysis;
    const node = game.nodes[node_index];
    if (node.kind != .decision) return error.InvalidAnalysis;

    var page = ActionValues{
        .allocator = allocator,
        .node_index = node_index,
        .player = node.player,
        .policy_revision = published.revision,
        .local_offset = -(try foldNowUtility(allocator, game, node, node.player)),
    };
    errdefer page.deinit();

    page.actions = allocator.alloc([]const u8, node.n_actions) catch return error.OutOfMemory;
    @memset(page.actions, "");
    var a: usize = 0;
    while (a < node.n_actions) : (a += 1) {
        page.actions[a] = allocator.dupe(u8, node.action_labels[a]) catch return error.OutOfMemory;
    }

    const actor: usize = @intCast(node.player);
    const hands: usize = @intCast(@max(node.hands, 0));
    page.combos = allocator.alloc([]const u8, hands) catch return error.OutOfMemory;
    @memset(page.combos, "");
    page.ev_defined = allocator.alloc(u8, hands) catch return error.OutOfMemory;
    @memset(page.ev_defined, 0);
    page.action_ev = allocator.alloc(f64, hands * node.n_actions) catch return error.OutOfMemory;
    @memset(page.action_ev, 0);
    page.mixed_ev = allocator.alloc(f64, hands) catch return error.OutOfMemory;
    @memset(page.mixed_ev, 0);

    var hand: usize = 0;
    while (hand < hands) : (hand += 1) {
        const combo = game.hands.combos[actor][hand];
        var buf: [4]u8 = undefined;
        const text = range_mod.Range.comboText(combo, &buf) catch return error.InvalidAnalysis;
        page.combos[hand] = allocator.dupe(u8, text) catch return error.OutOfMemory;
    }

    var owned_sigma: ?[]f32 = null;
    defer if (owned_sigma) |buf| allocator.free(buf);
    const sigma = try resolveSigma(allocator, game, published, &owned_sigma);

    // Accumulate action utilities and opponent reach mass per hero hand.
    var action_sum = allocator.alloc(f64, hands * node.n_actions) catch return error.OutOfMemory;
    defer allocator.free(action_sum);
    @memset(action_sum, 0);
    var mass = allocator.alloc(f64, hands) catch return error.OutOfMemory;
    defer allocator.free(mass);
    @memset(mass, 0);

    var reach_mass: f64 = 0;
    for (game.deals) |deal| {
        const hero_hand: i32 = if (node.player == 0) deal.h0 else deal.h1;
        if (hero_hand < 0 or @as(usize, @intCast(hero_hand)) >= hands) continue;
        reach_mass += deal.probability;
        const hh: usize = @intCast(hero_hand);
        mass[hh] += deal.probability;

        var action: usize = 0;
        while (action < node.n_actions) : (action += 1) {
            const child = traversal.expectedDeal(
                allocator,
                game,
                sigma,
                node.child[action],
                deal,
                turn,
                river,
            ) catch return error.InvalidAnalysis;
            action_sum[hh * node.n_actions + action] += deal.probability * child.utility[actor];
        }
    }
    page.reach_defined = reach_mass > 0;

    var node_ev: f64 = 0;
    var node_ok = page.reach_defined;
    hand = 0;
    while (hand < hands) : (hand += 1) {
        if (!(mass[hand] > 0)) {
            if (page.reach_defined) node_ok = false;
            continue;
        }
        page.ev_defined[hand] = 1;
        var mixed: f64 = 0;
        var played_row: [8]f32 = undefined;
        if (node.n_actions <= 1) {
            played_row[0] = 1.0;
        } else {
            const key = game.cardKey(node, @intCast(hand), turn, river) catch {
                page.ev_defined[hand] = 0;
                continue;
            };
            if (key < 0 or @as(usize, @intCast(key)) >= node.slot_of.len) {
                page.ev_defined[hand] = 0;
                continue;
            }
            const slot_i = node.slot_of[@intCast(key)];
            if (slot_i < 0) {
                page.ev_defined[hand] = 0;
                continue;
            }
            const base: usize = @intCast(game.slots[@intCast(slot_i)].base);
            @memcpy(played_row[0..node.n_actions], sigma[base .. base + node.n_actions]);
        }
        var action: usize = 0;
        while (action < node.n_actions) : (action += 1) {
            const conditional = action_sum[hand * node.n_actions + action] / mass[hand];
            page.action_ev[hand * node.n_actions + action] = conditional;
            mixed += @as(f64, @floatCast(played_row[action])) * conditional;
        }
        page.mixed_ev[hand] = mixed;
        node_ev += (mass[hand] / reach_mass) * mixed;
    }
    page.node_ev_defined = node_ok;
    if (node_ok) page.node_ev = node_ev;
    return page;
}
