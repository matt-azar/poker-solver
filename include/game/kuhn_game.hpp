#pragma once

#include "game/kuhn.hpp"

#include <array>
#include <string>

namespace poker::kuhn
{

// Kuhn Poker as an extensive game: chance deals, then player nodes, then terminals.
// Information sets are (acting player, that player's private card, public sequence).
class KuhnGame
{
public:
    static constexpr int kNumPlayers = 2;

    struct State
    {
        bool at_chance = true;
        Deal deal{};
        Sequence sequence = Sequence::Empty;
    };

    KuhnGame()
        : deals_(all_deals())
    {
    }

    int infoset_count() const
    {
        return kNumInfosets;
    }

    State root() const
    {
        return State{};
    }

    bool is_chance(const State& state) const
    {
        return state.at_chance;
    }

    bool is_terminal(const State& state) const
    {
        return !state.at_chance && poker::kuhn::is_terminal(state.sequence);
    }

    double p1_utility(const State& state) const
    {
        return poker::kuhn::p1_utility(state.deal, state.sequence);
    }

    int chance_count(const State& state) const
    {
        return state.at_chance ? kNumDeals : 0;
    }

    double chance_probability(const State&, int) const
    {
        return kDealProbability;
    }

    State child_chance(const State&, int outcome) const
    {
        State next;
        next.at_chance = false;
        next.deal = deals_[static_cast<std::size_t>(outcome)];
        next.sequence = Sequence::Empty;
        return next;
    }

    int infoset(const State& state) const
    {
        const Player player = player_to_act(state.sequence);
        const Card card = private_card(state.deal, player);
        return infoset_id(player, card, state.sequence);
    }

    int acting_player(int infoset) const
    {
        return static_cast<int>(infoset_player(infoset));
    }

    int action_count(int) const
    {
        return kActionsPerInfoset;
    }

    State child_action(const State& state, int local_action) const
    {
        const Action action = local_action_to_action(infoset(state), local_action);
        State next = state;
        next.sequence = poker::kuhn::apply_action(state.sequence, action);
        return next;
    }

    std::string infoset_label(int infoset) const
    {
        return poker::kuhn::infoset_label(infoset);
    }

    std::string action_label(int infoset, int local_action) const
    {
        return std::string(action_name(local_action_to_action(infoset, local_action)));
    }

private:
    std::array<Deal, kNumDeals> deals_;
};

} // namespace poker::kuhn
