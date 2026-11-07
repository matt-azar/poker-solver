#pragma once

#include "game/chips.hpp"
#include "poker/range.hpp"
#include "solver/chip_payoff.hpp"
#include "solver/icm.hpp"
#include "solver/incentives.hpp"

#include <array>
#include <vector>

namespace poker::river
{

// Heads-up no-limit river. The board is fixed. Chance deals one ordered pair of
// private hands from the joint range distribution in docs/HOLDEM.md.
//
// Player 0 is out of position. Player 1 is in position. Utilities are player 0's
// net chips from the start of the river. The existing pot was contributed equally,
// so a showdown win is worth pot/2 plus the opponent's river investment. Uncalled
// chips are not profit: a fold refunds them through that same formula.
//
// An opening size f bets round(f * pot) tenths (0.1-chip units). A raise size f
// raises by round(f * pot_after_the_call) tenths, where pot_after_the_call is
// the pot once the facing bet has been called. Ties in rounding go away from
// zero. A listed size larger than the stack is an all-in when all-ins are
// allowed, and is omitted otherwise. Equal amounts are one action.
//
// The minimum opening bet is 0.1 chip. Later raises must increase the commitment
// by at least the previous full bet or raise. Heads-up equal stacks cannot raise
// an opponent who is already all-in. Both players start this street with the
// same stack behind. pot / stack / contrib are tenths; utilities report chips.

inline constexpr int kMaxRiverActions = 8;
inline constexpr int kMaxHistory = 12;

struct RiverConfig
{
    std::array<int, 5> board{};
    // pot / stack are tenths of a chip (chip_units(100) == 100.0 chips).
    int pot = chip_units(100);
    int stack = chip_units(200);
    holdem::Range oop{};
    holdem::Range ip{};
    std::vector<double> oop_bet_sizes{};
    std::vector<double> ip_bet_sizes{};
    std::vector<double> oop_raise_sizes{};
    std::vector<double> ip_raise_sizes{};
    bool allow_all_in = true;
    int max_raises = 2;
    int first_to_act = 0;
    // Pot rake applied at terminals. Zero rate keeps the prior chip rule.
    // See docs/auxiliary/payoffs/RAKE.md.
    poker::solver::RakeConfig rake{};
    // Optional tournament ICM. Empty stacks leaves chip/rake terminals.
    // stacks[] are tournament chip counts (not betting `stack`). See docs/auxiliary/payoffs/ICM.md.
    poker::solver::IcmConfig icm{};
    // Optional action-label incentive overlay. Empty rules leave terminals
    // unchanged. Path-attributed at terminals; see docs/auxiliary/payoffs/INCENTIVES.md.
    poker::solver::IncentiveConfig incentives{};
};

} // namespace poker::river
