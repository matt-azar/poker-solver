#pragma once

#include "solver/payoff.hpp"
#include "solver/rake.hpp"

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
// Under the zero-rake chip rule, utility[1] == -utility[0]. With positive rake,
// the house takes collect(pot, rake) from the pot; the winner's root-centered
// utility is reduced by that amount (split evenly on a tie). See docs/RAKE.md.
struct ChipPayoff
{
    static PlayerPayoff terminal(
        int initial_pot,
        int contrib0,
        int contrib1,
        int folded,
        int showdown,
        const RakeConfig& rake = {})
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
        rake.validate();

        const double half_pot = static_cast<double>(initial_pot) * 0.5;
        PlayerPayoff payoff;
        bool player0_wins = false;
        bool player1_wins = false;
        if (folded == 0)
        {
            payoff.utility[0] = -(half_pot + static_cast<double>(contrib0));
            player1_wins = true;
        }
        else if (folded == 1)
        {
            payoff.utility[0] = half_pot + static_cast<double>(contrib1);
            player0_wins = true;
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
                player0_wins = true;
            }
            else if (showdown < 0)
            {
                payoff.utility[0] = -(half_pot + static_cast<double>(contrib0));
                player1_wins = true;
            }
            else
            {
                payoff.utility[0] = 0.0;
            }
        }
        payoff.utility[1] = -payoff.utility[0];

        const double pot_chips =
            static_cast<double>(initial_pot) + static_cast<double>(contrib0)
            + static_cast<double>(contrib1);
        const double taken = collect(pot_chips, rake);
        if (taken == 0.0)
        {
            return payoff;
        }
        if (player0_wins)
        {
            payoff.utility[0] -= taken;
        }
        else if (player1_wins)
        {
            payoff.utility[1] -= taken;
        }
        else
        {
            const double half_rake = taken * 0.5;
            payoff.utility[0] -= half_rake;
            payoff.utility[1] -= half_rake;
        }
        return payoff;
    }
};

} // namespace poker::solver
