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
const equity_jobs = @import("equity_jobs.zig");
const locks_json = @import("locks_json.zig");
const strategy_edits_json = @import("strategy_edits_json.zig");

pub const sidecar_name = "solver-engine";
pub const phase = "phase-6";

pub fn linkedLayers() []const []const u8 {
    _ = poker_app;
    _ = poker_engine;
    _ = poker_formats;
    _ = workers;
    _ = equity_jobs;
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
        // Fail pending on exit (D1). Supersede in-flight analysis so workers exit.
        _ = state.bumpAnalysisGen();
        state.joinBegin();
        state.joinTrain();
        state.joinAnalysis();
        state.joinIo();
        for (state.pending.items) |rid| {
            var err_reply = ipc.makeErrorReply(allocator, rid, null, "exit", "sidecar_exit", "solver-engine exiting") catch continue;
            defer err_reply.deinit();
            // Intentional best-effort (Tiger Style Phase 2): stdout may already
            // be closed on process exit; do not escalate into a panic here.
            state.writeReply(err_reply) catch {};
        }
        state.deinit();
        std.debug.print("solver-engine exiting\n", .{});
    }

    const stdin = std.io.getStdIn().reader();

    while (true) {
        // Read length + payload first so a decode-only InvalidFrame keeps the
        // stream aligned and the sidecar can reply instead of exiting (ZR-119).
        var len_buf: [4]u8 = undefined;
        stdin.readNoEof(&len_buf) catch break;
        const len = std.mem.readInt(u32, &len_buf, .little);
        if (len == 0 or len > 16 * 1024 * 1024) {
            std.debug.print("ipc read error: InvalidFrame\n", .{});
            break;
        }
        const payload = allocator.alloc(u8, len) catch break;
        defer allocator.free(payload);
        stdin.readNoEof(payload) catch break;

        var req = ipc.decodePayload(allocator, payload) catch |err| {
            std.debug.print("ipc decode error: {s}\n", .{@errorName(err)});
            // Recoverable: payload consumed; try to ACK with an error reply.
            const rid = blk: {
                // Best-effort top-level request_id for the waiter.
                if (std.mem.indexOf(u8, payload, "\"request_id\":\"")) |at| {
                    const from = at + "\"request_id\":\"".len;
                    if (std.mem.indexOfScalar(u8, payload[from..], '"')) |n| {
                        break :blk payload[from .. from + n];
                    }
                }
                break :blk "unknown";
            };
            var bad = ipc.makeErrorReply(allocator, rid, null, "invalid_frame", "invalid_frame", @errorName(err)) catch continue;
            defer bad.deinit();
            state.writeReply(bad) catch {};
            continue;
        };
        defer req.deinit();
        if (req.kind != .request) {
            var bad = try ipc.makeErrorReply(allocator, req.request_id, req.job_id, req.op, "invalid_frame", "expected request");
            defer bad.deinit();
            try state.writeReply(bad);
            continue;
        }

        // Async begin/train/analysis/IO: keep stdin free so status/Stop stay live
        // (R10 / ZR-120 / ZR-151). Sync `handle` remains for unit tests.
        if (std.mem.eql(u8, req.op, "begin_config")) {
            dispatch.startBeginConfig(&state, req) catch |err| {
                var fail = try ipc.makeErrorReply(allocator, req.request_id, req.job_id, req.op, "host_error", @errorName(err));
                defer fail.deinit();
                try state.writeReply(fail);
            };
            continue;
        }
        if (std.mem.eql(u8, req.op, "solve")) {
            dispatch.startSolve(&state, req) catch |err| {
                var fail = try ipc.makeErrorReply(allocator, req.request_id, req.job_id, req.op, "host_error", @errorName(err));
                defer fail.deinit();
                try state.writeReply(fail);
            };
            continue;
        }
        if (std.mem.eql(u8, req.op, "resolve_locked")) {
            dispatch.startResolveLocked(&state, req) catch |err| {
                var fail = try ipc.makeErrorReply(allocator, req.request_id, req.job_id, req.op, "host_error", @errorName(err));
                defer fail.deinit();
                try state.writeReply(fail);
            };
            continue;
        }
        // ZR-151: heavy Study ops off the critical IPC loop.
        if (std.mem.eql(u8, req.op, "values")) {
            dispatch.startValues(&state, req) catch |err| {
                var fail = try ipc.makeErrorReply(allocator, req.request_id, req.job_id, req.op, "host_error", @errorName(err));
                defer fail.deinit();
                try state.writeReply(fail);
            };
            continue;
        }
        if (std.mem.eql(u8, req.op, "equity")) {
            dispatch.startEquity(&state, req) catch |err| {
                var fail = try ipc.makeErrorReply(allocator, req.request_id, req.job_id, req.op, "host_error", @errorName(err));
                defer fail.deinit();
                try state.writeReply(fail);
            };
            continue;
        }
        if (std.mem.eql(u8, req.op, "node")) {
            dispatch.startNode(&state, req) catch |err| {
                var fail = try ipc.makeErrorReply(allocator, req.request_id, req.job_id, req.op, "host_error", @errorName(err));
                defer fail.deinit();
                try state.writeReply(fail);
            };
            continue;
        }
        // ZR-171: categories off stdin (same analysis worker as values/equity/node).
        if (std.mem.eql(u8, req.op, "categories")) {
            dispatch.startCategories(&state, req) catch |err| {
                var fail = try ipc.makeErrorReply(allocator, req.request_id, req.job_id, req.op, "host_error", @errorName(err));
                defer fail.deinit();
                try state.writeReply(fail);
            };
            continue;
        }
        if (std.mem.eql(u8, req.op, "save")) {
            dispatch.startSave(&state, req) catch |err| {
                var fail = try ipc.makeErrorReply(allocator, req.request_id, req.job_id, req.op, "host_error", @errorName(err));
                defer fail.deinit();
                try state.writeReply(fail);
            };
            continue;
        }
        if (std.mem.eql(u8, req.op, "open")) {
            dispatch.startOpen(&state, req) catch |err| {
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
    _ = strategy_edits_json;
    _ = linkedLayers;
}
