#include "harness.hpp"

#include "poker/card.hpp"
#include "poker/range.hpp"
#include "solver/street_batch.hpp"

#include <cmath>
#include <string>
#include <vector>

namespace
{

using poker::holdem::Range;
using poker::solver::StreetBatchSolver;
using poker::solver::StreetInspection;
using poker::streets::StreetConfig;

int card_id(const char* text)
{
    return poker::holdem::parse_card(text);
}

int hand_index(const StreetInspection& view, const std::string& combo)
{
    for (int index = 0; index < static_cast<int>(view.hands.size()); ++index)
    {
        if (view.hands[static_cast<std::size_t>(index)].combo == combo)
        {
            return index;
        }
    }
    return -1;
}

int action_index(const StreetInspection& view, const std::string& prefix)
{
    for (int index = 0; index < static_cast<int>(view.actions.size()); ++index)
    {
        if (view.actions[static_cast<std::size_t>(index)].label.rfind(prefix, 0) == 0)
        {
            return index;
        }
    }
    return -1;
}

StreetConfig check_config(const std::vector<int>& board, const char* oop, const char* ip)
{
    StreetConfig config;
    config.board = board;
    config.pot = 100;
    config.stack = 100;
    config.oop = Range::parse(oop);
    config.ip = Range::parse(ip);
    config.allow_all_in = false;
    config.max_raises = 0;
    config.memory_mib = 64;
    return config;
}

const poker::solver::StreetInspectCard* card_choice(const StreetInspection& view, const std::string& text)
{
    for (const poker::solver::StreetInspectCard& choice : view.cards)
    {
        if (choice.card == text)
        {
            return &choice;
        }
    }
    return nullptr;
}

StreetInspection first_chance(StreetBatchSolver& solver)
{
    StreetInspection view = solver.inspect_node(solver.root_node_id());
    for (int step = 0; step < 6 && view.kind != "chance"; ++step)
    {
        CHECK(!view.actions.empty());
        view = solver.inspect_node(view.actions[0].child_id);
    }
    CHECK(view.kind == "chance");
    return view;
}

void expect_oracle(const StreetInspection& view, const Range& oop, const Range& ip)
{
    bool dealt[52] = {};
    for (const std::string& text : view.board)
    {
        dealt[poker::holdem::parse_card(text)] = true;
    }
    double weight[52] = {};
    double total = 0.0;
    for (int left = 0; left < 1326; ++left)
    {
        const double left_weight = oop.weight(left);
        if (left_weight == 0.0)
        {
            continue;
        }
        int a = 0;
        int b = 0;
        Range::combo_cards(left, a, b);
        if (dealt[a] || dealt[b])
        {
            continue;
        }
        for (int right = 0; right < 1326; ++right)
        {
            const double right_weight = ip.weight(right);
            if (right_weight == 0.0)
            {
                continue;
            }
            int c = 0;
            int d = 0;
            Range::combo_cards(right, c, d);
            if (dealt[c] || dealt[d] || a == c || a == d || b == c || b == d)
            {
                continue;
            }
            int remaining = 0;
            bool open[52] = {};
            for (int card = 0; card < 52; ++card)
            {
                open[card] = !dealt[card] && card != a && card != b && card != c && card != d;
                if (open[card])
                {
                    ++remaining;
                }
            }
            const double piece = left_weight * right_weight / static_cast<double>(remaining);
            for (int card = 0; card < 52; ++card)
            {
                if (open[card])
                {
                    weight[card] += piece;
                }
            }
            total += left_weight * right_weight;
        }
    }
    CHECK(total > 0.0);
    CHECK(view.reach_defined);
    double sum = 0.0;
    int listed = 0;
    for (int card = 0; card < 52; ++card)
    {
        if (dealt[card])
        {
            CHECK(card_choice(view, poker::holdem::format_card(card)) == nullptr);
            continue;
        }
        const poker::solver::StreetInspectCard* choice = card_choice(view, poker::holdem::format_card(card));
        CHECK(choice != nullptr);
        CHECK(choice->weight_defined);
        CHECK_NEAR(choice->weight, weight[card] / total, 1e-9);
        sum += choice->weight;
        ++listed;
    }
    CHECK(listed == static_cast<int>(view.cards.size()));
    CHECK_NEAR(sum, 1.0, 1e-9);
}

void test_chance_matches_pair_oracle()
{
    const std::vector<int> flop = {card_id("Ah"), card_id("Kd"), card_id("7c")};
    StreetBatchSolver flop_solver(check_config(
        flop, "AcAd:1,9c9d:2,QcQd:0.5", "AcAd:0.5,QhQs:3,JhTh:1"));
    flop_solver.run_frozen_iterations(1, poker::solver::Algorithm::CfrPlus);
    flop_solver.prepare_inspection();
    const StreetInspection turn_deal = first_chance(flop_solver);
    CHECK(turn_deal.place == "deal turn");
    expect_oracle(
        turn_deal,
        Range::parse("AcAd:1,9c9d:2,QcQd:0.5"),
        Range::parse("AcAd:0.5,QhQs:3,JhTh:1"));

    const std::vector<int> turn = {card_id("Kh"), card_id("Kd"), card_id("7c"), card_id("4s")};
    StreetBatchSolver turn_solver(check_config(turn, "AhAd:1,9c9d:2", "2c3d:1,QcQd:0.5"));
    turn_solver.run_frozen_iterations(1, poker::solver::Algorithm::CfrPlus);
    turn_solver.prepare_inspection();
    const StreetInspection river_deal = first_chance(turn_solver);
    CHECK(river_deal.place == "deal river");
    expect_oracle(river_deal, Range::parse("AhAd:1,9c9d:2"), Range::parse("2c3d:1,QcQd:0.5"));
}

void test_forced_cards_and_tiny_reach()
{
    StreetBatchSolver solver(check_config(
        {card_id("7h"), card_id("8d"), card_id("9c")}, "AhAd", "2c3d"));
    solver.run_frozen_iterations(1, poker::solver::Algorithm::CfrPlus);
    solver.prepare_inspection();
    const StreetInspection chance = first_chance(solver);
    const poker::solver::StreetInspectCard* held = card_choice(chance, "Ah");
    CHECK(held != nullptr);
    CHECK(held->weight_defined);
    CHECK_NEAR(held->weight, 0.0, 0.0);
    CHECK_NEAR(card_choice(chance, "Ad")->weight, 0.0, 0.0);
    CHECK_NEAR(card_choice(chance, "2c")->weight, 0.0, 0.0);
    CHECK_NEAR(card_choice(chance, "3d")->weight, 0.0, 0.0);
    CHECK(card_choice(chance, "7h") == nullptr);
    double sum = 0.0;
    for (const poker::solver::StreetInspectCard& choice : chance.cards)
    {
        sum += choice.weight;
    }
    CHECK_NEAR(sum, 1.0, 1e-12);

    StreetBatchSolver tiny(check_config(
        {card_id("7h"), card_id("8d"), card_id("9c")}, "AhAd:1e-18", "2c3d:1e-18"));
    tiny.run_frozen_iterations(1, poker::solver::Algorithm::CfrPlus);
    tiny.prepare_inspection();
    const StreetInspection root = tiny.inspect_node(tiny.root_node_id());
    CHECK(root.reach_defined);
    double marginal = 0.0;
    for (const poker::solver::StreetInspectHand& hand : root.hands)
    {
        marginal += hand.marginal;
    }
    CHECK_NEAR(marginal, 1.0, 1e-12);
    const StreetInspection tiny_chance = first_chance(tiny);
    CHECK(tiny_chance.reach_defined);
    double tiny_sum = 0.0;
    for (const poker::solver::StreetInspectCard& choice : tiny_chance.cards)
    {
        CHECK(choice.weight_defined);
        tiny_sum += choice.weight;
    }
    CHECK_NEAR(tiny_sum, 1.0, 1e-9);
}

void test_incompatible_positive_reaches()
{
    StreetConfig config;
    config.board = {card_id("2h"), card_id("3d"), card_id("4c")};
    config.pot = 100;
    config.stack = 100;
    config.oop = Range::parse("AcAd,9c9d");
    config.ip = Range::parse("AcKh,9h9s");
    config.oop_bet_sizes = {0.5};
    config.ip_bet_sizes = {0.5};
    config.allow_all_in = false;
    config.max_raises = 1;
    config.memory_mib = 64;
    StreetBatchSolver solver(config);
    solver.run_frozen_iterations(1, poker::solver::Algorithm::CfrPlus);
    solver.prepare_inspection();
    const StreetInspection root = solver.inspect_node(solver.root_node_id());
    const int oop_keep = hand_index(root, "AdAc");
    const int oop_drop = hand_index(root, "9d9c");
    const int bet = action_index(root, "Bet");
    CHECK(oop_keep >= 0);
    CHECK(oop_drop >= 0);
    CHECK(bet >= 0);
    std::vector<double> keep(root.actions.size(), 0.0);
    std::vector<double> drop(root.actions.size(), 0.0);
    keep[static_cast<std::size_t>(bet)] = 1.0;
    drop[0] = 1.0;
    solver.set_average_for_test(root.node_id, oop_keep, keep);
    solver.set_average_for_test(root.node_id, oop_drop, drop);
    const StreetInspection ip_node = solver.inspect_node(root.actions[static_cast<std::size_t>(bet)].child_id);
    CHECK(ip_node.player == 1);
    CHECK(ip_node.reach_defined);
    const int ip_keep = hand_index(ip_node, "AcKh");
    const int ip_drop = hand_index(ip_node, "9s9h");
    const int call = action_index(ip_node, "Call");
    CHECK(ip_keep >= 0);
    CHECK(ip_drop >= 0);
    CHECK(call >= 0);
    CHECK(ip_node.hands[static_cast<std::size_t>(ip_keep)].reach > 0.0);
    std::vector<double> ip_only(ip_node.actions.size(), 0.0);
    std::vector<double> ip_other(ip_node.actions.size(), 0.0);
    ip_only[static_cast<std::size_t>(call)] = 1.0;
    ip_other[0] = 1.0;
    solver.set_average_for_test(ip_node.node_id, ip_keep, ip_only);
    solver.set_average_for_test(ip_node.node_id, ip_drop, ip_other);
    const StreetInspection blocked = solver.inspect_node(ip_node.actions[static_cast<std::size_t>(call)].child_id);
    CHECK(blocked.kind == "chance");
    CHECK(blocked.joint == 0.0);
    CHECK(!blocked.reach_defined);
    CHECK(!blocked.cards.empty());
    for (const poker::solver::StreetInspectCard& choice : blocked.cards)
    {
        CHECK(!choice.weight_defined);
    }
}

void test_inspection_leaves_tables()
{
    StreetBatchSolver solver(check_config(
        {card_id("Ah"), card_id("Kd"), card_id("7c")}, "AcAd:1,9c9d:2", "QhQs:3,JhTh:1"));
    solver.run_frozen_iterations(2, poker::solver::Algorithm::CfrPlus);
    const std::vector<double> regret(solver.regret_table().begin(), solver.regret_table().end());
    const std::vector<double> strategy(solver.strategy_sum_table().begin(), solver.strategy_sum_table().end());
    const StreetInspection root = solver.inspect_node(solver.root_node_id());
    CHECK(!root.actions.empty());
    const StreetInspection child = solver.inspect_node(root.actions[0].child_id);
    StreetInspection cursor = child;
    for (int step = 0; step < 4 && cursor.kind != "chance"; ++step)
    {
        CHECK(!cursor.actions.empty());
        cursor = solver.inspect_node(cursor.actions[0].child_id);
    }
    CHECK(cursor.kind == "chance");
    CHECK(solver.regret_table().size() == regret.size());
    CHECK(solver.strategy_sum_table().size() == strategy.size());
    for (std::size_t index = 0; index < regret.size(); ++index)
    {
        CHECK(solver.regret_table()[index] == regret[index]);
        CHECK(solver.strategy_sum_table()[index] == strategy[index]);
    }
}

} // namespace

void run_street_chance_tests()
{
    test_chance_matches_pair_oracle();
    test_forced_cards_and_tiny_reach();
    test_incompatible_positive_reaches();
    test_inspection_leaves_tables();
}
