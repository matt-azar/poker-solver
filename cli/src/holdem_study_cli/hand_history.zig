//! hand-history 1 → river holdem-study-job/1 (street boundary: 5-card board).
//! Range provenance uses seat labels / holes — not stakes or rake labels.
const std = @import("std");
const line_validate = @import("line_validate.zig");

pub const HhError = error{
    InvalidHeader,
    MissingField,
    BadNumber,
    UnsupportedStreet,
    MissingRange,
    OutOfMemory,
};

pub const Action = struct {
    player: u8,
    label: []u8,
};

pub const Record = struct {
    board: []u8,
    pot: f64,
    stack: f64,
    oop_hole: ?[]u8 = null,
    ip_hole: ?[]u8 = null,
    oop_label: ?[]u8 = null,
    ip_label: ?[]u8 = null,
    actions: []Action,
    terminal_pot: f64,
    outcome: []u8,
    p0_net: f64,

    pub fn deinit(self: *Record, allocator: std.mem.Allocator) void {
        allocator.free(self.board);
        if (self.oop_hole) |s| allocator.free(s);
        if (self.ip_hole) |s| allocator.free(s);
        if (self.oop_label) |s| allocator.free(s);
        if (self.ip_label) |s| allocator.free(s);
        for (self.actions) |a| allocator.free(a.label);
        if (self.actions.len != 0) allocator.free(self.actions);
        allocator.free(self.outcome);
        self.* = undefined;
    }
};

fn parseFinite(text: []const u8) HhError!f64 {
    return std.fmt.parseFloat(f64, text) catch error.BadNumber;
}

fn boardCardCount(board: []const u8) usize {
    var count: usize = 0;
    var it = std.mem.tokenizeAny(u8, board, " \t");
    while (it.next()) |_| count += 1;
    return count;
}

pub fn parse(allocator: std.mem.Allocator, text: []const u8) HhError!Record {
    var lines = std.mem.splitScalar(u8, text, '\n');
    const header = lines.next() orelse return error.InvalidHeader;
    if (!std.mem.eql(u8, std.mem.trim(u8, header, " \t\r"), "hand-history 1")) {
        return error.InvalidHeader;
    }

    var board: ?[]u8 = null;
    var pot: ?f64 = null;
    var stack: ?f64 = null;
    var oop_hole: ?[]u8 = null;
    var ip_hole: ?[]u8 = null;
    var oop_label: ?[]u8 = null;
    var ip_label: ?[]u8 = null;
    var actions_list = std.ArrayList(Action).init(allocator);
    errdefer {
        for (actions_list.items) |a| allocator.free(a.label);
        actions_list.deinit();
        if (board) |b| allocator.free(b);
        if (oop_hole) |s| allocator.free(s);
        if (ip_hole) |s| allocator.free(s);
        if (oop_label) |s| allocator.free(s);
        if (ip_label) |s| allocator.free(s);
    }
    var terminal_pot: ?f64 = null;
    var outcome: ?[]u8 = null;
    var p0_net: ?f64 = null;

    while (lines.next()) |raw_line| {
        const line = std.mem.trim(u8, raw_line, " \t\r");
        if (line.len == 0 or line[0] == '#') continue;
        const sp = std.mem.indexOfScalar(u8, line, ' ');
        const key = if (sp) |i| line[0..i] else line;
        const value = if (sp) |i| std.mem.trim(u8, line[i + 1 ..], " \t") else "";
        if (std.mem.eql(u8, key, "board")) {
            board = try allocator.dupe(u8, value);
        } else if (std.mem.eql(u8, key, "pot")) {
            pot = try parseFinite(value);
        } else if (std.mem.eql(u8, key, "stack")) {
            stack = try parseFinite(value);
        } else if (std.mem.eql(u8, key, "oop-hole")) {
            oop_hole = try allocator.dupe(u8, value);
        } else if (std.mem.eql(u8, key, "ip-hole")) {
            ip_hole = try allocator.dupe(u8, value);
        } else if (std.mem.eql(u8, key, "oop-label")) {
            oop_label = try allocator.dupe(u8, value);
        } else if (std.mem.eql(u8, key, "ip-label")) {
            ip_label = try allocator.dupe(u8, value);
        } else if (std.mem.eql(u8, key, "action")) {
            var tok = std.mem.tokenizeAny(u8, value, " \t");
            const player_s = tok.next() orelse return error.MissingField;
            const player = std.fmt.parseInt(u8, player_s, 10) catch return error.BadNumber;
            const label_rest = tok.rest();
            if (label_rest.len == 0) return error.MissingField;
            try actions_list.append(.{
                .player = player,
                .label = try allocator.dupe(u8, std.mem.trim(u8, label_rest, " \t")),
            });
        } else if (std.mem.eql(u8, key, "terminal-pot")) {
            terminal_pot = try parseFinite(value);
        } else if (std.mem.eql(u8, key, "outcome")) {
            outcome = try allocator.dupe(u8, value);
        } else if (std.mem.eql(u8, key, "p0-net")) {
            p0_net = try parseFinite(value);
        } else {
            return error.MissingField;
        }
    }

    const board_v = board orelse return error.MissingField;
    if (boardCardCount(board_v) != 5) return error.UnsupportedStreet;
    return .{
        .board = board_v,
        .pot = pot orelse return error.MissingField,
        .stack = stack orelse return error.MissingField,
        .oop_hole = oop_hole,
        .ip_hole = ip_hole,
        .oop_label = oop_label,
        .ip_label = ip_label,
        .actions = try actions_list.toOwnedSlice(),
        .terminal_pot = terminal_pot orelse return error.MissingField,
        .outcome = outcome orelse return error.MissingField,
        .p0_net = p0_net orelse return error.MissingField,
    };
}

