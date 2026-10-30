#include "solver/river_batch.hpp"

#include "poker/card.hpp"
#include "poker/hand_eval.hpp"
#include "poker/range.hpp"
#include "solver/regret_matching.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <span>
#include <stdexcept>
#include <string>
#include <vector>

namespace poker::solver
{
namespace
{

struct BetState
{
    int contrib[2] = {};
    int pot = 0;
    int committed = 0;
    int last_raise = 0;
    int num_raises = 0;
    int acting = 0;
    int folded = -1;
    bool terminal = false;
    bool pending_check = false;
};

struct Legal
{
    int count = 0;
    int code[8] = {};
    int add[8] = {};
};

int round_chips(double fraction, int basis)
{
    return static_cast<int>(std::llround(fraction * static_cast<double>(basis)));
}

std::string chip_label(int code, int add, int street_total, bool all_in, bool facing)
{
    std::string text;
    if (code == 0)
    {
        text = "Fold";
    }
    else if (code == 1 && !facing)
    {
        text = "Check";
    }
    else if (code == 1)
    {
        text = "Call";
    }
    else if (!facing)
    {
        text = "Bet " + std::to_string(add);
    }
    else
    {
        text = "Raise to " + std::to_string(street_total);
    }
    if (all_in && code != 0)
    {
        text += " all-in";
    }
    return text;
}

const std::vector<double>& size_list(const river::RiverConfig& config, int player, bool facing)
{
    if (player == 0)
    {
        return facing ? config.oop_raise_sizes : config.oop_bet_sizes;
    }
    return facing ? config.ip_raise_sizes : config.ip_bet_sizes;
}

Legal legal_actions(const river::RiverConfig& config, const BetState& state)
{
    const int player = state.acting;
    const int to_call = state.committed - state.contrib[player];
    const bool facing = to_call > 0;
    const int max_add = config.stack - state.contrib[player];
    if (to_call < 0 || max_add < 0)
    {
        throw std::logic_error("river stack accounting failed");
    }

    int amounts[8] = {};
    int n_amounts = 0;
    const int aggressive_limit = facing ? 6 : 7;
    const auto push_amount = [&](int add)
    {
        for (int i = 0; i < n_amounts; ++i)
        {
            if (amounts[i] == add)
            {
                return;
            }
        }
        if (n_amounts >= aggressive_limit)
        {
            throw std::invalid_argument(
                "a river decision has more than 8 actions; use fewer bet sizes");
        }
        int slot = n_amounts;
        while (slot > 0 && amounts[slot - 1] > add)
        {
            amounts[slot] = amounts[slot - 1];
            --slot;
        }
        amounts[slot] = add;
        ++n_amounts;
    };
    const auto consider = [&](int add)
    {
        if (config.max_raises <= state.num_raises || add < 1)
        {
            return;
        }
        if (add > max_add)
        {
            if (!config.allow_all_in)
            {
                return;
            }
            add = max_add;
        }
        const int raise_by = add - to_call;
        if (raise_by <= 0)
        {
            return;
        }
        const int min_increment = state.last_raise == 0 ? 1 : state.last_raise;
        const bool full = raise_by >= min_increment;
        const bool shove = state.contrib[player] + add == config.stack;
        if (!full && !(config.allow_all_in && shove))
        {
            return;
        }
        push_amount(add);
    };

    const int basis = facing ? state.pot + to_call : state.pot;
    for (double fraction : size_list(config, player, facing))
    {
        const int sized = round_chips(fraction, basis);
        consider(facing ? to_call + sized : sized);
    }
    if (config.allow_all_in)
    {
        consider(max_add);
    }

    Legal legal;
    if (facing)
    {
        legal.code[legal.count] = 0;
        legal.add[legal.count] = 0;
        ++legal.count;
        const int call_add = to_call < max_add ? to_call : max_add;
        legal.code[legal.count] = 1;
        legal.add[legal.count] = call_add;
        ++legal.count;
    }
    else
    {
        legal.code[legal.count] = 1;
        legal.add[legal.count] = 0;
        ++legal.count;
    }
    for (int i = 0; i < n_amounts; ++i)
    {
        if (legal.count >= 8)
        {
            throw std::invalid_argument(
                "a river decision has more than 8 actions; use fewer bet sizes");
        }
        legal.code[legal.count] = 2;
        legal.add[legal.count] = amounts[i];
        ++legal.count;
    }
    return legal;
}

BetState apply_action(const river::RiverConfig& config, const BetState& state, const Legal& legal, int action)
{
    BetState next = state;
    const int player = state.acting;
    const int code = legal.code[action];
    const int add = legal.add[action];
    if (code == 0)
    {
        next.folded = player;
        next.terminal = true;
        next.acting = -1;
        return next;
    }
    const int to_call = state.committed - state.contrib[player];
    next.contrib[player] += add;
    next.pot += add;
    if (code == 1)
    {
        if (to_call > 0 || state.pending_check)
        {
            next.terminal = true;
            next.acting = -1;
            next.pending_check = false;
            return next;
        }
        next.pending_check = true;
        next.acting = 1 - player;
        return next;
    }
    const int raise_by = add - to_call;
    next.pending_check = false;
    next.last_raise = raise_by;
    next.committed = next.contrib[player];
    next.num_raises += 1;
    next.acting = 1 - player;
    (void)config;
    return next;
}

} // namespace

struct RiverBatchSolver::Engine
{
    struct Deal
    {
        int h0 = 0;
        int h1 = 0;
        double probability = 0.0;
    };

