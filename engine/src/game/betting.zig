const std = @import("std");
const chips = @import("../poker/chips.zig");
const size_spec = @import("../poker/size_spec.zig");
const street_spec = @import("street_spec.zig");
const tree_edit = @import("tree_edit.zig");

pub const BettingError = error{InvalidBetting};

pub const BetState = struct {
    contrib: [2]chips.Chip = .{ 0, 0 },
    pot: chips.Chip = 0,
    committed: chips.Chip = 0,
    last_raise: chips.Chip = 0,
    num_raises: i32 = 0,
    prev_aggressor: i32 = -1,
    street_aggressor: i32 = -1,
    acting: i32 = 0,
    street: i32 = 0,
    folded: i32 = -1,
    terminal: bool = false,
    pending_check: bool = false,
    chance: bool = false,
    deal_which: i32 = 0,
};

pub const Legal = struct {
    count: i32 = 0,
    code: [8]i32 = .{0} ** 8,
    add: [8]chips.Chip = .{0} ** 8,
};

pub fn bettingStreets(board_len: usize) i32 {
    return 6 - @as(i32, @intCast(board_len));
}

fn selectListed(specific: []const f64, shared: []const f64) []const f64 {
    if (size_spec.isExplicitEmptyList(specific)) return specific;
    if (specific.len != 0) return specific;
    if (size_spec.isExplicitEmptyList(shared)) return shared;
    return shared;
}

fn streetBetList(config: street_spec.StreetSpec, player: i32, kind: i32) []const f64 {
    if (player == 0) {
        return switch (kind) {
            0 => config.oop_flop_bets,
            1 => config.oop_turn_bets,
            else => config.oop_river_bets,
        };
    }
    return switch (kind) {
        0 => config.ip_flop_bets,
        1 => config.ip_turn_bets,
        else => config.ip_river_bets,
    };
}

fn streetRaiseList(config: street_spec.StreetSpec, player: i32, kind: i32) []const f64 {
    if (player == 0) {
        return switch (kind) {
            0 => config.oop_flop_raises,
            1 => config.oop_turn_raises,
            else => config.oop_river_raises,
        };
    }
    return switch (kind) {
        0 => config.ip_flop_raises,
        1 => config.ip_turn_raises,
        else => config.ip_river_raises,
    };
}

fn selectBets(config: street_spec.StreetSpec, player: i32, kind: i32) []const f64 {
    return selectListed(
        streetBetList(config, player, kind),
        if (player == 0) config.oop_bet_sizes else config.ip_bet_sizes,
    );
}

fn selectRaises(config: street_spec.StreetSpec, player: i32, kind: i32) []const f64 {
    return selectListed(
        streetRaiseList(config, player, kind),
        if (player == 0) config.oop_raise_sizes else config.ip_raise_sizes,
    );
}

fn selectDonk(config: street_spec.StreetSpec, kind: i32) struct { use_normal: bool, specs: []const f64 } {
    const street = switch (kind) {
        0 => config.oop_flop_donk,
        1 => config.oop_turn_donk,
        else => config.oop_river_donk,
    };
    if (street.len != 0) return .{ .use_normal = false, .specs = street };
    if (config.oop_donk_sizes.len != 0) return .{ .use_normal = false, .specs = config.oop_donk_sizes };
    return .{ .use_normal = true, .specs = &.{} };
}

pub fn fillAggressiveAmounts(
    config: street_spec.StreetSpec,
    state: BetState,
    betting_street_count: i32,
    amounts: *[8]chips.Chip,
    n_amounts: *i32,
) BettingError!void {
    return fillAggressiveAmountsImpl(config, state, betting_street_count, amounts, n_amounts);
}

