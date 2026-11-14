const std = @import("std");
const card = @import("../poker/card.zig");
const chips = @import("../poker/chips.zig");
const range_mod = @import("../poker/range.zig");
const size_spec = @import("../poker/size_spec.zig");
const street_spec = @import("street_spec.zig");
const tree_edit = @import("tree_edit.zig");

pub const ConfigError = error{
    InvalidStreetConfig,
    OutOfMemory,
};

pub fn parseStreetConfig(allocator: std.mem.Allocator, text: []const u8) ConfigError!street_spec.StreetSpec {
    var lines = try splitConfigLines(allocator, text);
    defer lines.deinit();
    if (lines.items.len == 0 or !std.mem.eql(u8, lines.items[0], "street-config 1")) {
        return error.InvalidStreetConfig;
    }

    var config = street_spec.StreetSpec.init(allocator);
    errdefer config.deinit();

    var seen = std.StringHashMap(void).init(allocator);
    defer seen.deinit();

    var incentive_rules = std.ArrayList(street_spec.IncentiveRule).init(allocator);
    errdefer {
        for (incentive_rules.items) |rule| {
            if (rule.key.len != 0) allocator.free(rule.key);
        }
        incentive_rules.deinit();
    }
    var edge_tags = std.ArrayList(street_spec.IncentiveEdgeTagSpec).init(allocator);
    errdefer {
        for (edge_tags.items) |spec| {
            if (spec.action_key.len != 0) allocator.free(spec.action_key);
            for (spec.tags) |tag| allocator.free(tag);
            if (spec.tags.len != 0) allocator.free(spec.tags);
        }
        edge_tags.deinit();
    }
    var edits = std.ArrayList(tree_edit.LineEdit).init(allocator);
    errdefer {
        for (edits.items) |edit| tree_edit.freeEdit(allocator, edit);
        edits.deinit();
    }

    for (lines.items[1..]) |line| {
        if (line.len == 0) return error.InvalidStreetConfig;
        const space = std.mem.indexOfScalar(u8, line, ' ');
        const key = if (space) |s| line[0..s] else line;
        const value = if (space) |s| line[s + 1 ..] else "";

        if (std.mem.eql(u8, key, "tree-edit")) {
            try appendTreeEdit(allocator, &edits, value);
            continue;
        }
        if (std.mem.eql(u8, key, "incentive")) {
            try appendIncentiveRule(allocator, &incentive_rules, value);
            continue;
        }
        if (std.mem.eql(u8, key, "edge-tag")) {
            try appendEdgeTag(allocator, &edge_tags, value);
            continue;
        }

        const gop = seen.getOrPut(key) catch return error.OutOfMemory;
        if (gop.found_existing) return error.InvalidStreetConfig;
        gop.value_ptr.* = {};

        try assignUniqueField(&config, allocator, key, value);
    }

    config.incentives.rules = incentive_rules.toOwnedSlice() catch return error.OutOfMemory;
    config.incentives.edge_tags = edge_tags.toOwnedSlice() catch return error.OutOfMemory;
    config.tree_edits = edits.toOwnedSlice() catch return error.OutOfMemory;
    return config;
}

pub fn formatStreetConfig(allocator: std.mem.Allocator, config: street_spec.StreetSpec) ConfigError![]u8 {
    var out = std.ArrayList(u8).init(allocator);
    errdefer out.deinit();

    try appendLine(&out, "street-config", "1");
    try appendBoardLine(allocator, &out, config.board);
    try appendChipLine(&out, "pot", config.pot);
    try appendChipLine(&out, "stack", config.stack);
    try appendRangeLine(allocator, &out, "oop-range", config.oop);
    try appendRangeLine(allocator, &out, "ip-range", config.ip);
    try appendInt(&out, "first-to-act", config.first_to_act);
    try appendInt(&out, "max-raises", config.max_raises);
    try appendFlag(&out, "allow-three-bet", config.allow_three_bet);
    try appendNumber(&out, "all-in-threshold", config.all_in_threshold);
    try appendNumber(&out, "pot-cap", config.pot_cap);
    if (config.merge_threshold != 0.0) {
        try appendNumber(&out, "merge-threshold", config.merge_threshold);
    }
    try appendNumber(&out, "rake-rate", config.rake.rate);
    try appendNumber(&out, "rake-cap", config.rake.cap);
    try appendNumbers(&out, "icm-stacks", config.icm.stacks);
    try appendNumbers(&out, "icm-payouts", config.icm.payouts);
    try appendIncentiveLines(&out, config.incentives.rules);
    try appendEdgeTagLines(allocator, &out, config.incentives.edge_tags);
    try appendInt(&out, "memory-mib", config.memory_mib);
    try appendInt(&out, "threads", config.threads);
    try appendSizeSpecFields(&out, config);
    try appendNumbers(&out, "oop-raise-multiples", config.oop_raise_multiples);
    try appendNumbers(&out, "ip-raise-multiples", config.ip_raise_multiples);
    for (config.tree_edits) |edit| {
        var buf: [512]u8 = undefined;
        const line = tree_edit.formatOneEdit(edit, &buf) catch return error.InvalidStreetConfig;
        try appendLine(&out, "tree-edit", line);
    }
    return out.toOwnedSlice() catch return error.OutOfMemory;
}

