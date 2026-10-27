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

// Same CFR and CFR+ update as CfrTrainer<StreetGame>, including per-deal
// order, runout order, and the CFR+ floor between deals. The betting
// structure is stored once and reused on every turn and river card.
// StreetGame remains the reference.
class StreetBatchSolver
{
public:
    explicit StreetBatchSolver(streets::StreetConfig config);
    ~StreetBatchSolver();

    StreetBatchSolver(const StreetBatchSolver&) = delete;
    StreetBatchSolver& operator=(const StreetBatchSolver&) = delete;

    SolveStats solve(const SolveConfig& config, Algorithm algorithm);
    void run_iterations(int count, Algorithm algorithm);
    void continue_iterations(int count, Algorithm algorithm);

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

private:
    struct Engine;
    std::unique_ptr<Engine> engine_;
};
} // namespace poker::solver
