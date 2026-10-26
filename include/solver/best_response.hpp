#pragma once

#include "solver/cfr.hpp"

#include <vector>

namespace poker::solver
{

double best_response_p1_utility(const std::vector<double>& opponent_and_self_avg);
double best_response_p2_utility(const std::vector<double>& opponent_and_self_avg);

// Nash gap = u1(BR1, σ2) + u2(σ1, BR2). Zero at Nash. This is NashConv, not NashConv/2.
double nash_gap(const std::vector<double>& average_strategy);

SolveStats evaluate_average_strategy(const std::vector<double>& average_strategy);

} // namespace poker::solver
