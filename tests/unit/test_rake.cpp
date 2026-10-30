#include "harness.hpp"

#include "solver/chip_payoff.hpp"
#include "solver/rake.hpp"

#include <stdexcept>

using poker::solver::ChipPayoff;
using poker::solver::PlayerPayoff;
using poker::solver::RakeConfig;
using poker::solver::collect;

namespace
{

void check_zero_sum_match(
    int pot,
    int c0,
    int c1,
    int folded,
    int showdown,
    double u0)
{
    const PlayerPayoff plain = ChipPayoff::terminal(pot, c0, c1, folded, showdown);
    const PlayerPayoff zero_rake =
        ChipPayoff::terminal(pot, c0, c1, folded, showdown, RakeConfig{});
    const RakeConfig explicit_zero{0.0, 0.0};
    const PlayerPayoff zero_rate =
        ChipPayoff::terminal(pot, c0, c1, folded, showdown, explicit_zero);

    CHECK_NEAR(plain.utility[0], u0, 1e-12);
    CHECK_NEAR(plain.utility[1], -u0, 1e-12);
    CHECK(plain.utility[0] == zero_rake.utility[0]);
    CHECK(plain.utility[1] == zero_rake.utility[1]);
    CHECK(plain.utility[0] == zero_rate.utility[0]);
    CHECK(plain.utility[1] == zero_rate.utility[1]);
}

} // namespace

void run_rake_tests()
{
    // Collection: whole-chip floor of rate * pot, then min with cap (cap 0 = none).
    {
        RakeConfig rake{0.05, 0.0};
        CHECK_NEAR(collect(200.0, rake), 10.0, 1e-12);
        CHECK_NEAR(collect(199.0, rake), 9.0, 1e-12); // floor(9.95) == 9
        CHECK_NEAR(collect(0.0, rake), 0.0, 1e-12);
        CHECK_NEAR(collect(100.0, RakeConfig{0.0, 0.0}), 0.0, 1e-12);
    }
    {
        RakeConfig capped{0.05, 5.0};
        CHECK_NEAR(collect(200.0, capped), 5.0, 1e-12);
        CHECK_NEAR(collect(80.0, capped), 4.0, 1e-12); // floor(4) < cap
    }
    {
        RakeConfig full{1.0, 0.0};
        CHECK_NEAR(collect(123.0, full), 123.0, 1e-12);
    }

    bool bad_rate = false;
    try
    {
        RakeConfig{-0.1, 0.0}.validate();
    }
    catch (const std::invalid_argument&)
    {
        bad_rate = true;
    }
    CHECK(bad_rate);

    bool bad_high = false;
    try
    {
        RakeConfig{1.1, 0.0}.validate();
    }
    catch (const std::invalid_argument&)
    {
        bad_high = true;
    }
    CHECK(bad_high);

    bool bad_cap = false;
    try
    {
        RakeConfig{0.05, -1.0}.validate();
    }
    catch (const std::invalid_argument&)
    {
        bad_cap = true;
    }
    CHECK(bad_cap);
    CHECK((!RakeConfig{0.05, -1.0}.valid()));
    CHECK((RakeConfig{}.valid()));
    CHECK((RakeConfig{0.0, 0.0}.valid()));
    CHECK((RakeConfig{1.0, 10.0}.valid()));

    bool terminal_rejects = false;
    try
    {
        (void)ChipPayoff::terminal(100, 0, 0, -1, 1, RakeConfig{2.0, 0.0});
    }
    catch (const std::invalid_argument&)
    {
        terminal_rejects = true;
    }
    CHECK(terminal_rejects);

    // Zero-rake regression pin: same numbers as today's ChipPayoff::terminal.
    check_zero_sum_match(100, 100, 0, 1, 0, 50.0);   // IP folds
    check_zero_sum_match(100, 100, 100, -1, 1, 150.0); // called win
    check_zero_sum_match(100, 100, 400, 0, 0, -150.0); // OOP folds
    check_zero_sum_match(100, 0, 0, -1, -1, -50.0);    // showdown lose
    check_zero_sum_match(100, 0, 0, -1, 0, 0.0);       // showdown tie

    // Fold win with 5% rake on pot 200: rake = 10. Winner absorbs the rake.
    {
        const RakeConfig rake{0.05, 0.0};
        const PlayerPayoff chips = ChipPayoff::terminal(100, 100, 0, 1, 0, rake);
        CHECK_NEAR(chips.utility[0], 40.0, 1e-12);  // 50 - 10
        CHECK_NEAR(chips.utility[1], -50.0, 1e-12);
        CHECK_NEAR(chips.utility[0] + chips.utility[1], -10.0, 1e-12);
    }

    // Same fold with cap 5: rake = min(10, 5) = 5.
    {
        const RakeConfig rake{0.05, 5.0};
        const PlayerPayoff chips = ChipPayoff::terminal(100, 100, 0, 1, 0, rake);
        CHECK_NEAR(chips.utility[0], 45.0, 1e-12);
        CHECK_NEAR(chips.utility[1], -50.0, 1e-12);
        CHECK_NEAR(chips.utility[0] + chips.utility[1], -5.0, 1e-12);
    }

    // Showdown win: pot 300, rate 5% → rake 15; u0 = 150 - 15.
    {
        const RakeConfig rake{0.05, 0.0};
        const PlayerPayoff chips = ChipPayoff::terminal(100, 100, 100, -1, 1, rake);
        CHECK_NEAR(chips.utility[0], 135.0, 1e-12);
        CHECK_NEAR(chips.utility[1], -150.0, 1e-12);
        CHECK_NEAR(chips.utility[0] + chips.utility[1], -15.0, 1e-12);
    }

    // Showdown lose: pot 100, rate 5% → rake 5; winner (p1) absorbs rake.
    {
        const RakeConfig rake{0.05, 0.0};
        const PlayerPayoff chips = ChipPayoff::terminal(100, 0, 0, -1, -1, rake);
        CHECK_NEAR(chips.utility[0], -50.0, 1e-12);
        CHECK_NEAR(chips.utility[1], 45.0, 1e-12);
        CHECK_NEAR(chips.utility[0] + chips.utility[1], -5.0, 1e-12);
    }

    // Showdown tie: each loses half the rake.
    {
        const RakeConfig rake{0.05, 0.0};
        const PlayerPayoff chips = ChipPayoff::terminal(100, 0, 0, -1, 0, rake);
        CHECK_NEAR(chips.utility[0], -2.5, 1e-12);
        CHECK_NEAR(chips.utility[1], -2.5, 1e-12);
        CHECK_NEAR(chips.utility[0] + chips.utility[1], -5.0, 1e-12);
    }

    // OOP folds into rake: pot 100+100+400 = 600, 5% → 30; p1 wins.
    {
        const RakeConfig rake{0.05, 0.0};
        const PlayerPayoff chips = ChipPayoff::terminal(100, 100, 400, 0, 0, rake);
        CHECK_NEAR(chips.utility[0], -150.0, 1e-12);
        CHECK_NEAR(chips.utility[1], 120.0, 1e-12); // 150 - 30
        CHECK_NEAR(chips.utility[0] + chips.utility[1], -30.0, 1e-12);
    }
}