/// Require a trailing LF. CRLF (`\r\n`) is accepted: Windows checkouts normalize
/// by stripping a trailing CR from each line (shipping path; Git may check out CRLF).
fn splitConfigLines(allocator: std.mem.Allocator, text: []const u8) ConfigError!std.ArrayList([]const u8) {
    if (text.len == 0 or text[text.len - 1] != '\n') return error.InvalidStreetConfig;

    var lines = std.ArrayList([]const u8).init(allocator);
    errdefer lines.deinit();
    var start: usize = 0;
    while (start < text.len) {
        const end = std.mem.indexOfScalarPos(u8, text, start, '\n') orelse text.len;
        var line = text[start..end];
        if (line.len > 0 and line[line.len - 1] == '\r') {
            line = line[0 .. line.len - 1];
        }
        // Bare CR mid-line (not CRLF) is invalid.
        if (std.mem.indexOfScalar(u8, line, '\r') != null) return error.InvalidStreetConfig;
        lines.append(line) catch return error.OutOfMemory;
        start = end + 1;
    }
    if (lines.items.len > 0 and lines.items[lines.items.len - 1].len == 0) {
        _ = lines.pop();
    }
    return lines;
}

fn appendTreeEdit(
    allocator: std.mem.Allocator,
    edits: *std.ArrayList(tree_edit.LineEdit),
    value: []const u8,
) ConfigError!void {
    if (value.len == 0) return error.InvalidStreetConfig;
    const edit = tree_edit.parseOneEdit(allocator, value) catch return error.InvalidStreetConfig;
    edits.append(edit) catch {
        tree_edit.freeEdit(allocator, edit);
        return error.OutOfMemory;
    };
}

fn appendIncentiveRule(
    allocator: std.mem.Allocator,
    incentive_rules: *std.ArrayList(street_spec.IncentiveRule),
    value: []const u8,
) ConfigError!void {
    const tokens = try splitTokens(allocator, value);
    defer allocator.free(tokens);
    if (tokens.len != 4) return error.InvalidStreetConfig;
    var rule = street_spec.IncentiveRule{};
    if (std.mem.eql(u8, tokens[0], "label")) {
        rule.kind = .action_label_match;
    } else if (std.mem.eql(u8, tokens[0], "tag")) {
        rule.kind = .category_tag;
    } else return error.InvalidStreetConfig;
    rule.player = std.fmt.parseInt(i32, tokens[1], 10) catch return error.InvalidStreetConfig;
    rule.key = allocator.dupe(u8, tokens[2]) catch return error.OutOfMemory;
    rule.delta = std.fmt.parseFloat(f64, tokens[3]) catch return error.InvalidStreetConfig;
    incentive_rules.append(rule) catch {
        allocator.free(rule.key);
        return error.OutOfMemory;
    };
}

