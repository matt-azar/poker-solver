#include "solver/regret_matching.hpp"

namespace poker::solver
{
namespace
{

template <typename In, typename Out>
void regret_matching_impl(const In* regrets, Out* current, int n)
{
    double normalizing = 0.0;
    for (int a = 0; a < n; ++a)
    {
        const double value = static_cast<double>(regrets[a]);
        const double positive = value > 0.0 ? value : 0.0;
        current[a] = static_cast<Out>(positive);
        normalizing += positive;
    }
    if (normalizing > 0.0)
    {
        for (int a = 0; a < n; ++a)
        {
            current[a] = static_cast<Out>(static_cast<double>(current[a]) / normalizing);
        }
        return;
    }
    const double uniform = 1.0 / static_cast<double>(n);
    for (int a = 0; a < n; ++a)
    {
        current[a] = static_cast<Out>(uniform);
    }
}

} // namespace

void regret_matching(const double* regrets, double* current, int n)
{
    regret_matching_impl(regrets, current, n);
}

void regret_matching(const float* regrets, float* current, int n)
{
    regret_matching_impl(regrets, current, n);
}

void regret_matching(const double* regrets, float* current, int n)
{
    regret_matching_impl(regrets, current, n);
}

void accumulate_average(double* strategy_sum, const double* current, int n, double reach_i)
{
    for (int a = 0; a < n; ++a)
    {
        strategy_sum[a] += reach_i * current[a];
    }
}

void accumulate_average(float* strategy_sum, const float* current, int n, double reach_i)
{
    for (int a = 0; a < n; ++a)
    {
        strategy_sum[a] = static_cast<float>(
            static_cast<double>(strategy_sum[a]) + reach_i * static_cast<double>(current[a]));
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

void normalize_average(const float* strategy_sum, float* out, int n)
{
    double total = 0.0;
    for (int a = 0; a < n; ++a)
    {
        total += static_cast<double>(strategy_sum[a]);
    }
    if (total > 0.0)
    {
        for (int a = 0; a < n; ++a)
        {
            out[a] = static_cast<float>(static_cast<double>(strategy_sum[a]) / total);
        }
        return;
    }
    const double uniform = 1.0 / static_cast<double>(n);
    for (int a = 0; a < n; ++a)
    {
        out[a] = static_cast<float>(uniform);
    }
}

} // namespace poker::solver