    struct Node
    {
        bool terminal = false;
        int player = -1;
        int folded = -1;
        int contrib[2] = {};
        int n_actions = 0;
        int child[8] = {};
        int hand_base = 0;
        std::string path;
        std::string action_labels[8];
    };

    struct Slot
    {
        std::string label;
        int node = 0;
        int base = 0;
        int n_actions = 0;
    };

    river::RiverConfig config;
    std::vector<int> combos[2];
    std::vector<Deal> deals;
    std::vector<double> weight;
    std::vector<std::int8_t> showdown;
    std::vector<Node> nodes;
    std::vector<Slot> slots;
    std::vector<double> regret;
    std::vector<double> pass_sigma;
    std::vector<double> strategy_sum;
    mutable std::vector<double> average;
    mutable bool average_ready = false;
    int n0 = 0;
    int n1 = 0;
    int public_decisions = 0;
    int public_terminals = 0;

    explicit Engine(river::RiverConfig incoming)
        : config(std::move(incoming))
    {
        holdem::validate_board(config.board.data(), 5);
        if (config.pot <= 0)
        {
            throw std::invalid_argument("river pot must be positive");
        }
        if (config.stack < 0)
        {
            throw std::invalid_argument("river stack must be nonnegative");
        }
        if (config.first_to_act != 0 && config.first_to_act != 1)
        {
            throw std::invalid_argument("first player must be 0 (OOP) or 1 (IP)");
        }
        if (config.max_raises < 0 || config.max_raises > 6)
        {
            throw std::invalid_argument("max raises must be from 0 through 6");
        }

        BetState root;
        root.pot = config.pot;
        root.acting = config.first_to_act;
        build_node(root, "");
        build_deals();
        assign_bases();
    }

    int build_node(const BetState& state, const std::string& path)
    {
        if (state.terminal)
        {
            Node node;
            node.terminal = true;
            node.folded = state.folded;
            node.contrib[0] = state.contrib[0];
            node.contrib[1] = state.contrib[1];
            nodes.push_back(node);
            ++public_terminals;
            return static_cast<int>(nodes.size()) - 1;
        }

        const Legal legal = legal_actions(config, state);
        const bool facing = state.committed > state.contrib[state.acting];
        Node node;
        node.player = state.acting;
        node.n_actions = legal.count;
        node.path = path;
        for (int action = 0; action < legal.count; ++action)
        {
            const int street_total = state.contrib[state.acting] + legal.add[action];
            const bool all_in = legal.code[action] != 0 && street_total == config.stack && legal.add[action] > 0;
            node.action_labels[action] = chip_label(
                legal.code[action], legal.add[action], street_total, all_in, facing);
        }
        const int id = static_cast<int>(nodes.size());
        nodes.push_back(node);
        ++public_decisions;
        for (int action = 0; action < legal.count; ++action)
        {
            const std::string& label = nodes[static_cast<std::size_t>(id)].action_labels[action];
            const std::string next_path = path.empty() ? label : path + "/" + label;
            const int child = build_node(apply_action(config, state, legal, action), next_path);
            nodes[static_cast<std::size_t>(id)].child[action] = child;
        }
        return id;
    }