fn expandAndConsider(
    config: street_spec.StreetSpec,
    state: BetState,
    ctx: size_spec.SpecContext,
    specs: []const f64,
    amounts: *[8]chips.Chip,
    n_amounts: *i32,
    aggressive_limit: i32,
) BettingError!void {
    if (size_spec.isExplicitEmptyList(specs)) return;

    const player = state.acting;
    const to_call = state.committed - state.contrib[@intCast(player)];
    const facing = to_call > 0;
    const max_add = config.stack - state.contrib[@intCast(player)];

    // Collect emitted adds via forEachSpecAdd into a temp, then consider each.
    var emitted_buf: [16]size_spec.SpecEmit = undefined;
    var emitted_n: usize = 0;
    size_spec.forEachSpecAdd(specs, ctx, struct {
        buf: *[16]size_spec.SpecEmit,
        n: *usize,
        pub fn call(self: @This(), emitted: size_spec.SpecEmit) void {
            if (self.n.* < self.buf.len) {
                self.buf.*[self.n.*] = emitted;
                self.n.* += 1;
            }
        }
    }{ .buf = &emitted_buf, .n = &emitted_n });

    for (emitted_buf[0..emitted_n]) |emitted| {
        try considerAmount(config, state, player, to_call, facing, max_add, emitted.add, emitted.force_all_in, amounts, n_amounts, aggressive_limit);
    }
}

/// Shared pot-cap / all-in-threshold / min-raise clamps for listed sizes and AddSize.
/// Returns null when the amount is illegal after clamps. `force_all_in` is for size-list
/// `a` tokens only; AddSize always passes false.
///
/// A listed size above remaining stack is always re-interpreted as all-in (NLHE shove).
/// Pio all-in threshold (fraction of starting stack) likewise converts a regular size
/// to all-in. Short-of-min-raise shoves are kept only for `a` / oversize / threshold —
/// list `a` for an explicit extra all-in.
fn resolveAggressiveAdd(
    config: street_spec.StreetSpec,
    state: BetState,
    add_in: chips.Chip,
    force_all_in: bool,
) ?chips.Chip {
    const player = state.acting;
    const to_call = state.committed - state.contrib[@intCast(player)];
    const facing = to_call > 0;
    const max_add = config.stack - state.contrib[@intCast(player)];
    var add = add_in;
    // Oversize / threshold shove-ups keep a short all-in (same as explicit `a`).
    var treat_as_all_in = force_all_in;
    if (facing and config.max_raises <= state.num_raises) return null;
    if (add < 1) return null;
    if (facing and !config.allow_three_bet and state.num_raises >= 1) return null;
    if (add > max_add) {
        add = max_add;
        treat_as_all_in = true;
    }
    if (config.all_in_threshold > 0.0) {
        const committed_after = @as(f64, @floatFromInt(state.contrib[@intCast(player)] + add));
        const limit = config.all_in_threshold * @as(f64, @floatFromInt(config.stack));
        if (committed_after > limit and add < max_add) {
            add = max_add;
            treat_as_all_in = true;
        }
    }
    if (config.pot_cap > 0.0) {
        const reference = if (facing) state.pot + to_call else state.pot;
        var max_by = chips.roundChips(config.pot_cap, reference) catch 1;
        if (max_by < 1) max_by = 1;
        if (add - to_call > max_by) add = to_call + max_by;
    }
    const raise_by = add - to_call;
    if (raise_by <= 0) return null;
    const min_increment: chips.Chip = if (state.last_raise == 0) 1 else state.last_raise;
    const full = raise_by >= min_increment;
    const shove = state.contrib[@intCast(player)] + add == config.stack;
    if (!full and !(shove and treat_as_all_in)) return null;
    return add;
}

fn considerAmount(
    config: street_spec.StreetSpec,
    state: BetState,
    player: i32,
    to_call: chips.Chip,
    facing: bool,
    max_add: chips.Chip,
    add_in: chips.Chip,
    force_all_in: bool,
    amounts: *[8]chips.Chip,
    n_amounts: *i32,
    aggressive_limit: i32,
) BettingError!void {
    _ = player;
    _ = to_call;
    _ = facing;
    _ = max_add;
    const add = resolveAggressiveAdd(config, state, add_in, force_all_in) orelse return;

    var i: i32 = 0;
    while (i < n_amounts.*) : (i += 1) {
        if (amounts.*[@intCast(i)] == add) return;
    }
    if (n_amounts.* >= aggressive_limit) return error.InvalidBetting;
    var slot = n_amounts.*;
    while (slot > 0 and amounts.*[@intCast(slot - 1)] > add) {
        amounts.*[@intCast(slot)] = amounts.*[@intCast(slot - 1)];
        slot -= 1;
    }
    amounts.*[@intCast(slot)] = add;
    n_amounts.* += 1;
}

