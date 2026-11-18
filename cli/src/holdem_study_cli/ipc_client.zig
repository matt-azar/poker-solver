//! Minimal protocol-2 IPC client for an isolated solver-engine child.
//!
//! Framing: exact-read loops already; writeAll honors short writes.
//! Waits use elapsed-time deadlines (poll/peek) so a silent pipe times out
//! instead of spinning on a frame-count guard (audit §8 / IPC-7).
//! Host `ok:false` replies preserve `error_code` / `error_message` on the
//! client — they are not collapsed into a bare EngineError.
const std = @import("std");
const builtin = @import("builtin");

pub const ClientError = error{
    EngineMissing,
    SpawnFailed,
    BrokenPipe,
    Timeout,
    BadFrame,
    /// Unexpected client-side failure (malformed local state, etc.).
    EngineError,
    /// Host returned ok:false — inspect lastErrorCode / lastErrorMessage.
    HostRejected,
    OutOfMemory,
};

const ReplyJson = struct {
    v: u32,
    kind: []const u8,
    request_id: []const u8,
    op: []const u8 = "",
    ok: bool = true,
    body: std.json.Value = .null,
    error_code: ?[]const u8 = null,
    error_message: ?[]const u8 = null,
};

pub const DEFAULT_REQUEST_TIMEOUT_NS: u64 = 120 * std.time.ns_per_s;

