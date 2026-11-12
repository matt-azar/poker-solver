//! `solver-engine` sidecar (D11): typed IPC over inherited pipes (D1).
//! Logs → stderr. IPC frames on stdin/stdout. Outside the engine.
const std = @import("std");
const poker_app = @import("poker_app");
const poker_engine = @import("poker_engine");
const poker_formats = @import("poker_formats");
const ipc = @import("ipc.zig");
const dispatch = @import("dispatch.zig");
const workers = @import("workers.zig");

pub const sidecar_name = "solver-engine";
pub const phase = "phase-6";

pub fn linkedLayers() []const []const u8 {
    _ = poker_app;
    _ = poker_engine;
    _ = poker_formats;
    _ = workers;
    return &.{ "poker_engine", "poker_app", "poker_formats" };
}

fn parseLaunchId(args: []const []const u8) []const u8 {
    var i: usize = 0;
    while (i + 1 < args.len) : (i += 1) {
        if (std.mem.eql(u8, args[i], "--launch-id")) return args[i + 1];
    }
    return "local";
}

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    const arg_list = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, arg_list);
    const launch_id = parseLaunchId(arg_list);

    std.debug.print("solver-engine starting protocol={d} launch_id={s}\n", .{ ipc.protocol_version, launch_id });

    var state = try dispatch.HostState.init(allocator, launch_id);
    defer {
        // Fail pending on exit (D1).
        for (state.pending.items) |rid| {
            var err_reply = ipc.makeErrorReply(allocator, rid, null, "exit", "sidecar_exit", "solver-engine exiting") catch continue;
            defer err_reply.deinit();
            ipc.writeFrame(allocator, std.io.getStdOut().writer(), err_reply) catch {};
        }
        state.deinit();
        std.debug.print("solver-engine exiting\n", .{});
    }

    const stdin = std.io.getStdIn().reader();
    const stdout = std.io.getStdOut().writer();

    while (true) {
        var req = ipc.readFrame(allocator, stdin) catch |err| {
            if (err == error.BrokenPipe) break;
            std.debug.print("ipc read error: {s}\n", .{@errorName(err)});
            break;
        };
        defer req.deinit();
        if (req.kind != .request) {
            var bad = try ipc.makeErrorReply(allocator, req.request_id, req.job_id, req.op, "invalid_frame", "expected request");
            defer bad.deinit();
            try ipc.writeFrame(allocator, stdout, bad);
            continue;
        }
        var reply = dispatch.handle(&state, req) catch |err| blk: {
            break :blk try ipc.makeErrorReply(allocator, req.request_id, req.job_id, req.op, "host_error", @errorName(err));
        };
        defer reply.deinit();
        try ipc.writeFrame(allocator, stdout, reply);
    }
}

test {
    _ = ipc;
    _ = dispatch;
    _ = workers;
    _ = linkedLayers;
}
