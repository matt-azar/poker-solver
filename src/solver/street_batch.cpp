#include "solver/street_batch.hpp"

#include "poker/card.hpp"
#include "poker/hand_eval.hpp"
#include "poker/range.hpp"
#include "solver/regret_matching.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <span>
#include <stdexcept>
#include <string>
#include <utility>
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
    int street = 0;
    int folded = -1;
    bool terminal = false;
    bool pending_check = false;
    bool chance = false;
    int deal_which = 0;
};

struct Legal
{
    int count = 0;
    int code[8] = {};
    int add[8] = {};
};

int betting_streets(const streets::StreetConfig& config)
{
    return static_cast<int>(config.board.size()) == 3 ? 3 : 2;
}

int street_kind(const streets::StreetConfig& config, int street)
{
    return config.board.size() == 3 ? street : street + 1;
}

const std::vector<double>& listed_bets(const streets::StreetConfig& config, int player, int kind)
{
    const std::vector<double>& specific = player == 0
        ? (kind == 0 ? config.oop_flop_bets : kind == 1 ? config.oop_turn_bets : config.oop_river_bets)
        : (kind == 0 ? config.ip_flop_bets : kind == 1 ? config.ip_turn_bets : config.ip_river_bets);
    if (!specific.empty())
    {
        return specific;
    }
    return player == 0 ? config.oop_bet_sizes : config.ip_bet_sizes;
}

const std::vector<double>& listed_raises(const streets::StreetConfig& config, int player, int kind)
{
    const std::vector<double>& specific = player == 0
        ? (kind == 0 ? config.oop_flop_raises : kind == 1 ? config.oop_turn_raises : config.oop_river_raises)
        : (kind == 0 ? config.ip_flop_raises : kind == 1 ? config.ip_turn_raises : config.ip_river_raises);
    if (!specific.empty())
    {
        return specific;
    }
    const std::vector<double>& street_bets = player == 0
        ? (kind == 0 ? config.oop_flop_bets : kind == 1 ? config.oop_turn_bets : config.oop_river_bets)
        : (kind == 0 ? config.ip_flop_bets : kind == 1 ? config.ip_turn_bets : config.ip_river_bets);
    if (!street_bets.empty())
    {
        return street_bets;
    }
    return player == 0 ? config.oop_raise_sizes : config.ip_raise_sizes;
}

const std::vector<double>& size_list(const streets::StreetConfig& config, int player, int street, bool facing)
{
    const int kind = street_kind(config, street);
    return facing ? listed_raises(config, player, kind) : listed_bets(config, player, kind);
}

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

Legal legal_actions(const streets::StreetConfig& config, const BetState& state)
{
    const int player = state.acting;
    const int to_call = state.committed - state.contrib[player];
    const bool facing = to_call > 0;
    const int max_add = config.stack - state.contrib[player];
    if (to_call < 0 || max_add < 0)
    {
        throw std::logic_error("street stack accounting failed");
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
                "a street decision has more than 8 actions; use fewer bet sizes");
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
        if (config.all_in_threshold > 0.0 && config.allow_all_in)
        {
            const double committed_after = static_cast<double>(state.contrib[player] + add);
            const double limit = config.all_in_threshold * static_cast<double>(config.stack);
            if (committed_after > limit && add < max_add)
            {
                add = max_add;
            }
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
    for (double fraction : size_list(config, player, state.street, facing))
    {
        const int sized = round_chips(fraction, basis);
        consider(facing ? to_call + sized : sized);
    }
    if (config.geometric)
    {
        const int streets_left = betting_streets(config) - state.street;
        const int stack_left = facing ? max_add - to_call : max_add;
        const double fraction = streets::geometric_pot_fraction(basis, stack_left, streets_left);
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
                "a street decision has more than 8 actions; use fewer bet sizes");
        }
        legal.code[legal.count] = 2;
        legal.add[legal.count] = amounts[i];
        ++legal.count;
    }
    return legal;
}

