//! `solver-engine` sidecar (D11): typed IPC over inherited pipes (D1).
//! Logs → stderr. IPC frames on stdin/stdout. Outside the engine.
//! Solve runs on a background thread so Study `values` can overlap train (R10).
const std = @import("std");
const poker_app = @import("poker_app");
const poker_engine = @import("poker_engine");
const poker_formats = @import("poker_formats");
const ipc = @import("ipc.zig");
const dispatch = @import("dispatch.zig");
const workers = @import("workers.zig");
const equity_json = @import("equity_json.zig");
const locks_json = @import("locks_json.zig");

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
        state.joinTrain();
        for (state.pending.items) |rid| {
            var err_reply = ipc.makeErrorReply(allocator, rid, null, "exit", "sidecar_exit", "solver-engine exiting") catch continue;
            defer err_reply.deinit();
            state.writeReply(err_reply) catch {};
        }
        state.deinit();
        std.debug.print("solver-engine exiting\n", .{});
    }

    const stdin = std.io.getStdIn().reader();

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
            try state.writeReply(bad);
            continue;
        }

        // Async solve: keep stdin free so values can run under train (R10).
        if (std.mem.eql(u8, req.op, "solve")) {
            dispatch.startSolve(&state, req) catch |err| {
                var fail = try ipc.makeErrorReply(allocator, req.request_id, req.job_id, req.op, "host_error", @errorName(err));
                defer fail.deinit();
                try state.writeReply(fail);
            };
            continue;
        }

        var reply = dispatch.handle(&state, req) catch |err| blk: {
            break :blk try ipc.makeErrorReply(allocator, req.request_id, req.job_id, req.op, "host_error", @errorName(err));
        };
        defer reply.deinit();
        try state.writeReply(reply);
    }
}

test {
    _ = ipc;
    _ = dispatch;
    _ = workers;
    _ = equity_json;
    _ = locks_json;
    _ = linkedLayers;
}