fn fillAggressiveAmountsImpl(
    config: street_spec.StreetSpec,
    state: BetState,
    betting_street_count: i32,
    amounts: *[8]chips.Chip,
    n_amounts: *i32,
) BettingError!void {
    const player = state.acting;
    const to_call = state.committed - state.contrib[@intCast(player)];
    const facing = to_call > 0;
    const max_add = config.stack - state.contrib[@intCast(player)];
    if (to_call < 0 or max_add < 0) return error.InvalidBetting;

    n_amounts.* = 0;
    const aggressive_limit: i32 = if (facing) 6 else 7;
    const kind = state.street + @as(i32, @intCast(config.board.len)) - 3;
    const basis = if (facing) state.pot + to_call else state.pot;
    const ctx = size_spec.SpecContext{
        .basis = basis,
        .to_call = to_call,
        .contrib = state.contrib[@intCast(player)],
        .max_add = max_add,
        .committed = state.committed,
        .streets_left = betting_street_count - state.street,
        .num_raises = state.num_raises,
        .facing = facing,
    };

    const donk_spot = !facing and player == 0 and state.prev_aggressor == 1;
    const multiples = if (player == 0) config.oop_raise_multiples else config.ip_raise_multiples;
    const only_multiples = facing and multiples.len != 0 and streetRaiseList(config, player, kind).len == 0 and (if (player == 0) config.oop_raise_sizes else config.ip_raise_sizes).len == 0;

    if (donk_spot) {
        const donk = selectDonk(config, kind);
        if (!donk.use_normal) {
            try expandAndConsider(config, state, ctx, donk.specs, amounts, n_amounts, aggressive_limit);
        } else {
            try expandAndConsider(config, state, ctx, selectBets(config, player, kind), amounts, n_amounts, aggressive_limit);
        }
    } else if (!only_multiples) {
        const list = if (facing) selectRaises(config, player, kind) else selectBets(config, player, kind);
        try expandAndConsider(config, state, ctx, list, amounts, n_amounts, aggressive_limit);
    }
    if (facing) {
        for (multiples) |multiple| {
            if (multiple <= 0.0 or state.committed <= 0) continue;
            const street_total: chips.Chip = @intFromFloat(@round(multiple * @as(f64, @floatFromInt(state.committed))));
            try considerAmount(config, state, player, to_call, facing, max_add, street_total - state.contrib[@intCast(player)], false, amounts, n_amounts, aggressive_limit);
        }
    }
    if (config.merge_threshold > 0.0) {
        size_spec.mergeCloseAmounts(amounts, n_amounts, config.merge_threshold);
    }
}

pub fn legalActions(config: street_spec.StreetSpec, state: BetState) BettingError!Legal {
    const player = state.acting;
    const to_call = state.committed - state.contrib[@intCast(player)];
    const facing = to_call > 0;
    const max_add = config.stack - state.contrib[@intCast(player)];
    if (to_call < 0 or max_add < 0) return error.InvalidBetting;

    var amounts: [8]chips.Chip = .{0} ** 8;
    var n_amounts: i32 = 0;
    try fillAggressiveAmounts(config, state, bettingStreets(config.board.len), &amounts, &n_amounts);

    var legal = Legal{};
    if (facing) {
        legal.code[@intCast(legal.count)] = 0;
        legal.add[@intCast(legal.count)] = 0;
        legal.count += 1;
        const call_add = if (to_call < max_add) to_call else max_add;
        legal.code[@intCast(legal.count)] = 1;
        legal.add[@intCast(legal.count)] = call_add;
        legal.count += 1;
    } else {
        legal.code[@intCast(legal.count)] = 1;
        legal.add[@intCast(legal.count)] = 0;
        legal.count += 1;
    }
    var i: i32 = 0;
    while (i < n_amounts) : (i += 1) {
        if (legal.count >= 8) return error.InvalidBetting;
        legal.code[@intCast(legal.count)] = 2;
        legal.add[@intCast(legal.count)] = amounts[@intCast(i)];
        legal.count += 1;
    }
    return legal;
}