fn appendEdgeTag(
    allocator: std.mem.Allocator,
    edge_tags: *std.ArrayList(street_spec.IncentiveEdgeTagSpec),
    value: []const u8,
) ConfigError!void {
    const tokens = try splitTokens(allocator, value);
    defer allocator.free(tokens);
    if (tokens.len < 2) return error.InvalidStreetConfig;
    var spec = street_spec.IncentiveEdgeTagSpec{};
    var tag_at: usize = 1;
    if (tokens[0].len == 1 and (tokens[0][0] == '0' or tokens[0][0] == '1') and tokens.len >= 3) {
        spec.player = std.fmt.parseInt(i32, tokens[0], 10) catch return error.InvalidStreetConfig;
        spec.action_key = allocator.dupe(u8, tokens[1]) catch return error.OutOfMemory;
        tag_at = 2;
    } else {
        spec.action_key = allocator.dupe(u8, tokens[0]) catch return error.OutOfMemory;
    }
    var tags = std.ArrayList([]const u8).init(allocator);
    errdefer {
        for (tags.items) |t| allocator.free(t);
        tags.deinit();
        allocator.free(spec.action_key);
    }
    var i = tag_at;
    while (i < tokens.len) : (i += 1) {
        const owned = allocator.dupe(u8, tokens[i]) catch return error.OutOfMemory;
        tags.append(owned) catch {
            allocator.free(owned);
            return error.OutOfMemory;
        };
    }
    spec.tags = tags.toOwnedSlice() catch return error.OutOfMemory;
    edge_tags.append(spec) catch {
        for (spec.tags) |t| allocator.free(t);
        allocator.free(spec.tags);
        allocator.free(spec.action_key);
        return error.OutOfMemory;
    };
}

fn assignUniqueField(
    config: *street_spec.StreetSpec,
    allocator: std.mem.Allocator,
    key: []const u8,
    value: []const u8,
) ConfigError!void {
    if (std.mem.eql(u8, key, "board")) {
        config.board = try parseBoard(allocator, value);
    } else if (std.mem.eql(u8, key, "pot")) {
        config.pot = chips.parseChips(value) catch return error.InvalidStreetConfig;
    } else if (std.mem.eql(u8, key, "stack")) {
        config.stack = chips.parseChips(value) catch return error.InvalidStreetConfig;
    } else if (std.mem.eql(u8, key, "oop-range")) {
        config.oop = range_mod.Range.parse(value) catch return error.InvalidStreetConfig;
    } else if (std.mem.eql(u8, key, "ip-range")) {
        config.ip = range_mod.Range.parse(value) catch return error.InvalidStreetConfig;
    } else if (std.mem.eql(u8, key, "first-to-act")) {
        config.first_to_act = parseInt(value) catch return error.InvalidStreetConfig;
    } else if (std.mem.eql(u8, key, "max-raises")) {
        config.max_raises = parseInt(value) catch return error.InvalidStreetConfig;
    } else if (std.mem.eql(u8, key, "allow-three-bet")) {
        config.allow_three_bet = parseFlag(value) catch return error.InvalidStreetConfig;
    } else if (std.mem.eql(u8, key, "geometric")) {
        _ = parseFlag(value) catch return error.InvalidStreetConfig;
    } else if (std.mem.eql(u8, key, "all-in-threshold")) {
        config.all_in_threshold = parseFinite(value) catch return error.InvalidStreetConfig;
    } else if (std.mem.eql(u8, key, "pot-cap")) {
        config.pot_cap = parseFinite(value) catch return error.InvalidStreetConfig;
    } else if (std.mem.eql(u8, key, "merge-threshold")) {
        config.merge_threshold = parseFinite(value) catch return error.InvalidStreetConfig;
    } else if (std.mem.eql(u8, key, "rake-rate")) {
        config.rake.rate = parseFinite(value) catch return error.InvalidStreetConfig;
    } else if (std.mem.eql(u8, key, "rake-cap")) {
        config.rake.cap = parseFinite(value) catch return error.InvalidStreetConfig;
    } else if (std.mem.eql(u8, key, "icm-stacks")) {
        config.icm.stacks = try parseNumbers(allocator, value);
    } else if (std.mem.eql(u8, key, "icm-payouts")) {
        config.icm.payouts = try parseNumbers(allocator, value);
    } else if (std.mem.eql(u8, key, "memory-mib")) {
        config.memory_mib = parseInt(value) catch return error.InvalidStreetConfig;
    } else if (std.mem.eql(u8, key, "threads")) {
        config.threads = parseInt(value) catch return error.InvalidStreetConfig;
    } else if (std.mem.eql(u8, key, "oop-raise-multiples")) {
        config.oop_raise_multiples = try parseNumbers(allocator, value);
    } else if (std.mem.eql(u8, key, "ip-raise-multiples")) {
        config.ip_raise_multiples = try parseNumbers(allocator, value);
    } else if (try matchSizeField(config, allocator, key, value)) {
        // assigned
    } else {
        return error.InvalidStreetConfig;
    }
}

