//! Training state, reach, and traversal — Phase 3 (+ frozen_walk for flop scale).
pub const regret_matching = @import("regret_matching.zig");
pub const training_state = @import("training_state.zig");
pub const traversal = @import("traversal.zig");
pub const frozen_walk = @import("frozen_walk.zig");
pub const algorithms = @import("algorithms/cfr_plus.zig");
pub const cfr_plus = algorithms;
pub const node_lock = @import("node_lock.zig");
pub const phase = "phase-3";

test {
    _ = regret_matching;
    _ = training_state;
    _ = traversal;
    _ = frozen_walk;
    _ = algorithms;
    _ = node_lock;
    _ = @import("strategy_parity_test.zig");
    _ = @import("turn_pot_bet_rematch_test.zig");
    _ = @import("node_lock_rematch_test.zig");
    _ = @import("lock_apply_train_rematch_test.zig");
}
