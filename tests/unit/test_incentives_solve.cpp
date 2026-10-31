#include "harness.hpp"

#include "game/river_config_text.hpp"
#include "game/river_game.hpp"
#include "game/street_config_text.hpp"
#include "game/street_game.hpp"
#include "poker/card.hpp"
#include "poker/range.hpp"
#include "solver/chip_payoff.hpp"
#include "solver/incentives.hpp"
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
using poker::solver::IncentiveKind;
using poker::solver::IncentiveRule;
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

int find_river_action(const RiverGame& game, const RiverGame::State& state, const char* label)
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

} // namespace

void run_incentives_solve_tests()
{
    // Empty incentives on StreetGame fold match plain chip terminals bit-for-bit.
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

    // OOP fold incentive (+3.5 on compact "f") adds to player-0 utility after
    // IP folds — path attribution, not mid-tree CategoryTag.
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
        cfg.incentives.add(IncentiveRule{
            IncentiveKind::ActionLabelMatch, "f", 1, 3.5});
        // IP folds: player 1 takes "f". Rule targets player 1 → utility[1] += 3.5.
        // Player-0 chip utility stays 50; CFR scalar is utility[0].
        const StreetGame game(cfg);
        StreetGame::State state = game.child_chance(game.root(), 0);
        state = game.child_action(state, find_street_action(game, state, "Bet 100"));
        state = game.child_action(state, find_street_action(game, state, "Fold"));
        const PlayerPayoff paid = game.terminal_payoff(state);
        CHECK_NEAR(paid.utility[0], 50.0, 1e-12);
        CHECK_NEAR(paid.utility[1], -50.0 + 3.5, 1e-12);
    }

    // OOP bet incentive on player 0 changes the p0 scalar used by CFR.
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
        cfg.incentives.add(IncentiveRule{
            IncentiveKind::ActionLabelMatch, "b100", 0, 4.0});
        const StreetGame game(cfg);
        StreetGame::State state = game.child_chance(game.root(), 0);
        state = game.child_action(state, find_street_action(game, state, "Bet 100"));
        state = game.child_action(state, find_street_action(game, state, "Fold"));
        const PlayerPayoff paid = game.terminal_payoff(state);
        CHECK_NEAR(paid.utility[0], 54.0, 1e-12);
        CHECK_NEAR(paid.utility[1], -50.0, 1e-12);
        CHECK_NEAR(game.p1_utility(state), 54.0, 1e-12);
    }

    // Display chip labels also match ActionLabelMatch keys.
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
        cfg.incentives.add(IncentiveRule{
            IncentiveKind::ActionLabelMatch, "Bet 100", 0, 2.0});
        const StreetGame game(cfg);
        StreetGame::State state = game.child_chance(game.root(), 0);
        state = game.child_action(state, find_street_action(game, state, "Bet 100"));
        state = game.child_action(state, find_street_action(game, state, "Fold"));
        CHECK_NEAR(game.terminal_payoff(state).utility[0], 52.0, 1e-12);
    }

    // Config text round-trip keeps incentive lines; empty omits them.
    {
        StreetConfig street;
        street.board = {card("Ah"), card("Kd"), card("7c"), card("4s")};
        street.pot = 100;
        street.stack = 200;
        street.oop = Range::parse("AcAd");
        street.ip = Range::parse("KsKc");
        const std::string plain = poker::streets::format_street_config(street);
        CHECK(plain.find("incentive") == std::string::npos);

        street.incentives.add(IncentiveRule{
            IncentiveKind::ActionLabelMatch, "b100", 0, 3.5});
        street.incentives.add(IncentiveRule{
            IncentiveKind::CategoryTag, "bluff", 1, -2.0});
        const std::string text = poker::streets::format_street_config(street);
        CHECK(text.find("incentive label 0 b100 3.5\n") != std::string::npos);
        CHECK(text.find("incentive tag 1 bluff -2\n") != std::string::npos);
        const StreetConfig parsed = poker::streets::parse_street_config(text);
        CHECK(parsed.incentives.rules.size() == 2);
        CHECK(parsed.incentives.rules[0].kind == IncentiveKind::ActionLabelMatch);
        CHECK(parsed.incentives.rules[0].key == "b100");
        CHECK_NEAR(parsed.incentives.rules[0].delta, 3.5, 1e-12);
        CHECK(parsed.incentives.rules[1].kind == IncentiveKind::CategoryTag);
        CHECK(poker::streets::format_street_config(parsed) == text);
    }
    {
        RiverConfig river;
        set_board(river);
        river.pot = 100;
        river.stack = 200;
        river.oop = Range::parse("AcAd");
        river.ip = Range::parse("KsKc");
        river.incentives.add(IncentiveRule{
            IncentiveKind::ActionLabelMatch, "c", 0, 1.25});
        const std::string text = poker::river::format_river_config(river);
        CHECK(text.find("incentive label 0 c 1.25\n") != std::string::npos);
        const RiverConfig parsed = poker::river::parse_river_config(text);
        CHECK(parsed.incentives.enabled());
        CHECK_NEAR(parsed.incentives.rules[0].delta, 1.25, 1e-12);
    }

    // Bad incentive player rejected at game validate.
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
            bad.incentives.add(IncentiveRule{
                IncentiveKind::ActionLabelMatch, "c", 2, 1.0});
            StreetGame game(bad);
            (void)game;
        }
        catch (const std::invalid_argument&)
        {
            threw = true;
        }
        CHECK(threw);
    }

    // Empty-incentive RiverBatch check-down stays at the prior chip pin (+50).
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
    }

    // RiverBatch: check incentive on player 0 shifts check-down EV by +delta*2
    // (both seats check once on the check-down path).
    {
        RiverConfig cfg;
        set_board(cfg);
        cfg.pot = 100;
        cfg.stack = 100;
        cfg.oop = Range::parse("AcAd");
        cfg.ip = Range::parse("KsKc");
        cfg.allow_all_in = false;
        cfg.max_raises = 0;
        cfg.incentives.add(IncentiveRule{
            IncentiveKind::ActionLabelMatch, "c", 0, 1.0});
        // Only OOP's check matches player 0; IP check is player 1 — ignored for u0.
        RiverBatchSolver batch(cfg);
        poker::solver::SolveConfig solve;
        solve.max_iterations = 1;
        const poker::solver::SolveStats stats =
            batch.solve(solve, poker::solver::Algorithm::CfrPlus);
        CHECK_NEAR(stats.p1_expected_utility, 51.0, 1e-9);
        CHECK_NEAR(batch.expected_utility(), 51.0, 1e-9);
    }

    // RiverGame check-down with the same rule matches the batch pin.
    {
        RiverConfig cfg;
        set_board(cfg);
        cfg.pot = 100;
        cfg.stack = 100;
        cfg.oop = Range::parse("AcAd");
        cfg.ip = Range::parse("KsKc");
        cfg.allow_all_in = false;
        cfg.max_raises = 0;
        cfg.incentives.add(IncentiveRule{
            IncentiveKind::ActionLabelMatch, "c", 0, 1.0});
        const RiverGame game(cfg);
        RiverGame::State state = game.child_chance(game.root(), 0);
        state = game.child_action(state, find_river_action(game, state, "Check"));
        state = game.child_action(state, find_river_action(game, state, "Check"));
        CHECK_NEAR(game.terminal_payoff(state).utility[0], 51.0, 1e-12);
    }

    // StreetBatch five-card check-down with empty incentives stays at +50.
    {
        StreetConfig cfg;
        cfg.board = {
            card("Ah"), card("Kd"), card("7c"), card("4s"), card("2h")};
        cfg.pot = 100;
        cfg.stack = 100;
        cfg.oop = Range::parse("AcAd");
        cfg.ip = Range::parse("KsKc");
        cfg.allow_all_in = false;
        cfg.max_raises = 0;
        cfg.memory_mib = 64;
        StreetBatchSolver batch(cfg);
        poker::solver::SolveConfig solve;
        solve.max_iterations = 1;
        const poker::solver::SolveStats stats =
            batch.solve(solve, poker::solver::Algorithm::CfrPlus);
        CHECK_NEAR(stats.p1_expected_utility, 50.0, 1e-9);
    }

    // StreetBatch five-card check-down with OOP check +1 → +51.
    {
        StreetConfig cfg;
        cfg.board = {
            card("Ah"), card("Kd"), card("7c"), card("4s"), card("2h")};
        cfg.pot = 100;
        cfg.stack = 100;
        cfg.oop = Range::parse("AcAd");
        cfg.ip = Range::parse("KsKc");
        cfg.allow_all_in = false;
        cfg.max_raises = 0;
        cfg.memory_mib = 64;
        cfg.incentives.add(IncentiveRule{
            IncentiveKind::ActionLabelMatch, "c", 0, 1.0});
        StreetBatchSolver batch(cfg);
        poker::solver::SolveConfig solve;
        solve.max_iterations = 1;
        const poker::solver::SolveStats stats =
            batch.solve(solve, poker::solver::Algorithm::CfrPlus);
        CHECK_NEAR(stats.p1_expected_utility, 51.0, 1e-9);
    }
}