fn parseBoard(allocator: std.mem.Allocator, value: []const u8) ConfigError![]card.Card {
    const tokens = try splitTokens(allocator, value);
    defer allocator.free(tokens);
    var board = allocator.alloc(card.Card, tokens.len) catch return error.OutOfMemory;
    errdefer allocator.free(board);
    for (tokens, 0..) |tok, i| {
        board[i] = card.parseCard(tok) catch return error.InvalidStreetConfig;
    }
    return board;
}

fn appendBoardLine(allocator: std.mem.Allocator, out: *std.ArrayList(u8), board: []const card.Card) ConfigError!void {
    var board_buf = std.ArrayList(u8).init(allocator);
    defer board_buf.deinit();
    for (board, 0..) |c, i| {
        if (i != 0) board_buf.append(' ') catch return error.OutOfMemory;
        var card_buf: [2]u8 = undefined;
        const text = card.formatCard(c, &card_buf) catch return error.InvalidStreetConfig;
        board_buf.appendSlice(text) catch return error.OutOfMemory;
    }
    try appendLine(out, "board", board_buf.items);
}

fn appendChipLine(out: *std.ArrayList(u8), key: []const u8, value: chips.Chip) ConfigError!void {
    var buf: [32]u8 = undefined;
    const text = chips.formatChips(value, true, &buf) catch return error.InvalidStreetConfig;
    try appendLine(out, key, text);
}

fn appendRangeLine(
    allocator: std.mem.Allocator,
    out: *std.ArrayList(u8),
    key: []const u8,
    range: range_mod.Range,
) ConfigError!void {
    const text = range.toComboList(allocator) catch return error.InvalidStreetConfig;
    defer allocator.free(text);
    try appendLine(out, key, text);
}

fn appendIncentiveLines(out: *std.ArrayList(u8), rules: []const street_spec.IncentiveRule) ConfigError!void {
    for (rules) |rule| {
        var value_buf: [256]u8 = undefined;
        const kind = if (rule.kind == .category_tag) "tag" else "label";
        const value = std.fmt.bufPrint(&value_buf, "{s} {d} {s} {d}", .{ kind, rule.player, rule.key, rule.delta }) catch return error.InvalidStreetConfig;
        try appendLine(out, "incentive", value);
    }
}

fn appendEdgeTagLines(
    allocator: std.mem.Allocator,
    out: *std.ArrayList(u8),
    edge_tags: []const street_spec.IncentiveEdgeTagSpec,
) ConfigError!void {
    for (edge_tags) |spec| {
        var value = std.ArrayList(u8).init(allocator);
        defer value.deinit();
        if (spec.player >= 0) {
            value.writer().print("{d} ", .{spec.player}) catch return error.OutOfMemory;
        }
        value.appendSlice(spec.action_key) catch return error.OutOfMemory;
        for (spec.tags) |tag| {
            value.append(' ') catch return error.OutOfMemory;
            value.appendSlice(tag) catch return error.OutOfMemory;
        }
        try appendLine(out, "edge-tag", value.items);
    }
}

fn appendSizeSpecFields(out: *std.ArrayList(u8), config: street_spec.StreetSpec) ConfigError!void {
    try appendSpecs(out, "oop-bets", config.oop_bet_sizes);
    try appendSpecs(out, "ip-bets", config.ip_bet_sizes);
    try appendSpecs(out, "oop-raises", config.oop_raise_sizes);
    try appendSpecs(out, "ip-raises", config.ip_raise_sizes);
    try appendSpecs(out, "oop-flop-bets", config.oop_flop_bets);
    try appendSpecs(out, "oop-turn-bets", config.oop_turn_bets);
    try appendSpecs(out, "oop-river-bets", config.oop_river_bets);
    try appendSpecs(out, "ip-flop-bets", config.ip_flop_bets);
    try appendSpecs(out, "ip-turn-bets", config.ip_turn_bets);
    try appendSpecs(out, "ip-river-bets", config.ip_river_bets);
    try appendSpecs(out, "oop-flop-raises", config.oop_flop_raises);
    try appendSpecs(out, "oop-turn-raises", config.oop_turn_raises);
    try appendSpecs(out, "oop-river-raises", config.oop_river_raises);
    try appendSpecs(out, "ip-flop-raises", config.ip_flop_raises);
    try appendSpecs(out, "ip-turn-raises", config.ip_turn_raises);
    try appendSpecs(out, "ip-river-raises", config.ip_river_raises);
    try appendSpecs(out, "oop-donk", config.oop_donk_sizes);
    try appendSpecs(out, "oop-flop-donk", config.oop_flop_donk);
    try appendSpecs(out, "oop-turn-donk", config.oop_turn_donk);
    try appendSpecs(out, "oop-river-donk", config.oop_river_donk);
}

