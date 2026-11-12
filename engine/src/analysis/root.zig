//! Inspect / EV / equity / BR — Phase 4.
pub const evaluation = @import("evaluation.zig");
pub const best_response = @import("best_response.zig");
pub const inspect = @import("inspect.zig");
pub const action_ev = @import("action_ev.zig");
pub const equity = @import("equity.zig");
pub const equity_calculator = @import("equity_calculator.zig");
pub const node_id = @import("node_id.zig");
pub const phase = "phase-4";

test {
    _ = evaluation;
    _ = best_response;
    _ = inspect;
    _ = action_ev;
    _ = equity;
    _ = equity_calculator;
    _ = node_id;
    _ = @import("phase4_test.zig");
    _ = @import("action_ev_rematch_test.zig");
    _ = @import("equity_rematch_test.zig");
}