    int hand_index(int player, int combo)
    {
        for (int i = 0; i < static_cast<int>(combos[player].size()); ++i)
        {
            if (combos[player][static_cast<std::size_t>(i)] == combo)
            {
                return i;
            }
        }
        combos[player].push_back(combo);
        return static_cast<int>(combos[player].size()) - 1;
    }

    void build_deals()
    {
        const std::vector<holdem::HandPairProbability> rows = holdem::joint_distribution(
            config.oop, config.ip, config.board.data(), 5);
        if (rows.empty())
        {
            throw std::invalid_argument("ranges leave no legal river hand pair");
        }
        std::vector<std::pair<int, int>> pairs;
        pairs.reserve(rows.size());
        for (const holdem::HandPairProbability& row : rows)
        {
            pairs.emplace_back(hand_index(0, row.combo0), hand_index(1, row.combo1));
        }
        n0 = static_cast<int>(combos[0].size());
        n1 = static_cast<int>(combos[1].size());
        weight.assign(static_cast<std::size_t>(n0 * n1), 0.0);
        showdown.assign(static_cast<std::size_t>(n0 * n1), 0);
        const std::span<const int> board(config.board.data(), config.board.size());
        deals.reserve(rows.size());
        for (std::size_t i = 0; i < rows.size(); ++i)
        {
            Deal deal;
            deal.h0 = pairs[i].first;
            deal.h1 = pairs[i].second;
            deal.probability = rows[i].probability;
            deals.push_back(deal);
            const std::size_t cell = static_cast<std::size_t>(deal.h0 * n1 + deal.h1);
            weight[cell] = deal.probability;
            int c0 = 0;
            int c1 = 0;
            int d0 = 0;
            int d1 = 0;
            holdem::Range::combo_cards(combos[0][static_cast<std::size_t>(deal.h0)], c0, c1);
            holdem::Range::combo_cards(combos[1][static_cast<std::size_t>(deal.h1)], d0, d1);
            showdown[cell] = static_cast<std::int8_t>(holdem::compare_showdown(c0, c1, d0, d1, board));
        }
    }

    void assign_bases()
    {
        int cursor = 0;
        for (Node& node : nodes)
        {
            if (node.terminal)
            {
                continue;
            }
            node.hand_base = cursor;
            const int hands = node.player == 0 ? n0 : n1;
            cursor += hands * node.n_actions;
            for (int hand = 0; hand < hands; ++hand)
            {
                Slot slot;
                const int combo = combos[node.player][static_cast<std::size_t>(hand)];
                slot.label = node.player == 0 ? "OOP " : "IP ";
                slot.label += holdem::Range::combo_text(combo);
                slot.label += " | ";
                slot.label += node.path.empty() ? "open" : node.path;
                slot.node = static_cast<int>(&node - nodes.data());
                slot.base = node.hand_base + hand * node.n_actions;
                slot.n_actions = node.n_actions;
                slots.push_back(std::move(slot));
            }
        }
        regret.assign(static_cast<std::size_t>(cursor), 0.0);
        pass_sigma.assign(static_cast<std::size_t>(cursor), 0.0);
        strategy_sum.assign(static_cast<std::size_t>(cursor), 0.0);
        average.assign(static_cast<std::size_t>(cursor), 0.0);
    }

    double payoff(const Node& node, int h0, int h1) const
    {
        const double half = static_cast<double>(config.pot) * 0.5;
        if (node.folded == 0)
        {
            return -(half + static_cast<double>(node.contrib[0]));
        }
        if (node.folded == 1)
        {
            return half + static_cast<double>(node.contrib[1]);
        }
        const int outcome = showdown[static_cast<std::size_t>(h0 * n1 + h1)];
        if (outcome > 0)
        {
            return half + static_cast<double>(node.contrib[1]);
        }
        if (outcome < 0)
        {
            return -(half + static_cast<double>(node.contrib[0]));
        }
        return 0.0;
    }

