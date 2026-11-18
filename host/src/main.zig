//! `solver-engine` sidecar (D11): typed IPC over inherited pipes (D1).
//! Logs → stderr. IPC frames on stdin/stdout. Outside the engine.
//! Solve runs on a background thread so Study `values` can overlap train (R10).
const std = @import("std");
const builtin = @import("builtin");
const poker_app = @import("poker_app");
const poker_engine = @import("poker_engine");
const poker_formats = @import("poker_formats");
const ipc = @import("ipc.zig");
const dispatch = @import("dispatch.zig");
const workers = @import("workers.zig");
const equity_json = @import("equity_json.zig");
const equity_jobs = @import("equity_jobs.zig");
const locks_json = @import("locks_json.zig");
const compare_json = @import("compare_json.zig");
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

/// Prefer the IPC stdin loop over MT train workers so status/Stop stay live when
/// flop CFR saturates the machine (Windows Study hung-kill false positives).
fn preferIpcThreadScheduling() void {
    if (builtin.os.tag != .windows) return;
    // Explicit imports: not all Zig versions export SetThreadPriority on kernel32.
    const WINAPI = std.os.windows.WINAPI;
    const HANDLE = std.os.windows.HANDLE;
    const BOOL = std.os.windows.BOOL;
    const GetCurrentThread = struct {
        extern "kernel32" fn GetCurrentThread() callconv(WINAPI) HANDLE;
    }.GetCurrentThread;
    const SetThreadPriority = struct {
        extern "kernel32" fn SetThreadPriority(hThread: HANDLE, nPriority: c_int) callconv(WINAPI) BOOL;
    }.SetThreadPriority;
    // Win32 THREAD_PRIORITY_ABOVE_NORMAL = 1 (not TIME_CRITICAL).
    _ = SetThreadPriority(GetCurrentThread(), 1);
}

/// Latch cooperative cancel for the live begin/train identity (if any) and always
/// request Session stop. Parent stdin EOF must not join remaining train first.
fn signalParentGoneCancel(state: *dispatch.HostState) void {
    var active_copy: ?[]u8 = null;
    defer if (active_copy) |jid| state.allocator.free(jid);
    {
        state.job_mu.lock();
        defer state.job_mu.unlock();
        if (state.active_job_id) |jid| {
            active_copy = state.allocator.dupe(u8, jid) catch null;
        }
    }
    if (active_copy) |jid| {
        // Best-effort: OOM on cancel map must not skip requestStop below.
        state.cancelJob(jid) catch {};
    }
    // Always latch stop — covers begin mid-compile and races that clear active id.
    state.session.requestStop();
}

/// Best-effort fail-once for outstanding request_ids (stdout may already be closed).
/// Snapshot under lock; do not hold pending_mu across writeReply (stdout_mu) or a
/// worker untrack can deadlock against this exit path.
fn failPendingOnParentExit(state: *dispatch.HostState) void {
    state.pending_mu.lock();
    const snapshot = state.allocator.dupe([]u8, state.pending.items) catch {
        state.pending_mu.unlock();
        return;
    };
    state.pending_mu.unlock();
    defer state.allocator.free(snapshot);

    for (snapshot) |rid| {
        var err_reply = ipc.makeErrorReply(state.allocator, rid, null, "exit", "sidecar_exit", "solver-engine exiting") catch continue;
        defer err_reply.deinit();
        // Intentional best-effort (Tiger Style Phase 2): stdout may already
        // be closed on process exit; do not escalate into a panic here.
        state.writeReply(err_reply) catch {};
    }
}

