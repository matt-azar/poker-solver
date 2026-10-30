#include "harness.hpp"

#include "game/river_game.hpp"
#include "game/street_config_text.hpp"
#include "game/street_game.hpp"
#include "poker/card.hpp"
#include "poker/hand_eval.hpp"
#include "poker/range.hpp"
#include "solver/street_batch.hpp"
#include "solver/trainer.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <map>
#include <span>
#include <stdexcept>
#include <string>
#include <vector>

using poker::holdem::Range;
using poker::river::RiverConfig;
using poker::river::RiverGame;
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

StreetConfig street_from_river(const RiverConfig& river)
{
    StreetConfig config;
    config.board.assign(river.board.begin(), river.board.end());
    config.pot = river.pot;
    config.stack = river.stack;
    config.oop = river.oop;
    config.ip = river.ip;
    config.oop_bet_sizes = river.oop_bet_sizes;
    config.ip_bet_sizes = river.ip_bet_sizes;
    config.oop_raise_sizes = river.oop_raise_sizes;
    config.ip_raise_sizes = river.ip_raise_sizes;
    config.allow_all_in = river.allow_all_in;
    config.max_raises = river.max_raises;
    config.first_to_act = river.first_to_act;
    return config;
}

void expect_street_matches_river(
    const RiverConfig& river,
    poker::solver::Algorithm algorithm,
    int iterations,
    bool compare_gap)
{
    const RiverGame game(river);
    poker::solver::CfrTrainer<RiverGame> trainer(game, algorithm);
    trainer.run_iterations(iterations);

    const StreetConfig street = street_from_river(river);
    poker::solver::StreetBatchSolver batch(street);
    batch.run_iterations(iterations, algorithm);

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
    CHECK(batch.public_decisions() * batch.deal_count() == game.decision_node_count());
    CHECK(batch.public_terminals() * batch.deal_count() == game.terminal_count());
    double worst = 0.0;
    for (const poker::solver::StreetStrategyEntry& entry : entries)
    {
        const std::string key = entry.infoset + "\n" + entry.action;
        const auto found = reference.find(key);
        CHECK(found != reference.end());
        if (found == reference.end())
        {
            std::cerr << "missing five-card street strategy " << key << "\n";
            continue;
        }
        const double gap = std::abs(found->second - entry.probability);
        if (gap > worst)
        {
            worst = gap;
        }
        if (gap > 1e-8)
        {
            std::cerr << "five-card street strategy " << key << " river " << found->second
                      << " street " << entry.probability << "\n";
        }
        CHECK(gap <= 1e-8);
    }
    std::cout << "REPORT street_five_card_river_match\n";
    std::cout << "  iterations " << iterations << "\n";
    std::cout << "  deals " << game.deal_count() << "\n";
    std::cout << "  infosets " << game.infoset_count() << "\n";
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

std::string combo_name(const char* a, const char* b)
{
    return Range::combo_text(Range::combo_index(card(a), card(b)));
}

bool one_turn_action(
    const std::vector<poker::solver::StreetStrategyEntry>& entries,
    const std::string& hand,
    const char* action_prefix,
    bool facing_bet,
    double& probability)
{
    int matches = 0;
    probability = -1.0;
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
        if (entry.action.rfind(action_prefix, 0) != 0)
        {
            continue;
        }
        probability = entry.probability;
        ++matches;
    }
    return matches == 1;
}

std::vector<poker::solver::StreetStrategyEntry> trainer_entries(
    const StreetGame& game,
    const poker::solver::CfrTrainer<StreetGame>& trainer)
{
    const std::vector<double> strategy = trainer.average_strategy();
    const std::vector<int> offset = poker::solver::action_offsets(game);
    std::vector<poker::solver::StreetStrategyEntry> entries;
    for (int infoset = 0; infoset < game.infoset_count(); ++infoset)
    {
        const int count = game.action_count(infoset);
        const int base = offset[static_cast<std::size_t>(infoset)];
        for (int action = 0; action < count; ++action)
        {
            poker::solver::StreetStrategyEntry entry;
            entry.infoset = game.infoset_label(infoset);
            entry.action = game.action_label(infoset, action);
            entry.probability = strategy[static_cast<std::size_t>(base + action)];
            entries.push_back(std::move(entry));
        }
    }
    return entries;
}

void check_bluff_profile(
    const std::vector<poker::solver::StreetStrategyEntry>& entries,
    double value,
    double gap,
    const char* tag)
{
    double bet_nuts = -1.0;
    double bet_air = -1.0;
    double call = -1.0;
    const bool nuts_found = one_turn_action(
        entries, "OOP " + combo_name("Kc", "Ks"), "Bet", false, bet_nuts);
    const bool air_found = one_turn_action(
        entries, "OOP " + combo_name("2c", "3d"), "Bet", false, bet_air);
    const bool call_found = one_turn_action(
        entries, "IP " + combo_name("Ah", "Ad"), "Call", true, call);
    CHECK(nuts_found);
    CHECK(air_found);
    CHECK(call_found);
    const double ev = 50.0 * bet_nuts * call + 50.0 * bet_air * (1.0 - 2.0 * call);
    const double br0 = 50.0 * std::max(call, 1.0 - call);
    const double min_ev = 50.0 * std::min(bet_air, bet_nuts - bet_air);
    const double nash = (br0 - ev) + (ev - min_ev);
    std::cout << "REPORT turn_bluff_" << tag << "\n";
    std::cout << "  bet_nuts " << bet_nuts << "\n";
    std::cout << "  bet_air " << bet_air << "\n";
    std::cout << "  call " << call << "\n";
    std::cout << "  value " << value << "\n";
    std::cout << "  formula_ev " << ev << "\n";
    std::cout << "  formula_nash " << nash << "\n";
    std::cout << "  nash_gap " << gap << "\n";
    CHECK(bet_nuts >= 0.9999);
    CHECK(std::abs(bet_air - 0.5) <= 0.001);
    CHECK(std::abs(call - 0.5) <= 0.001);
    CHECK(std::abs(value - 25.0) <= 0.01);
    CHECK(gap <= 0.1);
    CHECK(gap >= -1e-9);
    CHECK_NEAR(value, ev, 1e-8);
    CHECK_NEAR(gap, nash, 1e-8);
}

void expect_strategy_parity(
    const std::vector<poker::solver::StreetStrategyEntry>& frozen,
    const std::vector<poker::solver::StreetStrategyEntry>& reference)
{
    std::map<std::string, double> by_key;
    for (const poker::solver::StreetStrategyEntry& entry : reference)
    {
        by_key[entry.infoset + "\n" + entry.action] = entry.probability;
    }
    CHECK(frozen.size() == reference.size());
    for (const poker::solver::StreetStrategyEntry& entry : frozen)
    {
        const auto found = by_key.find(entry.infoset + "\n" + entry.action);
        CHECK(found != by_key.end());
        if (found == by_key.end())
        {
            std::cerr << "missing frozen strategy " << entry.infoset << " " << entry.action << "\n";
            continue;
        }
        if (std::abs(found->second - entry.probability) > 1e-8)
        {
            std::cerr << "strategy " << entry.infoset << " " << entry.action
                      << " reference " << found->second
                      << " frozen " << entry.probability << "\n";
        }
        CHECK_NEAR(found->second, entry.probability, 1e-8);
    }
}

// Kh Kd 7c 4s. OOP holds KsKc and 3d2c. IP holds AhAd. Pot 100, one hundred behind.
// OOP checks or shoves the turn. IP folds or calls. A check checks the river down.
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

    {
        poker::solver::StreetBatchSolver frozen(config);
        frozen.run_frozen_iterations(3, poker::solver::Algorithm::CfrPlus);
        const StreetGame game(config);
        poker::solver::CfrTrainer<StreetGame> per_deal(game, poker::solver::Algorithm::CfrPlus);
        per_deal.run_iterations(3);
        expect_strategy_parity(frozen.average_strategy_entries(), trainer_entries(game, per_deal));
    }

    poker::solver::StreetBatchSolver frozen(config);
    frozen.run_frozen_iterations(4000, poker::solver::Algorithm::CfrPlus);
    check_bluff_profile(
        frozen.average_strategy_entries(),
        frozen.expected_utility(),
        frozen.nash_gap(),
        "frozen");

    const StreetGame game(config);
    poker::solver::CfrTrainer<StreetGame> per_deal(game, poker::solver::Algorithm::CfrPlus);
    per_deal.run_iterations(4000);
    const poker::solver::SolveStats stats = per_deal.evaluate();
    check_bluff_profile(
        trainer_entries(game, per_deal),
        stats.p1_expected_utility,
        stats.nash_gap,
        "per_deal");
    expect_strategy_parity(frozen.average_strategy_entries(), trainer_entries(game, per_deal));
}

void expect_support_hole()
{
    const std::vector<int> board = {card("Ah"), card("Kd"), card("7c"), card("4s")};
    StreetConfig config = check_only(board, "QcQd,JsJd", "QcTc,JhTh");
    poker::solver::StreetBatchSolver solver(config);
    const std::vector<poker::solver::StreetStrategyEntry> entries = solver.average_strategy_entries();
    const std::string blocked = "OOP " + combo_name("Qc", "Qd");
    const std::string live = "OOP " + combo_name("Js", "Jd");
    bool blocked_on_jh = false;
    bool live_on_jh = false;
    for (const poker::solver::StreetStrategyEntry& entry : entries)
    {
        if (entry.infoset.find("river Jh") == std::string::npos)
        {
            continue;
        }
        if (entry.infoset.find(blocked) != std::string::npos)
        {
            blocked_on_jh = true;
        }
        if (entry.infoset.find(live) != std::string::npos)
        {
            live_on_jh = true;
        }
    }
    CHECK(!blocked_on_jh);
    CHECK(live_on_jh);
    solver.run_frozen_iterations(1, poker::solver::Algorithm::VanillaCfr);
    CHECK(std::isfinite(solver.expected_utility()));
    CHECK(std::isfinite(solver.nash_gap()));
}

