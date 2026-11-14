//! Shared worker budget for train + Study analysis (D3). Host-owned.
const std = @import("std");

pub const WorkerBudget = struct {
    total: u32 = 1,
    training: u32 = 1,
    analysis: u32 = 0,

    /// Max CFR worker threads so the IPC stdin loop (and a little OS/UI slack)
    /// can still be scheduled under Windows flop MT train. Engine uses
    /// `threads` OS workers (caller + chance pool); without a reserve, status
    /// / Stop starve and Study false-hung-kills a healthy sidecar.
    pub fn maxTrainThreads(cpus: u32) u32 {
        const n = @max(cpus, 1);
        if (n <= 1) return 1;
        if (n == 2) return 1; // leave 1 for IPC
        if (n == 3) return 2; // leave 1 for IPC
        // ≥4: leave one for IPC stdin + one for OS / WebView slack.
        return n - 2;
    }

    pub fn initFromCpus() WorkerBudget {
        const cpus = std.Thread.getCpuCount() catch 1;
        const total: u32 = @intCast(@max(cpus, 1));
        const training = maxTrainThreads(total);
        return .{ .total = total, .training = training, .analysis = 0 };
    }

    /// Study analysis takes priority at safe boundaries: borrow from training.
    pub fn prioritizeAnalysis(self: *WorkerBudget, want: u32) void {
        const take = @min(want, self.total);
        self.analysis = take;
        // Never hand analysis more than the train cap would allow overall —
        // training slice is what remains for CFR after the borrow.
        self.training = if (self.total > take) self.total - take else 0;
        const cap = maxTrainThreads(self.total);
        if (self.training > cap) self.training = cap;
    }

    pub fn returnToTraining(self: *WorkerBudget) void {
        self.training = maxTrainThreads(self.total);
        self.analysis = 0;
    }
};

test "maxTrainThreads reserves IPC headroom" {
    try std.testing.expectEqual(@as(u32, 1), WorkerBudget.maxTrainThreads(1));
    try std.testing.expectEqual(@as(u32, 1), WorkerBudget.maxTrainThreads(2));
    try std.testing.expectEqual(@as(u32, 2), WorkerBudget.maxTrainThreads(3));
    try std.testing.expectEqual(@as(u32, 2), WorkerBudget.maxTrainThreads(4));
    try std.testing.expectEqual(@as(u32, 6), WorkerBudget.maxTrainThreads(8));
}

test "analysis priority borrows from training" {
    var budget = WorkerBudget{ .total = 4, .training = 2, .analysis = 0 };
    budget.prioritizeAnalysis(2);
    try std.testing.expectEqual(@as(u32, 2), budget.analysis);
    try std.testing.expectEqual(@as(u32, 2), budget.training);
    budget.returnToTraining();
    try std.testing.expectEqual(@as(u32, 2), budget.training);
    try std.testing.expectEqual(@as(u32, 0), budget.analysis);
}

test "initFromCpus training below total when multi-core" {
    const budget = WorkerBudget.initFromCpus();
    try std.testing.expect(budget.total >= 1);
    try std.testing.expect(budget.training >= 1);
    try std.testing.expect(budget.training <= budget.total);
    if (budget.total >= 4) {
        try std.testing.expectEqual(budget.total - 2, budget.training);
    }
}
