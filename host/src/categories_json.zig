//! Study-shaped categories JSON for the host IPC `categories` op.
const std = @import("std");
const poker_engine = @import("poker_engine");

const hand_categories = poker_engine.poker.hand_categories;
const hand_eval = poker_engine.poker.hand_eval;
const card = poker_engine.poker.card;

pub const PackError = error{OutOfMemory};

fn appendF64(list: *std.ArrayList(u8), value: f64) PackError!void {
    var buf: [64]u8 = undefined;
    const rendered = std.fmt.bufPrint(&buf, "{d}", .{value}) catch return error.OutOfMemory;
    list.appendSlice(rendered) catch return error.OutOfMemory;
}

fn appendJsonString(list: *std.ArrayList(u8), value: []const u8) PackError!void {
    list.append('"') catch return error.OutOfMemory;
    for (value) |c| {
        switch (c) {
            '"' => list.appendSlice("\\\"") catch return error.OutOfMemory,
            '\\' => list.appendSlice("\\\\") catch return error.OutOfMemory,
            '\n' => list.appendSlice("\\n") catch return error.OutOfMemory,
            '\r' => list.appendSlice("\\r") catch return error.OutOfMemory,
            '\t' => list.appendSlice("\\t") catch return error.OutOfMemory,
            else => {
                if (c < 0x20) {
                    const hexdigits = "0123456789abcdef";
                    const esc = [_]u8{ '\\', 'u', '0', '0', hexdigits[c >> 4], hexdigits[c & 0xf] };
                    list.appendSlice(&esc) catch return error.OutOfMemory;
                } else {
                    list.append(c) catch return error.OutOfMemory;
                }
            },
        }
    }
    list.append('"') catch return error.OutOfMemory;
}

fn appendPlayer(list: *std.ArrayList(u8), player: hand_categories.PlayerCategoryMass) PackError!void {
    list.appendSlice("{\"defined\":") catch return error.OutOfMemory;
    list.appendSlice(if (player.defined) "true" else "false") catch return error.OutOfMemory;
    list.appendSlice(",\"total_mass\":") catch return error.OutOfMemory;
    if (player.defined) {
        try appendF64(list, player.total_mass);
    } else {
        list.appendSlice("null") catch return error.OutOfMemory;
    }
    list.appendSlice(",\"fractions\":[") catch return error.OutOfMemory;
    var slot: usize = 0;
    while (slot < hand_categories.hand_category_count) : (slot += 1) {
        if (slot != 0) list.append(',') catch return error.OutOfMemory;
        if (player.defined) {
            try appendF64(list, player.fraction[slot]);
        } else {
            list.appendSlice("null") catch return error.OutOfMemory;
        }
    }
    list.appendSlice("],\"mass\":[") catch return error.OutOfMemory;
    slot = 0;
    while (slot < hand_categories.hand_category_count) : (slot += 1) {
        if (slot != 0) list.append(',') catch return error.OutOfMemory;
        if (player.defined) {
            try appendF64(list, player.mass[slot]);
        } else {
            list.appendSlice("null") catch return error.OutOfMemory;
        }
    }
    list.appendSlice("]}") catch return error.OutOfMemory;
}

pub const PackArgs = struct {
    solution_id: u64,
    node_id: []const u8,
    policy_revision: u64,
    query_seconds: f64,
    report: *const hand_categories.CategoryComposition,
};

/// Build Study `/categories`-compatible body JSON (caller frees).
pub fn packStudyCategoriesBody(allocator: std.mem.Allocator, args: PackArgs) PackError![]u8 {
    var list = std.ArrayList(u8).init(allocator);
    errdefer list.deinit();

    try list.appendSlice("{\"pending\":false,\"kind\":\"categories\",\"solution_id\":");
    var id_buf: [32]u8 = undefined;
    const id_text = std.fmt.bufPrint(&id_buf, "{d}", .{args.solution_id}) catch return error.OutOfMemory;
    try list.appendSlice(id_text);
    try list.appendSlice(",\"node_id\":");
    try appendJsonString(&list, args.node_id);
    try list.appendSlice(",\"policy_revision\":");
    const rev_text = std.fmt.bufPrint(&id_buf, "{d}", .{args.policy_revision}) catch return error.OutOfMemory;
    try list.appendSlice(rev_text);
    try list.appendSlice(",\"model\":");
    try appendJsonString(&list, args.report.model);
    try list.appendSlice(",\"available\":");
    try list.appendSlice(if (args.report.available) "true" else "false");
    try list.appendSlice(",\"exclusive\":");
    try list.appendSlice(if (args.report.exclusive) "true" else "false");
    try list.appendSlice(",\"reason\":");
    if (args.report.reason.len == 0) {
        try list.appendSlice("null");
    } else {
        try appendJsonString(&list, args.report.reason);
    }
    try list.appendSlice(",\"board\":[");
    for (args.report.board(), 0..) |c, i| {
        if (i != 0) try list.append(',');
        var card_buf: [2]u8 = undefined;
        const text = card.formatCard(c, &card_buf) catch "??";
        try appendJsonString(&list, text);
    }
    try list.appendSlice("],\"categories\":[");
    const category_order = [_]hand_eval.HandCategory{
        .high_card,
        .pair,
        .two_pair,
        .three_of_a_kind,
        .straight,
        .flush,
        .full_house,
        .four_of_a_kind,
        .straight_flush,
    };
    for (category_order, 0..) |cat, slot| {
        if (slot != 0) try list.append(',');
        try appendJsonString(&list, hand_categories.categoryName(cat));
    }
    try list.appendSlice("],\"oop\":");
    try appendPlayer(&list, args.report.player0);
    try list.appendSlice(",\"ip\":");
    try appendPlayer(&list, args.report.player1);
    try list.appendSlice(",\"query_seconds\":");
    try appendF64(&list, args.query_seconds);
    try list.append('}');

    return list.toOwnedSlice();
}