pub const SolverClient = struct {
    allocator: std.mem.Allocator,
    child: std.process.Child,
    request_seq: u32 = 0,
    last_error_code: ?[]u8 = null,
    last_error_message: ?[]u8 = null,

    pub fn spawn(allocator: std.mem.Allocator, engine_path: []const u8, launch_id: []const u8) ClientError!SolverClient {
        std.fs.cwd().access(engine_path, .{}) catch return error.EngineMissing;
        var child = std.process.Child.init(&.{ engine_path, "--launch-id", launch_id }, allocator);
        child.stdin_behavior = .Pipe;
        child.stdout_behavior = .Pipe;
        child.stderr_behavior = .Pipe;
        child.spawn() catch return error.SpawnFailed;
        if (child.stderr) |stderr| {
            const thread = std.Thread.spawn(.{}, drainStderr, .{stderr}) catch {
                _ = child.kill() catch {};
                _ = child.wait() catch {};
                return error.SpawnFailed;
            };
            thread.detach();
        }
        return .{
            .allocator = allocator,
            .child = child,
        };
    }

    fn drainStderr(stderr: std.fs.File) void {
        var buf: [512]u8 = undefined;
        while (true) {
            const n = stderr.read(&buf) catch break;
            if (n == 0) break;
        }
    }

    /// Kill and reap the child. Safe to call more than once. Call this before
    /// any `std.process.exit` — Zig exit skips `defer`.
    pub fn deinit(self: *SolverClient) void {
        self.clearLastHostError();
        if (self.child.stdin) |*stdin| {
            stdin.close();
            self.child.stdin = null;
        }
        _ = self.child.kill() catch {};
        _ = self.child.wait() catch {};
    }

    pub fn lastErrorCode(self: *const SolverClient) ?[]const u8 {
        return self.last_error_code;
    }

    pub fn lastErrorMessage(self: *const SolverClient) ?[]const u8 {
        return self.last_error_message;
    }

    fn clearLastHostError(self: *SolverClient) void {
        if (self.last_error_code) |c| {
            self.allocator.free(c);
            self.last_error_code = null;
        }
        if (self.last_error_message) |m| {
            self.allocator.free(m);
            self.last_error_message = null;
        }
    }

    fn setLastHostError(self: *SolverClient, code: ?[]const u8, message: ?[]const u8) ClientError!void {
        self.clearLastHostError();
        if (code) |c| {
            self.last_error_code = self.allocator.dupe(u8, c) catch return error.OutOfMemory;
        }
        if (message) |m| {
            self.last_error_message = self.allocator.dupe(u8, m) catch {
                self.clearLastHostError();
                return error.OutOfMemory;
            };
        }
    }

    fn nextRequestId(self: *SolverClient, buf: *[32]u8) []const u8 {
        self.request_seq += 1;
        return std.fmt.bufPrint(buf, "cli-{d}", .{self.request_seq}) catch "cli-x";
    }

    fn waitReadable(file: std.fs.File, timeout_ms: i32) ClientError!void {
        if (builtin.os.tag == .windows) {
            // Anonymous pipe: poll is unreliable; peek until data or deadline.
            const deadline = std.time.milliTimestamp() + @as(i64, timeout_ms);
            while (true) {
                var avail: std.os.windows.DWORD = 0;
                const ok = std.os.windows.kernel32.PeekNamedPipe(
                    file.handle,
                    null,
                    0,
                    null,
                    &avail,
                    null,
                );
                if (ok == 0) return error.BrokenPipe;
                if (avail > 0) return;
                if (std.time.milliTimestamp() >= deadline) return error.Timeout;
                std.Thread.sleep(5 * std.time.ns_per_ms);
            }
        } else {
            var fds = [_]std.posix.pollfd{.{
                .fd = file.handle,
                .events = std.posix.POLL.IN,
                .revents = 0,
            }};
            const ready = std.posix.poll(&fds, timeout_ms) catch return error.BrokenPipe;
            if (ready == 0) return error.Timeout;
            const re = fds[0].revents;
            if ((re & (std.posix.POLL.ERR | std.posix.POLL.NVAL)) != 0) return error.BrokenPipe;
            if ((re & std.posix.POLL.IN) == 0 and (re & std.posix.POLL.HUP) != 0) {
                return error.BrokenPipe;
            }
        }
    }

    /// Read exactly `buf.len` bytes before `deadline_ns`, looping short reads.
    pub fn readExactDeadline(file: std.fs.File, buf: []u8, deadline_ns: i128) ClientError!void {
        var filled: usize = 0;
        while (filled < buf.len) {
            const now = std.time.nanoTimestamp();
            if (now >= deadline_ns) return error.Timeout;
            const remain_ns = deadline_ns - now;
            const remain_ms_i128 = @divFloor(remain_ns, std.time.ns_per_ms);
            const remain_ms: i32 = if (remain_ms_i128 <= 0)
                1
            else if (remain_ms_i128 > std.math.maxInt(i32))
                std.math.maxInt(i32)
            else
                @intCast(remain_ms_i128);
            try waitReadable(file, remain_ms);
            const n = file.read(buf[filled..]) catch return error.BrokenPipe;
            if (n == 0) return error.BrokenPipe;
            filled += n;
        }
    }

    fn readExact(file: std.fs.File, buf: []u8) ClientError!void {
        // Unlimited wait — prefer readExactDeadline for production waits.
        const far = std.time.nanoTimestamp() + @as(i128, 365) * std.time.ns_per_day;
        return readExactDeadline(file, buf, far);
    }

    /// Send a request and return the owned reply body JSON (caller frees).
    pub fn request(
        self: *SolverClient,
        op: []const u8,
        body_json: []const u8,
        job_id: ?[]const u8,
    ) ClientError![]u8 {
        return self.requestTimeout(op, body_json, job_id, DEFAULT_REQUEST_TIMEOUT_NS);
    }

    pub fn requestTimeout(
        self: *SolverClient,
        op: []const u8,
        body_json: []const u8,
        job_id: ?[]const u8,
        timeout_ns: u64,
    ) ClientError![]u8 {
        self.clearLastHostError();
        var rid_buf: [32]u8 = undefined;
        const rid = self.nextRequestId(&rid_buf);

        var payload = std.ArrayList(u8).init(self.allocator);
        defer payload.deinit();
        const w = payload.writer();
        w.print("{{\"v\":2,\"kind\":\"request\",\"request_id\":{s},\"job_id\":", .{std.json.fmt(rid, .{})}) catch return error.OutOfMemory;
        if (job_id) |jid| {
            std.json.stringify(jid, .{}, w) catch return error.OutOfMemory;
        } else {
            w.writeAll("null") catch return error.OutOfMemory;
        }
        w.print(",\"op\":{s},\"body\":", .{std.json.fmt(op, .{})}) catch return error.OutOfMemory;
        w.writeAll(body_json) catch return error.OutOfMemory;
        w.writeAll("}") catch return error.OutOfMemory;

        const stdin = self.child.stdin orelse return error.BrokenPipe;
        var len_buf: [4]u8 = undefined;
        std.mem.writeInt(u32, &len_buf, @intCast(payload.items.len), .little);
        stdin.writeAll(&len_buf) catch return error.BrokenPipe;
        stdin.writeAll(payload.items) catch return error.BrokenPipe;

        const deadline_ns: i128 = std.time.nanoTimestamp() + @as(i128, @intCast(timeout_ns));
        while (true) {
            if (std.time.nanoTimestamp() >= deadline_ns) return error.Timeout;
            const frame = try self.readPayloadDeadline(deadline_ns);
            defer self.allocator.free(frame);

            const parsed = std.json.parseFromSlice(ReplyJson, self.allocator, frame, .{
                .ignore_unknown_fields = true,
            }) catch return error.BadFrame;
            defer parsed.deinit();
            const env = parsed.value;

            if (std.mem.eql(u8, env.kind, "progress")) continue;
            if (!std.mem.eql(u8, env.request_id, rid)) continue; // discard late / other
            if (!std.mem.eql(u8, env.kind, "reply")) return error.BadFrame;
            if (!env.ok) {
                try self.setLastHostError(env.error_code, env.error_message);
                return error.HostRejected;
            }
            if (!std.mem.eql(u8, env.op, op)) return error.BadFrame;

            var body_out = std.ArrayList(u8).init(self.allocator);
            errdefer body_out.deinit();
            std.json.stringify(env.body, .{}, body_out.writer()) catch return error.OutOfMemory;
            return body_out.toOwnedSlice() catch return error.OutOfMemory;
        }
    }

    fn readPayloadDeadline(self: *SolverClient, deadline_ns: i128) ClientError![]u8 {
        const stdout = self.child.stdout orelse return error.BrokenPipe;
        var len_buf: [4]u8 = undefined;
        try readExactDeadline(stdout, &len_buf, deadline_ns);
        const len = std.mem.readInt(u32, &len_buf, .little);
        if (len == 0 or len > 64 * 1024 * 1024) return error.BadFrame;
        const payload = self.allocator.alloc(u8, len) catch return error.OutOfMemory;
        errdefer self.allocator.free(payload);
        try readExactDeadline(stdout, payload, deadline_ns);
        return payload;
    }

    fn readPayload(self: *SolverClient) ClientError![]u8 {
        const far = std.time.nanoTimestamp() + @as(i128, 365) * std.time.ns_per_day;
        return self.readPayloadDeadline(far);
    }
};

