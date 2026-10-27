#pragma once

#include <cstdint>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace poker::leduc
{

// Six-card Leduc Hold'em, the two-player game from Southey et al. (UAI 2005)
// and the default OpenSpiel leduc_poker parameters.
//
// Deck: J1 J2 Q1 Q2 K1 K2, encoded as 0..5. Rank is card/2 (J=0, Q=1, K=2).
// Suit is card%2. The player observes their own card, including suit.
// The opponent's card is not part of an information set.
//
// Each player antes 1. Player 0 acts first on both streets.
// Round 1 raise size is 2. Round 2 raise size is 4.
// A raise cap of 2 means the opening bet counts as the first raise, so the
// longest line on a street is bet, raise, call. Check is a call of 0 chips.
// The stake level is not reset when the board is dealt.
//
// Showdown: a pair (private rank equals the board rank) beats a high card.
// Otherwise the higher rank wins. Equal ranks split the pot. Suits never
// break a tie. There is only one card of the board's rank left in the deck,
// so at most one player pairs.
//
// Utilities are player 0's net chips. Player 1's are the negation.

inline constexpr int kDeckSize = 6;
inline constexpr int kAnte = 1;
inline constexpr int kRound1Raise = 2;
inline constexpr int kRound2Raise = 4;
inline constexpr int kDefaultMaxRaises = 2;

enum class LeducAction : int
{
    Fold = 0,
    Call = 1,
    Raise = 2
};

struct LeducConfig
{
    int max_raises_round1 = kDefaultMaxRaises;
    int max_raises_round2 = kDefaultMaxRaises;
};

class LeducGame
{
public:
    struct State
    {
        int hole[2] = {-1, -1};
        int board = -1;
        int contrib[2] = {kAnte, kAnte};
        int pot = kAnte * 2;
        int stakes = kAnte;
        int num_raises = 0;
        int num_calls = 0;
        int round = 1;
        int acting = -1;
        int chance_stage = 1;
        int folded_player = -1;
        bool terminal = false;
        int seq1[4] = {};
        int n1 = 0;
        int seq2[4] = {};
        int n2 = 0;
    };

    LeducGame()
        : LeducGame(LeducConfig{})
    {
    }

    explicit LeducGame(LeducConfig config)
        : config_(config)
    {
        if (config_.max_raises_round1 < 0 || config_.max_raises_round2 < 0)
        {
            throw std::invalid_argument("Leduc raise cap must be non-negative");
        }
        index(root());
    }

    int infoset_count() const
    {
        return static_cast<int>(infosets_.size());
    }

    State root() const
    {
        return State{};
    }

    bool is_chance(const State& state) const
    {
        return !state.terminal && state.chance_stage != 0;
    }

    bool is_terminal(const State& state) const
    {
        return state.terminal;
    }

    double p1_utility(const State& state) const
    {
        if (!state.terminal)
        {
            throw std::logic_error("p1_utility on a non-terminal Leduc state");
        }
        if (state.folded_player == 0)
        {
            return -static_cast<double>(state.contrib[0]);
        }
        if (state.folded_player == 1)
        {
            return static_cast<double>(state.contrib[1]);
        }
        if (state.contrib[0] != state.contrib[1])
        {
            throw std::logic_error("showdown with unequal contributions");
        }
        const int strength0 = hand_strength(state.hole[0], state.board);
        const int strength1 = hand_strength(state.hole[1], state.board);
        if (strength0 == strength1)
        {
            return 0.0;
        }
        if (strength0 > strength1)
        {
            return static_cast<double>(state.contrib[1]);
        }
        return -static_cast<double>(state.contrib[0]);
    }

    int chance_count(const State& state) const
    {
        if (!is_chance(state))
        {
            return 0;
        }
        return kDeckSize - cards_used(state);
    }

    double chance_probability(const State& state, int) const
    {
        const int count = chance_count(state);
        if (count <= 0)
        {
            throw std::logic_error("chance_probability with no outcomes");
        }
        return 1.0 / static_cast<double>(count);
    }

    State child_chance(const State& state, int outcome) const
    {
        if (!is_chance(state))
        {
            throw std::logic_error("child_chance on a non-chance state");
        }
        const int card = nth_remaining(state, outcome);
        State next = state;
        if (state.chance_stage == 1)
        {
            next.hole[0] = card;
            next.chance_stage = 2;
        }
        else if (state.chance_stage == 2)
        {
            next.hole[1] = card;
            next.chance_stage = 0;
            next.acting = 0;
        }
        else if (state.chance_stage == 3)
        {
            next.board = card;
            next.chance_stage = 0;
            next.acting = 0;
        }
        else
        {
            throw std::logic_error("unknown Leduc chance stage");
        }
        return next;
    }

    int infoset(const State& state) const
    {
        if (is_chance(state) || state.terminal)
        {
            throw std::logic_error("infoset requested off a decision node");
        }
        const auto found = ids_.find(pack(state));
        if (found == ids_.end())
        {
            throw std::logic_error("Leduc decision was not indexed");
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
            throw std::logic_error("local action out of range");
        }
        return apply(state, static_cast<LeducAction>(legal.actions[local_action]));
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
        return action_name(info.facing_bet, info.actions[local_action]);
    }

    const LeducConfig& config() const
    {
        return config_;
    }

private:
    struct Legal
    {
        int count = 0;
        int actions[3] = {};
    };

    struct Infoset
    {
        int player = 0;
        int action_count = 0;
        int actions[3] = {};
        bool facing_bet = false;
        std::string label;
    };

    static int hand_strength(int hole, int board)
    {
        if (hole < 0 || board < 0)
        {
            throw std::logic_error("showdown without cards");
        }
        const int hole_rank = hole / 2;
        const int board_rank = board / 2;
        if (hole_rank == board_rank)
        {
            return 3 + hole_rank;
        }
        return hole_rank;
    }

    static int cards_used(const State& state)
    {
        int used = 0;
        if (state.hole[0] >= 0)
        {
            ++used;
        }
        if (state.hole[1] >= 0)
        {
            ++used;
        }
        if (state.board >= 0)
        {
            ++used;
        }
        return used;
    }

    static bool card_in_play(const State& state, int card)
    {
        return card == state.hole[0] || card == state.hole[1] || card == state.board;
    }

    static int nth_remaining(const State& state, int outcome)
    {
        int seen = 0;
        for (int card = 0; card < kDeckSize; ++card)
        {
            if (card_in_play(state, card))
            {
                continue;
            }
            if (seen == outcome)
            {
                return card;
            }
            ++seen;
        }
        throw std::logic_error("chance outcome out of range");
    }

    static const char* card_name(int card)
    {
        static const char* names[] = {"J1", "J2", "Q1", "Q2", "K1", "K2"};
        if (card < 0 || card >= kDeckSize)
        {
            return "-";
        }
        return names[card];
    }

    static std::string action_name(bool facing_bet, int action)
    {
        if (action == static_cast<int>(LeducAction::Fold))
        {
            return "Fold";
        }
        if (action == static_cast<int>(LeducAction::Raise))
        {
            return facing_bet ? "Raise" : "Bet";
        }
        return facing_bet ? "Call" : "Check";
    }

    static std::string sequence_text(const int* actions, int count)
    {
        std::string text;
        bool facing = false;
        for (int i = 0; i < count; ++i)
        {
            if (!text.empty())
            {
                text += '-';
            }
            text += action_name(facing, actions[i]);
            if (actions[i] == static_cast<int>(LeducAction::Raise))
            {
                facing = true;
            }
            else if (actions[i] == static_cast<int>(LeducAction::Call) && facing)
            {
                facing = false;
            }
        }
        return text;
    }

    int raise_cap(const State& state) const
    {
        return state.round == 1 ? config_.max_raises_round1 : config_.max_raises_round2;
    }

    Legal legal_actions(const State& state) const
    {
        if (is_chance(state) || state.terminal)
        {
            throw std::logic_error("legal actions off a decision node");
        }
        Legal legal;
        const bool facing = state.stakes > state.contrib[state.acting];
        if (facing)
        {
            legal.actions[legal.count++] = static_cast<int>(LeducAction::Fold);
        }
        legal.actions[legal.count++] = static_cast<int>(LeducAction::Call);
        if (state.num_raises < raise_cap(state))
        {
            legal.actions[legal.count++] = static_cast<int>(LeducAction::Raise);
        }
        return legal;
    }

    static void append_action(State& state, LeducAction action)
    {
        if (state.round == 1)
        {
            if (state.n1 >= 4)
            {
                throw std::logic_error("round-1 history overflow");
            }
            state.seq1[state.n1++] = static_cast<int>(action);
        }
        else
        {
            if (state.n2 >= 4)
            {
                throw std::logic_error("round-2 history overflow");
            }
            state.seq2[state.n2++] = static_cast<int>(action);
        }
    }

    static bool street_closed(const State& state)
    {
        if (state.num_raises == 0)
        {
            return state.num_calls == 2;
        }
        return state.num_calls == 1;
    }

    static std::uint64_t pack_sequence(const int* actions, int count)
    {
        std::uint64_t code = static_cast<std::uint64_t>(count);
        std::uint64_t bit = 1;
        for (int i = 0; i < count; ++i)
        {
            if (actions[i] == static_cast<int>(LeducAction::Raise))
            {
                code += bit << 3;
            }
            bit <<= 1;
        }
        return code;
    }

    static std::uint64_t pack(const State& state)
    {
        const int player = state.acting;
        const int hole = state.hole[player];
        const std::uint64_t board = state.board < 0
            ? 0
            : static_cast<std::uint64_t>(state.board + 1);
        return static_cast<std::uint64_t>(hole)
            | (board << 8)
            | (static_cast<std::uint64_t>(player) << 16)
            | (pack_sequence(state.seq1, state.n1) << 24)
            | (pack_sequence(state.seq2, state.n2) << 40);
    }

    static std::string make_label(const State& state, bool facing)
    {
        std::string label = state.acting == 0 ? "P0 " : "P1 ";
        label += card_name(state.hole[state.acting]);
        label += " board=";
        label += card_name(state.board);
        label += " r1=";
        label += sequence_text(state.seq1, state.n1);
        label += " r2=";
        label += sequence_text(state.seq2, state.n2);
        label += facing ? " facing" : " open";
        return label;
    }

    State apply(const State& state, LeducAction action) const
    {
        if (action == LeducAction::Fold)
        {
            State next = state;
            next.folded_player = state.acting;
            next.terminal = true;
            next.acting = -1;
            return next;
        }

        State next = state;
        const int player = state.acting;
        const int call_amount = state.stakes - state.contrib[player];
        if (call_amount < 0)
        {
            throw std::logic_error("negative call amount");
        }
        next.contrib[player] += call_amount;
        next.pot += call_amount;

        if (action == LeducAction::Raise)
        {
            const int raise_amount = state.round == 1 ? kRound1Raise : kRound2Raise;
            next.stakes += raise_amount;
            next.contrib[player] += raise_amount;
            next.pot += raise_amount;
            next.num_raises += 1;
            next.num_calls = 0;
            append_action(next, LeducAction::Raise);
            next.acting = 1 - player;
            return next;
        }

        if (action != LeducAction::Call)
        {
            throw std::logic_error("unknown Leduc action");
        }
        next.num_calls += 1;
        append_action(next, LeducAction::Call);
        if (!street_closed(next))
        {
            next.acting = 1 - player;
            return next;
        }
        if (next.round == 1)
        {
            next.chance_stage = 3;
            next.acting = -1;
            next.round = 2;
            next.num_raises = 0;
            next.num_calls = 0;
            return next;
        }
        next.terminal = true;
        next.acting = -1;
        return next;
    }

    void ensure_infoset(const State& state)
    {
        const std::uint64_t key = pack(state);
        if (ids_.find(key) != ids_.end())
        {
            return;
        }
        const Legal legal = legal_actions(state);
        Infoset info;
        info.player = state.acting;
        info.action_count = legal.count;
        info.facing_bet = state.stakes > state.contrib[state.acting];
        for (int i = 0; i < legal.count; ++i)
        {
            info.actions[i] = legal.actions[i];
        }
        info.label = make_label(state, info.facing_bet);
        const int id = static_cast<int>(infosets_.size());
        ids_.emplace(key, id);
        infosets_.push_back(std::move(info));
    }

    void index(const State& state)
    {
        if (state.terminal)
        {
            return;
        }
        if (is_chance(state))
        {
            const int count = chance_count(state);
            for (int outcome = 0; outcome < count; ++outcome)
            {
                index(child_chance(state, outcome));
            }
            return;
        }
        ensure_infoset(state);
        const Legal legal = legal_actions(state);
        for (int action = 0; action < legal.count; ++action)
        {
            index(apply(state, static_cast<LeducAction>(legal.actions[action])));
        }
    }

    LeducConfig config_;
    std::unordered_map<std::uint64_t, int> ids_;
    std::vector<Infoset> infosets_;
};

} // namespace poker::leduc