fn matchSizeField(config: *street_spec.StreetSpec, allocator: std.mem.Allocator, key: []const u8, value: []const u8) ConfigError!bool {
    const Field = struct {
        name: []const u8,
        allow_multiple: bool,
        ptr: *[]f64,
    };
    const fields = [_]Field{
        .{ .name = "oop-bets", .allow_multiple = false, .ptr = &config.oop_bet_sizes },
        .{ .name = "ip-bets", .allow_multiple = false, .ptr = &config.ip_bet_sizes },
        .{ .name = "oop-raises", .allow_multiple = true, .ptr = &config.oop_raise_sizes },
        .{ .name = "ip-raises", .allow_multiple = true, .ptr = &config.ip_raise_sizes },
        .{ .name = "oop-flop-bets", .allow_multiple = false, .ptr = &config.oop_flop_bets },
        .{ .name = "oop-turn-bets", .allow_multiple = false, .ptr = &config.oop_turn_bets },
        .{ .name = "oop-river-bets", .allow_multiple = false, .ptr = &config.oop_river_bets },
        .{ .name = "ip-flop-bets", .allow_multiple = false, .ptr = &config.ip_flop_bets },
        .{ .name = "ip-turn-bets", .allow_multiple = false, .ptr = &config.ip_turn_bets },
        .{ .name = "ip-river-bets", .allow_multiple = false, .ptr = &config.ip_river_bets },
        .{ .name = "oop-flop-raises", .allow_multiple = true, .ptr = &config.oop_flop_raises },
        .{ .name = "oop-turn-raises", .allow_multiple = true, .ptr = &config.oop_turn_raises },
        .{ .name = "oop-river-raises", .allow_multiple = true, .ptr = &config.oop_river_raises },
        .{ .name = "ip-flop-raises", .allow_multiple = true, .ptr = &config.ip_flop_raises },
        .{ .name = "ip-turn-raises", .allow_multiple = true, .ptr = &config.ip_turn_raises },
        .{ .name = "ip-river-raises", .allow_multiple = true, .ptr = &config.ip_river_raises },
        .{ .name = "oop-donk", .allow_multiple = false, .ptr = &config.oop_donk_sizes },
        .{ .name = "oop-flop-donk", .allow_multiple = false, .ptr = &config.oop_flop_donk },
        .{ .name = "oop-turn-donk", .allow_multiple = false, .ptr = &config.oop_turn_donk },
        .{ .name = "oop-river-donk", .allow_multiple = false, .ptr = &config.oop_river_donk },
    };
    for (fields) |field| {
        if (std.mem.eql(u8, key, field.name)) {
            field.ptr.* = try parsePioSpecs(allocator, value, field.allow_multiple);
            return true;
        }
    }
    return false;
}

fn splitTokens(allocator: std.mem.Allocator, value: []const u8) ConfigError![][]const u8 {
    var tokens = std.ArrayList([]const u8).init(allocator);
    errdefer tokens.deinit();
    if (value.len == 0) return tokens.toOwnedSlice() catch return error.OutOfMemory;
    var index: usize = 0;
    while (index < value.len) {
        if (value[index] == ' ') return error.InvalidStreetConfig;
        const next = std.mem.indexOfScalarPos(u8, value, index, ' ');
        const end = next orelse value.len;
        tokens.append(value[index..end]) catch return error.OutOfMemory;
        if (next == null) break;
        index = next.? + 1;
        if (index == value.len) return error.InvalidStreetConfig;
    }
    return tokens.toOwnedSlice() catch return error.OutOfMemory;
}

