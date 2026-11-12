//! Application layer: session, jobs, admission, policy publication — Phase 5.
const std = @import("std");
const poker_engine = @import("poker_engine");
const poker_formats = @import("poker_formats");

pub const session = @import("session.zig");
pub const Session = session.Session;
pub const Phase = session.Phase;
pub const PublishedLease = session.PublishedLease;
pub const phase = "phase-5";

pub fn engineModuleName() []const u8 {
    _ = poker_engine;
    _ = poker_formats;
    return "poker_engine";
}

test "app links engine and formats" {
    try std.testing.expectEqualStrings("poker_engine", engineModuleName());
}

test "session train save open roundtrip" {
    const text =
        \\street-config 1
        \\board Ah Kd 7c 4s 2h
        \\pot 100
        \\stack 100
        \\oop-range AcAd:1
        \\ip-range KsKc:1
        \\first-to-act 0
        \\max-raises 0
        \\allow-all-in 0
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 1024
        \\threads 1
        \\
    ;
    var sess = Session.init(std.testing.allocator);
    defer sess.deinit();
    try sess.begin(text);
    try sess.train(2);
    try std.testing.expect(sess.phase == .published);
    try std.testing.expect(sess.policyRevision() >= 1);
    try sess.setLocksText("lock demo");
    sess.setMetrics(.{ .value = 50, .br0 = 50, .br1 = -50, .nash_gap = 0, .accuracy = 0 });

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const abs = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(abs);
    const path = try std.fs.path.join(std.testing.allocator, &.{ abs, "phase5_roundtrip.psol" });
    defer std.testing.allocator.free(path);
    try sess.save(path);

    var other = Session.init(std.testing.allocator);
    defer other.deinit();
    // Keep prior session if open fails: seed a different solution first.
    try other.begin(text);
    try other.train(1);
    const prior_id = other.solution_id;
    try other.open(path);
    try std.testing.expect(other.solution_id != prior_id);
    try std.testing.expect(other.phase == .published);
    try std.testing.expectEqualStrings("lock demo", other.locks_text);
    try std.testing.expect(other.has_metrics);
    try std.testing.expectApproxEqAbs(@as(f64, 50.0), other.metrics.value, 1e-12);

    // Fail-closed: legacy open must not clobber.
    const legacy_id = other.solution_id;
    const legacy_phase = other.phase;
    const err = other.open("tests/fixtures/psol/street_kind1_v2_cfrplus_tiny.psol");
    try std.testing.expectError(error.LegacyCheckpointRejected, err);
    try std.testing.expectEqual(legacy_id, other.solution_id);
    try std.testing.expectEqual(legacy_phase, other.phase);
}

test {
    _ = session;
}
