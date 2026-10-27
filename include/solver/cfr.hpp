#pragma once

#include "game/kuhn_game.hpp"
#include "solver/trainer.hpp"

#include <vector>

namespace poker::solver
{

class KuhnCfrTrainer
{
public:
    KuhnCfrTrainer();

    void iterate();
    void solve(int iterations);

    // Average strategy: kNumInfosets * kActionsPerInfoset probabilities.
    std::vector<double> average_strategy() const;

    double expected_p1_utility() const;
    SolveStats evaluate() const;

    const std::vector<double>& regrets() const;
    const std::vector<double>& strategy_sum() const;

    static std::size_t table_memory_bytes();

private:
    CfrTrainer<poker::kuhn::KuhnGame> trainer_;
};

// Reference utility walk kept independent of the generalized tree walker.
double expected_p1_utility(const std::vector<double>& strategy);
double traverse_expected_p1(poker::kuhn::Deal deal,
                            poker::kuhn::Sequence sequence,
                            const std::vector<double>& strategy);

} // namespace poker::solver
