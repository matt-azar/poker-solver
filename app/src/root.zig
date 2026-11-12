//! Application layer: session, jobs, admission, policy publication — Phase 5.
const std = @import("std");
const poker_engine = @import("poker_engine");
const poker_formats = @import("poker_formats");

pub const session = @import("session.zig");
pub const plan_preview = @import("plan_preview.zig");
pub const budget_allocator = @import("budget_allocator.zig");
pub const Session = session.Session;
pub const Phase = session.Phase;
pub const PublishedLease = session.PublishedLease;
pub const BudgetAllocator = budget_allocator.BudgetAllocator;
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
    var sess = try Session.init(std.testing.allocator);
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

    var other = try Session.init(std.testing.allocator);
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

    // Fail-closed: damaged/truncated v4 (oversized array count) must not clobber.
    const damaged_path = try std.fs.path.join(std.testing.allocator, &.{ abs, "damaged_oversized.psol" });
    defer std.testing.allocator.free(damaged_path);
    {
        // Craft a sealed v4 file whose average count cannot fit remaining payload.
        var payload = std.ArrayList(u8).init(std.testing.allocator);
        defer payload.deinit();
        try payload.append(poker_formats.psol_v4.algorithm_cfr_plus);
        try payload.append(0);
        try payload.appendSlice(&[_]u8{ 0, 0 });
        try payload.appendSlice(&[_]u8{ 1, 0, 0, 0 });
        try payload.append('x');
        try payload.appendSlice(&[_]u8{ 0, 0, 0, 0 });
        try payload.appendSlice(&[_]u8{ 0, 0, 0, 0 });
        try payload.appendSlice(&[_]u8{ 0, 0, 0, 0 });
        try payload.appendSlice(&[_]u8{ 0x00, 0x00, 0x00, 0x10 }); // 0x10000000 f32s

        var hash: u64 = 0xcbf29ce484222325;
        for (payload.items) |b| {
            hash ^= b;
            hash *%= 0x100000001b3;
        }
        var header: [32]u8 = undefined;
        @memcpy(header[0..4], "PSOL");
        std.mem.writeInt(u32, header[4..8], 4, .little);
        std.mem.writeInt(u32, header[8..12], 0, .little);
        std.mem.writeInt(u64, header[12..20], payload.items.len, .little);
        std.mem.writeInt(u64, header[20..28], hash, .little);
        std.mem.writeInt(u32, header[28..32], 0, .little);

        const file = try std.fs.cwd().createFile(damaged_path, .{});
        defer file.close();
        try file.writeAll(&header);
        try file.writeAll(payload.items);
    }
    const damaged_id = other.solution_id;
    const damaged_phase = other.phase;
    const damaged_rev = other.policyRevision();
    const damaged_err = other.open(damaged_path);
    try std.testing.expectError(error.InvalidPsol, damaged_err);
    try std.testing.expectEqual(damaged_id, other.solution_id);
    try std.testing.expectEqual(damaged_phase, other.phase);
    try std.testing.expectEqual(damaged_rev, other.policyRevision());
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
    var sess = try Session.init(std.testing.allocator);
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

    var other = try Session.init(std.testing.allocator);
    defer other.deinit();
    try other.open(browse_only);
    try std.testing.expect(!other.has_training);
    try std.testing.expect(other.training == null);
    try std.testing.expect(!other.canContinue());
    try other.save(browse_only);

    var reloaded = try poker_formats.readFile(std.testing.allocator, browse_only);
    defer reloaded.deinit();
    try std.testing.expect(!reloaded.hasTraining());

    var resumed = try Session.init(std.testing.allocator);
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
    var sess = try Session.init(std.testing.allocator);
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
    var sess = try Session.init(std.testing.allocator);
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
    var sess = try Session.init(std.testing.allocator);
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
    var sess = try Session.init(std.testing.allocator);
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
    var sess = try Session.init(std.testing.allocator);
    defer sess.deinit();
    try sess.begin(text);
    sess.publish_every = 100;
    try sess.train(5);
    try std.testing.expectEqual(@as(i32, 5), sess.training.?.trained);
    // First iter + completion flush (cadence bound never hit).
    try std.testing.expectEqual(@as(i32, 5), sess.last_published_trained);
    try std.testing.expectEqual(@as(i32, 5), sess.last_committed_trained);
    try std.testing.expectEqual(@as(u64, 2), sess.policyRevision());
    try std.testing.expect(sess.phase == .published);
}

test "begin over budget preserves prior published solution" {
    const small =
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
        \\memory-mib 64
        \\threads 1
        \\
    ;
    var sess = try Session.init(std.testing.allocator);
    defer sess.deinit();
    try sess.begin(small);
    try sess.train(1);
    try std.testing.expect(sess.phase == .published);
    const prior_id = sess.solution_id;
    const prior_rev = sess.policyRevision();
    const prior_live = sess.allocatedBytes();
    try std.testing.expect(prior_live > 0);

    const fixture = try std.fs.cwd().readFileAlloc(
        std.testing.allocator,
        "benchmarks/study/configs/smoke_resource_flop.txt",
        256 * 1024,
    );
    defer std.testing.allocator.free(fixture);
    const begin_err = sess.begin(fixture);
    try std.testing.expectError(error.BudgetExceeded, begin_err);
    try std.testing.expectEqual(prior_id, sess.solution_id);
    try std.testing.expectEqual(prior_rev, sess.policyRevision());
    try std.testing.expect(sess.phase == .published);
    try std.testing.expectEqual(prior_live, sess.allocatedBytes());
}

