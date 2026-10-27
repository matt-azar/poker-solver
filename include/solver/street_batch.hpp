#pragma once

#include "game/street_game.hpp"
#include "solver/trainer.hpp"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace poker::solver
{

struct StreetStrategyEntry
{
    std::string infoset;
    std::string action;
    double probability = 0.0;
};

// One named piece of solver-owned heap. Rank-cache bytes are a reserved bound,
// charged before the first pass, not a claim that every runout is already stored.
struct StreetMemoryComponent
{
    std::string name;
    std::uint64_t bytes = 0;
};

// Engine heap tracked by the street solver. This is not process RSS.
// estimated_peak_bytes is the plan made before the large tables are allocated.
// regret_strategy_sum_bytes is only the regret array plus the strategy-sum array.
struct StreetMemoryReport
{
    std::uint64_t memory_budget_bytes = 0;
    std::uint64_t allocated_bytes = 0;
    std::uint64_t peak_allocated_bytes = 0;
    std::uint64_t regret_strategy_sum_bytes = 0;
    std::uint64_t estimated_peak_bytes = 0;
    std::uint64_t expanded_terminals = 0;
    std::uint64_t expanded_decisions = 0;
    std::uint64_t process_peak_working_set_bytes = 0;
    double construction_seconds = 0.0;
    double train_seconds = 0.0;
    double evaluation_seconds = 0.0;
    std::vector<StreetMemoryComponent> components;
};

// Same pass contract as CfrTrainer<StreetGame>. Each pass freezes regret
// matching, sums that player's counterfactual regret, then CFR+ floors only
// that player. The sequential walk and the frozen combo walk both use this
// contract. StreetGame remains the reference. Construction and the workspace
// used by a pass stay inside StreetConfig::memory_mib. That budget is
// solver-owned heap, not an operating-system memory limit.
class StreetBatchSolver
{
public:
    explicit StreetBatchSolver(streets::StreetConfig config);
    ~StreetBatchSolver();

    StreetBatchSolver(const StreetBatchSolver&) = delete;
    StreetBatchSolver& operator=(const StreetBatchSolver&) = delete;

    SolveStats solve(const SolveConfig& config, Algorithm algorithm);
    // One public-tree pass per player. The strategy is frozen for the pass and
    // CFR+ floors only the player who just accumulated regret.
    SolveStats solve_frozen(const SolveConfig& config, Algorithm algorithm);
    void run_iterations(int count, Algorithm algorithm);
    void continue_iterations(int count, Algorithm algorithm);
    void run_frozen_iterations(int count, Algorithm algorithm);
    void continue_frozen_iterations(int count, Algorithm algorithm);

    double expected_utility() const;
    double p1_best_response_utility() const;
    double p2_best_response_utility() const;
    double nash_gap() const;

    std::uint64_t infoset_count() const;
    std::uint64_t deal_count() const;
    int public_decisions() const;
    int public_terminals() const;
    // Expanded histories. These are not stored nodes.
    std::uint64_t decision_node_count() const;
    std::uint64_t terminal_count() const;
    int regret_entries() const;
    // Regret array plus strategy-sum array only.
    std::size_t memory_bytes_estimate() const;
    StreetMemoryReport memory_report() const;

    std::vector<StreetStrategyEntry> average_strategy_entries() const;
    bool set_regret(const std::string& infoset, const std::string& action, double value);
    bool regret_value(const std::string& infoset, const std::string& action, double& value) const;

private:
    struct Engine;
    std::unique_ptr<Engine> engine_;
};
} // namespace poker::solver
