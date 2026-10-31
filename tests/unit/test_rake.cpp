#include "harness.hpp"

#include "game/river_config_text.hpp"
#include "game/river_game.hpp"
#include "game/street_config_text.hpp"
#include "game/street_game.hpp"
#include "poker/card.hpp"
#include "poker/range.hpp"
#include "solver/chip_payoff.hpp"
#include "solver/rake.hpp"
#include "solver/river_batch.hpp"
#include "solver/street_batch.hpp"
#include "solver/trainer.hpp"

#include <stdexcept>
#include <string>

using poker::holdem::Range;
using poker::river::RiverConfig;
using poker::river::RiverGame;
using poker::solver::ChipPayoff;
using poker::solver::PlayerPayoff;
using poker::solver::RakeConfig;
using poker::solver::RiverBatchSolver;
using poker::solver::StreetBatchSolver;
using poker::solver::collect;
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

int find_action(const RiverGame& game, const RiverGame::State& state, const std::string& label)
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

int find_deal(const RiverGame& game, int combo0, int combo1)
{
    for (int deal = 0; deal < game.deal_count(); ++deal)
    {
        int left = 0;
        int right = 0;
        game.deal_combos(deal, left, right);
        if (left == combo0 && right == combo1)
        {
            return deal;
        }
    }
    return -1;
}

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

