const std = @import("std");
const compile = @import("../game/compile.zig");
const payoff = @import("../poker/payoff.zig");
const icm = @import("../poker/icm.zig");
const range_mod = @import("../poker/range.zig");
const traversal = @import("../solve/traversal.zig");
const training_state = @import("../solve/training_state.zig");
const frozen_walk = @import("../solve/frozen_walk.zig");

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

/// Prefer frozen public-tree `response_walk` for root EV (flop-scale Study latency).
/// Non-root / explicit turn·river pins keep the deal-by-deal oracle path.
pub fn actionValues(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    published: training_state.PublishedPolicy,
    node_index: u32,
    turn: i32,
    river: i32,
) ActionEvError!ActionValues {
    if (node_index == 0 and turn < 0 and river < 0) {
        if (actionValuesFrozen(allocator, game, published, 0)) |page| {
            return page;
        } else |_| {
            // Malformed frozen tables → deal-by-deal fallback (tiny oracles).
            return actionValuesDealByDeal(allocator, game, published, node_index, turn, river);
        }
    }
    return actionValuesDealByDeal(allocator, game, published, node_index, turn, river);
}

/// Frozen StreetBatch-style action EV at the **root** under published average.
/// Reuses FrozenCtx rank cache / response_walk (same engine as flop train + #256 BR / #259 MT).
pub fn actionValuesFrozen(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    published: training_state.PublishedPolicy,
    node_index: u32,
) ActionEvError!ActionValues {
    if (node_index != 0) return error.InvalidAnalysis;
    if (node_index >= game.nodes.len) return error.InvalidAnalysis;
    const node = game.nodes[node_index];
    if (node.kind != .decision) return error.InvalidAnalysis;

    var owned_sigma: ?[]f32 = null;
    defer if (owned_sigma) |buf| allocator.free(buf);
    const sigma = try resolveSigma(allocator, game, published, &owned_sigma);

    var ctx = frozen_walk.FrozenCtx.initEval(allocator, game) catch return error.InvalidAnalysis;
    defer ctx.deinit();
    const w = &ctx.workspace;
    ctx.prepareResponseRoot(w);
    // serial_chance=true: Study values share the process with optional train workers (D3).
    ctx.responseWalk(w, 0, -1, -1, 0, -1, sigma, true) catch return error.InvalidAnalysis;

    const actor: usize = @intCast(node.player);
    const hands: usize = if (actor == 0) ctx.n0 else ctx.n1;
    const ev = if (actor == 0) w.scratch[0].ev0 else w.scratch[0].ev1;
    const aev = if (actor == 0) w.scratch[0].aev0 else w.scratch[0].aev1;
    const n_act: usize = node.n_actions;

    var page = ActionValues{
        .allocator = allocator,
        .node_index = node_index,
        .player = node.player,
        .policy_revision = published.revision,
        .local_offset = -(try foldNowUtility(allocator, game, node, node.player)),
    };
    errdefer page.deinit();

    page.actions = allocator.alloc([]const u8, n_act) catch return error.OutOfMemory;
    @memset(page.actions, "");
    var a: usize = 0;
    while (a < n_act) : (a += 1) {
        page.actions[a] = allocator.dupe(u8, node.action_labels[a]) catch return error.OutOfMemory;
    }

    page.combos = allocator.alloc([]const u8, hands) catch return error.OutOfMemory;
    @memset(page.combos, "");
    page.ev_defined = allocator.alloc(u8, hands) catch return error.OutOfMemory;
    @memset(page.ev_defined, 0);
    page.action_ev = allocator.alloc(f64, hands * n_act) catch return error.OutOfMemory;
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

    // Root CF values from response_walk already fold opponent reach + chance.
    // node_ev matches evaluatePublishedFrozen util for the acting seat.
    // Do not trust live masks after the walk (left on last runout); use range weights.
    var node_ev: f64 = 0;
    var any = false;
    hand = 0;
    while (hand < hands) : (hand += 1) {
        if (!(game.hands.range_w[actor][hand] > 0)) continue;
        any = true;
        page.ev_defined[hand] = 1;
        page.mixed_ev[hand] = ev[hand];
        node_ev += ev[hand];
        if (n_act <= 1) {
            page.action_ev[hand * n_act] = ev[hand];
            continue;
        }
        a = 0;
        while (a < n_act) : (a += 1) {
            page.action_ev[hand * n_act + a] = aev[a * hands + hand];
        }
    }
    page.reach_defined = any;
    page.node_ev_defined = any;
    if (any) page.node_ev = node_ev;
    return page;
}

