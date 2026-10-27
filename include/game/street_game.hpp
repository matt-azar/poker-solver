#pragma once

#include "poker/card.hpp"
#include "poker/hand_eval.hpp"
#include "poker/range.hpp"

#include <cmath>
#include <cstdint>
#include <span>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace poker::streets
{

inline constexpr int kMaxStreetActions = 8;
inline constexpr int kMaxStreetHistory = 24;

// Heads-up flop (3-card board) or turn (4-card board) with the same
// pot-fraction bets on every street. The river is dealt inside the tree.
// Information sets store the acting player's hand and the cards already dealt.
// They do not store the opponent's hand or a card that has not been dealt.
struct StreetConfig
{
    std::vector<int> board;
    int pot = 100;
    int stack = 200;
    holdem::Range oop{};
    holdem::Range ip{};
    std::vector<double> oop_bet_sizes{};
    std::vector<double> ip_bet_sizes{};
    std::vector<double> oop_raise_sizes{};
    std::vector<double> ip_raise_sizes{};
    bool allow_all_in = true;
    int max_raises = 1;
    int first_to_act = 0;
};

class StreetGame
{
public:
    struct State
    {
        int pair_index = -1;
        int turn_card = -1;
        int river_card = -1;
        int street = 0;
        int contrib[2] = {};
        int pot = 0;
        int committed = 0;
        int last_raise = 0;
        int num_raises = 0;
        int acting = -1;
        int folded = -1;
        int n_hist = 0;
        int hist[kMaxStreetHistory] = {};
        int chance_kind = 0;
        bool terminal = false;
        bool pending_check = false;
    };

    explicit StreetGame(StreetConfig config)
        : config_(std::move(config))
    {
        validate_config();
        build_deals();
        index(root(), "");
    }

    int infoset_count() const
    {
        return static_cast<int>(infosets_.size());
    }

    int deal_count() const
    {
        return static_cast<int>(deals_.size());
    }

    int decision_node_count() const
    {
        return decision_nodes_;
    }

    int terminal_count() const
    {
        return terminals_;
    }

    int board_count() const
    {
        return static_cast<int>(config_.board.size());
    }

    State root() const
    {
        State state;
        state.chance_kind = 1;
        state.pot = config_.pot;
        return state;
    }

    bool is_chance(const State& state) const
    {
        return state.chance_kind != 0;
    }

    bool is_terminal(const State& state) const
    {
        return state.terminal;
    }

    double p1_utility(const State& state) const
    {
        if (!state.terminal)
        {
            throw std::logic_error("p1_utility on a non-terminal street state");
        }
        const double half_pot = static_cast<double>(config_.pot) * 0.5;
        if (state.folded == 0)
        {
            return -(half_pot + static_cast<double>(state.contrib[0]));
        }
        if (state.folded == 1)
        {
            return half_pot + static_cast<double>(state.contrib[1]);
        }
        if (state.contrib[0] != state.contrib[1])
        {
            throw std::logic_error("showdown with unequal street contributions");
        }
        const int outcome = showdown_outcome(state);
        if (outcome > 0)
        {
            return half_pot + static_cast<double>(state.contrib[1]);
        }
        if (outcome < 0)
        {
            return -(half_pot + static_cast<double>(state.contrib[0]));
        }
        return 0.0;
    }

    int chance_count(const State& state) const
    {
        if (state.chance_kind == 1)
        {
            return deal_count();
        }
        if (state.chance_kind == 2 || state.chance_kind == 3)
        {
            int cards[52];
            return remaining_cards(state, cards);
        }
        return 0;
    }

    double chance_probability(const State& state, int outcome) const
    {
        if (state.chance_kind == 1)
        {
            return deals_.at(static_cast<std::size_t>(outcome)).probability;
        }
        const int count = chance_count(state);
        if (outcome < 0 || outcome >= count || count == 0)
        {
            throw std::logic_error("street chance outcome is out of range");
        }
        return 1.0 / static_cast<double>(count);
    }

    State child_chance(const State& state, int outcome) const
    {
        if (state.chance_kind == 1)
        {
            if (outcome < 0 || outcome >= deal_count())
            {
                throw std::logic_error("hand deal is out of range");
            }
            State next;
            next.pair_index = outcome;
            next.pot = config_.pot;
            next.acting = config_.first_to_act;
            next.street = 0;
            return next;
        }
        if (state.chance_kind != 2 && state.chance_kind != 3)
        {
            throw std::logic_error("child_chance on a street decision");
        }
        int cards[52];
        const int count = remaining_cards(state, cards);
        if (outcome < 0 || outcome >= count)
        {
            throw std::logic_error("runout card is out of range");
        }
        State next = state;
        next.chance_kind = 0;
        next.acting = config_.first_to_act;
        next.pending_check = false;
        next.last_raise = 0;
        next.num_raises = 0;
        next.committed = next.contrib[0];
        next.street = state.street + 1;
        if (state.chance_kind == 2)
        {
            next.turn_card = cards[outcome];
        }
        else
        {
            next.river_card = cards[outcome];
        }
        return next;
    }

    int infoset(const State& state) const
    {
        if (is_chance(state) || state.terminal)
        {
            throw std::logic_error("infoset on a street chance or terminal node");
        }
        const auto found = ids_.find(pack(state));
        if (found == ids_.end())
        {
            throw std::logic_error("street information set was not indexed");
        }
        return found->second;
    }

    int acting_player(int infoset) const
    {
        return infosets_.at(static_cast<std::size_t>(infoset)).player;
    }

    int action_count(int infoset) const
    {
        return infosets_.at(static_cast<std::size_t>(infoset)).action_count;
    }

    State child_action(const State& state, int local_action) const
    {
        const Legal legal = legal_actions(state);
        if (local_action < 0 || local_action >= legal.count)
        {
            throw std::logic_error("street action out of range");
        }
        return apply(state, legal, local_action);
    }

    std::string infoset_label(int infoset) const
    {
        return infosets_.at(static_cast<std::size_t>(infoset)).label;
    }

    std::string action_label(int infoset, int local_action) const
    {
        const Infoset& info = infosets_.at(static_cast<std::size_t>(infoset));
        if (local_action < 0 || local_action >= info.action_count)
        {
            throw std::logic_error("action_label out of range");
        }
        return info.labels[static_cast<std::size_t>(local_action)];
    }

private:
    struct Deal
    {
        int combo0 = 0;
        int combo1 = 0;
        double probability = 0.0;
        int c0 = 0;
        int c1 = 0;
        int d0 = 0;
        int d1 = 0;
    };

    struct Legal
    {
        int count = 0;
        int code[kMaxStreetActions] = {};
        int add[kMaxStreetActions] = {};
    };

    struct Infoset
    {
        int player = 0;
        int action_count = 0;
        std::string labels[kMaxStreetActions];
        std::string label;
    };

    struct Key
    {
        int combo = 0;
        int player = 0;
        int turn_card = -1;
        int river_card = -1;
        int n_hist = 0;
        int hist[kMaxStreetHistory] = {};

        bool operator==(const Key& other) const
        {
            if (combo != other.combo || player != other.player || turn_card != other.turn_card
                || river_card != other.river_card || n_hist != other.n_hist)
            {
                return false;
            }
            for (int i = 0; i < n_hist; ++i)
            {
                if (hist[i] != other.hist[i])
                {
                    return false;
                }
            }
            return true;
        }
    };

    struct KeyHash
    {
        std::size_t operator()(const Key& key) const
        {
            std::size_t hash = static_cast<std::size_t>(key.combo + 1);
            hash = hash * 1315423911u + static_cast<std::size_t>(key.player);
            hash = hash * 1315423911u + static_cast<std::size_t>(key.turn_card + 2);
            hash = hash * 1315423911u + static_cast<std::size_t>(key.river_card + 2);
            for (int i = 0; i < key.n_hist; ++i)
            {
                hash = hash * 1315423911u + static_cast<std::size_t>(key.hist[i] + 1);
            }
            return hash;
        }
    };

    int betting_streets() const
    {
        return static_cast<int>(config_.board.size()) == 3 ? 3 : 2;
    }

    static int round_chips(double fraction, int basis)
    {
        return static_cast<int>(std::llround(fraction * static_cast<double>(basis)));
    }

    void validate_config() const
    {
        if (config_.board.size() != 3 && config_.board.size() != 4)
        {
            throw std::invalid_argument("street solver board must have 3 or 4 cards");
        }
        holdem::validate_board(config_.board.data(), static_cast<int>(config_.board.size()));
        if (config_.pot <= 0)
        {
            throw std::invalid_argument("pot must be positive");
        }
        if (config_.stack < 0)
        {
            throw std::invalid_argument("stack must be nonnegative");
        }
        if (config_.first_to_act != 0 && config_.first_to_act != 1)
        {
            throw std::invalid_argument("first player must be 0 (OOP) or 1 (IP)");
        }
        if (config_.max_raises < 0 || config_.max_raises > 6)
        {
            throw std::invalid_argument("max raises must be from 0 through 6");
        }
    }

    void build_deals()
    {
        const std::vector<holdem::HandPairProbability> rows = holdem::joint_distribution(
            config_.oop, config_.ip, config_.board.data(), static_cast<int>(config_.board.size()));
        if (rows.empty())
        {
            throw std::invalid_argument("ranges leave no legal hand pair");
        }
        deals_.reserve(rows.size());
        for (const holdem::HandPairProbability& row : rows)
        {
            Deal deal;
            deal.combo0 = row.combo0;
            deal.combo1 = row.combo1;
            deal.probability = row.probability;
            holdem::Range::combo_cards(row.combo0, deal.c0, deal.c1);
            holdem::Range::combo_cards(row.combo1, deal.d0, deal.d1);
            deals_.push_back(deal);
        }
    }

    int remaining_cards(const State& state, int* out) const
    {
        bool dead[52] = {};
        for (int card : config_.board)
        {
            dead[card] = true;
        }
        const Deal& deal = deals_.at(static_cast<std::size_t>(state.pair_index));
        dead[deal.c0] = true;
        dead[deal.c1] = true;
        dead[deal.d0] = true;
        dead[deal.d1] = true;
        if (state.turn_card >= 0)
        {
            dead[state.turn_card] = true;
        }
        if (state.river_card >= 0)
        {
            dead[state.river_card] = true;
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

    int showdown_outcome(const State& state) const
    {
        int board[5];
        int count = 0;
        for (int card : config_.board)
        {
            board[count++] = card;
        }
        if (state.turn_card >= 0)
        {
            board[count++] = state.turn_card;
        }
        if (state.river_card >= 0)
        {
            board[count++] = state.river_card;
        }
        if (count != 5)
        {
            throw std::logic_error("showdown without five board cards");
        }
        const Deal& deal = deals_.at(static_cast<std::size_t>(state.pair_index));
        return holdem::compare_showdown(deal.c0, deal.c1, deal.d0, deal.d1, std::span<const int>(board, 5));
    }

    const std::vector<double>& size_list(int player, bool facing) const
    {
        if (player == 0)
        {
            return facing ? config_.oop_raise_sizes : config_.oop_bet_sizes;
        }
        return facing ? config_.ip_raise_sizes : config_.ip_bet_sizes;
    }

    static std::string chip_label(int code, int add, int street_total, bool all_in, bool facing)
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

    Legal legal_actions(const State& state) const
    {
        if (is_chance(state) || state.terminal)
        {
            throw std::logic_error("legal actions off a street decision");
        }
        const int player = state.acting;
        const int to_call = state.committed - state.contrib[player];
        const bool facing = to_call > 0;
        const int max_add = config_.stack - state.contrib[player];
        if (to_call < 0 || max_add < 0)
        {
            throw std::logic_error("street stack accounting failed");
        }

        int amounts[kMaxStreetActions] = {};
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
            if (config_.max_raises <= state.num_raises || add < 1)
            {
                return;
            }
            if (add > max_add)
            {
                if (!config_.allow_all_in)
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
            const bool shove = state.contrib[player] + add == config_.stack;
            if (!full && !(config_.allow_all_in && shove))
            {
                return;
            }
            push_amount(add);
        };

        const int basis = facing ? state.pot + to_call : state.pot;
        for (double fraction : size_list(player, facing))
        {
            const int sized = round_chips(fraction, basis);
            consider(facing ? to_call + sized : sized);
        }
        if (config_.allow_all_in)
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
            if (legal.count >= kMaxStreetActions)
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

    void finish_street(State& state) const
    {
        state.pending_check = false;
        state.acting = -1;
        if (state.street + 1 < betting_streets())
        {
            const bool flop_tree = config_.board.size() == 3;
            state.chance_kind = (flop_tree && state.street == 0) ? 2 : 3;
            return;
        }
        state.terminal = true;
    }

    State apply(const State& state, const Legal& legal, int local_action) const
    {
        if (state.n_hist >= kMaxStreetHistory)
        {
            throw std::logic_error("street history overflow");
        }
        State next = state;
        next.hist[next.n_hist++] = local_action;
        const int player = state.acting;
        const int code = legal.code[local_action];
        const int add = legal.add[local_action];
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
                finish_street(next);
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
        return next;
    }

    Key pack(const State& state) const
    {
        Key key;
        const Deal& deal = deals_.at(static_cast<std::size_t>(state.pair_index));
        key.combo = state.acting == 0 ? deal.combo0 : deal.combo1;
        key.player = state.acting;
        key.turn_card = state.turn_card;
        key.river_card = state.river_card;
        key.n_hist = state.n_hist;
        for (int i = 0; i < state.n_hist; ++i)
        {
            key.hist[i] = state.hist[i];
        }
        return key;
    }

    std::string place_text(const State& state) const
    {
        if (config_.board.size() == 4)
        {
            if (state.street == 0)
            {
                return "turn";
            }
            return "river " + holdem::format_card(state.river_card);
        }
        if (state.street == 0)
        {
            return "flop";
        }
        if (state.street == 1)
        {
            return "turn " + holdem::format_card(state.turn_card);
        }
        return "turn " + holdem::format_card(state.turn_card)
            + " river " + holdem::format_card(state.river_card);
    }

    void ensure_infoset(const State& state, const Legal& legal, const std::string& path)
    {
        const Key key = pack(state);
        if (ids_.find(key) != ids_.end())
        {
            return;
        }
        Infoset info;
        info.player = state.acting;
        info.action_count = legal.count;
        const bool facing = state.committed > state.contrib[state.acting];
        for (int i = 0; i < legal.count; ++i)
        {
            const int street_total = state.contrib[state.acting] + legal.add[i];
            const bool all_in = legal.code[i] != 0 && street_total == config_.stack && legal.add[i] > 0;
            info.labels[static_cast<std::size_t>(i)] = chip_label(
                legal.code[i], legal.add[i], street_total, all_in, facing);
        }
        const Deal& deal = deals_.at(static_cast<std::size_t>(state.pair_index));
        const int combo = state.acting == 0 ? deal.combo0 : deal.combo1;
        info.label = state.acting == 0 ? "OOP " : "IP ";
        info.label += holdem::Range::combo_text(combo);
        info.label += " | ";
        info.label += place_text(state);
        info.label += " | ";
        info.label += path.empty() ? "open" : path;
        const int id = static_cast<int>(infosets_.size());
        ids_.emplace(key, id);
        infosets_.push_back(std::move(info));
    }

    void index(const State& state, const std::string& path)
    {
        if (state.terminal)
        {
            ++terminals_;
            if (terminals_ > 200000)
            {
                throw std::invalid_argument(
                    "street tree has more than 200000 terminals; use smaller ranges");
            }
            return;
        }
        if (is_chance(state))
        {
            const int count = chance_count(state);
            for (int outcome = 0; outcome < count; ++outcome)
            {
                index(child_chance(state, outcome), path);
            }
            return;
        }
        ++decision_nodes_;
        const Legal legal = legal_actions(state);
        ensure_infoset(state, legal, path);
        for (int action = 0; action < legal.count; ++action)
        {
            const int street_total = state.contrib[state.acting] + legal.add[action];
            const bool all_in = legal.code[action] != 0 && street_total == config_.stack && legal.add[action] > 0;
            const std::string action_text = chip_label(
                legal.code[action], legal.add[action], street_total, all_in,
                state.committed > state.contrib[state.acting]);
            const std::string next_path = path.empty() ? action_text : path + "/" + action_text;
            index(apply(state, legal, action), next_path);
        }
    }

    StreetConfig config_;
    std::vector<Deal> deals_;
    std::unordered_map<Key, int, KeyHash> ids_;
    std::vector<Infoset> infosets_;
    int decision_nodes_ = 0;
    int terminals_ = 0;
};

} // namespace poker::streets