fn parsePioSpecs(allocator: std.mem.Allocator, value: []const u8, allow_multiple: bool) ConfigError![]f64 {
    const tokens = try splitTokens(allocator, value);
    defer allocator.free(tokens);
    var specs = allocator.alloc(f64, tokens.len) catch return error.OutOfMemory;
    errdefer allocator.free(specs);
    for (tokens, 0..) |tok, i| {
        specs[i] = size_spec.parseSizeToken(tok, allow_multiple) catch return error.InvalidStreetConfig;
    }
    return specs;
}

fn parseNumbers(allocator: std.mem.Allocator, value: []const u8) ConfigError![]f64 {
    const tokens = try splitTokens(allocator, value);
    defer allocator.free(tokens);
    var numbers = allocator.alloc(f64, tokens.len) catch return error.OutOfMemory;
    errdefer allocator.free(numbers);
    for (tokens, 0..) |tok, i| {
        if (tok.len > 0 and (tok[tok.len - 1] == 'c' or tok[tok.len - 1] == 'x' or tok[tok.len - 1] == 'X')) {
            return error.InvalidStreetConfig;
        }
        numbers[i] = parseFinite(tok) catch return error.InvalidStreetConfig;
    }
    return numbers;
}

fn parseFinite(text: []const u8) ConfigError!f64 {
    const value = std.fmt.parseFloat(f64, text) catch return error.InvalidStreetConfig;
    if (!std.math.isFinite(value)) return error.InvalidStreetConfig;
    return value;
}

fn parseInt(text: []const u8) ConfigError!i32 {
    return std.fmt.parseInt(i32, text, 10) catch return error.InvalidStreetConfig;
}

fn parseFlag(text: []const u8) ConfigError!bool {
    if (std.mem.eql(u8, text, "0")) return false;
    if (std.mem.eql(u8, text, "1")) return true;
    return error.InvalidStreetConfig;
}

fn appendLine(out: *std.ArrayList(u8), key: []const u8, value: []const u8) ConfigError!void {
    out.appendSlice(key) catch return error.OutOfMemory;
    if (value.len != 0) {
        out.append(' ') catch return error.OutOfMemory;
        out.appendSlice(value) catch return error.OutOfMemory;
    }
    out.append('\n') catch return error.OutOfMemory;
}

fn appendInt(out: *std.ArrayList(u8), key: []const u8, value: i32) ConfigError!void {
    var buf: [32]u8 = undefined;
    const text = std.fmt.bufPrint(&buf, "{d}", .{value}) catch return error.InvalidStreetConfig;
    try appendLine(out, key, text);
}

fn appendFlag(out: *std.ArrayList(u8), key: []const u8, value: bool) ConfigError!void {
    try appendLine(out, key, if (value) "1" else "0");
}

fn appendNumber(out: *std.ArrayList(u8), key: []const u8, value: f64) ConfigError!void {
    var buf: [64]u8 = undefined;
    const text = std.fmt.bufPrint(&buf, "{d}", .{value}) catch return error.InvalidStreetConfig;
    try appendLine(out, key, text);
}

fn appendNumbers(out: *std.ArrayList(u8), key: []const u8, values: []const f64) ConfigError!void {
    if (values.len == 0) return;
    var value = std.ArrayList(u8).init(out.allocator);
    defer value.deinit();
    for (values, 0..) |n, i| {
        if (i != 0) value.append(' ') catch return error.OutOfMemory;
        var buf: [64]u8 = undefined;
        const text = std.fmt.bufPrint(&buf, "{d}", .{n}) catch return error.InvalidStreetConfig;
        value.appendSlice(text) catch return error.OutOfMemory;
    }
    try appendLine(out, key, value.items);
}

fn appendSpecs(out: *std.ArrayList(u8), key: []const u8, specs: []const f64) ConfigError!void {
    if (specs.len == 0) return;
    var value = std.ArrayList(u8).init(out.allocator);
    defer value.deinit();
    for (specs, 0..) |spec, i| {
        if (i != 0) value.append(' ') catch return error.OutOfMemory;
        var buf: [64]u8 = undefined;
        const text = size_spec.formatSpec(spec, &buf) catch return error.InvalidStreetConfig;
        value.appendSlice(text) catch return error.OutOfMemory;
    }
    try appendLine(out, key, value.items);
}