std::string action_named(
    const std::vector<poker::solver::StreetStrategyEntry>& entries,
    const std::string& infoset,
    const char* prefix)
{
    for (const poker::solver::StreetStrategyEntry& entry : entries)
    {
        if (entry.infoset == infoset && entry.action.rfind(prefix, 0) == 0)
        {
            return entry.action;
        }
    }
    std::cerr << "missing action " << infoset << " " << prefix << "\n";
    for (const poker::solver::StreetStrategyEntry& entry : entries)
    {
        if (entry.infoset.find("AhAd") != std::string::npos
            || entry.infoset.find("3d2c") != std::string::npos)
        {
            std::cerr << "  " << entry.infoset << " / " << entry.action << "\n";
        }
    }
    return {};
}

// Turn shove has probability zero, so the river after a check has no strategic
// reach. Its counterfactual bet regret is still nonzero, and its average stays
// uniform because the average weight is own reach.
void expect_zero_own_reach()
{
    StreetConfig config;
    config.board = {card("Kh"), card("Kd"), card("7c"), card("4s")};
    config.pot = 100;
    config.stack = 100;
    config.oop = Range::parse("AhAd");
    config.ip = Range::parse("2c3d");
    config.oop_turn_bets = {1.0};
    config.oop_river_bets = {1.0};
    config.allow_all_in = false;
    config.max_raises = 1;
    poker::solver::StreetBatchSolver solver(config);
    const std::vector<poker::solver::StreetStrategyEntry> entries = solver.average_strategy_entries();
    const std::string turn_open = "OOP " + combo_name("Ah", "Ad") + " | turn | open";
    const std::string turn_bet = action_named(entries, turn_open, "Bet");
    const std::string river = "OOP " + combo_name("Ah", "Ad") + " | river 9c | Check/Check";
    const std::string river_bet = action_named(entries, river, "Bet");
    CHECK(!turn_bet.empty());
    CHECK(!river_bet.empty());
    CHECK(solver.set_regret(turn_open, "Check", 0.0));
    CHECK(solver.set_regret(turn_open, turn_bet, 1.0));
    solver.continue_frozen_iterations(1, poker::solver::Algorithm::CfrPlus);
    double regret = 0.0;
    CHECK(solver.regret_value(river, river_bet, regret));
    CHECK(regret > 1.0);
    double probability = -1.0;
    int matches = 0;
    for (const poker::solver::StreetStrategyEntry& entry : solver.average_strategy_entries())
    {
        if (entry.infoset == river && entry.action == river_bet)
        {
            probability = entry.probability;
            ++matches;
        }
    }
    CHECK(matches == 1);
    CHECK_NEAR(probability, 0.5, 1e-12);
}

// IP never calls, so the river after a call has zero opponent reach. OOP's own
// reach is positive, and the average still records the frozen river strategy.
void expect_average_without_opponent_reach()
{
    StreetConfig config;
    config.board = {card("Kh"), card("Kd"), card("7c"), card("4s")};
    config.pot = 100;
    config.stack = 200;
    config.oop = Range::parse("AhAd");
    config.ip = Range::parse("2c3d");
    config.oop_turn_bets = {0.5};
    config.oop_river_bets = {0.25};
    config.allow_all_in = false;
    config.max_raises = 1;
    poker::solver::StreetBatchSolver solver(config);
    const std::vector<poker::solver::StreetStrategyEntry> entries = solver.average_strategy_entries();
    const std::string oop = "OOP " + combo_name("Ah", "Ad");
    const std::string ip = "IP " + combo_name("2c", "3d");
    const std::string turn_open = oop + " | turn | open";
    const std::string turn_bet = action_named(entries, turn_open, "Bet");
    const std::string facing = ip + " | turn | " + turn_bet;
    const std::string river = oop + " | river 9c | " + turn_bet + "/Call";
    const std::string river_bet = action_named(entries, river, "Bet");
    CHECK(!turn_bet.empty());
    CHECK(!river_bet.empty());
    CHECK(solver.set_regret(turn_open, "Check", 0.0));
    CHECK(solver.set_regret(turn_open, turn_bet, 1.0));
    CHECK(solver.set_regret(facing, "Fold", 1.0));
    CHECK(solver.set_regret(facing, "Call", 0.0));
    CHECK(solver.set_regret(river, "Check", 0.0));
    CHECK(solver.set_regret(river, river_bet, 1.0));
    solver.continue_frozen_iterations(1, poker::solver::Algorithm::CfrPlus);
    double probability = -1.0;
    int matches = 0;
    for (const poker::solver::StreetStrategyEntry& entry : solver.average_strategy_entries())
    {
        if (entry.infoset == river && entry.action == river_bet)
        {
            probability = entry.probability;
            ++matches;
        }
    }
    CHECK(matches == 1);
    CHECK_NEAR(probability, 1.0, 1e-12);
}

} // namespace

void run_tree_rule_tests(const std::vector<int>& turn_board);
void expect_canonical_street_config();

std::uint64_t component_bytes(
    const poker::solver::StreetMemoryReport& report,
    const char* name)
{
    for (const poker::solver::StreetMemoryComponent& component : report.components)
    {
        if (component.name == name)
        {
            return component.bytes;
        }
    }
    return 0;
}

void expect_memory_budget()
{
    StreetConfig zero = check_only(
        {card("Ah"), card("Kd"), card("7c"), card("4s")}, "AcAd", "KsKc");
    zero.memory_mib = 0;
    std::string zero_message;
    try
    {
        poker::solver::StreetBatchSolver solver(zero);
    }
    catch (const std::invalid_argument& error)
    {
        zero_message = error.what();
    }
    CHECK(zero_message.find("positive") != std::string::npos);

    const std::vector<int> flop = {card("Ah"), card("Kd"), card("7c")};
    StreetConfig wide = check_only(flop, "77+", "77+");
    wide.memory_mib = 1;
    std::string denied;
    try
    {
        poker::solver::StreetBatchSolver solver(wide);
    }
    catch (const std::invalid_argument& error)
    {
        denied = error.what();
    }
    CHECK(denied.find("memory budget") != std::string::npos);
    CHECK(denied.find("budget ") != std::string::npos);
    CHECK(denied.find("allocated ") != std::string::npos);
    CHECK(denied.find("request ") != std::string::npos);

    wide.memory_mib = 1024;
    poker::solver::StreetBatchSolver solver(wide);
    const poker::solver::StreetMemoryReport report = solver.memory_report();
    CHECK(report.memory_budget_bytes == 1024ull * 1048576ull);
    CHECK(report.allocated_bytes > 0);
    CHECK(report.peak_allocated_bytes >= report.allocated_bytes);
    CHECK(report.peak_allocated_bytes > report.regret_strategy_sum_bytes);
    CHECK(report.estimated_peak_bytes > report.regret_strategy_sum_bytes);
    CHECK(report.reserved_bytes == 0);
    CHECK(report.allocated_bytes <= report.peak_allocated_bytes);
    CHECK(report.peak_allocated_bytes <= report.memory_budget_bytes);
    CHECK(component_bytes(report, "rank_cache") > 100000);
    CHECK(component_bytes(report, "scratch") > 0);
    CHECK(component_bytes(report, "deals") > 0);
    CHECK(component_bytes(report, "support") > 0);
#ifdef _WIN32
    CHECK(report.process_peak_working_set_bytes > 0);
#endif
    CHECK(solver.public_decisions() == 6);
    const std::uint64_t runouts = 45ull * 44ull;
    CHECK(solver.terminal_count() == solver.deal_count() * runouts);
    CHECK(solver.decision_node_count() == solver.deal_count() * 2ull * (1ull + 45ull + runouts));
    CHECK(solver.terminal_count() == report.expanded_terminals);
    CHECK(solver.decision_node_count() == report.expanded_decisions);

    const std::uint64_t need = report.peak_allocated_bytes > report.estimated_peak_bytes
        ? report.peak_allocated_bytes
        : report.estimated_peak_bytes;
    StreetConfig tight_config = wide;
    tight_config.memory_mib = static_cast<int>(need / 1048576ull) + 1;
    poker::solver::StreetBatchSolver tight(tight_config);
    solver.run_frozen_iterations(1, poker::solver::Algorithm::CfrPlus);
    tight.run_frozen_iterations(1, poker::solver::Algorithm::CfrPlus);
    CHECK_NEAR(solver.expected_utility(), tight.expected_utility(), 1e-8);
    CHECK_NEAR(solver.nash_gap(), tight.nash_gap(), 1e-8);
    const poker::solver::StreetMemoryReport trained = solver.memory_report();
    CHECK(trained.train_seconds > 0.0);
    CHECK(trained.evaluation_seconds > 0.0);
    CHECK(trained.allocated_bytes == report.allocated_bytes);
    CHECK(trained.peak_allocated_bytes >= report.peak_allocated_bytes);

    const std::vector<int> turn = {card("Ah"), card("Kd"), card("7c"), card("4s")};
    StreetConfig weighted = check_only(turn, "AcAd:1,5c5d:3", "KsKc");
    poker::solver::StreetBatchSolver weighted_solver(weighted);
    weighted_solver.run_iterations(1, poker::solver::Algorithm::VanillaCfr);
    const double aces = average_turn_runout(
        turn, card("Ac"), card("Ad"), card("Ks"), card("Kc"), 100);
    const double fives = average_turn_runout(
        turn, card("5c"), card("5d"), card("Ks"), card("Kc"), 100);
    CHECK_NEAR(weighted_solver.expected_utility(), 0.25 * aces + 0.75 * fives, 1e-9);
    StreetConfig weighted_other_config = weighted;
    weighted_other_config.memory_mib = 64;
    poker::solver::StreetBatchSolver weighted_other(weighted_other_config);
    weighted_other.run_iterations(1, poker::solver::Algorithm::VanillaCfr);
    CHECK_NEAR(weighted_other.expected_utility(), weighted_solver.expected_utility(), 1e-9);

    StreetConfig blocked = check_only(turn, "QcQd,JsJd", "QcTc,JhTh");
    expect_street_batch(blocked, poker::solver::Algorithm::VanillaCfr, 1, false);
}

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

    const std::vector<int> river_board = {
        card("Ah"), card("Kd"), card("7c"), card("4s"), card("2h")};
    {
        const StreetGame river_check(check_only(river_board, "QcQd", "JcJd"));
        CHECK(river_check.deal_count() == 1);
        CHECK(river_check.board_count() == 5);
        CHECK(river_check.infoset_count() == 2);
        CHECK(river_check.terminal_count() == 1);
        poker::solver::SolveConfig once;
        once.max_iterations = 1;
        poker::solver::CfrTrainer<StreetGame> check_solver(
            river_check, poker::solver::Algorithm::VanillaCfr);
        const poker::solver::SolveStats check_stats = check_solver.solve(once);
        CHECK_NEAR(check_stats.nash_gap, 0.0, 1e-9);
        expect_street_batch(
            check_only(river_board, "QcQd", "JcJd"),
            poker::solver::Algorithm::VanillaCfr,
            1,
            true);

        RiverConfig polar;
        for (int i = 0; i < 5; ++i)
        {
            polar.board[static_cast<std::size_t>(i)] = river_board[static_cast<std::size_t>(i)];
        }
        polar.pot = 100;
        polar.stack = 100;
        polar.oop = Range::parse("AcAd,5c5d");
        polar.ip = Range::parse("KsKc");
        polar.oop_bet_sizes = {1.0};
        polar.allow_all_in = false;
        polar.max_raises = 1;
        expect_street_batch(street_from_river(polar), poker::solver::Algorithm::CfrPlus, 40, true);
        expect_street_matches_river(polar, poker::solver::Algorithm::CfrPlus, 40, true);
        expect_street_matches_river(polar, poker::solver::Algorithm::VanillaCfr, 40, true);

        RiverConfig full;
        for (int i = 0; i < 5; ++i)
        {
            full.board[static_cast<std::size_t>(i)] = river_board[static_cast<std::size_t>(i)];
        }
        full.pot = 100;
        full.stack = 200;
        full.oop = Range::parse("AA");
        full.ip = Range::parse("KK");
        full.oop_bet_sizes = {0.5, 1.0};
        full.ip_bet_sizes = {0.5, 1.0};
        full.oop_raise_sizes = {0.5, 1.0};
        full.ip_raise_sizes = {0.5, 1.0};
        full.allow_all_in = true;
        full.max_raises = 2;
        expect_street_matches_river(full, poker::solver::Algorithm::VanillaCfr, 12, true);
        expect_street_matches_river(full, poker::solver::Algorithm::CfrPlus, 12, true);
    }

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
    expect_canonical_street_config();
    expect_support_hole();
    expect_zero_own_reach();
    expect_average_without_opponent_reach();
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

