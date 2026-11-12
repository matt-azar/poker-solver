//! Framed typed IPC for `solver-engine` (D1). Outside the engine.
//! Encoding: little-endian u32 length + UTF-8 JSON object (protocol version 2).
const std = @import("std");

pub const protocol_version: u32 = 2;

pub const FrameKind = enum {
    request,
    reply,
    progress,
};

pub const IpcError = error{
    InvalidFrame,
    UnsupportedProtocol,
    OutOfMemory,
    BrokenPipe,
};

pub const Envelope = struct {
    allocator: std.mem.Allocator,
    v: u32 = protocol_version,
    kind: FrameKind = .request,
    request_id: []u8 = &.{},
    job_id: ?[]u8 = null,
    op: []u8 = &.{},
    /// Raw JSON value for body (owned).
    body_json: []u8 = &.{},
    ok: bool = true,
    error_code: ?[]u8 = null,
    error_message: ?[]u8 = null,

    pub fn deinit(self: *Envelope) void {
        if (self.request_id.len != 0) self.allocator.free(self.request_id);
        if (self.job_id) |j| self.allocator.free(j);
        if (self.op.len != 0) self.allocator.free(self.op);
        if (self.body_json.len != 0) self.allocator.free(self.body_json);
        if (self.error_code) |c| self.allocator.free(c);
        if (self.error_message) |m| self.allocator.free(m);
        self.* = .{ .allocator = self.allocator };
    }
};

fn kindName(kind: FrameKind) []const u8 {
    return switch (kind) {
        .request => "request",
        .reply => "reply",
        .progress => "progress",
    };
}

fn parseKind(name: []const u8) IpcError!FrameKind {
    if (std.mem.eql(u8, name, "request")) return .request;
    if (std.mem.eql(u8, name, "reply")) return .reply;
    if (std.mem.eql(u8, name, "progress")) return .progress;
    return error.InvalidFrame;
}

fn writeJsonString(list: *std.ArrayList(u8), value: []const u8) IpcError!void {
    list.append('"') catch return error.OutOfMemory;
    for (value) |c| {
        switch (c) {
            '"' => list.appendSlice("\\\"") catch return error.OutOfMemory,
            '\\' => list.appendSlice("\\\\") catch return error.OutOfMemory,
            '\n' => list.appendSlice("\\n") catch return error.OutOfMemory,
            '\r' => list.appendSlice("\\r") catch return error.OutOfMemory,
            '\t' => list.appendSlice("\\t") catch return error.OutOfMemory,
            else => list.append(c) catch return error.OutOfMemory,
        }
    }
    list.append('"') catch return error.OutOfMemory;
}

/// Encode one envelope to a length-prefixed frame.
pub fn encodeFrame(allocator: std.mem.Allocator, env: Envelope) IpcError![]u8 {
    var list = std.ArrayList(u8).init(allocator);
    errdefer list.deinit();
    const w = list.writer();
    w.writeAll("{\"v\":") catch return error.OutOfMemory;
    w.print("{d}", .{env.v}) catch return error.OutOfMemory;
    w.writeAll(",\"kind\":\"") catch return error.OutOfMemory;
    w.writeAll(kindName(env.kind)) catch return error.OutOfMemory;
    w.writeAll("\",\"request_id\":") catch return error.OutOfMemory;
    try writeJsonString(&list, env.request_id);
    w.writeAll(",\"job_id\":") catch return error.OutOfMemory;
    if (env.job_id) |jid| {
        try writeJsonString(&list, jid);
    } else {
        w.writeAll("null") catch return error.OutOfMemory;
    }
    w.writeAll(",\"op\":") catch return error.OutOfMemory;
    try writeJsonString(&list, env.op);
    w.writeAll(",\"ok\":") catch return error.OutOfMemory;
    w.writeAll(if (env.ok) "true" else "false") catch return error.OutOfMemory;
    if (env.error_code) |code| {
        w.writeAll(",\"error_code\":") catch return error.OutOfMemory;
        try writeJsonString(&list, code);
    }
    if (env.error_message) |msg| {
        w.writeAll(",\"error_message\":") catch return error.OutOfMemory;
        try writeJsonString(&list, msg);
    }
    w.writeAll(",\"body\":") catch return error.OutOfMemory;
    w.writeAll(if (env.body_json.len != 0) env.body_json else "null") catch return error.OutOfMemory;
    w.writeAll("}") catch return error.OutOfMemory;

    const payload = try list.toOwnedSlice();
    defer allocator.free(payload);
    var frame = allocator.alloc(u8, 4 + payload.len) catch return error.OutOfMemory;
    std.mem.writeInt(u32, frame[0..4], @intCast(payload.len), .little);
    @memcpy(frame[4..], payload);
    return frame;
}

