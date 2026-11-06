#pragma once

#include "game/chips.hpp"
#include "game/size_spec.hpp"
#include "poker/range.hpp"
#include "solver/chip_payoff.hpp"
#include "solver/icm.hpp"
#include "solver/incentives.hpp"
#include "solver/tree_edit.hpp"

#include <cmath>
#include <stdexcept>
#include <vector>

namespace poker::streets
{

inline constexpr int kMaxStreetActions = 8;
inline constexpr int kMaxStreetHistory = 24;

// Heads-up flop (3-card board) or turn (4-card board). The betting
// structure does not depend on the turn or river card. Sizes may differ
// by street. The river is dealt inside the tree.
// Information sets store the acting player's hand and the cards already dealt.
// They do not store the opponent's hand or a card that has not been dealt.
struct StreetConfig
{
    std::vector<int> board;
    // pot / stack are tenths of a chip (chip_units(100) == 100.0 chips).
    int pot = chip_units(100);
    int stack = chip_units(200);
    holdem::Range oop{};
    holdem::Range ip{};
    std::vector<double> oop_bet_sizes{};
    std::vector<double> ip_bet_sizes{};
    std::vector<double> oop_raise_sizes{};
    std::vector<double> ip_raise_sizes{};
    // Used on that street only. Empty means the street uses the lists above.
    std::vector<double> oop_flop_bets{};
    std::vector<double> oop_turn_bets{};
    std::vector<double> oop_river_bets{};
    std::vector<double> ip_flop_bets{};
    std::vector<double> ip_turn_bets{};
    std::vector<double> ip_river_bets{};
    std::vector<double> oop_flop_raises{};
    std::vector<double> oop_turn_raises{};
    std::vector<double> oop_river_raises{};
    std::vector<double> ip_flop_raises{};
    std::vector<double> ip_turn_raises{};
    std::vector<double> ip_river_raises{};
    // OOP bets with these sizes when IP was the aggressor on the previous
    // street. A zero-length list keeps the normal bet list. A one-element
    // explicit-empty list checks in the donk spot. Street lists override this.
    std::vector<double> oop_donk_sizes{};
    std::vector<double> oop_flop_donk{};
    std::vector<double> oop_turn_donk{};
    std::vector<double> oop_river_donk{};
    // Facing a bet, a raise-to of this multiple of the opponent's street total.
    // Used in addition to the raise list. A non-empty list with an empty raise
    // list does not fall back to the bet sizes.
    std::vector<double> oop_raise_multiples{};
    std::vector<double> ip_raise_multiples{};
    // A size that would commit more than this fraction of the starting stack
    // is replaced by all-in. Zero leaves every size as listed.
    double all_in_threshold = 0.0;
    // A bet or raise increment larger than this multiple of the pot is cut
    // down to the cap. Zero leaves no-limit sizing. One is pot-limit.
    double pot_cap = 0.0;
    // Collapse two chip amounts when the gap is at most this fraction of the
    // larger one. Zero keeps every distinct amount. Study sends 0.10 by default.
    double merge_threshold = 0.0;
    bool allow_all_in = true;
    // False removes the re-raise after a bet and a raise (3-bet).
    bool allow_three_bet = true;
    // Cap on facing raises per street. Opening bets do not count.
    // 0 = bets allowed, raises forbidden. Check-only uses empty bet lists.
    int max_raises = 1;
    int first_to_act = 0;
    // Solver-owned heap for StreetBatchSolver, in mebibytes. Zero is rejected.
    int memory_mib = 1024;
    // Frozen-pass threads, including the caller. One keeps the serial walk.
    int threads = 1;
    // Pot rake applied at terminals. Zero rate keeps the prior chip rule.
    // See docs/auxiliary/payoffs/RAKE.md.
    poker::solver::RakeConfig rake{};
    // Optional tournament ICM. Empty stacks leaves chip/rake terminals.
    // stacks[] are tournament chip counts (not betting `stack`). See docs/auxiliary/payoffs/ICM.md.
    poker::solver::IcmConfig icm{};
    // Optional action-label incentive overlay. Empty rules leave terminals
    // unchanged. Path-attributed at terminals; see docs/auxiliary/payoffs/INCENTIVES.md.
    poker::solver::IncentiveConfig incentives{};
    // Force/Remove filter legal actions at matching public histories during
    // build and play. AddSize injects one extra bet/raise size at the matching
    // decision (same min-raise / stack / pot-cap rules as listed sizes).
    poker::solver::TreeEditSet tree_edits{};
};

// Zero-length falls back to `shared`. An explicit-empty list does not.
inline const std::vector<double>& select_listed(
    const std::vector<double>& specific, const std::vector<double>& shared)
{
    if (is_explicit_empty_list(specific))
    {
        return empty_size_list();
    }
    if (!specific.empty())
    {
        return specific;
    }
    if (is_explicit_empty_list(shared))
    {
        return empty_size_list();
    }
    return shared;
}

inline const std::vector<double>& street_bet_list(const StreetConfig& config, int player, int kind)
{
    return player == 0
        ? (kind == 0 ? config.oop_flop_bets : kind == 1 ? config.oop_turn_bets : config.oop_river_bets)
        : (kind == 0 ? config.ip_flop_bets : kind == 1 ? config.ip_turn_bets : config.ip_river_bets);
}

inline const std::vector<double>& street_raise_list(const StreetConfig& config, int player, int kind)
{
    return player == 0
        ? (kind == 0 ? config.oop_flop_raises : kind == 1 ? config.oop_turn_raises : config.oop_river_raises)
        : (kind == 0 ? config.ip_flop_raises : kind == 1 ? config.ip_turn_raises : config.ip_river_raises);
}

inline const std::vector<double>& select_bets(const StreetConfig& config, int player, int kind)
{
    return select_listed(
        street_bet_list(config, player, kind),
        player == 0 ? config.oop_bet_sizes : config.ip_bet_sizes);
}

inline const std::vector<double>& select_raises(const StreetConfig& config, int player, int kind)
{
    // Raise lists stay separate from bet lists. Empty means no pot-fraction
    // raises (raise multiples / geometric / all-in may still apply).
    return select_listed(
        street_raise_list(config, player, kind),
        player == 0 ? config.oop_raise_sizes : config.ip_raise_sizes);
}

struct DonkSelection
{
    // True when no donk list is set, so the spot uses the normal bet list.
    bool use_normal_bets = true;
    const std::vector<double>* specs = nullptr;
};

inline DonkSelection select_donk(const StreetConfig& config, int kind)
{
    const std::vector<double>& street = kind == 0
        ? config.oop_flop_donk
        : kind == 1 ? config.oop_turn_donk : config.oop_river_donk;
    if (!street.empty())
    {
        return DonkSelection{false, &street};
    }
    if (!config.oop_donk_sizes.empty())
    {
        return DonkSelection{false, &config.oop_donk_sizes};
    }
    return DonkSelection{};
}

// Chip adds for one decision. Size-token decoding lives in size_spec.hpp;
// this helper only applies street selection, min-raise, pot-cap, and stack rules.
// `state` needs the street betting fields (acting, street, contrib, pot,
// committed, last_raise, num_raises, prev_aggressor).
template <typename State>
void fill_aggressive_amounts(
    const StreetConfig& config,
    const State& state,
    int betting_street_count,
    int* amounts,
    int& n_amounts)
{
    const int player = state.acting;
    const int to_call = state.committed - state.contrib[player];
    const bool facing = to_call > 0;
    const int max_add = config.stack - state.contrib[player];
    if (to_call < 0 || max_add < 0)
    {
        throw std::logic_error("street stack accounting failed");
    }

    n_amounts = 0;
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
    const auto consider = [&](int add, bool force_all_in)
    {
        if (facing && config.max_raises <= state.num_raises)
        {
            return;
        }
        if (add < 1)
        {
            return;
        }
        if (facing && !config.allow_three_bet && state.num_raises >= 1)
        {
            return;
        }
        if (add > max_add)
        {
            if (!config.allow_all_in && !force_all_in)
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
        if (!full && !(shove && (config.allow_all_in || force_all_in)))
        {
            return;
        }
        push_amount(add);
    };

    const int kind = state.street + static_cast<int>(config.board.size()) - 3;
    const int basis = facing ? state.pot + to_call : state.pot;
    SpecContext ctx;
    ctx.basis = basis;
    ctx.to_call = to_call;
    ctx.contrib = state.contrib[player];
    ctx.max_add = max_add;
    ctx.committed = state.committed;
    ctx.streets_left = betting_street_count - state.street;
    ctx.num_raises = state.num_raises;
    ctx.facing = facing;

    const bool donk_spot = !facing && player == 0 && state.prev_aggressor == 1;
    const std::vector<double>& multiples = player == 0
        ? config.oop_raise_multiples : config.ip_raise_multiples;
    const bool only_multiples = facing && !multiples.empty()
        && street_raise_list(config, player, kind).empty()
        && (player == 0 ? config.oop_raise_sizes : config.ip_raise_sizes).empty();

    bool offers = false;
    const auto emit_list = [&](const std::vector<double>& specs)
    {
        if (list_offers_size(specs))
        {
            offers = true;
        }
        for_each_spec_add(specs, ctx, [&](const SpecEmit& emitted)
        {
            consider(emitted.add, emitted.force_all_in);
        });
    };

    if (donk_spot)
    {
        const DonkSelection donk = select_donk(config, kind);
        if (!donk.use_normal_bets)
        {
            emit_list(*donk.specs);
        }
        else
        {
            emit_list(select_bets(config, player, kind));
        }
    }
    else if (!only_multiples)
    {
        emit_list(facing ? select_raises(config, player, kind) : select_bets(config, player, kind));
    }
    if (facing)
    {
        if (!multiples.empty())
        {
            offers = true;
        }
        for (double multiple : multiples)
        {
            if (multiple <= 0.0 || state.committed <= 0)
            {
                continue;
            }
            const int street_total = static_cast<int>(std::llround(
                multiple * static_cast<double>(state.committed)));
            consider(street_total - state.contrib[player], false);
        }
    }
    // All-in is added only when this spot already has a size (including an `a`
    // or `e` token). A blank / explicit-empty list stays check-only.
    if (config.allow_all_in && offers)
    {
        consider(max_add, false);
    }
    if (config.merge_threshold > 0.0)
    {
        merge_close_amounts(amounts, n_amounts, config.merge_threshold);
    }
}

} // namespace poker::streets