    double cfr_deal(int node_index, double pi0, double pi1, double chance, int h0, int h1,
                    int updating, double weight_iter)
    {
        const Node& node = nodes[static_cast<std::size_t>(node_index)];
        if (node.terminal)
        {
            return payoff(node, h0, h1);
        }
        const int hand = node.player == 0 ? h0 : h1;
        const int base = node.hand_base + hand * node.n_actions;
        const double* sigma = pass_sigma.data() + base;
        const bool update = updating < 0 || updating == node.player;
        if (update)
        {
            const double reach = node.player == 0 ? pi0 : pi1;
            accumulate_average(strategy_sum.data() + base, sigma, node.n_actions, weight_iter * reach);
        }
        double action_utility[8];
        double node_utility = 0.0;
        for (int action = 0; action < node.n_actions; ++action)
        {
            if (node.player == 0)
            {
                action_utility[action] = cfr_deal(
                    node.child[action], pi0 * sigma[action], pi1, chance, h0, h1, updating, weight_iter);
            }
            else
            {
                action_utility[action] = cfr_deal(
                    node.child[action], pi0, pi1 * sigma[action], chance, h0, h1, updating, weight_iter);
            }
            node_utility += sigma[action] * action_utility[action];
        }
        if (update)
        {
            const double opponent_reach = (node.player == 0 ? pi1 : pi0) * chance;
            for (int action = 0; action < node.n_actions; ++action)
            {
                const double instant = node.player == 0
                    ? (action_utility[action] - node_utility)
                    : (node_utility - action_utility[action]);
                regret[static_cast<std::size_t>(base + action)] += opponent_reach * instant;
            }
        }
        return node_utility;
    }

    void freeze_sigma()
    {
        for (const Slot& slot : slots)
        {
            regret_matching(
                regret.data() + slot.base,
                pass_sigma.data() + slot.base,
                slot.n_actions);
        }
    }

    void floor_player(int player)
    {
        for (const Slot& slot : slots)
        {
            if (player >= 0 && nodes[static_cast<std::size_t>(slot.node)].player != player)
            {
                continue;
            }
            for (int action = 0; action < slot.n_actions; ++action)
            {
                double& cumulative = regret[static_cast<std::size_t>(slot.base + action)];
                if (cumulative < 0.0)
                {
                    cumulative = 0.0;
                }
            }
        }
    }

    int trained = 0;

    void reset()
    {
        std::fill(regret.begin(), regret.end(), 0.0);
        std::fill(strategy_sum.begin(), strategy_sum.end(), 0.0);
        average_ready = false;
        trained = 0;
    }

    void train_more(int count, Algorithm algorithm)
    {
        if (algorithm != Algorithm::VanillaCfr && algorithm != Algorithm::CfrPlus)
        {
            throw std::invalid_argument("the public river tree implements vanilla CFR and CFR+");
        }
        average_ready = false;
        for (int step = 0; step < count; ++step)
        {
            ++trained;
            if (algorithm == Algorithm::VanillaCfr)
            {
                freeze_sigma();
                for (const Deal& deal : deals)
                {
                    cfr_deal(0, 1.0, 1.0, deal.probability, deal.h0, deal.h1, -1, 1.0);
                }
            }
            else
            {
                const double weight_iter = static_cast<double>(trained);
                freeze_sigma();
                for (const Deal& deal : deals)
                {
                    cfr_deal(0, 1.0, 1.0, deal.probability, deal.h0, deal.h1, 0, weight_iter);
                }
                floor_player(0);
                freeze_sigma();
                for (const Deal& deal : deals)
                {
                    cfr_deal(0, 1.0, 1.0, deal.probability, deal.h0, deal.h1, 1, weight_iter);
                }
                floor_player(1);
            }
        }
    }

    void ensure_average() const
    {
        if (average_ready)
        {
            return;
        }
        for (const Slot& slot : slots)
        {
            normalize_average(
                strategy_sum.data() + slot.base,
                average.data() + slot.base,
                slot.n_actions);
        }
        average_ready = true;
    }

    const double* sigma_of(const Node& node, int hand) const
    {
        return average.data() + node.hand_base + hand * node.n_actions;
    }

    void terminal_v0(const Node& node, const double* reach1, double* v0) const
    {
        for (int h0 = 0; h0 < n0; ++h0)
        {
            double sum = 0.0;
            for (int h1 = 0; h1 < n1; ++h1)
            {
                const double mass = weight[static_cast<std::size_t>(h0 * n1 + h1)] * reach1[h1];
                if (mass == 0.0)
                {
                    continue;
                }
                sum += mass * payoff(node, h0, h1);
            }
            v0[h0] = sum;
        }
    }

