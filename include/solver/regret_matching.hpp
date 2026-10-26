#pragma once

namespace poker::solver
{

// Fills current[0..n) from regrets using regret matching.
// If the sum of positive regrets is zero, uses a uniform strategy.
void regret_matching(const double* regrets, double* current, int n);

// Adds reach_i * current[a] into strategy_sum[a] for each action.
void accumulate_average(double* strategy_sum, const double* current, int n, double reach_i);

// Normalizes strategy_sum into out. Uniform if the sum is zero.
void normalize_average(const double* strategy_sum, double* out, int n);

} // namespace poker::solver
