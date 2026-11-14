//! Side-effect-free tree preview + memory plan (ZR-83).
//! Temp parse + compile + estimate + deinit only — never mutates Session.
const std = @import("std");
const poker_engine = @import("poker_engine");

const compile = poker_engine.game.compile;
const tree_edit = poker_engine.game.tree_edit;

pub const PreviewError = error{OutOfMemory} || poker_engine.game.street_config.ConfigError || compile.CompileError || tree_edit.TreeEditError;

/// Rough peak for compiled game + training tables + one published average.
/// Copied from Session so preview/plan never share Session internals.
pub fn estimateSolutionBytes(game: compile.CompiledGame) u64 {
    const te: u64 = @intCast(@max(game.table_entries, 0));
    const deal_bytes = game.deals.len * @sizeOf(compile.Deal);
    const slot_bytes = game.slots.len * @sizeOf(compile.Slot);
    const node_bytes = game.nodes.len * @sizeOf(compile.Node);
    // regret + strategy_sum + sigma + published average
    const table_bytes = te * @sizeOf(f32) * 4;
    // Conservative scratch / ranks / maps overhead for flop-scale trees.
    const overhead = te * 32 + game.deals.len * 16;
    return deal_bytes + slot_bytes + node_bytes + table_bytes + overhead;
}

/// Duplicated from compile.zig (private there; ZR-94 owns that file).
fn compactFromDisplay(label: []const u8, buf: []u8) []const u8 {
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
        w.print("b{s}", .{core[4..]}) catch return label;
        if (all_in) w.writeAll("ai") catch {};
        return fbs.getWritten();
    }
    if (core.len > 9 and std.mem.eql(u8, core[0..9], "Raise to ")) {
        w.print("r{s}", .{core[9..]}) catch return label;
        if (all_in) w.writeAll("ai") catch {};
        return fbs.getWritten();
    }
    return label;
}

fn clampThreads(threads: i32) u32 {
    if (threads < 1) return 1;
    return @intCast(@min(threads, 64));
}

pub const MemoryPlan = struct {
    estimated_peak_bytes: u64 = 0,
    memory_budget_bytes: u64 = 0,
    deals: u64 = 0,
    infosets: u64 = 0,
    decision_nodes: u64 = 0,
    terminals: u64 = 0,
    public_decisions: u64 = 0,
    threads: u32 = 1,
    fits_budget: bool = false,
    dry_run: bool = true,
};

pub fn buildMemoryPlan(game: compile.CompiledGame, memory_mib: i32, threads: i32) MemoryPlan {
    const estimated = estimateSolutionBytes(game);
    const budget: u64 = if (memory_mib <= 0) 0 else @as(u64, @intCast(memory_mib)) * 1024 * 1024;
    var decisions: u64 = 0;
    var terminals: u64 = 0;
    for (game.nodes) |n| {
        if (n.kind == .decision) decisions += 1;
        if (n.kind == .terminal) terminals += 1;
    }
    return .{
        .estimated_peak_bytes = estimated,
        .memory_budget_bytes = budget,
        .deals = game.deals.len,
        .infosets = game.infosetCount(),
        .decision_nodes = decisions,
        .terminals = terminals,
        .public_decisions = game.public_decisions,
        .threads = clampThreads(threads),
        .fits_budget = budget > 0 and estimated <= budget,
        .dry_run = true,
    };
}

pub const PreviewBundle = struct {
    allocator: std.mem.Allocator,
    game: compile.CompiledGame,
    plan: MemoryPlan,
    tree_edit_lines: [][]u8,

    pub fn deinit(self: *PreviewBundle) void {
        for (self.tree_edit_lines) |line| self.allocator.free(line);
        if (self.tree_edit_lines.len != 0) self.allocator.free(self.tree_edit_lines);
        self.game.deinit();
        self.* = undefined;
    }
};

fn ownTreeEditLines(allocator: std.mem.Allocator, edits: []const tree_edit.LineEdit) PreviewError![][]u8 {
    if (edits.len == 0) return &.{};
    var lines = try allocator.alloc([]u8, edits.len);
    var filled: usize = 0;
    errdefer {
        for (lines[0..filled]) |line| allocator.free(line);
        allocator.free(lines);
    }
    while (filled < edits.len) : (filled += 1) {
        var buf: [256]u8 = undefined;
        const formatted = try tree_edit.formatOneEdit(edits[filled], &buf);
        lines[filled] = try allocator.dupe(u8, formatted);
    }
    return lines;
}

