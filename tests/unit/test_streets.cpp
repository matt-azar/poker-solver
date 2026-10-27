#include "harness.hpp"

#include "game/street_game.hpp"
#include "poker/card.hpp"
#include "poker/hand_eval.hpp"
#include "poker/range.hpp"
#include "solver/trainer.hpp"

#include <cmath>
#include <iostream>
#include <span>
#include <stdexcept>
#include <string>
#include <vector>

using poker::holdem::Range;
using poker::streets::StreetConfig;
using poker::streets::StreetGame;

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

int find_action(const StreetGame& game, const StreetGame::State& state, const char* label)
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

StreetGame::State check_through(const StreetGame& game, StreetGame::State state)
{
    while (!game.is_terminal(state) && !game.is_chance(state))
    {
        const int action = find_action(game, state, "Check");
        CHECK(action >= 0);
        state = game.child_action(state, action);
    }
    return state;
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

double showdown_utility(int c0, int c1, int d0, int d1, const int* board, int pot)
{
    const int outcome = poker::holdem::compare_showdown(c0, c1, d0, d1, std::span<const int>(board, 5));
    const double half = static_cast<double>(pot) * 0.5;
    if (outcome > 0)
    {
        return half;
    }
    if (outcome < 0)
    {
        return -half;
    }
    return 0.0;
}

double average_turn_runout(const std::vector<int>& board, int c0, int c1, int d0, int d1, int pot)
{
    bool dead[52] = {};
    for (int card_id : board)
    {
        dead[card_id] = true;
    }
    dead[c0] = true;
    dead[c1] = true;
    dead[d0] = true;
    dead[d1] = true;
    double sum = 0.0;
    int count = 0;
    for (int river = 0; river < 52; ++river)
    {
        if (dead[river])
        {
            continue;
        }
        int full[5] = {board[0], board[1], board[2], board[3], river};
        sum += showdown_utility(c0, c1, d0, d1, full, pot);
        ++count;
    }
    return sum / static_cast<double>(count);
}

double average_flop_runout(const std::vector<int>& board, int c0, int c1, int d0, int d1, int pot)
{
    bool dead[52] = {};
    for (int card_id : board)
    {
        dead[card_id] = true;
    }
    dead[c0] = true;
    dead[c1] = true;
    dead[d0] = true;
    dead[d1] = true;
    double sum = 0.0;
    int count = 0;
    for (int turn = 0; turn < 52; ++turn)
    {
        if (dead[turn])
        {
            continue;
        }
        for (int river = 0; river < 52; ++river)
        {
            if (dead[river] || river == turn)
            {
                continue;
            }
            int full[5] = {board[0], board[1], board[2], turn, river};
            sum += showdown_utility(c0, c1, d0, d1, full, pot);
            ++count;
        }
    }
    return sum / static_cast<double>(count);
}

StreetConfig check_only(const std::vector<int>& board, const char* oop, const char* ip)
{
    StreetConfig config;
    config.board = board;
    config.pot = 100;
    config.stack = 200;
    config.oop = Range::parse(oop);
    config.ip = Range::parse(ip);
    config.max_raises = 0;
    config.allow_all_in = false;
    return config;
}

} // namespace