    void terminal_v1(const Node& node, const double* reach0, double* v1) const
    {
        for (int h1 = 0; h1 < n1; ++h1)
        {
            double sum = 0.0;
            for (int h0 = 0; h0 < n0; ++h0)
            {
                const double mass = weight[static_cast<std::size_t>(h0 * n1 + h1)] * reach0[h0];
                if (mass == 0.0)
                {
                    continue;
                }
                sum += mass * payoff(node, h0, h1);
            }
            v1[h1] = sum;
        }
    }

    void walk_v0(int node_index, const double* reach1, double* v0, int br_player) const
    {
        const Node& node = nodes[static_cast<std::size_t>(node_index)];
        if (node.terminal)
        {
            terminal_v0(node, reach1, v0);
            return;
        }
        if (node.player == 1)
        {
            std::vector<double> total(static_cast<std::size_t>(n0), 0.0);
            std::vector<double> next_reach(static_cast<std::size_t>(n1), 0.0);
            std::vector<double> child_value(static_cast<std::size_t>(n0), 0.0);
            for (int action = 0; action < node.n_actions; ++action)
            {
                for (int hand = 0; hand < n1; ++hand)
                {
                    next_reach[static_cast<std::size_t>(hand)] =
                        reach1[hand] * sigma_of(node, hand)[action];
                }
                walk_v0(node.child[action], next_reach.data(), child_value.data(), br_player);
                for (int hand = 0; hand < n0; ++hand)
                {
                    total[static_cast<std::size_t>(hand)] += child_value[static_cast<std::size_t>(hand)];
                }
            }
            for (int hand = 0; hand < n0; ++hand)
            {
                v0[hand] = total[static_cast<std::size_t>(hand)];
            }
            return;
        }

        std::vector<double> action_values(static_cast<std::size_t>(node.n_actions * n0), 0.0);
        for (int action = 0; action < node.n_actions; ++action)
        {
            walk_v0(node.child[action], reach1, action_values.data() + static_cast<std::size_t>(action * n0), br_player);
        }
        for (int hand = 0; hand < n0; ++hand)
        {
            if (br_player == 0)
            {
                int best = 0;
                double best_value = action_values[static_cast<std::size_t>(hand)];
                for (int action = 1; action < node.n_actions; ++action)
                {
                    const double value = action_values[static_cast<std::size_t>(action * n0 + hand)];
                    if (value > best_value)
                    {
                        best = action;
                        best_value = value;
                    }
                }
                v0[hand] = best_value;
            }
            else
            {
                const double* sigma = sigma_of(node, hand);
                double mixed = 0.0;
                for (int action = 0; action < node.n_actions; ++action)
                {
                    mixed += sigma[action] * action_values[static_cast<std::size_t>(action * n0 + hand)];
                }
                v0[hand] = mixed;
            }
        }
    }

    void walk_v1(int node_index, const double* reach0, double* v1, int br_player) const
    {
        const Node& node = nodes[static_cast<std::size_t>(node_index)];
        if (node.terminal)
        {
            terminal_v1(node, reach0, v1);
            return;
        }
        if (node.player == 0)
        {
            std::vector<double> total(static_cast<std::size_t>(n1), 0.0);
            std::vector<double> next_reach(static_cast<std::size_t>(n0), 0.0);
            std::vector<double> child_value(static_cast<std::size_t>(n1), 0.0);
            for (int action = 0; action < node.n_actions; ++action)
            {
                for (int hand = 0; hand < n0; ++hand)
                {
                    next_reach[static_cast<std::size_t>(hand)] =
                        reach0[hand] * sigma_of(node, hand)[action];
                }
                walk_v1(node.child[action], next_reach.data(), child_value.data(), br_player);
                for (int hand = 0; hand < n1; ++hand)
                {
                    total[static_cast<std::size_t>(hand)] += child_value[static_cast<std::size_t>(hand)];
                }
            }
            for (int hand = 0; hand < n1; ++hand)
            {
                v1[hand] = total[static_cast<std::size_t>(hand)];
            }
            return;
        }

        std::vector<double> action_values(static_cast<std::size_t>(node.n_actions * n1), 0.0);
        for (int action = 0; action < node.n_actions; ++action)
        {
            walk_v1(node.child[action], reach0, action_values.data() + static_cast<std::size_t>(action * n1), br_player);
        }
        for (int hand = 0; hand < n1; ++hand)
        {
            if (br_player == 1)
            {
                int best = 0;
                double best_value = action_values[static_cast<std::size_t>(hand)];
                for (int action = 1; action < node.n_actions; ++action)
                {
                    const double value = action_values[static_cast<std::size_t>(action * n1 + hand)];
                    if (value < best_value)
                    {
                        best = action;
                        best_value = value;
                    }
                }
                v1[hand] = best_value;
            }
            else
            {
                const double* sigma = sigma_of(node, hand);
                double mixed = 0.0;
                for (int action = 0; action < node.n_actions; ++action)
                {
                    mixed += sigma[action] * action_values[static_cast<std::size_t>(action * n1 + hand)];
                }
                v1[hand] = mixed;
            }
        }
    }

