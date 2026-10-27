#include "solver/street_batch.hpp"

#include "poker/card.hpp"
#include "poker/hand_eval.hpp"
#include "poker/range.hpp"
#include "solver/regret_matching.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <numeric>
#include <span>
#include <stdexcept>
#include <string>
#include <unordered_map>
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
    int prev_aggressor = -1;
    int street_aggressor = -1;
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

int chips_from_spec(double spec, int basis)
{
    if (spec < 0.0)
    {
        return static_cast<int>(std::llround(-spec));
    }
    return round_chips(spec, basis);
}

const std::vector<double>& street_raises(const streets::StreetConfig& config, int player, int kind)
{
    return player == 0
        ? (kind == 0 ? config.oop_flop_raises : kind == 1 ? config.oop_turn_raises : config.oop_river_raises)
        : (kind == 0 ? config.ip_flop_raises : kind == 1 ? config.ip_turn_raises : config.ip_river_raises);
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
        if (!config.allow_three_bet && state.num_raises >= 2)
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
        if (config.pot_cap > 0.0)
        {
            const int reference = facing ? state.pot + to_call : state.pot;
            int max_by = round_chips(config.pot_cap, reference);
            if (max_by < 1)
            {
                max_by = 1;
            }
            if (add - to_call > max_by)
            {
                add = to_call + max_by;
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
    const bool donk = !facing && player == 0 && state.prev_aggressor == 1
        && !config.oop_donk_sizes.empty();
    const std::vector<double>& multiples = player == 0
        ? config.oop_raise_multiples : config.ip_raise_multiples;
    const bool only_multiples = facing && !multiples.empty()
        && street_raises(config, player, street_kind(config, state.street)).empty()
        && (player == 0 ? config.oop_raise_sizes : config.ip_raise_sizes).empty();
    if (donk)
    {
        for (double spec : config.oop_donk_sizes)
        {
            consider(chips_from_spec(spec, basis));
        }
    }
    else if (!only_multiples)
    {
        for (double spec : size_list(config, player, state.street, facing))
        {
            const int sized = chips_from_spec(spec, basis);
            consider(facing ? to_call + sized : sized);
        }
    }
    if (facing)
    {
        for (double multiple : multiples)
        {
            if (multiple <= 0.0 || state.committed <= 0)
            {
                continue;
            }
            const int street_total = static_cast<int>(std::llround(
                multiple * static_cast<double>(state.committed)));
            consider(street_total - state.contrib[player]);
        }
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
    state.prev_aggressor = state.street_aggressor;
    state.street_aggressor = -1;
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
    state.street_aggressor = player;
    state.acting = 1 - player;
    return state;
}

std::uint32_t pack_rank(const holdem::HandValue& value)
{
    std::uint32_t rank = static_cast<std::uint32_t>(value.category);
    for (int i = 0; i < 5; ++i)
    {
        rank = rank * 16u + static_cast<std::uint32_t>(value.tiebreak[i]);
    }
    return rank;
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
    std::vector<double> range_w[2];
    std::vector<int> hole_a[2];
    std::vector<int> hole_b[2];
    std::vector<int> hand_of[2];
    double joint_scale = 0.0;
    struct RunoutRanks
    {
        std::vector<std::uint32_t> rank[2];
    };
    mutable std::unordered_map<int, RunoutRanks> runout_ranks;
    mutable std::vector<int> order_buf;
    mutable std::vector<int> pos_buf;
    mutable std::vector<double> prefix_buf;
    mutable std::vector<double> card_prefix_buf;
    mutable std::vector<std::uint32_t> sorted_rank_buf;
    std::vector<std::uint64_t> mask[2];
    std::uint64_t board_mask = 0;
    struct Support
    {
        int compatible = 0;
        int contain[52] = {};
    };
    std::vector<Support> support[2];
    std::vector<double> frozen_sigma;
    struct Scratch
    {
        std::vector<double> ev0;
        std::vector<double> ev1;
        std::vector<double> pi0;
        std::vector<double> pi1;
        std::vector<double> aev0;
        std::vector<double> aev1;
    };
    mutable std::vector<Scratch> scratch;

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
        frozen_sigma.assign(static_cast<std::size_t>(cursor_), 0.0);
        build_reach_table();
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
        if (config.pot_cap < 0.0)
        {
            throw std::invalid_argument("pot cap must be nonnegative");
        }
    }

    int build_node(const BetState& state, const std::string& path, int depth)
    {
        if (depth > 48)
        {
            throw std::logic_error("public street tree deeper than 48");
        }
        if (state.terminal)
        {
            Node node;
            node.terminal = true;
            node.street = state.street;
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

    void add_slot(int node_index, int hand, int turn, int river)
    {
        Node& node = nodes[static_cast<std::size_t>(node_index)];
        const int key = card_key(node, hand, turn, river);
        Slot slot;
        slot.node = node_index;
        slot.base = cursor_;
        slot.n_actions = node.n_actions;
        slot.hand = hand;
        slot.turn = turn;
        slot.river = river;
        node.slot_of[static_cast<std::size_t>(key)] = static_cast<int>(slots.size());
        slots.push_back(std::move(slot));
        cursor_ += node.n_actions;
    }

    // Every legal deal keeps four distinct hole cards off the board, so each
    // public node is reached by deals.size() times the same runout count.
    // extra is 0 on the first street, 1 after the next card, and 2 on the river.
    void charge_visits(int extra, bool terminal)
    {
        int live = 52 - static_cast<int>(config.board.size()) - 4;
        long long per_deal = 1;
        for (int i = 0; i < extra; ++i)
        {
            per_deal *= live;
            --live;
        }
        const long long visits = per_deal * static_cast<long long>(deals.size());
        if (terminal)
        {
            const long long next = static_cast<long long>(expanded_terminals) + visits;
            if (next > 100000000LL)
            {
                throw std::invalid_argument(
                    "street tree has more than 100000000 hand terminals; use smaller ranges");
            }
            expanded_terminals = static_cast<int>(next);
            return;
        }
        const long long next = static_cast<long long>(expanded_decisions) + visits;
        if (next > 2000000000LL)
        {
            throw std::invalid_argument(
                "street tree has more than 2000000000 decision visits; use smaller ranges");
        }
        expanded_decisions = static_cast<int>(next);
    }

    void register_tree()
    {
        bool on_board[52] = {};
        for (int card : config.board)
        {
            on_board[card] = true;
        }
        std::vector<int> card_a[2];
        std::vector<int> card_b[2];
        std::vector<int> hand_at[2];
        for (int player = 0; player < 2; ++player)
        {
            const int count = static_cast<int>(combos[player].size());
            card_a[player].resize(static_cast<std::size_t>(count));
            card_b[player].resize(static_cast<std::size_t>(count));
            hand_at[player].assign(static_cast<std::size_t>(holdem::kComboCount), -1);
            for (int hand = 0; hand < count; ++hand)
            {
                const int combo = combos[player][static_cast<std::size_t>(hand)];
                holdem::Range::combo_cards(
                    combo, card_a[player][static_cast<std::size_t>(hand)],
                    card_b[player][static_cast<std::size_t>(hand)]);
                hand_at[player][static_cast<std::size_t>(combo)] = hand;
            }
        }

        for (const Node& node : nodes)
        {
            if (node.chance)
            {
                continue;
            }
            charge_visits(node.terminal ? node.street : node.card_mode, node.terminal);
        }

        for (int player = 0; player < 2; ++player)
        {
            const int opp = 1 - player;
            const int count = static_cast<int>(combos[player].size());
            const int opp_count = static_cast<int>(combos[opp].size());
            support[player].assign(static_cast<std::size_t>(count), Support{});
            for (int hand = 0; hand < count; ++hand)
            {
                const int c0 = card_a[player][static_cast<std::size_t>(hand)];
                const int c1 = card_b[player][static_cast<std::size_t>(hand)];
                Support& row = support[player][static_cast<std::size_t>(hand)];
                for (int other = 0; other < opp_count; ++other)
                {
                    const int d0 = card_a[opp][static_cast<std::size_t>(other)];
                    const int d1 = card_b[opp][static_cast<std::size_t>(other)];
                    if (d0 == c0 || d0 == c1 || d1 == c0 || d1 == c1)
                    {
                        continue;
                    }
                    ++row.compatible;
                    ++row.contain[d0];
                    ++row.contain[d1];
                }
            }
        }

        for (int node_index = 0; node_index < static_cast<int>(nodes.size()); ++node_index)
        {
            const Node& node = nodes[static_cast<std::size_t>(node_index)];
            if (node.terminal || node.chance)
            {
                continue;
            }
            const int player = node.player;
            const int opp = 1 - player;
            for (int hand = 0; hand < node.hands; ++hand)
            {
                const Support& row = support[player][static_cast<std::size_t>(hand)];
                const int c0 = card_a[player][static_cast<std::size_t>(hand)];
                const int c1 = card_b[player][static_cast<std::size_t>(hand)];
                if (node.card_mode == 0)
                {
                    add_slot(node_index, hand, -1, -1);
                    continue;
                }
                if (node.card_mode == 1)
                {
                    for (int card = 0; card < 52; ++card)
                    {
                        if (on_board[card] || card == c0 || card == c1)
                        {
                            continue;
                        }
                        if (row.compatible - row.contain[card] <= 0)
                        {
                            continue;
                        }
                        if (node.mode1_is_turn)
                        {
                            add_slot(node_index, hand, card, -1);
                        }
                        else
                        {
                            add_slot(node_index, hand, -1, card);
                        }
                    }
                    continue;
                }
                for (int turn = 0; turn < 52; ++turn)
                {
                    if (on_board[turn] || turn == c0 || turn == c1)
                    {
                        continue;
                    }
                    for (int river = 0; river < 52; ++river)
                    {
                        if (river == turn || on_board[river] || river == c0 || river == c1)
                        {
                            continue;
                        }
                        int blocked = row.contain[turn] + row.contain[river];
                        const int pair = holdem::Range::combo_index(turn, river);
                        if (hand_at[opp][static_cast<std::size_t>(pair)] >= 0)
                        {
                            --blocked;
                        }
                        if (row.compatible - blocked <= 0)
                        {
                            continue;
                        }
                        add_slot(node_index, hand, turn, river);
                    }
                }
            }
        }
    }

    std::string slot_label(const Slot& slot) const
    {
        const Node& node = nodes[static_cast<std::size_t>(slot.node)];
        const int combo = combos[node.player][static_cast<std::size_t>(slot.hand)];
        std::string text = node.player == 0 ? "OOP " : "IP ";
        text += holdem::Range::combo_text(combo);
        text += " | ";
        text += place_text(node.street, slot.turn, slot.river);
        text += " | ";
        text += node.path.empty() ? "open" : node.path;
        return text;
    }

    int slot_index(const Node& node, int hand, int turn, int river, double reach) const
    {
        const int key = card_key(node, hand, turn, river);
        const int index = node.slot_of[static_cast<std::size_t>(key)];
        if (index >= 0)
        {
            return index;
        }
        const int combo = combos[node.player][static_cast<std::size_t>(hand)];
        const int node_index = static_cast<int>(&node - nodes.data());
        throw std::logic_error(
            "street public tree missed an information set"
            " node " + std::to_string(node_index)
            + " path " + (node.path.empty() ? std::string("open") : node.path)
            + " place " + place_text(node.street, turn, river)
            + " player " + std::to_string(node.player)
            + " hand " + holdem::Range::combo_text(combo)
            + " supported " + std::string(hand_supported(node.player, hand, turn, river) ? "1" : "0")
            + " compatible " + std::to_string(compatible_on(node.player, hand, turn, river))
            + " reach " + std::to_string(reach));
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
                    int turn, int river, int updating, double weight_iter)
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
                    next_turn, next_river, updating, weight_iter);
            }
            return value;
        }

        const int hand = node.player == 0 ? deal.h0 : deal.h1;
        const double reach = node.player == 0 ? pi0 : pi1;
        const int index = slot_index(node, hand, turn, river, reach);
        const int base = slots[static_cast<std::size_t>(index)].base;
        const double* sigma = frozen_sigma.data() + base;
        const bool update = updating < 0 || updating == node.player;
        if (update)
        {
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
                    turn, river, updating, weight_iter);
            }
            else
            {
                action_utility[action] = cfr_deal(
                    node.child[action], pi0, pi1 * sigma[action], chance, deal,
                    turn, river, updating, weight_iter);
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
                freeze_sigma();
                for (const Deal& deal : deals)
                {
                    cfr_deal(0, 1.0, 1.0, deal.probability, deal, -1, -1, -1, 1.0);
                }
            }
            else
            {
                const double weight_iter = static_cast<double>(trained);
                freeze_sigma();
                for (const Deal& deal : deals)
                {
                    cfr_deal(0, 1.0, 1.0, deal.probability, deal, -1, -1, 0, weight_iter);
                }
                floor_player(0);
                freeze_sigma();
                for (const Deal& deal : deals)
                {
                    cfr_deal(0, 1.0, 1.0, deal.probability, deal, -1, -1, 1, weight_iter);
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

    int stored_slot(const Node& node, int hand, int turn, int river) const
    {
        return node.slot_of[static_cast<std::size_t>(card_key(node, hand, turn, river))];
    }

    // One public-tree pass. responding < 0 plays the average strategy.
    // A best-responding player picks, per hand, the action with the higher
    // utility and keeps the lowest index on a tie. The other player mixes.
    void response_walk(int node_index, int turn, int river, int depth, int responding) const
    {
        if (depth + 1 >= static_cast<int>(scratch.size()))
        {
            throw std::logic_error("street best response ran out of scratch");
        }
        const Node& node = nodes[static_cast<std::size_t>(node_index)];
        Scratch& here = scratch[static_cast<std::size_t>(depth)];
        const double* pi0 = here.pi0.data();
        const double* pi1 = here.pi1.data();
        if (node.terminal)
        {
            apply_terminal(node, turn, river, pi0, pi1, here.ev0, here.ev1);
            return;
        }
        if (node.chance)
        {
            std::fill(here.ev0.begin(), here.ev0.end(), 0.0);
            std::fill(here.ev1.begin(), here.ev1.end(), 0.0);
            int denom = 52 - static_cast<int>(config.board.size()) - 4;
            std::uint64_t dead = board_mask;
            if (turn >= 0)
            {
                --denom;
                dead |= std::uint64_t{1} << turn;
            }
            if (river >= 0)
            {
                --denom;
                dead |= std::uint64_t{1} << river;
            }
            const double probability = 1.0 / static_cast<double>(denom);
            Scratch& child = scratch[static_cast<std::size_t>(depth + 1)];
            for (int card = 0; card < 52; ++card)
            {
                if (((dead >> card) & 1u) != 0)
                {
                    continue;
                }
                int next_turn = turn;
                int next_river = river;
                if (node.deal_which == 1)
                {
                    next_turn = card;
                }
                else
                {
                    next_river = card;
                }
                if (!card_reaches_pair(next_turn, next_river, pi0, pi1))
                {
                    continue;
                }
                for (int h0 = 0; h0 < n0; ++h0)
                {
                    child.pi0[static_cast<std::size_t>(h0)] = hand_supported(0, h0, next_turn, next_river)
                        ? pi0[h0] : 0.0;
                }
                for (int h1 = 0; h1 < n1; ++h1)
                {
                    child.pi1[static_cast<std::size_t>(h1)] = hand_supported(1, h1, next_turn, next_river)
                        ? pi1[h1] : 0.0;
                }
                response_walk(node.child[0], next_turn, next_river, depth + 1, responding);
                for (int h0 = 0; h0 < n0; ++h0)
                {
                    here.ev0[static_cast<std::size_t>(h0)] +=
                        probability * child.ev0[static_cast<std::size_t>(h0)];
                }
                for (int h1 = 0; h1 < n1; ++h1)
                {
                    here.ev1[static_cast<std::size_t>(h1)] +=
                        probability * child.ev1[static_cast<std::size_t>(h1)];
                }
            }
            return;
        }

        Scratch& child = scratch[static_cast<std::size_t>(depth + 1)];
        const bool choosing = node.player == responding;
        for (int action = 0; action < node.n_actions; ++action)
        {
            if (node.player == 0)
            {
                for (int h0 = 0; h0 < n0; ++h0)
                {
                    if (!hand_supported(0, h0, turn, river))
                    {
                        child.pi0[static_cast<std::size_t>(h0)] = 0.0;
                        continue;
                    }
                    if (choosing)
                    {
                        child.pi0[static_cast<std::size_t>(h0)] = pi0[h0];
                    }
                    else
                    {
                        const int index = slot_index(node, h0, turn, river, pi0[h0]);
                        const double played = average[static_cast<std::size_t>(
                            slots[static_cast<std::size_t>(index)].base + action)];
                        child.pi0[static_cast<std::size_t>(h0)] = pi0[h0] * played;
                    }
                }
                std::copy(pi1, pi1 + n1, child.pi1.begin());
            }
            else
            {
                std::copy(pi0, pi0 + n0, child.pi0.begin());
                for (int h1 = 0; h1 < n1; ++h1)
                {
                    if (!hand_supported(1, h1, turn, river))
                    {
                        child.pi1[static_cast<std::size_t>(h1)] = 0.0;
                        continue;
                    }
                    if (choosing)
                    {
                        child.pi1[static_cast<std::size_t>(h1)] = pi1[h1];
                    }
                    else
                    {
                        const int index = slot_index(node, h1, turn, river, pi1[h1]);
                        const double played = average[static_cast<std::size_t>(
                            slots[static_cast<std::size_t>(index)].base + action)];
                        child.pi1[static_cast<std::size_t>(h1)] = pi1[h1] * played;
                    }
                }
            }
            response_walk(node.child[action], turn, river, depth + 1, responding);
            std::copy(
                child.ev0.begin(), child.ev0.end(),
                here.aev0.begin() + static_cast<std::size_t>(action * n0));
            std::copy(
                child.ev1.begin(), child.ev1.end(),
                here.aev1.begin() + static_cast<std::size_t>(action * n1));
        }

        for (int h0 = 0; h0 < n0; ++h0)
        {
            if (!hand_supported(0, h0, turn, river))
            {
                here.ev0[static_cast<std::size_t>(h0)] = 0.0;
                continue;
            }
            if (node.player == 0 && responding == 0)
            {
                const int index = slot_index(node, h0, turn, river, pi0[h0]);
                int best = 0;
                for (int action = 1; action < node.n_actions; ++action)
                {
                    if (here.aev0[static_cast<std::size_t>(action * n0 + h0)]
                        > here.aev0[static_cast<std::size_t>(best * n0 + h0)])
                    {
                        best = action;
                    }
                }
                here.ev0[static_cast<std::size_t>(h0)] =
                    here.aev0[static_cast<std::size_t>(best * n0 + h0)];
                response[static_cast<std::size_t>(index)] = best;
            }
            else if (node.player == 0)
            {
                const int index = slot_index(node, h0, turn, river, pi0[h0]);
                double mix = 0.0;
                for (int action = 0; action < node.n_actions; ++action)
                {
                    const double played = average[static_cast<std::size_t>(
                        slots[static_cast<std::size_t>(index)].base + action)];
                    mix += played * here.aev0[static_cast<std::size_t>(action * n0 + h0)];
                }
                here.ev0[static_cast<std::size_t>(h0)] = mix;
            }
            else if (responding == 1)
            {
                here.ev0[static_cast<std::size_t>(h0)] = 0.0;
            }
            else
            {
                double mix = 0.0;
                for (int action = 0; action < node.n_actions; ++action)
                {
                    mix += here.aev0[static_cast<std::size_t>(action * n0 + h0)];
                }
                here.ev0[static_cast<std::size_t>(h0)] = mix;
            }
        }
        for (int h1 = 0; h1 < n1; ++h1)
        {
            if (!hand_supported(1, h1, turn, river))
            {
                here.ev1[static_cast<std::size_t>(h1)] = 0.0;
                continue;
            }
            if (node.player == 1 && responding == 1)
            {
                const int index = slot_index(node, h1, turn, river, pi1[h1]);
                int best = 0;
                for (int action = 1; action < node.n_actions; ++action)
                {
                    if (here.aev1[static_cast<std::size_t>(action * n1 + h1)]
                        < here.aev1[static_cast<std::size_t>(best * n1 + h1)])
                    {
                        best = action;
                    }
                }
                here.ev1[static_cast<std::size_t>(h1)] =
                    here.aev1[static_cast<std::size_t>(best * n1 + h1)];
                response[static_cast<std::size_t>(index)] = best;
            }
            else if (node.player == 1)
            {
                const int index = slot_index(node, h1, turn, river, pi1[h1]);
                double mix = 0.0;
                for (int action = 0; action < node.n_actions; ++action)
                {
                    const double played = average[static_cast<std::size_t>(
                        slots[static_cast<std::size_t>(index)].base + action)];
                    mix += played * here.aev1[static_cast<std::size_t>(action * n1 + h1)];
                }
                here.ev1[static_cast<std::size_t>(h1)] = mix;
            }
            else if (responding == 0)
            {
                here.ev1[static_cast<std::size_t>(h1)] = 0.0;
            }
            else
            {
                double mix = 0.0;
                for (int action = 0; action < node.n_actions; ++action)
                {
                    mix += here.aev1[static_cast<std::size_t>(action * n1 + h1)];
                }
                here.ev1[static_cast<std::size_t>(h1)] = mix;
            }
        }
    }

    double utility_of_response(int responding) const
    {
        ensure_average();
        response.assign(slots.size(), -1);
        std::fill(scratch[0].pi0.begin(), scratch[0].pi0.end(), 1.0);
        std::fill(scratch[0].pi1.begin(), scratch[0].pi1.end(), 1.0);
        response_walk(0, -1, -1, 0, responding);
        const std::vector<double>& values = responding == 1 ? scratch[0].ev1 : scratch[0].ev0;
        double total = 0.0;
        for (double value : values)
        {
            total += value;
        }
        return total;
    }

    void build_reach_table()
    {
        board_mask = 0;
        for (int card : config.board)
        {
            board_mask |= std::uint64_t{1} << card;
        }
        const holdem::Range* ranges[2] = {&config.oop, &config.ip};
        for (int player = 0; player < 2; ++player)
        {
            mask[player].assign(combos[player].size(), 0);
            range_w[player].assign(combos[player].size(), 0.0);
            hole_a[player].assign(combos[player].size(), 0);
            hole_b[player].assign(combos[player].size(), 0);
            hand_of[player].assign(static_cast<std::size_t>(holdem::kComboCount), -1);
            for (std::size_t hand = 0; hand < combos[player].size(); ++hand)
            {
                int c0 = 0;
                int c1 = 0;
                const int combo = combos[player][hand];
                holdem::Range::combo_cards(combo, c0, c1);
                mask[player][hand] = (std::uint64_t{1} << c0) | (std::uint64_t{1} << c1);
                hole_a[player][hand] = c0;
                hole_b[player][hand] = c1;
                range_w[player][hand] = ranges[player]->weight(combo);
                hand_of[player][static_cast<std::size_t>(combo)] = static_cast<int>(hand);
            }
        }
        const double mass = holdem::joint_mass(
            config.oop, config.ip, config.board.data(), static_cast<int>(config.board.size()));
        if (mass <= 0.0)
        {
            throw std::logic_error("street ranges have no joint weight");
        }
        joint_scale = 1.0 / mass;
        scratch.resize(32);
        for (Scratch& level : scratch)
        {
            level.ev0.assign(static_cast<std::size_t>(n0), 0.0);
            level.ev1.assign(static_cast<std::size_t>(n1), 0.0);
            level.pi0.assign(static_cast<std::size_t>(n0), 0.0);
            level.pi1.assign(static_cast<std::size_t>(n1), 0.0);
            level.aev0.assign(static_cast<std::size_t>(8 * n0), 0.0);
            level.aev1.assign(static_cast<std::size_t>(8 * n1), 0.0);
        }
    }

    bool hand_live(int player, int hand, int turn, int river) const
    {
        const std::uint64_t bits = mask[player][static_cast<std::size_t>(hand)];
        if (turn >= 0 && ((bits >> turn) & 1u) != 0)
        {
            return false;
        }
        if (river >= 0 && ((bits >> river) & 1u) != 0)
        {
            return false;
        }
        return true;
    }

    const std::vector<std::uint32_t>& ranks_for(int player, int turn, int river) const
    {
        const int key = (turn + 1) * 64 + (river + 1);
        RunoutRanks& table = runout_ranks[key];
        if (table.rank[0].empty())
        {
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
            for (int side = 0; side < 2; ++side)
            {
                const int hands = side == 0 ? n0 : n1;
                table.rank[side].assign(static_cast<std::size_t>(hands), 0);
                for (int hand = 0; hand < hands; ++hand)
                {
                    if (!hand_live(side, hand, turn, river))
                    {
                        continue;
                    }
                    int cards[7];
                    cards[0] = hole_a[side][static_cast<std::size_t>(hand)];
                    cards[1] = hole_b[side][static_cast<std::size_t>(hand)];
                    for (int i = 0; i < 5; ++i)
                    {
                        cards[2 + i] = board[i];
                    }
                    table.rank[side][static_cast<std::size_t>(hand)] = pack_rank(
                        holdem::evaluate(std::span<const int>(cards, 7)));
                }
            }
        }
        return table.rank[player];
    }

    void collect_reach(
        int player,
        int turn,
        int river,
        const double* pi,
        bool use_board,
        std::vector<double>& amount,
        double& total,
        double* by_card) const
    {
        const int hands = player == 0 ? n0 : n1;
        amount.assign(static_cast<std::size_t>(hands), 0.0);
        total = 0.0;
        std::fill(by_card, by_card + 52, 0.0);
        for (int hand = 0; hand < hands; ++hand)
        {
            if (pi[hand] == 0.0)
            {
                continue;
            }
            if (use_board && !hand_live(player, hand, turn, river))
            {
                continue;
            }
            const double piece = range_w[player][static_cast<std::size_t>(hand)] * pi[hand];
            if (piece == 0.0)
            {
                continue;
            }
            amount[static_cast<std::size_t>(hand)] = piece;
            total += piece;
            by_card[hole_a[player][static_cast<std::size_t>(hand)]] += piece;
            by_card[hole_b[player][static_cast<std::size_t>(hand)]] += piece;
        }
    }

    double blocked_reach(int hero, int hand, const double* by_card, const std::vector<double>& opp_amount) const
    {
        const int c0 = hole_a[hero][static_cast<std::size_t>(hand)];
        const int c1 = hole_b[hero][static_cast<std::size_t>(hand)];
        double blocked = by_card[c0] + by_card[c1];
        const int opp = 1 - hero;
        const int opp_hand = hand_of[opp][static_cast<std::size_t>(holdem::Range::combo_index(c0, c1))];
        if (opp_hand >= 0)
        {
            blocked -= opp_amount[static_cast<std::size_t>(opp_hand)];
        }
        return blocked;
    }

    // Opponents in the initial support who are removed by these public cards.
    // The pair adjustment matches registration, including an opponent combo
    // that holds both cards.
    int compatible_on(int player, int hand, int turn, int river) const
    {
        const Support& row = support[player][static_cast<std::size_t>(hand)];
        int blocked = 0;
        if (turn >= 0)
        {
            blocked += row.contain[turn];
        }
        if (river >= 0)
        {
            blocked += row.contain[river];
        }
        if (turn >= 0 && river >= 0)
        {
            const int pair = holdem::Range::combo_index(turn, river);
            if (hand_of[1 - player][static_cast<std::size_t>(pair)] >= 0)
            {
                --blocked;
            }
        }
        return row.compatible - blocked;
    }

    // Structural support ignores strategy. A hand that meets the board, or that
    // has no compatible opponent left on this board, has no history here.
    bool hand_supported(int player, int hand, int turn, int river) const
    {
        if (range_w[player][static_cast<std::size_t>(hand)] <= 0.0)
        {
            return false;
        }
        if (!hand_live(player, hand, turn, river))
        {
            return false;
        }
        return compatible_on(player, hand, turn, river) > 0;
    }

    // Same-pair condition: some legal pair on this board has positive reach on
    // at least one side. A positive-reach hand with no compatible partner does
    // not qualify. Chance probabilities are not renormalized over the cards
    // this keeps.
    bool card_reaches_pair(int turn, int river, const double* pi0, const double* pi1) const
    {
        for (int hand = 0; hand < n0; ++hand)
        {
            if (pi0[hand] > 0.0 && hand_supported(0, hand, turn, river))
            {
                return true;
            }
        }
        for (int hand = 0; hand < n1; ++hand)
        {
            if (pi1[hand] > 0.0 && hand_supported(1, hand, turn, river))
            {
                return true;
            }
        }
        return false;
    }

    void order_reach(int player, const std::vector<double>& amount, const std::vector<std::uint32_t>& ranks) const
    {
        const int hands = static_cast<int>(amount.size());
        order_buf.resize(static_cast<std::size_t>(hands));
        std::iota(order_buf.begin(), order_buf.end(), 0);
        std::sort(order_buf.begin(), order_buf.end(), [&](int left, int right)
        {
            const std::uint32_t left_rank = ranks[static_cast<std::size_t>(left)];
            const std::uint32_t right_rank = ranks[static_cast<std::size_t>(right)];
            if (left_rank != right_rank)
            {
                return left_rank < right_rank;
            }
            return left < right;
        });
        pos_buf.assign(static_cast<std::size_t>(hands), 0);
        prefix_buf.assign(static_cast<std::size_t>(hands + 1), 0.0);
        card_prefix_buf.assign(static_cast<std::size_t>(52 * (hands + 1)), 0.0);
        sorted_rank_buf.resize(static_cast<std::size_t>(hands));
        const int span = hands + 1;
        for (int index = 0; index < hands; ++index)
        {
            const int hand = order_buf[static_cast<std::size_t>(index)];
            pos_buf[static_cast<std::size_t>(hand)] = index;
            sorted_rank_buf[static_cast<std::size_t>(index)] = ranks[static_cast<std::size_t>(hand)];
            prefix_buf[static_cast<std::size_t>(index + 1)] =
                prefix_buf[static_cast<std::size_t>(index)] + amount[static_cast<std::size_t>(hand)];
            for (int card = 0; card < 52; ++card)
            {
                card_prefix_buf[static_cast<std::size_t>(card * span + index + 1)] =
                    card_prefix_buf[static_cast<std::size_t>(card * span + index)];
            }
            const double piece = amount[static_cast<std::size_t>(hand)];
            card_prefix_buf[static_cast<std::size_t>(
                hole_a[player][static_cast<std::size_t>(hand)] * span + index + 1)] += piece;
            card_prefix_buf[static_cast<std::size_t>(
                hole_b[player][static_cast<std::size_t>(hand)] * span + index + 1)] += piece;
        }
    }

    double slice_reach(int begin, int end, int c0, int c1, int add_hand, const std::vector<double>& amount) const
    {
        if (end <= begin)
        {
            return 0.0;
        }
        const int span = static_cast<int>(prefix_buf.size());
        double sum = prefix_buf[static_cast<std::size_t>(end)] - prefix_buf[static_cast<std::size_t>(begin)];
        sum -= card_prefix_buf[static_cast<std::size_t>(c0 * span + end)]
            - card_prefix_buf[static_cast<std::size_t>(c0 * span + begin)];
        sum -= card_prefix_buf[static_cast<std::size_t>(c1 * span + end)]
            - card_prefix_buf[static_cast<std::size_t>(c1 * span + begin)];
        if (add_hand >= 0)
        {
            const int pos = pos_buf[static_cast<std::size_t>(add_hand)];
            if (pos >= begin && pos < end)
            {
                sum += amount[static_cast<std::size_t>(add_hand)];
            }
        }
        return sum;
    }

    void showdown_side(
        int hero,
        int turn,
        int river,
        double win_pay,
        double lose_pay,
        const std::vector<double>& opp_amount,
        std::vector<double>& ev) const
    {
        const int opp = 1 - hero;
        const std::vector<std::uint32_t> hero_ranks = ranks_for(hero, turn, river);
        const std::vector<std::uint32_t> opp_ranks = ranks_for(opp, turn, river);
        order_reach(opp, opp_amount, opp_ranks);
        const int hero_hands = static_cast<int>(ev.size());
        const int opp_hands = static_cast<int>(opp_amount.size());
        for (int hand = 0; hand < hero_hands; ++hand)
        {
            if (!hand_live(hero, hand, turn, river))
            {
                ev[static_cast<std::size_t>(hand)] = 0.0;
                continue;
            }
            const std::uint32_t rank = hero_ranks[static_cast<std::size_t>(hand)];
            const int worse = static_cast<int>(std::lower_bound(
                sorted_rank_buf.begin(), sorted_rank_buf.begin() + opp_hands, rank)
                - sorted_rank_buf.begin());
            const int after_tie = static_cast<int>(std::upper_bound(
                sorted_rank_buf.begin(), sorted_rank_buf.begin() + opp_hands, rank)
                - sorted_rank_buf.begin());
            const int c0 = hole_a[hero][static_cast<std::size_t>(hand)];
            const int c1 = hole_b[hero][static_cast<std::size_t>(hand)];
            const int opp_hand = hand_of[opp][static_cast<std::size_t>(holdem::Range::combo_index(c0, c1))];
            const int add_hand = opp_hand >= 0 && opp_amount[static_cast<std::size_t>(opp_hand)] != 0.0
                ? opp_hand : -1;
            const double worse_mass = slice_reach(0, worse, c0, c1, add_hand, opp_amount);
            const double better_mass = slice_reach(after_tie, opp_hands, c0, c1, add_hand, opp_amount);
            const double low_pay = hero == 0 ? win_pay : lose_pay;
            const double high_pay = hero == 0 ? lose_pay : win_pay;
            ev[static_cast<std::size_t>(hand)] = range_w[hero][static_cast<std::size_t>(hand)] * joint_scale
                * (low_pay * worse_mass + high_pay * better_mass);
        }
    }

    void apply_terminal(
        const Node& node,
        int turn,
        int river,
        const double* pi0,
        const double* pi1,
        std::vector<double>& ev0,
        std::vector<double>& ev1) const
    {
        std::vector<double> amount0;
        std::vector<double> amount1;
        double total0 = 0.0;
        double total1 = 0.0;
        double by0[52];
        double by1[52];
        collect_reach(0, turn, river, pi0, true, amount0, total0, by0);
        collect_reach(1, turn, river, pi1, true, amount1, total1, by1);
        const double half = static_cast<double>(config.pot) * 0.5;
        if (node.folded >= 0)
        {
            const double pay = node.folded == 0
                ? -(half + static_cast<double>(node.contrib[0]))
                : half + static_cast<double>(node.contrib[1]);
            for (int hand = 0; hand < n0; ++hand)
            {
                if (!hand_live(0, hand, turn, river))
                {
                    ev0[static_cast<std::size_t>(hand)] = 0.0;
                    continue;
                }
                const double open = total1 - blocked_reach(0, hand, by1, amount1);
                ev0[static_cast<std::size_t>(hand)] =
                    pay * range_w[0][static_cast<std::size_t>(hand)] * joint_scale * open;
            }
            for (int hand = 0; hand < n1; ++hand)
            {
                if (!hand_live(1, hand, turn, river))
                {
                    ev1[static_cast<std::size_t>(hand)] = 0.0;
                    continue;
                }
                const double open = total0 - blocked_reach(1, hand, by0, amount0);
                ev1[static_cast<std::size_t>(hand)] =
                    pay * range_w[1][static_cast<std::size_t>(hand)] * joint_scale * open;
            }
            return;
        }
        const double win_pay = half + static_cast<double>(node.contrib[1]);
        const double lose_pay = -(half + static_cast<double>(node.contrib[0]));
        showdown_side(0, turn, river, win_pay, lose_pay, amount1, ev0);
        showdown_side(1, turn, river, win_pay, lose_pay, amount0, ev1);
    }

    void frozen_walk(int node_index, int turn, int river, int depth, int updating, double weight_iter)
    {
        if (depth + 1 >= static_cast<int>(scratch.size()))
        {
            throw std::logic_error("frozen street traversal ran out of scratch");
        }
        const Node& node = nodes[static_cast<std::size_t>(node_index)];
        Scratch& here = scratch[static_cast<std::size_t>(depth)];
        const double* pi0 = here.pi0.data();
        const double* pi1 = here.pi1.data();
        if (node.terminal)
        {
            apply_terminal(node, turn, river, pi0, pi1, here.ev0, here.ev1);
            return;
        }
        if (node.chance)
        {
            std::fill(here.ev0.begin(), here.ev0.end(), 0.0);
            std::fill(here.ev1.begin(), here.ev1.end(), 0.0);
            int denom = 52 - static_cast<int>(config.board.size()) - 4;
            std::uint64_t dead = board_mask;
            if (turn >= 0)
            {
                --denom;
                dead |= std::uint64_t{1} << turn;
            }
            if (river >= 0)
            {
                --denom;
                dead |= std::uint64_t{1} << river;
            }
            const double probability = 1.0 / static_cast<double>(denom);
            Scratch& child = scratch[static_cast<std::size_t>(depth + 1)];
            for (int card = 0; card < 52; ++card)
            {
                if (((dead >> card) & 1u) != 0)
                {
                    continue;
                }
                int next_turn = turn;
                int next_river = river;
                if (node.deal_which == 1)
                {
                    next_turn = card;
                }
                else
                {
                    next_river = card;
                }
                if (!card_reaches_pair(next_turn, next_river, pi0, pi1))
                {
                    continue;
                }
                for (int h0 = 0; h0 < n0; ++h0)
                {
                    child.pi0[static_cast<std::size_t>(h0)] = hand_supported(0, h0, next_turn, next_river)
                        ? pi0[h0] : 0.0;
                }
                for (int h1 = 0; h1 < n1; ++h1)
                {
                    child.pi1[static_cast<std::size_t>(h1)] = hand_supported(1, h1, next_turn, next_river)
                        ? pi1[h1] : 0.0;
                }
                frozen_walk(node.child[0], next_turn, next_river, depth + 1, updating, weight_iter);
                for (int h0 = 0; h0 < n0; ++h0)
                {
                    here.ev0[static_cast<std::size_t>(h0)] += probability * child.ev0[static_cast<std::size_t>(h0)];
                }
                for (int h1 = 0; h1 < n1; ++h1)
                {
                    here.ev1[static_cast<std::size_t>(h1)] += probability * child.ev1[static_cast<std::size_t>(h1)];
                }
            }
            return;
        }

        Scratch& child = scratch[static_cast<std::size_t>(depth + 1)];
        for (int action = 0; action < node.n_actions; ++action)
        {
            if (node.player == 0)
            {
                for (int h0 = 0; h0 < n0; ++h0)
                {
                    if (!hand_supported(0, h0, turn, river))
                    {
                        child.pi0[static_cast<std::size_t>(h0)] = 0.0;
                        continue;
                    }
                    const int index = slot_index(node, h0, turn, river, pi0[h0]);
                    const double* sigma = frozen_sigma.data() + slots[static_cast<std::size_t>(index)].base;
                    child.pi0[static_cast<std::size_t>(h0)] = pi0[h0] * sigma[action];
                }
                std::copy(pi1, pi1 + n1, child.pi1.begin());
            }
            else
            {
                std::copy(pi0, pi0 + n0, child.pi0.begin());
                for (int h1 = 0; h1 < n1; ++h1)
                {
                    if (!hand_supported(1, h1, turn, river))
                    {
                        child.pi1[static_cast<std::size_t>(h1)] = 0.0;
                        continue;
                    }
                    const int index = slot_index(node, h1, turn, river, pi1[h1]);
                    const double* sigma = frozen_sigma.data() + slots[static_cast<std::size_t>(index)].base;
                    child.pi1[static_cast<std::size_t>(h1)] = pi1[h1] * sigma[action];
                }
            }
            frozen_walk(node.child[action], turn, river, depth + 1, updating, weight_iter);
            std::copy(child.ev0.begin(), child.ev0.end(), here.aev0.begin() + static_cast<std::size_t>(action * n0));
            std::copy(child.ev1.begin(), child.ev1.end(), here.aev1.begin() + static_cast<std::size_t>(action * n1));
        }

        for (int h0 = 0; h0 < n0; ++h0)
        {
            if (!hand_supported(0, h0, turn, river))
            {
                here.ev0[static_cast<std::size_t>(h0)] = 0.0;
                continue;
            }
            double mix = 0.0;
            if (node.player == 0)
            {
                const int index = slot_index(node, h0, turn, river, pi0[h0]);
                const int base = slots[static_cast<std::size_t>(index)].base;
                const double* sigma = frozen_sigma.data() + base;
                for (int action = 0; action < node.n_actions; ++action)
                {
                    mix += sigma[action] * here.aev0[static_cast<std::size_t>(action * n0 + h0)];
                }
                here.ev0[static_cast<std::size_t>(h0)] = mix;
                if (updating < 0 || updating == 0)
                {
                    accumulate_average(
                        strategy_sum.data() + base, sigma, node.n_actions, weight_iter * pi0[h0]);
                    for (int action = 0; action < node.n_actions; ++action)
                    {
                        regret[static_cast<std::size_t>(base + action)] +=
                            here.aev0[static_cast<std::size_t>(action * n0 + h0)] - mix;
                    }
                }
            }
            else
            {
                for (int action = 0; action < node.n_actions; ++action)
                {
                    mix += here.aev0[static_cast<std::size_t>(action * n0 + h0)];
                }
                here.ev0[static_cast<std::size_t>(h0)] = mix;
            }
        }
        for (int h1 = 0; h1 < n1; ++h1)
        {
            if (!hand_supported(1, h1, turn, river))
            {
                here.ev1[static_cast<std::size_t>(h1)] = 0.0;
                continue;
            }
            double mix = 0.0;
            if (node.player == 1)
            {
                const int index = slot_index(node, h1, turn, river, pi1[h1]);
                const int base = slots[static_cast<std::size_t>(index)].base;
                const double* sigma = frozen_sigma.data() + base;
                for (int action = 0; action < node.n_actions; ++action)
                {
                    mix += sigma[action] * here.aev1[static_cast<std::size_t>(action * n1 + h1)];
                }
                here.ev1[static_cast<std::size_t>(h1)] = mix;
                if (updating < 0 || updating == 1)
                {
                    accumulate_average(
                        strategy_sum.data() + base, sigma, node.n_actions, weight_iter * pi1[h1]);
                    for (int action = 0; action < node.n_actions; ++action)
                    {
                        regret[static_cast<std::size_t>(base + action)] +=
                            mix - here.aev1[static_cast<std::size_t>(action * n1 + h1)];
                    }
                }
            }
            else
            {
                for (int action = 0; action < node.n_actions; ++action)
                {
                    mix += here.aev1[static_cast<std::size_t>(action * n1 + h1)];
                }
                here.ev1[static_cast<std::size_t>(h1)] = mix;
            }
        }
    }

    void freeze_sigma()
    {
        for (const Slot& slot : slots)
        {
            regret_matching(
                regret.data() + slot.base,
                frozen_sigma.data() + slot.base,
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

    void frozen_pass(int updating, double weight_iter, Algorithm algorithm)
    {
        freeze_sigma();
        std::fill(scratch[0].pi0.begin(), scratch[0].pi0.end(), 1.0);
        std::fill(scratch[0].pi1.begin(), scratch[0].pi1.end(), 1.0);
        frozen_walk(0, -1, -1, 0, updating, weight_iter);
        if (algorithm == Algorithm::CfrPlus)
        {
            floor_player(updating);
        }
    }

    void train_frozen(int count, Algorithm algorithm)
    {
        if (algorithm != Algorithm::VanillaCfr && algorithm != Algorithm::CfrPlus)
        {
            throw std::invalid_argument("the frozen street pass implements vanilla CFR and CFR+");
        }
        average_ready = false;
        for (int step = 0; step < count; ++step)
        {
            ++trained;
            if (algorithm == Algorithm::VanillaCfr)
            {
                frozen_pass(-1, 1.0, algorithm);
            }
            else
            {
                const double weight_iter = static_cast<double>(trained);
                frozen_pass(0, weight_iter, algorithm);
                frozen_pass(1, weight_iter, algorithm);
            }
        }
    }

    bool assign_labeled_regret(const std::string& infoset, const std::string& action, double value)
    {
        for (const Slot& slot : slots)
        {
            if (slot_label(slot) != infoset)
            {
                continue;
            }
            const Node& node = nodes[static_cast<std::size_t>(slot.node)];
            for (int index = 0; index < slot.n_actions; ++index)
            {
                if (node.action_labels[index] != action)
                {
                    continue;
                }
                regret[static_cast<std::size_t>(slot.base + index)] = value;
                average_ready = false;
                return true;
            }
        }
        return false;
    }

    bool read_labeled_regret(const std::string& infoset, const std::string& action, double& value) const
    {
        for (const Slot& slot : slots)
        {
            if (slot_label(slot) != infoset)
            {
                continue;
            }
            const Node& node = nodes[static_cast<std::size_t>(slot.node)];
            for (int index = 0; index < slot.n_actions; ++index)
            {
                if (node.action_labels[index] != action)
                {
                    continue;
                }
                value = regret[static_cast<std::size_t>(slot.base + index)];
                return true;
            }
        }
        return false;
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

void StreetBatchSolver::run_frozen_iterations(int count, Algorithm algorithm)
{
    engine_->reset();
    engine_->train_frozen(count, algorithm);
}

void StreetBatchSolver::continue_frozen_iterations(int count, Algorithm algorithm)
{
    engine_->train_frozen(count, algorithm);
}

SolveStats StreetBatchSolver::solve_frozen(const SolveConfig& config, Algorithm algorithm)
{
    const auto start = std::chrono::steady_clock::now();
    engine_->reset();
    int completed = 0;
    SolveStats stats;
    bool fresh = false;
    for (int step = 0; step < config.max_iterations; ++step)
    {
        engine_->train_frozen(1, algorithm);
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

bool StreetBatchSolver::set_regret(const std::string& infoset, const std::string& action, double value)
{
    return engine_->assign_labeled_regret(infoset, action, value);
}

bool StreetBatchSolver::regret_value(const std::string& infoset, const std::string& action, double& value) const
{
    return engine_->read_labeled_regret(infoset, action, value);
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
            entry.infoset = engine_->slot_label(slot);
            entry.action = node.action_labels[action];
            entry.probability = engine_->average[static_cast<std::size_t>(slot.base + action)];
            entries.push_back(std::move(entry));
        }
    }
    return entries;
}

} // namespace poker::solver