bool same_numbers(const std::vector<double>& left, const std::vector<double>& right)
{
    if (left.size() != right.size())
    {
        return false;
    }
    for (std::size_t index = 0; index < left.size(); ++index)
    {
        if (left[index] != right[index])
        {
            return false;
        }
    }
    return true;
}

bool same_range(const Range& left, const Range& right)
{
    const std::array<double, 1326>& a = left.weights();
    const std::array<double, 1326>& b = right.weights();
    for (std::size_t index = 0; index < a.size(); ++index)
    {
        if (a[index] != b[index])
        {
            return false;
        }
    }
    return true;
}

bool same_config(const StreetConfig& left, const StreetConfig& right)
{
    return left.board == right.board && left.pot == right.pot && left.stack == right.stack
        && same_range(left.oop, right.oop) && same_range(left.ip, right.ip)
        && same_numbers(left.oop_bet_sizes, right.oop_bet_sizes)
        && same_numbers(left.ip_bet_sizes, right.ip_bet_sizes)
        && same_numbers(left.oop_raise_sizes, right.oop_raise_sizes)
        && same_numbers(left.ip_raise_sizes, right.ip_raise_sizes)
        && same_numbers(left.oop_flop_bets, right.oop_flop_bets)
        && same_numbers(left.oop_turn_bets, right.oop_turn_bets)
        && same_numbers(left.oop_river_bets, right.oop_river_bets)
        && same_numbers(left.ip_flop_bets, right.ip_flop_bets)
        && same_numbers(left.ip_turn_bets, right.ip_turn_bets)
        && same_numbers(left.ip_river_bets, right.ip_river_bets)
        && same_numbers(left.oop_flop_raises, right.oop_flop_raises)
        && same_numbers(left.oop_turn_raises, right.oop_turn_raises)
        && same_numbers(left.oop_river_raises, right.oop_river_raises)
        && same_numbers(left.ip_flop_raises, right.ip_flop_raises)
        && same_numbers(left.ip_turn_raises, right.ip_turn_raises)
        && same_numbers(left.ip_river_raises, right.ip_river_raises)
        && same_numbers(left.oop_donk_sizes, right.oop_donk_sizes)
        && same_numbers(left.oop_raise_multiples, right.oop_raise_multiples)
        && same_numbers(left.ip_raise_multiples, right.ip_raise_multiples)
        && left.geometric == right.geometric
        && left.all_in_threshold == right.all_in_threshold
        && left.pot_cap == right.pot_cap
        && left.allow_all_in == right.allow_all_in
        && left.allow_three_bet == right.allow_three_bet
        && left.max_raises == right.max_raises
        && left.first_to_act == right.first_to_act
        && left.memory_mib == right.memory_mib
        && left.threads == right.threads;
}

void expect_same_opening(const StreetGame& left, const StreetGame& right)
{
    CHECK(left.deal_count() == right.deal_count());
    CHECK(left.infoset_count() == right.infoset_count());
    CHECK(left.decision_node_count() == right.decision_node_count());
    CHECK(left.terminal_count() == right.terminal_count());
    const StreetGame::State left_open = left.child_chance(left.root(), 0);
    const StreetGame::State right_open = right.child_chance(right.root(), 0);
    const int left_id = left.infoset(left_open);
    const int right_id = right.infoset(right_open);
    CHECK(left.action_count(left_id) == right.action_count(right_id));
    const int count = left.action_count(left_id);
    for (int action = 0; action < count; ++action)
    {
        CHECK(left.action_label(left_id, action) == right.action_label(right_id, action));
    }
}

