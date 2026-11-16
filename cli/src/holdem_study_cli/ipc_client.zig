//! Minimal protocol-2 IPC client for an isolated solver-engine child.
const std = @import("std");

pub const ClientError = error{
    EngineMissing,
    SpawnFailed,
    BrokenPipe,
    Timeout,
    BadFrame,
    EngineError,
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

pub const SolverClient = struct {
    allocator: std.mem.Allocator,
    child: std.process.Child,
    request_seq: u32 = 0,

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

    pub fn deinit(self: *SolverClient) void {
        if (self.child.stdin) |*stdin| {
            stdin.close();
            self.child.stdin = null;
        }
        _ = self.child.kill() catch {};
        _ = self.child.wait() catch {};
    }

    fn nextRequestId(self: *SolverClient, buf: *[32]u8) []const u8 {
        self.request_seq += 1;
        return std.fmt.bufPrint(buf, "cli-{d}", .{self.request_seq}) catch "cli-x";
    }

    fn readExact(file: std.fs.File, buf: []u8) ClientError!void {
        var filled: usize = 0;
        while (filled < buf.len) {
            const n = file.read(buf[filled..]) catch return error.BrokenPipe;
            if (n == 0) return error.BrokenPipe;
            filled += n;
        }
    }

    /// Send a request and return the owned reply body JSON (caller frees).
    pub fn request(self: *SolverClient, op: []const u8, body_json: []const u8, job_id: ?[]const u8) ClientError![]u8 {
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

        var guard: usize = 0;
        while (guard < 10_000) : (guard += 1) {
            const frame = try self.readPayload();
            defer self.allocator.free(frame);

            const parsed = std.json.parseFromSlice(ReplyJson, self.allocator, frame, .{
                .ignore_unknown_fields = true,
            }) catch return error.BadFrame;
            defer parsed.deinit();
            const env = parsed.value;

            if (std.mem.eql(u8, env.kind, "progress")) continue;
            if (!std.mem.eql(u8, env.request_id, rid)) continue;
            if (!std.mem.eql(u8, env.kind, "reply")) return error.BadFrame;
            if (!env.ok) return error.EngineError;
            if (!std.mem.eql(u8, env.op, op)) return error.BadFrame;

            var body_out = std.ArrayList(u8).init(self.allocator);
            errdefer body_out.deinit();
            std.json.stringify(env.body, .{}, body_out.writer()) catch return error.OutOfMemory;
            return body_out.toOwnedSlice() catch return error.OutOfMemory;
        }
        return error.Timeout;
    }

    fn readPayload(self: *SolverClient) ClientError![]u8 {
        const stdout = self.child.stdout orelse return error.BrokenPipe;
        var len_buf: [4]u8 = undefined;
        try readExact(stdout, &len_buf);
        const len = std.mem.readInt(u32, &len_buf, .little);
        if (len == 0 or len > 64 * 1024 * 1024) return error.BadFrame;
        const payload = self.allocator.alloc(u8, len) catch return error.OutOfMemory;
        errdefer self.allocator.free(payload);
        try readExact(stdout, payload);
        return payload;
    }
};
