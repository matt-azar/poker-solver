#pragma once

#include "game/street_game.hpp"
#include "solver/trainer.hpp"

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

// Same pass contract as CfrTrainer<StreetGame>. Each pass freezes regret
// matching, sums that player's counterfactual regret, then CFR+ floors only
// that player. The sequential walk and the frozen combo walk both use this
// contract. StreetGame remains the reference.
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

    int infoset_count() const;
    int deal_count() const;
    int public_decisions() const;
    int public_terminals() const;
    int decision_node_count() const;
    int terminal_count() const;
    int regret_entries() const;
    std::size_t memory_bytes_estimate() const;

    std::vector<StreetStrategyEntry> average_strategy_entries() const;
    bool set_regret(const std::string& infoset, const std::string& action, double value);
    bool regret_value(const std::string& infoset, const std::string& action, double& value) const;

private:
    struct Engine;
    std::unique_ptr<Engine> engine_;
};
} // namespace poker::solver