void expect_canonical_street_config()
{
    StreetConfig config;
    config.board = {card("Ah"), card("Kd"), card("7c"), card("4s")};
    config.pot = 100;
    config.stack = 300;
    config.oop = Range::parse("QcQd:2");
    config.ip = Range::parse("JcJd");
    config.oop_bet_sizes = {0.5, -20.0};
    config.oop_donk_sizes = {-40.0};
    config.ip_raise_multiples = {3.0};
    config.oop_turn_bets = {0.25};
    config.pot_cap = 1.0;
    config.allow_all_in = false;
    config.max_raises = 1;
    config.memory_mib = 1024;
    config.threads = 1;

    const std::string text = poker::streets::format_street_config(config);
    const char* expected =
        "street-config 1\n"
        "board Ah Kd 7c 4s\n"
        "pot 100\n"
        "stack 300\n"
        "oop-range QdQc:2\n"
        "ip-range JdJc:1\n"
        "first-to-act 0\n"
        "max-raises 1\n"
        "allow-all-in 0\n"
        "allow-three-bet 1\n"
        "geometric 0\n"
        "all-in-threshold 0\n"
        "pot-cap 1\n"
        "memory-mib 1024\n"
        "threads 1\n"
        "oop-bets 0.5 20c\n"
        "oop-turn-bets 0.25\n"
        "oop-donk 40c\n"
        "ip-raise-multiples 3\n";
    if (text != expected)
    {
        std::cerr << "canonical street config:\n" << text;
    }
    CHECK(text == expected);

    const StreetConfig parsed = poker::streets::parse_street_config(text);
    CHECK(same_config(config, parsed));
    CHECK(poker::streets::format_street_config(parsed) == text);

    const StreetGame original(config);
    const StreetGame rebuilt(parsed);
    expect_same_opening(original, rebuilt);

    const std::string tiny = poker::streets::format_street_config([&] {
        StreetConfig scaled = config;
        scaled.oop_bet_sizes = {1e-200};
        scaled.oop_donk_sizes.clear();
        scaled.ip_raise_multiples.clear();
        scaled.oop_turn_bets.clear();
        scaled.allow_all_in = true;
        return scaled;
    }());
    const StreetConfig scaled_back = poker::streets::parse_street_config(tiny);
    CHECK(scaled_back.oop_bet_sizes.size() == 1);
    CHECK(scaled_back.oop_bet_sizes[0] == 1e-200);
    CHECK(poker::streets::format_street_config(scaled_back) == tiny);

    const char* swapped =
        "street-config 1\n"
        "ip-range JdJc:1\n"
        "oop-range QcQd:2\n"
        "board Ah Kd 7c 4s\n"
        "stack 300\n"
        "pot 100\n"
        "threads 1\n"
        "memory-mib 1024\n"
        "pot-cap 1\n"
        "all-in-threshold 0\n"
        "geometric 0\n"
        "allow-three-bet 1\n"
        "allow-all-in 0\n"
        "max-raises 1\n"
        "first-to-act 0\n"
        "oop-donk 40c\n"
        "oop-bets 0.5 20c\n"
        "oop-turn-bets 0.25\n"
        "ip-raise-multiples 3\n";
    CHECK(poker::streets::format_street_config(poker::streets::parse_street_config(swapped)) == text);

    CHECK(throws_invalid([] { poker::streets::parse_street_config("street-config 2\n"); }));
    CHECK(!throws_invalid([] { poker::streets::parse_street_config("street-config 1\n"); }));
    CHECK(throws_invalid([] { poker::streets::parse_street_config("street-config 1"); }));
    CHECK(throws_invalid([] {
        poker::streets::parse_street_config("street-config 1\npot 100\npot 100\n");
    }));
    CHECK(throws_invalid([] {
        poker::streets::parse_street_config("street-config 1\noop-bets 3x\n");
    }));
    CHECK(throws_invalid([] {
        poker::streets::parse_street_config("street-config 1\noop-bets 0c\n");
    }));
    CHECK(throws_invalid([] {
        poker::streets::parse_street_config("street-config 1\nunknown 1\n");
    }));
    CHECK(!throws_invalid([] {
        poker::streets::parse_street_config("street-config 1\nboard Ah Kd\npot 100\nstack 100\n");
    }));
    CHECK(throws_invalid([] {
        const StreetConfig short_board = poker::streets::parse_street_config(
            "street-config 1\nboard Ah Kd\npot 100\nstack 100\n"
            "oop-range QcQd\nip-range JcJd\n");
        StreetGame game(short_board);
    }));

    // street_solver's no-argument default, also shipped as configs/street_default.txt.
    const char* street_default =
        "street-config 1\n"
        "board Kh Kd 7c 4s\n"
        "pot 100\n"
        "stack 100\n"
        "oop-range AhAd:1\n"
        "ip-range 3d2c:1\n"
        "first-to-act 0\n"
        "max-raises 1\n"
        "allow-all-in 0\n"
        "allow-three-bet 1\n"
        "geometric 0\n"
        "all-in-threshold 0\n"
        "pot-cap 0\n"
        "memory-mib 1024\n"
        "threads 1\n"
        "oop-bets 1\n"
        "oop-raises 1\n";
    StreetConfig cli_default;
    cli_default.board = {card("Kh"), card("Kd"), card("7c"), card("4s")};
    cli_default.pot = 100;
    cli_default.stack = 100;
    cli_default.oop = Range::parse("AhAd");
    cli_default.ip = Range::parse("2c3d");
    cli_default.oop_bet_sizes = {1.0};
    cli_default.oop_raise_sizes = {1.0};
    cli_default.allow_all_in = false;
    cli_default.max_raises = 1;
    CHECK(poker::streets::format_street_config(cli_default) == street_default);
    const StreetConfig loaded_default = poker::streets::parse_street_config(street_default);
    CHECK(same_config(cli_default, loaded_default));
    expect_same_opening(StreetGame(cli_default), StreetGame(loaded_default));

    StreetConfig merged;
    merged.board = config.board;
    merged.pot = 100;
    merged.stack = 300;
    merged.oop = Range::parse("QcQd");
    merged.ip = Range::parse("JcJd");
    merged.oop_bet_sizes = {0.5, -50.0};
    merged.allow_all_in = false;
    merged.max_raises = 1;
    const StreetGame merged_game(merged);
    const StreetGame::State merged_open = merged_game.child_chance(merged_game.root(), 0);
    CHECK(find_action(merged_game, merged_open, "Bet 50") >= 0);
    CHECK(merged_game.action_count(merged_game.infoset(merged_open)) == 2);

    StreetConfig minimum;
    minimum.board = config.board;
    minimum.pot = 100;
    minimum.stack = 500;
    minimum.oop = Range::parse("QcQd");
    minimum.ip = Range::parse("JcJd");
    minimum.oop_bet_sizes = {0.5};
    minimum.ip_raise_sizes = {0.1, 1.0};
    minimum.allow_all_in = false;
    minimum.max_raises = 2;
    const StreetGame minimum_game(minimum);
    StreetGame::State faced = minimum_game.child_chance(minimum_game.root(), 0);
    faced = minimum_game.child_action(faced, find_action(minimum_game, faced, "Bet 50"));
    CHECK(find_action(minimum_game, faced, "Raise to 250") >= 0);
    CHECK(minimum_game.action_count(minimum_game.infoset(faced)) == 3);

    StreetConfig short_stack = minimum;
    short_stack.stack = 80;
    short_stack.oop_bet_sizes = {-50.0};
    short_stack.ip_raise_sizes = {0.1};
    short_stack.allow_all_in = true;
    const StreetGame short_game(short_stack);
    StreetGame::State short_faced = short_game.child_chance(short_game.root(), 0);
    short_faced = short_game.child_action(short_faced, find_action(short_game, short_faced, "Bet 50"));
    CHECK(find_action(short_game, short_faced, "Raise to 80 all-in") >= 0);
    CHECK(short_game.action_count(short_game.infoset(short_faced)) == 3);
    short_stack.allow_all_in = false;
    const StreetGame no_shove(short_stack);
    StreetGame::State called = no_shove.child_chance(no_shove.root(), 0);
    called = no_shove.child_action(called, find_action(no_shove, called, "Bet 50"));
    CHECK(find_action(no_shove, called, "Raise to 80 all-in") < 0);
    CHECK(no_shove.action_count(no_shove.infoset(called)) == 2);
}

void expect_allocation_audit()
{
    const std::vector<int> flop = {card("Ah"), card("Kd"), card("7c")};
    StreetConfig branching;
    branching.board = flop;
    branching.pot = 100;
    branching.stack = 10000;
    branching.oop = Range::parse("QcQd");
    branching.ip = Range::parse("JcJd");
    branching.oop_bet_sizes = {0.25, 0.5, 1.0};
    branching.ip_bet_sizes = {0.25, 0.5, 1.0};
    branching.oop_raise_sizes = {0.5, 1.0};
    branching.ip_raise_sizes = {0.5, 1.0};
    branching.allow_all_in = true;
    branching.max_raises = 3;
    branching.memory_mib = 1;

    poker::solver::CountingResource denied_audit;
    std::string denied;
    try
    {
        poker::solver::StreetBatchSolver solver(branching, &denied_audit);
    }
    catch (const std::invalid_argument& error)
    {
        denied = error.what();
    }
    CHECK(denied.find("memory budget") != std::string::npos);
    CHECK(denied.find("budget ") != std::string::npos);
    CHECK(denied.find("allocated ") != std::string::npos);
    CHECK(denied.find("request ") != std::string::npos);
    CHECK(denied_audit.current() == 0);
    CHECK(denied_audit.peak() > 0);
    CHECK(denied_audit.peak() <= 1048576ull);

    poker::solver::CountingResource live_audit;
    StreetConfig small = check_only(flop, "QcQd", "JcJd");
    small.memory_mib = 64;
    poker::solver::StreetBatchSolver small_solver(small, &live_audit);
    const poker::solver::StreetMemoryReport small_report = small_solver.memory_report();
    CHECK(live_audit.current() == small_report.allocated_bytes);
    CHECK(live_audit.peak() <= small_report.memory_budget_bytes);
    CHECK(small_report.reserved_bytes == 0);
    const std::uint64_t before = live_audit.current();
    small_solver.run_frozen_iterations(1, poker::solver::Algorithm::CfrPlus);
    CHECK(live_audit.current() == before);
    CHECK(std::isfinite(small_solver.expected_utility()));

    const std::vector<int> turn = {card("Ah"), card("Kd"), card("7c"), card("4s")};
    StreetConfig betting = check_only(turn, "QcQd", "JcJd");
    betting.stack = 400;
    betting.oop_bet_sizes = {0.5, 1.0};
    betting.ip_bet_sizes = {0.5, 1.0};
    betting.oop_raise_sizes = {0.5, 1.0};
    betting.ip_raise_sizes = {0.5, 1.0};
    betting.allow_all_in = true;
    betting.max_raises = 2;
    betting.memory_mib = 64;
    poker::solver::CountingResource wide_audit;
    poker::solver::StreetBatchSolver wide_solver(betting, &wide_audit);
    const poker::solver::StreetMemoryReport wide_report = wide_solver.memory_report();
    CHECK(wide_audit.current() == wide_report.allocated_bytes);
    CHECK(wide_audit.current() > 0);
    CHECK(wide_audit.peak() <= wide_report.memory_budget_bytes);
    CHECK(component_bytes(wide_report, "public_tree") > 0);
    CHECK(component_bytes(wide_report, "rank_cache") > 0);
    CHECK(wide_solver.public_decisions() > 4);
    const std::uint64_t wide_before = wide_audit.current();
    wide_solver.run_frozen_iterations(1, poker::solver::Algorithm::CfrPlus);
    CHECK(wide_audit.current() == wide_before);
    CHECK(std::isfinite(wide_solver.expected_utility()));
    CHECK(wide_solver.nash_gap() >= -1e-8);
}

void run_street_memory_tests()
{
    expect_memory_budget();
    expect_allocation_audit();
}