pub fn chipLabel(
    code: i32,
    add: chips.Chip,
    street_total: chips.Chip,
    all_in: bool,
    facing: bool,
    buf: []u8,
) BettingError![]const u8 {
    var fbs = std.io.fixedBufferStream(buf);
    const w = fbs.writer();
    if (code == 0) {
        w.writeAll("Fold") catch return error.InvalidBetting;
    } else if (code == 1 and !facing) {
        w.writeAll("Check") catch return error.InvalidBetting;
    } else if (code == 1) {
        w.writeAll("Call") catch return error.InvalidBetting;
    } else if (!facing) {
        var chip_buf: [32]u8 = undefined;
        const digits = chips.formatChips(add, true, &chip_buf) catch return error.InvalidBetting;
        w.print("Bet {s}", .{digits}) catch return error.InvalidBetting;
    } else {
        var chip_buf: [32]u8 = undefined;
        const digits = chips.formatChips(street_total, true, &chip_buf) catch return error.InvalidBetting;
        w.print("Raise to {s}", .{digits}) catch return error.InvalidBetting;
    }
    if (all_in and code != 0) {
        w.writeAll(" all-in") catch return error.InvalidBetting;
    }
    return fbs.getWritten();
}

pub fn compactActionToken(
    code: i32,
    add: chips.Chip,
    street_total: chips.Chip,
    all_in: bool,
    facing: bool,
    buf: []u8,
) BettingError![]const u8 {
    var fbs = std.io.fixedBufferStream(buf);
    const w = fbs.writer();
    if (code == 0) {
        w.writeAll("f") catch return error.InvalidBetting;
    } else if (code == 1) {
        w.writeAll(if (facing) "call" else "c") catch return error.InvalidBetting;
    } else {
        var chip_buf: [32]u8 = undefined;
        const digits = chips.formatChips(if (facing) street_total else add, true, &chip_buf) catch return error.InvalidBetting;
        w.print("{s}{s}", .{ if (facing) "r" else "b", digits }) catch return error.InvalidBetting;
        if (all_in) w.writeAll("ai") catch return error.InvalidBetting;
    }
    return fbs.getWritten();
}

fn finishStreet(config: street_spec.StreetSpec, state: *BetState) void {
    state.prev_aggressor = state.street_aggressor;
    state.street_aggressor = -1;
    state.pending_check = false;
    state.acting = -1;
    if (state.street + 1 < bettingStreets(config.board.len)) {
        const flop_tree = config.board.len == 3;
        state.chance = true;
        state.deal_which = if (flop_tree and state.street == 0) 1 else 2;
        state.street += 1;
        return;
    }
    state.terminal = true;
}

pub fn applyAction(config: street_spec.StreetSpec, state_in: BetState, legal: Legal, action: i32) BetState {
    var state = state_in;
    const player = state.acting;
    const code = legal.code[@intCast(action)];
    const add = legal.add[@intCast(action)];
    if (code == 0) {
        state.folded = player;
        state.terminal = true;
        state.acting = -1;
        return state;
    }
    const to_call = state.committed - state.contrib[@intCast(player)];
    state.contrib[@intCast(player)] += add;
    state.pot += add;
    if (code == 1) {
        if (to_call > 0 or state.pending_check) {
            finishStreet(config, &state);
            return state;
        }
        state.pending_check = true;
        state.acting = 1 - player;
        return state;
    }
    const raise_by = add - to_call;
    state.pending_check = false;
    state.last_raise = raise_by;
    state.committed = state.contrib[@intCast(player)];
    if (to_call > 0) state.num_raises += 1;
    state.street_aggressor = player;
    state.acting = 1 - player;
    return state;
}

/// Compact path token from a public display label (C++ compact_from_display_label).
/// Fold/Check/Call → f/c/call; "Bet 50" → b50; "Raise to 100 all-in" → r100ai.
pub fn compactFromDisplayLabel(label: []const u8, buf: []u8) ?[]const u8 {
    if (std.mem.eql(u8, label, "Fold")) return "f";
    if (std.mem.eql(u8, label, "Check")) return "c";
    if (std.mem.eql(u8, label, "Call")) return "call";
    var core = label;
    var all_in = false;
    if (std.mem.endsWith(u8, core, " all-in")) {
        all_in = true;
        core = core[0 .. core.len - " all-in".len];
    }
    var fbs = std.io.fixedBufferStream(buf);
    const w = fbs.writer();
    if (core.len > 4 and std.mem.eql(u8, core[0..4], "Bet ")) {
        w.print("b{s}", .{core[4..]}) catch return null;
        if (all_in) w.writeAll("ai") catch return null;
        return fbs.getWritten();
    }
    if (core.len > 9 and std.mem.eql(u8, core[0..9], "Raise to ")) {
        w.print("r{s}", .{core[9..]}) catch return null;
        if (all_in) w.writeAll("ai") catch return null;
        return fbs.getWritten();
    }
    return null;
}