/// Parse + compile without installing into a Session.
pub fn compilePreview(allocator: std.mem.Allocator, config_text: []const u8) PreviewError!PreviewBundle {
    var spec = try poker_engine.game.parseStreetConfig(allocator, config_text);
    defer spec.deinit();

    const edit_lines = try ownTreeEditLines(allocator, spec.tree_edits);
    errdefer {
        for (edit_lines) |line| allocator.free(line);
        if (edit_lines.len != 0) allocator.free(edit_lines);
    }

    var game = try compile.compile(allocator, spec);
    errdefer game.deinit();

    const plan = buildMemoryPlan(game, spec.memory_mib, spec.threads);
    return .{
        .allocator = allocator,
        .game = game,
        .plan = plan,
        .tree_edit_lines = edit_lines,
    };
}

fn appendJsonString(list: *std.ArrayList(u8), value: []const u8) !void {
    try list.append('"');
    for (value) |c| {
        switch (c) {
            '"' => try list.appendSlice("\\\""),
            '\\' => try list.appendSlice("\\\\"),
            '\n' => try list.appendSlice("\\n"),
            '\r' => try list.appendSlice("\\r"),
            '\t' => try list.appendSlice("\\t"),
            else => {
                if (c < 0x20) {
                    const hexdigits = "0123456789abcdef";
                    const esc = [_]u8{ '\\', 'u', '0', '0', hexdigits[c >> 4], hexdigits[c & 0xf] };
                    try list.appendSlice(&esc);
                } else {
                    try list.append(c);
                }
            },
        }
    }
    try list.append('"');
}

pub fn formatMemoryPlanJson(list: *std.ArrayList(u8), plan: MemoryPlan) !void {
    const w = list.writer();
    try w.print(
        \\{{"estimated_peak_bytes":{d},"memory_budget_bytes":{d},"deals":{d},"infosets":{d},"decision_nodes":{d},"terminals":{d},"public_decisions":{d},"threads":{d},"fits_budget":{},"dry_run":{}}}
    ,
        .{
            plan.estimated_peak_bytes,
            plan.memory_budget_bytes,
            plan.deals,
            plan.infosets,
            plan.decision_nodes,
            plan.terminals,
            plan.public_decisions,
            plan.threads,
            plan.fits_budget,
            plan.dry_run,
        },
    );
}

