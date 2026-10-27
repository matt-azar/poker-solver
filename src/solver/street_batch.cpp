#include "solver/street_batch.hpp"

#include "poker/card.hpp"
#include "poker/hand_eval.hpp"
#include "poker/range.hpp"
#include "solver/regret_matching.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <limits>
#include <memory_resource>
#include <new>
#include <numeric>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <tuple>
#include <unordered_map>
#include <utility>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <psapi.h>
#endif

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

std::pmr::string chip_label(
    int code,
    int add,
    int street_total,
    bool all_in,
    bool facing,
    std::pmr::memory_resource* heap)
{
    std::pmr::string text(heap);
    const auto append_number = [&](int value)
    {
        const std::string digits = std::to_string(value);
        text.append(digits.data(), digits.size());
    };
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
        text = "Bet ";
        append_number(add);
    }
    else
    {
        text = "Raise to ";
        append_number(street_total);
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

std::uint64_t checked_add(std::uint64_t left, std::uint64_t right, const char* what)
{
    if (left > std::numeric_limits<std::uint64_t>::max() - right)
    {
        throw std::invalid_argument(std::string(what) + " overflowed");
    }
    return left + right;
}

std::uint64_t checked_mul(std::uint64_t left, std::uint64_t right, const char* what)
{
    if (left != 0 && right > std::numeric_limits<std::uint64_t>::max() / left)
    {
        throw std::invalid_argument(std::string(what) + " overflowed");
    }
    return left * right;
}

std::uint64_t budget_bytes(int mib)
{
    if (mib <= 0)
    {
        throw std::invalid_argument(
            "memory budget must be a positive integer number of mebibytes");
    }
    const auto value = static_cast<std::uint64_t>(mib);
    if (value > std::numeric_limits<std::uint64_t>::max() / 1048576ull)
    {
        throw std::invalid_argument("memory budget overflows");
    }
    return value * 1048576ull;
}

std::uint64_t process_peak_working_set_bytes()
{
#ifdef _WIN32
    PROCESS_MEMORY_COUNTERS counters = {};
    if (GetProcessMemoryInfo(GetCurrentProcess(), &counters, sizeof(counters)) != 0)
    {
        return static_cast<std::uint64_t>(counters.PeakWorkingSetSize);
    }
#endif
    return 0;
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

#define POKER_NODE_STRINGS(alloc)                                                              \
    std::pmr::string(alloc), std::pmr::string(alloc), std::pmr::string(alloc), std::pmr::string(alloc), \
    std::pmr::string(alloc), std::pmr::string(alloc), std::pmr::string(alloc), std::pmr::string(alloc)

#define POKER_NODE_COPY_STRINGS(other, alloc)                     \
    std::pmr::string((other).action_labels[0], alloc),           \
        std::pmr::string((other).action_labels[1], alloc),       \
        std::pmr::string((other).action_labels[2], alloc),       \
        std::pmr::string((other).action_labels[3], alloc),       \
        std::pmr::string((other).action_labels[4], alloc),       \
        std::pmr::string((other).action_labels[5], alloc),       \
        std::pmr::string((other).action_labels[6], alloc),       \
        std::pmr::string((other).action_labels[7], alloc)

#define POKER_NODE_MOVE_STRINGS(other, alloc)                              \
    std::pmr::string(std::move((other).action_labels[0]), alloc),         \
        std::pmr::string(std::move((other).action_labels[1]), alloc),     \
        std::pmr::string(std::move((other).action_labels[2]), alloc),     \
        std::pmr::string(std::move((other).action_labels[3]), alloc),     \
        std::pmr::string(std::move((other).action_labels[4]), alloc),     \
        std::pmr::string(std::move((other).action_labels[5]), alloc),     \
        std::pmr::string(std::move((other).action_labels[6]), alloc),     \
        std::pmr::string(std::move((other).action_labels[7]), alloc)

    struct Node
    {
        using allocator_type = std::pmr::polymorphic_allocator<std::byte>;

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
        std::pmr::vector<int> slot_of;
        std::pmr::string path;
        std::pmr::string action_labels[8];

        template <typename Alloc>
        Node(std::allocator_arg_t, const Alloc& alloc)
            : slot_of(alloc)
            , path(alloc)
            , action_labels{POKER_NODE_STRINGS(alloc)}
        {
        }

        template <typename Alloc>
        Node(std::allocator_arg_t, const Alloc& alloc, const Node& other)
            : slot_of(other.slot_of, alloc)
            , path(other.path, alloc)
            , action_labels{POKER_NODE_COPY_STRINGS(other, alloc)}
        {
            copy_scalars_from(other);
        }

        template <typename Alloc>
        Node(std::allocator_arg_t, const Alloc& alloc, Node&& other)
            : slot_of(std::move(other.slot_of), alloc)
            , path(std::move(other.path), alloc)
            , action_labels{POKER_NODE_MOVE_STRINGS(other, alloc)}
        {
            copy_scalars_from(other);
        }

        void copy_scalars_from(const Node& other)
        {
            terminal = other.terminal;
            chance = other.chance;
            deal_which = other.deal_which;
            player = other.player;
            street = other.street;
            depth = other.depth;
            card_mode = other.card_mode;
            mode1_is_turn = other.mode1_is_turn;
            hands = other.hands;
            folded = other.folded;
            contrib[0] = other.contrib[0];
            contrib[1] = other.contrib[1];
            n_actions = other.n_actions;
            for (int index = 0; index < 8; ++index)
            {
                child[index] = other.child[index];
            }
        }
    };

#undef POKER_NODE_STRINGS
#undef POKER_NODE_COPY_STRINGS
#undef POKER_NODE_MOVE_STRINGS

    struct Slot
    {
        int node = 0;
        int base = 0;
        int n_actions = 0;
        int hand = 0;
        int turn = -1;
        int river = -1;
    };

    struct RunoutRanks
    {
        using allocator_type = std::pmr::polymorphic_allocator<std::byte>;
        std::pmr::vector<std::uint32_t> rank[2];

        template <typename Alloc>
        RunoutRanks(std::allocator_arg_t, const Alloc& alloc)
            : rank{std::pmr::vector<std::uint32_t>(alloc), std::pmr::vector<std::uint32_t>(alloc)}
        {
        }

        template <typename Alloc>
        RunoutRanks(std::allocator_arg_t, const Alloc& alloc, const RunoutRanks& other)
            : rank{std::pmr::vector<std::uint32_t>(other.rank[0], alloc),
                std::pmr::vector<std::uint32_t>(other.rank[1], alloc)}
        {
        }

        template <typename Alloc>
        RunoutRanks(std::allocator_arg_t, const Alloc& alloc, RunoutRanks&& other)
            : rank{std::pmr::vector<std::uint32_t>(std::move(other.rank[0]), alloc),
                std::pmr::vector<std::uint32_t>(std::move(other.rank[1]), alloc)}
        {
        }
    };

    struct Support
    {
        int compatible = 0;
        int contain[52] = {};
    };

    struct Scratch
    {
        using allocator_type = std::pmr::polymorphic_allocator<std::byte>;
        std::pmr::vector<double> ev0;
        std::pmr::vector<double> ev1;
        std::pmr::vector<double> pi0;
        std::pmr::vector<double> pi1;
        std::pmr::vector<double> aev0;
        std::pmr::vector<double> aev1;

        template <typename Alloc>
        Scratch(std::allocator_arg_t, const Alloc& alloc)
            : ev0(alloc)
            , ev1(alloc)
            , pi0(alloc)
            , pi1(alloc)
            , aev0(alloc)
            , aev1(alloc)
        {
        }

        template <typename Alloc>
        Scratch(std::allocator_arg_t, const Alloc& alloc, const Scratch& other)
            : ev0(other.ev0, alloc)
            , ev1(other.ev1, alloc)
            , pi0(other.pi0, alloc)
            , pi1(other.pi1, alloc)
            , aev0(other.aev0, alloc)
            , aev1(other.aev1, alloc)
        {
        }

        template <typename Alloc>
        Scratch(std::allocator_arg_t, const Alloc& alloc, Scratch&& other)
            : ev0(std::move(other.ev0), alloc)
            , ev1(std::move(other.ev1), alloc)
            , pi0(std::move(other.pi0), alloc)
            , pi1(std::move(other.pi1), alloc)
            , aev0(std::move(other.aev0), alloc)
            , aev1(std::move(other.aev1), alloc)
        {
        }
    };

    streets::StreetConfig config;
    BudgetResource* budget_ = nullptr;
    std::pmr::memory_resource* heap_ = nullptr;
    std::pmr::vector<int> combos[2];
    std::pmr::vector<Deal> deals;
    std::pmr::vector<Node> nodes;
    std::pmr::vector<Slot> slots;
    std::pmr::vector<int> decision_ids;
    std::pmr::vector<double> regret;
    std::pmr::vector<double> strategy_sum;
    mutable std::pmr::vector<double> average;
    mutable std::pmr::vector<int> response;
    std::pmr::vector<char> combo_blocked;
    std::pmr::vector<int> combo_low;
    std::pmr::vector<int> combo_high;
    std::pmr::vector<int> combo_to_hand[2];
    std::pmr::vector<double> range_w[2];
    std::pmr::vector<int> hole_a[2];
    std::pmr::vector<int> hole_b[2];
    std::pmr::vector<int> hand_of[2];
    mutable std::pmr::unordered_map<int, RunoutRanks> runout_ranks;
    mutable std::pmr::vector<int> order_buf;
    mutable std::pmr::vector<int> pos_buf;
    mutable std::pmr::vector<double> prefix_buf;
    mutable std::pmr::vector<double> card_prefix_buf;
    mutable std::pmr::vector<std::uint32_t> sorted_rank_buf;
    std::pmr::vector<std::uint64_t> mask[2];
    std::pmr::vector<Support> support[2];
    std::pmr::vector<double> frozen_sigma;
    mutable std::pmr::vector<Scratch> scratch;
    mutable std::pmr::vector<double> amount_buf[2];
    mutable bool average_ready = false;
    int n0 = 0;
    int n1 = 0;
    int public_decisions = 0;
    int public_terminals = 0;
    std::uint64_t expanded_decisions = 0;
    std::uint64_t expanded_terminals = 0;
    std::uint64_t counted_deals_ = 0;
    std::uint64_t planned_slots_ = 0;
    std::int64_t planned_cursor_ = 0;
    std::uint64_t estimated_peak_bytes_ = 0;
    std::uint64_t max_rank_keys_ = 0;
    double construction_seconds_ = 0.0;
    double train_seconds_ = 0.0;
    mutable double evaluation_seconds_ = 0.0;
    double joint_mass_ = 0.0;
    int trained = 0;
    double joint_scale = 0.0;
    std::uint64_t board_mask = 0;

    explicit Engine(streets::StreetConfig incoming, BudgetResource& budget)
        : config(std::move(incoming))
        , budget_(&budget)
        , heap_(&budget)
        , combos{std::pmr::vector<int>(heap_), std::pmr::vector<int>(heap_)}
        , deals(heap_)
        , nodes(heap_)
        , slots(heap_)
        , decision_ids(heap_)
        , regret(heap_)
        , strategy_sum(heap_)
        , average(heap_)
        , response(heap_)
        , combo_blocked(heap_)
        , combo_low(heap_)
        , combo_high(heap_)
        , combo_to_hand{std::pmr::vector<int>(heap_), std::pmr::vector<int>(heap_)}
        , range_w{std::pmr::vector<double>(heap_), std::pmr::vector<double>(heap_)}
        , hole_a{std::pmr::vector<int>(heap_), std::pmr::vector<int>(heap_)}
        , hole_b{std::pmr::vector<int>(heap_), std::pmr::vector<int>(heap_)}
        , hand_of{std::pmr::vector<int>(heap_), std::pmr::vector<int>(heap_)}
        , runout_ranks(heap_)
        , order_buf(heap_)
        , pos_buf(heap_)
        , prefix_buf(heap_)
        , card_prefix_buf(heap_)
        , sorted_rank_buf(heap_)
        , mask{std::pmr::vector<std::uint64_t>(heap_), std::pmr::vector<std::uint64_t>(heap_)}
        , support{std::pmr::vector<Support>(heap_), std::pmr::vector<Support>(heap_)}
        , frozen_sigma(heap_)
        , scratch(heap_)
        , amount_buf{std::pmr::vector<double>(heap_), std::pmr::vector<double>(heap_)}
    {
        const auto started = std::chrono::steady_clock::now();
        validate();
        budget_->set_stage("public_tree");
        BetState root;
        root.pot = config.pot;
        root.acting = config.first_to_act;
        root.street = 0;
        build_node(root, "", 0);
        count_and_index_hands();
        set_hand_counts();
        visit_slots(false);
        estimated_peak_bytes_ = checked_add(budget_->current(), planned_allocation_bytes(), "plan");
        fill_deals();
        allocate_slot_of();
        allocate_slots();
        visit_slots(true);
        if (static_cast<std::uint64_t>(slots.size()) != planned_slots_ || cursor_ != planned_cursor_)
        {
            throw std::logic_error("street slot registration did not match the memory plan");
        }
        allocate_tables();
        build_reach_table();
        construction_seconds_ = std::chrono::duration<double>(
            std::chrono::steady_clock::now() - started).count();
    }

    std::int64_t cursor_ = 0;

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

    int build_node(const BetState& state, std::string_view path, int depth)
    {
        if (depth > 48)
        {
            throw std::logic_error("public street tree deeper than 48");
        }
        if (state.terminal)
        {
            Node node(std::allocator_arg, heap_);
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
            Node node(std::allocator_arg, heap_);
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
        Node node(std::allocator_arg, heap_);
        node.player = state.acting;
        node.street = state.street;
        node.depth = depth;
        node.n_actions = legal.count;
        node.path.assign(path.data(), path.size());
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
                legal.code[action], legal.add[action], street_total, all_in, facing, heap_);
        }
        const int id = static_cast<int>(nodes.size());
        nodes.push_back(std::move(node));
        ++public_decisions;
        decision_ids.push_back(id);
        for (int action = 0; action < legal.count; ++action)
        {
            const std::pmr::string& label = nodes[static_cast<std::size_t>(id)].action_labels[action];
            std::pmr::string next_path(heap_);
            if (path.empty())
            {
                next_path.assign(label.data(), label.size());
            }
            else
            {
                next_path.reserve(path.size() + 1 + label.size());
                next_path.assign(path.data(), path.size());
                next_path.push_back('/');
                next_path.append(label.data(), label.size());
            }
            const int child = build_node(apply_action(config, state, legal, action), next_path, depth + 1);
            nodes[static_cast<std::size_t>(id)].child[action] = child;
        }
        return id;
    }

    void prepare_pair_scan()
    {
        combo_blocked.assign(static_cast<std::size_t>(holdem::kComboCount), 0);
        combo_low.assign(static_cast<std::size_t>(holdem::kComboCount), 0);
        combo_high.assign(static_cast<std::size_t>(holdem::kComboCount), 0);
        for (int combo = 0; combo < holdem::kComboCount; ++combo)
        {
            int low = 0;
            int high = 0;
            holdem::Range::combo_cards(combo, low, high);
            combo_low[static_cast<std::size_t>(combo)] = low;
            combo_high[static_cast<std::size_t>(combo)] = high;
            for (int card : config.board)
            {
                if (card == low || card == high)
                {
                    combo_blocked[static_cast<std::size_t>(combo)] = 1;
                }
            }
        }
        joint_mass_ = holdem::joint_mass(
            config.oop, config.ip, config.board.data(), static_cast<int>(config.board.size()));
    }

    template <typename Visit>
    void for_each_legal_pair(Visit&& visit) const
    {
        for (int first = 0; first < holdem::kComboCount; ++first)
        {
            const double left = config.oop.weight(first);
            if (left == 0.0 || combo_blocked[static_cast<std::size_t>(first)] != 0)
            {
                continue;
            }
            const int a0 = combo_low[static_cast<std::size_t>(first)];
            const int a1 = combo_high[static_cast<std::size_t>(first)];
            for (int second = 0; second < holdem::kComboCount; ++second)
            {
                const double right = config.ip.weight(second);
                if (right == 0.0 || combo_blocked[static_cast<std::size_t>(second)] != 0)
                {
                    continue;
                }
                const int b0 = combo_low[static_cast<std::size_t>(second)];
                const int b1 = combo_high[static_cast<std::size_t>(second)];
                if (a0 == b0 || a0 == b1 || a1 == b0 || a1 == b1)
                {
                    continue;
                }
                visit(first, second, left * right);
            }
        }
    }

    void count_and_index_hands()
    {
        budget_->set_stage("combos");
        prepare_pair_scan();
        if (joint_mass_ <= 0.0)
        {
            throw std::invalid_argument("ranges leave no legal hand pair");
        }
        combo_to_hand[0].assign(static_cast<std::size_t>(holdem::kComboCount), -1);
        combo_to_hand[1].assign(static_cast<std::size_t>(holdem::kComboCount), -1);
        std::uint64_t count = 0;
        for_each_legal_pair([&](int first, int second, double)
        {
            ++count;
            if (combo_to_hand[0][static_cast<std::size_t>(first)] < 0)
            {
                combo_to_hand[0][static_cast<std::size_t>(first)] = static_cast<int>(combos[0].size());
                combos[0].push_back(first);
            }
            if (combo_to_hand[1][static_cast<std::size_t>(second)] < 0)
            {
                combo_to_hand[1][static_cast<std::size_t>(second)] = static_cast<int>(combos[1].size());
                combos[1].push_back(second);
            }
        });
        if (count == 0)
        {
            throw std::invalid_argument("ranges leave no legal hand pair");
        }
        counted_deals_ = count;
        n0 = static_cast<int>(combos[0].size());
        n1 = static_cast<int>(combos[1].size());
    }

    void fill_deals()
    {
        budget_->set_stage("deals");
        deals.reserve(static_cast<std::size_t>(counted_deals_));
        for_each_legal_pair([&](int first, int second, double product)
        {
            Deal deal;
            deal.combo0 = first;
            deal.combo1 = second;
            deal.h0 = combo_to_hand[0][static_cast<std::size_t>(first)];
            deal.h1 = combo_to_hand[1][static_cast<std::size_t>(second)];
            deal.probability = product / joint_mass_;
            deal.c0 = combo_low[static_cast<std::size_t>(first)];
            deal.c1 = combo_high[static_cast<std::size_t>(first)];
            deal.d0 = combo_low[static_cast<std::size_t>(second)];
            deal.d1 = combo_high[static_cast<std::size_t>(second)];
            deals.push_back(deal);
        });
        if (deals.size() != static_cast<std::size_t>(counted_deals_))
        {
            throw std::logic_error("street deal fill did not match the counted pairs");
        }
    }

    void set_hand_counts()
    {
        for (Node& node : nodes)
        {
            if (node.terminal || node.chance)
            {
                continue;
            }
            node.hands = node.player == 0 ? n0 : n1;
        }
    }

    std::uint64_t slot_index_cells() const
    {
        std::uint64_t cells = 0;
        for (const Node& node : nodes)
        {
            if (node.terminal || node.chance)
            {
                continue;
            }
            std::uint64_t dim = 1;
            if (node.card_mode == 1)
            {
                dim = 52;
            }
            else if (node.card_mode == 2)
            {
                dim = 52ull * 52ull;
            }
            cells = checked_add(
                cells,
                checked_mul(dim, static_cast<std::uint64_t>(node.hands), "slot index"),
                "slot index");
        }
        return cells;
    }

    std::uint64_t planned_allocation_bytes() const
    {
        const std::uint64_t hands0 = static_cast<std::uint64_t>(n0);
        const std::uint64_t hands1 = static_cast<std::uint64_t>(n1);
        const std::uint64_t wide = hands0 > hands1 ? hands0 : hands1;
        std::uint64_t total = 0;
        const std::uint64_t header = static_cast<std::uint64_t>(
            BudgetResource::request_bytes(0, alignof(std::max_align_t)));
        const auto add = [&](std::uint64_t bytes)
        {
            total = checked_add(total, bytes, "plan");
            total = checked_add(total, header, "plan");
        };
        add(checked_mul(counted_deals_, sizeof(Deal), "plan"));
        add(checked_mul(slot_index_cells(), sizeof(int), "plan"));
        add(checked_mul(planned_slots_, sizeof(Slot), "plan"));
        const std::uint64_t table = checked_mul(
            static_cast<std::uint64_t>(planned_cursor_), sizeof(double), "plan");
        add(table);
        add(table);
        add(table);
        add(table);
        const std::uint64_t scratch_level = checked_add(
            checked_mul(hands0, sizeof(double) * 10, "plan"),
            checked_mul(hands1, sizeof(double) * 10, "plan"),
            "plan");
        add(checked_mul(32, sizeof(Scratch), "plan"));
        add(checked_mul(32, scratch_level, "plan"));
        add(checked_mul(hands0 + hands1, sizeof(std::uint64_t), "plan"));
        add(checked_mul(hands0 + hands1, sizeof(double), "plan"));
        add(checked_mul((hands0 + hands1) * 2, sizeof(int), "plan"));
        add(checked_mul(static_cast<std::uint64_t>(holdem::kComboCount) * 2, sizeof(int), "plan"));
        add(checked_mul(wide, sizeof(int), "plan"));
        add(checked_mul(wide, sizeof(int), "plan"));
        add(checked_mul(wide + 1, sizeof(double), "plan"));
        add(checked_mul(52ull * (wide + 1), sizeof(double), "plan"));
        add(checked_mul(wide, sizeof(std::uint32_t), "plan"));
        add(checked_mul(planned_slots_, sizeof(int), "plan"));
        add(checked_mul(hands0 + hands1, sizeof(double), "plan"));
        const int free_cards = 52 - static_cast<int>(config.board.size());
        const std::uint64_t keys = config.board.size() == 3
            ? checked_mul(
                static_cast<std::uint64_t>(free_cards),
                static_cast<std::uint64_t>(free_cards - 1),
                "plan")
            : static_cast<std::uint64_t>(free_cards);
        const std::uint64_t payload = checked_add(
            checked_mul(hands0, sizeof(std::uint32_t), "plan"),
            checked_mul(hands1, sizeof(std::uint32_t), "plan"),
            "plan");
        // One map node per runout: three pointers plus the mapped object.
        // This is a plan, not the measured allocation.
        const std::uint64_t map_node = 3ull * sizeof(void*) + sizeof(RunoutRanks);
        add(checked_mul(keys, checked_add(payload, map_node, "plan"), "plan"));
        return total;
    }

    void allocate_slot_of()
    {
        budget_->set_stage("slot_of");
        for (Node& node : nodes)
        {
            if (node.terminal || node.chance)
            {
                continue;
            }
            std::uint64_t dim = 1;
            if (node.card_mode == 1)
            {
                dim = 52;
            }
            else if (node.card_mode == 2)
            {
                dim = 52ull * 52ull;
            }
            const std::uint64_t count = checked_mul(
                dim, static_cast<std::uint64_t>(node.hands), "slot index");
            node.slot_of.assign(static_cast<std::size_t>(count), -1);
        }
    }

    void allocate_slots()
    {
        budget_->set_stage("slots");
        slots.reserve(static_cast<std::size_t>(planned_slots_));
    }

    void allocate_tables()
    {
        if (cursor_ != planned_cursor_)
        {
            throw std::logic_error("street regret cursor did not match the memory plan");
        }
        const auto entries = static_cast<std::size_t>(cursor_);
        budget_->set_stage("regret");
        regret.assign(entries, 0.0);
        budget_->set_stage("strategy_sum");
        strategy_sum.assign(entries, 0.0);
        budget_->set_stage("average");
        average.assign(entries, 0.0);
        budget_->set_stage("frozen");
        frozen_sigma.assign(entries, 0.0);
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
        if (slots.size() >= static_cast<std::size_t>(std::numeric_limits<int>::max()))
        {
            throw std::invalid_argument(
                "street information-set count exceeded the 32-bit stored id limit");
        }
        if (node.n_actions < 0
            || cursor_ > static_cast<std::int64_t>(std::numeric_limits<int>::max()) - node.n_actions)
        {
            throw std::invalid_argument(
                "street regret table exceeded the 32-bit stored id limit");
        }
        const int key = card_key(node, hand, turn, river);
        Slot slot;
        slot.node = node_index;
        slot.base = static_cast<int>(cursor_);
        slot.n_actions = node.n_actions;
        slot.hand = hand;
        slot.turn = turn;
        slot.river = river;
        node.slot_of[static_cast<std::size_t>(key)] = static_cast<int>(slots.size());
        slots.push_back(std::move(slot));
        cursor_ += node.n_actions;
    }

    void note_planned_slot(const Node& node)
    {
        if (node.n_actions < 0
            || planned_cursor_ > static_cast<std::int64_t>(std::numeric_limits<int>::max()) - node.n_actions)
        {
            throw std::invalid_argument(
                "street regret table exceeded the 32-bit stored id limit");
        }
        ++planned_slots_;
        planned_cursor_ += node.n_actions;
    }

    void consider_slot(bool commit, int node_index, int hand, int turn, int river)
    {
        if (commit)
        {
            add_slot(node_index, hand, turn, river);
            return;
        }
        note_planned_slot(nodes[static_cast<std::size_t>(node_index)]);
    }

    // Every legal deal keeps four distinct hole cards off the board, so each
    // public node is reached by counted_deals_ times the same runout count.
    // extra is 0 on the first street, 1 after the next card, and 2 on the river.
    // The product is an expanded-history statistic. It is not a stored node count.
    void charge_visits(int extra, bool terminal)
    {
        std::uint64_t live = 52 - static_cast<std::uint64_t>(config.board.size()) - 4;
        std::uint64_t per_deal = 1;
        for (int i = 0; i < extra; ++i)
        {
            per_deal = checked_mul(per_deal, live, "expanded histories");
            --live;
        }
        const std::uint64_t visits = checked_mul(per_deal, counted_deals_, "expanded histories");
        if (terminal)
        {
            expanded_terminals = checked_add(expanded_terminals, visits, "expanded histories");
            return;
        }
        expanded_decisions = checked_add(expanded_decisions, visits, "expanded histories");
    }

    void visit_slots(bool commit)
    {
        bool on_board[52] = {};
        for (int card : config.board)
        {
            on_board[card] = true;
        }
        budget_->set_stage("registration");
        std::pmr::vector<int> card_a[2] = {std::pmr::vector<int>(heap_), std::pmr::vector<int>(heap_)};
        std::pmr::vector<int> card_b[2] = {std::pmr::vector<int>(heap_), std::pmr::vector<int>(heap_)};
        std::pmr::vector<int> hand_at[2] = {std::pmr::vector<int>(heap_), std::pmr::vector<int>(heap_)};
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

        if (!commit)
        {
            planned_slots_ = 0;
            planned_cursor_ = 0;
            expanded_decisions = 0;
            expanded_terminals = 0;
            for (const Node& node : nodes)
            {
                if (node.chance)
                {
                    continue;
                }
                charge_visits(node.terminal ? node.street : node.card_mode, node.terminal);
            }

            budget_->set_stage("support");
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
                    consider_slot(commit, node_index, hand, -1, -1);
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
                            consider_slot(commit, node_index, hand, card, -1);
                        }
                        else
                        {
                            consider_slot(commit, node_index, hand, -1, card);
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
                        consider_slot(commit, node_index, hand, turn, river);
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
        if (node.path.empty())
        {
            text += "open";
        }
        else
        {
            text.append(node.path.data(), node.path.size());
        }
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
            + " path " + (node.path.empty()
                ? std::string("open")
                : std::string(node.path.data(), node.path.size()))
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
        const auto started = std::chrono::steady_clock::now();
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
        train_seconds_ += std::chrono::duration<double>(
            std::chrono::steady_clock::now() - started).count();
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
        const auto started = std::chrono::steady_clock::now();
        ensure_average();
        response.assign(slots.size(), -1);
        std::fill(scratch[0].pi0.begin(), scratch[0].pi0.end(), 1.0);
        std::fill(scratch[0].pi1.begin(), scratch[0].pi1.end(), 1.0);
        response_walk(0, -1, -1, 0, responding);
        const std::pmr::vector<double>& values = responding == 1 ? scratch[0].ev1 : scratch[0].ev0;
        double total = 0.0;
        for (double value : values)
        {
            total += value;
        }
        evaluation_seconds_ += std::chrono::duration<double>(
            std::chrono::steady_clock::now() - started).count();
        return total;
    }

    void build_reach_table()
    {
        board_mask = 0;
        for (int card : config.board)
        {
            board_mask |= std::uint64_t{1} << card;
        }
        const std::uint64_t wide = static_cast<std::uint64_t>(n0 > n1 ? n0 : n1);
        budget_->set_stage("ranges");
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
        if (joint_mass_ <= 0.0)
        {
            throw std::logic_error("street ranges have no joint weight");
        }
        joint_scale = 1.0 / joint_mass_;
        budget_->set_stage("scratch");
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

        budget_->set_stage("prefix");
        order_buf.assign(static_cast<std::size_t>(wide), 0);
        pos_buf.assign(static_cast<std::size_t>(wide), 0);
        prefix_buf.assign(static_cast<std::size_t>(wide + 1), 0.0);
        card_prefix_buf.assign(static_cast<std::size_t>(52ull * (wide + 1)), 0.0);
        sorted_rank_buf.assign(static_cast<std::size_t>(wide), 0);

        budget_->set_stage("response");
        response.assign(slots.size(), -1);

        budget_->set_stage("terminal_buffers");
        amount_buf[0].assign(static_cast<std::size_t>(n0), 0.0);
        amount_buf[1].assign(static_cast<std::size_t>(n1), 0.0);
        prepare_rank_cache();
    }

    void prepare_rank_cache()
    {
        budget_->set_stage("rank_cache");
        bool on_board[52] = {};
        for (int card : config.board)
        {
            on_board[card] = true;
        }
        const int free_cards = 52 - static_cast<int>(config.board.size());
        max_rank_keys_ = config.board.size() == 3
            ? static_cast<std::uint64_t>(free_cards) * static_cast<std::uint64_t>(free_cards - 1)
            : static_cast<std::uint64_t>(free_cards);
        runout_ranks.reserve(static_cast<std::size_t>(max_rank_keys_));
        const auto reserve_key = [&](int turn, int river)
        {
            const int key = (turn + 1) * 64 + (river + 1);
            const auto inserted = runout_ranks.try_emplace(key);
            RunoutRanks& table = inserted.first->second;
            table.rank[0].reserve(static_cast<std::size_t>(n0));
            table.rank[1].reserve(static_cast<std::size_t>(n1));
        };
        if (config.board.size() == 4)
        {
            for (int river = 0; river < 52; ++river)
            {
                if (!on_board[river])
                {
                    reserve_key(-1, river);
                }
            }
        }
        else
        {
            for (int turn = 0; turn < 52; ++turn)
            {
                if (on_board[turn])
                {
                    continue;
                }
                for (int river = 0; river < 52; ++river)
                {
                    if (on_board[river] || river == turn)
                    {
                        continue;
                    }
                    reserve_key(turn, river);
                }
            }
        }
        if (runout_ranks.size() != static_cast<std::size_t>(max_rank_keys_))
        {
            throw std::logic_error("street rank cache did not reserve every runout");
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

    const std::pmr::vector<std::uint32_t>& ranks_for(int player, int turn, int river) const
    {
        const int key = (turn + 1) * 64 + (river + 1);
        const auto found = runout_ranks.find(key);
        if (found == runout_ranks.end())
        {
            throw std::logic_error("street rank cache missed a reserved runout");
        }
        RunoutRanks& table = found->second;
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
                if (table.rank[side].capacity() < static_cast<std::size_t>(hands))
                {
                    throw std::logic_error("street rank cache exceeded its reserved bound");
                }
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
        std::pmr::vector<double>& amount,
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

    double blocked_reach(int hero, int hand, const double* by_card, std::span<const double> opp_amount) const
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

    void order_reach(int player, std::span<const double> amount, std::span<const std::uint32_t> ranks) const
    {
        const int hands = static_cast<int>(amount.size());
        if (order_buf.capacity() < amount.size()
            || pos_buf.capacity() < amount.size()
            || prefix_buf.capacity() < amount.size() + 1
            || sorted_rank_buf.capacity() < amount.size()
            || card_prefix_buf.capacity() < 52ull * (amount.size() + 1))
        {
            throw std::logic_error("street showdown prefix exceeded its reserved bound");
        }
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

    double slice_reach(int begin, int end, int c0, int c1, int add_hand, std::span<const double> amount) const
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
        std::span<const double> opp_amount,
        std::span<double> ev) const
    {
        const int opp = 1 - hero;
        const std::pmr::vector<std::uint32_t>& hero_ranks = ranks_for(hero, turn, river);
        const std::pmr::vector<std::uint32_t>& opp_ranks = ranks_for(opp, turn, river);
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
        std::span<double> ev0,
        std::span<double> ev1) const
    {
        double total0 = 0.0;
        double total1 = 0.0;
        double by0[52];
        double by1[52];
        collect_reach(0, turn, river, pi0, true, amount_buf[0], total0, by0);
        collect_reach(1, turn, river, pi1, true, amount_buf[1], total1, by1);
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
                const double open = total1 - blocked_reach(0, hand, by1, amount_buf[1]);
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
                const double open = total0 - blocked_reach(1, hand, by0, amount_buf[0]);
                ev1[static_cast<std::size_t>(hand)] =
                    pay * range_w[1][static_cast<std::size_t>(hand)] * joint_scale * open;
            }
            return;
        }
        const double win_pay = half + static_cast<double>(node.contrib[1]);
        const double lose_pay = -(half + static_cast<double>(node.contrib[0]));
        showdown_side(0, turn, river, win_pay, lose_pay, amount_buf[1], ev0);
        showdown_side(1, turn, river, win_pay, lose_pay, amount_buf[0], ev1);
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
        const auto started = std::chrono::steady_clock::now();
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
        train_seconds_ += std::chrono::duration<double>(
            std::chrono::steady_clock::now() - started).count();
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
                if (std::string_view(node.action_labels[index]) != action)
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
                if (std::string_view(node.action_labels[index]) != action)
                {
                    continue;
                }
                value = regret[static_cast<std::size_t>(slot.base + index)];
                return true;
            }
        }
        return false;
    }

    StreetMemoryReport memory_report() const
    {
        StreetMemoryReport report;
        report.memory_budget_bytes = budget_->limit();
        report.allocated_bytes = budget_->current();
        report.peak_allocated_bytes = budget_->peak();
        report.reserved_bytes = budget_->reserved();
        report.regret_strategy_sum_bytes = regret.size() * sizeof(double)
            + strategy_sum.size() * sizeof(double);
        report.estimated_peak_bytes = estimated_peak_bytes_;
        report.expanded_terminals = expanded_terminals;
        report.expanded_decisions = expanded_decisions;
        report.process_peak_working_set_bytes = process_peak_working_set_bytes();
        report.construction_seconds = construction_seconds_;
        report.train_seconds = train_seconds_;
        report.evaluation_seconds = evaluation_seconds_;
        for (const BudgetResource::Component& item : budget_->components())
        {
            if (item.bytes == 0)
            {
                continue;
            }
            StreetMemoryComponent component;
            component.name = item.name;
            component.bytes = item.bytes;
            report.components.push_back(std::move(component));
        }
        return report;
    }
};