fn findStringField(json: []const u8, key: []const u8) ?[]const u8 {
    var needle_buf: [64]u8 = undefined;
    const needle = std.fmt.bufPrint(&needle_buf, "\"{s}\":", .{key}) catch return null;
    const start = std.mem.indexOf(u8, json, needle) orelse return null;
    var i = start + needle.len;
    while (i < json.len and (json[i] == ' ' or json[i] == '\t')) : (i += 1) {}
    if (i >= json.len or json[i] != '"') return null;
    i += 1;
    const from = i;
    while (i < json.len) : (i += 1) {
        if (json[i] == '\\') {
            i += 1;
            continue;
        }
        if (json[i] == '"') return json[from..i];
    }
    return null;
}

fn findRawField(json: []const u8, key: []const u8) ?[]const u8 {
    var needle_buf: [64]u8 = undefined;
    const needle = std.fmt.bufPrint(&needle_buf, "\"{s}\":", .{key}) catch return null;
    const start = std.mem.indexOf(u8, json, needle) orelse return null;
    var i = start + needle.len;
    while (i < json.len and (json[i] == ' ' or json[i] == '\t')) : (i += 1) {}
    if (i >= json.len) return null;
    if (json[i] == '"') {
        const from = i + 1;
        var j = from;
        while (j < json.len) : (j += 1) {
            if (json[j] == '\\') {
                j += 1;
                continue;
            }
            if (json[j] == '"') return json[from..j];
        }
        return null;
    }
    if (json[i] == '{') {
        var depth: i32 = 0;
        const from = i;
        while (i < json.len) : (i += 1) {
            if (json[i] == '{') depth += 1;
            if (json[i] == '}') {
                depth -= 1;
                if (depth == 0) return json[from .. i + 1];
            }
        }
        return null;
    }
    if (std.mem.startsWith(u8, json[i..], "null")) return "null";
    if (std.mem.startsWith(u8, json[i..], "true")) return "true";
    if (std.mem.startsWith(u8, json[i..], "false")) return "false";
    const from = i;
    while (i < json.len and json[i] != ',' and json[i] != '}') : (i += 1) {}
    return std.mem.trim(u8, json[from..i], " \t\r\n");
}

/// Decode payload JSON (without length prefix) into an owned envelope.
pub fn decodePayload(allocator: std.mem.Allocator, json: []const u8) IpcError!Envelope {
    var env = Envelope{ .allocator = allocator };
    errdefer env.deinit();

    const v_text = findRawField(json, "v") orelse return error.InvalidFrame;
    env.v = std.fmt.parseInt(u32, v_text, 10) catch return error.InvalidFrame;
    if (env.v != protocol_version) return error.UnsupportedProtocol;

    const kind_text = findStringField(json, "kind") orelse return error.InvalidFrame;
    env.kind = try parseKind(kind_text);

    const rid = findStringField(json, "request_id") orelse return error.InvalidFrame;
    env.request_id = allocator.dupe(u8, rid) catch return error.OutOfMemory;

    if (findRawField(json, "job_id")) |jid| {
        if (!std.mem.eql(u8, jid, "null")) {
            env.job_id = allocator.dupe(u8, jid) catch return error.OutOfMemory;
        }
    }

    const op = findStringField(json, "op") orelse "";
    env.op = allocator.dupe(u8, op) catch return error.OutOfMemory;

    if (findRawField(json, "ok")) |ok_text| {
        env.ok = std.mem.eql(u8, ok_text, "true");
    }

    if (findStringField(json, "error_code")) |code| {
        env.error_code = allocator.dupe(u8, code) catch return error.OutOfMemory;
    }
    if (findStringField(json, "error_message")) |msg| {
        env.error_message = allocator.dupe(u8, msg) catch return error.OutOfMemory;
    }

    if (findRawField(json, "body")) |body| {
        env.body_json = allocator.dupe(u8, body) catch return error.OutOfMemory;
    } else {
        env.body_json = allocator.dupe(u8, "null") catch return error.OutOfMemory;
    }
    return env;
}

