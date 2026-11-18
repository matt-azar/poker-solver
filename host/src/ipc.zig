//! Framed typed IPC for `solver-engine` (D1). Outside the engine.
//! Encoding: little-endian u32 length + UTF-8 JSON object (protocol version 2).
const std = @import("std");

pub const protocol_version: u32 = 2;

/// Protocol-2 hard payload ceiling (JSON body after the u32 length prefix).
/// Desktop Rust framing and Zig `readFrame` already reject above 16 MiB; the
/// outgoing encoder uses the same limit so oversized replies never enter stdout.
/// CLI / river-beta historically allowed 64 MiB — protocol 2 documents **16 MiB**
/// as the shared hard ceiling (admission byte budgets remain separate).
pub const max_payload_bytes: u32 = 16 * 1024 * 1024;

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
    PayloadTooLarge,
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

/// Escape a JSON string value (quotes included). Shared by envelope encode and
/// other host JSON packers so control bytes cannot break Study parsers (ZR-180).
pub fn appendJsonString(list: *std.ArrayList(u8), value: []const u8) error{OutOfMemory}!void {
    try list.append('"');
    for (value) |c| {
        switch (c) {
            '"' => try list.appendSlice("\\\""),
            '\\' => try list.appendSlice("\\\\"),
            '\n' => try list.appendSlice("\\n"),
            '\r' => try list.appendSlice("\\r"),
            '\t' => try list.appendSlice("\\t"),
            else => {
                if (c < 0x20) {
                    const hexdigits = "0123456789abcdef";
                    const esc = [_]u8{ '\\', 'u', '0', '0', hexdigits[c >> 4], hexdigits[c & 0xf] };
                    try list.appendSlice(&esc);
                } else {
                    try list.append(c);
                }
            },
        }
    }
    try list.append('"');
}

fn writeJsonString(list: *std.ArrayList(u8), value: []const u8) IpcError!void {
    appendJsonString(list, value) catch return error.OutOfMemory;
}

/// Unescape a JSON string body (contents between quotes).
/// Uses `std.json` so surrogate pairs (e.g. `\uD83C\uDCA1` → 🂡) and raw UTF-8
/// both round-trip for checkpoint paths (IPC audit §6 / prompt §5).
pub fn unescapeJsonString(allocator: std.mem.Allocator, escaped: []const u8) error{ OutOfMemory, InvalidJsonString }![]u8 {
    var quoted = try allocator.alloc(u8, escaped.len + 2);
    defer allocator.free(quoted);
    quoted[0] = '"';
    @memcpy(quoted[1 .. escaped.len + 1], escaped);
    quoted[escaped.len + 1] = '"';

    const parsed = std.json.parseFromSlice([]const u8, allocator, quoted, .{}) catch return error.InvalidJsonString;
    defer parsed.deinit();
    return allocator.dupe(u8, parsed.value) catch return error.OutOfMemory;
}

