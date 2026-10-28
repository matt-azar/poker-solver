#include "harness.hpp"

#include "game/street_game.hpp"
#include "poker/card.hpp"
#include "poker/range.hpp"
#include "solver/street_batch.hpp"

#include <atomic>
#include <cmath>
#include <cstring>
#include <map>
#include <new>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace
{

using poker::holdem::Range;
using poker::solver::Algorithm;
using poker::solver::SolveConfig;
using poker::solver::StreetActionValues;
using poker::solver::StreetBatchSolver;
using poker::solver::StreetInspection;
using poker::solver::StreetValueCancelled;
using poker::streets::StreetConfig;
using poker::streets::StreetGame;

int card_id(const char* text)
{
    return poker::holdem::parse_card(text);
}

std::string combo_name(const char* a, const char* b)
{
    return Range::combo_text(Range::combo_index(card_id(a), card_id(b)));
}

int find_hand(const std::vector<std::string>& combos, const std::string& combo)
{
    for (int index = 0; index < static_cast<int>(combos.size()); ++index)
    {
        if (combos[static_cast<std::size_t>(index)] == combo)
        {
            return index;
        }
    }
    return -1;
}

int find_action(const std::vector<std::string>& actions, const char* prefix)
{
    for (int index = 0; index < static_cast<int>(actions.size()); ++index)
    {
        if (actions[static_cast<std::size_t>(index)].rfind(prefix, 0) == 0)
        {
            return index;
        }
    }
    return -1;
}

int find_inspected_hand(const StreetInspection& view, const std::string& combo)
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

void set_named_average(
    StreetBatchSolver& solver,
    const std::string& node_id,
    const std::string& combo,
    const std::vector<std::pair<const char*, double>>& named)
{
    const StreetInspection view = solver.inspect_node(node_id);
    const int hand = find_inspected_hand(view, combo);
    CHECK(hand >= 0);
    std::vector<double> probability(view.actions.size(), 0.0);
    for (const auto& item : named)
    {
        const int action = find_action(
            [&]()
            {
                std::vector<std::string> labels;
                labels.reserve(view.actions.size());
                for (const auto& entry : view.actions)
                {
                    labels.push_back(entry.label);
                }
                return labels;
            }(),
            item.first);
        if (action < 0)
        {
            throw std::runtime_error(std::string("missing action ") + item.first);
        }
        probability[static_cast<std::size_t>(action)] = item.second;
    }
    solver.set_average_for_test(node_id, hand, probability);
}

struct TableSnapshot
{
    std::vector<double> regret;
    std::vector<double> strategy_sum;
    std::vector<std::pair<std::string, double>> average;
    int iterations = 0;
    double evaluation_seconds = 0.0;
    double train_seconds = 0.0;
    std::uint64_t allocated = 0;
    std::uint64_t peak = 0;
};

TableSnapshot snapshot_of(const StreetBatchSolver& solver)
{
    TableSnapshot shot;
    const auto regret = solver.regret_table();
    const auto strategy = solver.strategy_sum_table();
    shot.regret.assign(regret.begin(), regret.end());
    shot.strategy_sum.assign(strategy.begin(), strategy.end());
    for (const auto& entry : solver.average_strategy_entries())
    {
        shot.average.emplace_back(entry.infoset + " " + entry.action, entry.probability);
    }
    shot.iterations = solver.completed_iterations();
    const auto report = solver.memory_report();
    shot.evaluation_seconds = report.evaluation_seconds;
    shot.train_seconds = report.train_seconds;
    shot.allocated = report.allocated_bytes;
    shot.peak = report.peak_allocated_bytes;
    return shot;
}

void expect_unchanged(const StreetBatchSolver& solver, const TableSnapshot& before)
{
    const auto regret = solver.regret_table();
    const auto strategy = solver.strategy_sum_table();
    CHECK(regret.size() == before.regret.size());
    CHECK(strategy.size() == before.strategy_sum.size());
    CHECK(std::memcmp(
              regret.data(), before.regret.data(), before.regret.size() * sizeof(double))
        == 0);
    CHECK(std::memcmp(
              strategy.data(),
              before.strategy_sum.data(),
              before.strategy_sum.size() * sizeof(double))
        == 0);
    const TableSnapshot after = snapshot_of(solver);
    CHECK(after.average == before.average);
    CHECK(after.iterations == before.iterations);
    CHECK(after.evaluation_seconds == before.evaluation_seconds);
    CHECK(after.train_seconds == before.train_seconds);
    CHECK(after.allocated == before.allocated);
    CHECK(after.peak == before.peak);
}

using Profile = std::map<std::string, std::map<std::string, double>>;

Profile profile_from(const StreetBatchSolver& solver)
{
    Profile profile;
    for (const auto& entry : solver.average_strategy_entries())
    {
        profile[entry.infoset][entry.action] = entry.probability;
    }
    return profile;
}

double profile_probability(const Profile& profile, const std::string& infoset, const std::string& action)
{
    const auto row = profile.find(infoset);
    CHECK(row != profile.end());
    if (row == profile.end())
    {
        return 0.0;
    }
    const auto found = row->second.find(action);
    CHECK(found != row->second.end());
    if (found == row->second.end())
    {
        return 0.0;
    }
    return found->second;
}

double oracle_continuation(
    const StreetGame& game,
    StreetGame::State state,
    const Profile& profile,
    int hero)
{
    if (game.is_terminal(state))
    {
        const double payoff = game.p1_utility(state);
        return hero == 0 ? payoff : -payoff;
    }
    if (game.is_chance(state))
    {
        double sum = 0.0;
        const int count = game.chance_count(state);
        for (int outcome = 0; outcome < count; ++outcome)
        {
            sum += game.chance_probability(state, outcome)
                * oracle_continuation(game, game.child_chance(state, outcome), profile, hero);
        }
        return sum;
    }
    const int infoset = game.infoset(state);
    double sum = 0.0;
    const std::string label = game.infoset_label(infoset);
    const int count = game.action_count(infoset);
    for (int action = 0; action < count; ++action)
    {
        const std::string name = game.action_label(infoset, action);
        const double probability = profile_probability(profile, label, name);
        sum += probability * oracle_continuation(
            game, game.child_action(state, action), profile, hero);
    }
    return sum;
}

struct OracleHand
{
    double weight = 0.0;
    std::vector<double> weighted;
};

bool same_card(int left, int right)
{
    return left == right;
}

StreetGame::State follow_line(
    const StreetGame& game,
    StreetGame::State state,
    const std::vector<std::string>& line,
    int target_turn,
    int target_river,
    const Profile& profile,
    int hero,
    double& weight)
{
    std::size_t step = 0;
    while (true)
    {
        CHECK(!game.is_terminal(state));
        if (game.is_chance(state))
        {
            const int want = (target_turn >= 0 && state.turn_card != target_turn)
                ? target_turn
                : target_river;
            if (want < 0)
            {
                throw std::runtime_error("oracle chance has no target card");
            }
            bool found = false;
            const int count = game.chance_count(state);
            for (int outcome = 0; outcome < count; ++outcome)
            {
                const StreetGame::State next = game.child_chance(state, outcome);
                if ((want == target_turn && same_card(next.turn_card, want))
                    || (want != target_turn && same_card(next.river_card, want)))
                {
                    state = next;
                    found = true;
                    break;
                }
            }
            if (!found)
            {
                throw std::runtime_error("oracle missed a runout card");
            }
            continue;
        }
        if (step >= line.size())
        {
            return state;
        }
        const int infoset = game.infoset(state);
        int action = -1;
        for (int index = 0; index < game.action_count(infoset); ++index)
        {
            if (game.action_label(infoset, index) == line[step])
            {
                action = index;
                break;
            }
        }
        if (action < 0)
        {
            throw std::runtime_error("oracle missed path action " + line[step]);
        }
        if (game.acting_player(infoset) != hero)
        {
            weight *= profile_probability(profile, game.infoset_label(infoset), line[step]);
        }
        state = game.child_action(state, action);
        ++step;
    }
}

std::map<std::string, OracleHand> oracle_values(
    const StreetConfig& config,
    const StreetInspection& view,
    const Profile& profile)
{
    const StreetGame game(config);
    const auto pairs = poker::holdem::joint_distribution(
        config.oop, config.ip, config.board.data(), static_cast<int>(config.board.size()));
    CHECK(static_cast<int>(pairs.size()) == game.deal_count());
    std::vector<std::string> line;
    if (view.line != "open" && !view.line.empty())
    {
        std::size_t cursor = 0;
        while (cursor < view.line.size())
        {
            const std::size_t slash = view.line.find('/', cursor);
            if (slash == std::string::npos)
            {
                line.push_back(view.line.substr(cursor));
                break;
            }
            line.push_back(view.line.substr(cursor, slash - cursor));
            cursor = slash + 1;
        }
    }
    int target_turn = -1;
    int target_river = -1;
    if (view.board.size() == config.board.size() + 1)
    {
        const int dealt = card_id(view.board.back().c_str());
        if (config.board.size() == 3)
        {
            target_turn = dealt;
        }
        else
        {
            target_river = dealt;
        }
    }
    else if (view.board.size() == config.board.size() + 2)
    {
        target_turn = card_id(view.board[config.board.size()].c_str());
        target_river = card_id(view.board.back().c_str());
    }
    const int hero = view.player;
    std::map<std::string, OracleHand> hands;
    for (std::size_t deal = 0; deal < pairs.size(); ++deal)
    {
        const int hero_combo = hero == 0 ? pairs[deal].combo0 : pairs[deal].combo1;
        int hole0 = 0;
        int hole1 = 0;
        int hole2 = 0;
        int hole3 = 0;
        Range::combo_cards(pairs[deal].combo0, hole0, hole1);
        Range::combo_cards(pairs[deal].combo1, hole2, hole3);
        const auto dealt_privately = [&](int card)
        {
            return card >= 0 && (card == hole0 || card == hole1 || card == hole2 || card == hole3);
        };
        if (dealt_privately(target_turn) || dealt_privately(target_river))
        {
            continue;
        }
        const std::string combo = Range::combo_text(hero_combo);
        const double opponent_prior = hero == 0
            ? config.ip.weight(pairs[deal].combo1)
            : config.oop.weight(pairs[deal].combo0);
        double weight = opponent_prior;
        StreetGame::State state = follow_line(
            game,
            game.child_chance(game.root(), static_cast<int>(deal)),
            line,
            target_turn,
            target_river,
            profile,
            hero,
            weight);
        CHECK(!game.is_chance(state));
        CHECK(!game.is_terminal(state));
        const int infoset = game.infoset(state);
        CHECK(game.acting_player(infoset) == hero);
        CHECK(game.infoset_label(infoset).find(combo) != std::string::npos);
        OracleHand& hand = hands[combo];
        if (hand.weighted.empty())
        {
            hand.weighted.assign(static_cast<std::size_t>(game.action_count(infoset)), 0.0);
        }
        hand.weight += weight;
        for (int action = 0; action < game.action_count(infoset); ++action)
        {
            const double value = oracle_continuation(
                game, game.child_action(state, action), profile, hero);
            hand.weighted[static_cast<std::size_t>(action)] += weight * value;
        }
    }
    return hands;
}

void expect_oracle(
    const StreetConfig& config,
    StreetBatchSolver& solver,
    const std::string& node_id,
    double tolerance)
{
    const StreetInspection view = solver.inspect_node(node_id);
    CHECK(view.kind == "decision");
    const Profile profile = profile_from(solver);
    const StreetActionValues page = solver.action_values(node_id);
    CHECK(page.player == view.player);
    CHECK(page.actions.size() == view.actions.size());
    CHECK(page.combos.size() == view.hands.size());
    CHECK(page.utility_basis == "root_centered");
    CHECK(page.units == "chips");
    CHECK(page.reach_defined == view.reach_defined);
    for (std::size_t action = 0; action < view.actions.size(); ++action)
    {
        CHECK(page.actions[action] == view.actions[action].label);
    }
    for (std::size_t hand = 0; hand < view.hands.size(); ++hand)
    {
        CHECK(page.combos[hand] == view.hands[hand].combo);
    }
    const auto oracle = oracle_values(config, view, profile);
    for (int hand = 0; hand < static_cast<int>(page.combos.size()); ++hand)
    {
        const std::string& combo = page.combos[static_cast<std::size_t>(hand)];
        const auto found = oracle.find(combo);
        const bool defined = found != oracle.end() && found->second.weight > 0.0;
        CHECK(static_cast<bool>(page.ev_defined[static_cast<std::size_t>(hand)]) == defined);
        if (!view.hands[static_cast<std::size_t>(hand)].structural)
        {
            CHECK(!page.ev_defined[static_cast<std::size_t>(hand)]);
        }
        if (!defined)
        {
            continue;
        }
        CHECK(std::isfinite(page.mixed_ev[static_cast<std::size_t>(hand)]));
        double mixed = 0.0;
        CHECK(found->second.weighted.size() == page.actions.size());
        for (int action = 0; action < static_cast<int>(page.actions.size()); ++action)
        {
            const double expected = found->second.weighted[static_cast<std::size_t>(action)]
                / found->second.weight;
            const double got = page.action_ev[static_cast<std::size_t>(
                hand * static_cast<int>(page.actions.size()) + action)];
            CHECK(std::isfinite(got));
            CHECK_NEAR(got, expected, tolerance);
            mixed += view.hands[static_cast<std::size_t>(hand)].strategy[static_cast<std::size_t>(action)] * got;
        }
        CHECK_NEAR(page.mixed_ev[static_cast<std::size_t>(hand)], mixed, tolerance);
    }
}

double page_action(const StreetActionValues& page, int hand, int action)
{
    return page.action_ev[static_cast<std::size_t>(hand * static_cast<int>(page.actions.size()) + action)];
}

StreetConfig bluff_config(const char* air_weight, const char* ip_weight)
{
    StreetConfig config;
    config.board = {card_id("Kh"), card_id("Kd"), card_id("7c"), card_id("4s")};
    config.pot = 100;
    config.stack = 100;
    config.oop = Range::parse(std::string("KcKs:1,2c3d:") + air_weight);
    config.ip = Range::parse(std::string("AhAd:") + ip_weight);
    config.oop_turn_bets = {1.0};
    config.allow_all_in = false;
    config.max_raises = 1;
    config.memory_mib = 64;
    return config;
}

void install_bluff(StreetBatchSolver& solver, double air_shove, double ip_call)
{
    const std::string root = solver.root_node_id();
    set_named_average(solver, root, combo_name("Kc", "Ks"), {{"Check", 1.0 - 1.0}, {"Bet", 1.0}});
    set_named_average(solver, root, combo_name("2c", "3d"), {{"Check", 1.0 - air_shove}, {"Bet", air_shove}});
    const StreetInspection opening = solver.inspect_node(root);
    const int bet = find_action(
        [&]()
        {
            std::vector<std::string> labels;
            for (const auto& action : opening.actions)
            {
                labels.push_back(action.label);
            }
            return labels;
        }(),
        "Bet");
    CHECK(bet >= 0);
    const std::string facing = opening.actions[static_cast<std::size_t>(bet)].child_id;
    set_named_average(
        solver, facing, combo_name("Ah", "Ad"), {{"Fold", 1.0 - ip_call}, {"Call", ip_call}});
}

void test_turn_bluff_fixture()
{
    StreetConfig config = bluff_config("1", "1");
    StreetBatchSolver solver(config);
    install_bluff(solver, 0.5, 0.5);
    const double stored_ev = solver.expected_utility();
    const TableSnapshot before = snapshot_of(solver);
    const std::string root = solver.root_node_id();
    const StreetActionValues page = solver.action_values(root);
    expect_unchanged(solver, before);
    const int nuts = find_hand(page.combos, combo_name("Kc", "Ks"));
    const int air = find_hand(page.combos, combo_name("2c", "3d"));
    const int check = find_action(page.actions, "Check");
    const int shove = find_action(page.actions, "Bet");
    CHECK(nuts >= 0 && air >= 0 && check >= 0 && shove >= 0);
    CHECK(page.ev_defined[static_cast<std::size_t>(nuts)]);
    CHECK(page.ev_defined[static_cast<std::size_t>(air)]);
    CHECK_NEAR(page_action(page, nuts, check), 50.0, 1e-9);
    CHECK_NEAR(page_action(page, nuts, shove), 100.0, 1e-9);
    CHECK_NEAR(page_action(page, air, check), -50.0, 1e-9);
    CHECK_NEAR(page_action(page, air, shove), -50.0, 1e-9);
    CHECK_NEAR(page.mixed_ev[static_cast<std::size_t>(nuts)], 100.0, 1e-9);
    CHECK_NEAR(page.mixed_ev[static_cast<std::size_t>(air)], -50.0, 1e-9);
    CHECK(page.node_ev_defined);
    CHECK_NEAR(page.node_ev, 25.0, 1e-9);
    CHECK_NEAR(page.node_ev, stored_ev, 1e-9);
    CHECK(page.reach_defined);

    const StreetInspection opening = solver.inspect_node(root);
    const std::string facing = opening.actions[static_cast<std::size_t>(shove)].child_id;
    const StreetActionValues response = solver.action_values(facing);
    const int aces = find_hand(response.combos, combo_name("Ah", "Ad"));
    const int fold = find_action(response.actions, "Fold");
    const int call = find_action(response.actions, "Call");
    CHECK(response.player == 1);
    CHECK(aces >= 0 && fold >= 0 && call >= 0);
    CHECK(response.ev_defined[static_cast<std::size_t>(aces)]);
    CHECK_NEAR(page_action(response, aces, fold), -50.0, 1e-9);
    CHECK_NEAR(page_action(response, aces, call), -50.0, 1e-9);
    expect_oracle(config, solver, root, 1e-9);
    expect_oracle(config, solver, facing, 1e-9);
    const StreetActionValues again = solver.action_values(facing);
    CHECK(again.query_seconds == 0.0);
    CHECK_NEAR(page_action(again, aces, call), -50.0, 1e-9);
    expect_unchanged(solver, before);

    StreetBatchSolver pure(config);
    install_bluff(pure, 0.0, 0.0);
    const StreetInspection pure_root = pure.inspect_node(pure.root_node_id());
    const int pure_bet = find_action(
        [&]()
        {
            std::vector<std::string> labels;
            for (const auto& action : pure_root.actions)
            {
                labels.push_back(action.label);
            }
            return labels;
        }(),
        "Bet");
    const StreetActionValues forced = pure.action_values(
        pure_root.actions[static_cast<std::size_t>(pure_bet)].child_id);
    const int pure_aces = find_hand(forced.combos, combo_name("Ah", "Ad"));
    const int pure_fold = find_action(forced.actions, "Fold");
    const int pure_call = find_action(forced.actions, "Call");
    CHECK(forced.ev_defined[static_cast<std::size_t>(pure_aces)]);
    CHECK_NEAR(page_action(forced, pure_aces, pure_fold), -50.0, 1e-9);
    CHECK_NEAR(page_action(forced, pure_aces, pure_call), -150.0, 1e-9);
    CHECK_NEAR(forced.mixed_ev[static_cast<std::size_t>(pure_aces)], -50.0, 1e-9);
    expect_oracle(
        config, pure, pure_root.actions[static_cast<std::size_t>(pure_bet)].child_id, 1e-9);
}

void test_scale_and_prior_do_not_change_action_ev()
{
    const auto value_of = [](const char* air_weight, const char* ip_weight)
    {
        StreetConfig config = bluff_config(air_weight, ip_weight);
        StreetBatchSolver solver(config);
        install_bluff(solver, 0.5, 0.5);
        return solver.action_values(solver.root_node_id());
    };
    const StreetActionValues base = value_of("1", "1");
    const StreetActionValues tiny_opponent = value_of("1", "1e-18");
    const StreetActionValues heavy_hero = value_of("4", "1");
    const int nuts = find_hand(base.combos, combo_name("Kc", "Ks"));
    const int air = find_hand(base.combos, combo_name("2c", "3d"));
    CHECK(nuts >= 0 && air >= 0);
    for (const StreetActionValues* other : {&tiny_opponent, &heavy_hero})
    {
        const int other_nuts = find_hand(other->combos, combo_name("Kc", "Ks"));
        const int other_air = find_hand(other->combos, combo_name("2c", "3d"));
        CHECK(other_nuts >= 0 && other_air >= 0);
        CHECK(other->ev_defined[static_cast<std::size_t>(other_nuts)]);
        CHECK(other->ev_defined[static_cast<std::size_t>(other_air)]);
        for (int action = 0; action < static_cast<int>(base.actions.size()); ++action)
        {
            CHECK_NEAR(
                page_action(*other, other_nuts, action), page_action(base, nuts, action), 1e-9);
            CHECK_NEAR(
                page_action(*other, other_air, action), page_action(base, air, action), 1e-9);
        }
    }
}

void test_zero_reach_is_separate_from_ev()
{
    StreetConfig config;
    config.board = {card_id("Kh"), card_id("Kd"), card_id("7c"), card_id("4s")};
    config.pot = 100;
    config.stack = 100;
    config.oop = Range::parse("AhAd");
    config.ip = Range::parse("2c3d");
    config.oop_turn_bets = {1.0};
    config.ip_turn_bets = {1.0};
    config.allow_all_in = false;
    config.max_raises = 1;
    config.memory_mib = 64;
    StreetBatchSolver solver(config);
    const std::string root = solver.root_node_id();
    set_named_average(solver, root, combo_name("Ah", "Ad"), {{"Check", 0.0}, {"Bet", 1.0}});
    const StreetInspection opening = solver.inspect_node(root);
    const int check = find_action(
        [&]()
        {
            std::vector<std::string> labels;
            for (const auto& action : opening.actions)
            {
                labels.push_back(action.label);
            }
            return labels;
        }(),
        "Check");
    CHECK(check >= 0);
    const StreetInspection ip_node = solver.inspect_node(opening.actions[static_cast<std::size_t>(check)].child_id);
    CHECK(ip_node.player == 1);
    const int ip_bet = find_action(
        [&]()
        {
            std::vector<std::string> labels;
            for (const auto& action : ip_node.actions)
            {
                labels.push_back(action.label);
            }
            return labels;
        }(),
        "Bet");
    CHECK(ip_bet >= 0);
    set_named_average(solver, ip_node.node_id, combo_name("2c", "3d"), {{"Check", 0.0}, {"Bet", 1.0}});
    const StreetInspection later = solver.inspect_node(ip_node.actions[static_cast<std::size_t>(ip_bet)].child_id);
    CHECK(later.kind == "decision");
    CHECK(later.player == 0);
    CHECK(!later.reach_defined);
    const int hero = find_inspected_hand(later, combo_name("Ah", "Ad"));
    CHECK(hero >= 0);
    CHECK(later.hands[static_cast<std::size_t>(hero)].structural);
    CHECK(later.hands[static_cast<std::size_t>(hero)].reach == 0.0);
    const StreetActionValues defined = solver.action_values(later.node_id);
    CHECK(!defined.reach_defined);
    CHECK(!defined.node_ev_defined);
    CHECK(defined.ev_defined[static_cast<std::size_t>(hero)]);
    for (double value : defined.action_ev)
    {
        if (defined.ev_defined[static_cast<std::size_t>(hero)])
        {
            CHECK(std::isfinite(value));
        }
    }
    expect_oracle(config, solver, later.node_id, 1e-9);

    set_named_average(solver, ip_node.node_id, combo_name("2c", "3d"), {{"Check", 1.0}, {"Bet", 0.0}});
    const StreetActionValues undefined = solver.action_values(later.node_id);
    CHECK(!undefined.reach_defined);
    CHECK(!undefined.ev_defined[static_cast<std::size_t>(hero)]);
    CHECK(!undefined.node_ev_defined);
    expect_oracle(config, solver, later.node_id, 1e-9);
}

void test_weighted_blockers_ties_and_flop()
{
    StreetConfig weighted;
    weighted.board = {card_id("Kh"), card_id("Kd"), card_id("7c"), card_id("4s")};
    weighted.pot = 100;
    weighted.stack = 80;
    weighted.oop = Range::parse("AhAd:1,2c3d:3");
    weighted.ip = Range::parse("AdKc:2,7h8d:0.5");
    weighted.oop_turn_bets = {0.5};
    weighted.ip_turn_bets = {0.5};
    weighted.oop_river_bets = {0.5};
    weighted.allow_all_in = true;
    weighted.max_raises = 1;
    weighted.memory_mib = 64;
    StreetBatchSolver weighted_solver(weighted);
    weighted_solver.run_frozen_iterations(2, poker::solver::Algorithm::CfrPlus);
    const double stored_ev = weighted_solver.expected_utility();
    const TableSnapshot before = snapshot_of(weighted_solver);
    const std::string root = weighted_solver.root_node_id();
    const StreetActionValues root_values = weighted_solver.action_values(root);
    CHECK(root_values.node_ev_defined);
    CHECK_NEAR(root_values.node_ev, stored_ev, 1e-9);
    expect_oracle(weighted, weighted_solver, root, 1e-9);
    const StreetInspection opening = weighted_solver.inspect_node(root);
    bool saw_ip = false;
    for (const auto& action : opening.actions)
    {
        const StreetInspection child = weighted_solver.inspect_node(action.child_id);
        if (child.kind == "decision" && child.player == 1)
        {
            expect_oracle(weighted, weighted_solver, action.child_id, 1e-9);
            saw_ip = true;
        }
    }
    CHECK(saw_ip);
    expect_unchanged(weighted_solver, before);

    StreetConfig tied;
    tied.board = {card_id("Ah"), card_id("Kd"), card_id("Qc"), card_id("Js")};
    tied.pot = 100;
    tied.stack = 50;
    tied.oop = Range::parse("2c3d:1.5");
    tied.ip = Range::parse("2h3h:0.25");
    tied.oop_turn_bets = {1.0};
    tied.allow_all_in = false;
    tied.max_raises = 1;
    tied.memory_mib = 32;
    StreetBatchSolver tie_solver(tied);
    const StreetActionValues tie_values = tie_solver.action_values(tie_solver.root_node_id());
    const int tie_hand = find_hand(tie_values.combos, combo_name("2c", "3d"));
    const int tie_check = find_action(tie_values.actions, "Check");
    CHECK(tie_hand >= 0 && tie_check >= 0);
    CHECK(tie_values.ev_defined[static_cast<std::size_t>(tie_hand)]);
    CHECK_NEAR(page_action(tie_values, tie_hand, tie_check), 0.0, 1e-9);
    expect_oracle(tied, tie_solver, tie_solver.root_node_id(), 1e-9);

    StreetConfig flop;
    flop.board = {card_id("Ah"), card_id("Kd"), card_id("7c")};
    flop.pot = 100;
    flop.stack = 100;
    flop.oop = Range::parse("QcQd:2,JsJd:0.5");
    flop.ip = Range::parse("QcTc:1,2c3d:4");
    flop.allow_all_in = false;
    flop.max_raises = 0;
    flop.memory_mib = 64;
    StreetBatchSolver flop_solver(flop);
    const std::string flop_root = flop_solver.root_node_id();
    expect_oracle(flop, flop_solver, flop_root, 1e-8);
    const StreetActionValues flop_values = flop_solver.action_values(flop_root);
    CHECK(flop_values.node_ev_defined);
    CHECK_NEAR(flop_values.node_ev, flop_solver.expected_utility(), 1e-8);
    StreetInspection cursor = flop_solver.inspect_node(flop_root);
    std::string chance_id;
    for (int guard = 0; guard < 8 && cursor.board.size() == flop.board.size(); ++guard)
    {
        if (cursor.kind == "chance")
        {
            chance_id = cursor.node_id;
            CHECK(!cursor.cards.empty());
            cursor = flop_solver.inspect_node(cursor.cards[0].child_id);
        }
        else if (cursor.kind == "decision")
        {
            CHECK(!cursor.actions.empty());
            cursor = flop_solver.inspect_node(cursor.actions[0].child_id);
        }
        else
        {
            break;
        }
    }
    CHECK(cursor.kind == "decision");
    CHECK(cursor.board.size() > flop.board.size());
    expect_oracle(flop, flop_solver, cursor.node_id, 1e-8);
    CHECK(!chance_id.empty());
    bool rejected = false;
    try
    {
        (void)flop_solver.action_values(chance_id);
    }
    catch (const std::invalid_argument&)
    {
        rejected = true;
    }
    CHECK(rejected);
}

void expect_same_defined_values(const StreetActionValues& left, const StreetActionValues& right)
{
    CHECK(left.player == right.player);
    CHECK(left.actions == right.actions);
    CHECK(left.combos == right.combos);
    CHECK(left.ev_defined == right.ev_defined);
    CHECK(left.reach_defined == right.reach_defined);
    CHECK(left.node_ev_defined == right.node_ev_defined);
    if (left.node_ev_defined && right.node_ev_defined)
    {
        CHECK_NEAR(left.node_ev, right.node_ev, 1e-8);
    }
    CHECK(left.mixed_ev.size() == right.mixed_ev.size());
    CHECK(left.action_ev.size() == right.action_ev.size());
    const int actions = static_cast<int>(left.actions.size());
    for (int hand = 0; hand < static_cast<int>(left.ev_defined.size()); ++hand)
    {
        if (left.ev_defined[static_cast<std::size_t>(hand)] == 0)
        {
            continue;
        }
        CHECK_NEAR(left.mixed_ev[static_cast<std::size_t>(hand)], right.mixed_ev[static_cast<std::size_t>(hand)], 1e-8);
        for (int action = 0; action < actions; ++action)
        {
            CHECK_NEAR(page_action(left, hand, action), page_action(right, hand, action), 1e-8);
        }
    }
}

StreetActionValues fresh_frozen(const StreetConfig& config, int iterations)
{
    StreetBatchSolver reference(config);
    reference.run_frozen_iterations(iterations, Algorithm::CfrPlus);
    return reference.action_values(reference.root_node_id());
}

void test_profile_revision_drops_stale_values()
{
    const StreetConfig config = bluff_config("1", "1");
    StreetBatchSolver solver(config);
    solver.run_frozen_iterations(1, Algorithm::CfrPlus);
    const std::string root = solver.root_node_id();
    const StreetActionValues first = solver.action_values(root);
    CHECK_NEAR(first.node_ev, fresh_frozen(config, 1).node_ev, 1e-8);
    const std::uint64_t epoch = solver.profile_epoch();
    const StreetActionValues repeat = solver.action_values(root);
    CHECK(repeat.query_seconds == 0.0);
    CHECK(solver.profile_epoch() == epoch);

    solver.continue_frozen_iterations(29, Algorithm::CfrPlus);
    CHECK(solver.profile_epoch() != epoch);
    (void)solver.expected_utility();
    (void)solver.average_strategy_entries();
    solver.prepare_inspection();
    (void)solver.profile_epoch();
    (void)solver.inspect_node(root);
    const StreetActionValues continued = solver.action_values(root);
    CHECK(continued.query_seconds != 0.0);
    expect_same_defined_values(continued, fresh_frozen(config, 30));
    const StreetActionValues continued_again = solver.action_values("p00.t-1.r-1");
    CHECK(continued_again.query_seconds == 0.0);
    CHECK(continued_again.node_id == "p00.t-1.r-1");
    expect_same_defined_values(continued_again, continued);

    StreetBatchSolver sequential(config);
    sequential.run_iterations(1, Algorithm::CfrPlus);
    const StreetActionValues sequential_first = sequential.action_values(sequential.root_node_id());
    sequential.continue_iterations(4, Algorithm::CfrPlus);
    (void)sequential.expected_utility();
    const StreetActionValues sequential_continued = sequential.action_values(sequential.root_node_id());
    CHECK(sequential_continued.query_seconds != 0.0);
    StreetBatchSolver sequential_fresh(config);
    sequential_fresh.run_iterations(5, Algorithm::CfrPlus);
    expect_same_defined_values(
        sequential_continued, sequential_fresh.action_values(sequential_fresh.root_node_id()));
    CHECK(std::abs(sequential_continued.node_ev - sequential_first.node_ev) > 1e-6);

    StreetBatchSolver reset_solver(config);
    reset_solver.run_frozen_iterations(1, Algorithm::CfrPlus);
    (void)reset_solver.action_values(reset_solver.root_node_id());
    reset_solver.run_frozen_iterations(5, Algorithm::CfrPlus);
    expect_same_defined_values(
        reset_solver.action_values(reset_solver.root_node_id()), fresh_frozen(config, 5));

    SolveConfig solved;
    solved.max_iterations = 4;
    solved.nash_gap_threshold = -1.0;
    StreetBatchSolver frozen_solve(config);
    frozen_solve.solve_frozen(solved, Algorithm::CfrPlus);
    (void)frozen_solve.inspect_node(frozen_solve.root_node_id());
    expect_same_defined_values(
        frozen_solve.action_values(frozen_solve.root_node_id()), fresh_frozen(config, 4));
    StreetBatchSolver sequential_solve(config);
    sequential_solve.solve(solved, Algorithm::CfrPlus);
    StreetBatchSolver sequential_solved_fresh(config);
    sequential_solved_fresh.run_iterations(4, Algorithm::CfrPlus);
    expect_same_defined_values(
        sequential_solve.action_values(sequential_solve.root_node_id()),
        sequential_solved_fresh.action_values(sequential_solved_fresh.root_node_id()));

    StreetBatchSolver edited(config);
    edited.run_frozen_iterations(1, Algorithm::CfrPlus);
    const StreetActionValues before_edit = edited.action_values(edited.root_node_id());
    const std::uint64_t before_epoch = edited.profile_epoch();
    set_named_average(edited, edited.root_node_id(), combo_name("Kc", "Ks"), {{"Check", 0.0}, {"Bet", 1.0}});
    CHECK(edited.profile_epoch() != before_epoch);
    const StreetActionValues after_edit = edited.action_values(edited.root_node_id());
    CHECK(after_edit.query_seconds != 0.0);
    CHECK(std::abs(after_edit.node_ev - before_edit.node_ev) > 1e-6);

    const StreetInspection edited_root = edited.inspect_node(edited.root_node_id());
    const int edited_bet = find_action(
        [&]()
        {
            std::vector<std::string> labels;
            for (const auto& action : edited_root.actions)
            {
                labels.push_back(action.label);
            }
            return labels;
        }(),
        "Bet");
    CHECK(edited_bet >= 0);
    const std::string facing = edited_root.actions[static_cast<std::size_t>(edited_bet)].child_id;
    std::atomic<bool> cancel{true};
    bool cancelled = false;
    try
    {
        (void)edited.action_values(facing, &cancel);
    }
    catch (const StreetValueCancelled&)
    {
        cancelled = true;
    }
    CHECK(cancelled);
    const StreetActionValues after_cancel = edited.action_values(edited.root_node_id());
    CHECK(after_cancel.query_seconds == 0.0);
    expect_same_defined_values(after_cancel, after_edit);
    const StreetActionValues facing_page = edited.action_values(facing);
    CHECK(facing_page.query_seconds != 0.0);
    CHECK(facing_page.player == 1);

    StreetBatchSolver published(config);
    published.run_frozen_iterations(1, Algorithm::CfrPlus);
    const std::string published_root = published.root_node_id();
    (void)published.action_values(published_root);
    StreetInspection cursor = published.inspect_node(published_root);
    std::string chance_id;
    for (int step = 0; step < 8 && chance_id.empty(); ++step)
    {
        if (cursor.kind == "chance")
        {
            chance_id = cursor.node_id;
            break;
        }
        if (cursor.kind != "decision" || cursor.actions.empty())
        {
            break;
        }
        cursor = published.inspect_node(cursor.actions[0].child_id);
    }
    CHECK(!chance_id.empty());
    bool rejected = false;
    try
    {
        (void)published.action_values(chance_id);
    }
    catch (const std::invalid_argument&)
    {
        rejected = true;
    }
    CHECK(rejected);
    CHECK(published.action_values(published_root).query_seconds == 0.0);

    published.arm_value_cache_failure_for_test();
    published.continue_frozen_iterations(1, Algorithm::CfrPlus);
    bool failed = false;
    try
    {
        (void)published.action_values(published_root);
    }
    catch (const std::bad_alloc&)
    {
        failed = true;
    }
    CHECK(failed);
    const StreetActionValues repaired = published.action_values(published_root);
    CHECK(repaired.query_seconds != 0.0);
    expect_same_defined_values(repaired, fresh_frozen(config, 2));
}

} // namespace

void run_action_value_tests()
{
    test_turn_bluff_fixture();
    test_scale_and_prior_do_not_change_action_ev();
    test_zero_reach_is_separate_from_ev();
    test_weighted_blockers_ties_and_flop();
    test_profile_revision_drops_stale_values();
}