// --- unit tests (no solver-engine required) ---------------------------------

test "readExactDeadline assembles partial reads" {
    const pair = try std.posix.pipe();
    defer std.posix.close(pair[0]);
    defer std.posix.close(pair[1]);

    const reader = std.fs.File{ .handle = pair[0] };
    const writer = std.fs.File{ .handle = pair[1] };

    const payload = "abcdefghij";
    // Write one byte at a time from a helper thread.
    const ThreadCtx = struct {
        file: std.fs.File,
        data: []const u8,
        fn run(self: *@This()) void {
            for (self.data) |b| {
                _ = self.file.write(&[_]u8{b}) catch return;
                std.Thread.sleep(2 * std.time.ns_per_ms);
            }
        }
    };
    var ctx = ThreadCtx{ .file = writer, .data = payload };
    const th = try std.Thread.spawn(.{}, ThreadCtx.run, .{&ctx});
    defer th.join();

    var buf: [10]u8 = undefined;
    const deadline = std.time.nanoTimestamp() + 5 * std.time.ns_per_s;
    try SolverClient.readExactDeadline(reader, &buf, deadline);
    try std.testing.expectEqualStrings(payload, &buf);
}

test "readExactDeadline times out on silent pipe" {
    const pair = try std.posix.pipe();
    defer std.posix.close(pair[0]);
    defer std.posix.close(pair[1]);

    const reader = std.fs.File{ .handle = pair[0] };
    var buf: [4]u8 = undefined;
    const deadline = std.time.nanoTimestamp() + 80 * std.time.ns_per_ms;
    const result = SolverClient.readExactDeadline(reader, &buf, deadline);
    try std.testing.expectError(error.Timeout, result);
}

