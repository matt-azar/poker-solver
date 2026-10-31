#pragma once

#include "solver/payoff.hpp"

#include <cmath>
#include <cstddef>
#include <span>
#include <stdexcept>
#include <vector>

namespace poker::solver
{

// Classic Malmuth-Harville (recursive) ICM.
//
// For stacks s[0..n) and place prizes p[0], p[1], ... (1st, 2nd, ...):
//   P(i finishes 1st) = s[i] / sum(s)
//   Conditionally remove i and recurse on the remaining stacks for places 2..n
//   with prizes p[1], p[2], ...
// Unpaid places (when p is shorter than n) contribute 0. Players with a zero
// stack are treated as already eliminated and receive no share of remaining
// prizes. See docs/ICM.md.
//
// Rejects empty stacks, negative or non-finite stacks/payouts, and a total
// stack of zero.
inline void validate_icm_inputs(
    std::span<const double> stacks,
    std::span<const double> payouts)
{
    if (stacks.empty())
    {
        throw std::invalid_argument("icm stacks must be non-empty");
    }
    double total = 0.0;
    for (double s : stacks)
    {
        if (!(s >= 0.0) || !std::isfinite(s))
        {
            throw std::invalid_argument("icm stacks must be finite and nonnegative");
        }
        total += s;
    }
    if (!(total > 0.0))
    {
        throw std::invalid_argument("icm total stack must be positive");
    }
    for (double prize : payouts)
    {
        if (!(prize >= 0.0) || !std::isfinite(prize))
        {
            throw std::invalid_argument("icm payouts must be finite and nonnegative");
        }
    }
}

namespace detail
{

inline void icm_recurse(
    std::vector<double>& stacks,
    std::size_t alive,
    std::span<const double> payouts,
    std::size_t place,
    double weight,
    std::vector<double>& equities)
{
    if (!(weight > 0.0) || alive == 0)
    {
        return;
    }

    double total = 0.0;
    for (double s : stacks)
    {
        total += s;
    }
    if (!(total > 0.0))
    {
        return;
    }

    if (alive == 1)
    {
        double remaining = 0.0;
        for (std::size_t k = place; k < payouts.size(); ++k)
        {
            remaining += payouts[k];
        }
        if (remaining == 0.0)
        {
            return;
        }
        for (std::size_t i = 0; i < stacks.size(); ++i)
        {
            if (stacks[i] > 0.0)
            {
                equities[i] += weight * remaining;
                return;
            }
        }
        return;
    }

    const double prize = place < payouts.size() ? payouts[place] : 0.0;
    for (std::size_t i = 0; i < stacks.size(); ++i)
    {
        const double s = stacks[i];
        if (!(s > 0.0))
        {
            continue;
        }
        const double p_first = s / total;
        if (prize != 0.0)
        {
            equities[i] += weight * p_first * prize;
        }
        stacks[i] = 0.0;
        icm_recurse(stacks, alive - 1, payouts, place + 1, weight * p_first, equities);
        stacks[i] = s;
    }
}

} // namespace detail

inline std::vector<double> icm_equities(
    std::span<const double> stacks,
    std::span<const double> payouts)
{
    validate_icm_inputs(stacks, payouts);

    std::vector<double> work(stacks.begin(), stacks.end());
    std::vector<double> equities(stacks.size(), 0.0);
    std::size_t alive = 0;
    for (double s : work)
    {
        if (s > 0.0)
        {
            ++alive;
        }
    }
    detail::icm_recurse(work, alive, payouts, 0, 1.0, equities);
    return equities;
}

// Map a heads-up chip terminal onto ICM equity deltas.
//
// `stacks` are chip counts immediately before applying the chip outcome
// (index 0 / 1 are the two hero players; any further seats are untouched
// spectators still in the tournament). `chip_terminal.utility[i]` is added to
// `stacks[i]` for i in {0,1}. The returned PlayerPayoff is
//   equity(post)[i] - equity(pre)[i]
// for those two players — not chip EV. ChipPayoff / zero-ICM mode stays separate.
struct IcmPayoff
{
    static PlayerPayoff from_chip_terminal(
        std::span<const double> stacks,
        std::span<const double> payouts,
        const PlayerPayoff& chip_terminal)
    {
        if (stacks.size() < 2)
        {
            throw std::invalid_argument("icm chip terminal needs at least two stacks");
        }
        validate_icm_inputs(stacks, payouts);
        if (!std::isfinite(chip_terminal.utility[0])
            || !std::isfinite(chip_terminal.utility[1]))
        {
            throw std::invalid_argument("icm chip terminal utilities must be finite");
        }

        std::vector<double> post(stacks.begin(), stacks.end());
        post[0] += chip_terminal.utility[0];
        post[1] += chip_terminal.utility[1];
        if (!(post[0] >= 0.0) || !(post[1] >= 0.0))
        {
            throw std::invalid_argument("icm post-terminal stacks must be nonnegative");
        }
        // Rake (or bust) may leave a zero total; treat as all remaining equity 0.
        double post_total = 0.0;
        for (double s : post)
        {
            post_total += s;
        }

        const std::vector<double> pre_eq = icm_equities(stacks, payouts);
        std::vector<double> post_eq(stacks.size(), 0.0);
        if (post_total > 0.0)
        {
            post_eq = icm_equities(post, payouts);
        }

        PlayerPayoff out;
        out.utility[0] = post_eq[0] - pre_eq[0];
        out.utility[1] = post_eq[1] - pre_eq[1];
        return out;
    }
};

} // namespace poker::solver
