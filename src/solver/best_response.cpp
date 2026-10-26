#include "solver/best_response.hpp"

#include "game/kuhn.hpp"

#include <limits>

namespace poker::solver
{
namespace
{

int entry(int infoset, int local_action)
{
    return infoset * poker::kuhn::kActionsPerInfoset + local_action;
}

std::vector<double> with_pure_actions(const std::vector<double>& mixed,
                                      poker::kuhn::Player br_player,
                                      int mask)
{
    std::vector<double> out = mixed;
    const int begin = br_player == poker::kuhn::Player::P1 ? 0 : 6;
    for (int local_infoset = 0; local_infoset < 6; ++local_infoset)
    {
        const int infoset = begin + local_infoset;
        const int bit = (mask >> local_infoset) & 1;
        out[entry(infoset, 0)] = bit == 0 ? 1.0 : 0.0;
        out[entry(infoset, 1)] = bit == 1 ? 1.0 : 0.0;
    }
    return out;
}

} // namespace

double best_response_p1_utility(const std::vector<double>& average_strategy)
{
    double best = -std::numeric_limits<double>::infinity();
    for (int mask = 0; mask < 64; ++mask)
    {
        const auto profile = with_pure_actions(average_strategy, poker::kuhn::Player::P1, mask);
        const double u = expected_p1_utility(profile);
        if (u > best)
        {
            best = u;
        }
    }
    return best;
}

double best_response_p2_utility(const std::vector<double>& average_strategy)
{
    double best_p2 = -std::numeric_limits<double>::infinity();
    for (int mask = 0; mask < 64; ++mask)
    {
        const auto profile = with_pure_actions(average_strategy, poker::kuhn::Player::P2, mask);
        const double u1 = expected_p1_utility(profile);
        const double u2 = -u1;
        if (u2 > best_p2)
        {
            best_p2 = u2;
        }
    }
    return best_p2;
}

double nash_gap(const std::vector<double>& average_strategy)
{
    return best_response_p1_utility(average_strategy)
        + best_response_p2_utility(average_strategy);
}

SolveStats evaluate_average_strategy(const std::vector<double>& average_strategy)
{
    SolveStats stats;
    stats.p1_expected_utility = expected_p1_utility(average_strategy);
    stats.p1_best_response_utility = best_response_p1_utility(average_strategy);
    stats.p2_best_response_utility = best_response_p2_utility(average_strategy);
    stats.nash_gap = stats.p1_best_response_utility + stats.p2_best_response_utility;
    stats.memory_bytes_estimate = KuhnCfrTrainer::table_memory_bytes();
    return stats;
}

} // namespace poker::solver
