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

/// Locate the start index of a top-level object value for `key` (after `:`).
/// Skips nested objects/arrays and string contents so body fields like
/// `"kind":"full"` cannot shadow envelope `"kind":"request"` when serde_json
/// (BTreeMap) emits alphabetical key order with `body` first (ZR-119).
fn findTopLevelValueStart(json: []const u8, key: []const u8) ?usize {
    var needle_buf: [64]u8 = undefined;
    const needle = std.fmt.bufPrint(&needle_buf, "\"{s}\"", .{key}) catch return null;

    var i: usize = 0;
    while (i < json.len and (json[i] == ' ' or json[i] == '\t' or json[i] == '\n' or json[i] == '\r')) : (i += 1) {}
    if (i >= json.len or json[i] != '{') return null;
    i += 1;

    var obj_depth: i32 = 1;
    var arr_depth: i32 = 0;
    var in_string = false;
    var escape = false;

    while (i < json.len) {
        const c = json[i];
        if (in_string) {
            if (escape) {
                escape = false;
                i += 1;
                continue;
            }
            if (c == '\\') {
                escape = true;
                i += 1;
                continue;
            }
            if (c == '"') in_string = false;
            i += 1;
            continue;
        }

        if (c == '"') {
            // Candidate key only at object depth 1 / array depth 0.
            if (obj_depth == 1 and arr_depth == 0 and std.mem.startsWith(u8, json[i..], needle)) {
                var j = i + needle.len;
                while (j < json.len and (json[j] == ' ' or json[j] == '\t')) : (j += 1) {}
                if (j < json.len and json[j] == ':') {
                    j += 1;
                    while (j < json.len and (json[j] == ' ' or json[j] == '\t')) : (j += 1) {}
                    if (j < json.len) return j;
                }
            }
            in_string = true;
            i += 1;
            continue;
        }

        switch (c) {
            '{' => obj_depth += 1,
            '}' => {
                obj_depth -= 1;
                if (obj_depth <= 0) return null;
            },
            '[' => arr_depth += 1,
            ']' => arr_depth -= 1,
            else => {},
        }
        i += 1;
    }
    return null;
}

fn readJsonString(json: []const u8, start: usize) ?[]const u8 {
    if (start >= json.len or json[start] != '"') return null;
    var i = start + 1;
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

fn readJsonContainer(json: []const u8, start: usize, open: u8, close: u8) ?[]const u8 {
    if (start >= json.len or json[start] != open) return null;
    var depth: i32 = 0;
    var in_string = false;
    var escape = false;
    var i = start;
    while (i < json.len) : (i += 1) {
        const c = json[i];
        if (in_string) {
            if (escape) {
                escape = false;
                continue;
            }
            if (c == '\\') {
                escape = true;
                continue;
            }
            if (c == '"') in_string = false;
            continue;
        }
        if (c == '"') {
            in_string = true;
            continue;
        }
        if (c == open) depth += 1;
        if (c == close) {
            depth -= 1;
            if (depth == 0) return json[start .. i + 1];
        }
    }
    return null;
}

fn findStringField(json: []const u8, key: []const u8) ?[]const u8 {
    const start = findTopLevelValueStart(json, key) orelse return null;
    return readJsonString(json, start);
}

fn findRawField(json: []const u8, key: []const u8) ?[]const u8 {
    const start = findTopLevelValueStart(json, key) orelse return null;
    if (start >= json.len) return null;
    if (json[start] == '"') {
        return readJsonString(json, start);
    }
    if (json[start] == '{') {
        return readJsonContainer(json, start, '{', '}');
    }
    if (json[start] == '[') {
        return readJsonContainer(json, start, '[', ']');
    }
    if (std.mem.startsWith(u8, json[start..], "null")) return "null";
    if (std.mem.startsWith(u8, json[start..], "true")) return "true";
    if (std.mem.startsWith(u8, json[start..], "false")) return "false";
    var i = start;
    while (i < json.len and json[i] != ',' and json[i] != '}' and json[i] != ']') : (i += 1) {}
    return std.mem.trim(u8, json[start..i], " \t\r\n");
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

test "decodePayload ignores nested body kind under alphabetical key order" {
    // serde_json without preserve_order emits BTreeMap alphabetical keys:
    // body before kind. Nested body "kind":"full" must not shadow envelope kind.
    const json =
        \\{"body":{"hand_indices":[],"kind":"full","node_id":"p0.t-1.r-1","probs":[0.0,1.0]},"job_id":null,"kind":"request","op":"put_strategy_edit","request_id":"r12","v":2}
    ;
    var decoded = try decodePayload(std.testing.allocator, json);
    defer decoded.deinit();
    try std.testing.expect(decoded.kind == .request);
    try std.testing.expectEqualStrings("put_strategy_edit", decoded.op);
    try std.testing.expectEqualStrings("r12", decoded.request_id);
    try std.testing.expect(std.mem.indexOf(u8, decoded.body_json, "\"kind\":\"full\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, decoded.body_json, "\"probs\":[0.0,1.0]") != null);
}

test "decodePayload put_lock alphabetical order with nested kind" {
    const json =
        \\{"body":{"hand_indices":[0],"kind":"full","node_id":"p0.t-1.r-1","probs":[1.0,0.0],"scope":"node"},"job_id":null,"kind":"request","op":"put_lock","request_id":"r3","v":2}
    ;
    var decoded = try decodePayload(std.testing.allocator, json);
    defer decoded.deinit();
    try std.testing.expect(decoded.kind == .request);
    try std.testing.expectEqualStrings("put_lock", decoded.op);
}
