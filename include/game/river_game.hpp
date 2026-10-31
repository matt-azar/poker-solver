#pragma once

#include "poker/card.hpp"
#include "poker/hand_eval.hpp"
#include "poker/range.hpp"
#include "solver/chip_payoff.hpp"
#include "solver/payoff.hpp"

#include <array>
#include <cmath>
#include <cstdint>
#include <span>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace poker::river
{

// Heads-up no-limit river. The board is fixed. Chance deals one ordered pair of
// private hands from the joint range distribution in docs/HOLDEM.md.
//
// Player 0 is out of position. Player 1 is in position. Utilities are player 0's
// net chips from the start of the river. The existing pot was contributed equally,
// so a showdown win is worth pot/2 plus the opponent's river investment. Uncalled
// chips are not profit: a fold refunds them through that same formula.
//
// An opening size f bets round(f * pot) chips. A raise size f raises by
// round(f * pot_after_the_call) chips, where pot_after_the_call is the pot once
// the facing bet has been called. Ties in rounding go away from zero. A listed
// size larger than the stack is an all-in when all-ins are allowed, and is
// omitted otherwise. Equal chip amounts are one action.
//
// The minimum opening bet is 1 chip. Later raises must increase the commitment
// by at least the previous full bet or raise. Heads-up equal stacks cannot raise
// an opponent who is already all-in. Both players start this street with the
// same stack behind.

inline constexpr int kMaxRiverActions = 8;
inline constexpr int kMaxHistory = 12;

struct RiverConfig
{
    std::array<int, 5> board{};
    int pot = 100;
    int stack = 200;
    holdem::Range oop{};
    holdem::Range ip{};
    std::vector<double> oop_bet_sizes{};
    std::vector<double> ip_bet_sizes{};
    std::vector<double> oop_raise_sizes{};
    std::vector<double> ip_raise_sizes{};
    bool allow_all_in = true;
    int max_raises = 2;
    int first_to_act = 0;
    // Pot rake applied at terminals. Zero rate keeps the prior chip rule.
    // See docs/RAKE.md.
    poker::solver::RakeConfig rake{};
};

class RiverGame
{
public:
    struct State
    {
        int pair_index = -1;
        int contrib[2] = {};
        int pot = 0;
        int committed = 0;
        int last_raise = 0;
        int num_raises = 0;
        int acting = -1;
        int folded = -1;
        int n_hist = 0;
        int hist[kMaxHistory] = {};
        bool chance = false;
        bool terminal = false;
        bool pending_check = false;
    };

    explicit RiverGame(RiverConfig config)
        : config_(std::move(config))
    {
        validate_config();
        build_deals();
        index(root());
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

    void deal_combos(int index, int& combo0, int& combo1) const
    {
        const Deal& deal = deals_.at(static_cast<std::size_t>(index));
        combo0 = deal.combo0;
        combo1 = deal.combo1;
    }

    double deal_probability(int index) const
    {
        return deals_.at(static_cast<std::size_t>(index)).probability;
    }

    const RiverConfig& config() const
    {
        return config_;
    }

    State root() const
    {
        State state;
        state.chance = true;
        state.pot = config_.pot;
        state.acting = -1;
        return state;
    }

    bool is_chance(const State& state) const
    {
        return state.chance && !state.terminal;
    }

    bool is_terminal(const State& state) const
    {
        return state.terminal;
    }

    // Both players' root-centered chip utilities. With zero rake, player 1 is
    // the negation of player 0 (see ChipPayoff). Positive rake uses config_.rake.
    poker::solver::PlayerPayoff terminal_payoff(const State& state) const
    {
        if (!state.terminal)
        {
            throw std::logic_error("terminal_payoff on a non-terminal river state");
        }
        const int showdown = state.folded < 0
            ? deals_.at(static_cast<std::size_t>(state.pair_index)).showdown
            : 0;
        return poker::solver::ChipPayoff::terminal(
            config_.pot,
            state.contrib[0],
            state.contrib[1],
            state.folded,
            showdown,
            config_.rake);
    }

    double p1_utility(const State& state) const
    {
        if (!state.terminal)
        {
            throw std::logic_error("p1_utility on a non-terminal river state");
        }
        return terminal_payoff(state).utility[0];
    }

    int chance_count(const State& state) const
    {
        if (!is_chance(state))
        {
            return 0;
        }
        return deal_count();
    }

    double chance_probability(const State& state, int outcome) const
    {
        if (!is_chance(state))
        {
            throw std::logic_error("chance_probability off a chance node");
        }
        return deal_probability(outcome);
    }

    State child_chance(const State& state, int outcome) const
    {
        if (!is_chance(state))
        {
            throw std::logic_error("child_chance on a non-chance state");
        }
        if (outcome < 0 || outcome >= deal_count())
        {
            throw std::logic_error("river deal index out of range");
        }
        State next;
        next.pair_index = outcome;
        next.pot = config_.pot;
        next.acting = config_.first_to_act;
        next.chance = false;
        return next;
    }

    int infoset(const State& state) const
    {
        if (is_chance(state) || state.terminal)
        {
            throw std::logic_error("infoset requested off a river decision");
        }
        const auto found = ids_.find(pack(state));
        if (found == ids_.end())
        {
            throw std::logic_error("river decision was not indexed");
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
            throw std::logic_error("river action out of range");
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
        int showdown = 0;
    };

    struct Legal
    {
        int count = 0;
        int code[kMaxRiverActions] = {};
        int add[kMaxRiverActions] = {};
    };

    struct Infoset
    {
        int player = 0;
        int action_count = 0;
        std::string labels[kMaxRiverActions];
        std::string label;
    };

    static int round_chips(double fraction, int basis)
    {
        if (basis < 0)
        {
            throw std::logic_error("negative sizing basis");
        }
        return static_cast<int>(std::llround(fraction * static_cast<double>(basis)));
    }

    void validate_config() const
    {
        holdem::validate_board(config_.board.data(), 5);
        if (config_.pot <= 0)
        {
            throw std::invalid_argument("river pot must be positive");
        }
        if (config_.stack < 0)
        {
            throw std::invalid_argument("river stack must be nonnegative");
        }
        if (config_.first_to_act != 0 && config_.first_to_act != 1)
        {
            throw std::invalid_argument("first player must be 0 (OOP) or 1 (IP)");
        }
        if (config_.max_raises < 0 || config_.max_raises > 6)
        {
            throw std::invalid_argument("max raises must be from 0 through 6");
        }
        const std::vector<double>* lists[] = {
            &config_.oop_bet_sizes,
            &config_.ip_bet_sizes,
            &config_.oop_raise_sizes,
            &config_.ip_raise_sizes};
        for (const std::vector<double>* list : lists)
        {
            for (double size : *list)
            {
                if (!std::isfinite(size) || size < 0.0)
                {
                    throw std::invalid_argument("bet sizes must be nonnegative");
                }
            }
        }
        config_.rake.validate();
    }

    void build_deals()
    {
        const std::vector<holdem::HandPairProbability> rows = holdem::joint_distribution(
            config_.oop, config_.ip, config_.board.data(), 5);
        if (rows.empty())
        {
            throw std::invalid_argument("ranges leave no legal river hand pair");
        }
        const std::span<const int> board(config_.board.data(), config_.board.size());
        deals_.reserve(rows.size());
        for (const holdem::HandPairProbability& row : rows)
        {
            int oop0 = 0;
            int oop1 = 0;
            int ip0 = 0;
            int ip1 = 0;
            holdem::Range::combo_cards(row.combo0, oop0, oop1);
            holdem::Range::combo_cards(row.combo1, ip0, ip1);
            Deal deal;
            deal.combo0 = row.combo0;
            deal.combo1 = row.combo1;
            deal.probability = row.probability;
            deal.showdown = holdem::compare_showdown(oop0, oop1, ip0, ip1, board);
            deals_.push_back(deal);
        }
    }

    int own_combo(const State& state) const
    {
        const Deal& deal = deals_.at(static_cast<std::size_t>(state.pair_index));
        return state.acting == 0 ? deal.combo0 : deal.combo1;
    }

    std::uint64_t pack(const State& state) const
    {
        if (state.n_hist < 0 || state.n_hist > kMaxHistory)
        {
            throw std::logic_error("river history length is invalid");
        }
        std::uint64_t key = static_cast<std::uint64_t>(own_combo(state));
        key |= static_cast<std::uint64_t>(state.acting) << 11;
        key |= static_cast<std::uint64_t>(state.n_hist) << 12;
        for (int i = 0; i < state.n_hist; ++i)
        {
            key |= static_cast<std::uint64_t>(state.hist[i] & 7) << (16 + 3 * i);
        }
        return key;
    }

    const std::vector<double>& size_list(int player, bool facing) const
    {
        if (player == 0)
        {
            return facing ? config_.oop_raise_sizes : config_.oop_bet_sizes;
        }
        return facing ? config_.ip_raise_sizes : config_.ip_bet_sizes;
    }

    Legal legal_actions(const State& state) const
    {
        if (is_chance(state) || state.terminal)
        {
            throw std::logic_error("legal actions off a river decision");
        }
        const int player = state.acting;
        const int to_call = state.committed - state.contrib[player];
        const bool facing = to_call > 0;
        const int max_add = config_.stack - state.contrib[player];
        if (to_call < 0 || max_add < 0)
        {
            throw std::logic_error("river stack accounting failed");
        }

        int amounts[kMaxRiverActions] = {};
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
            if (legal.count >= kMaxRiverActions)
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

    State apply(const State& state, const Legal& legal, int local_action) const
    {
        if (state.n_hist >= kMaxHistory)
        {
            throw std::logic_error("river history overflow");
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
        if (next.contrib[player] > config_.stack || next.pot != config_.pot + next.contrib[0] + next.contrib[1])
        {
            throw std::logic_error("river pot accounting failed");
        }

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

        if (code != 2)
        {
            throw std::logic_error("unknown river action");
        }
        const int raise_by = add - to_call;
        if (raise_by <= 0)
        {
            throw std::logic_error("aggressive action did not raise");
        }
        next.pending_check = false;
        next.last_raise = raise_by;
        next.committed = next.contrib[player];
        next.num_raises += 1;
        next.acting = 1 - player;
        return next;
    }

    void ensure_infoset(const State& state, const Legal& legal, const std::string& path)
    {
        const std::uint64_t key = pack(state);
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
        info.label += path.empty() ? "open" : path;
        const int id = static_cast<int>(infosets_.size());
        ids_.emplace(key, id);
        infosets_.push_back(std::move(info));
    }

    void index(const State& state, const std::string& path = {})
    {
        if (state.terminal)
        {
            ++terminals_;
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
            const std::string next_path = path.empty()
                ? chip_label(
                    legal.code[action],
                    legal.add[action],
                    state.contrib[state.acting] + legal.add[action],
                    legal.code[action] != 0
                        && state.contrib[state.acting] + legal.add[action] == config_.stack
                        && legal.add[action] > 0,
                    state.committed > state.contrib[state.acting])
                : path + "/" + chip_label(
                    legal.code[action],
                    legal.add[action],
                    state.contrib[state.acting] + legal.add[action],
                    legal.code[action] != 0
                        && state.contrib[state.acting] + legal.add[action] == config_.stack
                        && legal.add[action] > 0,
                    state.committed > state.contrib[state.acting]);
            index(apply(state, legal, action), next_path);
        }
    }

    RiverConfig config_;
    std::vector<Deal> deals_;
    std::unordered_map<std::uint64_t, int> ids_;
    std::vector<Infoset> infosets_;
    int decision_nodes_ = 0;
    int terminals_ = 0;
};

} // namespace poker::river
