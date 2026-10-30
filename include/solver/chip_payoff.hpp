#pragma once

#include "solver/payoff.hpp"

#include <stdexcept>

namespace poker::solver
{

// Heads-up chip terminal payoffs matching docs/RIVER.md and docs/STREETS.md.
//
// initial_pot is dead money contributed equally before this tree. contrib[i] is
// player i's investment on the streets in this tree. folded is -1 at showdown,
// otherwise the player who folded. showdown is >0 when player 0 wins, <0 when
// player 0 loses, and 0 on a tie; it is ignored on a fold.
//
// Under this chip rule, utility[1] == -utility[0].
struct ChipPayoff
{
    static PlayerPayoff terminal(
        int initial_pot,
        int contrib0,
        int contrib1,
        int folded,
        int showdown)
    {
        if (initial_pot <= 0)
        {
            throw std::invalid_argument("chip payoff pot must be positive");
        }
        if (contrib0 < 0 || contrib1 < 0)
        {
            throw std::invalid_argument("chip payoff contributions must be nonnegative");
        }
        if (folded != -1 && folded != 0 && folded != 1)
        {
            throw std::invalid_argument("chip payoff folded must be -1, 0, or 1");
        }

        const double half_pot = static_cast<double>(initial_pot) * 0.5;
        PlayerPayoff payoff;
        if (folded == 0)
        {
            payoff.utility[0] = -(half_pot + static_cast<double>(contrib0));
        }
        else if (folded == 1)
        {
            payoff.utility[0] = half_pot + static_cast<double>(contrib1);
        }
        else
        {
            if (contrib0 != contrib1)
            {
                throw std::logic_error("showdown with unequal street contributions");
            }
            if (showdown > 0)
            {
                payoff.utility[0] = half_pot + static_cast<double>(contrib1);
            }
            else if (showdown < 0)
            {
                payoff.utility[0] = -(half_pot + static_cast<double>(contrib0));
            }
            else
            {
                payoff.utility[0] = 0.0;
            }
        }
        payoff.utility[1] = -payoff.utility[0];
        return payoff;
    }
};

} // namespace poker::solver
