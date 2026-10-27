#include "harness.hpp"

#include "game/street_game.hpp"
#include "poker/card.hpp"
#include "poker/hand_eval.hpp"
#include "poker/range.hpp"
#include "solver/street_batch.hpp"
#include "solver/trainer.hpp"

#include <chrono>
#include <cmath>
#include <iostream>
#include <map>
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

void expect_street_batch(
    const StreetConfig& config,
    poker::solver::Algorithm algorithm,
    int iterations,
    bool compare_gap)
{
    const StreetGame game(config);
    poker::solver::CfrTrainer<StreetGame> trainer(game, algorithm);
    const auto started = std::chrono::steady_clock::now();
    trainer.run_iterations(iterations);
    const double reference_seconds = std::chrono::duration<double>(
        std::chrono::steady_clock::now() - started).count();

    poker::solver::StreetBatchSolver batch(config);
    const auto fast_started = std::chrono::steady_clock::now();
    batch.run_iterations(iterations, algorithm);
    const double fast_seconds = std::chrono::duration<double>(
        std::chrono::steady_clock::now() - fast_started).count();

    const std::vector<double> strategy = trainer.average_strategy();
    const std::vector<int> offset = poker::solver::action_offsets(game);
    std::map<std::string, double> reference;
    for (int infoset = 0; infoset < game.infoset_count(); ++infoset)
    {
        const int count = game.action_count(infoset);
        const int base = offset[static_cast<std::size_t>(infoset)];
        for (int action = 0; action < count; ++action)
        {
            reference[game.infoset_label(infoset) + "\n" + game.action_label(infoset, action)] =
                strategy[static_cast<std::size_t>(base + action)];
        }
    }

    const std::vector<poker::solver::StreetStrategyEntry> entries = batch.average_strategy_entries();
    CHECK(static_cast<int>(entries.size()) == static_cast<int>(reference.size()));
    CHECK(batch.infoset_count() == game.infoset_count());
    CHECK(batch.regret_entries() == static_cast<int>(strategy.size()));
    CHECK(batch.deal_count() == game.deal_count());
    CHECK(batch.decision_node_count() == game.decision_node_count());
    CHECK(batch.terminal_count() == game.terminal_count());
    double worst = 0.0;
    for (const poker::solver::StreetStrategyEntry& entry : entries)
    {
        const std::string key = entry.infoset + "\n" + entry.action;
        const auto found = reference.find(key);
        CHECK(found != reference.end());
        if (found == reference.end())
        {
            std::cerr << "missing strategy " << key << "\n";
            continue;
        }
        const double gap = std::abs(found->second - entry.probability);
        if (gap > worst)
        {
            worst = gap;
        }
        if (gap > 1e-8)
        {
            std::cerr << "strategy " << key << " reference " << found->second
                      << " batch " << entry.probability << "\n";
        }
        CHECK(gap <= 1e-8);
    }
    std::cout << "REPORT street_batch_match\n";
    std::cout << "  iterations " << iterations << "\n";
    std::cout << "  deals " << game.deal_count() << "\n";
    std::cout << "  infosets " << game.infoset_count() << "\n";
    std::cout << "  public_decisions " << batch.public_decisions() << "\n";
    std::cout << "  reference_cfr_seconds " << reference_seconds << "\n";
    std::cout << "  batch_cfr_seconds " << fast_seconds << "\n";
    std::cout << "  max_strategy_abs_diff " << worst << "\n";
    if (!compare_gap)
    {
        return;
    }
    const poker::solver::SolveStats stats = trainer.evaluate();
    CHECK_NEAR(batch.expected_utility(), stats.p1_expected_utility, 1e-8);
    CHECK_NEAR(batch.nash_gap(), stats.nash_gap, 1e-6);
    CHECK_NEAR(batch.p1_best_response_utility(), stats.p1_best_response_utility, 1e-6);
    CHECK_NEAR(batch.p2_best_response_utility(), stats.p2_best_response_utility, 1e-6);
}

