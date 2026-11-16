//! Validate a recorded action line against a compiled preview tree.
const std = @import("std");
const poker_engine = @import("poker_engine");

const compile = poker_engine.game.compile;

pub const WalkResult = struct {
    /// Actions that land on a Study decision (not a terminal).
    decision_actions: []const []const u8,
    missing: []const []const u8,
    legal_at_decision: []const []const u8,
    ok: bool,

    pub fn deinit(self: *WalkResult, allocator: std.mem.Allocator) void {
        if (self.decision_actions.len != 0) allocator.free(self.decision_actions);
        if (self.missing.len != 0) allocator.free(self.missing);
        if (self.legal_at_decision.len != 0) allocator.free(self.legal_at_decision);
        self.* = undefined;
    }
};

fn labelsEql(a: []const u8, b: []const u8) bool {
    return std.ascii.eqlIgnoreCase(a, b);
}

fn skipChance(game: *const compile.CompiledGame, start: usize) usize {
    var index = start;
    var guard: usize = 0;
    while (guard < game.nodes.len + 2) : (guard += 1) {
        if (index >= game.nodes.len) return index;
        const node = game.nodes[index];
        if (node.kind != .chance) return index;
        index = @intCast(node.child[0]);
    }
    return index;
}

/// Walk `action_line` on the compiled tree. Study decision = last non-terminal
/// node along the longest valid prefix (do not enter Call/Fold terminals).
pub fn walkPlayedLine(
    allocator: std.mem.Allocator,
    game: *const compile.CompiledGame,
    action_line: []const []const u8,
) !WalkResult {
    var taken = std.ArrayList([]const u8).init(allocator);
    errdefer taken.deinit();
    var missing = std.ArrayList([]const u8).init(allocator);
    errdefer missing.deinit();

    var index: usize = 0;
    for (action_line) |want| {
        index = skipChance(game, index);
        if (index >= game.nodes.len) {
            try missing.append(want);
            break;
        }
        const node = game.nodes[index];
        if (node.kind != .decision) {
            try missing.append(want);
            break;
        }
        var hit: ?usize = null;
        var a: usize = 0;
        while (a < node.n_actions) : (a += 1) {
            if (labelsEql(node.action_labels[a], want)) {
                hit = a;
                break;
            }
        }
        if (hit == null) {
            try missing.append(want);
            break;
        }
        const child_index: usize = @intCast(node.child[hit.?]);
        const child_skip = skipChance(game, child_index);
        if (child_skip < game.nodes.len and game.nodes[child_skip].kind == .terminal) {
            // Stay on this decision for Study.
            break;
        }
        try taken.append(want);
        index = child_index;
    }

    index = skipChance(game, index);
    var legal = std.ArrayList([]const u8).init(allocator);
    errdefer legal.deinit();
    if (index < game.nodes.len and game.nodes[index].kind == .decision) {
        const node = game.nodes[index];
        var a: usize = 0;
        while (a < node.n_actions) : (a += 1) {
            try legal.append(node.action_labels[a]);
        }
    }

    const ok = missing.items.len == 0;
    return .{
        .decision_actions = try taken.toOwnedSlice(),
        .missing = try missing.toOwnedSlice(),
        .legal_at_decision = try legal.toOwnedSlice(),
        .ok = ok,
    };
}

pub fn validateConfigLine(
    allocator: std.mem.Allocator,
    config_text: []const u8,
    action_line: []const []const u8,
) !WalkResult {
    var bundle = try @import("poker_app").plan_preview.compilePreview(allocator, config_text);
    defer bundle.deinit();
    return walkPlayedLine(allocator, &bundle.game, action_line);
}
