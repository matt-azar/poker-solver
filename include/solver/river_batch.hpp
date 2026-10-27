#pragma once

#include "game/river_game.hpp"
#include "solver/trainer.hpp"

#include <memory>
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

// Same CFR and CFR+ update as CfrTrainer<RiverGame>, including per-deal order
// and the CFR+ floor between deals. The betting tree is stored once. Best
// response is one walk over that tree. RiverGame remains the reference.
class RiverBatchSolver
{
public:
    explicit RiverBatchSolver(river::RiverConfig config);
    ~RiverBatchSolver();

    RiverBatchSolver(const RiverBatchSolver&) = delete;
    RiverBatchSolver& operator=(const RiverBatchSolver&) = delete;

    SolveStats solve(const SolveConfig& config, Algorithm algorithm);
    void run_iterations(int count, Algorithm algorithm);

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

private:
    struct Engine;
    std::unique_ptr<Engine> engine_;
};

} // namespace poker::solver
