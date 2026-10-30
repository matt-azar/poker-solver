#include "harness.hpp"

#include "poker/card.hpp"
#include "poker/hand_categories.hpp"
#include "poker/hand_eval.hpp"
#include "poker/range.hpp"
#include "solver/street_batch.hpp"
#include "solver/trainer.hpp"

#include <string>
#include <vector>

using poker::holdem::CategoryComposition;
using poker::holdem::HandCategory;
using poker::holdem::Range;
using poker::holdem::category_composition;
using poker::holdem::category_name;
using poker::holdem::kCategoryModel;
using poker::holdem::made_hand_category;
using poker::solver::Algorithm;
using poker::solver::StreetBatchSolver;

namespace
{

int card(const char* text)
{
    return poker::holdem::parse_card(text);
}

std::vector<int> board5()
{
    return {card("Ah"), card("Kd"), card("7c"), card("4s"), card("2h")};
}

poker::streets::StreetConfig turn_config()
{
    poker::streets::StreetConfig config;
    config.board = {card("Ah"), card("Kd"), card("7c"), card("4s")};
    config.pot = 100;
    config.stack = 100;
    config.oop = Range::parse("AcAd");
    config.ip = Range::parse("KsKc");
    config.oop_bet_sizes = {0.5};
    config.ip_bet_sizes = {0.5};
    config.max_raises = 0;
    config.allow_all_in = false;
    config.memory_mib = 64;
    return config;
}

std::string chance_after_checks(StreetBatchSolver& solver)
{
    std::string node = solver.root_node_id();
    for (int step = 0; step < 8; ++step)
    {
        const poker::solver::StreetInspection view = solver.inspect_node(node);
        if (view.kind == "chance")
        {
            return node;
        }
        CHECK(view.kind == "decision");
        int check = -1;
        for (std::size_t index = 0; index < view.actions.size(); ++index)
        {
            if (view.actions[index].label.find("Check") == 0
                || view.actions[index].label.find("Call") == 0)
            {
                check = static_cast<int>(index);
            }
        }
        CHECK(check >= 0);
        node = view.actions[static_cast<std::size_t>(check)].child_id;
    }
    CHECK(false);
    return node;
}

} // namespace

void run_hand_category_tests()
{
    const std::vector<int> board = board5();
    CHECK(made_hand_category(card("Ac"), card("Ad"), board) == HandCategory::ThreeOfAKind);
    CHECK(made_hand_category(card("Qc"), card("Qs"), board) == HandCategory::Pair);
    CHECK(category_name(HandCategory::ThreeOfAKind) == "three of a kind");

    const CategoryComposition short_board = category_composition(
        std::vector<int>{card("Ah"), card("Kd"), card("7c")},
        Range::parse("AcAd"),
        Range::parse("QcQs"));
    CHECK(!short_board.available);
    CHECK(short_board.reason.find("five-card") != std::string::npos);

    // Quads vs trips on Ah Ad 7c 4s 2h.
    const std::vector<int> quads_board = {
        card("Ah"), card("Ad"), card("7c"), card("4s"), card("2h")};
    const CategoryComposition report = category_composition(
        quads_board,
        Range::parse("AsAc"),
        Range::parse("7d7s"));
    CHECK(report.available);
    CHECK(report.model == kCategoryModel);
    CHECK(report.player0.defined);
    CHECK(report.player1.defined);
    CHECK_NEAR(report.player0.fraction[static_cast<std::size_t>(HandCategory::FourOfAKind)], 1.0, 1e-12);
    // 7d7s on Ah Ad 7c is sevens full of aces.
    CHECK_NEAR(report.player1.fraction[static_cast<std::size_t>(HandCategory::FullHouse)], 1.0, 1e-12);

    // Weighted mix: trips weight 1, pair weight 3.
    const CategoryComposition weighted = category_composition(
        board,
        Range::parse("AcAd:1,QcQs:3"),
        Range::parse("2c3d"));
    CHECK(weighted.available);
    CHECK(weighted.player0.defined);
    CHECK_NEAR(weighted.player0.total_mass, 4.0, 1e-12);
    CHECK_NEAR(
        weighted.player0.fraction[static_cast<std::size_t>(HandCategory::ThreeOfAKind)],
        0.25,
        1e-12);
    CHECK_NEAR(
        weighted.player0.fraction[static_cast<std::size_t>(HandCategory::Pair)],
        0.75,
        1e-12);

    const std::string json = poker::holdem::category_composition_json(report, 0.0);
    CHECK(json.find("\"kind\":\"categories\"") != std::string::npos);
    CHECK(json.find("\"model\":\"made-hand\"") != std::string::npos);
    CHECK(json.find("\"available\":true") != std::string::npos);

    StreetBatchSolver turn(turn_config());
    turn.continue_iterations(1, Algorithm::CfrPlus);
    const CategoryComposition incomplete = turn.category_composition(turn.root_node_id());
    CHECK(!incomplete.available);
    CHECK(incomplete.reason.find("five-card") != std::string::npos);

    const std::string chance = chance_after_checks(turn);
    const poker::solver::StreetRunoutValues runout = turn.runout_values(chance, nullptr);
    CHECK(!runout.cards.empty());
    const CategoryComposition dealt = turn.category_composition(runout.cards.front().child_id);
    CHECK(dealt.available);
    CHECK(dealt.board.size() == 5);
    CHECK(dealt.player0.defined);
    CHECK(dealt.player1.defined);
}
