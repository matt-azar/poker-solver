//! Study-shaped equity JSON for the host IPC `equity` op (D1: IPC outside engine).
//! Packs `analysis.equity.checkdownEquity` into the explorer Study `/equity` body shape.
const std = @import("std");
const poker_engine = @import("poker_engine");

const equity = poker_engine.analysis.equity;

pub const PackError = error{ OutOfMemory, InvalidEquity, InvalidWeight, WorkLimit };

fn appendF64(list: *std.ArrayList(u8), value: f64) PackError!void {
    var buf: [64]u8 = undefined;
    const rendered = std.fmt.bufPrint(&buf, "{d}", .{value}) catch return error.OutOfMemory;
    list.appendSlice(rendered) catch return error.OutOfMemory;
}

fn appendBuckets(
    list: *std.ArrayList(u8),
    buckets: *const [equity.equity_distribution_buckets]equity.EquityDistributionBucket,
) PackError!void {
    list.append('[') catch return error.OutOfMemory;
    for (buckets.*, 0..) |bucket, i| {
        if (i != 0) list.append(',') catch return error.OutOfMemory;
        list.appendSlice("{\"lo\":") catch return error.OutOfMemory;
        try appendF64(list, bucket.lo);
        list.appendSlice(",\"hi\":") catch return error.OutOfMemory;
        try appendF64(list, bucket.hi);
        list.appendSlice(",\"weight\":") catch return error.OutOfMemory;
        try appendF64(list, bucket.weight);
        list.append('}') catch return error.OutOfMemory;
    }
    list.append(']') catch return error.OutOfMemory;
}

fn appendHandRows(list: *std.ArrayList(u8), player: equity.PlayerEquity) PackError!void {
    list.append('[') catch return error.OutOfMemory;
    var first = true;
    for (player.combos) |row| {
        if (!row.defined or !(row.input_weight > 0) or !std.math.isFinite(row.input_weight) or !std.math.isFinite(row.equity)) {
            continue;
        }
        var eq = row.equity;
        if (eq < 0.0) eq = 0.0 else if (eq > 1.0) eq = 1.0;
        if (!first) list.append(',') catch return error.OutOfMemory;
        first = false;
        list.appendSlice("{\"combo\":\"") catch return error.OutOfMemory;
        list.appendSlice(row.combo) catch return error.OutOfMemory;
        list.appendSlice("\",\"equity\":") catch return error.OutOfMemory;
        try appendF64(list, eq);
        list.appendSlice(",\"weight\":") catch return error.OutOfMemory;
        try appendF64(list, row.input_weight);
        list.append('}') catch return error.OutOfMemory;
    }
    list.append(']') catch return error.OutOfMemory;
}

pub const PackArgs = struct {
    solution_id: u64,
    node_id: []const u8,
    node_index: u32,
    policy_revision: u64,
    status_generation: u64,
    query_seconds: f64,
    elapsed_ms: i64,
    live_under_train: bool,
    page: *const equity.ShowdownEquity,
};

