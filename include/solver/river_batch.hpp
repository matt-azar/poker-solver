#pragma once

#include "game/river_game.hpp"
#include "solver/street_batch.hpp"
#include "solver/trainer.hpp"
#include "solver/training_state.hpp"

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <span>
#include <string>
#include <vector>

namespace poker::solver
{

struct RiverStrategyEntry
{
    std::string infoset;
    std::string action;
    double probability = 0.0;
};

// Same CFR and CFR+ update as CfrTrainer<RiverGame>. A pass freezes regret
// matching, sums that player's counterfactual regret across every deal, then
// CFR+ floors only that player. The floor is not applied between deals. The
// betting tree is stored once. Best response is one walk over that tree.
// RiverGame remains the reference.
//
// Node browse and conditional action EV reuse the street inspection and
// StreetActionValues shapes so the explorer HTTP and UI stay shared. Node ids
// use pN.t-1.r-1. There are no chance nodes on a five-card board.
class RiverBatchSolver
{
public:
    explicit RiverBatchSolver(river::RiverConfig config);
    ~RiverBatchSolver();

    RiverBatchSolver(const RiverBatchSolver&) = delete;
    RiverBatchSolver& operator=(const RiverBatchSolver&) = delete;

    // Honors SolveConfig::locks: after regret matching, locked rows replace the
    // current strategy for matching public nodes (infoset_id == node index) and
    // SelectedCombos hand indices. Null locks keep today's unlocked path.
    SolveStats solve(const SolveConfig& config, Algorithm algorithm);
    // Optional locks apply for this call only (saved/restored like solve()).
    // Null keeps the unlocked path bit-identical to the prior no-locks API.
    void run_iterations(int count, Algorithm algorithm, const LockSet* locks = nullptr);
    // Adds iterations on top of the tables already stored. A new solver starts at zero.
    // Optional locks apply for this call only (same contract as run_iterations).
    void continue_iterations(int count, Algorithm algorithm, const LockSet* locks = nullptr);
    int completed_iterations() const;
    const river::RiverConfig& config() const;
    TrainingTables training_tables() const;
    void install_training_tables(const TrainingTables& tables);

    double expected_utility() const;
    double p1_best_response_utility() const;
    double p2_best_response_utility() const;
    double nash_gap() const;

    int infoset_count() const;
    int deal_count() const;
    int public_decisions() const;
    int public_terminals() const;
    int regret_entries() const;
    std::size_t memory_bytes_estimate() const;

    std::vector<RiverStrategyEntry> average_strategy_entries() const;

    // Normalize the average profile once. Later node queries only read it.
    void prepare_inspection() const;
    std::string root_node_id() const;
    StreetInspection inspect_node(const std::string& node_id) const;
    // Force each legal action once, then both players follow the stored average.
    // cancel may be null. A true flag throws StreetValueCancelled.
    StreetActionValues action_values(
        const std::string& node_id,
        const std::atomic<bool>* cancel = nullptr) const;
    std::uint64_t profile_epoch() const;
    // Free-form average edit for browse/EV. Does not rewrite strategy_sum, so
    // invalidate_prepared_average() restores the CFR average. Validates
    // nonnegative probs that sum to 1. Bumps profile_epoch.
    void set_average_strategy(
        const std::string& node_id,
        int hand,
        std::span<const double> probability);
    void invalidate_prepared_average();
    // Legacy test helper: also rewrites strategy_sum (survives average rebuild).
    void set_average_for_test(
        const std::string& node_id,
        int hand,
        std::span<const double> probability);
    std::span<const double> regret_table() const;
    std::span<const double> strategy_sum_table() const;

private:
    struct Engine;
    void note_profile_mutation();
    std::unique_ptr<Engine> engine_;
    mutable std::mutex value_mu_;
    mutable std::uint64_t profile_epoch_ = 0;
    mutable bool value_cache_valid_ = false;
    mutable std::string value_cache_node_;
    mutable std::uint64_t value_cache_epoch_ = 0;
    mutable StreetActionValues value_cache_{};
};

} // namespace poker::solver
