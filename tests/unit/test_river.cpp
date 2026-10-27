#include "harness.hpp"

#include "game/river_game.hpp"
#include "poker/card.hpp"
#include "poker/range.hpp"
#include "solver/trainer.hpp"

#include <cmath>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

using poker::holdem::Range;
using poker::river::RiverConfig;
using poker::river::RiverGame;

namespace
{

int card(const char* text)
{
    return poker::holdem::parse_card(text);
}

bool throws_invalid(const auto& call)
{
    try
    {
        call();
    }
    catch (const std::invalid_argument&)
    {
        return true;
    }
    return false;
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

double action_frequency(const RiverGame& game,
                         const std::vector<double>& strategy,
                         const std::vector<int>& offset,
                         int infoset,
                         const std::string& label)
{
    const int count = game.action_count(infoset);
    const int base = offset[static_cast<std::size_t>(infoset)];
    for (int action = 0; action < count; ++action)
    {
        if (game.action_label(infoset, action) == label)
        {
            return strategy[static_cast<std::size_t>(base + action)];
        }
    }
    return -1.0;
}

void walk(const RiverGame& game, const RiverGame::State& state, int depth)
{
    CHECK(depth < 16);
    CHECK(state.pot == game.config().pot + state.contrib[0] + state.contrib[1]);
    if (game.is_terminal(state))
    {
        const double utility = game.p1_utility(state);
        const double half = game.config().pot * 0.5;
        if (state.folded == 0)
        {
            CHECK_NEAR(utility, -(half + state.contrib[0]), 1e-9);
        }
        else if (state.folded == 1)
        {
            CHECK_NEAR(utility, half + state.contrib[1], 1e-9);
        }
        else
        {
            CHECK(state.contrib[0] == state.contrib[1]);
            CHECK(std::isfinite(utility));
        }
        return;
    }
    if (game.is_chance(state))
    {
        double sum = 0.0;
        const int count = game.chance_count(state);
        for (int outcome = 0; outcome < count; ++outcome)
        {
            sum += game.chance_probability(state, outcome);
            int combo0 = 0;
            int combo1 = 0;
            game.deal_combos(outcome, combo0, combo1);
            int cards0[2] = {};
            int cards1[2] = {};
            Range::combo_cards(combo0, cards0[0], cards0[1]);
            Range::combo_cards(combo1, cards1[0], cards1[1]);
            bool blocked = false;
            for (int card_id : game.config().board)
            {
                blocked = blocked || cards0[0] == card_id || cards0[1] == card_id
                    || cards1[0] == card_id || cards1[1] == card_id;
            }
            blocked = blocked || cards0[0] == cards1[0] || cards0[0] == cards1[1]
                || cards0[1] == cards1[0] || cards0[1] == cards1[1];
            CHECK(!blocked);
            walk(game, game.child_chance(state, outcome), depth + 1);
        }
        CHECK_NEAR(sum, 1.0, 1e-12);
        return;
    }

    const int infoset = game.infoset(state);
    CHECK(game.acting_player(infoset) == state.acting);
    const int count = game.action_count(infoset);
    CHECK(count >= 1);
    CHECK(count <= 8);
    for (int action = 0; action < count; ++action)
    {
        walk(game, game.child_action(state, action), depth + 1);
    }
}

RiverConfig polar_config()
{
    RiverConfig config;
    set_board(config);
    config.pot = 100;
    config.stack = 100;
    config.oop = Range::parse("AcAd,5c5d");
    config.ip = Range::parse("KsKc");
    config.oop_bet_sizes = {1.0};
    config.allow_all_in = false;
    config.max_raises = 1;
    return config;
}

} // namespace

void run_river_tests()
{
    RiverConfig blocked;
    set_board(blocked);
    blocked.oop = Range::parse("AhKd");
    blocked.ip = Range::parse("KsKc");
    CHECK(throws_invalid([&] { RiverGame game(blocked); }));

    RiverConfig too_many;
    set_board(too_many);
    too_many.stack = 5000;
    too_many.oop = Range::parse("AcAd");
    too_many.ip = Range::parse("KsKc");
    too_many.oop_bet_sizes = {0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0};
    too_many.allow_all_in = false;
    CHECK(throws_invalid([&] { RiverGame game(too_many); }));

    RiverConfig seven;
    set_board(seven);
    seven.stack = 5000;
    seven.oop = Range::parse("AcAd");
    seven.ip = Range::parse("KsKc");
    seven.oop_bet_sizes = {0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75};
    seven.allow_all_in = false;
    seven.max_raises = 1;
    {
        const RiverGame game(seven);
        const RiverGame::State dealt = game.child_chance(game.root(), 0);
        CHECK(game.action_count(game.infoset(dealt)) == 8);
    }

    RiverConfig shove;
    set_board(shove);
    shove.stack = 150;
    shove.oop = Range::parse("AcAd");
    shove.ip = Range::parse("KsKc");
    shove.oop_bet_sizes = {2.0};
    shove.allow_all_in = true;
    {
        const RiverGame game(shove);
        const RiverGame::State dealt = game.child_chance(game.root(), 0);
        CHECK(find_action(game, dealt, "Bet 150 all-in") >= 0);
        CHECK(find_action(game, dealt, "Check") >= 0);
    }
    shove.allow_all_in = false;
    {
        const RiverGame game(shove);
        const RiverGame::State dealt = game.child_chance(game.root(), 0);
        CHECK(game.action_count(game.infoset(dealt)) == 1);
        CHECK(find_action(game, dealt, "Check") == 0);
    }

    RiverConfig grouped;
    set_board(grouped);
    grouped.oop = Range::parse("AcAd");
    grouped.ip = Range::parse("QhQs,JhJs");
    grouped.max_raises = 0;
    grouped.allow_all_in = false;
    const RiverGame grouped_game(grouped);
    CHECK(grouped_game.deal_count() == 2);
    CHECK_NEAR(grouped_game.deal_probability(0) + grouped_game.deal_probability(1), 1.0, 1e-12);
    const RiverGame::State deal_a = grouped_game.child_chance(grouped_game.root(), 0);
    const RiverGame::State deal_b = grouped_game.child_chance(grouped_game.root(), 1);
    CHECK(grouped_game.infoset(deal_a) == grouped_game.infoset(deal_b));
    const int check_a = find_action(grouped_game, deal_a, "Check");
    const RiverGame::State ip_a = grouped_game.child_action(deal_a, check_a);
    const RiverGame::State ip_b = grouped_game.child_action(deal_b, check_a);
    CHECK(grouped_game.infoset(ip_a) != grouped_game.infoset(ip_b));
    CHECK(grouped_game.decision_node_count() == 4);
    CHECK(grouped_game.infoset_count() == 3);
    CHECK(grouped_game.terminal_count() == 2);
    {
        poker::solver::CfrTrainer<RiverGame> trainer(
            grouped_game, poker::solver::Algorithm::VanillaCfr);
        const poker::solver::SolveStats stats = trainer.solve({1, -1.0, 0});
        CHECK_NEAR(stats.p1_expected_utility, 50.0, 1e-9);
        CHECK_NEAR(stats.nash_gap, 0.0, 1e-9);
    }

    RiverConfig tie_cfg;
    tie_cfg.board = {card("Ah"), card("Kd"), card("Qc"), card("Js"), card("9d")};
    tie_cfg.oop = Range::parse("2c3d");
    tie_cfg.ip = Range::parse("4h5s");
    tie_cfg.max_raises = 0;
    tie_cfg.allow_all_in = false;
    {
        const RiverGame game(tie_cfg);
        poker::solver::CfrTrainer<RiverGame> trainer(game, poker::solver::Algorithm::VanillaCfr);
        const poker::solver::SolveStats stats = trainer.solve({1, -1.0, 0});
        CHECK_NEAR(stats.p1_expected_utility, 0.0, 1e-9);
        CHECK_NEAR(stats.nash_gap, 0.0, 1e-9);
    }

    RiverConfig ip_first;
    set_board(ip_first);
    ip_first.oop = Range::parse("AcAd");
    ip_first.ip = Range::parse("KsKc");
    ip_first.max_raises = 0;
    ip_first.allow_all_in = false;
    ip_first.first_to_act = 1;
    {
        const RiverGame game(ip_first);
        const RiverGame::State dealt = game.child_chance(game.root(), 0);
        CHECK(game.acting_player(game.infoset(dealt)) == 1);
        poker::solver::CfrTrainer<RiverGame> trainer(game, poker::solver::Algorithm::VanillaCfr);
        const poker::solver::SolveStats stats = trainer.solve({1, -1.0, 0});
        CHECK_NEAR(stats.p1_expected_utility, 50.0, 1e-9);
    }

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
    walk(sized_game, sized_game.root(), 0);
    const int only_deal = 0;
    const RiverGame::State open = sized_game.child_chance(sized_game.root(), only_deal);
    const int bet100 = find_action(sized_game, open, "Bet 100");
    CHECK(bet100 >= 0);
    const RiverGame::State facing = sized_game.child_action(open, bet100);
    CHECK(find_action(sized_game, facing, "Fold") >= 0);
    CHECK(find_action(sized_game, facing, "Call") >= 0);
    CHECK(find_action(sized_game, facing, "Raise to 400") >= 0);
    CHECK(sized_game.action_count(sized_game.infoset(facing)) == 3);

    const RiverGame::State folded = sized_game.child_action(
        facing, find_action(sized_game, facing, "Fold"));
    CHECK(sized_game.is_terminal(folded));
    CHECK_NEAR(sized_game.p1_utility(folded), 50.0, 1e-9);

    const RiverGame::State called = sized_game.child_action(
        facing, find_action(sized_game, facing, "Call"));
    CHECK_NEAR(sized_game.p1_utility(called), 150.0, 1e-9);

    const RiverGame::State raised = sized_game.child_action(
        facing, find_action(sized_game, facing, "Raise to 400"));
    CHECK(raised.pot == 600);
    CHECK(raised.contrib[1] == 400);
    const RiverGame::State oop_folds = sized_game.child_action(
        raised, find_action(sized_game, raised, "Fold"));
    CHECK_NEAR(sized_game.p1_utility(oop_folds), -150.0, 1e-9);

    const int checked = find_action(sized_game, open, "Check");
    const RiverGame::State ip_open = sized_game.child_action(open, checked);
    const int ip_bet = find_action(sized_game, ip_open, "Bet 50");
    CHECK(ip_bet >= 0);
    const RiverGame::State oop_faces = sized_game.child_action(ip_open, ip_bet);
    const RiverGame::State oop_fold = sized_game.child_action(
        oop_faces, find_action(sized_game, oop_faces, "Fold"));
    CHECK_NEAR(sized_game.p1_utility(oop_fold), -50.0, 1e-9);

    RiverConfig weights;
    set_board(weights);
    weights.oop = Range::parse("AcAd:1,AcAs:3");
    weights.ip = Range::parse("KsKc");
    weights.max_raises = 0;
    weights.allow_all_in = false;
    {
        const RiverGame game(weights);
        CHECK(game.deal_count() == 2);
        const int heavy = Range::combo_index(card("Ac"), card("As"));
        const int light = Range::combo_index(card("Ac"), card("Ad"));
        const int kings = Range::combo_index(card("Ks"), card("Kc"));
        const int heavy_deal = find_deal(game, heavy, kings);
        const int light_deal = find_deal(game, light, kings);
        CHECK(heavy_deal >= 0);
        CHECK(light_deal >= 0);
        CHECK_NEAR(game.deal_probability(heavy_deal), 0.75, 1e-12);
        CHECK_NEAR(game.deal_probability(light_deal), 0.25, 1e-12);
    }

    RiverConfig aa_kk;
    set_board(aa_kk);
    aa_kk.oop = Range::parse("AA");
    aa_kk.ip = Range::parse("KK");
    aa_kk.max_raises = 0;
    aa_kk.allow_all_in = false;
    {
        const RiverGame game(aa_kk);
        CHECK(game.deal_count() == 9);
        walk(game, game.root(), 0);
    }

    const RiverGame polar(polar_config());
    CHECK(polar.deal_count() == 2);
    const int nuts_combo = Range::combo_index(card("Ac"), card("Ad"));
    const int air_combo = Range::combo_index(card("5c"), card("5d"));
    const int catcher_combo = Range::combo_index(card("Ks"), card("Kc"));
    const int nuts_deal = find_deal(polar, nuts_combo, catcher_combo);
    const int air_deal = find_deal(polar, air_combo, catcher_combo);
    CHECK(nuts_deal >= 0);
    CHECK(air_deal >= 0);
    const RiverGame::State nuts_state = polar.child_chance(polar.root(), nuts_deal);
    const RiverGame::State air_state = polar.child_chance(polar.root(), air_deal);
    CHECK(polar.infoset(nuts_state) != polar.infoset(air_state));
    const int bet_action = find_action(polar, nuts_state, "Bet 100 all-in");
    const RiverGame::State ip_nuts = polar.child_action(nuts_state, bet_action);
    const RiverGame::State ip_air = polar.child_action(air_state, bet_action);
    CHECK(polar.infoset(ip_nuts) == polar.infoset(ip_air));
    CHECK(polar.acting_player(polar.infoset(ip_nuts)) == 1);

    poker::solver::SolveConfig short_run;
    short_run.max_iterations = 40;
    poker::solver::SolveConfig long_run;
    long_run.max_iterations = 4000;
    poker::solver::CfrTrainer<RiverGame> brief(polar, poker::solver::Algorithm::CfrPlus);
    poker::solver::CfrTrainer<RiverGame> solved(polar, poker::solver::Algorithm::CfrPlus);
    const poker::solver::SolveStats brief_stats = brief.solve(short_run);
    const poker::solver::SolveStats solved_stats = solved.solve(long_run);
    const std::vector<double> strategy = solved.average_strategy();
    const std::vector<int> offset = poker::solver::action_offsets(polar);
    const double nuts_bet = action_frequency(
        polar, strategy, offset, polar.infoset(nuts_state), "Bet 100 all-in");
    const double air_bet = action_frequency(
        polar, strategy, offset, polar.infoset(air_state), "Bet 100 all-in");
    const double ip_call = action_frequency(
        polar, strategy, offset, polar.infoset(ip_nuts), "Call all-in");
    std::cout << "REPORT river_polar_cfr_plus\n";
    std::cout << "  iterations " << solved_stats.iterations << "\n";
    std::cout << "  runtime_seconds " << solved_stats.runtime_seconds << "\n";
    std::cout << "  memory_bytes_estimate " << solved_stats.memory_bytes_estimate << "\n";
    std::cout << "  infosets " << polar.infoset_count() << "\n";
    std::cout << "  decision_nodes " << polar.decision_node_count() << "\n";
    std::cout << "  player0_expected_utility " << solved_stats.p1_expected_utility << "\n";
    std::cout << "  nash_gap " << solved_stats.nash_gap << "\n";
    std::cout << "  nuts_bet " << nuts_bet << "\n";
    std::cout << "  air_bet " << air_bet << "\n";
    std::cout << "  ip_call " << ip_call << "\n";
    std::cout << "  gap_at_40 " << brief_stats.nash_gap << "\n";
    CHECK(solved_stats.nash_gap < brief_stats.nash_gap);
    CHECK_NEAR(solved_stats.p1_expected_utility, 25.0, 1.5);
    CHECK(solved_stats.nash_gap < 1.0);
    CHECK(nuts_bet > 0.85);
    CHECK(air_bet > 0.3);
    CHECK(air_bet < 0.7);
    CHECK(ip_call > 0.3);
    CHECK(ip_call < 0.7);
    for (double regret : solved.regrets())
    {
        CHECK(regret >= -1e-12);
    }

    poker::solver::CfrTrainer<RiverGame> again(polar, poker::solver::Algorithm::CfrPlus);
    again.solve(short_run);
    const std::vector<double> left = brief.average_strategy();
    const std::vector<double> right = again.average_strategy();
    CHECK(left.size() == right.size());
    for (std::size_t i = 0; i < left.size(); ++i)
    {
        CHECK_NEAR(left[i], right[i], 1e-12);
    }

    poker::solver::CfrTrainer<RiverGame> vanilla(polar, poker::solver::Algorithm::VanillaCfr);
    const poker::solver::SolveStats vanilla_stats = vanilla.solve(short_run);
    bool moved = false;
    for (double regret : vanilla.regrets())
    {
        if (std::abs(regret) > 1e-9)
        {
            moved = true;
        }
    }
    CHECK(moved);
    CHECK(vanilla_stats.nash_gap > 0.0);
    std::cout << "REPORT river_polar_vanilla_40\n";
    std::cout << "  player0_expected_utility " << vanilla_stats.p1_expected_utility << "\n";
    std::cout << "  nash_gap " << vanilla_stats.nash_gap << "\n";
    std::cout << "  runtime_seconds " << vanilla_stats.runtime_seconds << "\n";
}