fn pathTokenMatchesDisplay(token: []const u8, display: []const u8) bool {
    if (std.mem.eql(u8, token, display)) return true;
    var compact_buf: [64]u8 = undefined;
    const compact = compactFromDisplayLabel(display, &compact_buf) orelse return false;
    return std.mem.eql(u8, token, compact);
}

/// Per-edit apply outcome across the public tree (compiled soft report).
pub const EditApplyStatus = enum {
    never_matched_path,
    applied,
    action_missing,
    illegal_size,
    duplicate,
    remove_would_empty,
};

pub fn editApplyStatusName(status: EditApplyStatus) []const u8 {
    return switch (status) {
        .never_matched_path => "never_matched_path",
        .applied => "applied",
        .action_missing => "action_missing",
        .illegal_size => "illegal_size",
        .duplicate => "duplicate",
        .remove_would_empty => "remove_would_empty",
    };
}

fn noteEditStatus(statuses: ?[]EditApplyStatus, index: usize, next: EditApplyStatus) void {
    if (statuses == null) return;
    const cur = statuses.?[index];
    if (cur == .applied) return;
    statuses.?[index] = next;
}

/// Resolve AddSize chip add with the same clamps as listed sizes (`considerAmount`).
fn resolveAddSizeAmount(
    config: street_spec.StreetSpec,
    state: BetState,
    edit: tree_edit.LineEdit,
) ?chips.Chip {
    const player = state.acting;
    const to_call = state.committed - state.contrib[@intCast(player)];
    const facing = to_call > 0;
    const basis = if (facing) state.pot + to_call else state.pot;
    const sized: chips.Chip = if (edit.usesChipSize())
        edit.size_chips
    else
        chips.roundChips(edit.size_pot_fraction, basis) catch return null;
    const add_in: chips.Chip = if (facing) to_call + sized else sized;
    return resolveAggressiveAdd(config, state, add_in, false);
}

fn insertAggressiveAmount(legal: *Legal, add: chips.Chip) BettingError!enum { inserted, duplicate } {
    var i: i32 = 0;
    while (i < legal.count) : (i += 1) {
        if (legal.code[@intCast(i)] == 2 and legal.add[@intCast(i)] == add) {
            return .duplicate;
        }
    }
    if (legal.count >= 8) return error.InvalidBetting;
    var slot = legal.count;
    while (slot > 0 and legal.code[@intCast(slot - 1)] == 2 and legal.add[@intCast(slot - 1)] > add) {
        legal.code[@intCast(slot)] = legal.code[@intCast(slot - 1)];
        legal.add[@intCast(slot)] = legal.add[@intCast(slot - 1)];
        slot -= 1;
    }
    legal.code[@intCast(slot)] = 2;
    legal.add[@intCast(slot)] = add;
    legal.count += 1;
    return .inserted;
}

fn pathMatchesPublicLine(path: tree_edit.LinePath, public_path: []const u8) bool {
    var steps: [24][]const u8 = undefined;
    var n_steps: usize = 0;
    if (public_path.len != 0) {
        var cursor: usize = 0;
        while (true) {
            const slash = std.mem.indexOfScalarPos(u8, public_path, cursor, '/') orelse {
                steps[n_steps] = public_path[cursor..];
                n_steps += 1;
                break;
            };
            steps[n_steps] = public_path[cursor..slash];
            n_steps += 1;
            cursor = slash + 1;
        }
    }
    if (path.steps.len != n_steps) return false;
    for (path.steps, 0..) |step, i| {
        if (!pathTokenMatchesDisplay(step.label, steps[i])) return false;
    }
    return true;
}

