const std = @import("std");
const chips = @import("../poker/chips.zig");

pub const TreeEditError = error{InvalidTreeEdit};

pub const LineEditKind = enum { force, remove, add_size };

pub const LineStep = struct {
    label: []const u8,
};

pub const LinePath = struct {
    steps: []LineStep = &.{},
};

pub const LineEdit = struct {
    kind: LineEditKind = .force,
    path: LinePath = .{},
    action: []const u8 = "",
    size_pot_fraction: f64 = -1.0,
    size_chips: chips.Chip = 0,

    pub fn usesChipSize(self: LineEdit) bool {
        return self.kind == .add_size and self.size_chips > 0;
    }
};

pub fn validActionLabel(label: []const u8) bool {
    if (label.len == 0) return false;
    for (label) |c| {
        if (c <= ' ' or c == '#' or c == '\'' or c == '"') return false;
    }
    return true;
}

pub fn validateLineEdit(edit: LineEdit) bool {
    for (edit.path.steps) |step| {
        if (!validActionLabel(step.label)) return false;
    }
    if (edit.kind == .add_size) {
        if (edit.action.len != 0) return false;
        if (edit.size_chips > 0) return edit.size_pot_fraction < 0.0;
        return edit.size_pot_fraction >= 0.0 and edit.size_chips == 0;
    }
    if (!validActionLabel(edit.action)) return false;
    if (edit.size_pot_fraction >= 0.0 or edit.size_chips != 0) return false;
    return true;
}

fn kindToken(kind: LineEditKind) []const u8 {
    return switch (kind) {
        .force => "force",
        .remove => "remove",
        .add_size => "add-size",
    };
}

fn parseKind(token: []const u8) ?LineEditKind {
    if (std.mem.eql(u8, token, "force")) return .force;
    if (std.mem.eql(u8, token, "remove")) return .remove;
    if (std.mem.eql(u8, token, "add-size")) return .add_size;
    return null;
}

/// Parse one tree-edit line (no trailing newline required). Labels are duped into `allocator`.
pub fn parseOneEdit(allocator: std.mem.Allocator, line: []const u8) TreeEditError!LineEdit {
    const first_space = std.mem.indexOfScalar(u8, line, ' ') orelse return error.InvalidTreeEdit;
    const kind = parseKind(line[0..first_space]) orelse return error.InvalidTreeEdit;
    const rest = line[first_space + 1 ..];
    const second_space = std.mem.indexOfScalar(u8, rest, ' ') orelse return error.InvalidTreeEdit;
    const path_token = rest[0..second_space];
    const tail = rest[second_space + 1 ..];
    if (tail.len == 0 or std.mem.indexOfScalar(u8, tail, ' ') != null) return error.InvalidTreeEdit;

    var edit = LineEdit{ .kind = kind };
    if (!std.mem.eql(u8, path_token, "-")) {
        var steps = std.ArrayList(LineStep).init(allocator);
        errdefer {
            for (steps.items) |s| allocator.free(s.label);
            steps.deinit();
        }
        var path_cursor: usize = 0;
        while (path_cursor < path_token.len) {
            const slash = std.mem.indexOfScalarPos(u8, path_token, path_cursor, '/') orelse path_token.len;
            const step = path_token[path_cursor..slash];
            if (!validActionLabel(step)) return error.InvalidTreeEdit;
            const owned = allocator.dupe(u8, step) catch return error.InvalidTreeEdit;
            steps.append(.{ .label = owned }) catch {
                allocator.free(owned);
                return error.InvalidTreeEdit;
            };
            path_cursor = if (slash < path_token.len) slash + 1 else slash;
        }
        edit.path.steps = steps.toOwnedSlice() catch return error.InvalidTreeEdit;
    }

    if (kind == .add_size) {
        if (tail.len > 0 and tail[tail.len - 1] == 'c') {
            edit.size_chips = chips.parseChips(tail[0 .. tail.len - 1]) catch return error.InvalidTreeEdit;
            if (edit.size_chips <= 0) return error.InvalidTreeEdit;
        } else {
            edit.size_pot_fraction = std.fmt.parseFloat(f64, tail) catch return error.InvalidTreeEdit;
        }
    } else {
        edit.action = allocator.dupe(u8, tail) catch return error.InvalidTreeEdit;
    }

    if (!validateLineEdit(edit)) {
        freeEdit(allocator, edit);
        return error.InvalidTreeEdit;
    }
    return edit;
}

pub fn freeEdit(allocator: std.mem.Allocator, edit: LineEdit) void {
    for (edit.path.steps) |s| allocator.free(s.label);
    if (edit.path.steps.len != 0) allocator.free(edit.path.steps);
    if (edit.action.len != 0) allocator.free(edit.action);
}

pub fn formatOneEdit(edit: LineEdit, buf: []u8) TreeEditError![]const u8 {
    var fbs = std.io.fixedBufferStream(buf);
    const w = fbs.writer();
    w.writeAll(kindToken(edit.kind)) catch return error.InvalidTreeEdit;
    w.writeByte(' ') catch return error.InvalidTreeEdit;
    if (edit.path.steps.len == 0) {
        w.writeByte('-') catch return error.InvalidTreeEdit;
    } else {
        for (edit.path.steps, 0..) |step, i| {
            if (i != 0) w.writeByte('/') catch return error.InvalidTreeEdit;
            w.writeAll(step.label) catch return error.InvalidTreeEdit;
        }
    }
    w.writeByte(' ') catch return error.InvalidTreeEdit;
    if (edit.kind == .add_size) {
        if (edit.usesChipSize()) {
            var chip_buf: [32]u8 = undefined;
            const chip_text = chips.formatChips(edit.size_chips, true, &chip_buf) catch return error.InvalidTreeEdit;
            w.writeAll(chip_text) catch return error.InvalidTreeEdit;
            w.writeByte('c') catch return error.InvalidTreeEdit;
        } else {
            w.print("{d}", .{edit.size_pot_fraction}) catch return error.InvalidTreeEdit;
        }
    } else {
        w.writeAll(edit.action) catch return error.InvalidTreeEdit;
    }
    return fbs.getWritten();
}

test "parse force root check" {
    const edit = try parseOneEdit(std.testing.allocator, "force - c");
    defer freeEdit(std.testing.allocator, edit);
    try std.testing.expect(edit.kind == .force);
    try std.testing.expectEqualStrings("c", edit.action);
    try std.testing.expectEqual(@as(usize, 0), edit.path.steps.len);
}