/// Parent stdin EOF / disappearance: cooperative stop, wake waiters, wind down
/// checkpoint I/O, then join every owned worker (audit §8 / Single prompt §7).
/// Prefer stop-then-join over hanging on remaining train after the parent is gone.
/// Uses only public HostState / Session entry points (no dispatch.zig edits).
pub fn shutdownOnParentEof(state: *dispatch.HostState) void {
    signalParentGoneCancel(state);

    // Supersede in-flight analysis/preview so the persistent pools exit without
    // finishing obsolete walks (per-metric gens + latest-draft preview).
    state.supersedeAllAnalysis();
    _ = state.bumpPreviewGen();

    // Equity calculator: cancel queued/current work and wake the worker CV.
    state.equity_jobs.shutdown();

    // Wake IPC waiters before joining long workers.
    failPendingOnParentExit(state);

    // Checkpoint I/O: join Save/Open so atomic replace can finish coherently
    // rather than racing process teardown mid-stream.
    state.joinIo();

    state.joinBegin();
    state.joinTrain();
    state.joinAnalysis();
    state.joinCompare();
    state.joinPreview();
}

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    const arg_list = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, arg_list);
    const launch_id = parseLaunchId(arg_list);

    preferIpcThreadScheduling();

    std.debug.print("solver-engine starting protocol={d} launch_id={s}\n", .{ ipc.protocol_version, launch_id });

    var state = try dispatch.HostState.init(allocator, launch_id);
    defer {
        // stdin EOF / loop break lands here: stop first, then join (audit §8).
        // shutdownOnParentEof supersedes analysis/preview pool gens before joins.
        shutdownOnParentEof(&state);
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
        // Compare off stdin so Status is not blocked behind dual inspect + pack.
        if (std.mem.eql(u8, req.op, "compare")) {
            dispatch.startCompare(&state, req) catch |err| {
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
        if (std.mem.eql(u8, req.op, "line_card_report")) {
            dispatch.startLineCardReport(&state, req) catch |err| {
                var fail = try ipc.makeErrorReply(allocator, req.request_id, req.job_id, req.op, "host_error", @errorName(err));
                defer fail.deinit();
                try state.writeReply(fail);
            };
            continue;
        }
        if (std.mem.eql(u8, req.op, "value_bluffs_post_call")) {
            dispatch.startValueBluffsPostCall(&state, req) catch |err| {
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
        if (std.mem.eql(u8, req.op, "tree_preview")) {
            dispatch.startTreePreview(&state, req) catch |err| {
                var fail = try ipc.makeErrorReply(allocator, req.request_id, req.job_id, req.op, "host_error", @errorName(err));
                defer fail.deinit();
                try state.writeReply(fail);
            };
            continue;
        }
        if (std.mem.eql(u8, req.op, "plan_memory")) {
            dispatch.startPlanMemory(&state, req) catch |err| {
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

/// Tiny check-only river used by parent-EOF shutdown tests (no stdout IPC).
const eof_test_river_config =
    \\street-config 1
    \\board Ah Kh Qh Jh 2c
    \\pot 100
    \\stack 100
    \\oop-range AsQs:1,2d2h:1
    \\ip-range AsQs:1,2d2h:1
    \\oop-river-bets 
    \\ip-river-bets 
    \\first-to-act 0
    \\max-raises 0
    \\allow-three-bet 1
    \\all-in-threshold 0
    \\pot-cap 0
    \\rake-rate 0
    \\rake-cap 0
    \\memory-mib 256
    \\threads 1
    \\
;

/// Background train that honors Session.requestStop (mirrors product trainWorker
/// without writing an admit frame to stdout — which deadlocks under zig test).
const EofTrainSim = struct {
    state: *dispatch.HostState,
    iterations: i32,
    saw_stop_before_exit: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),

    fn run(self: *@This()) void {
        defer {
            self.state.train_running.store(false, .release);
            self.state.bumpStatusGeneration();
            self.state.job_mu.lock();
            if (self.state.active_job_id) |jid| {
                self.state.allocator.free(jid);
                self.state.active_job_id = null;
            }
            self.state.job_mu.unlock();
        }
        self.state.session.trainGated(self.iterations, 0, 1, -1) catch {};
        if (self.state.session.stop_requested.load(.acquire)) {
            self.saw_stop_before_exit.store(true, .release);
        }
    }
};

fn spawnEofTrainSim(state: *dispatch.HostState, sim: *EofTrainSim) !void {
    state.session.clearControlFlags();
    try state.setActiveJob("eof-train");
    state.train_running.store(true, .release);
    state.train_thread = try std.Thread.spawn(.{}, EofTrainSim.run, .{sim});
}

fn waitUntilTrainRunning(state: *dispatch.HostState, timeout_ns: u64) !void {
    const start = std.time.nanoTimestamp();
    while (!state.train_running.load(.acquire)) {
        if (@as(u64, @intCast(std.time.nanoTimestamp() - start)) > timeout_ns) return error.Timeout;
        std.Thread.yield() catch {};
    }
    // Confirmed admission: active job is registered and worker is live.
    try std.testing.expect(state.matchesActiveJob("eof-train"));
}

test {
    _ = ipc;
    _ = dispatch;
    _ = workers;
    _ = equity_json;
    _ = locks_json;
    _ = compare_json;
    _ = strategy_edits_json;
    _ = linkedLayers;
}

test "parent EOF signals stop and cancels active job before join" {
    // Audit §8: stdin-EOF must requestStop / cancel before joining train.
    var state = try dispatch.HostState.init(std.testing.allocator, "eof-signal");
    defer state.deinit();
    try state.session.begin(eof_test_river_config);
    try state.session.train(1);

    var sim = EofTrainSim{ .state = &state, .iterations = 50_000 };
    try spawnEofTrainSim(&state, &sim);
    try waitUntilTrainRunning(&state, 2 * std.time.ns_per_s);

    // Capture per-metric analysis gens + preview gen so EOF supersession is visible.
    var analysis_gens_before: [state.analysis_kind_gen.len]u64 = undefined;
    for (&analysis_gens_before, &state.analysis_kind_gen) |*out, *gen| {
        out.* = gen.load(.acquire);
    }
    const preview_before = state.preview_gen.load(.acquire);

    const t0 = std.time.nanoTimestamp();
    shutdownOnParentEof(&state);
    const elapsed_ns: u64 = @intCast(std.time.nanoTimestamp() - t0);

    try std.testing.expect(state.session.stop_requested.load(.acquire));
    try std.testing.expect(state.isCancelled("eof-train") or !state.matchesActiveJob("eof-train"));
    try std.testing.expect(sim.saw_stop_before_exit.load(.acquire));
    try std.testing.expect(state.train_thread == null);
    try std.testing.expect(!state.train_running.load(.acquire));
    for (analysis_gens_before, &state.analysis_kind_gen) |before, *gen| {
        try std.testing.expect(gen.load(.acquire) > before);
    }
    try std.testing.expect(state.preview_gen.load(.acquire) > preview_before);
    // Cooperative stop must not wait out a 50k-iter train (product hang risk).
    try std.testing.expect(elapsed_ns < 5 * std.time.ns_per_s);
}

test "Stop-first then parent EOF join is prompt on Linux" {
    // Matched pair with EOF-after-admission: explicit Stop then EOF join should be
    // near-idle (audit: ~1 ms Stop-first vs hung join without cooperative stop).
    if (builtin.os.tag != .linux) return;
    var state = try dispatch.HostState.init(std.testing.allocator, "eof-stop-first");
    defer state.deinit();
    try state.session.begin(eof_test_river_config);
    try state.session.train(1);

    var sim = EofTrainSim{ .state = &state, .iterations = 50_000 };
    try spawnEofTrainSim(&state, &sim);
    try waitUntilTrainRunning(&state, 2 * std.time.ns_per_s);

    // Explicit Stop path (same latch cancel uses).
    try state.cancelJob("eof-train");
    state.session.requestStop();
    const stop_wait_start = std.time.nanoTimestamp();
    while (state.train_running.load(.acquire)) {
        if (@as(u64, @intCast(std.time.nanoTimestamp() - stop_wait_start)) > 5 * std.time.ns_per_s) {
            return error.Timeout;
        }
        std.Thread.yield() catch {};
    }

    const t0 = std.time.nanoTimestamp();
    shutdownOnParentEof(&state);
    const elapsed_ns: u64 = @intCast(std.time.nanoTimestamp() - t0);

    try std.testing.expect(state.train_thread == null);
    // Already-stopped workers: join should be prompt (generous bound for CI noise).
    try std.testing.expect(elapsed_ns < 1 * std.time.ns_per_s);
}

test "parent EOF after confirmed admission stops faster than full train" {
    // EOF-after-admission without a prior Stop still cooperatively cancels.
    if (builtin.os.tag != .linux) return;
    var state = try dispatch.HostState.init(std.testing.allocator, "eof-after-admit");
    defer state.deinit();
    try state.session.begin(eof_test_river_config);
    try state.session.train(1);

    var sim = EofTrainSim{ .state = &state, .iterations = 50_000 };
    try spawnEofTrainSim(&state, &sim);
    try waitUntilTrainRunning(&state, 2 * std.time.ns_per_s);
    // Let a few iterations start so this is post-admission, not pre-train.
    std.Thread.sleep(5 * std.time.ns_per_ms);

    const t0 = std.time.nanoTimestamp();
    shutdownOnParentEof(&state);
    const elapsed_ns: u64 = @intCast(std.time.nanoTimestamp() - t0);

    try std.testing.expect(sim.saw_stop_before_exit.load(.acquire));
    try std.testing.expect(state.train_thread == null);
    try std.testing.expect(elapsed_ns < 5 * std.time.ns_per_s);
    // Trained count must be far below the 50k target if stop was honored.
    state.session.mu.lock();
    const trained: i32 = if (state.session.training) |*tr| tr.trained else state.session.last_committed_trained;
    state.session.mu.unlock();
    try std.testing.expect(trained < 50_000);
}

test "parent EOF shuts down equity jobs and joins idle workers" {
    var state = try dispatch.HostState.init(std.testing.allocator, "eof-equity-io");
    defer state.deinit();

    // Build a minimal equity request; enqueue transfers ownership to the manager.
    var request = equity_jobs.JobRequest{
        .client_revision = try std.testing.allocator.dupe(u8, "eof"),
        .options = .{ .method = .exact, .seed = 1 },
    };
    var transferred = false;
    errdefer if (!transferred) request.deinit(std.testing.allocator);
    request.players = try std.testing.allocator.alloc(equity_jobs.PlayerSpec, 2);
    for (request.players) |*p| p.* = .{ .id = &.{}, .range_text = &.{} };
    request.players[0] = .{
        .id = try std.testing.allocator.dupe(u8, "p1"),
        .range_text = try std.testing.allocator.dupe(u8, "AsAd"),
    };
    request.players[1] = .{
        .id = try std.testing.allocator.dupe(u8, "p2"),
        .range_text = try std.testing.allocator.dupe(u8, "KcKd"),
    };
    request.board = try std.testing.allocator.alloc(poker_engine.poker.card.Card, 0);
    request.dead_cards = try std.testing.allocator.alloc(poker_engine.poker.card.Card, 0);

    _ = try state.equity_jobs.enqueue(request);
    transferred = true;
    try state.track("pending-eof");
    shutdownOnParentEof(&state);

    try std.testing.expect(state.io_thread == null);
    try std.testing.expect(state.begin_thread == null);
    try std.testing.expect(state.train_thread == null);
    // Persistent analysis/preview pools are joined and cleared on EOF.
    try std.testing.expect(state.analysis_worker == null);
    try std.testing.expect(state.preview_worker == null);
    try std.testing.expect(state.compare_thread == null);
    try std.testing.expectEqual(@as(u32, 0), state.analysis_live_workers.load(.acquire));
    try std.testing.expectEqual(@as(u32, 0), state.preview_live_workers.load(.acquire));
}