void check_raw_tables(
    const char* name,
    const poker::solver::StreetBatchSolver& left,
    const poker::solver::StreetBatchSolver& right)
{
    const std::span<const double> left_regret = left.regret_table();
    const std::span<const double> right_regret = right.regret_table();
    const std::span<const double> left_sum = left.strategy_sum_table();
    const std::span<const double> right_sum = right.strategy_sum_table();
    CHECK(left_regret.size() == right_regret.size());
    CHECK(left_sum.size() == right_sum.size());
    double worst_regret = 0.0;
    double worst_sum = 0.0;
    const std::size_t regret_n = std::min(left_regret.size(), right_regret.size());
    const std::size_t sum_n = std::min(left_sum.size(), right_sum.size());
    for (std::size_t index = 0; index < regret_n; ++index)
    {
        worst_regret = std::max(
            worst_regret, std::abs(left_regret[index] - right_regret[index]));
    }
    for (std::size_t index = 0; index < sum_n; ++index)
    {
        worst_sum = std::max(worst_sum, std::abs(left_sum[index] - right_sum[index]));
    }
    if (worst_regret != 0.0 || worst_sum != 0.0)
    {
        std::cerr << name << " raw-table delta regret " << worst_regret
                  << " strategy_sum " << worst_sum << "\n";
    }
    CHECK(worst_regret == 0.0);
    CHECK(worst_sum == 0.0);
    CHECK_NEAR(left.expected_utility(), right.expected_utility(), 1e-8 * 100.0);
    CHECK_NEAR(left.nash_gap(), right.nash_gap(), 1e-8 * 100.0);
}

void run_street_workspace_tests()
{
    const std::vector<int> turn = {card("Ah"), card("Kd"), card("7c"), card("4s")};
    StreetConfig betting = check_only(turn, "AcAd:1,5c5d:3", "KsKc,JhJs");
    betting.stack = 100;
    betting.pot = 100;
    betting.oop_bet_sizes = {0.5};
    betting.ip_bet_sizes = {0.5};
    betting.oop_raise_sizes = {0.5};
    betting.ip_raise_sizes = {0.5};
    betting.allow_all_in = true;
    betting.max_raises = 1;

    {
        poker::solver::StreetBatchSolver cold(betting);
        CHECK(cold.memory_report().cache_init_seconds == 0.0);
    }
    poker::solver::StreetBatchSolver first(betting);
    poker::solver::StreetBatchSolver second(betting);
    first.run_frozen_iterations(3, poker::solver::Algorithm::CfrPlus);
    second.run_frozen_iterations(3, poker::solver::Algorithm::CfrPlus);
    CHECK(first.memory_report().cache_init_seconds > 0.0);
    check_raw_tables("serial cfr+ turn", first, second);

    poker::solver::StreetBatchSolver pieces(betting);
    pieces.run_frozen_iterations(2, poker::solver::Algorithm::CfrPlus);
    pieces.continue_frozen_iterations(2, poker::solver::Algorithm::CfrPlus);
    poker::solver::StreetBatchSolver whole(betting);
    whole.run_frozen_iterations(4, poker::solver::Algorithm::CfrPlus);
    check_raw_tables("serial continuation", pieces, whole);

    poker::solver::StreetBatchSolver vanilla_a(betting);
    poker::solver::StreetBatchSolver vanilla_b(betting);
    vanilla_a.run_frozen_iterations(2, poker::solver::Algorithm::VanillaCfr);
    vanilla_b.run_frozen_iterations(2, poker::solver::Algorithm::VanillaCfr);
    check_raw_tables("serial vanilla turn", vanilla_a, vanilla_b);

    const std::vector<int> flop = {card("Ah"), card("Kd"), card("7c")};
    StreetConfig flop_betting = check_only(flop, "QcQd", "JcJd");
    flop_betting.stack = 100;
    flop_betting.oop_bet_sizes = {0.5};
    flop_betting.ip_bet_sizes = {0.5};
    flop_betting.oop_raise_sizes = {0.5};
    flop_betting.ip_raise_sizes = {0.5};
    flop_betting.allow_all_in = true;
    flop_betting.max_raises = 1;
    poker::solver::StreetBatchSolver flop_a(flop_betting);
    poker::solver::StreetBatchSolver flop_b(flop_betting);
    flop_a.run_frozen_iterations(2, poker::solver::Algorithm::CfrPlus);
    flop_b.run_frozen_iterations(2, poker::solver::Algorithm::CfrPlus);
    check_raw_tables("serial cfr+ flop", flop_a, flop_b);
}

double table_delta(
    std::span<const double> left,
    std::span<const double> right)
{
    double worst = 0.0;
    const std::size_t count = std::min(left.size(), right.size());
    for (std::size_t index = 0; index < count; ++index)
    {
        const double scale = 1.0 + std::max(std::abs(left[index]), std::abs(right[index]));
        worst = std::max(worst, std::abs(left[index] - right[index]) / scale);
    }
    return worst;
}

void check_thread_match(
    const char* name,
    poker::solver::StreetBatchSolver& left,
    poker::solver::StreetBatchSolver& right)
{
    CHECK(left.regret_table().size() == right.regret_table().size());
    CHECK(left.strategy_sum_table().size() == right.strategy_sum_table().size());
    const double regret = table_delta(left.regret_table(), right.regret_table());
    const double sum = table_delta(left.strategy_sum_table(), right.strategy_sum_table());
    if (regret != 0.0 || sum != 0.0)
    {
        std::cerr << name << " relative delta regret " << regret
                  << " strategy_sum " << sum << "\n";
    }
    CHECK(regret == 0.0);
    CHECK(sum == 0.0);
    const auto left_entries = left.average_strategy_entries();
    const auto right_entries = right.average_strategy_entries();
    CHECK(left_entries.size() == right_entries.size());
    double worst_probability = 0.0;
    const std::size_t entry_count = std::min(left_entries.size(), right_entries.size());
    for (std::size_t index = 0; index < entry_count; ++index)
    {
        worst_probability = std::max(
            worst_probability,
            std::abs(left_entries[index].probability - right_entries[index].probability));
    }
    CHECK(worst_probability <= 1e-10);
    CHECK_NEAR(left.expected_utility(), right.expected_utility(), 1e-8 * 100.0);
    CHECK_NEAR(left.nash_gap(), right.nash_gap(), 1e-8 * 100.0);
}

StreetConfig betting_config(const std::vector<int>& board, const char* oop, const char* ip, int threads)
{
    StreetConfig config = check_only(board, oop, ip);
    config.stack = 100;
    config.pot = 100;
    config.oop_bet_sizes = {0.5};
    config.ip_bet_sizes = {0.5};
    config.oop_raise_sizes = {0.5};
    config.ip_raise_sizes = {0.5};
    config.allow_all_in = true;
    config.max_raises = 1;
    config.threads = threads;
    return config;
}

void expect_parallel_case(
    const char* name,
    const std::vector<int>& board,
    const char* oop,
    const char* ip,
    poker::solver::Algorithm algorithm,
    int iterations)
{
    StreetConfig serial = betting_config(board, oop, ip, 1);
    StreetConfig two = betting_config(board, oop, ip, 2);
    StreetConfig four = betting_config(board, oop, ip, 4);
    poker::solver::StreetBatchSolver baseline(serial);
    poker::solver::StreetBatchSolver pair(two);
    poker::solver::StreetBatchSolver quad(four);
    baseline.run_frozen_iterations(iterations, algorithm);
    pair.run_frozen_iterations(iterations, algorithm);
    quad.run_frozen_iterations(iterations, algorithm);
    check_thread_match(name, baseline, pair);
    check_thread_match(name, baseline, quad);
}

