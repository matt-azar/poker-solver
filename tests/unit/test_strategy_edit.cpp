#include "harness.hpp"

#include "game/street_game.hpp"
#include "poker/card.hpp"
#include "poker/range.hpp"
#include "solver/strategy_edit.hpp"
#include "solver/street_batch.hpp"
#include "solver/trainer.hpp"

#include <stdexcept>
#include <string>
#include <vector>

using poker::holdem::Range;
using poker::solver::Algorithm;
using poker::solver::SolveConfig;
using poker::solver::StrategyEdit;
using poker::solver::StrategyEditKind;
using poker::solver::StrategyEditSet;
using poker::solver::StreetBatchSolver;
using poker::solver::make_strategy_probs;
using poker::solver::validate_strategy_probs;
using poker::streets::StreetConfig;

namespace
{

int card(const char* text)
{
    return poker::holdem::parse_card(text);
}

StreetConfig tiny_turn()
{
    StreetConfig config;
    config.board = {card("Kh"), card("Kd"), card("7c"), card("4s")};
    config.pot = 100;
    config.stack = 100;
    config.oop = Range::parse("2c3d,2h3h");
    config.ip = Range::parse("AhAd");
    config.allow_all_in = false;
    config.max_raises = 1;
    config.oop_turn_bets = {1.0};
    config.memory_mib = 64;
    return config;
}

void test_validate_strategy_probs()
{
    CHECK(validate_strategy_probs(std::vector<double>{0.25, 0.75}, 2));
    CHECK(!validate_strategy_probs(std::vector<double>{}, 2));
    CHECK(!validate_strategy_probs(std::vector<double>{0.5, 0.4}, 2));
    CHECK(!validate_strategy_probs(std::vector<double>{-0.1, 1.1}, 2));
    CHECK(!validate_strategy_probs(std::vector<double>{1.0}, 2));
    const auto row = make_strategy_probs(std::vector<double>{0.0, 1.0}, 2);
    CHECK(row.size() == 2);
    CHECK_NEAR(row[0], 0.0, 1e-15);
    CHECK_NEAR(row[1], 1.0, 1e-15);
    bool threw = false;
    try
    {
        (void)make_strategy_probs(std::vector<double>{0.0, 0.0}, 2);
    }
    catch (const std::invalid_argument&)
    {
        threw = true;
    }
    CHECK(threw);
}

void test_strategy_edit_set_upsert_erase()
{
    StrategyEditSet edits;
    StrategyEdit full;
    full.infoset_id = 0;
    full.kind = StrategyEditKind::FullNode;
    full.probs = {0.2, 0.8};
    edits.upsert(full);
    CHECK(edits.size() == 1);
    CHECK(edits.find(0) != nullptr);

    StrategyEdit selected;
    selected.infoset_id = 0;
    selected.kind = StrategyEditKind::SelectedCombos;
    selected.hand_indices = {0, 1};
    selected.probs = {1.0, 0.0};
    edits.upsert(selected);
    CHECK(edits.find(0)->kind == StrategyEditKind::SelectedCombos);
    CHECK(edits.erase_hand(0, 1));
    CHECK(edits.find(0)->hand_indices.size() == 1);
    CHECK(edits.erase_hand(0, 0));
    CHECK(edits.empty());
}

void test_street_average_edit_round_trip_and_clear()
{
    StreetBatchSolver solver(tiny_turn());
    SolveConfig solve;
    solve.max_iterations = 12;
    solver.solve(solve, Algorithm::VanillaCfr);
    solver.prepare_inspection();
    const std::string root = solver.root_node_id();
    const auto before = solver.inspect_node(root);
    CHECK(before.kind == "decision");
    CHECK(before.actions.size() >= 2);
    CHECK(!before.hands.empty());

    int hand = -1;
    std::vector<double> original;
    for (std::size_t i = 0; i < before.hands.size(); ++i)
    {
        if (before.hands[i].structural && !before.hands[i].strategy.empty())
        {
            hand = static_cast<int>(i);
            original = before.hands[i].strategy;
            break;
        }
    }
    CHECK(hand >= 0);
    CHECK(original.size() == before.actions.size());

    std::vector<double> edited(before.actions.size(), 0.0);
    edited[edited.size() - 1] = 1.0;
    const std::uint64_t epoch0 = solver.profile_epoch();
    solver.set_average_strategy(root, hand, edited);
    CHECK(solver.profile_epoch() > epoch0);
    const auto mid = solver.inspect_node(root);
    CHECK(mid.hands[static_cast<std::size_t>(hand)].strategy.size() == edited.size());
    for (std::size_t a = 0; a < edited.size(); ++a)
    {
        CHECK_NEAR(mid.hands[static_cast<std::size_t>(hand)].strategy[a], edited[a], 1e-12);
    }

    solver.invalidate_prepared_average();
    const auto restored = solver.inspect_node(root);
    for (std::size_t a = 0; a < original.size(); ++a)
    {
        CHECK_NEAR(
            restored.hands[static_cast<std::size_t>(hand)].strategy[a], original[a], 1e-9);
    }
}

} // namespace

void run_strategy_edit_tests()
{
    test_validate_strategy_probs();
    test_strategy_edit_set_upsert_erase();
    test_street_average_edit_round_trip_and_clear();
}