fn tokenMatchesAction(
    token: []const u8,
    code: i32,
    add: chips.Chip,
    street_total: chips.Chip,
    all_in: bool,
    facing: bool,
) bool {
    var label_buf: [64]u8 = undefined;
    const label = chipLabel(code, add, street_total, all_in, facing, &label_buf) catch return false;
    if (std.mem.eql(u8, token, label)) return true;
    var compact_buf: [64]u8 = undefined;
    const compact = compactActionToken(code, add, street_total, all_in, facing, &compact_buf) catch return false;
    return std.mem.eql(u8, token, compact);
}

pub fn applyTreeEdits(
    legal: *Legal,
    config: street_spec.StreetSpec,
    state: BetState,
    public_path: []const u8,
    statuses: ?[]EditApplyStatus,
) BettingError!void {
    if (config.tree_edits.len == 0) return;
    if (statuses) |s| {
        if (s.len != config.tree_edits.len) return error.InvalidBetting;
    }
    const facing = state.committed > state.contrib[@intCast(state.acting)];
    for (config.tree_edits, 0..) |edit, edit_i| {
        if (!pathMatchesPublicLine(edit.path, public_path)) continue;
        if (edit.kind == .add_size) {
            const add = resolveAddSizeAmount(config, state, edit) orelse {
                noteEditStatus(statuses, edit_i, .illegal_size);
                continue;
            };
            const insert = try insertAggressiveAmount(legal, add);
            noteEditStatus(statuses, edit_i, if (insert == .duplicate) .duplicate else .applied);
            continue;
        }
        if (edit.kind == .force) {
            var keep: i32 = -1;
            var i: i32 = 0;
            while (i < legal.count) : (i += 1) {
                const street_total = state.contrib[@intCast(state.acting)] + legal.add[@intCast(i)];
                const all_in = legal.code[@intCast(i)] != 0 and street_total == config.stack and legal.add[@intCast(i)] > 0;
                if (tokenMatchesAction(edit.action, legal.code[@intCast(i)], legal.add[@intCast(i)], street_total, all_in, facing)) {
                    keep = i;
                    break;
                }
            }
            if (keep < 0) {
                noteEditStatus(statuses, edit_i, .action_missing);
                continue;
            }
            legal.code[0] = legal.code[@intCast(keep)];
            legal.add[0] = legal.add[@intCast(keep)];
            legal.count = 1;
            noteEditStatus(statuses, edit_i, .applied);
            continue;
        }
        if (edit.kind == .remove) {
            var filtered = Legal{};
            var removed_any = false;
            var i: i32 = 0;
            while (i < legal.count) : (i += 1) {
                const street_total = state.contrib[@intCast(state.acting)] + legal.add[@intCast(i)];
                const all_in = legal.code[@intCast(i)] != 0 and street_total == config.stack and legal.add[@intCast(i)] > 0;
                if (tokenMatchesAction(edit.action, legal.code[@intCast(i)], legal.add[@intCast(i)], street_total, all_in, facing)) {
                    removed_any = true;
                    continue;
                }
                filtered.code[@intCast(filtered.count)] = legal.code[@intCast(i)];
                filtered.add[@intCast(filtered.count)] = legal.add[@intCast(i)];
                filtered.count += 1;
            }
            if (!removed_any) {
                noteEditStatus(statuses, edit_i, .action_missing);
            } else if (filtered.count == 0) {
                // Keep at least one legal action; still report the soft skip.
                noteEditStatus(statuses, edit_i, .remove_would_empty);
            } else {
                legal.* = filtered;
                noteEditStatus(statuses, edit_i, .applied);
            }
        }
    }
}

test "check-only root has Check" {
    var config = street_spec.StreetSpec.init(std.testing.allocator);
    defer config.deinit();
    config.board = try std.testing.allocator.dupe(i32, &[_]i32{ 48, 45, 24 }); // Ah Kd 7c approx — overwritten below
    // Use parsed cards
    std.testing.allocator.free(config.board);
    const ah = try @import("../poker/card.zig").parseCard("Ah");
    const kd = try @import("../poker/card.zig").parseCard("Kd");
    const c7 = try @import("../poker/card.zig").parseCard("7c");
    config.board = try std.testing.allocator.dupe(i32, &[_]i32{ ah, kd, c7 });
    config.pot = chips.chipUnits(100);
    config.stack = chips.chipUnits(200);
    config.max_raises = 0;
    config.all_in_threshold = 0;

    var state = BetState{};
    state.pot = config.pot;
    state.acting = config.first_to_act;
    const legal = try legalActions(config, state);
    try std.testing.expectEqual(@as(i32, 1), legal.count);
    try std.testing.expectEqual(@as(i32, 1), legal.code[0]);
    try std.testing.expectEqual(@as(i32, 0), legal.add[0]);
}

