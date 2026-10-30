#include "harness.hpp"

#include "game/river_game.hpp"
#include "game/street_game.hpp"
#include "poker/card.hpp"
#include "poker/range.hpp"
#include "solver/chip_payoff.hpp"
#include "solver/payoff.hpp"

#include <stdexcept>
#include <string>

using poker::holdem::Range;
using poker::river::RiverConfig;
using poker::river::RiverGame;
using poker::solver::ChipPayoff;
using poker::solver::PlayerPayoff;
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

int river_outcome(const StreetGame& game, const StreetGame::State& chance, int wanted)
{
    const int count = game.chance_count(chance);
    for (int outcome = 0; outcome < count; ++outcome)
    {
        const StreetGame::State dealt = game.child_chance(chance, outcome);
        if (dealt.river_card == wanted)
        {
            return outcome;
        }
    }
    return -1;
}

StreetGame::State check_through(const StreetGame& game, StreetGame::State state)
{
    while (!game.is_terminal(state) && !game.is_chance(state))
    {
        const int action = find_street_action(game, state, "Check");
        CHECK(action >= 0);
        state = game.child_action(state, action);
    }
    return state;
}

void check_matches_river(const RiverGame& game, const RiverGame::State& state)
{
    CHECK(game.is_terminal(state));
    const PlayerPayoff both = game.terminal_payoff(state);
    const double p0 = game.p1_utility(state);
    CHECK_NEAR(both.utility[0], p0, 1e-12);
    CHECK_NEAR(both.utility[1], -p0, 1e-12);

    // Fold ignores showdown. On showdown, recover the outcome sign from the
    // known player-0 utility so ChipPayoff is checked without reading deals_.
    const int showdown = state.folded < 0
        ? (p0 > 0.0 ? 1 : (p0 < 0.0 ? -1 : 0))
        : 0;
    const PlayerPayoff chips = ChipPayoff::terminal(
        game.config().pot,
        state.contrib[0],
        state.contrib[1],
        state.folded,
        showdown);
    CHECK_NEAR(chips.utility[0], p0, 1e-12);
    CHECK_NEAR(chips.utility[1], -p0, 1e-12);
}

void check_matches_street(const StreetGame& game, const StreetGame::State& state, int pot)
{
    CHECK(game.is_terminal(state));
    const PlayerPayoff both = game.terminal_payoff(state);
    const double p0 = game.p1_utility(state);
    CHECK_NEAR(both.utility[0], p0, 1e-12);
    CHECK_NEAR(both.utility[1], -p0, 1e-12);

    const int showdown = state.folded < 0
        ? (p0 > 0.0 ? 1 : (p0 < 0.0 ? -1 : 0))
        : 0;
    const PlayerPayoff chips = ChipPayoff::terminal(
        pot,
        state.contrib[0],
        state.contrib[1],
        state.folded,
        showdown);
    CHECK_NEAR(chips.utility[0], p0, 1e-12);
    CHECK_NEAR(chips.utility[1], -p0, 1e-12);
}

StreetConfig turn_check_only(const char* oop, const char* ip)
{
    StreetConfig config;
    config.board = {card("Ah"), card("Kd"), card("7c"), card("4s")};
    config.pot = 100;
    config.stack = 200;
    config.oop = Range::parse(oop);
    config.ip = Range::parse(ip);
    config.max_raises = 0;
    config.allow_all_in = false;
    return config;
}

StreetGame::State check_down_to_river(
    const StreetGame& game,
    int deal,
    int river_card)
{
    StreetGame::State state = game.child_chance(game.root(), deal);
    state = check_through(game, state);
    CHECK(game.is_chance(state));
    const int outcome = river_outcome(game, state, river_card);
    CHECK(outcome >= 0);
    state = game.child_chance(state, outcome);
    state = check_through(game, state);
    CHECK(game.is_terminal(state));
    return state;
}

} // namespace

void run_rake_tests();

