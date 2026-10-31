#include "harness.hpp"

#include "solver/chip_payoff.hpp"
#include "solver/icm.hpp"

#include <span>
#include <stdexcept>
#include <vector>

using poker::solver::ChipPayoff;
using poker::solver::IcmPayoff;
using poker::solver::PlayerPayoff;
using poker::solver::icm_equities;
using poker::solver::validate_icm_inputs;

void run_icm_tests()
{
    // Heads-up winner-take-all: equity equals stack share of the prize.
    {
        const double stacks[] = {1000.0, 1000.0};
        const double payouts[] = {100.0, 0.0};
        const auto eq = icm_equities(stacks, payouts);
        CHECK_NEAR(eq[0], 50.0, 1e-12);
        CHECK_NEAR(eq[1], 50.0, 1e-12);
    }
    {
        const double stacks[] = {700.0, 300.0};
        const double payouts[] = {100.0};
        const auto eq = icm_equities(stacks, payouts);
        CHECK_NEAR(eq[0], 70.0, 1e-12);
        CHECK_NEAR(eq[1], 30.0, 1e-12);
    }

    // Heads-up with a second-place prize.
    // Pre: equal stacks → each gets (p1+p2)/2.
    {
        const double stacks[] = {1000.0, 1000.0};
        const double payouts[] = {70.0, 30.0};
        const auto eq = icm_equities(stacks, payouts);
        CHECK_NEAR(eq[0], 50.0, 1e-12);
        CHECK_NEAR(eq[1], 50.0, 1e-12);
    }

    // Three-player Malmuth-Harville pin (hand-computed exact fractions).
    // stacks 5000/3000/2000, payouts 50/30/20:
    //   A = 25 + 57/7 + 21/4 = 1075/28
    //   B = 15 + 9 + 4 + 19/4 = 131/4
    //   C = 202/7
    // Tolerance 1e-9 is far looser than double error on this tiny tree.
    {
        const double stacks[] = {5000.0, 3000.0, 2000.0};
        const double payouts[] = {50.0, 30.0, 20.0};
        const auto eq = icm_equities(stacks, payouts);
        CHECK_NEAR(eq[0], 1075.0 / 28.0, 1e-9);
        CHECK_NEAR(eq[1], 131.0 / 4.0, 1e-9);
        CHECK_NEAR(eq[2], 202.0 / 7.0, 1e-9);
        CHECK_NEAR(eq[0] + eq[1] + eq[2], 100.0, 1e-9);
    }

    // Zero-stack seat is already eliminated; remaining two split as HU.
    {
        const double stacks[] = {1000.0, 0.0, 1000.0};
        const double payouts[] = {80.0, 20.0};
        const auto eq = icm_equities(stacks, payouts);
        CHECK_NEAR(eq[0], 50.0, 1e-12);
        CHECK_NEAR(eq[1], 0.0, 1e-12);
        CHECK_NEAR(eq[2], 50.0, 1e-12);
    }

    // Reject bad inputs.
    {
        bool threw = false;
        try
        {
            const std::vector<double> stacks;
            const double payouts[] = {1.0};
            (void)icm_equities(std::span<const double>{stacks}, payouts);
        }
        catch (const std::invalid_argument&)
        {
            threw = true;
        }
        CHECK(threw);
    }
    {
        bool threw = false;
        try
        {
            const double stacks[] = {100.0, -1.0};
            const double payouts[] = {1.0};
            validate_icm_inputs(stacks, payouts);
        }
        catch (const std::invalid_argument&)
        {
            threw = true;
        }
        CHECK(threw);
    }
    {
        bool threw = false;
        try
        {
            const double stacks[] = {0.0, 0.0};
            const double payouts[] = {1.0};
            (void)icm_equities(stacks, payouts);
        }
        catch (const std::invalid_argument&)
        {
            threw = true;
        }
        CHECK(threw);
    }
    {
        bool threw = false;
        try
        {
            const double stacks[] = {100.0, 100.0};
            const double payouts[] = {-1.0};
            (void)icm_equities(stacks, payouts);
        }
        catch (const std::invalid_argument&)
        {
            threw = true;
        }
        CHECK(threw);
    }

    // IcmPayoff::from_chip_terminal — HU winner-take-all.
    // Pre stacks 1000/1000, prize 100. Chip delta (+100, -100):
    // post 1100/900 → equities 55/45 → delta (+5, -5).
    {
        const double stacks[] = {1000.0, 1000.0};
        const double payouts[] = {100.0, 0.0};
        PlayerPayoff chips;
        chips.utility[0] = 100.0;
        chips.utility[1] = -100.0;
        const PlayerPayoff delta = IcmPayoff::from_chip_terminal(stacks, payouts, chips);
        CHECK_NEAR(delta.utility[0], 5.0, 1e-12);
        CHECK_NEAR(delta.utility[1], -5.0, 1e-12);
    }

    // HU with second place: stacks 1000/1000, payouts 70/30, same chip swing.
    // Pre each 50; post 1100/900 → 52 / 48; delta (+2, -2).
    {
        const double stacks[] = {1000.0, 1000.0};
        const double payouts[] = {70.0, 30.0};
        PlayerPayoff chips;
        chips.utility[0] = 100.0;
        chips.utility[1] = -100.0;
        const PlayerPayoff delta = IcmPayoff::from_chip_terminal(stacks, payouts, chips);
        CHECK_NEAR(delta.utility[0], 2.0, 1e-12);
        CHECK_NEAR(delta.utility[1], -2.0, 1e-12);
    }

    // Consume a real ChipPayoff fold terminal without mutating ChipPayoff itself.
    // pot 100, contrib 100/0, IP folds → chip (50, -50).
    // stacks 1000/1000, WTA 100 → post 1050/950 → delta (+2.5, -2.5).
    {
        const PlayerPayoff chips = ChipPayoff::terminal(100, 100, 0, 1, 0);
        CHECK_NEAR(chips.utility[0], 50.0, 1e-12);
        CHECK_NEAR(chips.utility[1], -50.0, 1e-12);
        const double stacks[] = {1000.0, 1000.0};
        const double payouts[] = {100.0};
        const PlayerPayoff delta = IcmPayoff::from_chip_terminal(stacks, payouts, chips);
        CHECK_NEAR(delta.utility[0], 2.5, 1e-12);
        CHECK_NEAR(delta.utility[1], -2.5, 1e-12);
    }

    // Negative post-stack is rejected.
    {
        bool threw = false;
        try
        {
            const double stacks[] = {40.0, 40.0};
            const double payouts[] = {100.0};
            PlayerPayoff chips;
            chips.utility[0] = 50.0;
            chips.utility[1] = -50.0;
            (void)IcmPayoff::from_chip_terminal(stacks, payouts, chips);
        }
        catch (const std::invalid_argument&)
        {
            threw = true;
        }
        CHECK(threw);
    }
}