void finish_street(const streets::StreetConfig& config, BetState& state)
{
    state.pending_check = false;
    state.acting = -1;
    if (state.street + 1 < betting_streets(config))
    {
        const bool flop_tree = config.board.size() == 3;
        state.chance = true;
        state.deal_which = (flop_tree && state.street == 0) ? 1 : 2;
        state.street += 1;
        return;
    }
    state.terminal = true;
}

BetState apply_action(const streets::StreetConfig& config, BetState state, const Legal& legal, int action)
{
    const int player = state.acting;
    const int code = legal.code[action];
    const int add = legal.add[action];
    if (code == 0)
    {
        state.folded = player;
        state.terminal = true;
        state.acting = -1;
        return state;
    }
    const int to_call = state.committed - state.contrib[player];
    state.contrib[player] += add;
    state.pot += add;
    if (code == 1)
    {
        if (to_call > 0 || state.pending_check)
        {
            finish_street(config, state);
            return state;
        }
        state.pending_check = true;
        state.acting = 1 - player;
        return state;
    }
    const int raise_by = add - to_call;
    state.pending_check = false;
    state.last_raise = raise_by;
    state.committed = state.contrib[player];
    state.num_raises += 1;
    state.acting = 1 - player;
    return state;
}

} // namespace

struct StreetBatchSolver::Engine
{
    struct Deal
    {
        int h0 = 0;
        int h1 = 0;
        int combo0 = 0;
        int combo1 = 0;
        int c0 = 0;
        int c1 = 0;
        int d0 = 0;
        int d1 = 0;
        double probability = 0.0;
    };

    struct Node
    {
        bool terminal = false;
        bool chance = false;
        int deal_which = 0;
        int player = -1;
        int street = 0;
        int depth = 0;
        int card_mode = 0;
        bool mode1_is_turn = false;
        int hands = 0;
        int folded = -1;
        int contrib[2] = {};
        int n_actions = 0;
        int child[8] = {};
        std::vector<int> slot_of;
        std::string path;
        std::string action_labels[8];
    };

    struct Slot
    {
        std::string label;
        int node = 0;
        int base = 0;
        int n_actions = 0;
        int hand = 0;
        int turn = -1;
        int river = -1;
    };

    streets::StreetConfig config;
    std::vector<int> combos[2];
    std::vector<Deal> deals;
    std::vector<Node> nodes;
    std::vector<Slot> slots;
    std::vector<int> decision_ids;
    std::vector<double> regret;
    std::vector<double> strategy_sum;
    mutable std::vector<double> average;
    mutable std::vector<int> response;
    mutable bool average_ready = false;
    int n0 = 0;
    int n1 = 0;
    int public_decisions = 0;
    int public_terminals = 0;
    int expanded_decisions = 0;
    int expanded_terminals = 0;
    int trained = 0;

    explicit Engine(streets::StreetConfig incoming)
        : config(std::move(incoming))
    {
        validate();
        BetState root;
        root.pot = config.pot;
        root.acting = config.first_to_act;
        root.street = 0;
        build_node(root, "", 0);
        build_deals();
        prepare_slots();
        register_tree();
        regret.assign(static_cast<std::size_t>(cursor_), 0.0);
        strategy_sum.assign(static_cast<std::size_t>(cursor_), 0.0);
        average.assign(static_cast<std::size_t>(cursor_), 0.0);
    }

    int cursor_ = 0;

    void validate() const
    {
        if (config.board.size() != 3 && config.board.size() != 4)
        {
            throw std::invalid_argument("street solver board must have 3 or 4 cards");
        }
        holdem::validate_board(config.board.data(), static_cast<int>(config.board.size()));
        if (config.pot <= 0)
        {
            throw std::invalid_argument("pot must be positive");
        }
        if (config.stack < 0)
        {
            throw std::invalid_argument("stack must be nonnegative");
        }
        if (config.first_to_act != 0 && config.first_to_act != 1)
        {
            throw std::invalid_argument("first player must be 0 (OOP) or 1 (IP)");
        }
        if (config.max_raises < 0 || config.max_raises > 6)
        {
            throw std::invalid_argument("max raises must be from 0 through 6");
        }
        if (config.all_in_threshold < 0.0)
        {
            throw std::invalid_argument("all-in threshold must be nonnegative");
        }
    }