test "oversized listed bet becomes all-in" {
    // b100 with stack < pot must shove (DS-26).
    var config = street_spec.StreetSpec.init(std.testing.allocator);
    defer config.deinit();
    const ah = try @import("../poker/card.zig").parseCard("Ah");
    const kd = try @import("../poker/card.zig").parseCard("Kd");
    const c7 = try @import("../poker/card.zig").parseCard("7c");
    const s2 = try @import("../poker/card.zig").parseCard("2s");
    const h2 = try @import("../poker/card.zig").parseCard("2h");
    config.board = try std.testing.allocator.dupe(i32, &[_]i32{ ah, kd, c7, s2, h2 });
    config.pot = try chips.chipsToTenths(82.2);
    config.stack = try chips.chipsToTenths(61.4);
    config.max_raises = 1;
    config.all_in_threshold = 0;
    config.oop_river_bets = try std.testing.allocator.dupe(f64, &[_]f64{1.0});

    var state = BetState{};
    state.pot = config.pot;
    state.acting = config.first_to_act;
    const legal = try legalActions(config, state);
    try std.testing.expectEqual(@as(i32, 2), legal.count);
    try std.testing.expectEqual(@as(i32, 1), legal.code[0]); // Check
    try std.testing.expectEqual(@as(i32, 0), legal.add[0]);
    try std.testing.expectEqual(@as(i32, 2), legal.code[1]); // Bet
    try std.testing.expectEqual(config.stack, legal.add[1]); // all-in
}

test "default half-stack all-in threshold shoves 60pct pot" {
    // Default threshold 0.5: committing more than half the starting stack → all-in.
    var config = street_spec.StreetSpec.init(std.testing.allocator);
    defer config.deinit();
    const ah = try @import("../poker/card.zig").parseCard("Ah");
    const kd = try @import("../poker/card.zig").parseCard("Kd");
    const c7 = try @import("../poker/card.zig").parseCard("7c");
    const s2 = try @import("../poker/card.zig").parseCard("2s");
    config.board = try std.testing.allocator.dupe(i32, &[_]i32{ ah, kd, c7, s2 });
    config.pot = chips.chipUnits(100);
    config.stack = chips.chipUnits(100);
    config.max_raises = 1;
    try std.testing.expectApproxEqAbs(@as(f64, 0.5), config.all_in_threshold, 1e-12);
    config.oop_turn_bets = try std.testing.allocator.dupe(f64, &[_]f64{0.6});

    var state = BetState{};
    state.pot = config.pot;
    state.acting = config.first_to_act;
    const legal = try legalActions(config, state);
    try std.testing.expectEqual(@as(i32, 2), legal.count);
    try std.testing.expectEqual(@as(i32, 2), legal.code[1]);
    try std.testing.expectEqual(config.stack, legal.add[1]);
}

test "all-in threshold 0.8 shoves 90pct pot" {
    var config = street_spec.StreetSpec.init(std.testing.allocator);
    defer config.deinit();
    const ah = try @import("../poker/card.zig").parseCard("Ah");
    const kd = try @import("../poker/card.zig").parseCard("Kd");
    const c7 = try @import("../poker/card.zig").parseCard("7c");
    const s2 = try @import("../poker/card.zig").parseCard("2s");
    config.board = try std.testing.allocator.dupe(i32, &[_]i32{ ah, kd, c7, s2 });
    config.pot = chips.chipUnits(100);
    config.stack = chips.chipUnits(100);
    config.max_raises = 1;
    config.all_in_threshold = 0.8;
    config.oop_turn_bets = try std.testing.allocator.dupe(f64, &[_]f64{0.9});

    var state = BetState{};
    state.pot = config.pot;
    state.acting = config.first_to_act;
    const legal = try legalActions(config, state);
    try std.testing.expectEqual(@as(i32, 2), legal.count);
    try std.testing.expectEqual(@as(i32, 2), legal.code[1]);
    try std.testing.expectEqual(config.stack, legal.add[1]);
}
