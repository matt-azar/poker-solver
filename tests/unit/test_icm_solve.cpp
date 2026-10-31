#include "harness.hpp"

#include "game/river_config_text.hpp"
#include "game/river_game.hpp"
#include "game/street_config_text.hpp"
#include "game/street_game.hpp"
#include "poker/card.hpp"
#include "poker/range.hpp"
#include "solver/chip_payoff.hpp"
#include "solver/icm.hpp"
#include "solver/river_batch.hpp"
#include "solver/street_batch.hpp"
#include "solver/trainer.hpp"

#include <stdexcept>
#include <string>
#include <vector>

using poker::holdem::Range;
using poker::river::RiverConfig;
using poker::river::RiverGame;
using poker::solver::ChipPayoff;
using poker::solver::IcmConfig;
using poker::solver::IcmPayoff;
using poker::solver::PlayerPayoff;
using poker::solver::RiverBatchSolver;
using poker::solver::StreetBatchSolver;
using poker::streets::StreetConfig;
using poker::streets::StreetGame;

namespace
{

int card(const char* text)
{
    return poker::holdem::parse_card(text);
}

void set_board(RiverConfig& config)
{
    const char* names[] = {"Ah", "Kd", "7c", "4s", "2h"};
    for (int i = 0; i < 5; ++i)
    {
        config.board[static_cast<std::size_t>(i)] = card(names[i]);
    }
}

int find_street_action(const StreetGame& game, const StreetGame::State& state, const char* label)
{
    const int infoset = game.infoset(state);
    const int count = game.action_count(infoset);
    for (int action = 0; action < count; ++action)
    {
        if (game.action_label(infoset, action) == label)
        {
            return action;
        }
    }
    return -1;
}

IcmConfig hu_wta(double s0, double s1, double prize)
{
    IcmConfig icm;
    icm.stacks = {s0, s1};
    icm.payouts = {prize};
    return icm;
}

} // namespace