    int build_node(const BetState& state, const std::string& path, int depth)
    {
        if (state.terminal)
        {
            Node node;
            node.terminal = true;
            node.folded = state.folded;
            node.contrib[0] = state.contrib[0];
            node.contrib[1] = state.contrib[1];
            nodes.push_back(std::move(node));
            ++public_terminals;
            return static_cast<int>(nodes.size()) - 1;
        }
        if (state.chance)
        {
            Node node;
            node.chance = true;
            node.street = state.street;
            node.deal_which = state.deal_which;
            const int id = static_cast<int>(nodes.size());
            nodes.push_back(std::move(node));
            BetState next = state;
            next.chance = false;
            next.deal_which = 0;
            next.acting = config.first_to_act;
            next.pending_check = false;
            next.last_raise = 0;
            next.num_raises = 0;
            next.committed = next.contrib[0];
            nodes[static_cast<std::size_t>(id)].child[0] = build_node(next, path, depth);
            return id;
        }

        const Legal legal = legal_actions(config, state);
        const bool facing = state.committed > state.contrib[state.acting];
        Node node;
        node.player = state.acting;
        node.street = state.street;
        node.depth = depth;
        node.n_actions = legal.count;
        node.path = path;
        if (config.board.size() == 3)
        {
            if (state.street == 0)
            {
                node.card_mode = 0;
            }
            else if (state.street == 1)
            {
                node.card_mode = 1;
                node.mode1_is_turn = true;
            }
            else
            {
                node.card_mode = 2;
            }
        }
        else
        {
            node.card_mode = state.street == 0 ? 0 : 1;
            node.mode1_is_turn = false;
        }
        for (int action = 0; action < legal.count; ++action)
        {
            const int street_total = state.contrib[state.acting] + legal.add[action];
            const bool all_in = legal.code[action] != 0 && street_total == config.stack && legal.add[action] > 0;
            node.action_labels[action] = chip_label(
                legal.code[action], legal.add[action], street_total, all_in, facing);
        }
        const int id = static_cast<int>(nodes.size());
        nodes.push_back(std::move(node));
        ++public_decisions;
        decision_ids.push_back(id);
        for (int action = 0; action < legal.count; ++action)
        {
            const std::string& label = nodes[static_cast<std::size_t>(id)].action_labels[action];
            const std::string next_path = path.empty() ? label : path + "/" + label;
            const int child = build_node(apply_action(config, state, legal, action), next_path, depth + 1);
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
            config.oop, config.ip, config.board.data(), static_cast<int>(config.board.size()));
        if (rows.empty())
        {
            throw std::invalid_argument("ranges leave no legal hand pair");
        }
        deals.reserve(rows.size());
        for (const holdem::HandPairProbability& row : rows)
        {
            Deal deal;
            deal.h0 = hand_index(0, row.combo0);
            deal.h1 = hand_index(1, row.combo1);
            deal.combo0 = row.combo0;
            deal.combo1 = row.combo1;
            deal.probability = row.probability;
            holdem::Range::combo_cards(row.combo0, deal.c0, deal.c1);
            holdem::Range::combo_cards(row.combo1, deal.d0, deal.d1);
            deals.push_back(deal);
        }
        n0 = static_cast<int>(combos[0].size());
        n1 = static_cast<int>(combos[1].size());
    }

    void prepare_slots()
    {
        for (Node& node : nodes)
        {
            if (node.terminal || node.chance)
            {
                continue;
            }
            node.hands = node.player == 0 ? n0 : n1;
            int dim = 1;
            if (node.card_mode == 1)
            {
                dim = 52;
            }
            else if (node.card_mode == 2)
            {
                dim = 52 * 52;
            }
            node.slot_of.assign(static_cast<std::size_t>(dim * node.hands), -1);
        }
    }