test "parse street default fixture" {
    const text =
        \\street-config 1
        \\board Kh Kd 7c 4s
        \\pot 100
        \\stack 100
        \\oop-range AhAd:1
        \\ip-range 3d2c:1
        \\first-to-act 0
        \\max-raises 1
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 1024
        \\threads 1
        \\oop-bets 1
        \\oop-raises 1
        \\
    ;
    var config = try parseStreetConfig(std.testing.allocator, text);
    defer config.deinit();
    try std.testing.expectEqual(@as(usize, 4), config.board.len);
    try std.testing.expectEqual(chips.chipUnits(100), config.pot);
    try std.testing.expectEqual(@as(i32, 0), config.first_to_act);
    try std.testing.expectApproxEqAbs(@as(f64, 0.0), config.all_in_threshold, 1e-12);
    try std.testing.expectEqual(@as(usize, 1), config.oop_bet_sizes.len);
    try std.testing.expectApproxEqAbs(@as(f64, 1.0), config.oop_bet_sizes[0], 1e-12);

    const formatted = try formatStreetConfig(std.testing.allocator, config);
    defer std.testing.allocator.free(formatted);
    var again = try parseStreetConfig(std.testing.allocator, formatted);
    defer again.deinit();
    try std.testing.expectEqual(config.board.len, again.board.len);
    try std.testing.expectEqual(config.pot, again.pot);
    try std.testing.expectEqual(config.stack, again.stack);
    try std.testing.expectApproxEqAbs(config.all_in_threshold, again.all_in_threshold, 1e-12);
}

test "reject unknown scalar key" {
    const text =
        \\street-config 1
        \\board Ah Kd 7c
        \\pot 100
        \\stack 100
        \\oop-range AhAd:1
        \\ip-range KcKd:1
        \\first-to-act 0
        \\max-raises 1
        \\not-a-real-field 1
        \\allow-three-bet 1
        \\all-in-threshold 0.5
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 64
        \\threads 1
        \\
    ;
    try std.testing.expectError(error.InvalidStreetConfig, parseStreetConfig(std.testing.allocator, text));
}

test "reject bad version" {
    try std.testing.expectError(error.InvalidStreetConfig, parseStreetConfig(std.testing.allocator, "street-config 2\n"));
}

test "reject missing trailing newline" {
    try std.testing.expectError(error.InvalidStreetConfig, parseStreetConfig(std.testing.allocator, "street-config 1"));
    try std.testing.expectError(error.InvalidStreetConfig, parseStreetConfig(std.testing.allocator, "street-config 1\r"));
}

test "accept CRLF line endings" {
    // Same fixture as "parse street default fixture", but Windows CRLF.
    const text =
        "street-config 1\r\n" ++
        "board Kh Kd 7c 4s\r\n" ++
        "pot 100\r\n" ++
        "stack 100\r\n" ++
        "oop-range AhAd:1\r\n" ++
        "ip-range 3d2c:1\r\n" ++
        "first-to-act 0\r\n" ++
        "max-raises 1\r\n" ++
        "allow-three-bet 1\r\n" ++
        "all-in-threshold 0\r\n" ++
        "pot-cap 0\r\n" ++
        "rake-rate 0\r\n" ++
        "rake-cap 0\r\n" ++
        "memory-mib 1024\r\n" ++
        "threads 1\r\n" ++
        "oop-bets 1\r\n" ++
        "oop-raises 1\r\n";
    var config = try parseStreetConfig(std.testing.allocator, text);
    defer config.deinit();
    try std.testing.expectEqual(@as(usize, 4), config.board.len);
    try std.testing.expectEqual(chips.chipUnits(100), config.pot);
    try std.testing.expectEqual(@as(usize, 1), config.oop_bet_sizes.len);
}

test "reject bare CR mid-line" {
    try std.testing.expectError(
        error.InvalidStreetConfig,
        parseStreetConfig(std.testing.allocator, "street-config 1\npot 1\r00\n"),
    );
}

test "tree-edit round trip line" {
    const text =
        \\street-config 1
        \\board Ah Kd 7c
        \\pot 100
        \\stack 200
        \\oop-range AhAd:1
        \\ip-range KcKd:1
        \\first-to-act 0
        \\max-raises 1
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 1024
        \\threads 1
        \\tree-edit force - c
        \\
    ;
    var config = try parseStreetConfig(std.testing.allocator, text);
    defer config.deinit();
    try std.testing.expectEqual(@as(usize, 1), config.tree_edits.len);
    try std.testing.expect(config.tree_edits[0].kind == .force);
}
