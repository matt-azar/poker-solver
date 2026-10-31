#pragma once

#include <cmath>
#include <stdexcept>

namespace poker::solver
{

// Fixed DCFR(α=1.5, β=0, γ=2) from Brown & Sandholm, AAAI 2019.
// Factors are a function of the 1-based iteration index t only.
struct DcfrFactors
{
    double positive_discount = 1.0;
    double negative_discount = 0.5;
    double average_weight = 1.0;
};

// t is the completed-iteration index after the increment (1, 2, ...).
// average_weight is t² with conversion to floating point before squaring.
inline DcfrFactors dcfr_factors(int iteration)
{
    if (iteration <= 0)
    {
        throw std::invalid_argument("DCFR iteration index must be positive");
    }
    const double t = static_cast<double>(iteration);
    const double t_pow = std::pow(t, 1.5);
    DcfrFactors factors;
    factors.positive_discount = t_pow / (t_pow + 1.0);
    factors.negative_discount = 0.5;
    factors.average_weight = t * t;
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