pub fn readFrame(allocator: std.mem.Allocator, reader: anytype) IpcError!Envelope {
    var len_buf: [4]u8 = undefined;
    reader.readNoEof(&len_buf) catch return error.BrokenPipe;
    const len = std.mem.readInt(u32, &len_buf, .little);
    if (len == 0 or len > 16 * 1024 * 1024) return error.InvalidFrame;
    const payload = allocator.alloc(u8, len) catch return error.OutOfMemory;
    defer allocator.free(payload);
    reader.readNoEof(payload) catch return error.BrokenPipe;
    return decodePayload(allocator, payload);
}

pub fn writeFrame(allocator: std.mem.Allocator, writer: anytype, env: Envelope) IpcError!void {
    const frame = try encodeFrame(allocator, env);
    defer allocator.free(frame);
    writer.writeAll(frame) catch return error.BrokenPipe;
}

pub fn makeReply(
    allocator: std.mem.Allocator,
    request_id: []const u8,
    job_id: ?[]const u8,
    op: []const u8,
    body_json: []const u8,
) IpcError!Envelope {
    return .{
        .allocator = allocator,
        .kind = .reply,
        .request_id = allocator.dupe(u8, request_id) catch return error.OutOfMemory,
        .job_id = if (job_id) |j| allocator.dupe(u8, j) catch return error.OutOfMemory else null,
        .op = allocator.dupe(u8, op) catch return error.OutOfMemory,
        .body_json = allocator.dupe(u8, body_json) catch return error.OutOfMemory,
        .ok = true,
    };
}

pub fn makeErrorReply(
    allocator: std.mem.Allocator,
    request_id: []const u8,
    job_id: ?[]const u8,
    op: []const u8,
    code: []const u8,
    message: []const u8,
) IpcError!Envelope {
    return .{
        .allocator = allocator,
        .kind = .reply,
        .request_id = allocator.dupe(u8, request_id) catch return error.OutOfMemory,
        .job_id = if (job_id) |j| allocator.dupe(u8, j) catch return error.OutOfMemory else null,
        .op = allocator.dupe(u8, op) catch return error.OutOfMemory,
        .body_json = allocator.dupe(u8, "null") catch return error.OutOfMemory,
        .ok = false,
        .error_code = allocator.dupe(u8, code) catch return error.OutOfMemory,
        .error_message = allocator.dupe(u8, message) catch return error.OutOfMemory,
    };
}

pub fn makeProgress(
    allocator: std.mem.Allocator,
    request_id: []const u8,
    job_id: []const u8,
    body_json: []const u8,
) IpcError!Envelope {
    return .{
        .allocator = allocator,
        .kind = .progress,
        .request_id = allocator.dupe(u8, request_id) catch return error.OutOfMemory,
        .job_id = allocator.dupe(u8, job_id) catch return error.OutOfMemory,
        .op = allocator.dupe(u8, "progress") catch return error.OutOfMemory,
        .body_json = allocator.dupe(u8, body_json) catch return error.OutOfMemory,
        .ok = true,
    };
}

test "frame roundtrip ready" {
    var env = try makeReply(std.testing.allocator, "r1", null, "ready", "{\"protocol\":2,\"sidecar\":\"solver-engine\"}");
    defer env.deinit();
    const frame = try encodeFrame(std.testing.allocator, env);
    defer std.testing.allocator.free(frame);
    const len = std.mem.readInt(u32, frame[0..4], .little);
    try std.testing.expectEqual(frame.len - 4, len);
    var decoded = try decodePayload(std.testing.allocator, frame[4..]);
    defer decoded.deinit();
    try std.testing.expect(decoded.kind == .reply);
    try std.testing.expectEqualStrings("r1", decoded.request_id);
    try std.testing.expectEqualStrings("ready", decoded.op);
    try std.testing.expect(decoded.ok);
}