void run_street_parallel_tests()
{
    const std::vector<int> turn = {card("Ah"), card("Kd"), card("7c"), card("4s")};
    const std::vector<int> flop = {card("Ah"), card("Kd"), card("7c")};
    const std::vector<int> tie_board = {card("Ah"), card("Kd"), card("Qh"), card("Jh")};
    expect_parallel_case(
        "weighted turn", turn, "AcAd:1,5c5d:3", "KsKc:2,QhQs:0.5",
        poker::solver::Algorithm::CfrPlus, 3);
    expect_parallel_case(
        "weighted flop", flop, "QcQd:2,JsJd:1", "QcTc:1,JhTh:3",
        poker::solver::Algorithm::CfrPlus, 2);
    expect_parallel_case(
        "tie turn", tie_board, "AcAd", "KsKc",
        poker::solver::Algorithm::CfrPlus, 2);
    expect_parallel_case(
        "blocker turn", turn, "QcQd,JsJd", "QcTc",
        poker::solver::Algorithm::VanillaCfr, 2);
    expect_parallel_case(
        "many workers", turn, "AcAd", "KsKc",
        poker::solver::Algorithm::CfrPlus, 2);

    {
        StreetConfig wide = betting_config(turn, "AcAd", "KsKc", 64);
        StreetConfig serial = betting_config(turn, "AcAd", "KsKc", 1);
        poker::solver::StreetBatchSolver many(wide);
        poker::solver::StreetBatchSolver one(serial);
        CHECK(many.thread_count() == 64);
        many.run_frozen_iterations(2, poker::solver::Algorithm::CfrPlus);
        one.run_frozen_iterations(2, poker::solver::Algorithm::CfrPlus);
        check_thread_match("64 threads", one, many);
    }

    {
        StreetConfig config = betting_config(flop, "QcQd", "JcJd", 4);
        poker::solver::StreetBatchSolver again_a(config);
        poker::solver::StreetBatchSolver again_b(config);
        again_a.run_frozen_iterations(2, poker::solver::Algorithm::CfrPlus);
        again_b.run_frozen_iterations(2, poker::solver::Algorithm::CfrPlus);
        check_thread_match("repeat", again_a, again_b);
        poker::solver::StreetBatchSolver parts(config);
        parts.run_frozen_iterations(1, poker::solver::Algorithm::CfrPlus);
        parts.continue_frozen_iterations(1, poker::solver::Algorithm::CfrPlus);
        check_thread_match("continuation", again_a, parts);
        StreetConfig other = betting_config(flop, "QcQd", "JcJd", 2);
        poker::solver::StreetBatchSolver mixed(other);
        mixed.run_frozen_iterations(2, poker::solver::Algorithm::CfrPlus);
        check_thread_match("two versus four", again_a, mixed);
    }

    {
        const std::vector<int> lock_board = {card("Kh"), card("Kd"), card("7c"), card("4s")};
        StreetConfig serial = betting_config(lock_board, "AhAd", "2c3d", 1);
        StreetConfig quad = betting_config(lock_board, "AhAd", "2c3d", 4);
        poker::solver::StreetBatchSolver one(serial);
        poker::solver::StreetBatchSolver four(quad);
        one.run_single_frozen_pass_for_test(0);
        four.run_single_frozen_pass_for_test(0);
        check_thread_match("oop pass", one, four);
        bool oop_moved = false;
        for (const poker::solver::StreetStrategyEntry& entry : four.average_strategy_entries())
        {
            double regret = 0.0;
            CHECK(four.regret_value(entry.infoset, entry.action, regret));
            if (entry.infoset.rfind("IP ", 0) == 0)
            {
                CHECK(regret == 0.0);
            }
            else if (regret != 0.0)
            {
                oop_moved = true;
            }
        }
        CHECK(oop_moved);
        const std::vector<double> oop_regret(
            four.regret_table().begin(), four.regret_table().end());
        four.run_single_frozen_pass_for_test(1);
        const std::span<const double> after = four.regret_table();
        // IP's pass floors only IP. OOP entries that were already nonnegative stay.
        // Compare the full table with a one-thread pair of passes instead.
        one.run_single_frozen_pass_for_test(1);
        check_thread_match("both passes", one, four);
        CHECK(oop_regret.size() == after.size());
    }

    {
        StreetConfig config = check_only(turn, "AcAd", "KsKc");
        config.threads = 4;
        poker::solver::StreetBatchSolver delayed(config);
        delayed.arm_card_delay_for_test(50);
        StreetConfig serial = check_only(turn, "AcAd", "KsKc");
        poker::solver::StreetBatchSolver plain(serial);
        delayed.run_frozen_iterations(2, poker::solver::Algorithm::CfrPlus);
        plain.run_frozen_iterations(2, poker::solver::Algorithm::CfrPlus);
        check_thread_match("delayed cards", plain, delayed);
    }

    {
        const std::vector<int> lock_board = {card("Kh"), card("Kd"), card("7c"), card("4s")};
        StreetConfig config = betting_config(lock_board, "AhAd", "2c3d", 2);
        poker::solver::StreetBatchSolver solver(config);
        solver.arm_worker_failure_for_test();
        std::string failed;
        try
        {
            solver.run_frozen_iterations(1, poker::solver::Algorithm::CfrPlus);
        }
        catch (const std::runtime_error& error)
        {
            failed = error.what();
        }
        CHECK(failed.find("injected") != std::string::npos);
        bool refused = false;
        try
        {
            solver.continue_frozen_iterations(1, poker::solver::Algorithm::CfrPlus);
        }
        catch (const std::logic_error& error)
        {
            refused = std::string(error.what()).find("cannot continue") != std::string::npos;
        }
        CHECK(refused);
        bool utility_refused = false;
        try
        {
            (void)solver.expected_utility();
        }
        catch (const std::logic_error&)
        {
            utility_refused = true;
        }
        CHECK(utility_refused);
    }

    {
        StreetConfig bad = check_only(turn, "AcAd", "KsKc");
        bad.threads = 0;
        CHECK(throws_invalid([&] { poker::solver::StreetBatchSolver solver(bad); }));
        StreetConfig sequential = betting_config(turn, "AcAd", "KsKc", 4);
        poker::solver::StreetBatchSolver solver(sequential);
        bool rejected = false;
        try
        {
            solver.run_iterations(1, poker::solver::Algorithm::CfrPlus);
        }
        catch (const std::invalid_argument& error)
        {
            rejected = std::string(error.what()).find("frozen") != std::string::npos;
        }
        CHECK(rejected);
    }

    {
        StreetConfig sample = check_only(turn, "22+", "22+");
        sample.threads = 1;
        sample.memory_mib = 1024;
        poker::solver::StreetBatchSolver measured(sample);
        const int tight = static_cast<int>(
            measured.memory_report().peak_allocated_bytes / 1048576ull) + 1;
        sample.threads = 64;
        sample.memory_mib = tight;
        poker::solver::CountingResource counter;
        std::string denied;
        try
        {
            poker::solver::StreetBatchSolver refused(sample, &counter);
        }
        catch (const std::invalid_argument& error)
        {
            denied = error.what();
        }
        CHECK(denied.find("memory budget") != std::string::npos);
        CHECK(counter.current() == 0);
        sample.threads = 1;
        poker::solver::StreetBatchSolver accepted(sample);
        accepted.run_frozen_iterations(1, poker::solver::Algorithm::CfrPlus);
        CHECK(std::isfinite(accepted.expected_utility()));
    }

    {
        StreetConfig config = betting_config(turn, "AcAd", "KsKc", 4);
        poker::solver::CountingResource counter;
        poker::solver::StreetBatchSolver solver(config, &counter);
        const std::uint64_t before = counter.current();
        const std::uint64_t peak = counter.peak();
        solver.run_frozen_iterations(1, poker::solver::Algorithm::CfrPlus);
        CHECK(counter.current() == before);
        CHECK(counter.peak() == peak);
        solver.continue_frozen_iterations(1, poker::solver::Algorithm::CfrPlus);
        CHECK(counter.current() == before);
        CHECK(counter.peak() == peak);
        CHECK(solver.memory_report().thread_count == 4);
    }
}