double strategy_probability(
    const std::vector<poker::solver::StreetStrategyEntry>& entries,
    const char* player_and_hand,
    const char* action_prefix,
    bool facing_bet)
{
    double probability = -1.0;
    const std::string hand(player_and_hand);
    const std::string action(action_prefix);
    for (const poker::solver::StreetStrategyEntry& entry : entries)
    {
        if (entry.infoset.find(hand) == std::string::npos)
        {
            continue;
        }
        if (entry.infoset.find("river") != std::string::npos)
        {
            continue;
        }
        const bool bet_line = entry.infoset.find("Bet") != std::string::npos;
        if (bet_line != facing_bet)
        {
            continue;
        }
        if (entry.action.rfind(action, 0) != 0)
        {
            continue;
        }
        probability = entry.probability;
    }
    return probability;
}

// Kh Kd 7c 4s. OOP holds KcKs and 2c3d. IP holds AhAd. Pot 100, one hundred behind.
// OOP can check or shove the turn. IP can fold or call. A check checks the river down.
// The equilibrium bets every king, bluffs half the air, calls half the time, and is worth 25.
void expect_turn_bluff_equilibrium()
{
    StreetConfig config;
    config.board = {card("Kh"), card("Kd"), card("7c"), card("4s")};
    config.pot = 100;
    config.stack = 100;
    config.oop = Range::parse("KcKs,2c3d");
    config.ip = Range::parse("AhAd");
    config.oop_turn_bets = {1.0};
    config.allow_all_in = false;
    config.max_raises = 1;
    poker::solver::StreetBatchSolver frozen(config);
    frozen.run_frozen_iterations(4000, poker::solver::Algorithm::CfrPlus);
    const std::vector<poker::solver::StreetStrategyEntry> entries = frozen.average_strategy_entries();
    const double bet_nuts = strategy_probability(entries, "OOP KcKs", "Bet", false);
    const double bet_air = strategy_probability(entries, "OOP 2c3d", "Bet", false);
    const double call = strategy_probability(entries, "IP AhAd", "Call", true);
    const double value = frozen.expected_utility();
    const double gap = frozen.nash_gap();
    const double nuts_ev = 50.0 + bet_nuts * 100.0 * call;
    const double air_ev = (1.0 - bet_air) * -50.0 + bet_air * (50.0 - 200.0 * call);
    const double closed_form = 0.5 * nuts_ev + 0.5 * air_ev;
    std::cout << "REPORT turn_bluff_equilibrium\n";
    std::cout << "  bet_nuts " << bet_nuts << "\n";
    std::cout << "  bet_air " << bet_air << "\n";
    std::cout << "  call " << call << "\n";
    std::cout << "  value " << value << "\n";
    std::cout << "  closed_form " << closed_form << "\n";
    std::cout << "  nash_gap " << gap << "\n";
    CHECK(bet_nuts > 0.98);
    CHECK(std::abs(bet_air - 0.5) < 0.05);
    CHECK(std::abs(call - 0.5) < 0.05);
    CHECK_NEAR(value, closed_form, 1e-6);
    CHECK_NEAR(value, 25.0, 0.05);
    CHECK(gap < 0.15);
    CHECK(gap >= -1e-9);

    const StreetGame game(config);
    poker::solver::CfrTrainer<StreetGame> per_deal(game, poker::solver::Algorithm::CfrPlus);
    per_deal.run_iterations(4000);
    const poker::solver::SolveStats per_deal_stats = per_deal.evaluate();
    std::cout << "  per_deal_value " << per_deal_stats.p1_expected_utility << "\n";
    std::cout << "  per_deal_gap " << per_deal_stats.nash_gap << "\n";
    CHECK_NEAR(per_deal_stats.p1_expected_utility, 25.0, 0.05);
    CHECK(per_deal_stats.nash_gap < 0.15);
}

} // namespace

void run_tree_rule_tests(const std::vector<int>& turn_board);

