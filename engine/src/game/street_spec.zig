const std = @import("std");
const card = @import("../poker/card.zig");
const chips = @import("../poker/chips.zig");
const range_mod = @import("../poker/range.zig");
const tree_edit = @import("tree_edit.zig");

pub const RakeConfig = struct {
    rate: f64 = 0,
    cap: f64 = 0,
};

pub const IcmConfig = struct {
    stacks: []f64 = &.{},
    payouts: []f64 = &.{},
};

pub const IncentiveKind = enum { action_label_match, category_tag };

pub const IncentiveRule = struct {
    kind: IncentiveKind = .action_label_match,
    player: i32 = 0,
    key: []const u8 = "",
    delta: f64 = 0,
};

pub const IncentiveEdgeTagSpec = struct {
    player: i32 = -1, // -1 = either seat
    action_key: []const u8 = "",
    tags: [][]const u8 = &.{},
};

pub const IncentiveConfig = struct {
    rules: []IncentiveRule = &.{},
    edge_tags: []IncentiveEdgeTagSpec = &.{},
};

/// Typed game specification (C++ StreetConfig). Owned slices use `allocator`.
pub const StreetSpec = struct {
    allocator: std.mem.Allocator,
    board: []card.Card = &.{},
    pot: chips.Chip = chips.chipUnits(100),
    stack: chips.Chip = chips.chipUnits(200),
    oop: range_mod.Range = .{},
    ip: range_mod.Range = .{},
    oop_bet_sizes: []f64 = &.{},
    ip_bet_sizes: []f64 = &.{},
    oop_raise_sizes: []f64 = &.{},
    ip_raise_sizes: []f64 = &.{},
    oop_flop_bets: []f64 = &.{},
    oop_turn_bets: []f64 = &.{},
    oop_river_bets: []f64 = &.{},
    ip_flop_bets: []f64 = &.{},
    ip_turn_bets: []f64 = &.{},
    ip_river_bets: []f64 = &.{},
    oop_flop_raises: []f64 = &.{},
    oop_turn_raises: []f64 = &.{},
    oop_river_raises: []f64 = &.{},
    ip_flop_raises: []f64 = &.{},
    ip_turn_raises: []f64 = &.{},
    ip_river_raises: []f64 = &.{},
    oop_donk_sizes: []f64 = &.{},
    oop_flop_donk: []f64 = &.{},
    oop_turn_donk: []f64 = &.{},
    oop_river_donk: []f64 = &.{},
    oop_raise_multiples: []f64 = &.{},
    ip_raise_multiples: []f64 = &.{},
    all_in_threshold: f64 = 0,
    pot_cap: f64 = 0,
    merge_threshold: f64 = 0,
    allow_all_in: bool = true,
    allow_three_bet: bool = true,
    max_raises: i32 = 1,
    first_to_act: i32 = 0,
    memory_mib: i32 = 1024,
    threads: i32 = 1,
    rake: RakeConfig = .{},
    icm: IcmConfig = .{},
    incentives: IncentiveConfig = .{},
    tree_edits: []tree_edit.LineEdit = &.{},

    pub fn init(allocator: std.mem.Allocator) StreetSpec {
        return .{ .allocator = allocator };
    }

    pub fn deinit(self: *StreetSpec) void {
        if (self.board.len != 0) self.allocator.free(self.board);
        freeSlice(self.allocator, self.oop_bet_sizes);
        freeSlice(self.allocator, self.ip_bet_sizes);
        freeSlice(self.allocator, self.oop_raise_sizes);
        freeSlice(self.allocator, self.ip_raise_sizes);
        freeSlice(self.allocator, self.oop_flop_bets);
        freeSlice(self.allocator, self.oop_turn_bets);
        freeSlice(self.allocator, self.oop_river_bets);
        freeSlice(self.allocator, self.ip_flop_bets);
        freeSlice(self.allocator, self.ip_turn_bets);
        freeSlice(self.allocator, self.ip_river_bets);
        freeSlice(self.allocator, self.oop_flop_raises);
        freeSlice(self.allocator, self.oop_turn_raises);
        freeSlice(self.allocator, self.oop_river_raises);
        freeSlice(self.allocator, self.ip_flop_raises);
        freeSlice(self.allocator, self.ip_turn_raises);
        freeSlice(self.allocator, self.ip_river_raises);
        freeSlice(self.allocator, self.oop_donk_sizes);
        freeSlice(self.allocator, self.oop_flop_donk);
        freeSlice(self.allocator, self.oop_turn_donk);
        freeSlice(self.allocator, self.oop_river_donk);
        freeSlice(self.allocator, self.oop_raise_multiples);
        freeSlice(self.allocator, self.ip_raise_multiples);
        freeSlice(self.allocator, self.icm.stacks);
        freeSlice(self.allocator, self.icm.payouts);
        for (self.incentives.rules) |rule| {
            if (rule.key.len != 0) self.allocator.free(rule.key);
        }
        if (self.incentives.rules.len != 0) self.allocator.free(self.incentives.rules);
        for (self.incentives.edge_tags) |spec| {
            if (spec.action_key.len != 0) self.allocator.free(spec.action_key);
            for (spec.tags) |tag| self.allocator.free(tag);
            if (spec.tags.len != 0) self.allocator.free(spec.tags);
        }
        if (self.incentives.edge_tags.len != 0) self.allocator.free(self.incentives.edge_tags);
        for (self.tree_edits) |edit| tree_edit.freeEdit(self.allocator, edit);
        if (self.tree_edits.len != 0) self.allocator.free(self.tree_edits);
        self.* = init(self.allocator);
    }
};

fn freeSlice(allocator: std.mem.Allocator, slice: []f64) void {
    if (slice.len != 0) allocator.free(slice);
}
