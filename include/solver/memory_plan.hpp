#pragma once

#include "game/street_game.hpp"
#include "solver/street_batch.hpp"

#include <cstdint>
#include <utility>

namespace poker::solver
{

// Pre-solve memory plan for a street config. estimated_peak_bytes is the same
// labeled engine plan that StreetMemoryReport exposes after construction
// (payload sizes, one block header per planned buffer, one map node per
// runout). It is not process RSS and not a measured high-water mark.
//
// Distinctions (do not conflate):
//   estimated_peak_bytes — labeled plan recorded mid-construction
//   allocated_bytes / peak_allocated_bytes — measured engine-budget charges
//     after a full build (absent / lower on a plan-only dry-run)
//   process_peak_working_set_bytes — whole-process RSS when the OS reports it
//
// plan_street_memory uses StreetBatchSolver(config, kPlanOnly): public tree and
// plan fields are computed, then construction stops before deals, slots, regret
// tables, reach, and worker contexts are allocated. Callers inspect the plan
// before a long solve without paying for the remaining training buffers.
struct StreetMemoryPlan
{
    std::uint64_t estimated_peak_bytes = 0;
    std::uint64_t memory_budget_bytes = 0;
    std::uint64_t deals = 0;
    std::uint64_t infosets = 0;
    std::uint64_t decision_nodes = 0;
    std::uint64_t terminals = 0;
    int public_decisions = 0;
    int thread_count = 1;
    // True when the plan came from a mid-construction dry-run (always for
    // plan_street_memory).
    bool dry_run = false;
};

inline StreetMemoryPlan plan_street_memory(streets::StreetConfig config)
{
    StreetBatchSolver solver(std::move(config), kPlanOnly);
    const StreetMemoryReport report = solver.memory_report();
    StreetMemoryPlan plan;
    plan.estimated_peak_bytes = report.estimated_peak_bytes;
    plan.memory_budget_bytes = report.memory_budget_bytes;
    plan.deals = solver.deal_count();
    plan.infosets = solver.infoset_count();
    plan.decision_nodes = solver.decision_node_count();
    plan.terminals = solver.terminal_count();
    plan.public_decisions = solver.public_decisions();
    plan.thread_count = solver.thread_count();
    plan.dry_run = true;
    return plan;
}

inline bool plan_fits_budget(const StreetMemoryPlan& plan)
{
    return plan.estimated_peak_bytes <= plan.memory_budget_bytes;
}

} // namespace poker::solver