void run_street_tests()
{
    StreetConfig blocked;
    blocked.board = {card("Ah"), card("Kd"), card("7c"), card("4s")};
    blocked.oop = Range::parse("AhAd");
    blocked.ip = Range::parse("KsKc");
    CHECK(throws_invalid([&] { StreetGame game(blocked); }));

    const std::vector<int> turn_board = {card("Ah"), card("Kd"), card("7c"), card("4s")};
    {
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

    const double flop_geometric = (std::pow(7.0, 1.0 / 3.0) - 1.0) / 2.0;
    CHECK_NEAR(poker::streets::geometric_pot_fraction(100, 300, 3), flop_geometric, 1e-12);
    CHECK_NEAR(poker::streets::geometric_pot_fraction(100, 300, 1), 3.0, 1e-12);

    StreetConfig geo;
    geo.board = turn_board;
    geo.pot = 100;
    geo.stack = 300;
    geo.oop = Range::parse("QcQd");
    geo.ip = Range::parse("JcJd");
    geo.geometric = true;
    geo.allow_all_in = true;
    geo.max_raises = 1;
    const StreetGame geo_game(geo);
    const StreetGame::State geo_open = geo_game.child_chance(geo_game.root(), 0);
    const int geo_chips = static_cast<int>(std::llround(
        poker::streets::geometric_pot_fraction(100, 300, 2) * 100.0));
    const std::string geo_label = "Bet " + std::to_string(geo_chips);
    CHECK(find_action(geo_game, geo_open, geo_label.c_str()) >= 0);
    StreetGame::State geo_called = geo_game.child_action(
        geo_open, find_action(geo_game, geo_open, geo_label.c_str()));
    geo_called = geo_game.child_action(geo_called, find_action(geo_game, geo_called, "Call"));
    CHECK(geo_game.is_chance(geo_called));
    const StreetGame::State geo_river = geo_game.child_chance(geo_called, 0);
    const int river_stack = 300 - geo_chips;
    CHECK(find_action(geo_game, geo_river, ("Bet " + std::to_string(river_stack) + " all-in").c_str()) >= 0);
    const int geo_river_index = river_outcome(geo_game, geo_called, card("9c"));
    const StreetGame::State geo_other = geo_game.child_chance(geo_called, geo_river_index);
    CHECK(geo_game.action_count(geo_game.infoset(geo_river))
        == geo_game.action_count(geo_game.infoset(geo_other)));

    StreetConfig by_street;
    by_street.board = turn_board;
    by_street.pot = 100;
    by_street.stack = 400;
    by_street.oop = Range::parse("QcQd");
    by_street.ip = Range::parse("JcJd");
    by_street.oop_turn_bets = {0.5};
    by_street.oop_river_bets = {1.0};
    by_street.allow_all_in = false;
    by_street.max_raises = 1;
    const StreetGame by_street_game(by_street);
    const StreetGame::State turn_open = by_street_game.child_chance(by_street_game.root(), 0);
    CHECK(find_action(by_street_game, turn_open, "Bet 50") >= 0);
    StreetGame::State called = by_street_game.child_action(
        turn_open, find_action(by_street_game, turn_open, "Bet 50"));
    called = by_street_game.child_action(called, find_action(by_street_game, called, "Call"));
    const StreetGame::State river_open = by_street_game.child_chance(called, 0);
    CHECK(find_action(by_street_game, river_open, "Bet 200") >= 0);

    StreetConfig threshold;
    threshold.board = turn_board;
    threshold.pot = 100;
    threshold.stack = 200;
    threshold.oop = Range::parse("QcQd");
    threshold.ip = Range::parse("JcJd");
    threshold.oop_bet_sizes = {0.5};
    threshold.allow_all_in = true;
    threshold.all_in_threshold = 0.2;
    threshold.max_raises = 1;
    const StreetGame snapped(threshold);
    const StreetGame::State snapped_open = snapped.child_chance(snapped.root(), 0);
    CHECK(find_action(snapped, snapped_open, "Bet 200 all-in") >= 0);
    CHECK(find_action(snapped, snapped_open, "Bet 50") < 0);
    threshold.all_in_threshold = 0.4;
    const StreetGame kept(threshold);
    const StreetGame::State kept_open = kept.child_chance(kept.root(), 0);
    CHECK(find_action(kept, kept_open, "Bet 50") >= 0);

    expect_street_batch(check_only(turn_board, "QcQd", "JcJd"), poker::solver::Algorithm::VanillaCfr, 1, true);

    StreetConfig shared_bets;
    shared_bets.board = {card("Kh"), card("Kd"), card("7c"), card("4s")};
    shared_bets.pot = 100;
    shared_bets.stack = 100;
    shared_bets.oop = Range::parse("AcAd,5c5d");
    shared_bets.ip = Range::parse("2c3d");
    shared_bets.oop_bet_sizes = {1.0};
    shared_bets.ip_bet_sizes = {1.0};
    shared_bets.allow_all_in = false;
    shared_bets.max_raises = 1;
    expect_street_batch(shared_bets, poker::solver::Algorithm::CfrPlus, 12, true);

    StreetConfig per_street = shared_bets;
    per_street.oop = Range::parse("AcAd");
    per_street.oop_bet_sizes = {0.5};
    per_street.oop_turn_bets = {0.5};
    per_street.oop_river_bets = {1.0};
    per_street.ip_bet_sizes = {};
    per_street.stack = 400;
    expect_street_batch(per_street, poker::solver::Algorithm::VanillaCfr, 3, false);

    StreetConfig geo_match;
    geo_match.board = turn_board;
    geo_match.pot = 100;
    geo_match.stack = 300;
    geo_match.oop = Range::parse("QcQd");
    geo_match.ip = Range::parse("JcJd");
    geo_match.geometric = true;
    geo_match.allow_all_in = true;
    geo_match.max_raises = 1;
    expect_street_batch(geo_match, poker::solver::Algorithm::VanillaCfr, 2, false);

    const std::vector<int> flop_only = {card("Ah"), card("Kd"), card("7c")};
    expect_street_batch(check_only(flop_only, "QcQd", "JcJd"), poker::solver::Algorithm::VanillaCfr, 1, true);

    CHECK(throws_invalid([&] {
        poker::solver::StreetBatchSolver batch(check_only(turn_board, "QcQd", "JcJd"));
        batch.run_iterations(1, poker::solver::Algorithm::LinearCfr);
    }));

    poker::solver::StreetBatchSolver continued(shared_bets);
    poker::solver::StreetBatchSolver restarted(shared_bets);
    continued.continue_iterations(2, poker::solver::Algorithm::CfrPlus);
    continued.continue_iterations(2, poker::solver::Algorithm::CfrPlus);
    restarted.run_iterations(4, poker::solver::Algorithm::CfrPlus);
    const std::vector<poker::solver::StreetStrategyEntry> left = continued.average_strategy_entries();
    const std::vector<poker::solver::StreetStrategyEntry> right = restarted.average_strategy_entries();
    CHECK(left.size() == right.size());
    for (std::size_t i = 0; i < left.size(); ++i)
    {
        CHECK(left[i].infoset == right[i].infoset);
        CHECK(left[i].action == right[i].action);
        CHECK_NEAR(left[i].probability, right[i].probability, 1e-12);
    }

    poker::solver::StreetBatchSolver frozen_check(check_only(turn_board, "QcQd", "JcJd"));
    frozen_check.run_frozen_iterations(1, poker::solver::Algorithm::VanillaCfr);
    CHECK_NEAR(frozen_check.expected_utility(), queens_ev, 1e-9);
    CHECK_NEAR(frozen_check.nash_gap(), 0.0, 1e-8);

    const std::vector<int> flop_frozen_board = {card("Ah"), card("Kd"), card("7c")};
    const double flop_frozen_ev = average_flop_runout(
        flop_frozen_board, card("Qc"), card("Qd"), card("Jc"), card("Jd"), 100);
    poker::solver::StreetBatchSolver frozen_flop(check_only(flop_frozen_board, "QcQd", "JcJd"));
    frozen_flop.run_frozen_iterations(1, poker::solver::Algorithm::VanillaCfr);
    CHECK_NEAR(frozen_flop.expected_utility(), flop_frozen_ev, 1e-9);
    CHECK_NEAR(frozen_flop.nash_gap(), 0.0, 1e-8);

    StreetConfig frozen_lock;
    frozen_lock.board = {card("Kh"), card("Kd"), card("7c"), card("4s")};
    frozen_lock.pot = 100;
    frozen_lock.stack = 100;
    frozen_lock.oop = Range::parse("AhAd");
    frozen_lock.ip = Range::parse("2c3d");
    frozen_lock.oop_bet_sizes = {1.0};
    frozen_lock.ip_bet_sizes = {1.0};
    frozen_lock.allow_all_in = false;
    frozen_lock.max_raises = 1;
    poker::solver::StreetBatchSolver frozen_brief(frozen_lock);
    poker::solver::StreetBatchSolver frozen_long(frozen_lock);
    const auto frozen_started = std::chrono::steady_clock::now();
    frozen_brief.run_frozen_iterations(20, poker::solver::Algorithm::CfrPlus);
    frozen_long.run_frozen_iterations(400, poker::solver::Algorithm::CfrPlus);
    const double frozen_seconds = std::chrono::duration<double>(
        std::chrono::steady_clock::now() - frozen_started).count();
    const double frozen_gap_20 = frozen_brief.nash_gap();
    const double frozen_gap_400 = frozen_long.nash_gap();
    const double frozen_value = frozen_long.expected_utility();
    std::cout << "REPORT street_frozen_lock\n";
    std::cout << "  runtime_seconds " << frozen_seconds << "\n";
    std::cout << "  player0_expected_utility " << frozen_value << "\n";
    std::cout << "  nash_gap " << frozen_gap_400 << "\n";
    std::cout << "  gap_at_20 " << frozen_gap_20 << "\n";
    CHECK_NEAR(frozen_value, 50.0, 1.0);
    CHECK(frozen_gap_400 < frozen_gap_20);
    CHECK(frozen_gap_400 < 1.0);
    }

    run_tree_rule_tests(turn_board);
    expect_turn_bluff_equilibrium();
}

