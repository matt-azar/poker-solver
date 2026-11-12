//! Phase 1 smoke CLI: parse a `street-config 1` document and print key fields.
//! Product street_solver / river alias arrives in later phases.
const std = @import("std");
const poker_engine = @import("poker_engine");

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    var args = try std.process.argsWithAllocator(allocator);
    defer args.deinit();
    _ = args.next();
    const path = args.next() orelse {
        std.debug.print("usage: street-config-check <street-config.txt>\n", .{});
        std.process.exit(2);
    };

    const text = try std.fs.cwd().readFileAlloc(allocator, path, 16 * 1024 * 1024);
    defer allocator.free(text);

    var config = try poker_engine.game.parseStreetConfig(allocator, text);
    defer config.deinit();

    const formatted = try poker_engine.game.formatStreetConfig(allocator, config);
    defer allocator.free(formatted);

    const stdout = std.io.getStdOut().writer();
    try stdout.print("ok board_len={d} pot_tenths={d} stack_tenths={d} bytes={d}\n", .{
        config.board.len,
        config.pot,
        config.stack,
        formatted.len,
    });
}
