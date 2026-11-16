//! Load and validate holdem-study-job/1 JSON (street-config + run limits).
const std = @import("std");

pub const JobError = error{
    InvalidJob,
    MissingField,
    BadIterations,
    BadStreetConfig,
    OutOfMemory,
};

pub const Job = struct {
    street_config: []u8,
    iterations: i32,
    accuracy: ?f64 = null,
    time_limit: ?f64 = null,
    /// Owned decision action labels (Study open path).
    decision_actions: [][]u8 = &.{},
    /// Owned missing_sizes from review (may be empty).
    missing_sizes: [][]u8 = &.{},
    /// Raw JSON array mirror for solve summary.
    decision_actions_json: ?[]u8 = null,

    pub fn deinit(self: *Job, allocator: std.mem.Allocator) void {
        allocator.free(self.street_config);
        for (self.decision_actions) |a| allocator.free(a);
        if (self.decision_actions.len != 0) allocator.free(self.decision_actions);
        for (self.missing_sizes) |m| allocator.free(m);
        if (self.missing_sizes.len != 0) allocator.free(self.missing_sizes);
        if (self.decision_actions_json) |a| allocator.free(a);
        self.* = undefined;
    }
};

const RunJson = struct {
    iterations: i32,
    accuracy: ?f64 = null,
    time_limit: ?f64 = null,
};

const DecisionJson = struct {
    actions: []const []const u8 = &.{},
};

const ReviewJson = struct {
    missing_sizes: []const []const u8 = &.{},
};

const JobJson = struct {
    schema: []const u8,
    street_config: []const u8,
    run: RunJson,
    decision: ?DecisionJson = null,
    review: ?ReviewJson = null,
};

fn dupeLabels(allocator: std.mem.Allocator, labels: []const []const u8) JobError![][]u8 {
    if (labels.len == 0) return &.{};
    var out = allocator.alloc([]u8, labels.len) catch return error.OutOfMemory;
    var filled: usize = 0;
    errdefer {
        for (out[0..filled]) |s| allocator.free(s);
        allocator.free(out);
    }
    while (filled < labels.len) : (filled += 1) {
        out[filled] = allocator.dupe(u8, labels[filled]) catch return error.OutOfMemory;
    }
    return out;
}

pub fn loadJob(allocator: std.mem.Allocator, path: []const u8) JobError!Job {
    const text = std.fs.cwd().readFileAlloc(allocator, path, 16 * 1024 * 1024) catch return error.InvalidJob;
    defer allocator.free(text);

    const parsed = std.json.parseFromSlice(JobJson, allocator, text, .{
        .ignore_unknown_fields = true,
    }) catch return error.InvalidJob;
    defer parsed.deinit();
    const value = parsed.value;

    if (!std.mem.eql(u8, value.schema, "holdem-study-job/1")) return error.InvalidJob;
    if (value.run.iterations < 1) return error.BadIterations;
    const trimmed = std.mem.trim(u8, value.street_config, " \t\r\n");
    if (!std.mem.startsWith(u8, trimmed, "street-config 1")) return error.BadStreetConfig;

    const street_config = allocator.dupe(u8, value.street_config) catch return error.OutOfMemory;
    errdefer allocator.free(street_config);

    var decision_actions: [][]u8 = &.{};
    var decision_actions_json: ?[]u8 = null;
    if (value.decision) |dec| {
        decision_actions = try dupeLabels(allocator, dec.actions);
        if (dec.actions.len > 0) {
            var list = std.ArrayList(u8).init(allocator);
            errdefer list.deinit();
            try list.appendSlice("[");
            for (dec.actions, 0..) |action, i| {
                if (i > 0) try list.appendSlice(",");
                std.json.stringify(action, .{}, list.writer()) catch return error.OutOfMemory;
            }
            try list.appendSlice("]");
            decision_actions_json = list.toOwnedSlice() catch return error.OutOfMemory;
        }
    }

    var missing_sizes: [][]u8 = &.{};
    if (value.review) |rev| {
        missing_sizes = try dupeLabels(allocator, rev.missing_sizes);
    }

    return .{
        .street_config = street_config,
        .iterations = value.run.iterations,
        .accuracy = value.run.accuracy,
        .time_limit = value.run.time_limit,
        .decision_actions = decision_actions,
        .missing_sizes = missing_sizes,
        .decision_actions_json = decision_actions_json,
    };
}

pub fn validateRunLimits(job: Job) JobError!void {
    if (job.iterations < 1) return error.BadIterations;
    if (job.accuracy) |acc| {
        if (!std.math.isFinite(acc)) return error.InvalidJob;
    }
    if (job.time_limit) |tl| {
        if (!std.math.isFinite(tl) or tl <= 0) return error.InvalidJob;
    }
}