test "HostRejected preserves error_code from framed reply" {
    const allocator = std.testing.allocator;
    const pair_out = try std.posix.pipe(); // child stdout → client
    errdefer std.posix.close(pair_out[0]);
    defer std.posix.close(pair_out[1]);
    const pair_in = try std.posix.pipe(); // client → child stdin
    defer std.posix.close(pair_in[0]);
    // pair_in[1] owned by client.stdin; closed explicitly below (no double-close).

    // Minimal fake Child with pipe ends (no real process).
    var client: SolverClient = .{
        .allocator = allocator,
        .child = undefined,
    };
    client.child.stdin = std.fs.File{ .handle = pair_in[1] };
    client.child.stdout = std.fs.File{ .handle = pair_out[0] };

    const reply_body =
        \\{"v":2,"kind":"reply","request_id":"cli-1","op":"status","ok":false,"error_code":"busy","error_message":"train already running","body":null}
    ;
    var len_buf: [4]u8 = undefined;
    std.mem.writeInt(u32, &len_buf, @intCast(reply_body.len), .little);

    const WriterCtx = struct {
        file: std.fs.File,
        hdr: []const u8,
        body: []const u8,
        fn run(self: *@This()) void {
            // Delay so the client is waiting, then deliver in tiny chunks.
            std.Thread.sleep(20 * std.time.ns_per_ms);
            _ = self.file.write(self.hdr[0..2]) catch return;
            std.Thread.sleep(5 * std.time.ns_per_ms);
            _ = self.file.write(self.hdr[2..]) catch return;
            var i: usize = 0;
            while (i < self.body.len) : (i += 1) {
                _ = self.file.write(self.body[i .. i + 1]) catch return;
            }
        }
    };
    var wctx = WriterCtx{ .file = std.fs.File{ .handle = pair_out[1] }, .hdr = &len_buf, .body = reply_body };
    const th = try std.Thread.spawn(.{}, WriterCtx.run, .{&wctx});

    // Drain stdin writes from request so the writer side of pair_in does not block.
    const DrainCtx = struct {
        file: std.fs.File,
        fn run(self: *@This()) void {
            var buf: [4096]u8 = undefined;
            while (true) {
                const n = self.file.read(&buf) catch break;
                if (n == 0) break;
            }
        }
    };
    var dctx = DrainCtx{ .file = std.fs.File{ .handle = pair_in[0] } };
    const dth = try std.Thread.spawn(.{}, DrainCtx.run, .{&dctx});

    const result = client.requestTimeout("status", "null", null, 2 * std.time.ns_per_s);

    // Snapshot host error before teardown frees the strings.
    const code_snap = try allocator.dupe(u8, client.lastErrorCode() orelse "");
    defer allocator.free(code_snap);
    const msg_snap = try allocator.dupe(u8, client.lastErrorMessage() orelse "");
    defer allocator.free(msg_snap);

    // Close client stdin before joining the drain thread (EOF unblocks it).
    if (client.child.stdin) |*s| {
        s.close();
        client.child.stdin = null;
    }
    dth.join();
    th.join();
    client.clearLastHostError();
    // Client owned stdout (pair_out[0]); close once here.
    if (client.child.stdout) |*s| {
        s.close();
        client.child.stdout = null;
    }

    try std.testing.expectError(error.HostRejected, result);
    try std.testing.expectEqualStrings("busy", code_snap);
    try std.testing.expectEqualStrings("train already running", msg_snap);
}