void run_icm_solve_tests()
{
    // Empty ICM on StreetGame fold matches the plain chip terminal bit-for-bit.
    {
        StreetConfig cfg;
        cfg.board = {card("Ah"), card("Kd"), card("7c"), card("4s")};
        cfg.pot = 100;
        cfg.stack = 200;
        cfg.oop = Range::parse("AcAd");
        cfg.ip = Range::parse("KsKc");
        cfg.oop_bet_sizes = {1.0};
        cfg.allow_all_in = false;
        cfg.max_raises = 1;
        const StreetGame game(cfg);
        StreetGame::State state = game.child_chance(game.root(), 0);
        state = game.child_action(state, find_street_action(game, state, "Bet 100"));
        state = game.child_action(state, find_street_action(game, state, "Fold"));
        const PlayerPayoff paid = game.terminal_payoff(state);
        const PlayerPayoff chips = ChipPayoff::terminal(100, 100, 0, 1, 0);
        CHECK(paid.utility[0] == chips.utility[0]);
        CHECK(paid.utility[1] == chips.utility[1]);
        CHECK_NEAR(paid.utility[0], 50.0, 1e-12);
    }

    // StreetGame fold under HU WTA matches the ICM.md pin:
    // chip (50, -50) on stacks 1000/1000, prize 100 → ICM (+2.5, -2.5).
    // Betting stack 200 keeps pot/2+stack = 250 under the tournament stacks.
    {
        StreetConfig cfg;
        cfg.board = {card("Ah"), card("Kd"), card("7c"), card("4s")};
        cfg.pot = 100;
        cfg.stack = 200;
        cfg.oop = Range::parse("AcAd");
        cfg.ip = Range::parse("KsKc");
        cfg.oop_bet_sizes = {1.0};
        cfg.allow_all_in = false;
        cfg.max_raises = 1;
        cfg.icm = hu_wta(1000.0, 1000.0, 100.0);
        const StreetGame game(cfg);
        StreetGame::State state = game.child_chance(game.root(), 0);
        state = game.child_action(state, find_street_action(game, state, "Bet 100"));
        state = game.child_action(state, find_street_action(game, state, "Fold"));
        const PlayerPayoff paid = game.terminal_payoff(state);
        CHECK_NEAR(paid.utility[0], 2.5, 1e-12);
        CHECK_NEAR(paid.utility[1], -2.5, 1e-12);
        CHECK_NEAR(game.p1_utility(state), 2.5, 1e-12);
    }

    // Config text round-trip keeps ICM fields; empty ICM omits the lines.
    {
        StreetConfig street;
        street.board = {card("Ah"), card("Kd"), card("7c"), card("4s")};
        street.pot = 100;
        street.stack = 200;
        street.oop = Range::parse("AcAd");
        street.ip = Range::parse("KsKc");
        const std::string plain = poker::streets::format_street_config(street);
        CHECK(plain.find("icm-stacks") == std::string::npos);
        CHECK(plain.find("icm-payouts") == std::string::npos);

        street.icm = hu_wta(5000.0, 3000.0, 100.0);
        street.icm.payouts = {50.0, 30.0, 20.0};
        street.icm.stacks = {5000.0, 3000.0, 2000.0};
        const std::string text = poker::streets::format_street_config(street);
        CHECK(text.find("icm-stacks 5000 3000 2000\n") != std::string::npos);
        CHECK(text.find("icm-payouts 50 30 20\n") != std::string::npos);
        const StreetConfig parsed = poker::streets::parse_street_config(text);
        CHECK(parsed.icm.stacks.size() == 3);
        CHECK(parsed.icm.payouts.size() == 3);
        CHECK_NEAR(parsed.icm.stacks[0], 5000.0, 1e-12);
        CHECK_NEAR(parsed.icm.payouts[2], 20.0, 1e-12);
        CHECK(poker::streets::format_street_config(parsed) == text);
    }
    {
        RiverConfig river;
        set_board(river);
        river.pot = 100;
        river.stack = 200;
        river.oop = Range::parse("AcAd");
        river.ip = Range::parse("KsKc");
        river.icm = hu_wta(1000.0, 1000.0, 100.0);
        const std::string text = poker::river::format_river_config(river);
        CHECK(text.find("icm-stacks 1000 1000\n") != std::string::npos);
        CHECK(text.find("icm-payouts 100\n") != std::string::npos);
        const RiverConfig parsed = poker::river::parse_river_config(text);
        CHECK(parsed.icm.enabled());
        CHECK_NEAR(parsed.icm.stacks[1], 1000.0, 1e-12);
        CHECK_NEAR(parsed.icm.payouts[0], 100.0, 1e-12);
    }

    // Bad stacks / payouts rejected at game validate.
    {
        bool threw = false;
        try
        {
            StreetConfig bad;
            bad.board = {card("Ah"), card("Kd"), card("7c"), card("4s")};
            bad.pot = 100;
            bad.stack = 100;
            bad.oop = Range::parse("AcAd");
            bad.ip = Range::parse("KsKc");
            // Worst loss is pot/2 + stack = 150; stacks of 40 are too small.
            bad.icm = hu_wta(40.0, 40.0, 100.0);
            StreetGame game(bad);
            (void)game;
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
            RiverConfig bad;
            set_board(bad);
            bad.pot = 100;
            bad.stack = 100;
            bad.oop = Range::parse("AcAd");
            bad.ip = Range::parse("KsKc");
            bad.icm.stacks = {1000.0}; // need at least two seats
            bad.icm.payouts = {100.0};
            RiverGame game(bad);
            (void)game;
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
            RiverConfig bad;
            set_board(bad);
            bad.pot = 100;
            bad.stack = 100;
            bad.oop = Range::parse("AcAd");
            bad.ip = Range::parse("KsKc");
            bad.icm.stacks = {1000.0, 1000.0};
            bad.icm.payouts = {-1.0};
            RiverGame game(bad);
            (void)game;
        }
        catch (const std::invalid_argument&)
        {
            threw = true;
        }
        CHECK(threw);
    }

    // Empty-ICM RiverBatch check-down stays at the prior chip pin (+50).
    {
        RiverConfig zero;
        set_board(zero);
        zero.pot = 100;
        zero.stack = 100;
        zero.oop = Range::parse("AcAd");
        zero.ip = Range::parse("KsKc");
        zero.allow_all_in = false;
        zero.max_raises = 0;
        RiverBatchSolver batch(zero);
        poker::solver::SolveConfig solve;
        solve.max_iterations = 1;
        const poker::solver::SolveStats stats =
            batch.solve(solve, poker::solver::Algorithm::CfrPlus);
        CHECK_NEAR(stats.p1_expected_utility, 50.0, 1e-9);
        CHECK(stats.p1_expected_utility == batch.expected_utility());
    }

    // HU WTA RiverBatch check-down: chip EV +50 → ICM +2.5
    // (stacks 1000/1000, prize 100; post 1050/950 → equity 52.5/47.5).
    {
        RiverConfig icm_cfg;
        set_board(icm_cfg);
        icm_cfg.pot = 100;
        icm_cfg.stack = 100;
        icm_cfg.oop = Range::parse("AcAd");
        icm_cfg.ip = Range::parse("KsKc");
        icm_cfg.allow_all_in = false;
        icm_cfg.max_raises = 0;
        icm_cfg.icm = hu_wta(1000.0, 1000.0, 100.0);
        RiverBatchSolver batch(icm_cfg);
        poker::solver::SolveConfig solve;
        solve.max_iterations = 1;
        const poker::solver::SolveStats stats =
            batch.solve(solve, poker::solver::Algorithm::CfrPlus);
        CHECK_NEAR(stats.p1_expected_utility, 2.5, 1e-9);
        CHECK_NEAR(batch.expected_utility(), 2.5, 1e-9);

        PlayerPayoff chips;
        chips.utility[0] = 50.0;
        chips.utility[1] = -50.0;
        const PlayerPayoff delta = IcmPayoff::from_chip_terminal(
            icm_cfg.icm.stacks, icm_cfg.icm.payouts, chips);
        CHECK_NEAR(delta.utility[0], 2.5, 1e-12);
    }

    // HU WTA StreetBatch five-card check-down matches the river pin.
    {
        StreetConfig icm_cfg;
        icm_cfg.board = {
            card("Ah"), card("Kd"), card("7c"), card("4s"), card("2h")};
        icm_cfg.pot = 100;
        icm_cfg.stack = 100;
        icm_cfg.oop = Range::parse("AcAd");
        icm_cfg.ip = Range::parse("KsKc");
        icm_cfg.allow_all_in = false;
        icm_cfg.max_raises = 0;
        icm_cfg.icm = hu_wta(1000.0, 1000.0, 100.0);
        icm_cfg.memory_mib = 64;
        StreetBatchSolver batch(icm_cfg);
        poker::solver::SolveConfig solve;
        solve.max_iterations = 1;
        const poker::solver::SolveStats stats =
            batch.solve(solve, poker::solver::Algorithm::CfrPlus);
        CHECK_NEAR(stats.p1_expected_utility, 2.5, 1e-9);
    }
}
