#include "game/leduc_game.hpp"
#include "harness.hpp"
#include "solver/trainer.hpp"

#include <cmath>
#include <iostream>
#include <stdexcept>
#include <string>

namespace
{

using poker::leduc::LeducGame;

LeducGame::State deal_hole(const LeducGame& game, int card0, int card1)
{
    LeducGame::State state = game.root();
    bool found0 = false;
    const int first_count = game.chance_count(state);
    for (int outcome = 0; outcome < first_count; ++outcome)
    {
        LeducGame::State next = game.child_chance(state, outcome);
        if (next.hole[0] == card0)
        {
            state = next;
            found0 = true;
            break;
        }
    }
    if (!found0)
    {
        throw std::logic_error("missing first card");
    }
    const int second_count = game.chance_count(state);
    for (int outcome = 0; outcome < second_count; ++outcome)
    {
        LeducGame::State next = game.child_chance(state, outcome);
        if (next.hole[1] == card1)
        {
            return next;
        }
    }
    throw std::logic_error("missing second card");
}

LeducGame::State deal_board(const LeducGame& game, LeducGame::State state, int board)
{
    if (!game.is_chance(state))
    {
        throw std::logic_error("expected a board chance node");
    }
    const int count = game.chance_count(state);
    for (int outcome = 0; outcome < count; ++outcome)
    {
        LeducGame::State next = game.child_chance(state, outcome);
        if (next.board == board)
        {
            return next;
        }
    }
    throw std::logic_error("missing board card");
}

void walk_terminals(const LeducGame& game, const LeducGame::State& state, int& terminals)
{
    if (state.hole[0] >= 0 && state.hole[1] >= 0)
    {
        CHECK(state.hole[0] != state.hole[1]);
    }
    if (state.board >= 0)
    {
        CHECK(state.board != state.hole[0]);
        CHECK(state.board != state.hole[1]);
    }
    CHECK(state.pot == state.contrib[0] + state.contrib[1]);

    if (game.is_terminal(state))
    {
        ++terminals;
        const double utility = game.p1_utility(state);
        CHECK(utility == -static_cast<double>(state.contrib[0])
            || utility == static_cast<double>(state.contrib[1])
            || utility == 0.0);
        return;
    }
    if (game.is_chance(state))
    {
        double mass = 0.0;
        const int count = game.chance_count(state);
        CHECK(count > 0);
        for (int outcome = 0; outcome < count; ++outcome)
        {
            mass += game.chance_probability(state, outcome);
            walk_terminals(game, game.child_chance(state, outcome), terminals);
        }
        CHECK_NEAR(mass, 1.0, 1e-12);
        return;
    }

    const int infoset = game.infoset(state);
    CHECK(game.acting_player(infoset) == state.acting);
    CHECK(game.action_count(infoset) >= 1);
    const int count = game.action_count(infoset);
    for (int action = 0; action < count; ++action)
    {
        walk_terminals(game, game.child_action(state, action), terminals);
    }
}

void report_leduc(const char* name,
                  const poker::solver::SolveStats& stats,
                  int infosets)
{
    std::cout.precision(12);
    std::cout << "REPORT " << name << "\n";
    std::cout << "  iterations " << stats.iterations << "\n";
    std::cout << "  runtime_seconds " << stats.runtime_seconds << "\n";
    std::cout << "  memory_bytes_estimate " << stats.memory_bytes_estimate << "\n";
    std::cout << "  player0_expected_utility " << stats.p1_expected_utility << "\n";
    std::cout << "  nash_gap " << stats.nash_gap << "\n";
    std::cout << "  infosets " << infosets << "\n";
}

} // namespace