fn dupeUnescaped(allocator: std.mem.Allocator, escaped: []const u8) IpcError![]u8 {
    if (std.mem.indexOfScalar(u8, escaped, '\\') == null) {
        return allocator.dupe(u8, escaped) catch return error.OutOfMemory;
    }
    return unescapeJsonString(allocator, escaped) catch |err| switch (err) {
        error.OutOfMemory => error.OutOfMemory,
        error.InvalidJsonString => error.InvalidFrame,
    };
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
    if (payload.len > max_payload_bytes) return error.PayloadTooLarge;
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

    const kind_raw = findStringField(json, "kind") orelse return error.InvalidFrame;
    const kind_text = try dupeUnescaped(allocator, kind_raw);
    defer allocator.free(kind_text);
    env.kind = try parseKind(kind_text);

    const rid = findStringField(json, "request_id") orelse return error.InvalidFrame;
    env.request_id = try dupeUnescaped(allocator, rid);

    if (findRawField(json, "job_id")) |jid| {
        // findRawField returns inner string content (no quotes) or the literal "null".
        if (!std.mem.eql(u8, jid, "null")) {
            env.job_id = try dupeUnescaped(allocator, jid);
        }
    }

    const op = findStringField(json, "op") orelse "";
    env.op = try dupeUnescaped(allocator, op);

    if (findRawField(json, "ok")) |ok_text| {
        env.ok = std.mem.eql(u8, ok_text, "true");
    }

    if (findStringField(json, "error_code")) |code| {
        env.error_code = try dupeUnescaped(allocator, code);
    }
    if (findStringField(json, "error_message")) |msg| {
        env.error_message = try dupeUnescaped(allocator, msg);
    }

    if (findRawField(json, "body")) |body| {
        // Body is raw JSON (object/array/literal) — do not string-unescape.
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
    if (len == 0 or len > max_payload_bytes) return error.InvalidFrame;
    const payload = allocator.alloc(u8, len) catch return error.OutOfMemory;
    defer allocator.free(payload);
    reader.readNoEof(payload) catch return error.BrokenPipe;
    return decodePayload(allocator, payload);
}

/// Write one framed envelope. If the encoded payload exceeds `max_payload_bytes`,
/// refuse that response and write a small structured `payload_too_large` error
/// instead (same request_id / job_id / op) so stdout never receives the giant frame.
pub fn writeFrame(allocator: std.mem.Allocator, writer: anytype, env: Envelope) IpcError!void {
    const frame = encodeFrame(allocator, env) catch |err| {
        if (err != error.PayloadTooLarge) return err;
        var refuse = try makeErrorReply(
            allocator,
            env.request_id,
            env.job_id,
            if (env.op.len != 0) env.op else "unknown",
            "payload_too_large",
            "response exceeds protocol-2 max payload (16 MiB)",
        );
        defer refuse.deinit();
        const small = try encodeFrame(allocator, refuse);
        defer allocator.free(small);
        writer.writeAll(small) catch return error.BrokenPipe;
        return;
    };
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
    // Stage dupes so a mid-chain OOM cannot leak earlier fields (ZR-180).
    var env = Envelope{ .allocator = allocator, .kind = .reply, .ok = true };
    errdefer env.deinit();
    env.request_id = allocator.dupe(u8, request_id) catch return error.OutOfMemory;
    if (job_id) |j| {
        env.job_id = allocator.dupe(u8, j) catch return error.OutOfMemory;
    }
    env.op = allocator.dupe(u8, op) catch return error.OutOfMemory;
    env.body_json = allocator.dupe(u8, body_json) catch return error.OutOfMemory;
    return env;
}

pub fn makeErrorReply(
    allocator: std.mem.Allocator,
    request_id: []const u8,
    job_id: ?[]const u8,
    op: []const u8,
    code: []const u8,
    message: []const u8,
) IpcError!Envelope {
    var env = Envelope{ .allocator = allocator, .kind = .reply, .ok = false };
    errdefer env.deinit();
    env.request_id = allocator.dupe(u8, request_id) catch return error.OutOfMemory;
    if (job_id) |j| {
        env.job_id = allocator.dupe(u8, j) catch return error.OutOfMemory;
    }
    env.op = allocator.dupe(u8, op) catch return error.OutOfMemory;
    env.body_json = allocator.dupe(u8, "null") catch return error.OutOfMemory;
    env.error_code = allocator.dupe(u8, code) catch return error.OutOfMemory;
    env.error_message = allocator.dupe(u8, message) catch return error.OutOfMemory;
    return env;
}

pub fn makeProgress(
    allocator: std.mem.Allocator,
    request_id: []const u8,
    job_id: []const u8,
    body_json: []const u8,
) IpcError!Envelope {
    var env = Envelope{ .allocator = allocator, .kind = .progress, .ok = true };
    errdefer env.deinit();
    env.request_id = allocator.dupe(u8, request_id) catch return error.OutOfMemory;
    env.job_id = allocator.dupe(u8, job_id) catch return error.OutOfMemory;
    env.op = allocator.dupe(u8, "progress") catch return error.OutOfMemory;
    env.body_json = allocator.dupe(u8, body_json) catch return error.OutOfMemory;
    return env;
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

test "decodePayload unescapes request_id and writeJsonString escapes controls" {
    const json =
        \\{"v":2,"kind":"request","request_id":"r\"1\n","job_id":null,"op":"ready","body":null}
    ;
    var decoded = try decodePayload(std.testing.allocator, json);
    defer decoded.deinit();
    try std.testing.expectEqualStrings("r\"1\n", decoded.request_id);

    var list = std.ArrayList(u8).init(std.testing.allocator);
    defer list.deinit();
    try appendJsonString(&list, "a\"b\n\x01");
    try std.testing.expectEqualStrings("\"a\\\"b\\n\\u0001\"", list.items);
}

/// Playing-card Ace of Spades (U+1F0A1). Fixture encodings used by Unicode path tests.
const ace_of_spades_utf8 = "\xf0\x9f\x82\xa1";
const turn_checkpoint_utf8 = "Turn-" ++ ace_of_spades_utf8 ++ ".psol";
/// JSON `\u` surrogate-pair encoding of the same filename (no surrounding quotes).
const turn_checkpoint_surrogate_escaped = "Turn-\\uD83C\\uDCA1.psol";

test "unescapeJsonString round-trips raw UTF-8 and surrogate-pair encodings" {
    const from_raw = try unescapeJsonString(std.testing.allocator, turn_checkpoint_utf8);
    defer std.testing.allocator.free(from_raw);
    try std.testing.expectEqualStrings(turn_checkpoint_utf8, from_raw);

    const from_esc = try unescapeJsonString(std.testing.allocator, turn_checkpoint_surrogate_escaped);
    defer std.testing.allocator.free(from_esc);
    try std.testing.expectEqualStrings(turn_checkpoint_utf8, from_esc);
    try std.testing.expectEqualStrings(from_raw, from_esc);
}

test "decodePayload unescapes Unicode surrogate-pair request_id" {
    // Envelope string field with surrogate-pair escape must not truncate after "Turn-".
    const json =
        \\{"v":2,"kind":"request","request_id":"Turn-\uD83C\uDCA1.psol","job_id":null,"op":"save","body":null}
    ;
    var decoded = try decodePayload(std.testing.allocator, json);
    defer decoded.deinit();
    try std.testing.expectEqualStrings(turn_checkpoint_utf8, decoded.request_id);
}

test "encodeFrame refuses payloads above protocol-2 ceiling" {
    const over = max_payload_bytes + 1;
    const body = try std.testing.allocator.alloc(u8, over);
    defer std.testing.allocator.free(body);
    @memset(body, 'x');

    var env = Envelope{
        .allocator = std.testing.allocator,
        .kind = .reply,
        .request_id = try std.testing.allocator.dupe(u8, "r-big"),
        .op = try std.testing.allocator.dupe(u8, "values"),
        .body_json = body,
        .ok = true,
    };
    // body_json is borrowed for this test; clear before deinit so we free `body` ourselves.
    defer {
        env.body_json = &.{};
        env.deinit();
    }

    const result = encodeFrame(std.testing.allocator, env);
    try std.testing.expectError(error.PayloadTooLarge, result);
}

test "writeFrame substitutes small payload_too_large error for oversized reply" {
    const over = max_payload_bytes + 1;
    const body = try std.testing.allocator.alloc(u8, over);
    defer std.testing.allocator.free(body);
    @memset(body, 'y');

    var env = Envelope{
        .allocator = std.testing.allocator,
        .kind = .reply,
        .request_id = try std.testing.allocator.dupe(u8, "r-over"),
        .job_id = try std.testing.allocator.dupe(u8, "j1"),
        .op = try std.testing.allocator.dupe(u8, "node"),
        .body_json = body,
        .ok = true,
    };
    defer {
        env.body_json = &.{};
        env.deinit();
    }

    var out = std.ArrayList(u8).init(std.testing.allocator);
    defer out.deinit();
    try writeFrame(std.testing.allocator, out.writer(), env);

    try std.testing.expect(out.items.len >= 4);
    const len = std.mem.readInt(u32, out.items[0..4], .little);
    try std.testing.expect(len < max_payload_bytes);
    try std.testing.expectEqual(out.items.len - 4, len);

    var decoded = try decodePayload(std.testing.allocator, out.items[4..]);
    defer decoded.deinit();
    try std.testing.expect(!decoded.ok);
    try std.testing.expectEqualStrings("r-over", decoded.request_id);
    try std.testing.expectEqualStrings("j1", decoded.job_id.?);
    try std.testing.expectEqualStrings("node", decoded.op);
    try std.testing.expectEqualStrings("payload_too_large", decoded.error_code.?);
    try std.testing.expect(std.mem.indexOf(u8, decoded.error_message.?, "16 MiB") != null);
}