/// True when every multi-action decision on the path to `target` is card_mode 0
/// (hand-only slots). Enables opponent betting-path reach without turn/river keys.
fn pathDecisionsAreMode0(game: compile.CompiledGame, target: u32) bool {
    var cur = target;
    while (true) {
        const n = game.nodes[cur];
        if (n.kind == .decision and n.n_actions > 1 and n.card_mode != 0) return false;
        if (n.parent < 0) return true;
        cur = @intCast(n.parent);
    }
}

/// Opponent average-policy mass along betting edges to `target` (hero reach omitted).
fn opponentBettingReach(
    game: compile.CompiledGame,
    sigma: []const f32,
    target: u32,
    actor: i32,
    deal: compile.Deal,
    turn: i32,
    river: i32,
) ActionEvError!f64 {
    var parents: [64]u32 = undefined;
    var parent_actions: [64]i32 = undefined;
    var depth: usize = 0;
    var cur = target;
    while (game.nodes[cur].parent >= 0) {
        if (depth >= parents.len) return error.InvalidAnalysis;
        parents[depth] = @intCast(game.nodes[cur].parent);
        parent_actions[depth] = game.nodes[cur].parent_action;
        cur = parents[depth];
        depth += 1;
    }
    var reach: f64 = 1.0;
    var i = depth;
    while (i > 0) {
        i -= 1;
        const pnode = game.nodes[parents[i]];
        const pa = parent_actions[i];
        if (pnode.kind != .decision or pa < 0 or pnode.n_actions <= 1) continue;
        if (pnode.player == actor) continue;
        const hand = if (pnode.player == 0) deal.h0 else deal.h1;
        if (hand < 0) return error.InvalidAnalysis;
        const key = game.cardKey(pnode, hand, turn, river) catch return error.InvalidAnalysis;
        if (key < 0 or @as(usize, @intCast(key)) >= pnode.slot_of.len) return error.InvalidAnalysis;
        const slot_i = pnode.slot_of[@intCast(key)];
        if (slot_i < 0) return error.InvalidAnalysis;
        const base: usize = @intCast(game.slots[@intCast(slot_i)].base);
        reach *= @as(f64, @floatCast(sigma[base + @as(usize, @intCast(pa))]));
    }
    return reach;
}

/// Deal-by-deal conditional action EV (oracle / non-root). Do not use on flop-scale roots.
pub fn actionValuesDealByDeal(
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

    // Non-root river (mode-0 path): weight deals by opponent betting reach so
    // facing-Bet Call EV matches C++ q_opp posterior (MATHEMATICS.md Q_i).
    const weight_by_opp_reach = node_index != 0 and pathDecisionsAreMode0(game, node_index);

    var reach_mass: f64 = 0;
    for (game.deals) |deal| {
        const hero_hand: i32 = if (node.player == 0) deal.h0 else deal.h1;
        if (hero_hand < 0 or @as(usize, @intCast(hero_hand)) >= hands) continue;
        const opp_w: f64 = if (weight_by_opp_reach)
            (opponentBettingReach(game, sigma, node_index, node.player, deal, turn, river) catch return error.InvalidAnalysis)
        else
            1.0;
        if (!(opp_w > 0)) continue;
        const w = deal.probability * opp_w;
        reach_mass += w;
        const hh: usize = @intCast(hero_hand);
        mass[hh] += w;

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
            action_sum[hh * node.n_actions + action] += w * child.utility[actor];
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