    double utility_of_average() const
    {
        ensure_average();
        std::vector<double> reach(static_cast<std::size_t>(n1), 1.0);
        std::vector<double> value(static_cast<std::size_t>(n0), 0.0);
        walk_v0(0, reach.data(), value.data(), -1);
        double sum = 0.0;
        for (double item : value)
        {
            sum += item;
        }
        return sum;
    }

    double utility_when_p0_responds() const
    {
        ensure_average();
        std::vector<double> reach(static_cast<std::size_t>(n1), 1.0);
        std::vector<double> value(static_cast<std::size_t>(n0), 0.0);
        walk_v0(0, reach.data(), value.data(), 0);
        double sum = 0.0;
        for (double item : value)
        {
            sum += item;
        }
        return sum;
    }

    double utility_when_p1_responds() const
    {
        ensure_average();
        std::vector<double> reach(static_cast<std::size_t>(n0), 1.0);
        std::vector<double> value(static_cast<std::size_t>(n1), 0.0);
        walk_v1(0, reach.data(), value.data(), 1);
        double sum = 0.0;
        for (double item : value)
        {
            sum += item;
        }
        return sum;
    }

    bool same_combos(const std::vector<int>& stored, const std::vector<int>& live) const
    {
        return stored == live;
    }

    TrainingTables export_tables() const
    {
        TrainingTables tables;
        tables.iterations = trained;
        tables.oop_combos = combos[0];
        tables.ip_combos = combos[1];
        tables.slot_actions.reserve(slots.size());
        for (const Slot& slot : slots)
        {
            tables.slot_actions.push_back(static_cast<std::uint16_t>(slot.n_actions));
        }
        tables.regret = regret;
        tables.strategy_sum = strategy_sum;
        return tables;
    }

