#pragma once

// Internal betting-tree helpers for StreetBatchSolver. Not a public API.
#include "game/chips.hpp"
#include "game/street_config_text.hpp"
#include "solver/tree_edit.hpp"
#include "poker/hand_eval.hpp"
#include "poker/range.hpp"

#include <algorithm>
#include <cstdint>
#include <limits>
#include <memory_resource>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <psapi.h>
#endif

namespace poker::solver::street_batch_detail
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

inline int betting_streets(const streets::StreetConfig& config)
{
    // Flop: three streets. Turn: two. River: one.
    return 6 - static_cast<int>(config.board.size());
}

inline int round_chips(double fraction, int basis)
{
    return poker::round_chips(fraction, basis);
}

inline std::pmr::string chip_label(
    int code,
    int add,
    int street_total,
    bool all_in,
    bool facing,
    std::pmr::memory_resource* heap)
{
    std::pmr::string text(heap);
    const auto append_number = [&](int tenths)
    {
        const std::string digits = format_chips(tenths);
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


inline std::string compact_action_token(int code, int add, int street_total, bool all_in, bool facing)
{
    if (code == 0)
    {
        return "f";
    }
    if (code == 1)
    {
        return facing ? "call" : "c";
    }
    std::string token =
        facing ? "r" + format_chips(street_total) : "b" + format_chips(add);
    if (all_in)
    {
        token += "ai";
    }
    return token;
}

inline bool token_matches_action(
    std::string_view token,
    int code,
    int add,
    int street_total,
    bool all_in,
    bool facing,
    std::pmr::memory_resource* heap)
{
    if (token == chip_label(code, add, street_total, all_in, facing, heap))
    {
        return true;
    }
    return token == compact_action_token(code, add, street_total, all_in, facing);
}

inline std::string compact_from_display_label(std::string_view label)
{
    if (label == "Fold")
    {
        return "f";
    }
    if (label == "Check")
    {
        return "c";
    }
    if (label == "Call")
    {
        return "call";
    }
    bool all_in = false;
    std::string_view core = label;
    constexpr std::string_view kAllIn = " all-in";
    if (core.size() > kAllIn.size() && core.substr(core.size() - kAllIn.size()) == kAllIn)
    {
        all_in = true;
        core.remove_suffix(kAllIn.size());
    }
    if (core.size() > 4 && core.substr(0, 4) == "Bet ")
    {
        std::string token = "b";
        token.append(core.substr(4));
        if (all_in)
        {
            token += "ai";
        }
        return token;
    }
    constexpr std::string_view kRaise = "Raise to ";
    if (core.size() > kRaise.size() && core.substr(0, kRaise.size()) == kRaise)
    {
        std::string token = "r";
        token.append(core.substr(kRaise.size()));
        if (all_in)
        {
            token += "ai";
        }
        return token;
    }
    return {};
}

inline bool path_token_matches_display(std::string_view token, std::string_view display)
{
    if (token == display)
    {
        return true;
    }
    const std::string compact = compact_from_display_label(display);
    return !compact.empty() && token == compact;
}

inline bool path_matches_public_line(const poker::solver::LinePath& path, std::string_view public_path)
{
    std::vector<std::string_view> steps;
    if (!public_path.empty())
    {
        std::size_t cursor = 0;
        while (true)
        {
            const std::size_t slash = public_path.find('/', cursor);
            if (slash == std::string_view::npos)
            {
                steps.push_back(public_path.substr(cursor));
                break;
            }
            steps.push_back(public_path.substr(cursor, slash - cursor));
            cursor = slash + 1;
        }
    }
    if (path.size() != steps.size())
    {
        return false;
    }
    for (std::size_t i = 0; i < path.steps.size(); ++i)
    {
        if (!path_token_matches_display(path.steps[i].label, steps[i]))
        {
            return false;
        }
    }
    return true;
}

inline bool resolve_add_size_amount(
    const streets::StreetConfig& config, const BetState& state, const poker::solver::LineEdit& edit, int& out_add)
{
    const int player = state.acting;
    const int to_call = state.committed - state.contrib[player];
    const bool facing = to_call > 0;
    const int max_add = config.stack - state.contrib[player];
    if (to_call < 0 || max_add < 0)
    {
        throw std::logic_error("street stack accounting failed");
    }
    // Opening bets do not count as raises; max_raises / 3-bet caps apply only
    // when facing a bet (to_call > 0).
    if (facing && config.max_raises <= state.num_raises)
    {
        return false;
    }
    if (facing && !config.allow_three_bet && state.num_raises >= 1)
    {
        return false;
    }
    const int basis = facing ? state.pot + to_call : state.pot;
    const int sized = edit.uses_chip_size() ? edit.size_chips : round_chips(edit.size_pot_fraction, basis);
    int add = facing ? to_call + sized : sized;
    if (add < 1)
    {
        return false;
    }
    if (add > max_add)
    {
        if (!config.allow_all_in)
        {
            return false;
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
        return false;
    }
    const int min_increment = state.last_raise == 0 ? 1 : state.last_raise;
    const bool full = raise_by >= min_increment;
    const bool shove = state.contrib[player] + add == config.stack;
    if (!full && !(config.allow_all_in && shove))
    {
        return false;
    }
    out_add = add;
    return true;
}

inline void insert_aggressive_amount(Legal& legal, int add)
{
    for (int i = 0; i < legal.count; ++i)
    {
        if (legal.code[i] == 2 && legal.add[i] == add)
        {
            return;
        }
    }
    if (legal.count >= 8)
    {
        throw std::invalid_argument(
            "a street decision has more than 8 actions; use fewer bet sizes");
    }
    int slot = legal.count;
    while (slot > 0 && legal.code[slot - 1] == 2 && legal.add[slot - 1] > add)
    {
        legal.code[slot] = legal.code[slot - 1];
        legal.add[slot] = legal.add[slot - 1];
        --slot;
    }
    legal.code[slot] = 2;
    legal.add[slot] = add;
    ++legal.count;
}

inline void apply_tree_edits(
    Legal& legal,
    const streets::StreetConfig& config,
    const BetState& state,
    std::string_view public_path,
    std::pmr::memory_resource* heap)
{
    if (config.tree_edits.empty())
    {
        return;
    }
    for (const poker::solver::LineEdit& edit : config.tree_edits.edits)
    {
        if (!path_matches_public_line(edit.path, public_path))
        {
            continue;
        }
        const bool facing = state.committed > state.contrib[state.acting];
        if (edit.kind == poker::solver::LineEditKind::AddSize)
        {
            int add = 0;
            if (resolve_add_size_amount(config, state, edit, add))
            {
                insert_aggressive_amount(legal, add);
            }
            continue;
        }
        if (edit.kind == poker::solver::LineEditKind::Force)
        {
            int keep = -1;
            for (int i = 0; i < legal.count; ++i)
            {
                const int street_total = state.contrib[state.acting] + legal.add[i];
                const bool all_in =
                    legal.code[i] != 0 && street_total == config.stack && legal.add[i] > 0;
                if (token_matches_action(
                        edit.action, legal.code[i], legal.add[i], street_total, all_in, facing, heap))
                {
                    keep = i;
                    break;
                }
            }
            if (keep < 0)
            {
                continue;
            }
            legal.code[0] = legal.code[keep];
            legal.add[0] = legal.add[keep];
            legal.count = 1;
            continue;
        }
        if (edit.kind == poker::solver::LineEditKind::Remove)
        {
            Legal filtered;
            for (int i = 0; i < legal.count; ++i)
            {
                const int street_total = state.contrib[state.acting] + legal.add[i];
                const bool all_in =
                    legal.code[i] != 0 && street_total == config.stack && legal.add[i] > 0;
                if (token_matches_action(
                        edit.action, legal.code[i], legal.add[i], street_total, all_in, facing, heap))
                {
                    continue;
                }
                filtered.code[filtered.count] = legal.code[i];
                filtered.add[filtered.count] = legal.add[i];
                ++filtered.count;
            }
            legal = filtered;
        }
    }
}

inline Legal legal_actions(const streets::StreetConfig& config, const BetState& state)
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
    streets::fill_aggressive_amounts(
        config, state, betting_streets(config), amounts, n_amounts);

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

inline void finish_street(const streets::StreetConfig& config, BetState& state)
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

inline BetState apply_action(const streets::StreetConfig& config, BetState state, const Legal& legal, int action)
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
    // Count only true raises (facing a bet). The first aggression on a street
    // is an opening bet and does not consume max_raises.
    if (to_call > 0)
    {
        state.num_raises += 1;
    }
    state.street_aggressor = player;
    state.acting = 1 - player;
    return state;
}

inline std::uint64_t checked_add(std::uint64_t left, std::uint64_t right, const char* what)
{
    if (left > std::numeric_limits<std::uint64_t>::max() - right)
    {
        throw std::invalid_argument(std::string(what) + " overflowed");
    }
    return left + right;
}

inline std::uint64_t checked_mul(std::uint64_t left, std::uint64_t right, const char* what)
{
    if (left != 0 && right > std::numeric_limits<std::uint64_t>::max() / left)
    {
        throw std::invalid_argument(std::string(what) + " overflowed");
    }
    return left * right;
}

inline std::uint64_t budget_bytes(int mib)
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

inline std::uint64_t process_peak_working_set_bytes()
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

inline std::uint32_t pack_rank(const holdem::HandValue& value)
{
    std::uint32_t rank = static_cast<std::uint32_t>(value.category);
    for (int i = 0; i < 5; ++i)
    {
        rank = rank * 16u + static_cast<std::uint32_t>(value.tiebreak[i]);
    }
    return rank;
}

}  // namespace poker::solver::street_batch_detail