void run_street_tests()
{
    StreetConfig blocked;
    blocked.board = {card("Ah"), card("Kd"), card("7c"), card("4s")};
    blocked.oop = Range::parse("AhAd");
    blocked.ip = Range::parse("KsKc");
    CHECK(throws_invalid([&] { StreetGame game(blocked); }));

    const std::vector<int> turn_board = {card("Ah"), card("Kd"), card("7c"), card("4s")};
    const StreetGame queens(check_only(turn_board, "QcQd", "JcJd"));
    CHECK(queens.deal_count() == 1);
    const int rivers = 52 - 4 - 4;
    CHECK(queens.infoset_count() == 2 + 2 * rivers);
    CHECK(queens.terminal_count() == rivers);
    poker::solver::SolveConfig once;
    once.max_iterations = 1;
    poker::solver::CfrTrainer<StreetGame> check_solver(queens, poker::solver::Algorithm::VanillaCfr);
    const poker::solver::SolveStats check_stats = check_solver.solve(once);
    const double queens_ev = average_turn_runout(
        turn_board, card("Qc"), card("Qd"), card("Jc"), card("Jd"), 100);
    CHECK_NEAR(check_stats.p1_expected_utility, queens_ev, 1e-9);
    CHECK_NEAR(check_stats.nash_gap, 0.0, 1e-9);

    const StreetGame shared(check_only(turn_board, "AcAd", "KsKc,JhJs"));
    CHECK(shared.deal_count() == 2);
    const StreetGame::State oop0 = shared.child_chance(shared.root(), 0);
    const StreetGame::State oop1 = shared.child_chance(shared.root(), 1);
    CHECK(shared.infoset(oop0) == shared.infoset(oop1));
    const StreetGame::State ip0 = check_through(shared, oop0);
    const StreetGame::State ip1 = check_through(shared, oop1);
    CHECK(shared.is_chance(ip0));
    CHECK(shared.infoset(shared.child_action(oop0, find_action(shared, oop0, "Check")))
        != shared.infoset(shared.child_action(oop1, find_action(shared, oop1, "Check"))));
    const int common_river = card("9c");
    const int out0 = river_outcome(shared, ip0, common_river);
    const int out1 = river_outcome(shared, ip1, common_river);
    CHECK(out0 >= 0);
    CHECK(out1 >= 0);
    const StreetGame::State river0 = shared.child_chance(ip0, out0);
    const StreetGame::State river1 = shared.child_chance(ip1, out1);
    CHECK(river0.river_card == common_river);
    CHECK(shared.infoset(river0) == shared.infoset(river1));
    CHECK(shared.infoset(river0) != shared.infoset(oop0));
    const int other_river = card("8d");
    const StreetGame::State other = shared.child_chance(ip0, river_outcome(shared, ip0, other_river));
    CHECK(shared.infoset(other) != shared.infoset(river0));

    StreetConfig weighted = check_only(turn_board, "AcAd:1,5c5d:3", "KsKc");
    const StreetGame weighted_game(weighted);
    CHECK(weighted_game.deal_count() == 2);
    poker::solver::CfrTrainer<StreetGame> weighted_solver(
        weighted_game, poker::solver::Algorithm::VanillaCfr);
    const poker::solver::SolveStats weighted_stats = weighted_solver.solve(once);
    const double aces = average_turn_runout(
        turn_board, card("Ac"), card("Ad"), card("Ks"), card("Kc"), 100);
    const double fives = average_turn_runout(
        turn_board, card("5c"), card("5d"), card("Ks"), card("Kc"), 100);
    CHECK(std::abs(aces - fives) > 1.0);
    CHECK_NEAR(weighted_stats.p1_expected_utility, 0.25 * aces + 0.75 * fives, 1e-9);
    CHECK_NEAR(weighted_stats.nash_gap, 0.0, 1e-9);

    const std::vector<int> lock_board = {card("Kh"), card("Kd"), card("7c"), card("4s")};
    const StreetGame lock(check_only(lock_board, "AhAd", "2c3d"));
    poker::solver::CfrTrainer<StreetGame> lock_solver(lock, poker::solver::Algorithm::VanillaCfr);
    const poker::solver::SolveStats lock_stats = lock_solver.solve(once);
    CHECK_NEAR(lock_stats.p1_expected_utility, 50.0, 1e-9);
    CHECK_NEAR(average_turn_runout(lock_board, card("Ah"), card("Ad"), card("2c"), card("3d"), 100), 50.0, 1e-9);

    StreetConfig sized;
    sized.board = turn_board;
    sized.pot = 100;
    sized.stack = 200;
    sized.oop = Range::parse("QcQd");
    sized.ip = Range::parse("JcJd");
    sized.oop_bet_sizes = {0.5};
    sized.ip_bet_sizes = {0.5};
    sized.oop_raise_sizes = {};
    sized.ip_raise_sizes = {};
    sized.allow_all_in = false;
    sized.max_raises = 1;
    const StreetGame sized_game(sized);
    StreetGame::State turn = sized_game.child_chance(sized_game.root(), 0);
    turn = sized_game.child_action(turn, find_action(sized_game, turn, "Bet 50"));
    turn = sized_game.child_action(turn, find_action(sized_game, turn, "Call"));
    CHECK(sized_game.is_chance(turn));
    StreetGame::State river = sized_game.child_chance(turn, 0);
    river = sized_game.child_action(river, find_action(sized_game, river, "Check"));
    river = sized_game.child_action(river, find_action(sized_game, river, "Bet 100"));
    river = sized_game.child_action(river, find_action(sized_game, river, "Fold"));
    CHECK(sized_game.is_terminal(river));
    CHECK_NEAR(sized_game.p1_utility(river), -100.0, 1e-9);

    StreetConfig shove;
    shove.board = lock_board;
    shove.pot = 100;
    shove.stack = 100;
    shove.oop = Range::parse("AhAd");
    shove.ip = Range::parse("2c3d");
    shove.oop_bet_sizes = {1.0};
    shove.ip_bet_sizes = {};
    shove.allow_all_in = false;
    shove.max_raises = 1;
    const StreetGame shove_game(shove);
    poker::solver::SolveConfig brief;
    brief.max_iterations = 20;
    poker::solver::SolveConfig longer;
    longer.max_iterations = 400;
    poker::solver::CfrTrainer<StreetGame> brief_trainer(shove_game, poker::solver::Algorithm::CfrPlus);
    poker::solver::CfrTrainer<StreetGame> long_trainer(shove_game, poker::solver::Algorithm::CfrPlus);
    const poker::solver::SolveStats brief_stats = brief_trainer.solve(brief);
    const poker::solver::SolveStats long_stats = long_trainer.solve(longer);
    std::cout << "REPORT street_lock_cfr_plus\n";
    std::cout << "  iterations " << long_stats.iterations << "\n";
    std::cout << "  runtime_seconds " << long_stats.runtime_seconds << "\n";
    std::cout << "  memory_bytes_estimate " << long_stats.memory_bytes_estimate << "\n";
    std::cout << "  infosets " << shove_game.infoset_count() << "\n";
    std::cout << "  decision_nodes " << shove_game.decision_node_count() << "\n";
    std::cout << "  terminals " << shove_game.terminal_count() << "\n";
    std::cout << "  player0_expected_utility " << long_stats.p1_expected_utility << "\n";
    std::cout << "  nash_gap " << long_stats.nash_gap << "\n";
    std::cout << "  gap_at_20 " << brief_stats.nash_gap << "\n";
    CHECK(long_stats.nash_gap < brief_stats.nash_gap);
    CHECK_NEAR(long_stats.p1_expected_utility, 50.0, 1.0);
    CHECK(long_stats.nash_gap < 1.0);

    const std::vector<int> flop_board = {card("Ah"), card("Kd"), card("7c")};
    const StreetGame flop(check_only(flop_board, "QcQd", "JcJd"));
    CHECK(flop.board_count() == 3);
    CHECK(flop.deal_count() == 1);
    const int flop_rivers = (52 - 3 - 4) * (52 - 3 - 4 - 1);
    CHECK(flop.terminal_count() == flop_rivers);
    poker::solver::CfrTrainer<StreetGame> flop_solver(flop, poker::solver::Algorithm::VanillaCfr);
    const poker::solver::SolveStats flop_stats = flop_solver.solve(once);
    const double flop_ev = average_flop_runout(
        flop_board, card("Qc"), card("Qd"), card("Jc"), card("Jd"), 100);
    CHECK_NEAR(flop_stats.p1_expected_utility, flop_ev, 1e-9);
    CHECK_NEAR(flop_stats.nash_gap, 0.0, 1e-9);
    std::cout << "REPORT street_flop_checkdown\n";
    std::cout << "  terminals " << flop.terminal_count() << "\n";
    std::cout << "  infosets " << flop.infoset_count() << "\n";
    std::cout << "  player0_expected_utility " << flop_stats.p1_expected_utility << "\n";
    std::cout << "  enumerated " << flop_ev << "\n";
    std::cout << "  runtime_seconds " << flop_stats.runtime_seconds << "\n";
}
