//! Application layer: session, jobs, admission, policy publication — Phase 5.
const std = @import("std");
const poker_engine = @import("poker_engine");
const poker_formats = @import("poker_formats");

pub const session = @import("session.zig");
pub const plan_preview = @import("plan_preview.zig");
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

test "train recovers from sticky failed phase without re-begin" {
    const text =
        \\street-config 1
        \\board Ah Kh Qh Jh 2c
        \\pot 100
        \\stack 100
        \\oop-range AsQs:1,2d2h:1
        \\ip-range AsQs:1,2d2h:1
        \\oop-river-bets 1
        \\ip-river-bets 1
        \\first-to-act 0
        \\max-raises 0
        \\allow-all-in 1
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 256
        \\threads 1
        \\
    ;
    var sess = Session.init(std.testing.allocator);
    defer sess.deinit();
    try sess.begin(text);
    try std.testing.expect(sess.has_training);
    // Simulate a hard train fault that left phase=.failed with trainer intact.
    sess.phase = .failed;
    try sess.recoverTrainReady();
    try std.testing.expect(sess.phase == .paused);
    try sess.train(2);
    try std.testing.expect(sess.phase == .published);
    try std.testing.expect(sess.policyRevision() >= 1);

    // Failed after a publish must also restart (Continue path).
    sess.phase = .failed;
    try sess.train(1);
    try std.testing.expect(sess.phase == .published);
}

test "early stop before publish leaves session paused and continuable" {
    const text =
        \\street-config 1
        \\board Ah Kh Qh Jh 2c
        \\pot 100
        \\stack 100
        \\oop-range AsQs:1,2d2h:1
        \\ip-range AsQs:1,2d2h:1
        \\oop-river-bets 1
        \\ip-river-bets 1
        \\first-to-act 0
        \\max-raises 0
        \\allow-all-in 1
        \\allow-three-bet 1
        \\all-in-threshold 0
        \\pot-cap 0
        \\rake-rate 0
        \\rake-cap 0
        \\memory-mib 256
        \\threads 1
        \\
    ;
    var sess = Session.init(std.testing.allocator);
    defer sess.deinit();
    try sess.begin(text);
    try std.testing.expect(sess.phase == .paused);
    try std.testing.expect(sess.published == null);

    // Simulate Stop before first publish: requestStop then train exits immediately.
    sess.requestStop();
    try sess.train(2_000_000);
    try std.testing.expect(sess.last_terminal == .cancelled);
    try std.testing.expect(sess.phase == .paused);
    try std.testing.expect(sess.published == null);
    try std.testing.expect(sess.has_training);

    // Fresh train without re-begin must succeed and publish.
    try sess.train(2);
    try std.testing.expect(sess.phase == .published);
    try std.testing.expect(sess.last_terminal == .completed);
    try std.testing.expect(sess.policyRevision() >= 1);
}

test "prepareResolveLocked reset stamps baseline and zeros trained" {
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
    try sess.train(3);
    const prior = sess.solution_id;
    try std.testing.expect(sess.training.?.trained >= 3);
    try sess.prepareResolveLocked(false);
    try std.testing.expectEqual(prior, sess.baseline_id);
    try std.testing.expect(sess.solution_id != prior);
    try std.testing.expectEqual(@as(i32, 0), sess.training.?.trained);
    try sess.train(1);
    try std.testing.expect(sess.training.?.trained >= 1);
    try std.testing.expectEqual(prior, sess.baseline_id);
}

test "publish cadence carries across train(1) and flushes on exact" {
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
    sess.publish_every = 3;

    // First completed iter always publishes (Study values waiters).
    try sess.train(1);
    try std.testing.expectEqual(@as(i32, 1), sess.training.?.trained);
    try std.testing.expectEqual(@as(i32, 1), sess.last_published_trained);
    try std.testing.expectEqual(@as(u64, 1), sess.policyRevision());

    // Cadence carries: next two train(1) steps skip full publish.
    try sess.train(1);
    try sess.train(1);
    try std.testing.expectEqual(@as(i32, 3), sess.training.?.trained);
    try std.testing.expectEqual(@as(i32, 1), sess.last_published_trained);
    try std.testing.expectEqual(@as(u64, 1), sess.policyRevision());
    try std.testing.expectEqual(@as(i32, 2), sess.iters_since_publish);

    // Third step since last publish hits the bound.
    try sess.train(1);
    try std.testing.expectEqual(@as(i32, 4), sess.training.?.trained);
    try std.testing.expectEqual(@as(i32, 4), sess.last_published_trained);
    try std.testing.expectEqual(@as(u64, 2), sess.policyRevision());
    try std.testing.expectEqual(@as(i32, 0), sess.iters_since_publish);

    // Mid-cadence Acc/save path forces the exact average for the claimed iter.
    try sess.train(1);
    try std.testing.expectEqual(@as(i32, 5), sess.training.?.trained);
    try std.testing.expectEqual(@as(i32, 4), sess.last_published_trained);
    try sess.ensurePublishedExact();
    try std.testing.expectEqual(@as(i32, 5), sess.last_published_trained);
    try std.testing.expectEqual(@as(u64, 3), sess.policyRevision());
}

test "multi-iter train forces publish at completion" {
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
    sess.publish_every = 100;
    try sess.train(5);
    try std.testing.expectEqual(@as(i32, 5), sess.training.?.trained);
    // First iter + completion flush (cadence bound never hit).
    try std.testing.expectEqual(@as(i32, 5), sess.last_published_trained);
    try std.testing.expectEqual(@as(u64, 2), sess.policyRevision());
    try std.testing.expect(sess.phase == .published);
}

test {
    _ = session;
    _ = plan_preview;
}