/// Build Study `/equity`-compatible body JSON (caller frees).
pub fn packStudyEquityBody(allocator: std.mem.Allocator, args: PackArgs) PackError![]u8 {
    const defined = args.page.joint_defined and args.page.player0.defined and args.page.player1.defined;
    var oop_dist = if (defined)
        try equity.equityDistributionFromPlayer(args.page.player0)
    else
        equity.emptyEquityDistribution();
    var ip_dist = if (defined)
        try equity.equityDistributionFromPlayer(args.page.player1)
    else
        equity.emptyEquityDistribution();

    var list = std.ArrayList(u8).init(allocator);
    errdefer list.deinit();
    const w = list.writer();

    w.writeAll("{\"pending\":false,\"kind\":\"equity\",\"solution_id\":\"s") catch return error.OutOfMemory;
    w.print("{d}", .{args.solution_id}) catch return error.OutOfMemory;
    w.writeAll("\",\"node_id\":") catch return error.OutOfMemory;
    w.print("\"{s}\"", .{args.node_id}) catch return error.OutOfMemory;
    w.writeAll(",\"node_index\":") catch return error.OutOfMemory;
    w.print("{d}", .{args.node_index}) catch return error.OutOfMemory;
    w.writeAll(",\"policy_revision\":") catch return error.OutOfMemory;
    w.print("{d}", .{args.policy_revision}) catch return error.OutOfMemory;
    w.writeAll(",\"analysis_revision\":") catch return error.OutOfMemory;
    w.print("{d}", .{args.policy_revision}) catch return error.OutOfMemory;
    w.writeAll(",\"status_generation\":") catch return error.OutOfMemory;
    w.print("{d}", .{args.status_generation}) catch return error.OutOfMemory;
    w.writeAll(",\"units\":\"fraction of the pot\",\"model\":\"check-down\",\"defined\":") catch return error.OutOfMemory;
    w.writeAll(if (defined) "true" else "false") catch return error.OutOfMemory;
    w.writeAll(",\"oop_equity\":") catch return error.OutOfMemory;
    if (defined) {
        try appendF64(&list, args.page.player0.equity);
    } else {
        w.writeAll("null") catch return error.OutOfMemory;
    }
    w.writeAll(",\"ip_equity\":") catch return error.OutOfMemory;
    if (defined) {
        try appendF64(&list, args.page.player1.equity);
    } else {
        w.writeAll("null") catch return error.OutOfMemory;
    }
    w.writeAll(",\"equity_distribution\":") catch return error.OutOfMemory;
    try appendBuckets(&list, &oop_dist);
    w.writeAll(",\"ip_equity_distribution\":") catch return error.OutOfMemory;
    try appendBuckets(&list, &ip_dist);
    w.writeAll(",\"oop_hands\":") catch return error.OutOfMemory;
    try appendHandRows(&list, args.page.player0);
    w.writeAll(",\"ip_hands\":") catch return error.OutOfMemory;
    try appendHandRows(&list, args.page.player1);
    w.writeAll(",\"query_seconds\":") catch return error.OutOfMemory;
    try appendF64(&list, args.query_seconds);
    w.writeAll(",\"elapsed_ms\":") catch return error.OutOfMemory;
    w.print("{d}", .{args.elapsed_ms}) catch return error.OutOfMemory;
    w.writeAll(",\"engine\":\"checkdown_equity\",\"live_under_train\":") catch return error.OutOfMemory;
    w.writeAll(if (args.live_under_train) "true" else "false") catch return error.OutOfMemory;
    w.writeAll(",\"pair_runouts\":") catch return error.OutOfMemory;
    w.print("{d}", .{args.page.pair_runouts}) catch return error.OutOfMemory;
    w.writeAll("}") catch return error.OutOfMemory;

    return list.toOwnedSlice();
}

test "packStudyEquityBody river two-combo shape" {
    const compile = @import("poker_engine").game.compile;
    const street_config = @import("poker_engine").game.street_config;
    const text =
        \\street-config 1
        \\board Ah Kh Qh Jh 2c
        \\pot 100
        \\stack 100
        \\oop-range AsQs:1,2d2h:1
        \\ip-range AsQs:1,2d2h:1
        \\oop-river-bets 1
        \\ip-river-bets 1
        \\first-to-act 0
        \\max-raises 0
        \\allow-all-in 1
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 256
        \\threads 1
        \\
    ;
    var cfg = try street_config.parseStreetConfig(std.testing.allocator, text);
    defer cfg.deinit();
    var game = try compile.compile(std.testing.allocator, cfg);
    defer game.deinit();
    var page = try equity.checkdownEquity(std.testing.allocator, game, equity.study_explorer_max_pair_runouts);
    defer page.deinit();
    const body = try packStudyEquityBody(std.testing.allocator, .{
        .solution_id = 1,
        .node_id = "p0",
        .node_index = 0,
        .policy_revision = 1,
        .status_generation = 2,
        .query_seconds = 0.001,
        .elapsed_ms = 1,
        .live_under_train = false,
        .page = &page,
    });
    defer std.testing.allocator.free(body);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"kind\":\"equity\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"model\":\"check-down\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"units\":\"fraction of the pot\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"defined\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"oop_hands\":[") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"ip_hands\":[") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"equity_distribution\":[") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"engine\":\"checkdown_equity\"") != null);
    try std.testing.expect(page.joint_defined);
    try std.testing.expectApproxEqAbs(@as(f64, 1.0), page.player0.equity + page.player1.equity, 1e-9);
}
