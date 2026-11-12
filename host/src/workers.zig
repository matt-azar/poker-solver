//! Shared worker budget for train + Study analysis (D3). Host-owned.
const std = @import("std");

pub const WorkerBudget = struct {
    total: u32 = 1,
    training: u32 = 1,
    analysis: u32 = 0,

    pub fn initFromCpus() WorkerBudget {
        const cpus = std.Thread.getCpuCount() catch 1;
        const total: u32 = @intCast(@max(cpus, 1));
        return .{ .total = total, .training = total, .analysis = 0 };
    }

    /// Study analysis takes priority at safe boundaries: borrow from training.
    pub fn prioritizeAnalysis(self: *WorkerBudget, want: u32) void {
        const take = @min(want, self.total);
        self.analysis = take;
        self.training = self.total - take;
    }

    pub fn returnToTraining(self: *WorkerBudget) void {
        self.training = self.total;
        self.analysis = 0;
    }
};

test "analysis priority borrows from training" {
    var budget = WorkerBudget{ .total = 4, .training = 4, .analysis = 0 };
    budget.prioritizeAnalysis(2);
    try std.testing.expectEqual(@as(u32, 2), budget.analysis);
    try std.testing.expectEqual(@as(u32, 2), budget.training);
    budget.returnToTraining();
    try std.testing.expectEqual(@as(u32, 4), budget.training);
}