void run_payoff_tests()
{
    // Fold / called-win fixtures reuse the sized river tree from RIVER.md tests.
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
    const RiverGame sized_game(sized);
    const RiverGame::State open = sized_game.child_chance(sized_game.root(), 0);
    const RiverGame::State facing = sized_game.child_action(
        open, find_action(sized_game, open, "Bet 100"));

    const RiverGame::State ip_folds = sized_game.child_action(
        facing, find_action(sized_game, facing, "Fold"));
    CHECK_NEAR(sized_game.p1_utility(ip_folds), 50.0, 1e-9);
    check_matches_river(sized_game, ip_folds);
    {
        const PlayerPayoff chips = ChipPayoff::terminal(100, 100, 0, 1, 0);
        CHECK_NEAR(chips.utility[0], 50.0, 1e-12);
        CHECK_NEAR(chips.utility[1], -50.0, 1e-12);
    }

    const RiverGame::State called_win = sized_game.child_action(
        facing, find_action(sized_game, facing, "Call"));
    CHECK_NEAR(sized_game.p1_utility(called_win), 150.0, 1e-9);
    check_matches_river(sized_game, called_win);
    {
        const PlayerPayoff chips = ChipPayoff::terminal(100, 100, 100, -1, 1);
        CHECK_NEAR(chips.utility[0], 150.0, 1e-12);
        CHECK_NEAR(chips.utility[1], -150.0, 1e-12);
    }

    const RiverGame::State raised = sized_game.child_action(
        facing, find_action(sized_game, facing, "Raise to 400"));
    const RiverGame::State oop_folds = sized_game.child_action(
        raised, find_action(sized_game, raised, "Fold"));
    CHECK_NEAR(sized_game.p1_utility(oop_folds), -150.0, 1e-9);
    check_matches_river(sized_game, oop_folds);
    {
        const PlayerPayoff chips = ChipPayoff::terminal(100, 100, 400, 0, 0);
        CHECK_NEAR(chips.utility[0], -150.0, 1e-12);
        CHECK_NEAR(chips.utility[1], 150.0, 1e-12);
    }

    // Showdown loss: fives versus kings check down.
    RiverConfig lose;
    set_board(lose);
    lose.pot = 100;
    lose.stack = 100;
    lose.oop = Range::parse("5c5d");
    lose.ip = Range::parse("KsKc");
    lose.allow_all_in = false;
    lose.max_raises = 0;
    const RiverGame lose_game(lose);
    const int fives = Range::combo_index(card("5c"), card("5d"));
    const int kings = Range::combo_index(card("Ks"), card("Kc"));
    const int lose_deal = find_deal(lose_game, fives, kings);
    CHECK(lose_deal >= 0);
    RiverGame::State lose_state = lose_game.child_chance(lose_game.root(), lose_deal);
    lose_state = lose_game.child_action(lose_state, find_action(lose_game, lose_state, "Check"));
    lose_state = lose_game.child_action(lose_state, find_action(lose_game, lose_state, "Check"));
    CHECK(lose_game.is_terminal(lose_state));
    CHECK_NEAR(lose_game.p1_utility(lose_state), -50.0, 1e-9);
    check_matches_river(lose_game, lose_state);
    {
        const PlayerPayoff chips = ChipPayoff::terminal(100, 0, 0, -1, -1);
        CHECK_NEAR(chips.utility[0], -50.0, 1e-12);
        CHECK_NEAR(chips.utility[1], 50.0, 1e-12);
    }

    // Showdown tie: both players hold AK on Ah Kd 7c 4s 2h.
    RiverConfig tie;
    set_board(tie);
    tie.pot = 100;
    tie.stack = 100;
    tie.oop = Range::parse("AcKc");
    tie.ip = Range::parse("AdKs");
    tie.allow_all_in = false;
    tie.max_raises = 0;
    const RiverGame tie_game(tie);
    const int oop_ak = Range::combo_index(card("Ac"), card("Kc"));
    const int ip_ak = Range::combo_index(card("Ad"), card("Ks"));
    const int tie_deal = find_deal(tie_game, oop_ak, ip_ak);
    CHECK(tie_deal >= 0);
    RiverGame::State tie_state = tie_game.child_chance(tie_game.root(), tie_deal);
    tie_state = tie_game.child_action(tie_state, find_action(tie_game, tie_state, "Check"));
    tie_state = tie_game.child_action(tie_state, find_action(tie_game, tie_state, "Check"));
    CHECK(tie_game.is_terminal(tie_state));
    CHECK_NEAR(tie_game.p1_utility(tie_state), 0.0, 1e-9);
    check_matches_river(tie_game, tie_state);
    {
        const PlayerPayoff chips = ChipPayoff::terminal(100, 0, 0, -1, 0);
        CHECK_NEAR(chips.utility[0], 0.0, 1e-12);
        CHECK_NEAR(chips.utility[1], 0.0, 1e-12);
    }

    bool unequal_threw = false;
    try
    {
        (void)ChipPayoff::terminal(100, 50, 100, -1, 1);
    }
    catch (const std::logic_error&)
    {
        unequal_threw = true;
    }
    CHECK(unequal_threw);

<<<<<<< HEAD
    // StreetGame mirrors RiverGame through ChipPayoff. This base accepts only
    // 3/4-card boards, so fold / showdown / tie use a turn check-down fixture
    // with river 2h (the five-card board Ah Kd 7c 4s 2h).
    {
        StreetConfig fold_cfg;
        fold_cfg.board = {card("Ah"), card("Kd"), card("7c"), card("4s")};
        fold_cfg.pot = 100;
        fold_cfg.stack = 200;
        fold_cfg.oop = Range::parse("AcAd");
        fold_cfg.ip = Range::parse("KsKc");
        fold_cfg.oop_bet_sizes = {1.0};
        fold_cfg.allow_all_in = false;
        fold_cfg.max_raises = 1;
        const StreetGame fold_game(fold_cfg);
        CHECK(fold_game.deal_count() == 1);
        StreetGame::State fold_state = fold_game.child_chance(fold_game.root(), 0);
        fold_state = fold_game.child_action(
            fold_state, find_street_action(fold_game, fold_state, "Bet 100"));
        fold_state = fold_game.child_action(
            fold_state, find_street_action(fold_game, fold_state, "Fold"));
        CHECK(fold_game.is_terminal(fold_state));
        CHECK_NEAR(fold_game.p1_utility(fold_state), 50.0, 1e-9);
        check_matches_street(fold_game, fold_state, 100);
        {
            const PlayerPayoff chips = ChipPayoff::terminal(100, 100, 0, 1, 0);
            CHECK_NEAR(chips.utility[0], 50.0, 1e-12);
            CHECK_NEAR(chips.utility[1], -50.0, 1e-12);
        }
    }

    {
        const StreetGame win_game(turn_check_only("AcAd", "KsKc"));
        CHECK(win_game.deal_count() == 1);
        const StreetGame::State win_state =
            check_down_to_river(win_game, 0, card("2h"));
        CHECK_NEAR(win_game.p1_utility(win_state), 50.0, 1e-9);
        check_matches_street(win_game, win_state, 100);
        {
            const PlayerPayoff chips = ChipPayoff::terminal(100, 0, 0, -1, 1);
            CHECK_NEAR(chips.utility[0], 50.0, 1e-12);
            CHECK_NEAR(chips.utility[1], -50.0, 1e-12);
        }
    }

    {
        const StreetGame lose_game(turn_check_only("5c5d", "KsKc"));
        CHECK(lose_game.deal_count() == 1);
        const StreetGame::State lose_state =
            check_down_to_river(lose_game, 0, card("2h"));
        CHECK_NEAR(lose_game.p1_utility(lose_state), -50.0, 1e-9);
        check_matches_street(lose_game, lose_state, 100);
        {
            const PlayerPayoff chips = ChipPayoff::terminal(100, 0, 0, -1, -1);
            CHECK_NEAR(chips.utility[0], -50.0, 1e-12);
            CHECK_NEAR(chips.utility[1], 50.0, 1e-12);
        }
    }

    {
        const StreetGame street_tie(turn_check_only("AcKc", "AdKs"));
        CHECK(street_tie.deal_count() == 1);
        const StreetGame::State tie_state =
            check_down_to_river(street_tie, 0, card("2h"));
        CHECK_NEAR(street_tie.p1_utility(tie_state), 0.0, 1e-9);
        check_matches_street(street_tie, tie_state, 100);
        {
            const PlayerPayoff chips = ChipPayoff::terminal(100, 0, 0, -1, 0);
            CHECK_NEAR(chips.utility[0], 0.0, 1e-12);
            CHECK_NEAR(chips.utility[1], 0.0, 1e-12);
        }
    }
=======
    run_rake_tests();
>>>>>>> origin/cursor/rake-payoff-c006
}
