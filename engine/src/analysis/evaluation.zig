const std = @import("std");

/// Shared on-profile + best-response evaluation (C++ EvaluationResult).
/// NashConv = (br0 - u0) + (br1 - u1). Accuracy = NashConv / 2 (Pio).
pub const EvaluationResult = struct {
    u0: f64 = 0,
    u1: f64 = 0,
    br0: f64 = 0,
    br1: f64 = 0,
    gain0: f64 = 0,
    gain1: f64 = 0,
    nash_gap: f64 = 0,
    accuracy: f64 = 0,
};

pub fn makeEvaluation(util0: f64, util1: f64, br_util0: f64, br_util1: f64) EvaluationResult {
    var result = EvaluationResult{
        .u0 = util0,
        .u1 = util1,
        .br0 = br_util0,
        .br1 = br_util1,
        .gain0 = br_util0 - util0,
        .gain1 = br_util1 - util1,
    };
    result.nash_gap = result.gain0 + result.gain1;
    result.accuracy = 0.5 * result.nash_gap;
    return result;
}

test "makeEvaluation Accuracy is half NashConv" {
    const result = makeEvaluation(50.0, -50.0, 50.0, -50.0);
    try std.testing.expectApproxEqAbs(@as(f64, 0.0), result.nash_gap, 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, 0.0), result.accuracy, 1e-12);
    const raked = makeEvaluation(45.0, -50.0, 45.0, -50.0);
    try std.testing.expectApproxEqAbs(@as(f64, 0.0), raked.nash_gap, 1e-12);
    // Absolute BR sum is not NashConv under rake.
    try std.testing.expect(@abs((raked.br0 + raked.br1) - raked.nash_gap) > 1.0);
}