StreetBatchSolver::StreetBatchSolver(
    streets::StreetConfig config,
    std::pmr::memory_resource* upstream)
    : upstream_(upstream != nullptr ? upstream : std::pmr::new_delete_resource())
    , budget_(upstream_, budget_bytes(config.memory_mib))
{
    budget_.set_stage("engine");
    engine_storage_ = budget_.allocate(sizeof(Engine), alignof(Engine));
    try
    {
        engine_ = ::new (engine_storage_) Engine(std::move(config), budget_);
    }
    catch (...)
    {
        budget_.deallocate(engine_storage_, sizeof(Engine), alignof(Engine));
        engine_storage_ = nullptr;
        throw;
    }
}

StreetBatchSolver::~StreetBatchSolver()
{
    if (engine_ != nullptr)
    {
        engine_->~Engine();
        engine_ = nullptr;
    }
    if (engine_storage_ != nullptr)
    {
        budget_.deallocate(engine_storage_, sizeof(Engine), alignof(Engine));
        engine_storage_ = nullptr;
    }
}

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
    if (!fresh)
    {
        stats.p1_expected_utility = expected_utility();
        stats.p1_best_response_utility = p1_best_response_utility();
        stats.p2_best_response_utility = p2_best_response_utility();
        stats.nash_gap = stats.p1_best_response_utility + stats.p2_best_response_utility;
    }
    const auto end = std::chrono::steady_clock::now();
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
    if (!fresh)
    {
        stats.p1_expected_utility = expected_utility();
        stats.p1_best_response_utility = p1_best_response_utility();
        stats.p2_best_response_utility = p2_best_response_utility();
        stats.nash_gap = stats.p1_best_response_utility + stats.p2_best_response_utility;
    }
    const auto end = std::chrono::steady_clock::now();
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

std::uint64_t StreetBatchSolver::infoset_count() const
{
    return static_cast<std::uint64_t>(engine_->slots.size());
}

std::uint64_t StreetBatchSolver::deal_count() const
{
    return static_cast<std::uint64_t>(engine_->deals.size());
}

int StreetBatchSolver::public_decisions() const
{
    return engine_->public_decisions;
}

int StreetBatchSolver::public_terminals() const
{
    return engine_->public_terminals;
}

std::uint64_t StreetBatchSolver::decision_node_count() const
{
    return engine_->expanded_decisions;
}

std::uint64_t StreetBatchSolver::terminal_count() const
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

StreetMemoryReport StreetBatchSolver::memory_report() const
{
    return engine_->memory_report();
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
            entry.action.assign(node.action_labels[action].data(), node.action_labels[action].size());
            entry.probability = engine_->average[static_cast<std::size_t>(slot.base + action)];
            entries.push_back(std::move(entry));
        }
    }
    return entries;
}

} // namespace poker::solver