    int card_key(const Node& node, int hand, int turn, int river) const
    {
        if (node.card_mode == 0)
        {
            return hand;
        }
        if (node.card_mode == 1)
        {
            const int card = node.mode1_is_turn ? turn : river;
            return card * node.hands + hand;
        }
        return (turn * 52 + river) * node.hands + hand;
    }

    int remaining(const Deal& deal, int turn, int river, int* out) const
    {
        bool dead[52] = {};
        for (int card : config.board)
        {
            dead[card] = true;
        }
        dead[deal.c0] = true;
        dead[deal.c1] = true;
        dead[deal.d0] = true;
        dead[deal.d1] = true;
        if (turn >= 0)
        {
            dead[turn] = true;
        }
        if (river >= 0)
        {
            dead[river] = true;
        }
        int count = 0;
        for (int card = 0; card < 52; ++card)
        {
            if (!dead[card])
            {
                out[count++] = card;
            }
        }
        return count;
    }

    std::string place_text(int street, int turn, int river) const
    {
        if (config.board.size() == 4)
        {
            if (street == 0)
            {
                return "turn";
            }
            return "river " + holdem::format_card(river);
        }
        if (street == 0)
        {
            return "flop";
        }
        if (street == 1)
        {
            return "turn " + holdem::format_card(turn);
        }
        return "turn " + holdem::format_card(turn) + " river " + holdem::format_card(river);
    }

    void register_node(int node_index, const Deal& deal, int turn, int river)
    {
        const Node& node = nodes[static_cast<std::size_t>(node_index)];
        if (node.terminal)
        {
            ++expanded_terminals;
            if (expanded_terminals > 200000)
            {
                throw std::invalid_argument(
                    "street tree has more than 200000 terminals; use smaller ranges");
            }
            return;
        }
        if (node.chance)
        {
            int cards[52];
            const int count = remaining(deal, turn, river, cards);
            for (int i = 0; i < count; ++i)
            {
                int next_turn = turn;
                int next_river = river;
                if (node.deal_which == 1)
                {
                    next_turn = cards[i];
                }
                else
                {
                    next_river = cards[i];
                }
                register_node(node.child[0], deal, next_turn, next_river);
            }
            return;
        }

        ++expanded_decisions;
        const int hand = node.player == 0 ? deal.h0 : deal.h1;
        const int key = card_key(node, hand, turn, river);
        if (nodes[static_cast<std::size_t>(node_index)].slot_of[static_cast<std::size_t>(key)] < 0)
        {
            Slot slot;
            slot.node = node_index;
            slot.base = cursor_;
            slot.n_actions = node.n_actions;
            slot.hand = hand;
            slot.turn = turn;
            slot.river = river;
            const int combo = node.player == 0 ? deal.combo0 : deal.combo1;
            slot.label = node.player == 0 ? "OOP " : "IP ";
            slot.label += holdem::Range::combo_text(combo);
            slot.label += " | ";
            slot.label += place_text(node.street, turn, river);
            slot.label += " | ";
            slot.label += node.path.empty() ? "open" : node.path;
            nodes[static_cast<std::size_t>(node_index)].slot_of[static_cast<std::size_t>(key)] =
                static_cast<int>(slots.size());
            slots.push_back(std::move(slot));
            cursor_ += node.n_actions;
        }
        for (int action = 0; action < node.n_actions; ++action)
        {
            register_node(node.child[action], deal, turn, river);
        }
    }

    void register_tree()
    {
        for (const Deal& deal : deals)
        {
            register_node(0, deal, -1, -1);
        }
    }

    int slot_index(const Node& node, int hand, int turn, int river) const
    {
        const int key = card_key(node, hand, turn, river);
        const int index = node.slot_of[static_cast<std::size_t>(key)];
        if (index < 0)
        {
            throw std::logic_error("street public tree missed an information set");
        }
        return index;
    }

