//! Training state, reach, and traversal — Phase 3.
pub const regret_matching = @import("regret_matching.zig");
pub const training_state = @import("training_state.zig");
pub const traversal = @import("traversal.zig");
pub const algorithms = @import("algorithms/cfr_plus.zig");
pub const cfr_plus = algorithms;
pub const phase = "phase-3";

test {
    _ = regret_matching;
    _ = training_state;
    _ = traversal;
    _ = algorithms;
}