void run_street_showdown_tests()
{
    const auto oracle = [](
        const poker::solver::ShowdownSample& sample,
        int turn,
        int river,
        std::span<const double> amount,
        std::size_t hand,
        double& worse,
        double& better,
        double& tied)
    {
        worse = 0.0;
        better = 0.0;
        tied = 0.0;
        const int c0 = sample.hero_card0[hand];
        const int c1 = sample.hero_card1[hand];
        const bool hero_dead = (turn >= 0 && (c0 == turn || c1 == turn))
            || (river >= 0 && (c0 == river || c1 == river));
        if (hero_dead)
        {
            return;
        }
        for (std::size_t opp = 0; opp < amount.size(); ++opp)
        {
            const int a = sample.opponent_card0[opp];
            const int b = sample.opponent_card1[opp];
            if (a == c0 || a == c1 || b == c0 || b == c1)
            {
                continue;
            }
            if (turn >= 0 && (a == turn || b == turn))
            {
                continue;
            }
            if (river >= 0 && (a == river || b == river))
            {
                continue;
            }
            const double weight = amount[opp];
            if (sample.opponent_rank[opp] < sample.hero_rank[hand])
            {
                worse += weight;
            }
            else if (sample.opponent_rank[opp] > sample.hero_rank[hand])
            {
                better += weight;
            }
            else
            {
                tied += weight;
            }
        }
    };

    const auto dense = [](
        const poker::solver::ShowdownSample& sample,
        std::span<const double> amount,
        std::size_t hand) -> std::pair<double, double>
    {
        const int hands = static_cast<int>(sample.order.size());
        const int span = hands + 1;
        std::vector<double> prefix(static_cast<std::size_t>(span), 0.0);
        std::vector<double> by_card(static_cast<std::size_t>(52 * span), 0.0);
        for (int index = 0; index < hands; ++index)
        {
            const int opp = sample.order[static_cast<std::size_t>(index)];
            const double piece = amount[static_cast<std::size_t>(opp)];
            prefix[static_cast<std::size_t>(index + 1)] = prefix[static_cast<std::size_t>(index)] + piece;
            for (int card_id = 0; card_id < 52; ++card_id)
            {
                by_card[static_cast<std::size_t>(card_id * span + index + 1)] =
                    by_card[static_cast<std::size_t>(card_id * span + index)];
            }
            by_card[static_cast<std::size_t>(
                sample.opponent_card0[static_cast<std::size_t>(opp)] * span + index + 1)] += piece;
            by_card[static_cast<std::size_t>(
                sample.opponent_card1[static_cast<std::size_t>(opp)] * span + index + 1)] += piece;
        }
        const auto slice = [&](int begin, int end) -> double
        {
            if (end <= begin)
            {
                return 0.0;
            }
            const int c0 = sample.hero_card0[hand];
            const int c1 = sample.hero_card1[hand];
            double sum = prefix[static_cast<std::size_t>(end)] - prefix[static_cast<std::size_t>(begin)];
            sum -= by_card[static_cast<std::size_t>(c0 * span + end)]
                - by_card[static_cast<std::size_t>(c0 * span + begin)];
            sum -= by_card[static_cast<std::size_t>(c1 * span + end)]
                - by_card[static_cast<std::size_t>(c1 * span + begin)];
            const int same = [&]() -> int
            {
                for (int opp = 0; opp < hands; ++opp)
                {
                    if (sample.opponent_card0[static_cast<std::size_t>(opp)] == c0
                        && sample.opponent_card1[static_cast<std::size_t>(opp)] == c1)
                    {
                        return opp;
                    }
                }
                return -1;
            }();
            if (same >= 0 && amount[static_cast<std::size_t>(same)] != 0.0)
            {
                const int at = sample.position[static_cast<std::size_t>(same)];
                if (at >= begin && at < end)
                {
                    sum += amount[static_cast<std::size_t>(same)];
                }
            }
            return sum;
        };
        return {
            slice(0, sample.worse_end[hand]),
            slice(sample.better_begin[hand], hands),
        };
    };

    const auto check = [&](poker::solver::StreetBatchSolver& solver, int hero, int turn, int river, std::vector<double> amount)
    {
        const poker::solver::ShowdownSample sample = solver.sample_showdown_for_test(hero, turn, river, amount);
        CHECK(sample.order.size() == amount.size());
        std::vector<int> expect(sample.order.size());
        for (int index = 0; index < static_cast<int>(expect.size()); ++index)
        {
            expect[static_cast<std::size_t>(index)] = index;
        }
        std::sort(expect.begin(), expect.end(), [&](int left, int right)
        {
            const std::uint32_t left_rank = sample.opponent_rank[static_cast<std::size_t>(left)];
            const std::uint32_t right_rank = sample.opponent_rank[static_cast<std::size_t>(right)];
            if (left_rank != right_rank)
            {
                return left_rank < right_rank;
            }
            return left < right;
        });
        for (std::size_t index = 0; index < expect.size(); ++index)
        {
            CHECK(sample.order[index] == expect[index]);
            CHECK(sample.position[static_cast<std::size_t>(sample.order[index])] == static_cast<int>(index));
        }
        std::vector<std::uint32_t> sorted(expect.size());
        for (std::size_t index = 0; index < expect.size(); ++index)
        {
            sorted[index] = sample.opponent_rank[static_cast<std::size_t>(sample.order[index])];
        }
        CHECK(sample.card_offset.size() == 53);
        CHECK(sample.card_offset[0] == 0);
        CHECK(sample.card_offset[52] == static_cast<int>(sample.order.size()) * 2);
        CHECK(sample.card_order.size() == static_cast<std::size_t>(sample.card_offset[52]));
        CHECK(sample.card_cut.size() == sample.hero_rank.size() * 4);
        for (int card_id = 0; card_id < 52; ++card_id)
        {
            const int begin = sample.card_offset[static_cast<std::size_t>(card_id)];
            const int end = sample.card_offset[static_cast<std::size_t>(card_id + 1)];
            CHECK(end >= begin);
            for (int at = begin + 1; at < end; ++at)
            {
                CHECK(sample.card_order[static_cast<std::size_t>(at)]
                    > sample.card_order[static_cast<std::size_t>(at - 1)]);
            }
        }
        const auto list_cut = [&](int card_id, int order_end) -> int
        {
            int lower = sample.card_offset[static_cast<std::size_t>(card_id)];
            int upper = sample.card_offset[static_cast<std::size_t>(card_id + 1)];
            while (lower < upper)
            {
                const int mid = lower + (upper - lower) / 2;
                if (sample.card_order[static_cast<std::size_t>(mid)] < order_end)
                {
                    lower = mid + 1;
                }
                else
                {
                    upper = mid;
                }
            }
            return lower - sample.card_offset[static_cast<std::size_t>(card_id)];
        };
        for (std::size_t hand = 0; hand < sample.hero_rank.size(); ++hand)
        {
            const std::uint32_t rank = sample.hero_rank[hand];
            const int lower = static_cast<int>(
                std::lower_bound(sorted.begin(), sorted.end(), rank) - sorted.begin());
            const int upper = static_cast<int>(
                std::upper_bound(sorted.begin(), sorted.end(), rank) - sorted.begin());
            CHECK(sample.worse_end[hand] == lower);
            CHECK(sample.better_begin[hand] == upper);
            const int c0 = sample.hero_card0[hand];
            const int c1 = sample.hero_card1[hand];
            const int hands = static_cast<int>(sample.order.size());
            CHECK(list_cut(c0, 0) == 0);
            CHECK(list_cut(c1, 0) == 0);
            CHECK(list_cut(c0, hands) == sample.card_offset[static_cast<std::size_t>(c0 + 1)]
                - sample.card_offset[static_cast<std::size_t>(c0)]);
            CHECK(list_cut(c1, hands) == sample.card_offset[static_cast<std::size_t>(c1 + 1)]
                - sample.card_offset[static_cast<std::size_t>(c1)]);
            CHECK(sample.card_cut[hand * 4] == list_cut(c0, sample.worse_end[hand]));
            CHECK(sample.card_cut[hand * 4 + 1] == list_cut(c1, sample.worse_end[hand]));
            CHECK(sample.card_cut[hand * 4 + 2] == list_cut(c0, sample.better_begin[hand]));
            CHECK(sample.card_cut[hand * 4 + 3] == list_cut(c1, sample.better_begin[hand]));
            double worse = 0.0;
            double better = 0.0;
            double tied = 0.0;
            oracle(sample, turn, river, amount, hand, worse, better, tied);
            const bool hero_dead = (turn >= 0 && (c0 == turn || c1 == turn))
                || (river >= 0 && (c0 == river || c1 == river));
            if (hero_dead)
            {
                CHECK(sample.worse_mass[hand] == 0.0);
                CHECK(sample.better_mass[hand] == 0.0);
                continue;
            }
            const bool opp_blocked = [&]()
            {
                for (std::size_t opp = 0; opp < amount.size(); ++opp)
                {
                    const int a = sample.opponent_card0[opp];
                    const int b = sample.opponent_card1[opp];
                    if ((turn >= 0 && (a == turn || b == turn)) || (river >= 0 && (a == river || b == river)))
                    {
                        if (amount[opp] != 0.0)
                        {
                            return true;
                        }
                    }
                }
                return false;
            }();
            if (!opp_blocked)
            {
                CHECK(sample.worse_mass[hand] == worse);
                CHECK(sample.better_mass[hand] == better);
            }
            const std::pair<double, double> from_dense = dense(sample, amount, hand);
            CHECK(sample.worse_mass[hand] == from_dense.first);
            CHECK(sample.better_mass[hand] == from_dense.second);
            (void)tied;
        }
    };

    StreetConfig config;
    config.board = {card("Ah"), card("Kd"), card("7c")};
    config.pot = 100;
    config.stack = 100;
    config.oop = Range::parse("AcAd:1,KsKc:3,QcQd:2,5c5d:0.5");
    config.ip = Range::parse("AcAd:0.5,QhQs:4,JhTh:1,2c3d:2");
    config.allow_all_in = false;
    config.max_raises = 0;
    config.memory_mib = 256;
    poker::solver::StreetBatchSolver solver(config);
    const int turn = card("9c");
    const int river = card("2h");
    auto amounts_for = [&](int player)
    {
        const int hands = solver.indexed_hands_for_test(player);
        std::vector<double> amount(static_cast<std::size_t>(hands), 0.0);
        for (int hand = 0; hand < hands; ++hand)
        {
            amount[static_cast<std::size_t>(hand)] = hand % 3 == 0 ? 0.0 : 0.25 * static_cast<double>(hand + 1);
        }
        return amount;
    };
    check(solver, 0, turn, river, amounts_for(1));
    check(solver, 1, turn, river, amounts_for(0));
    check(solver, 0, turn, card("Qc"), amounts_for(1));
    {
        std::vector<double> zeros(static_cast<std::size_t>(solver.indexed_hands_for_test(1)), 0.0);
        check(solver, 0, turn, river, zeros);
    }

    StreetConfig tied;
    tied.board = {card("Ah"), card("Ad"), card("Ac")};
    tied.pot = 100;
    tied.stack = 100;
    tied.oop = Range::parse("2c3d:1.5,5c6d:0.25");
    tied.ip = Range::parse("7c8d:3,9cTc:1");
    tied.allow_all_in = false;
    tied.max_raises = 0;
    tied.memory_mib = 256;
    poker::solver::StreetBatchSolver tie_solver(tied);
    const int tie_turn = card("As");
    const int tie_river = card("Kd");
    std::vector<double> tie_amount(static_cast<std::size_t>(tie_solver.indexed_hands_for_test(1)), 0.0);
    CHECK(tie_amount.size() >= 2);
    tie_amount[0] = 0.0;
    tie_amount[1] = 1.5;
    check(tie_solver, 0, tie_turn, tie_river, tie_amount);
    const poker::solver::ShowdownSample tied_sample = tie_solver.sample_showdown_for_test(0, tie_turn, tie_river, tie_amount);
    bool saw_tie_interval = false;
    for (std::size_t hand = 0; hand < tied_sample.worse_mass.size(); ++hand)
    {
        CHECK(tied_sample.worse_mass[hand] == 0.0);
        CHECK(tied_sample.better_mass[hand] == 0.0);
        if (tied_sample.better_begin[hand] > tied_sample.worse_end[hand])
        {
            saw_tie_interval = true;
        }
    }
    CHECK(saw_tie_interval);
}

