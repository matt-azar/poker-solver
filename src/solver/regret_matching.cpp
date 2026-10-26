#include "solver/regret_matching.hpp"

namespace poker::solver
{

void regret_matching(const double* regrets, double* current, int n)
{
    double normalizing = 0.0;
    for (int a = 0; a < n; ++a)
    {
        const double positive = regrets[a] > 0.0 ? regrets[a] : 0.0;
        current[a] = positive;
        normalizing += positive;
    }
    if (normalizing > 0.0)
    {
        for (int a = 0; a < n; ++a)
        {
            current[a] /= normalizing;
        }
        return;
    }
    const double uniform = 1.0 / static_cast<double>(n);
    for (int a = 0; a < n; ++a)
    {
        current[a] = uniform;
    }
}

void accumulate_average(double* strategy_sum, const double* current, int n, double reach_i)
{
    for (int a = 0; a < n; ++a)
    {
        strategy_sum[a] += reach_i * current[a];
    }
}

void normalize_average(const double* strategy_sum, double* out, int n)
{
    double total = 0.0;
    for (int a = 0; a < n; ++a)
    {
        total += strategy_sum[a];
    }
    if (total > 0.0)
    {
        for (int a = 0; a < n; ++a)
        {
            out[a] = strategy_sum[a] / total;
        }
        return;
    }
    const double uniform = 1.0 / static_cast<double>(n);
    for (int a = 0; a < n; ++a)
    {
        out[a] = uniform;
    }
}

} // namespace poker::solver
