#include "solver/best_response.hpp"

#include "game/kuhn_game.hpp"
#include "solver/cfr.hpp"
#include "solver/trainer.hpp"

namespace poker::solver
{

double best_response_p1_utility(const std::vector<double>& average_strategy)
{
    return compute_best_response(poker::kuhn::KuhnGame{}, average_strategy).p1_utility_when_p1_responds;
}

double best_response_p2_utility(const std::vector<double>& average_strategy)
{
    return compute_best_response(poker::kuhn::KuhnGame{}, average_strategy).p2_utility_when_p2_responds;
}

double nash_gap(const std::vector<double>& average_strategy)
{
    return compute_best_response(poker::kuhn::KuhnGame{}, average_strategy).nash_gap;
}

SolveStats evaluate_average_strategy(const std::vector<double>& average_strategy)
{
    const BestResponseResult response = compute_best_response(
        poker::kuhn::KuhnGame{}, average_strategy);
    SolveStats stats;
    stats.p1_expected_utility = expected_p1_utility(average_strategy);
    stats.p1_best_response_utility = response.p1_utility_when_p1_responds;
    stats.p2_best_response_utility = response.p2_utility_when_p2_responds;
    stats.nash_gap = response.nash_gap;
    const CfrTrainer<poker::kuhn::KuhnGame> probe(poker::kuhn::KuhnGame{}, Algorithm::VanillaCfr);
    stats.memory_bytes_estimate = probe.memory_bytes_estimate();
    return stats;
}

} // namespace poker::solver