void run_street_inspect_tests()
{
    StreetConfig config;
    config.board = {card("Ah"), card("Kd"), card("7c")};
    config.pot = 100;
    config.stack = 100;
    config.oop = Range::parse("AcAd:1,9c9d:2,QcQd:0.5");
    config.ip = Range::parse("AcAd:0.5,QhQs:3,JhTh:1");
    config.oop_bet_sizes = {0.5};
    config.ip_bet_sizes = {0.5};
    config.allow_all_in = false;
    config.max_raises = 1;
    config.memory_mib = 256;
    poker::solver::StreetBatchSolver solver(config);
    solver.run_frozen_iterations(2, poker::solver::Algorithm::CfrPlus);
    solver.prepare_inspection();
    const std::string root_id = solver.root_node_id();
    CHECK(root_id == "p0.t-1.r-1");
    const std::vector<poker::solver::StreetStrategyEntry> entries = solver.average_strategy_entries();
    CHECK(!entries.empty());
    std::map<std::string, std::vector<const poker::solver::StreetStrategyEntry*>> by_infoset;
    for (const poker::solver::StreetStrategyEntry& entry : entries)
    {
        by_infoset[entry.infoset].push_back(&entry);
    }

    std::vector<std::string> pending;
    pending.push_back(root_id);
    std::map<std::string, int> seen;
    int decisions = 0;
    int chances = 0;
    bool saw_blocked = false;
    std::string chance_sample;
    std::string river_sample;
    while (!pending.empty())
    {
        const std::string id = pending.back();
        pending.pop_back();
        if (seen.find(id) != seen.end())
        {
            continue;
        }
        seen.emplace(id, 1);
        const poker::solver::StreetInspection view = solver.inspect_node(id);
        CHECK(view.node_id == id);
        if (view.kind == "decision")
        {
            ++decisions;
            if (river_sample.empty() && id.find(".r-1") == std::string::npos)
            {
                river_sample = id;
            }
            CHECK(view.player == 0 || view.player == 1);
            CHECK(!view.actions.empty());
            CHECK(view.actions.size() <= 8);
            CHECK(view.hands.size() <= 1326);
            double strategy_mass = 0.0;
            for (const poker::solver::StreetInspectHand& hand : view.hands)
            {
                if (!hand.structural)
                {
                    CHECK(hand.strategy.empty());
                    CHECK(hand.reach == 0.0);
                    if (view.place.rfind("turn ", 0) == 0)
                    {
                        saw_blocked = true;
                    }
                    continue;
                }
                CHECK(hand.strategy.size() == view.actions.size());
                double sum = 0.0;
                for (double probability : hand.strategy)
                {
                    sum += probability;
                }
                CHECK_NEAR(sum, 1.0, 1e-12);
                const std::string who = view.player == 0 ? "OOP " : "IP ";
                const std::string infoset = who + hand.combo + " | " + view.place + " | " + view.line;
                const auto found = by_infoset.find(infoset);
                CHECK(found != by_infoset.end());
                if (found != by_infoset.end())
                {
                    CHECK(found->second.size() == view.actions.size());
                    for (const poker::solver::StreetStrategyEntry* entry : found->second)
                    {
                        bool matched = false;
                        for (std::size_t action = 0; action < view.actions.size(); ++action)
                        {
                            if (entry->action == view.actions[action].label)
                            {
                                CHECK(entry->probability == hand.strategy[action]);
                                matched = true;
                            }
                        }
                        CHECK(matched);
                    }
                }
                strategy_mass += hand.marginal;
            }
            if (view.reach_defined)
            {
                CHECK(view.joint > 0.0);
                CHECK_NEAR(strategy_mass, 1.0, 1e-9);
            }
            for (const poker::solver::StreetInspectAction& action : view.actions)
            {
                pending.push_back(action.child_id);
            }
        }
        else if (view.kind == "chance")
        {
            ++chances;
            CHECK(view.cards.size() <= 52);
            double weight = 0.0;
            for (const poker::solver::StreetInspectCard& choice : view.cards)
            {
                CHECK(choice.card != "Ah");
                CHECK(choice.card != "Kd");
                CHECK(choice.card != "7c");
                if (choice.weight_defined)
                {
                    weight += choice.weight;
                }
            }
            if (!view.cards.empty() && view.cards.front().weight_defined)
            {
                CHECK_NEAR(weight, 1.0, 1e-9);
            }
            int queued = 0;
            for (const poker::solver::StreetInspectCard& choice : view.cards)
            {
                if (queued >= 2 && choice.card != "Ac" && choice.card != "2c" && choice.card != "Qc")
                {
                    continue;
                }
                if (chance_sample.empty())
                {
                    chance_sample = choice.child_id;
                }
                pending.push_back(choice.child_id);
                ++queued;
            }
        }
        else
        {
            CHECK(view.kind == "terminal");
            CHECK(view.hands.empty());
            CHECK(view.actions.empty());
        }
    }
    CHECK(decisions > 0);
    CHECK(chances > 0);
    CHECK(seen.size() > 10);

    const poker::solver::StreetInspection root = solver.inspect_node(root_id);
    CHECK(root.reach_defined);
    CHECK(root.player == 0);
    {
        const std::pair<int, double> opponent[] = {
            {Range::combo_index(card("Ac"), card("Ad")), 0.5},
            {Range::combo_index(card("Qh"), card("Qs")), 3.0},
            {Range::combo_index(card("Jh"), card("Th")), 1.0},
        };
        double oracle_joint = 0.0;
        std::vector<double> oracle(root.hands.size(), 0.0);
        for (std::size_t hero = 0; hero < root.hands.size(); ++hero)
        {
            int a = 0;
            int b = 0;
            bool parsed = false;
            for (int index = 0; index < 1326; ++index)
            {
                if (Range::combo_text(index) == root.hands[hero].combo)
                {
                    Range::combo_cards(index, a, b);
                    parsed = true;
                }
            }
            CHECK(parsed);
            double compatible = 0.0;
            for (const auto& opp : opponent)
            {
                int c = 0;
                int d = 0;
                Range::combo_cards(opp.first, c, d);
                if (a == c || a == d || b == c || b == d)
                {
                    continue;
                }
                compatible += opp.second;
            }
            const double piece = root.hands[hero].reach * compatible;
            oracle[hero] = piece;
            oracle_joint += piece;
        }
        CHECK(oracle_joint > 0.0);
        CHECK_NEAR(root.joint, oracle_joint, 1e-9);
        for (std::size_t hero = 0; hero < root.hands.size(); ++hero)
        {
            CHECK_NEAR(root.hands[hero].marginal, oracle[hero] / oracle_joint, 1e-12);
        }
    }

    CHECK(throws_invalid([&]() { solver.inspect_node("p0.t" + std::to_string(card("Ah")) + ".r-1"); }));
    CHECK(throws_invalid([&]() { solver.inspect_node("nope"); }));
    CHECK(!chance_sample.empty());
    CHECK(!river_sample.empty());
    {
        const std::size_t turn_at = chance_sample.find(".t");
        const std::size_t river_at = chance_sample.find(".r");
        CHECK(turn_at != std::string::npos && river_at != std::string::npos);
        const std::string dead = chance_sample.substr(0, turn_at) + ".t" + std::to_string(card("Ah")) + chance_sample.substr(river_at);
        CHECK(throws_invalid([&]() { solver.inspect_node(dead); }));
        const std::size_t river_turn = river_sample.find(".t");
        const std::size_t river_card = river_sample.find(".r");
        CHECK(river_turn != std::string::npos && river_card != std::string::npos);
        const std::string turn_text = river_sample.substr(river_turn + 2, river_card - (river_turn + 2));
        const std::string duplicate = river_sample.substr(0, river_card) + ".r" + turn_text;
        CHECK(throws_invalid([&]() { solver.inspect_node(duplicate); }));
    }

    const poker::solver::StreetInspection opening = solver.inspect_node(root_id);
    CHECK(!opening.actions.empty());
    std::vector<double> pure(opening.actions.size(), 0.0);
    pure[0] = 0.0;
    if (pure.size() > 1)
    {
        pure[1] = 1.0;
    }
    else
    {
        pure[0] = 1.0;
    }
    CHECK(opening.actions.size() > 1);
    {
        for (int hand = 0; hand < static_cast<int>(opening.hands.size()); ++hand)
        {
            if (opening.hands[static_cast<std::size_t>(hand)].structural)
            {
                solver.set_average_for_test(root_id, hand, pure);
            }
        }
        const poker::solver::StreetInspection blocked_line = solver.inspect_node(opening.actions[0].child_id);
        CHECK(!blocked_line.reach_defined);
        CHECK(blocked_line.joint == 0.0);
        for (const poker::solver::StreetInspectHand& hand : blocked_line.hands)
        {
            if (hand.structural)
            {
                CHECK(!hand.strategy.empty());
            }
            CHECK(hand.marginal == 0.0);
        }
    }

    StreetConfig tied;
    tied.board = {card("Ah"), card("Ad"), card("Ac")};
    tied.pot = 80;
    tied.stack = 80;
    tied.oop = Range::parse("2c3d:1.5,5c6d:0.25");
    tied.ip = Range::parse("7c8d:3,9cTc:1");
    tied.allow_all_in = false;
    tied.max_raises = 0;
    tied.memory_mib = 256;
    poker::solver::StreetBatchSolver tie_solver(tied);
    tie_solver.run_frozen_iterations(1, poker::solver::Algorithm::CfrPlus);
    const poker::solver::StreetInspection tie_root = tie_solver.inspect_node(tie_solver.root_node_id());
    CHECK(tie_root.kind == "decision");
    CHECK(tie_root.reach_defined);
    CHECK(tie_root.hands.size() >= 2);
    for (const poker::solver::StreetInspectHand& hand : tie_root.hands)
    {
        CHECK(hand.structural);
        double sum = 0.0;
        for (double probability : hand.strategy)
        {
            sum += probability;
        }
        CHECK_NEAR(sum, 1.0, 1e-12);
    }
    CHECK(saw_blocked);
}
