#pragma once

// Predictive CFR+ (PRM+) notes shared by the StreetBatch schedule and any
// future helpers. Discount / RM arithmetic is not here: RM runs on R+m with
// m = last instantaneous CF regret; the schedule cold-starts m = 0, commits
// after each updating pass (fold m into R and floor), and uses linear (t)
// own-reach average weights. Slot tables and collect flags live on
// StreetBatchSolver::Engine (prediction_, pcfr_collect_).

namespace poker::solver
{

// Intentionally no free functions yet: commit / zero-prediction / collect
// wiring is Engine slot-pass state, not portable math like solver/dcfr.hpp.

} // namespace poker::solver