    void install_tables(const TrainingTables& tables)
    {
        if (tables.iterations < 0
            || !same_combos(tables.oop_combos, combos[0])
            || !same_combos(tables.ip_combos, combos[1])
            || tables.slot_actions.size() != slots.size()
            || tables.regret.size() != regret.size()
            || tables.strategy_sum.size() != strategy_sum.size())
        {
            throw std::invalid_argument("training tables do not match this tree");
        }
        for (std::size_t index = 0; index < slots.size(); ++index)
        {
            if (tables.slot_actions[index] != static_cast<std::uint16_t>(slots[index].n_actions))
            {
                throw std::invalid_argument("training tables do not match this tree");
            }
        }
        regret = tables.regret;
        strategy_sum = tables.strategy_sum;
        trained = tables.iterations;
        average_ready = false;
    }
};

RiverBatchSolver::RiverBatchSolver(river::RiverConfig config)
    : engine_(std::make_unique<Engine>(std::move(config)))
{
}

RiverBatchSolver::~RiverBatchSolver() = default;

void RiverBatchSolver::run_iterations(int count, Algorithm algorithm)
{
    engine_->reset();
    engine_->train_more(count, algorithm);
}

void RiverBatchSolver::continue_iterations(int count, Algorithm algorithm)
{
    engine_->train_more(count, algorithm);
}

int RiverBatchSolver::completed_iterations() const
{
    return engine_->trained;
}

const river::RiverConfig& RiverBatchSolver::config() const
{
    return engine_->config;
}

TrainingTables RiverBatchSolver::training_tables() const
{
    return engine_->export_tables();
}

void RiverBatchSolver::install_training_tables(const TrainingTables& tables)
{
    engine_->install_tables(tables);
}

SolveStats RiverBatchSolver::solve(const SolveConfig& config, Algorithm algorithm)
{
    const auto start = std::chrono::steady_clock::now();
    engine_->reset();
    int completed = 0;
    SolveStats stats;
    stats.nash_gap_history.clear();
    stats.nash_gap_iterations.clear();
    bool fresh = false;
    for (int step = 0; step < config.max_iterations; ++step)
    {
        engine_->train_more(1, algorithm);
        ++completed;
        fresh = false;
        const bool check_gap = config.nash_gap_threshold >= 0.0
            && config.eval_every > 0
            && completed % config.eval_every == 0;
        if (check_gap)
        {
            stats.p1_expected_utility = expected_utility();
            stats.p1_best_response_utility = p1_best_response_utility();
            stats.p2_best_response_utility = p2_best_response_utility();
            stats.nash_gap = stats.p1_best_response_utility + stats.p2_best_response_utility;
            stats.nash_gap_history.push_back(stats.nash_gap);
            stats.nash_gap_iterations.push_back(completed);
            fresh = true;
            if (stats.nash_gap <= config.nash_gap_threshold)
            {
                break;
            }
        }
        if (config.max_wall_seconds >= 0.0)
        {
            const double elapsed = std::chrono::duration<double>(
                std::chrono::steady_clock::now() - start).count();
            if (elapsed >= config.max_wall_seconds)
            {
                stats.time_limit_reached = true;
                break;
            }
        }
    }
    const auto end = std::chrono::steady_clock::now();
    if (!fresh)
    {
        stats.p1_expected_utility = expected_utility();
        stats.p1_best_response_utility = p1_best_response_utility();
        stats.p2_best_response_utility = p2_best_response_utility();
        stats.nash_gap = stats.p1_best_response_utility + stats.p2_best_response_utility;
        if (config.nash_gap_threshold >= 0.0)
        {
            stats.nash_gap_history.push_back(stats.nash_gap);
            stats.nash_gap_iterations.push_back(completed);
        }
    }
    stats.iterations = completed;
    stats.runtime_seconds = std::chrono::duration<double>(end - start).count();
    stats.memory_bytes_estimate = memory_bytes_estimate();
    return stats;
}

double RiverBatchSolver::expected_utility() const
{
    return engine_->utility_of_average();
}

double RiverBatchSolver::p1_best_response_utility() const
{
    return engine_->utility_when_p0_responds();
}

double RiverBatchSolver::p2_best_response_utility() const
{
    return -engine_->utility_when_p1_responds();
}

double RiverBatchSolver::nash_gap() const
{
    return p1_best_response_utility() + p2_best_response_utility();
}

int RiverBatchSolver::infoset_count() const
{
    return static_cast<int>(engine_->slots.size());
}

int RiverBatchSolver::deal_count() const
{
    return static_cast<int>(engine_->deals.size());
}

int RiverBatchSolver::public_decisions() const
{
    return engine_->public_decisions;
}

int RiverBatchSolver::public_terminals() const
{
    return engine_->public_terminals;
}

int RiverBatchSolver::regret_entries() const
{
    return static_cast<int>(engine_->regret.size());
}

std::size_t RiverBatchSolver::memory_bytes_estimate() const
{
    return engine_->regret.size() * sizeof(double)
        + engine_->strategy_sum.size() * sizeof(double);
}

std::vector<RiverStrategyEntry> RiverBatchSolver::average_strategy_entries() const
{
    engine_->ensure_average();
    std::vector<RiverStrategyEntry> entries;
    entries.reserve(engine_->slots.size() * 2);
    for (const Engine::Slot& slot : engine_->slots)
    {
        const Engine::Node& node = engine_->nodes[static_cast<std::size_t>(slot.node)];
        for (int action = 0; action < slot.n_actions; ++action)
        {
            RiverStrategyEntry entry;
            entry.infoset = slot.label;
            entry.action = node.action_labels[action];
            entry.probability = engine_->average[static_cast<std::size_t>(slot.base + action)];
            entries.push_back(std::move(entry));
        }
    }
    return entries;
}

} // namespace poker::solver