void run_tree_rule_tests(const std::vector<int>& turn_board)
{
    {
        StreetConfig fixed_chips;
        fixed_chips.board = turn_board;
        fixed_chips.pot = 100;
        fixed_chips.stack = 300;
        fixed_chips.oop = Range::parse("QcQd");
        fixed_chips.ip = Range::parse("JcJd");
        fixed_chips.oop_bet_sizes = {-20.0};
        fixed_chips.ip_bet_sizes = {};
        fixed_chips.allow_all_in = false;
        fixed_chips.max_raises = 1;
        {
            const StreetGame fixed_game(fixed_chips);
            const StreetGame::State fixed_open = fixed_game.child_chance(fixed_game.root(), 0);
            CHECK(find_action(fixed_game, fixed_open, "Bet 20") >= 0);
            CHECK(find_action(fixed_game, fixed_open, "Bet 100") < 0);
        }
        expect_street_batch(fixed_chips, poker::solver::Algorithm::VanillaCfr, 1, false);
    }

    {
        StreetConfig multiple;
        multiple.board = turn_board;
        multiple.pot = 100;
        multiple.stack = 800;
        multiple.oop = Range::parse("QcQd");
        multiple.ip = Range::parse("JcJd");
        multiple.oop_bet_sizes = {0.5};
        multiple.ip_bet_sizes = {};
        multiple.ip_raise_multiples = {3.0};
        multiple.allow_all_in = false;
        multiple.max_raises = 2;
        const StreetGame multiple_game(multiple);
        StreetGame::State faced = multiple_game.child_chance(multiple_game.root(), 0);
        faced = multiple_game.child_action(faced, find_action(multiple_game, faced, "Bet 50"));
        CHECK(find_action(multiple_game, faced, "Raise to 150") >= 0);
    }

    {
        StreetConfig capped;
        capped.board = turn_board;
        capped.pot = 100;
        capped.stack = 500;
        capped.oop = Range::parse("QcQd");
        capped.ip = Range::parse("JcJd");
        capped.oop_bet_sizes = {2.0};
        capped.ip_bet_sizes = {};
        capped.pot_cap = 1.0;
        capped.allow_all_in = true;
        capped.max_raises = 1;
        const StreetGame capped_game(capped);
        const StreetGame::State capped_open = capped_game.child_chance(capped_game.root(), 0);
        CHECK(find_action(capped_game, capped_open, "Bet 100") >= 0);
        CHECK(find_action(capped_game, capped_open, "Bet 200") < 0);
        CHECK(find_action(capped_game, capped_open, "Bet 500 all-in") < 0);
    }

    {
        StreetConfig no_three_bet;
        no_three_bet.board = turn_board;
        no_three_bet.pot = 100;
        no_three_bet.stack = 800;
        no_three_bet.oop = Range::parse("QcQd");
        no_three_bet.ip = Range::parse("JcJd");
        no_three_bet.oop_bet_sizes = {0.5};
        no_three_bet.ip_bet_sizes = {0.5};
        no_three_bet.oop_raise_sizes = {0.5};
        no_three_bet.ip_raise_sizes = {0.5};
        no_three_bet.allow_three_bet = false;
        no_three_bet.allow_all_in = false;
        no_three_bet.max_raises = 4;
        const StreetGame no_three_game(no_three_bet);
        StreetGame::State reraise = no_three_game.child_chance(no_three_game.root(), 0);
        reraise = no_three_game.child_action(reraise, find_action(no_three_game, reraise, "Bet 50"));
        const int raised = find_action(no_three_game, reraise, "Raise to 150");
        CHECK(raised >= 0);
        reraise = no_three_game.child_action(reraise, raised);
        CHECK(no_three_game.action_count(no_three_game.infoset(reraise)) == 2);
        CHECK(find_action(no_three_game, reraise, "Fold") >= 0);
        CHECK(find_action(no_three_game, reraise, "Call") >= 0);
    }

    {
        StreetConfig donk;
        donk.board = {card("Ah"), card("Kd"), card("7c")};
        donk.pot = 100;
        donk.stack = 500;
        donk.oop = Range::parse("QcQd");
        donk.ip = Range::parse("JcJd");
        donk.oop_bet_sizes = {1.0};
        donk.ip_bet_sizes = {0.5};
        donk.oop_donk_sizes = {-40.0};
        donk.allow_all_in = false;
        donk.max_raises = 1;
        {
            const StreetGame donk_game(donk);
            StreetGame::State flop_open = donk_game.child_chance(donk_game.root(), 0);
            flop_open = donk_game.child_action(flop_open, find_action(donk_game, flop_open, "Check"));
            flop_open = donk_game.child_action(flop_open, find_action(donk_game, flop_open, "Bet 50"));
            flop_open = donk_game.child_action(flop_open, find_action(donk_game, flop_open, "Call"));
            CHECK(donk_game.is_chance(flop_open));
            const StreetGame::State donk_turn = donk_game.child_chance(flop_open, 0);
            CHECK(find_action(donk_game, donk_turn, "Bet 40") >= 0);
            CHECK(find_action(donk_game, donk_turn, "Bet 200") < 0);
            StreetGame::State checked = donk_game.child_chance(donk_game.root(), 0);
            checked = donk_game.child_action(checked, find_action(donk_game, checked, "Check"));
            checked = donk_game.child_action(checked, find_action(donk_game, checked, "Check"));
            CHECK(donk_game.is_chance(checked));
            const StreetGame::State probed = donk_game.child_chance(checked, 0);
            CHECK(find_action(donk_game, probed, "Bet 100") >= 0);
            CHECK(find_action(donk_game, probed, "Bet 40") < 0);
        }
        expect_street_batch(donk, poker::solver::Algorithm::VanillaCfr, 1, false);
    }
}