test "adequate river budget begin succeeds and tracks live bytes" {
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
        \\memory-mib 64
        \\threads 1
        \\
    ;
    var sess = try Session.init(std.testing.allocator);
    defer sess.deinit();
    try sess.begin(text);
    try std.testing.expect(sess.allocatedBytes() > 0);
    try std.testing.expect(sess.allocatedBytes() <= sess.memory_budget_bytes);
    try sess.train(1);
    try std.testing.expect(sess.published != null);
    // Publish may allocate an average buffer; still under the declared ceiling.
    try std.testing.expect(sess.allocatedBytes() <= sess.memory_budget_bytes);
}

test "mid-pass train fault keeps published browsable and blocks Continue" {
    // ZR-145: partial CFR+ mutation must not resume from dirty tables.
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
    var sess = try Session.init(std.testing.allocator);
    defer sess.deinit();
    try sess.begin(text);
    try sess.train(2);
    try std.testing.expect(sess.canContinue());
    const published_rev = sess.policyRevision();
    const committed = sess.last_committed_trained;
    try std.testing.expect(committed >= 2);
    try std.testing.expect(sess.published != null);

    sess.inject_mid_pass_fault = true;
    try std.testing.expectError(error.InvalidFrozen, sess.train(1));
    try std.testing.expect(sess.published != null);
    try std.testing.expectEqual(published_rev, sess.policyRevision());
    try std.testing.expectEqual(committed, sess.last_committed_trained);
    try std.testing.expect(!sess.has_training);
    try std.testing.expect(!sess.canContinue());
    // Browse-only published phase: recoverTrainReady is a no-op; train still refuses.
    try std.testing.expect(sess.phase == .published);
    try sess.recoverTrainReady();
    try std.testing.expect(!sess.canContinue());
    try std.testing.expectError(error.InvalidSession, sess.train(1));
}

test "Continue after mid-pass fault requires open checkpoint or fresh begin" {
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
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const path = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(path);
    const ckpt = try std.fs.path.join(std.testing.allocator, &.{ path, "zr145_midpass.psol" });
    defer std.testing.allocator.free(ckpt);

    var sess = try Session.init(std.testing.allocator);
    defer sess.deinit();
    try sess.begin(text);
    try sess.train(2);
    try sess.save(ckpt);

    sess.inject_mid_pass_fault = true;
    try std.testing.expectError(error.InvalidFrozen, sess.train(1));
    try std.testing.expect(!sess.canContinue());

    // Open checkpoint restores resume-safe trainer tables.
    try sess.open(ckpt);
    try std.testing.expect(sess.has_training);
    try std.testing.expect(sess.canContinue());
    try std.testing.expectEqual(@as(i32, 2), sess.last_committed_trained);
    try sess.train(1);
    try std.testing.expect(sess.phase == .published);
    try std.testing.expectEqual(@as(i32, 3), sess.last_committed_trained);

    // Fresh begin also restores Continue after a mid-pass fault.
    sess.inject_mid_pass_fault = true;
    try std.testing.expectError(error.InvalidFrozen, sess.train(1));
    try std.testing.expect(!sess.canContinue());
    try sess.begin(text);
    try std.testing.expect(sess.has_training);
    try std.testing.expect(!sess.canContinue()); // no published yet
    try sess.train(1);
    try std.testing.expect(sess.canContinue());
}

test "strategy publish failure is distinct from mid-pass train failure" {
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
    var sess = try Session.init(std.testing.allocator);
    defer sess.deinit();
    try sess.begin(text);
    // First iter always publishes; complete one clean iter first.
    try sess.train(1);
    const prior_rev = sess.policyRevision();
    try std.testing.expect(prior_rev >= 1);
    try std.testing.expectEqual(@as(i32, 1), sess.last_committed_trained);

    // Force publish on the next committed iter, then fail that publish.
    sess.publish_every = 1;
    sess.inject_publish_fault = true;
    try std.testing.expectError(error.StrategyPublishFailed, sess.train(1));
    // Iteration committed even though average install failed.
    try std.testing.expectEqual(@as(i32, 2), sess.last_committed_trained);
    try std.testing.expectEqual(@as(i32, 2), sess.training.?.trained);
    try std.testing.expect(sess.has_training);
    try std.testing.expect(sess.published != null);
    try std.testing.expectEqual(prior_rev, sess.policyRevision());
    try std.testing.expect(sess.canContinue());
    try std.testing.expect(sess.phase == .published);

    // Continue / further train still works (tables are coherent).
    try sess.train(1);
    try std.testing.expectEqual(@as(i32, 3), sess.last_committed_trained);
    try std.testing.expect(sess.policyRevision() > prior_rev);
}


test {
    _ = session;
    _ = plan_preview;
    _ = budget_allocator;
}
