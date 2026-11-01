#include "solver/river_batch.hpp"

#include "poker/card.hpp"
#include "poker/hand_eval.hpp"
#include "poker/range.hpp"
#include "solver/chip_payoff.hpp"
#include "solver/icm.hpp"
#include "solver/incentives.hpp"
#include "solver/regret_matching.hpp"
#include "solver/strategy_edit.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <limits>
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
        int parent = -1;
        int parent_action = -1;
        int hand_base = 0;
        // Path-attributed incentive deltas per seat (0 when incentives empty).
        double incentive_u0 = 0.0;
        double incentive_u1 = 0.0;
        std::string path;
        std::string action_labels[8];
    };

    struct Slot
    {
        std::string label;
        int node = 0;
        int hand = 0;
        int base = 0;
        int n_actions = 0;
    };

    river::RiverConfig config;
    std::vector<int> combos[2];
    std::vector<int> hole_a[2];
    std::vector<int> hole_b[2];
    std::vector<double> range_w[2];
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
    double joint_scale = 1.0;
    int n0 = 0;
    int n1 = 0;
    int public_decisions = 0;
    int public_terminals = 0;
    // Non-owning; set for the duration of solve()/run_*/continue_* from SolveConfig::locks.
    const LockSet* locks_ = nullptr;

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
        config.rake.validate();
        config.icm.validate(config.pot, config.stack);
        config.incentives.validate();

        BetState root;
        root.pot = config.pot;
        root.acting = config.first_to_act;
        build_node(root, "");
        fill_terminal_incentives();
        build_deals();
        assign_bases();
    }

    void fill_terminal_incentives()
    {
        if (!config.incentives.enabled())
        {
            return;
        }
        std::vector<IncentiveEdge> rev;
        std::vector<IncentiveEdge> path;
        for (int index = 0; index < static_cast<int>(nodes.size()); ++index)
        {
            Node& node = nodes[static_cast<std::size_t>(index)];
            if (!node.terminal)
            {
                continue;
            }
            rev.clear();
            for (int at = index; nodes[static_cast<std::size_t>(at)].parent >= 0;)
            {
                const Node& child = nodes[static_cast<std::size_t>(at)];
                const Node& parent = nodes[static_cast<std::size_t>(child.parent)];
                const int action = child.parent_action;
                if (action < 0 || action >= parent.n_actions)
                {
                    throw std::logic_error("river incentive parent action out of range");
                }
                IncentiveEdge edge;
                edge.player = parent.player;
                edge.display_label = parent.action_labels[static_cast<std::size_t>(action)];
                edge.compact_label = incentive_compact_from_display(edge.display_label);
                if (edge.compact_label.empty())
                {
                    edge.compact_label = edge.display_label;
                }
                attach_edge_tags(edge, config.incentives);
                rev.push_back(std::move(edge));
                at = child.parent;
            }
            path.assign(rev.rbegin(), rev.rend());
            PlayerPayoff zero;
            zero.utility[0] = 0.0;
            zero.utility[1] = 0.0;
            const PlayerPayoff path_delta =
                apply_path_incentives(config.incentives, zero, path);
            node.incentive_u0 = path_delta.utility[0];
            node.incentive_u1 = path_delta.utility[1];
        }
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
            nodes[static_cast<std::size_t>(child)].parent = id;
            nodes[static_cast<std::size_t>(child)].parent_action = action;
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
        const double joint_mass = holdem::joint_mass(
            config.oop, config.ip, config.board.data(), 5);
        if (!(joint_mass > 0.0))
        {
            throw std::invalid_argument("ranges leave no legal river hand pair");
        }
        joint_scale = 1.0 / joint_mass;
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
        const holdem::Range* ranges[2] = {&config.oop, &config.ip};
        for (int player = 0; player < 2; ++player)
        {
            const int hands = player == 0 ? n0 : n1;
            hole_a[player].assign(static_cast<std::size_t>(hands), 0);
            hole_b[player].assign(static_cast<std::size_t>(hands), 0);
            range_w[player].assign(static_cast<std::size_t>(hands), 0.0);
            for (int hand = 0; hand < hands; ++hand)
            {
                const int combo = combos[player][static_cast<std::size_t>(hand)];
                int c0 = 0;
                int c1 = 0;
                holdem::Range::combo_cards(combo, c0, c1);
                hole_a[player][static_cast<std::size_t>(hand)] = c0;
                hole_b[player][static_cast<std::size_t>(hand)] = c1;
                range_w[player][static_cast<std::size_t>(hand)] = ranges[player]->weight(combo);
            }
        }
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
                slot.hand = hand;
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

    PlayerPayoff terminal_modeled(const Node& node, int h0, int h1) const
    {
        const int outcome = node.folded < 0
            ? showdown[static_cast<std::size_t>(h0 * n1 + h1)]
            : 0;
        const PlayerPayoff chips = ChipPayoff::terminal(
            config.pot,
            node.contrib[0],
            node.contrib[1],
            node.folded,
            outcome,
            config.rake);
        PlayerPayoff paid = apply_icm_terminal(config.icm, chips);
        paid.utility[0] += node.incentive_u0;
        paid.utility[1] += node.incentive_u1;
        return paid;
    }

    double payoff(const Node& node, int h0, int h1) const
    {
        return terminal_modeled(node, h0, h1).utility[0];
    }

    PlayerPayoff cfr_deal_payoff(int node_index, double pi0, double pi1, double chance, int h0, int h1,
                                int updating, double weight_iter)
    {
        const Node& node = nodes[static_cast<std::size_t>(node_index)];
        if (node.terminal)
        {
            return terminal_modeled(node, h0, h1);
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
        PlayerPayoff action_utility[8];
        PlayerPayoff node_utility;
        for (int action = 0; action < node.n_actions; ++action)
        {
            if (node.player == 0)
            {
                action_utility[action] = cfr_deal_payoff(
                    node.child[action], pi0 * sigma[action], pi1, chance, h0, h1, updating, weight_iter);
            }
            else
            {
                action_utility[action] = cfr_deal_payoff(
                    node.child[action], pi0, pi1 * sigma[action], chance, h0, h1, updating, weight_iter);
            }
            node_utility.utility[0] += sigma[action] * action_utility[action].utility[0];
            node_utility.utility[1] += sigma[action] * action_utility[action].utility[1];
        }
        if (update)
        {
            const double opponent_reach = (node.player == 0 ? pi1 : pi0) * chance;
            for (int action = 0; action < node.n_actions; ++action)
            {
                const double instant = action_utility[action].utility[node.player]
                    - node_utility.utility[node.player];
                regret[static_cast<std::size_t>(base + action)] += opponent_reach * instant;
            }
        }
        return node_utility;
    }

    double cfr_deal(int node_index, double pi0, double pi1, double chance, int h0, int h1,
                    int updating, double weight_iter)
    {
        return cfr_deal_payoff(
            node_index, pi0, pi1, chance, h0, h1, updating, weight_iter).utility[0];
    }

    // When locks_ is set, locked rows replace RM for matching public nodes.
    void freeze_sigma()
    {
        for (const Slot& slot : slots)
        {
            regret_matching(
                regret.data() + slot.base,
                pass_sigma.data() + slot.base,
                slot.n_actions);
            if (locks_ != nullptr)
            {
                const NodeLock* lock = locks_->find(static_cast<std::size_t>(slot.node));
                apply_lock_to_strategy(
                    std::span<double>(
                        pass_sigma.data() + slot.base,
                        static_cast<std::size_t>(slot.n_actions)),
                    lock,
                    static_cast<std::size_t>(slot.hand));
            }
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
        if (algorithm == Algorithm::Dcfr)
        {
            throw std::invalid_argument(
                "DCFR is not supported on the legacy river public tree; use street_solver --frozen");
        }
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
                sum += mass * terminal_modeled(node, h0, h1).utility[0];
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
                sum += mass * terminal_modeled(node, h0, h1).utility[1];
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
                    if (value > best_value)
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

    void throw_if_cancelled(const std::atomic<bool>* cancel) const
    {
        if (cancel != nullptr && cancel->load(std::memory_order_relaxed))
        {
            throw StreetValueCancelled();
        }
    }

    std::string root_node_id() const
    {
        return "p0.t-1.r-1";
    }

    std::string node_id(int node) const
    {
        return "p" + std::to_string(node) + ".t-1.r-1";
    }

    std::string canonical_node_id(const std::string& text) const
    {
        return node_id(locate_node(text));
    }

    bool parse_node_id(const std::string& text, int& node) const
    {
        auto read_number = [&](std::size_t& cursor, int& value) -> bool
        {
            if (cursor >= text.size() || text[cursor] == '+')
            {
                return false;
            }
            long long parsed = 0;
            const char* first = text.data() + cursor;
            const char* last = text.data() + text.size();
            const std::from_chars_result result = std::from_chars(first, last, parsed);
            if (result.ec != std::errc() || result.ptr == first)
            {
                return false;
            }
            if (parsed < std::numeric_limits<int>::min() || parsed > std::numeric_limits<int>::max())
            {
                return false;
            }
            cursor = static_cast<std::size_t>(result.ptr - text.data());
            value = static_cast<int>(parsed);
            return true;
        };
        std::size_t cursor = 0;
        if (text.empty() || text[cursor] != 'p')
        {
            return false;
        }
        ++cursor;
        int turn = 0;
        int river = 0;
        if (!read_number(cursor, node) || cursor >= text.size() || text[cursor] != '.')
        {
            return false;
        }
        ++cursor;
        if (cursor >= text.size() || text[cursor] != 't')
        {
            return false;
        }
        ++cursor;
        if (!read_number(cursor, turn) || cursor >= text.size() || text[cursor] != '.')
        {
            return false;
        }
        ++cursor;
        if (cursor >= text.size() || text[cursor] != 'r')
        {
            return false;
        }
        ++cursor;
        return read_number(cursor, river) && cursor == text.size() && turn == -1 && river == -1;
    }

    int locate_node(const std::string& text) const
    {
        int node = 0;
        if (!parse_node_id(text, node)
            || node < 0
            || static_cast<std::size_t>(node) >= nodes.size())
        {
            throw std::invalid_argument("unknown node");
        }
        return node;
    }

    bool shares_hole(int hero, int hero_hand, int opponent, int opponent_hand) const
    {
        const int c0 = hole_a[hero][static_cast<std::size_t>(hero_hand)];
        const int c1 = hole_b[hero][static_cast<std::size_t>(hero_hand)];
        const int o0 = hole_a[opponent][static_cast<std::size_t>(opponent_hand)];
        const int o1 = hole_b[opponent][static_cast<std::size_t>(opponent_hand)];
        return o0 == c0 || o0 == c1 || o1 == c0 || o1 == c1;
    }

    bool difference_is_stable(double total, double removed, double difference) const
    {
        if (!std::isfinite(total) || !std::isfinite(removed) || !std::isfinite(difference))
        {
            return false;
        }
        if (difference < 0.0)
        {
            return false;
        }
        if (difference == 0.0)
        {
            return total == 0.0 && removed == 0.0;
        }
        const double scale = std::max(total, std::abs(removed));
        return difference > scale * 1e-3;
    }

    double direct_compatible_mass(int hero, int hand, int opponent, std::span<const double> opp_amount) const
    {
        double sum = 0.0;
        for (int other = 0; other < static_cast<int>(opp_amount.size()); ++other)
        {
            const double piece = opp_amount[static_cast<std::size_t>(other)];
            if (!(piece > 0.0) || shares_hole(hero, hand, opponent, other))
            {
                continue;
            }
            sum += piece;
        }
        return sum;
    }

    double blocked_reach(int hero, int hand, const double* by_card, std::span<const double> opp_amount) const
    {
        const int c0 = hole_a[hero][static_cast<std::size_t>(hand)];
        const int c1 = hole_b[hero][static_cast<std::size_t>(hand)];
        double blocked = by_card[c0] + by_card[c1];
        const int opp = 1 - hero;
        for (int other = 0; other < static_cast<int>(opp_amount.size()); ++other)
        {
            if (hole_a[opp][static_cast<std::size_t>(other)] == c0
                && hole_b[opp][static_cast<std::size_t>(other)] == c1)
            {
                blocked -= opp_amount[static_cast<std::size_t>(other)];
                break;
            }
            if (hole_a[opp][static_cast<std::size_t>(other)] == c1
                && hole_b[opp][static_cast<std::size_t>(other)] == c0)
            {
                blocked -= opp_amount[static_cast<std::size_t>(other)];
                break;
            }
        }
        return blocked;
    }

    double stable_compatible_mass(
        int hero,
        int hand,
        int opponent,
        double total,
        const double* by_card,
        std::span<const double> opp_amount) const
    {
        const double blocked = blocked_reach(hero, hand, by_card, opp_amount);
        const double open = total - blocked;
        if (difference_is_stable(total, blocked, open))
        {
            return open;
        }
        return direct_compatible_mass(hero, hand, opponent, opp_amount);
    }

    double joint_mass_of(const std::vector<double>& left, const std::vector<double>& right) const
    {
        double total = 0.0;
        double by_card[52] = {};
        for (int hand = 0; hand < static_cast<int>(right.size()); ++hand)
        {
            const double piece = right[static_cast<std::size_t>(hand)];
            if (piece == 0.0)
            {
                continue;
            }
            total += piece;
            by_card[hole_a[1][static_cast<std::size_t>(hand)]] += piece;
            by_card[hole_b[1][static_cast<std::size_t>(hand)]] += piece;
        }
        double joint = 0.0;
        for (int hand = 0; hand < static_cast<int>(left.size()); ++hand)
        {
            const double piece = left[static_cast<std::size_t>(hand)];
            if (piece == 0.0)
            {
                continue;
            }
            const double open = stable_compatible_mass(0, hand, 1, total, by_card, right);
            joint += piece * open;
        }
        return joint;
    }

    void marginals_of(
        const std::vector<double>& reach,
        int player,
        const std::vector<double>& opponent,
        int opponent_player,
        double& joint,
        std::vector<double>& marginal) const
    {
        double total = 0.0;
        double by_card[52] = {};
        for (int hand = 0; hand < static_cast<int>(opponent.size()); ++hand)
        {
            const double piece = opponent[static_cast<std::size_t>(hand)];
            if (piece == 0.0)
            {
                continue;
            }
            total += piece;
            by_card[hole_a[opponent_player][static_cast<std::size_t>(hand)]] += piece;
            by_card[hole_b[opponent_player][static_cast<std::size_t>(hand)]] += piece;
        }
        joint = 0.0;
        marginal.assign(reach.size(), 0.0);
        for (int hand = 0; hand < static_cast<int>(reach.size()); ++hand)
        {
            const double piece = reach[static_cast<std::size_t>(hand)];
            if (piece == 0.0)
            {
                continue;
            }
            const double open = stable_compatible_mass(
                player, hand, opponent_player, total, by_card, opponent);
            const double mass = piece * open;
            marginal[static_cast<std::size_t>(hand)] = mass;
            joint += mass;
        }
        if (joint > 0.0)
        {
            for (double& value : marginal)
            {
                value /= joint;
            }
        }
    }

    void replay_weights(int node_index, std::vector<double>& q0, std::vector<double>& q1) const
    {
        q0 = range_w[0];
        q1 = range_w[1];
        std::vector<int> chain;
        for (int at = node_index; at >= 0; at = nodes[static_cast<std::size_t>(at)].parent)
        {
            chain.push_back(at);
            if (chain.size() > nodes.size())
            {
                throw std::logic_error("node parent cycle");
            }
        }
        std::reverse(chain.begin(), chain.end());
        if (chain.empty() || chain.front() != 0)
        {
            throw std::invalid_argument("unknown node");
        }
        for (std::size_t step = 0; step + 1 < chain.size(); ++step)
        {
            const int current = chain[step];
            const int next = chain[step + 1];
            const Node& node = nodes[static_cast<std::size_t>(current)];
            if (nodes[static_cast<std::size_t>(next)].parent != current)
            {
                throw std::logic_error("node parent chain broke");
            }
            const int action = nodes[static_cast<std::size_t>(next)].parent_action;
            std::vector<double>& acting = node.player == 0 ? q0 : q1;
            const int hands = node.player == 0 ? n0 : n1;
            for (int hand = 0; hand < hands; ++hand)
            {
                if (!(acting[static_cast<std::size_t>(hand)] > 0.0))
                {
                    continue;
                }
                acting[static_cast<std::size_t>(hand)] *= sigma_of(node, hand)[action];
            }
        }
    }

    void average_value_walk(
        int node_index,
        std::vector<double>& pi0,
        std::vector<double>& pi1,
        std::vector<double>& ev0,
        std::vector<double>& ev1,
        std::vector<double>& aev0,
        std::vector<double>& aev1,
        bool force,
        const std::atomic<bool>* cancel) const
    {
        throw_if_cancelled(cancel);
        const Node& node = nodes[static_cast<std::size_t>(node_index)];
        if (node.terminal)
        {
            terminal_v0(node, pi1.data(), ev0.data());
            terminal_v1(node, pi0.data(), ev1.data());
            return;
        }

        std::vector<double> child_pi0(static_cast<std::size_t>(n0), 0.0);
        std::vector<double> child_pi1(static_cast<std::size_t>(n1), 0.0);
        std::vector<double> child_ev0(static_cast<std::size_t>(n0), 0.0);
        std::vector<double> child_ev1(static_cast<std::size_t>(n1), 0.0);
        aev0.assign(static_cast<std::size_t>(node.n_actions * n0), 0.0);
        aev1.assign(static_cast<std::size_t>(node.n_actions * n1), 0.0);
        for (int action = 0; action < node.n_actions; ++action)
        {
            if (node.player == 0)
            {
                for (int h0 = 0; h0 < n0; ++h0)
                {
                    if (force)
                    {
                        child_pi0[static_cast<std::size_t>(h0)] = pi0[static_cast<std::size_t>(h0)];
                    }
                    else
                    {
                        child_pi0[static_cast<std::size_t>(h0)] =
                            pi0[static_cast<std::size_t>(h0)] * sigma_of(node, h0)[action];
                    }
                }
                child_pi1 = pi1;
            }
            else
            {
                child_pi0 = pi0;
                for (int h1 = 0; h1 < n1; ++h1)
                {
                    if (force)
                    {
                        child_pi1[static_cast<std::size_t>(h1)] = pi1[static_cast<std::size_t>(h1)];
                    }
                    else
                    {
                        child_pi1[static_cast<std::size_t>(h1)] =
                            pi1[static_cast<std::size_t>(h1)] * sigma_of(node, h1)[action];
                    }
                }
            }
            std::vector<double> unused_aev0;
            std::vector<double> unused_aev1;
            average_value_walk(
                node.child[action],
                child_pi0,
                child_pi1,
                child_ev0,
                child_ev1,
                unused_aev0,
                unused_aev1,
                false,
                cancel);
            for (int h0 = 0; h0 < n0; ++h0)
            {
                aev0[static_cast<std::size_t>(action * n0 + h0)] = child_ev0[static_cast<std::size_t>(h0)];
            }
            for (int h1 = 0; h1 < n1; ++h1)
            {
                aev1[static_cast<std::size_t>(action * n1 + h1)] = child_ev1[static_cast<std::size_t>(h1)];
            }
        }
        if (force)
        {
            return;
        }
        for (int h0 = 0; h0 < n0; ++h0)
        {
            if (node.player == 0)
            {
                double mix = 0.0;
                for (int action = 0; action < node.n_actions; ++action)
                {
                    mix += sigma_of(node, h0)[action]
                        * aev0[static_cast<std::size_t>(action * n0 + h0)];
                }
                ev0[static_cast<std::size_t>(h0)] = mix;
            }
            else
            {
                double mix = 0.0;
                for (int action = 0; action < node.n_actions; ++action)
                {
                    mix += aev0[static_cast<std::size_t>(action * n0 + h0)];
                }
                ev0[static_cast<std::size_t>(h0)] = mix;
            }
        }
        for (int h1 = 0; h1 < n1; ++h1)
        {
            if (node.player == 1)
            {
                double mix = 0.0;
                for (int action = 0; action < node.n_actions; ++action)
                {
                    mix += sigma_of(node, h1)[action]
                        * aev1[static_cast<std::size_t>(action * n1 + h1)];
                }
                ev1[static_cast<std::size_t>(h1)] = mix;
            }
            else
            {
                double mix = 0.0;
                for (int action = 0; action < node.n_actions; ++action)
                {
                    mix += aev1[static_cast<std::size_t>(action * n1 + h1)];
                }
                ev1[static_cast<std::size_t>(h1)] = mix;
            }
        }
    }

    StreetInspection inspect_node(const std::string& text) const
    {
        ensure_average();
        const int node_index = locate_node(text);
        std::vector<double> q0;
        std::vector<double> q1;
        replay_weights(node_index, q0, q1);
        const Node& node = nodes[static_cast<std::size_t>(node_index)];
        StreetInspection view;
        view.node_id = text;
        view.line = node.path.empty() ? "open" : node.path;
        for (int card : config.board)
        {
            view.board.push_back(holdem::format_card(card));
        }
        view.place = "river";
        double hand_joint = 0.0;
        std::vector<double> marginal0;
        std::vector<double> marginal1;
        marginals_of(q0, 0, q1, 1, hand_joint, marginal0);
        marginals_of(q1, 1, q0, 0, hand_joint, marginal1);
        view.joint = hand_joint;
        view.reach_defined = hand_joint > 0.0;
        if (node.terminal)
        {
            view.kind = "terminal";
            view.folded = node.folded;
            return view;
        }
        view.kind = "decision";
        view.player = node.player;
        view.actions.resize(static_cast<std::size_t>(node.n_actions));
        for (int action = 0; action < node.n_actions; ++action)
        {
            view.actions[static_cast<std::size_t>(action)].label = node.action_labels[action];
            view.actions[static_cast<std::size_t>(action)].child_id = node_id(node.child[action]);
        }
        const int actor = node.player;
        const int hands = actor == 0 ? n0 : n1;
        const std::vector<double>& hero_q = actor == 0 ? q0 : q1;
        const std::vector<double>& hero_marginal = actor == 0 ? marginal0 : marginal1;
        view.hands.reserve(static_cast<std::size_t>(hands));
        for (int hand = 0; hand < hands; ++hand)
        {
            StreetInspectHand row;
            row.combo = holdem::Range::combo_text(combos[actor][static_cast<std::size_t>(hand)]);
            row.structural = range_w[actor][static_cast<std::size_t>(hand)] > 0.0;
            row.marginal = hero_marginal[static_cast<std::size_t>(hand)];
            row.reach = hero_q[static_cast<std::size_t>(hand)];
            row.strategy.resize(static_cast<std::size_t>(node.n_actions), 0.0);
            if (row.structural)
            {
                const double* sigma = sigma_of(node, hand);
                for (int action = 0; action < node.n_actions; ++action)
                {
                    row.strategy[static_cast<std::size_t>(action)] = sigma[action];
                }
            }
            view.hands.push_back(std::move(row));
        }
        return view;
    }

    StreetActionValues compute_action_values(
        const std::string& text,
        const std::atomic<bool>* cancel) const
    {
        const auto started = std::chrono::steady_clock::now();
        ensure_average();
        const int node_index = locate_node(text);
        const Node& node = nodes[static_cast<std::size_t>(node_index)];
        if (node.terminal)
        {
            throw std::invalid_argument("action values require a decision node");
        }
        std::vector<double> q0;
        std::vector<double> q1;
        replay_weights(node_index, q0, q1);
        const int actor = node.player;
        const int opponent = 1 - actor;
        const int hero_hands = actor == 0 ? n0 : n1;
        const int opp_hands = opponent == 0 ? n0 : n1;
        std::vector<double> strategic[2] = {
            std::vector<double>(static_cast<std::size_t>(n0), 0.0),
            std::vector<double>(static_cast<std::size_t>(n1), 0.0)};
        const std::vector<double>* weight_q[2] = {&q0, &q1};
        for (int player = 0; player < 2; ++player)
        {
            for (int hand = 0; hand < static_cast<int>(strategic[player].size()); ++hand)
            {
                const double prior = range_w[player][static_cast<std::size_t>(hand)];
                if (prior > 0.0)
                {
                    strategic[player][static_cast<std::size_t>(hand)] =
                        (*weight_q[player])[static_cast<std::size_t>(hand)] / prior;
                }
            }
        }
        StreetActionValues page;
        page.node_id = text;
        page.player = actor;
        page.reach_defined = joint_mass_of(q0, q1) > 0.0;
        page.actions.resize(static_cast<std::size_t>(node.n_actions));
        for (int action = 0; action < node.n_actions; ++action)
        {
            page.actions[static_cast<std::size_t>(action)] = node.action_labels[action];
        }
        page.combos.resize(static_cast<std::size_t>(hero_hands));
        for (int hand = 0; hand < hero_hands; ++hand)
        {
            page.combos[static_cast<std::size_t>(hand)] =
                holdem::Range::combo_text(combos[actor][static_cast<std::size_t>(hand)]);
        }
        page.ev_defined.assign(static_cast<std::size_t>(hero_hands), 0);
        page.action_ev.assign(static_cast<std::size_t>(hero_hands * node.n_actions), 0.0);
        page.mixed_ev.assign(static_cast<std::size_t>(hero_hands), 0.0);

        double peak = 0.0;
        for (int hand = 0; hand < opp_hands; ++hand)
        {
            peak = std::max(
                peak,
                range_w[opponent][static_cast<std::size_t>(hand)]
                    * strategic[opponent][static_cast<std::size_t>(hand)]);
        }
        if (!(peak > 0.0))
        {
            page.query_seconds = std::chrono::duration<double>(
                std::chrono::steady_clock::now() - started).count();
            return page;
        }
        const double reach_scale = 1.0 / peak;
        for (double& value : strategic[opponent])
        {
            value *= reach_scale;
        }

        std::vector<double> pi0(static_cast<std::size_t>(n0), 0.0);
        std::vector<double> pi1(static_cast<std::size_t>(n1), 0.0);
        if (actor == 0)
        {
            for (int hand = 0; hand < n0; ++hand)
            {
                pi0[static_cast<std::size_t>(hand)] =
                    range_w[0][static_cast<std::size_t>(hand)] > 0.0 ? 1.0 : 0.0;
            }
            pi1 = strategic[1];
        }
        else
        {
            pi0 = strategic[0];
            for (int hand = 0; hand < n1; ++hand)
            {
                pi1[static_cast<std::size_t>(hand)] =
                    range_w[1][static_cast<std::size_t>(hand)] > 0.0 ? 1.0 : 0.0;
            }
        }
        std::vector<double> ev0(static_cast<std::size_t>(n0), 0.0);
        std::vector<double> ev1(static_cast<std::size_t>(n1), 0.0);
        std::vector<double> aev0;
        std::vector<double> aev1;
        average_value_walk(node_index, pi0, pi1, ev0, ev1, aev0, aev1, true, cancel);

        std::vector<double> amount(static_cast<std::size_t>(opp_hands), 0.0);
        double total = 0.0;
        double by_card[52] = {};
        for (int hand = 0; hand < opp_hands; ++hand)
        {
            const double piece = range_w[opponent][static_cast<std::size_t>(hand)]
                * strategic[opponent][static_cast<std::size_t>(hand)];
            if (piece == 0.0)
            {
                continue;
            }
            amount[static_cast<std::size_t>(hand)] = piece;
            total += piece;
            by_card[hole_a[opponent][static_cast<std::size_t>(hand)]] += piece;
            by_card[hole_b[opponent][static_cast<std::size_t>(hand)]] += piece;
        }
        const std::vector<double>& raw = actor == 0 ? aev0 : aev1;
        const int raw_stride = actor == 0 ? n0 : n1;
        std::vector<double> marginal;
        double hand_joint = 0.0;
        const std::vector<double>& hero_weight = actor == 0 ? q0 : q1;
        const std::vector<double>& opp_weight = actor == 0 ? q1 : q0;
        marginals_of(hero_weight, actor, opp_weight, opponent, hand_joint, marginal);
        double node_ev = 0.0;
        bool node_ok = page.reach_defined;
        for (int hand = 0; hand < hero_hands; ++hand)
        {
            const double open = stable_compatible_mass(
                actor, hand, opponent, total, by_card, amount);
            const double prior = range_w[actor][static_cast<std::size_t>(hand)];
            if (!(open > 0.0) || !(prior > 0.0))
            {
                if (page.reach_defined && marginal[static_cast<std::size_t>(hand)] > 0.0)
                {
                    node_ok = false;
                }
                continue;
            }
            double mixed = 0.0;
            for (int action = 0; action < node.n_actions; ++action)
            {
                // aev0 / aev1 hold each seat's own modeled utility (dual-utility).
                const double stored_raw = raw[static_cast<std::size_t>(action * raw_stride + hand)];
                const double denom = prior * joint_scale * open;
                const double conditional = stored_raw / denom;
                page.action_ev[static_cast<std::size_t>(hand * node.n_actions + action)] = conditional;
                const double played = average[static_cast<std::size_t>(
                    node.hand_base + hand * node.n_actions + action)];
                mixed += played * conditional;
            }
            page.ev_defined[static_cast<std::size_t>(hand)] = 1;
            page.mixed_ev[static_cast<std::size_t>(hand)] = mixed;
            if (page.reach_defined)
            {
                node_ev += marginal[static_cast<std::size_t>(hand)] * mixed;
            }
        }
        page.node_ev_defined = node_ok;
        if (node_ok)
        {
            page.node_ev = node_ev;
        }
        {
            PlayerPayoff fold_pay = apply_icm_terminal(
                config.icm,
                ChipPayoff::terminal(
                    config.pot,
                    node.contrib[0],
                    node.contrib[1],
                    actor,
                    0,
                    config.rake));
            page.local_offset = -fold_pay.utility[static_cast<std::size_t>(actor)];
        }
        page.query_seconds = std::chrono::duration<double>(
            std::chrono::steady_clock::now() - started).count();
        return page;
    }

    void set_average_strategy(const std::string& text, int hand, std::span<const double> probability)
    {
        ensure_average();
        const int node_index = locate_node(text);
        const Node& node = nodes[static_cast<std::size_t>(node_index)];
        if (node.terminal)
        {
            throw std::invalid_argument("average edits require a decision node");
        }
        const int hands = node.player == 0 ? n0 : n1;
        if (hand < 0 || hand >= hands)
        {
            throw std::invalid_argument("hand is out of range");
        }
        if (!validate_strategy_probs(probability, node.n_actions))
        {
            throw std::invalid_argument("invalid strategy probability row");
        }
        const int base = node.hand_base + hand * node.n_actions;
        for (int action = 0; action < node.n_actions; ++action)
        {
            average[static_cast<std::size_t>(base + action)] =
                probability[static_cast<std::size_t>(action)];
        }
        average_ready = true;
    }

    void invalidate_prepared_average()
    {
        average_ready = false;
    }

    // Legacy test helper: also rewrites strategy_sum so the edit survives rebuild.
    void set_average_for_test(const std::string& text, int hand, std::span<const double> probability)
    {
        ensure_average();
        const int node_index = locate_node(text);
        const Node& node = nodes[static_cast<std::size_t>(node_index)];
        if (node.terminal)
        {
            throw std::invalid_argument("average edits require a decision node");
        }
        const int hands = node.player == 0 ? n0 : n1;
        if (hand < 0 || hand >= hands)
        {
            throw std::invalid_argument("hand is out of range");
        }
        if (static_cast<int>(probability.size()) != node.n_actions)
        {
            throw std::invalid_argument("average edit needs one probability per action");
        }
        double sum = 0.0;
        for (double value : probability)
        {
            if (!(value >= 0.0) || !std::isfinite(value))
            {
                throw std::invalid_argument("average probabilities must be nonnegative");
            }
            sum += value;
        }
        if (!(sum > 0.0))
        {
            throw std::invalid_argument("average probabilities must sum to a positive mass");
        }
        const int base = node.hand_base + hand * node.n_actions;
        for (int action = 0; action < node.n_actions; ++action)
        {
            average[static_cast<std::size_t>(base + action)] =
                probability[static_cast<std::size_t>(action)] / sum;
            strategy_sum[static_cast<std::size_t>(base + action)] =
                average[static_cast<std::size_t>(base + action)];
        }
        average_ready = true;
    }
};

RiverBatchSolver::RiverBatchSolver(river::RiverConfig config)
    : engine_(std::make_unique<Engine>(std::move(config)))
{
}

RiverBatchSolver::~RiverBatchSolver() = default;

void RiverBatchSolver::note_profile_mutation()
{
    ++profile_epoch_;
    value_cache_valid_ = false;
    value_cache_node_.clear();
    value_cache_ = StreetActionValues{};
}

void RiverBatchSolver::run_iterations(int count, Algorithm algorithm, const LockSet* locks)
{
    const LockSet* const previous_locks = engine_->locks_;
    engine_->locks_ = locks;
    try
    {
        engine_->reset();
        engine_->train_more(count, algorithm);
    }
    catch (...)
    {
        engine_->locks_ = previous_locks;
        throw;
    }
    engine_->locks_ = previous_locks;
    note_profile_mutation();
}

void RiverBatchSolver::continue_iterations(int count, Algorithm algorithm, const LockSet* locks)
{
    const LockSet* const previous_locks = engine_->locks_;
    engine_->locks_ = locks;
    try
    {
        engine_->train_more(count, algorithm);
    }
    catch (...)
    {
        engine_->locks_ = previous_locks;
        throw;
    }
    engine_->locks_ = previous_locks;
    note_profile_mutation();
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
    note_profile_mutation();
}

void RiverBatchSolver::prepare_inspection() const
{
    engine_->ensure_average();
}

std::string RiverBatchSolver::root_node_id() const
{
    return engine_->root_node_id();
}

StreetInspection RiverBatchSolver::inspect_node(const std::string& node_id) const
{
    return engine_->inspect_node(node_id);
}

StreetActionValues RiverBatchSolver::action_values(
    const std::string& node_id,
    const std::atomic<bool>* cancel) const
{
    const std::string canonical = engine_->canonical_node_id(node_id);
    {
        std::lock_guard<std::mutex> lock(value_mu_);
        if (value_cache_valid_
            && value_cache_epoch_ == profile_epoch_
            && value_cache_node_ == canonical)
        {
            StreetActionValues hit = value_cache_;
            hit.query_seconds = 0.0;
            return hit;
        }
    }
    StreetActionValues page = engine_->compute_action_values(canonical, cancel);
    page.profile_epoch = profile_epoch_;
    page.node_id = canonical;
    {
        std::lock_guard<std::mutex> lock(value_mu_);
        value_cache_ = page;
        value_cache_node_ = canonical;
        value_cache_epoch_ = profile_epoch_;
        value_cache_valid_ = true;
    }
    return page;
}

std::uint64_t RiverBatchSolver::profile_epoch() const
{
    return profile_epoch_;
}

void RiverBatchSolver::set_average_strategy(
    const std::string& node_id,
    int hand,
    std::span<const double> probability)
{
    engine_->set_average_strategy(node_id, hand, probability);
    note_profile_mutation();
}

void RiverBatchSolver::invalidate_prepared_average()
{
    engine_->invalidate_prepared_average();
    note_profile_mutation();
}

void RiverBatchSolver::set_average_for_test(
    const std::string& node_id,
    int hand,
    std::span<const double> probability)
{
    engine_->set_average_for_test(node_id, hand, probability);
    note_profile_mutation();
}

std::span<const double> RiverBatchSolver::regret_table() const
{
    return engine_->regret;
}

std::span<const double> RiverBatchSolver::strategy_sum_table() const
{
    return engine_->strategy_sum;
}

SolveStats RiverBatchSolver::solve(const SolveConfig& config, Algorithm algorithm)
{
    const LockSet* const previous_locks = engine_->locks_;
    engine_->locks_ = config.locks;
    const auto start = std::chrono::steady_clock::now();
    engine_->reset();
    note_profile_mutation();
    int completed = 0;
    SolveStats stats;
    stats.nash_gap_history.clear();
    stats.nash_gap_iterations.clear();
    bool fresh = false;
    try
    {
        for (int step = 0; step < config.max_iterations; ++step)
        {
            engine_->train_more(1, algorithm);
            note_profile_mutation();
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
    }
    catch (...)
    {
        engine_->locks_ = previous_locks;
        throw;
    }
    engine_->locks_ = previous_locks;
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
    // Modeled player-1 utility when player 1 best-responds (dual-utility).
    return engine_->utility_when_p1_responds();
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
