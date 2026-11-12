const std = @import("std");
const compile = @import("../game/compile.zig");
const range_mod = @import("../poker/range.zig");
const training_state = @import("../solve/training_state.zig");

pub const InspectError = error{ InvalidAnalysis, OutOfMemory };

/// Strategy page for one public decision under a published average revision (D2).
/// Row copy only — never reads trainer-exclusive sigma.
pub const NodePage = struct {
    allocator: std.mem.Allocator,
    node_index: u32 = 0,
    player: i32 = -1,
    policy_revision: u64 = 0,
    actions: [][]const u8 = &.{},
    /// Hero combo labels in PrivateHandIndex order.
    combos: [][]const u8 = &.{},
    /// Hand-major strategy: hand * n_actions + action. Empty when n_actions <= 1.
    strategy: []f32 = &.{},
    n_actions: u8 = 0,
    n_hands: i32 = 0,

    pub fn deinit(self: *NodePage) void {
        for (self.actions) |label| {
            if (label.len != 0) self.allocator.free(label);
        }
        if (self.actions.len != 0) self.allocator.free(self.actions);
        for (self.combos) |label| {
            if (label.len != 0) self.allocator.free(label);
        }
        if (self.combos.len != 0) self.allocator.free(self.combos);
        if (self.strategy.len != 0) self.allocator.free(self.strategy);
        self.* = .{ .allocator = self.allocator };
    }
};

fn strategyBuffer(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    published: training_state.PublishedPolicy,
) InspectError![]const f32 {
    if (published.average.len != 0) return published.average;
    var uniform = training_state.TrainingState.init(allocator, game) catch return error.OutOfMemory;
    defer uniform.deinit();
    return allocator.dupe(f32, uniform.sigma) catch return error.OutOfMemory;
}

/// Copy requested strategy rows for a public decision node from the published average.
pub fn inspectNode(
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    published: training_state.PublishedPolicy,
    node_index: u32,
    turn: i32,
    river: i32,
) InspectError!NodePage {
    if (node_index >= game.nodes.len) return error.InvalidAnalysis;
    const node = game.nodes[node_index];
    if (node.kind != .decision) return error.InvalidAnalysis;

    var page = NodePage{
        .allocator = allocator,
        .node_index = node_index,
        .player = node.player,
        .policy_revision = published.revision,
        .n_actions = node.n_actions,
        .n_hands = node.hands,
    };
    errdefer page.deinit();

    page.actions = allocator.alloc([]const u8, node.n_actions) catch return error.OutOfMemory;
    @memset(page.actions, "");
    var a: usize = 0;
    while (a < node.n_actions) : (a += 1) {
        page.actions[a] = allocator.dupe(u8, node.action_labels[a]) catch return error.OutOfMemory;
    }

    const player: usize = @intCast(node.player);
    const hands: usize = @intCast(@max(node.hands, 0));
    page.combos = allocator.alloc([]const u8, hands) catch return error.OutOfMemory;
    @memset(page.combos, "");
    var hand: usize = 0;
    while (hand < hands) : (hand += 1) {
        const combo = game.hands.combos[player][hand];
        var buf: [4]u8 = undefined;
        const text = range_mod.Range.comboText(combo, &buf) catch return error.InvalidAnalysis;
        page.combos[hand] = allocator.dupe(u8, text) catch return error.OutOfMemory;
    }

    if (node.n_actions <= 1) {
        // Implicit σ=1 — no stored row.
        return page;
    }

    var owned_sigma: ?[]f32 = null;
    defer if (owned_sigma) |buf| allocator.free(buf);
    const sigma: []const f32 = blk: {
        if (published.average.len != 0) break :blk published.average;
        var uniform = training_state.TrainingState.init(allocator, game) catch return error.OutOfMemory;
        defer uniform.deinit();
        owned_sigma = allocator.dupe(f32, uniform.sigma) catch return error.OutOfMemory;
        break :blk owned_sigma.?;
    };

    page.strategy = allocator.alloc(f32, hands * node.n_actions) catch return error.OutOfMemory;
    @memset(page.strategy, 0);
    hand = 0;
    while (hand < hands) : (hand += 1) {
        const key = game.cardKey(node, @intCast(hand), turn, river) catch {
            // Unsupported hand/runout — leave zeros.
            continue;
        };
        if (key < 0 or @as(usize, @intCast(key)) >= node.slot_of.len) continue;
        const slot_i = node.slot_of[@intCast(key)];
        if (slot_i < 0) continue;
        const base: usize = @intCast(game.slots[@intCast(slot_i)].base);
        const row = sigma[base .. base + node.n_actions];
        const dest = hand * node.n_actions;
        @memcpy(page.strategy[dest .. dest + node.n_actions], row);
    }
    return page;
}
