#pragma once

#include <cmath>
#include <stdexcept>

namespace poker::solver
{

// DCFR(α, β, γ) from Brown & Sandholm, AAAI 2019.
// Defaults are the fixed product triple (1.5, 0, 2).
struct DcfrParams
{
    double alpha = 1.5;
    double beta = 0.0;
    double gamma = 2.0;
};

struct DcfrFactors
{
    double positive_discount = 1.0;
    double negative_discount = 0.5;
    double average_weight = 1.0;
};

// t is the completed-iteration index after the increment (1, 2, ...).
// positive: t^α/(t^α+1); negative: t^β/(t^β+1); average weight: t^γ.
// With β=0, negative discount is exactly 1/2.
inline DcfrFactors dcfr_factors(int iteration, DcfrParams params = {})
{
    if (iteration <= 0)
    {
        throw std::invalid_argument("DCFR iteration index must be positive");
    }
    if (!std::isfinite(params.alpha) || !std::isfinite(params.beta) || !std::isfinite(params.gamma))
    {
        throw std::invalid_argument("DCFR parameters must be finite");
    }
    const double t = static_cast<double>(iteration);
    const double t_pos = std::pow(t, params.alpha);
    const double t_neg = std::pow(t, params.beta);
    DcfrFactors factors;
    factors.positive_discount = t_pos / (t_pos + 1.0);
    factors.negative_discount = t_neg / (t_neg + 1.0);
    factors.average_weight = std::pow(t, params.gamma);
    return factors;
}

// Classify the sign of u = old_regret + pass_delta after the increment.
// Keep negative regrets signed; do not floor.
inline double dcfr_discounted_regret(
    double old_regret,
    double pass_delta,
    double positive_discount,
    double negative_discount)
{
    const double u = old_regret + pass_delta;
    return u > 0.0 ? u * positive_discount : u * negative_discount;
}

// When the pass already wrote increments into the regret table, discount the
// post-pass value in place (do not add the increment a second time).
inline double dcfr_discount_post_pass(
    double post_pass_regret,
    double positive_discount,
    double negative_discount)
{
    return post_pass_regret > 0.0
        ? post_pass_regret * positive_discount
        : post_pass_regret * negative_discount;
}

} // namespace poker::solver