void check_game_payoff(
    const PlayerPayoff& both,
    double p0,
    int pot,
    int c0,
    int c1,
    int folded,
    int showdown,
    const RakeConfig& rake)
{
    CHECK_NEAR(both.utility[0], p0, 1e-12);
    const PlayerPayoff chips = ChipPayoff::terminal(pot, c0, c1, folded, showdown, rake);
    CHECK(both.utility[0] == chips.utility[0]);
    CHECK(both.utility[1] == chips.utility[1]);
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

    // Street/river config text round-trip keeps rake fields.
    {
        StreetConfig street;
        street.board = {card("Ah"), card("Kd"), card("7c"), card("4s")};
        street.pot = 100;
        street.stack = 200;
        street.oop = Range::parse("AcAd");
        street.ip = Range::parse("KsKc");
        street.rake = RakeConfig{0.05, 5.0};
        const std::string text = poker::streets::format_street_config(street);
        CHECK(text.find("rake-rate 0.05\n") != std::string::npos);
        CHECK(text.find("rake-cap 5\n") != std::string::npos);
        const StreetConfig parsed = poker::streets::parse_street_config(text);
        CHECK_NEAR(parsed.rake.rate, 0.05, 1e-12);
        CHECK_NEAR(parsed.rake.cap, 5.0, 1e-12);
        CHECK(poker::streets::format_street_config(parsed) == text);
    }
    {
        RiverConfig river;
        set_board(river);
        river.pot = 100;
        river.stack = 200;
        river.oop = Range::parse("AcAd");
        river.ip = Range::parse("KsKc");
        river.rake = RakeConfig{0.05, 0.0};
        const std::string text = poker::river::format_river_config(river);
        CHECK(text.find("rake-rate 0.05\n") != std::string::npos);
        CHECK(text.find("rake-cap 0\n") != std::string::npos);
        const RiverConfig parsed = poker::river::parse_river_config(text);
        CHECK_NEAR(parsed.rake.rate, 0.05, 1e-12);
        CHECK_NEAR(parsed.rake.cap, 0.0, 1e-12);
    }

    bool street_rejects = false;
    try
    {
        StreetConfig bad;
        bad.board = {card("Ah"), card("Kd"), card("7c"), card("4s")};
        bad.pot = 100;
        bad.stack = 100;
        bad.oop = Range::parse("AcAd");
        bad.ip = Range::parse("KsKc");
        bad.rake = RakeConfig{1.5, 0.0};
        StreetGame game(bad);
        (void)game;
    }
    catch (const std::invalid_argument&)
    {
        street_rejects = true;
    }
    CHECK(street_rejects);

    bool river_rejects = false;
    try
    {
        RiverConfig bad;
        set_board(bad);
        bad.pot = 100;
        bad.stack = 100;
        bad.oop = Range::parse("AcAd");
        bad.ip = Range::parse("KsKc");
        bad.rake = RakeConfig{0.05, -2.0};
        RiverGame game(bad);
        (void)game;
    }
    catch (const std::invalid_argument&)
    {
        river_rejects = true;
    }
    CHECK(river_rejects);

    // Positive-rake RiverGame terminals (independent expected values from docs/RAKE.md).
    {
        const RakeConfig rake{0.05, 0.0};
        RiverConfig sized;
        set_board(sized);
        sized.pot = 100;
        sized.stack = 1000;
        sized.oop = Range::parse("AcAd");
        sized.ip = Range::parse("KsKc");
        sized.oop_bet_sizes = {1.0};
        sized.ip_bet_sizes = {0.5};
        sized.ip_raise_sizes = {0.25, 1.0};
        sized.allow_all_in = false;
        sized.max_raises = 2;
        sized.rake = rake;
        const RiverGame game(sized);
        const RiverGame::State open = game.child_chance(game.root(), 0);
        const RiverGame::State facing = game.child_action(
            open, find_action(game, open, "Bet 100"));
        const RiverGame::State ip_folds = game.child_action(
            facing, find_action(game, facing, "Fold"));
        CHECK_NEAR(game.p1_utility(ip_folds), 40.0, 1e-9);
        check_game_payoff(
            game.terminal_payoff(ip_folds),
            40.0,
            100,
            100,
            0,
            1,
            0,
            rake);

        const RiverGame::State called = game.child_action(
            facing, find_action(game, facing, "Call"));
        CHECK_NEAR(game.p1_utility(called), 135.0, 1e-9);
        check_game_payoff(
            game.terminal_payoff(called),
            135.0,
            100,
            100,
            100,
            -1,
            1,
            rake);

        const RiverGame::State raised = game.child_action(
            facing, find_action(game, facing, "Raise to 400"));
        const RiverGame::State oop_folds = game.child_action(
            raised, find_action(game, raised, "Fold"));
        CHECK_NEAR(game.p1_utility(oop_folds), -150.0, 1e-9);
        check_game_payoff(
            game.terminal_payoff(oop_folds),
            -150.0,
            100,
            100,
            400,
            0,
            0,
            rake);
    }

    // Positive-rake showdown lose / tie through RiverGame.
    {
        const RakeConfig rake{0.05, 0.0};
        RiverConfig lose;
        set_board(lose);
        lose.pot = 100;
        lose.stack = 100;
        lose.oop = Range::parse("5c5d");
        lose.ip = Range::parse("KsKc");
        lose.allow_all_in = false;
        lose.max_raises = 0;
        lose.rake = rake;
        const RiverGame lose_game(lose);
        const int fives = Range::combo_index(card("5c"), card("5d"));
        const int kings = Range::combo_index(card("Ks"), card("Kc"));
        const int lose_deal = find_deal(lose_game, fives, kings);
        CHECK(lose_deal >= 0);
        RiverGame::State lose_state = lose_game.child_chance(lose_game.root(), lose_deal);
        lose_state = lose_game.child_action(lose_state, find_action(lose_game, lose_state, "Check"));
        lose_state = lose_game.child_action(lose_state, find_action(lose_game, lose_state, "Check"));
        CHECK_NEAR(lose_game.p1_utility(lose_state), -50.0, 1e-9);
        check_game_payoff(
            lose_game.terminal_payoff(lose_state),
            -50.0,
            100,
            0,
            0,
            -1,
            -1,
            rake);
    }
    {
        const RakeConfig rake{0.05, 0.0};
        RiverConfig tie;
        set_board(tie);
        tie.pot = 100;
        tie.stack = 100;
        tie.oop = Range::parse("AcKc");
        tie.ip = Range::parse("AdKs");
        tie.allow_all_in = false;
        tie.max_raises = 0;
        tie.rake = rake;
        const RiverGame tie_game(tie);
        const int oop_ak = Range::combo_index(card("Ac"), card("Kc"));
        const int ip_ak = Range::combo_index(card("Ad"), card("Ks"));
        const int tie_deal = find_deal(tie_game, oop_ak, ip_ak);
        CHECK(tie_deal >= 0);
        RiverGame::State tie_state = tie_game.child_chance(tie_game.root(), tie_deal);
        tie_state = tie_game.child_action(tie_state, find_action(tie_game, tie_state, "Check"));
        tie_state = tie_game.child_action(tie_state, find_action(tie_game, tie_state, "Check"));
        CHECK_NEAR(tie_game.p1_utility(tie_state), -2.5, 1e-9);
        check_game_payoff(
            tie_game.terminal_payoff(tie_state),
            -2.5,
            100,
            0,
            0,
            -1,
            0,
            rake);
    }

    // Positive-rake StreetGame fold terminal.
    {
        const RakeConfig rake{0.05, 0.0};
        StreetConfig fold_cfg;
        fold_cfg.board = {card("Ah"), card("Kd"), card("7c"), card("4s")};
        fold_cfg.pot = 100;
        fold_cfg.stack = 200;
        fold_cfg.oop = Range::parse("AcAd");
        fold_cfg.ip = Range::parse("KsKc");
        fold_cfg.oop_bet_sizes = {1.0};
        fold_cfg.allow_all_in = false;
        fold_cfg.max_raises = 1;
        fold_cfg.rake = rake;
        const StreetGame fold_game(fold_cfg);
        StreetGame::State fold_state = fold_game.child_chance(fold_game.root(), 0);
        fold_state = fold_game.child_action(
            fold_state, find_street_action(fold_game, fold_state, "Bet 100"));
        fold_state = fold_game.child_action(
            fold_state, find_street_action(fold_game, fold_state, "Fold"));
        CHECK_NEAR(fold_game.p1_utility(fold_state), 40.0, 1e-9);
        check_game_payoff(
            fold_game.terminal_payoff(fold_state),
            40.0,
            100,
            100,
            0,
            1,
            0,
            rake);
    }

    // Zero-rake RiverBatch check-down stays at the prior pin (+50).
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

    // Positive-rake RiverBatch check-down: aces always win, pot 100, 5% → rake 5.
    // No-rake EV 50 becomes 45.
    {
        RiverConfig raked;
        set_board(raked);
        raked.pot = 100;
        raked.stack = 100;
        raked.oop = Range::parse("AcAd");
        raked.ip = Range::parse("KsKc");
        raked.allow_all_in = false;
        raked.max_raises = 0;
        raked.rake = RakeConfig{0.05, 0.0};
        RiverBatchSolver batch(raked);
        poker::solver::SolveConfig solve;
        solve.max_iterations = 1;
        const poker::solver::SolveStats stats =
            batch.solve(solve, poker::solver::Algorithm::CfrPlus);
        CHECK_NEAR(stats.p1_expected_utility, 45.0, 1e-9);
        CHECK_NEAR(batch.expected_utility(), 45.0, 1e-9);
    }

    // Positive-rake StreetBatch five-card check-down matches the river pin.
    {
        StreetConfig raked;
        raked.board = {
            card("Ah"), card("Kd"), card("7c"), card("4s"), card("2h")};
        raked.pot = 100;
        raked.stack = 100;
        raked.oop = Range::parse("AcAd");
        raked.ip = Range::parse("KsKc");
        raked.allow_all_in = false;
        raked.max_raises = 0;
        raked.rake = RakeConfig{0.05, 0.0};
        raked.memory_mib = 64;
        StreetBatchSolver batch(raked);
        poker::solver::SolveConfig solve;
        solve.max_iterations = 1;
        const poker::solver::SolveStats stats =
            batch.solve(solve, poker::solver::Algorithm::CfrPlus);
        CHECK_NEAR(stats.p1_expected_utility, 45.0, 1e-9);
    }

    // Positive-rake StreetBatch tie check-down: each loses half of floor(0.05*100)=5.
    {
        StreetConfig tied;
        tied.board = {
            card("Ah"), card("Kd"), card("7c"), card("4s"), card("2h")};
        tied.pot = 100;
        tied.stack = 100;
        tied.oop = Range::parse("AcKc");
        tied.ip = Range::parse("AdKs");
        tied.allow_all_in = false;
        tied.max_raises = 0;
        tied.rake = RakeConfig{0.05, 0.0};
        tied.memory_mib = 64;
        StreetBatchSolver batch(tied);
        poker::solver::SolveConfig solve;
        solve.max_iterations = 1;
        const poker::solver::SolveStats stats =
            batch.solve(solve, poker::solver::Algorithm::CfrPlus);
        CHECK_NEAR(stats.p1_expected_utility, -2.5, 1e-9);
    }
}
