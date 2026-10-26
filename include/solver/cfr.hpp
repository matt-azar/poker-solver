#pragma once

#include "game/kuhn.hpp"

#include <cstddef>
#include <vector>

namespace poker::solver
{

struct SolveStats
{
    int iterations = 0;
    double runtime_seconds = 0.0;
    std::size_t memory_bytes_estimate = 0;
    double p1_expected_utility = 0.0;
    double p1_best_response_utility = 0.0;
    double p2_best_response_utility = 0.0;
    double nash_gap = 0.0;
};

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

    const std::vector<double>& regrets() const { return regret_; }
    const std::vector<double>& strategy_sum() const { return strategy_sum_; }

    static std::size_t table_memory_bytes();

private:
    double cfr(poker::kuhn::Deal deal,
               poker::kuhn::Sequence sequence,
               double pi1,
               double pi2,
               double pi_chance);

    std::vector<double> regret_;
    std::vector<double> strategy_sum_;
};

double expected_p1_utility(const std::vector<double>& strategy);
double traverse_expected_p1(poker::kuhn::Deal deal,
                            poker::kuhn::Sequence sequence,
                            const std::vector<double>& strategy);

} // namespace poker::solver