    double payoff(const Node& node, const Deal& deal, int turn, int river) const
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
        int board[5];
        int count = 0;
        for (int card : config.board)
        {
            board[count++] = card;
        }
        if (turn >= 0)
        {
            board[count++] = turn;
        }
        if (river >= 0)
        {
            board[count++] = river;
        }
        if (count != 5)
        {
            throw std::logic_error("showdown without five board cards");
        }
        const int outcome = holdem::compare_showdown(
            deal.c0, deal.c1, deal.d0, deal.d1, std::span<const int>(board, 5));
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

    double cfr_deal(int node_index, double pi0, double pi1, double chance, const Deal& deal,
                    int turn, int river, int updating, double weight_iter, Algorithm algorithm)
    {
        const Node& node = nodes[static_cast<std::size_t>(node_index)];
        if (node.terminal)
        {
            return payoff(node, deal, turn, river);
        }
        if (node.chance)
        {
            int cards[52];
            const int count = remaining(deal, turn, river, cards);
            const double probability = 1.0 / static_cast<double>(count);
            double value = 0.0;
            for (int i = 0; i < count; ++i)
            {
                int next_turn = turn;
                int next_river = river;
                if (node.deal_which == 1)
                {
                    next_turn = cards[i];
                }
                else
                {
                    next_river = cards[i];
                }
                value += probability * cfr_deal(
                    node.child[0], pi0, pi1, chance * probability, deal,
                    next_turn, next_river, updating, weight_iter, algorithm);
            }
            return value;
        }

        const int hand = node.player == 0 ? deal.h0 : deal.h1;
        const int index = slot_index(node, hand, turn, river);
        const int base = slots[static_cast<std::size_t>(index)].base;
        double sigma[8];
        regret_matching(regret.data() + base, sigma, node.n_actions);
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
                    node.child[action], pi0 * sigma[action], pi1, chance, deal,
                    turn, river, updating, weight_iter, algorithm);
            }
            else
            {
                action_utility[action] = cfr_deal(
                    node.child[action], pi0, pi1 * sigma[action], chance, deal,
                    turn, river, updating, weight_iter, algorithm);
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
                double& cumulative = regret[static_cast<std::size_t>(base + action)];
                cumulative += opponent_reach * instant;
                if (algorithm == Algorithm::CfrPlus && cumulative < 0.0)
                {
                    cumulative = 0.0;
                }
            }
        }
        return node_utility;
    }

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
            throw std::invalid_argument("the public street tree implements vanilla CFR and CFR+");
        }
        average_ready = false;
        for (int step = 0; step < count; ++step)
        {
            ++trained;
            if (algorithm == Algorithm::VanillaCfr)
            {
                for (const Deal& deal : deals)
                {
                    cfr_deal(0, 1.0, 1.0, deal.probability, deal, -1, -1, -1, 1.0, algorithm);
                }
            }
            else
            {
                const double weight_iter = static_cast<double>(trained);
                for (const Deal& deal : deals)
                {
                    cfr_deal(0, 1.0, 1.0, deal.probability, deal, -1, -1, 0, weight_iter, algorithm);
                }
                for (const Deal& deal : deals)
                {
                    cfr_deal(0, 1.0, 1.0, deal.probability, deal, -1, -1, 1, weight_iter, algorithm);
                }
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

    const double* sigma_of(int slot) const
    {
        return average.data() + slots[static_cast<std::size_t>(slot)].base;
    }

    double profile_value(int node_index, const Deal& deal, int turn, int river, int responding) const
    {
        const Node& node = nodes[static_cast<std::size_t>(node_index)];
        if (node.terminal)
        {
            return payoff(node, deal, turn, river);
        }
        if (node.chance)
        {
            int cards[52];
            const int count = remaining(deal, turn, river, cards);
            const double probability = 1.0 / static_cast<double>(count);
            double value = 0.0;
            for (int i = 0; i < count; ++i)
            {
                int next_turn = turn;
                int next_river = river;
                if (node.deal_which == 1)
                {
                    next_turn = cards[i];
                }
                else
                {
                    next_river = cards[i];
                }
                value += probability * profile_value(node.child[0], deal, next_turn, next_river, responding);
            }
            return value;
        }

        const int hand = node.player == 0 ? deal.h0 : deal.h1;
        const int index = slot_index(node, hand, turn, river);
        if (node.player == responding)
        {
            const int chosen = response[static_cast<std::size_t>(index)];
            if (chosen < 0)
            {
                throw std::logic_error("best response reached an unsolved street infoset");
            }
            return profile_value(node.child[chosen], deal, turn, river, responding);
        }
        const double* sigma = sigma_of(index);
        double value = 0.0;
        for (int action = 0; action < node.n_actions; ++action)
        {
            value += sigma[action] * profile_value(node.child[action], deal, turn, river, responding);
        }
        return value;
    }

    void accumulate_target(int node_index, const Deal& deal, int turn, int river, double reach,
                           int responding, int target, std::vector<double>& action_value) const
    {
        const Node& node = nodes[static_cast<std::size_t>(node_index)];
        if (node.terminal)
        {
            return;
        }
        if (node.chance)
        {
            int cards[52];
            const int count = remaining(deal, turn, river, cards);
            const double probability = 1.0 / static_cast<double>(count);
            for (int i = 0; i < count; ++i)
            {
                int next_turn = turn;
                int next_river = river;
                if (node.deal_which == 1)
                {
                    next_turn = cards[i];
                }
                else
                {
                    next_river = cards[i];
                }
                accumulate_target(
                    node.child[0], deal, next_turn, next_river, reach * probability,
                    responding, target, action_value);
            }
            return;
        }

        const int hand = node.player == 0 ? deal.h0 : deal.h1;
        const int index = slot_index(node, hand, turn, river);
        if (node.player != responding)
        {
            const double* sigma = sigma_of(index);
            for (int action = 0; action < node.n_actions; ++action)
            {
                accumulate_target(
                    node.child[action], deal, turn, river, reach * sigma[action],
                    responding, target, action_value);
            }
            return;
        }
        if (node_index == target)
        {
            for (int action = 0; action < node.n_actions; ++action)
            {
                const double utility = profile_value(node.child[action], deal, turn, river, responding);
                const double responder_utility = responding == 0 ? utility : -utility;
                action_value[static_cast<std::size_t>(index * 8 + action)] += reach * responder_utility;
            }
            return;
        }
        const int chosen = response[static_cast<std::size_t>(index)];
        if (chosen >= 0)
        {
            accumulate_target(node.child[chosen], deal, turn, river, reach, responding, target, action_value);
            return;
        }
        for (int action = 0; action < node.n_actions; ++action)
        {
            accumulate_target(node.child[action], deal, turn, river, reach, responding, target, action_value);
        }
    }

    double utility_of_response(int responding) const
    {
        ensure_average();
        response.assign(slots.size(), -1);
        if (responding >= 0)
        {
            std::vector<int> order = decision_ids;
            std::sort(order.begin(), order.end(), [&](int left, int right)
            {
                const int left_depth = nodes[static_cast<std::size_t>(left)].depth;
                const int right_depth = nodes[static_cast<std::size_t>(right)].depth;
                if (left_depth != right_depth)
                {
                    return left_depth > right_depth;
                }
                return left < right;
            });
            std::vector<double> action_value(slots.size() * 8, 0.0);
            for (const int target : order)
            {
                if (nodes[static_cast<std::size_t>(target)].player != responding)
                {
                    continue;
                }
                std::fill(action_value.begin(), action_value.end(), 0.0);
                for (const Deal& deal : deals)
                {
                    accumulate_target(0, deal, -1, -1, deal.probability, responding, target, action_value);
                }
                const int count = nodes[static_cast<std::size_t>(target)].n_actions;
                for (std::size_t slot = 0; slot < slots.size(); ++slot)
                {
                    if (slots[slot].node != target)
                    {
                        continue;
                    }
                    int best = 0;
                    for (int action = 1; action < count; ++action)
                    {
                        if (action_value[slot * 8 + static_cast<std::size_t>(action)]
                            > action_value[slot * 8 + static_cast<std::size_t>(best)])
                        {
                            best = action;
                        }
                    }
                    response[slot] = best;
                }
            }
        }

        double total = 0.0;
        for (const Deal& deal : deals)
        {
            total += deal.probability * profile_value(0, deal, -1, -1, responding);
        }
        return total;
    }
};

StreetBatchSolver::StreetBatchSolver(streets::StreetConfig config)
    : engine_(std::make_unique<Engine>(std::move(config)))
{
}

StreetBatchSolver::~StreetBatchSolver() = default;

void StreetBatchSolver::run_iterations(int count, Algorithm algorithm)
{
    engine_->reset();
    engine_->train_more(count, algorithm);
}

void StreetBatchSolver::continue_iterations(int count, Algorithm algorithm)
{
    engine_->train_more(count, algorithm);
}

SolveStats StreetBatchSolver::solve(const SolveConfig& config, Algorithm algorithm)
{
    const auto start = std::chrono::steady_clock::now();
    engine_->reset();
    int completed = 0;
    SolveStats stats;
    bool fresh = false;
    for (int step = 0; step < config.max_iterations; ++step)
    {
        engine_->train_more(1, algorithm);
        ++completed;
        fresh = false;
        const bool check_gap = config.nash_gap_threshold >= 0.0
            && config.eval_interval > 0
            && completed % config.eval_interval == 0;
        if (check_gap)
        {
            stats.p1_expected_utility = expected_utility();
            stats.p1_best_response_utility = p1_best_response_utility();
            stats.p2_best_response_utility = p2_best_response_utility();
            stats.nash_gap = stats.p1_best_response_utility + stats.p2_best_response_utility;
            fresh = true;
            if (stats.nash_gap <= config.nash_gap_threshold)
            {
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
    }
    stats.iterations = completed;
    stats.runtime_seconds = std::chrono::duration<double>(end - start).count();
    stats.memory_bytes_estimate = memory_bytes_estimate();
    return stats;
}

double StreetBatchSolver::expected_utility() const
{
    return engine_->utility_of_response(-1);
}

double StreetBatchSolver::p1_best_response_utility() const
{
    return engine_->utility_of_response(0);
}

double StreetBatchSolver::p2_best_response_utility() const
{
    return -engine_->utility_of_response(1);
}

double StreetBatchSolver::nash_gap() const
{
    return p1_best_response_utility() + p2_best_response_utility();
}

int StreetBatchSolver::infoset_count() const
{
    return static_cast<int>(engine_->slots.size());
}

int StreetBatchSolver::deal_count() const
{
    return static_cast<int>(engine_->deals.size());
}

int StreetBatchSolver::public_decisions() const
{
    return engine_->public_decisions;
}

int StreetBatchSolver::public_terminals() const
{
    return engine_->public_terminals;
}

int StreetBatchSolver::decision_node_count() const
{
    return engine_->expanded_decisions;
}

int StreetBatchSolver::terminal_count() const
{
    return engine_->expanded_terminals;
}

int StreetBatchSolver::regret_entries() const
{
    return static_cast<int>(engine_->regret.size());
}

std::size_t StreetBatchSolver::memory_bytes_estimate() const
{
    return engine_->regret.size() * sizeof(double)
        + engine_->strategy_sum.size() * sizeof(double);
}

std::vector<StreetStrategyEntry> StreetBatchSolver::average_strategy_entries() const
{
    engine_->ensure_average();
    std::vector<StreetStrategyEntry> entries;
    entries.reserve(engine_->slots.size() * 2);
    for (const Engine::Slot& slot : engine_->slots)
    {
        const Engine::Node& node = engine_->nodes[static_cast<std::size_t>(slot.node)];
        for (int action = 0; action < slot.n_actions; ++action)
        {
            StreetStrategyEntry entry;
            entry.infoset = slot.label;
            entry.action = node.action_labels[action];
            entry.probability = engine_->average[static_cast<std::size_t>(slot.base + action)];
            entries.push_back(std::move(entry));
        }
    }
    return entries;
}

} // namespace poker::solver