void run_leduc_tests()
{
    const LeducGame game;

    const LeducGame::State root = game.root();
    CHECK(game.is_chance(root));
    CHECK(game.chance_count(root) == 6);
    double root_mass = 0.0;
    for (int outcome = 0; outcome < 6; ++outcome)
    {
        CHECK_NEAR(game.chance_probability(root, outcome), 1.0 / 6.0, 1e-12);
        root_mass += game.chance_probability(root, outcome);
        CHECK(game.child_chance(root, outcome).hole[0] == outcome);
    }
    CHECK_NEAR(root_mass, 1.0, 1e-12);

    const LeducGame::State after_jack = game.child_chance(root, 0);
    CHECK(game.is_chance(after_jack));
    CHECK(game.chance_count(after_jack) == 5);
    CHECK(game.child_chance(after_jack, 0).hole[1] == 1);
    CHECK_NEAR(game.chance_probability(after_jack, 0), 0.2, 1e-12);

    const LeducGame::State jack_vs_queen = deal_hole(game, 0, 2);
    const LeducGame::State jack_vs_other_queen = deal_hole(game, 0, 3);
    const LeducGame::State other_jack_vs_queen = deal_hole(game, 1, 2);
    CHECK(!game.is_chance(jack_vs_queen));
    CHECK(game.infoset(jack_vs_queen) == game.infoset(jack_vs_other_queen));
    CHECK(game.infoset(jack_vs_queen) != game.infoset(other_jack_vs_queen));
    CHECK(game.acting_player(game.infoset(jack_vs_queen)) == 0);

    const LeducGame::State queen_vs_jack = deal_hole(game, 2, 0);
    const LeducGame::State other_queen_vs_jack = deal_hole(game, 3, 0);
    const LeducGame::State checked_a = game.child_action(queen_vs_jack, 0);
    const LeducGame::State checked_b = game.child_action(other_queen_vs_jack, 0);
    CHECK(game.infoset(checked_a) == game.infoset(checked_b));
    CHECK(game.acting_player(game.infoset(checked_a)) == 1);

    const LeducGame::State bet = game.child_action(jack_vs_queen, 1);
    const LeducGame::State folded = game.child_action(bet, 0);
    CHECK(game.is_terminal(folded));
    CHECK_NEAR(game.p1_utility(folded), 1.0, 1e-12);
    CHECK(folded.contrib[0] == 3);
    CHECK(folded.contrib[1] == 1);

    const LeducGame::State called = game.child_action(bet, 1);
    CHECK(game.is_chance(called));
    CHECK(game.chance_count(called) == 4);
    double board_mass = 0.0;
    for (int outcome = 0; outcome < 4; ++outcome)
    {
        board_mass += game.chance_probability(called, outcome);
        const int board = game.child_chance(called, outcome).board;
        CHECK(board != 0);
        CHECK(board != 2);
    }
    CHECK_NEAR(board_mass, 1.0, 1e-12);

    const LeducGame::State king_vs_jack = deal_hole(game, 4, 0);
    LeducGame::State checked_down = game.child_action(king_vs_jack, 0);
    checked_down = game.child_action(checked_down, 0);
    checked_down = deal_board(game, checked_down, 2);
    const int round2_open = game.infoset(checked_down);
    checked_down = game.child_action(checked_down, 0);
    checked_down = game.child_action(checked_down, 0);
    CHECK(game.is_terminal(checked_down));
    CHECK_NEAR(game.p1_utility(checked_down), 1.0, 1e-12);

    LeducGame::State other_board = deal_hole(game, 4, 0);
    other_board = game.child_action(other_board, 0);
    other_board = game.child_action(other_board, 0);
    other_board = deal_board(game, other_board, 3);
    CHECK(game.infoset(other_board) != round2_open);

    LeducGame::State paired = deal_hole(game, 5, 0);
    paired = game.child_action(paired, 1);
    paired = game.child_action(paired, 1);
    CHECK(paired.contrib[0] == 3);
    CHECK(paired.contrib[1] == 3);
    paired = deal_board(game, paired, 4);
    paired = game.child_action(paired, 0);
    paired = game.child_action(paired, 0);
    CHECK(game.is_terminal(paired));
    CHECK_NEAR(game.p1_utility(paired), 3.0, 1e-12);

    LeducGame::State tied = deal_hole(game, 0, 1);
    tied = game.child_action(tied, 0);
    tied = game.child_action(tied, 0);
    tied = deal_board(game, tied, 2);
    tied = game.child_action(tied, 0);
    tied = game.child_action(tied, 0);
    CHECK(game.is_terminal(tied));
    CHECK_NEAR(game.p1_utility(tied), 0.0, 1e-12);

    int terminals = 0;
    walk_terminals(game, game.root(), terminals);
    CHECK(terminals > 0);
    CHECK(game.infoset_count() > 100);
    std::cout << "leduc_terminals " << terminals << "\n";
    std::cout << "leduc_infosets " << game.infoset_count() << "\n";

    poker::solver::CfrTrainer<LeducGame> once(LeducGame{}, poker::solver::Algorithm::VanillaCfr);
    once.run_iterations(2);
    double regret_mass = 0.0;
    double strategy_mass = 0.0;
    for (double regret : once.regrets())
    {
        regret_mass += std::abs(regret);
    }
    for (double sum : once.strategy_sum())
    {
        strategy_mass += std::abs(sum);
    }
    CHECK(regret_mass > 0.0);
    CHECK(strategy_mass > 0.0);

    poker::solver::CfrTrainer<LeducGame> plus_signs(
        LeducGame{}, poker::solver::Algorithm::CfrPlus);
    plus_signs.run_iterations(3);
    for (double regret : plus_signs.regrets())
    {
        CHECK(regret >= 0.0);
    }

    poker::solver::SolveConfig early_config;
    early_config.max_iterations = 20;
    poker::solver::CfrTrainer<LeducGame> early(
        LeducGame{}, poker::solver::Algorithm::VanillaCfr);
    const auto early_stats = early.solve(early_config);
    report_leduc("leduc_vanilla_20", early_stats, game.infoset_count());

    poker::solver::SolveConfig late_config;
    late_config.max_iterations = 200;
    poker::solver::CfrTrainer<LeducGame> late(
        LeducGame{}, poker::solver::Algorithm::VanillaCfr);
    const auto late_stats = late.solve(late_config);
    report_leduc("leduc_vanilla_200", late_stats, game.infoset_count());
    CHECK(late_stats.iterations == 200);
    CHECK(late_stats.runtime_seconds > 0.0);
    CHECK(late_stats.memory_bytes_estimate > 0);
    CHECK(std::isfinite(late_stats.p1_expected_utility));
    CHECK(late_stats.nash_gap < early_stats.nash_gap);
    CHECK(late_stats.nash_gap >= -1e-9);

    poker::solver::CfrTrainer<LeducGame> plus_early(
        LeducGame{}, poker::solver::Algorithm::CfrPlus);
    const auto plus_early_stats = plus_early.solve(early_config);
    poker::solver::CfrTrainer<LeducGame> plus_late(
        LeducGame{}, poker::solver::Algorithm::CfrPlus);
    const auto plus_late_stats = plus_late.solve(late_config);
    report_leduc("leduc_cfr_plus_200", plus_late_stats, game.infoset_count());
    CHECK(plus_late_stats.nash_gap < plus_early_stats.nash_gap);
    CHECK(std::isfinite(plus_late_stats.p1_expected_utility));
    CHECK(plus_late_stats.memory_bytes_estimate == late_stats.memory_bytes_estimate);

    poker::solver::CfrTrainer<LeducGame> again(
        LeducGame{}, poker::solver::Algorithm::VanillaCfr);
    again.run_iterations(15);
    poker::solver::CfrTrainer<LeducGame> again_too(
        LeducGame{}, poker::solver::Algorithm::VanillaCfr);
    again_too.run_iterations(15);
    const auto left = again.average_strategy();
    const auto right = again_too.average_strategy();
    CHECK(left.size() == right.size());
    for (std::size_t i = 0; i < left.size(); ++i)
    {
        CHECK_NEAR(left[i], right[i], 1e-12);
    }
}
