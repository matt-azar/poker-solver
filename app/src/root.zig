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
    const locks_text =
        \\lock 42 at -1 -1 full probs 0.25 0.75
        \\lock 12 at -1 7 full probs 1 0
        \\lock 8 line full probs 0 1
        \\
    ;
    try sess.setLocksText(locks_text);
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
    try std.testing.expectEqualStrings(locks_text, other.locks_text);
    // Overlay text remains parseable as C++-compatible node/line locks.
    var parsed = try poker_engine.solve.node_lock.parseLockSet(std.testing.allocator, other.locks_text);
    defer parsed.deinit();
    try std.testing.expectEqual(@as(usize, 3), parsed.size());
    try std.testing.expectEqual(@as(f64, 0.25), parsed.findExact(42, -1, -1).?.actions.probs[0]);
    try std.testing.expectEqual(@as(f64, 1.0), parsed.findForRunout(12, -1, 7).?.actions.probs[0]);
    try std.testing.expect(parsed.find(8).?.isLine());
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

test "browse-only open keeps has_training false and continue disabled" {
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
    try sess.train(1);
    try std.testing.expect(sess.has_training);
    try std.testing.expect(sess.canContinue());

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const abs = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(abs);
    const with_train = try std.fs.path.join(std.testing.allocator, &.{ abs, "with_train.psol" });
    defer std.testing.allocator.free(with_train);
    const browse_only = try std.fs.path.join(std.testing.allocator, &.{ abs, "browse_only.psol" });
    defer std.testing.allocator.free(browse_only);

    try sess.save(with_train);

    // Force a browse-only document by clearing the training flag in a copy.
    var doc = try poker_formats.readFile(std.testing.allocator, with_train);
    defer doc.deinit();
    try std.testing.expect(doc.hasTraining());
    doc.has_training_flag = false;
    if (doc.regret.len != 0) {
        std.testing.allocator.free(doc.regret);
        doc.regret = &.{};
    }
    if (doc.strategy_sum.len != 0) {
        std.testing.allocator.free(doc.strategy_sum);
        doc.strategy_sum = &.{};
    }
    try poker_formats.writeFile(std.testing.allocator, browse_only, doc);

    var other = Session.init(std.testing.allocator);
    defer other.deinit();
    try other.open(browse_only);
    try std.testing.expect(!other.has_training);
    try std.testing.expect(other.training == null);
    try std.testing.expect(!other.canContinue());
    try other.save(browse_only);

    var reloaded = try poker_formats.readFile(std.testing.allocator, browse_only);
    defer reloaded.deinit();
    try std.testing.expect(!reloaded.hasTraining());

    var resumed = Session.init(std.testing.allocator);
    defer resumed.deinit();
    try resumed.open(with_train);
    try std.testing.expect(resumed.has_training);
    try std.testing.expect(resumed.canContinue());
}

test {
    _ = session;
}