fn formatPreviewNode(list: *std.ArrayList(u8), node: compile.Node, index: usize) !void {
    const w = list.writer();
    const terminal = node.kind == .terminal;
    const chance = node.kind == .chance;
    const chance_child: i64 = if (chance) @intCast(node.child[0]) else -1;
    try w.print(
        \\{{"index":{d},"terminal":{},"chance":{},"player":{d},"street":{d},"path":
    ,
        .{ index, terminal, chance, node.player, node.street },
    );
    try appendJsonString(list, node.path);
    try w.print(",\"chance_child\":{d},\"actions\":[", .{chance_child});

    if (node.kind == .decision) {
        var a: usize = 0;
        while (a < node.n_actions) : (a += 1) {
            if (a > 0) try w.writeAll(",");
            var compact_buf: [64]u8 = undefined;
            const compact = compactFromDisplay(node.action_labels[a], &compact_buf);
            try w.writeAll("{\"label\":");
            try appendJsonString(list, node.action_labels[a]);
            try w.writeAll(",\"compact\":");
            try appendJsonString(list, compact);
            try w.print(",\"child_index\":{d}}}", .{node.child[a]});
        }
    }

    try w.writeAll("],\"children\":[");
    if (node.kind == .decision) {
        var a: usize = 0;
        while (a < node.n_actions) : (a += 1) {
            if (a > 0) try w.writeAll(",");
            try w.print("{d}", .{node.child[a]});
        }
    } else if (node.kind == .chance) {
        try w.print("{d}", .{node.child[0]});
    }
    try w.writeAll("]}");
}

pub fn formatTreePreviewJson(allocator: std.mem.Allocator, bundle: *const PreviewBundle) ![]u8 {
    var list = std.ArrayList(u8).init(allocator);
    errdefer list.deinit();
    const w = list.writer();
    try w.writeAll("{\"nodes\":[");
    for (bundle.game.nodes, 0..) |node, i| {
        if (i > 0) try w.writeAll(",");
        try formatPreviewNode(&list, node, i);
    }
    try w.writeAll("],\"tree_edits\":[");
    for (bundle.tree_edit_lines, 0..) |line, i| {
        if (i > 0) try w.writeAll(",");
        try appendJsonString(&list, line);
    }
    try w.writeAll("],\"plan\":");
    try formatMemoryPlanJson(&list, bundle.plan);
    try w.writeAll("}");
    return try list.toOwnedSlice();
}

pub fn planMemoryJson(allocator: std.mem.Allocator, config_text: []const u8) PreviewError![]u8 {
    var bundle = try compilePreview(allocator, config_text);
    defer bundle.deinit();
    var list = std.ArrayList(u8).init(allocator);
    errdefer list.deinit();
    try formatMemoryPlanJson(&list, bundle.plan);
    return try list.toOwnedSlice();
}

pub fn treePreviewJson(allocator: std.mem.Allocator, config_text: []const u8) PreviewError![]u8 {
    var bundle = try compilePreview(allocator, config_text);
    defer bundle.deinit();
    return try formatTreePreviewJson(allocator, &bundle);
}

test "plan_preview flop-check-down dry-run plan" {
    const text = try std.fs.cwd().readFileAlloc(std.testing.allocator, "configs/templates/flop-check-down.txt", 64 * 1024);
    defer std.testing.allocator.free(text);

    var bundle = try compilePreview(std.testing.allocator, text);
    defer bundle.deinit();

    try std.testing.expect(bundle.plan.dry_run);
    try std.testing.expectEqual(@as(u64, 6), bundle.plan.decision_nodes);
    try std.testing.expectEqual(@as(u64, 6), bundle.plan.public_decisions);
    try std.testing.expect(bundle.plan.estimated_peak_bytes > 0);
    try std.testing.expect(bundle.plan.deals >= 1);
    try std.testing.expectEqual(bundle.game.infosetCount(), bundle.plan.infosets);
    try std.testing.expectEqual(@as(u64, 64 * 1024 * 1024), bundle.plan.memory_budget_bytes);
    try std.testing.expect(bundle.plan.fits_budget);
    try std.testing.expectEqual(@as(u32, 1), bundle.plan.threads);

    const root = bundle.game.nodes[0];
    try std.testing.expect(root.kind == .decision);
    try std.testing.expectEqualStrings("", root.path);
    try std.testing.expectEqualStrings("Check", root.action_labels[0]);

    var compact_buf: [16]u8 = undefined;
    try std.testing.expectEqualStrings("c", compactFromDisplay("Check", &compact_buf));
}

test "plan_preview over-budget still reports fits_budget false" {
    // memory_mib <= 0 → budget 0 → fits_budget false (preview still returns a plan).
    const text =
        \\street-config 1
        \\board Ah Kd 7c
        \\pot 100
        \\stack 100
        \\oop-range AcAd:1
        \\ip-range 2c3d:1
        \\first-to-act 0
        \\max-raises 0
        \\allow-all-in 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 0
        \\threads 1
        \\
    ;
    var bundle = try compilePreview(std.testing.allocator, text);
    defer bundle.deinit();
    try std.testing.expect(!bundle.plan.fits_budget);
    try std.testing.expectEqual(@as(u64, 0), bundle.plan.memory_budget_bytes);
    try std.testing.expect(bundle.plan.estimated_peak_bytes > 0);
    try std.testing.expect(bundle.plan.dry_run);
}

test "tree_preview JSON root Check compact and force edit echo" {
    const text =
        \\street-config 1
        \\board Ah Kd 7c
        \\pot 100
        \\stack 100
        \\oop-range AcAd:1
        \\ip-range 2c3d:1
        \\first-to-act 0
        \\max-raises 1
        \\allow-all-in 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 64
        \\threads 1
        \\oop-bets 0.33
        \\ip-bets 0.33
        \\oop-raises 1
        \\ip-raises 1
        \\tree-edit force - c
        \\
    ;
    const json = try treePreviewJson(std.testing.allocator, text);
    defer std.testing.allocator.free(json);

    try std.testing.expect(std.mem.indexOf(u8, json, "\"path\":\"\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"label\":\"Check\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"compact\":\"c\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"tree_edits\":[\"force - c\"]") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"dry_run\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"fits_budget\":") != null);
}