fn rangeFor(seat_hole: ?[]const u8, seat_label: ?[]const u8) HhError![]const u8 {
    if (seat_hole) |h| {
        if (h.len != 0) return h;
    }
    if (seat_label) |l| {
        if (l.len != 0) return l;
    }
    return error.MissingRange;
}

fn appendJsonString(list: *std.ArrayList(u8), value: []const u8) !void {
    try std.json.stringify(value, .{}, list.writer());
}

fn betChips(label: []const u8) ?f64 {
    var core = label;
    if (std.mem.endsWith(u8, core, " all-in")) {
        core = core[0 .. core.len - " all-in".len];
    }
    if (std.mem.startsWith(u8, core, "Bet ")) {
        return std.fmt.parseFloat(f64, core[4..]) catch null;
    }
    if (std.mem.startsWith(u8, core, "Raise to ")) {
        return std.fmt.parseFloat(f64, core["Raise to ".len..]) catch null;
    }
    return null;
}

/// Emit holdem-study-job/1 JSON for a river HH.
/// Positions default to BB (OOP) / BTN (IP) for SRP-shaped spot notes — no stakes label.
pub fn riverJobJson(allocator: std.mem.Allocator, record: Record, iterations: i32) anyerror![]u8 {
    const oop_src = try rangeFor(record.oop_hole, record.oop_label);
    const ip_src = try rangeFor(record.ip_hole, record.ip_label);
    const oop_range = if (record.oop_hole != null)
        try std.fmt.allocPrint(allocator, "{s}:1", .{oop_src})
    else
        try allocator.dupe(u8, oop_src);
    defer allocator.free(oop_range);
    const ip_range = if (record.ip_hole != null)
        try std.fmt.allocPrint(allocator, "{s}:1", .{ip_src})
    else
        try allocator.dupe(u8, ip_src);
    defer allocator.free(ip_range);

    // Include played bet fractions + 0.5 so the default tree covers the line.
    var fracs = std.ArrayList(f64).init(allocator);
    defer fracs.deinit();
    const appendUnique = struct {
        fn call(list: *std.ArrayList(f64), value: f64) !void {
            if (!std.math.isFinite(value) or value <= 0) return;
            for (list.items) |existing| {
                if (@abs(existing - value) < 1e-9) return;
            }
            try list.append(value);
        }
    }.call;
    try appendUnique(&fracs, 0.5);
    for (record.actions) |a| {
        if (betChips(a.label)) |chips| {
            if (record.pot > 0) try appendUnique(&fracs, chips / record.pot);
        }
    }

    var config = std.ArrayList(u8).init(allocator);
    defer config.deinit();
    const cw = config.writer();
    try cw.writeAll("street-config 1\n");
    try cw.print("board {s}\n", .{record.board});
    try cw.print("pot {d}\n", .{record.pot});
    try cw.print("stack {d}\n", .{record.stack});
    try cw.print("oop-range {s}\n", .{oop_range});
    try cw.print("ip-range {s}\n", .{ip_range});
    try cw.writeAll("first-to-act 0\nmax-raises 2\nallow-three-bet 1\nall-in-threshold 0.5\npot-cap 0\nrake-rate 0\nrake-cap 0\nmemory-mib 256\nthreads 1\n");
    try cw.writeAll("oop-river-bets");
    for (fracs.items) |f| try cw.print(" {d}", .{f});
    try cw.writeAll("\nip-river-bets");
    for (fracs.items) |f| try cw.print(" {d}", .{f});
    try cw.writeAll("\n");

    var missing = std.ArrayList([]const u8).init(allocator);
    defer missing.deinit();

    // Authoritative missing_sizes: walk the compiled tree (not fraction lists alone).
    var action_labels = try allocator.alloc([]const u8, record.actions.len);
    defer allocator.free(action_labels);
    for (record.actions, 0..) |a, i| action_labels[i] = a.label;
    var walk = try line_validate.validateConfigLine(allocator, config.items, action_labels);
    defer walk.deinit(allocator);
    for (walk.missing) |m| try missing.append(m);

    var out = std.ArrayList(u8).init(allocator);
    errdefer out.deinit();
    const w = out.writer();
    try w.writeAll("{\n  \"schema\": \"holdem-study-job/1\",\n  \"street_config\": ");
    try appendJsonString(&out, config.items);
    try w.print(",\n  \"run\": {{\n    \"iterations\": {d},\n    \"accuracy\": null,\n    \"time_limit\": null\n  }}", .{iterations});
    try w.writeAll(",\n  \"provenance\": {\n    \"source\": \"hand-history\",\n    \"created_by\": \"holdem-study-cli\",\n");
    // Position pair + preflop family — not stakes/rake.
    try w.writeAll("    \"notes\": \"BTN vs BB SRP river from hand-history\",\n");
    try w.writeAll("    \"range_sources\": {\n      \"oop\": ");
    try appendJsonString(&out, oop_src);
    try w.writeAll(",\n      \"ip\": ");
    try appendJsonString(&out, ip_src);
    try w.writeAll("\n    }\n  },\n  \"review\": {\n");
    try w.writeAll("    \"positions\": { \"oop\": \"BB\", \"ip\": \"BTN\" },\n");
    try w.writeAll("    \"board\": [");
    {
        var it = std.mem.tokenizeAny(u8, record.board, " \t");
        var first = true;
        while (it.next()) |card| {
            if (!first) try w.writeAll(", ");
            first = false;
            try appendJsonString(&out, card);
        }
    }
    try w.print("],\n    \"pot\": {d},\n    \"effective_stack\": {d},\n", .{ record.pot, record.stack });
    try w.writeAll("    \"action_line\": [");
    for (record.actions, 0..) |a, i| {
        if (i > 0) try w.writeAll(", ");
        try appendJsonString(&out, a.label);
    }
    try w.writeAll("],\n    \"range_sources\": {\n      \"oop\": ");
    try appendJsonString(&out, oop_src);
    try w.writeAll(",\n      \"ip\": ");
    try appendJsonString(&out, ip_src);
    try w.writeAll("\n    },\n    \"missing_sizes\": [");
    for (missing.items, 0..) |m, i| {
        if (i > 0) try w.writeAll(", ");
        try appendJsonString(&out, m);
    }
    try w.writeAll("],\n    \"street_boundary\": \"river\"\n  },\n  \"decision\": {\n    \"actions\": [");
    for (walk.decision_actions, 0..) |label, di| {
        if (di > 0) try w.writeAll(", ");
        try appendJsonString(&out, label);
    }
    try w.writeAll("],\n    \"path\": ");
    {
        var path = std.ArrayList(u8).init(allocator);
        defer path.deinit();
        for (walk.decision_actions, 0..) |label, di| {
            if (di > 0) try path.append('/');
            try path.appendSlice(label);
        }
        try appendJsonString(&out, path.items);
    }
    try w.writeAll("\n  }\n}\n");
    // Always return reviewable JSON; callers must treat non-empty missing_sizes as failure.
    return try out.toOwnedSlice();
}
