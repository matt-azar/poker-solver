#pragma once

// PioSOLVER-style size tokens stored in the existing double lists.
//
//   spec >= 0                         pot fraction (0.75 = 75% pot)
//   -1e8 < spec < 0                   fixed chips of -spec (20c → -20)
//   spec == kAllInSpec (-1e9)         all-in token `a` (always offered)
//   kGeoBase - N (-2e9 - N)           geometric. N = 0 is bare `e`
//                                     (flop 3 streets, turn 2, river 1).
//                                     N >= 1 is `Ne` (N equal pot-fraction bets).
//   kMultipleBase - m (-3e9 - m)      raise-to m times the bet faced (`2.5x`)
//   kExplicitEmptySpec (-4e9)         this list is set and empty (forced check /
//                                     no raise / no donk). A missing or zero-length
//                                     list still falls back to the shared list.

#include "game/chips.hpp"

#include <algorithm>
#include <charconv>
#include <cmath>
#include <string>
#include <string_view>
#include <vector>

namespace poker::streets
{

inline constexpr double kChipSpecFloor = -1.0e8;
inline constexpr double kAllInSpec = -1.0e9;
inline constexpr double kGeoBase = -2.0e9;
inline constexpr double kMultipleBase = -3.0e9;
inline constexpr double kExplicitEmptySpec = -4.0e9;

inline bool is_chip_spec(double spec)
{
    return spec < 0.0 && spec > kChipSpecFloor;
}

inline bool is_all_in_spec(double spec)
{
    return spec < -5.0e8 && spec > -1.5e9;
}

inline bool is_geometric_spec(double spec)
{
    return spec <= kGeoBase + 0.5 && spec > kMultipleBase + 0.5;
}

inline bool is_multiple_spec(double spec)
{
    return spec <= kMultipleBase + 0.5 && spec > kExplicitEmptySpec + 0.5;
}

inline bool is_explicit_empty_spec(double spec)
{
    return spec <= kExplicitEmptySpec + 0.5 && spec > kExplicitEmptySpec - 1.0e6;
}

inline bool is_explicit_empty_list(const std::vector<double>& specs)
{
    return specs.size() == 1 && is_explicit_empty_spec(specs[0]);
}

// True when the list names at least one bet, raise, geometric, all-in, or multiple.
inline bool list_offers_size(const std::vector<double>& specs)
{
    if (is_explicit_empty_list(specs))
    {
        return false;
    }
    for (double spec : specs)
    {
        if (!is_explicit_empty_spec(spec))
        {
            return true;
        }
    }
    return false;
}

inline const std::vector<double>& empty_size_list()
{
    static const std::vector<double> kEmpty;
    return kEmpty;
}

inline int geometric_streets_of(double spec)
{
    return static_cast<int>(std::llround(-(spec - kGeoBase)));
}

inline double multiple_of(double spec)
{
    return -(spec - kMultipleBase);
}

inline double geometric_spec(int streets)
{
    if (streets < 0)
    {
        streets = 0;
    }
    return kGeoBase - static_cast<double>(streets);
}

inline double multiple_spec(double multiple)
{
    return kMultipleBase - multiple;
}

inline double explicit_empty_spec()
{
    return kExplicitEmptySpec;
}

// Pot fraction that invests stack_left over streets_left equal called bets.
// One street left returns the all-in fraction. Pio's `e` / `Ne` use this split:
//   ((1 + 2E/P) ^ (1/S) - 1) / 2
inline double geometric_pot_fraction(int pot, int stack_left, int streets_left)
{
    if (pot <= 0 || stack_left <= 0 || streets_left <= 0)
    {
        return 0.0;
    }
    if (streets_left == 1)
    {
        return static_cast<double>(stack_left) / static_cast<double>(pot);
    }
    const double ratio = 1.0 + 2.0 * static_cast<double>(stack_left) / static_cast<double>(pot);
    const double root = std::pow(ratio, 1.0 / static_cast<double>(streets_left));
    return (root - 1.0) / 2.0;
}

// Bare `e` uses streets_left. `Ne` uses N. A raise subtracts raises already
// made on this street (the opening bet does not count), and never goes below 1.
inline int geometric_street_count(int encoded, int streets_left, bool facing, int num_raises)
{
    const int base = encoded <= 0 ? std::max(streets_left, 1) : encoded;
    if (!facing)
    {
        return std::max(base, 1);
    }
    const int left = base - std::max(num_raises, 0);
    return std::max(left, 1);
}

struct SpecContext
{
    int basis = 0;
    int to_call = 0;
    int contrib = 0;
    int max_add = 0;
    int committed = 0;
    int streets_left = 1;
    int num_raises = 0;
    bool facing = false;
};

struct SpecEmit
{
    int add = 0;
    bool force_all_in = false;
};

inline int chips_from_listed_spec(double spec, int basis)
{
    if (is_chip_spec(spec))
    {
        return poker::absolute_chips_to_tenths(-spec);
    }
    if (spec < 0.0)
    {
        return 0;
    }
    return poker::round_chips(spec, basis);
}

// Expand one Pio size list into chip adds at this node. Sentinels that are not
// bets (`-` explicit-empty) are skipped. The caller still applies min-raise,
// pot-cap, and stack clamps.
template <typename Fn>
void for_each_spec_add(const std::vector<double>& specs, const SpecContext& ctx, Fn&& fn)
{
    if (is_explicit_empty_list(specs))
    {
        return;
    }
    for (double spec : specs)
    {
        if (is_explicit_empty_spec(spec))
        {
            continue;
        }
        if (is_all_in_spec(spec))
        {
            fn(SpecEmit{ctx.max_add, true});
            continue;
        }
        if (is_geometric_spec(spec))
        {
            const int streets = geometric_street_count(
                geometric_streets_of(spec), ctx.streets_left, ctx.facing, ctx.num_raises);
            const int stack_left = ctx.facing
                ? std::max(0, ctx.max_add - ctx.to_call)
                : std::max(0, ctx.max_add);
            const double fraction = geometric_pot_fraction(ctx.basis, stack_left, streets);
            const int sized = poker::round_chips(fraction, ctx.basis);
            fn(SpecEmit{ctx.facing ? ctx.to_call + sized : sized, false});
            continue;
        }
        if (is_multiple_spec(spec))
        {
            if (!ctx.facing || ctx.committed <= 0)
            {
                continue;
            }
            const double multiple = multiple_of(spec);
            if (!(multiple > 0.0))
            {
                continue;
            }
            const int street_total = static_cast<int>(std::llround(
                multiple * static_cast<double>(ctx.committed)));
            fn(SpecEmit{street_total - ctx.contrib, false});
            continue;
        }
        const int sized = chips_from_listed_spec(spec, ctx.basis);
        fn(SpecEmit{ctx.facing ? ctx.to_call + sized : sized, false});
    }
}

// Keep the larger chip amount when two sizes land within threshold (a fraction,
// 0.10 = 10%). Pio keeps the highest of the bets that sit inside the threshold.
inline void merge_close_amounts(int* amounts, int& count, double threshold_fraction)
{
    if (!(threshold_fraction > 0.0) || count < 2)
    {
        return;
    }
    int write = 0;
    for (int index = 0; index < count; ++index)
    {
        if (write == 0)
        {
            amounts[write++] = amounts[index];
            continue;
        }
        const int previous = amounts[write - 1];
        const int current = amounts[index];
        const int denom = std::max(previous, current);
        const int gap = previous > current ? previous - current : current - previous;
        if (denom > 0
            && static_cast<double>(gap) <= threshold_fraction * static_cast<double>(denom))
        {
            amounts[write - 1] = std::max(previous, current);
            continue;
        }
        amounts[write++] = current;
    }
    count = write;
}

inline std::string format_spec(double spec)
{
    if (is_explicit_empty_spec(spec))
    {
        return "-";
    }
    if (is_all_in_spec(spec))
    {
        return "a";
    }
    if (is_geometric_spec(spec))
    {
        const int streets = geometric_streets_of(spec);
        if (streets <= 0)
        {
            return "e";
        }
        return std::to_string(streets) + "e";
    }
    if (is_multiple_spec(spec))
    {
        char buffer[64];
        const double multiple = multiple_of(spec);
        const std::to_chars_result result = std::to_chars(
            buffer, buffer + sizeof(buffer), multiple, std::chars_format::general);
        if (result.ec != std::errc{})
        {
            return "x";
        }
        std::string text(buffer, result.ptr);
        text.push_back('x');
        return text;
    }
    if (spec < 0.0)
    {
        char buffer[64];
        const std::to_chars_result result = std::to_chars(
            buffer, buffer + sizeof(buffer), -spec, std::chars_format::general);
        if (result.ec != std::errc{})
        {
            return "0c";
        }
        std::string text(buffer, result.ptr);
        text.push_back('c');
        return text;
    }
    char buffer[64];
    const std::to_chars_result result = std::to_chars(
        buffer, buffer + sizeof(buffer), spec, std::chars_format::general);
    if (result.ec != std::errc{})
    {
        return "0";
    }
    return std::string(buffer, result.ptr);
}

// Parse one token into a stored spec. `allow_multiple` is false on bet/donk
// lists (`2.5x` is a raise size). Returns false and sets error on a bad token.
inline bool parse_size_token(std::string_view token, bool allow_multiple, double& out, std::string& error)
{
    if (token.empty() || token == "-")
    {
        out = kExplicitEmptySpec;
        return true;
    }
    std::string lower(token);
    for (char& character : lower)
    {
        if (character >= 'A' && character <= 'Z')
        {
            character = static_cast<char>(character - 'A' + 'a');
        }
    }
    if (lower == "a" || lower == "allin" || lower == "all-in")
    {
        out = kAllInSpec;
        return true;
    }
    if (lower == "none" || lower == "x")
    {
        out = kExplicitEmptySpec;
        return true;
    }
    if (!lower.empty() && lower.back() == 'e')
    {
        const std::string_view prefix(lower.data(), lower.size() - 1);
        int streets = 0;
        if (!prefix.empty())
        {
            const char* begin = prefix.data();
            const char* end = begin + prefix.size();
            const std::from_chars_result parsed = std::from_chars(begin, end, streets);
            if (parsed.ec != std::errc{} || parsed.ptr != end || streets <= 0 || streets > 100)
            {
                error = "geometric size must be e, 2e, 3e, …";
                return false;
            }
        }
        out = geometric_spec(streets);
        return true;
    }
    if (!lower.empty() && lower.back() == 'x')
    {
        if (!allow_multiple)
        {
            error = "a bet size cannot be a multiple; put 2.5x on a raise list";
            return false;
        }
        const std::string_view prefix(lower.data(), lower.size() - 1);
        double multiple = 0.0;
        const char* begin = prefix.data();
        const char* end = begin + prefix.size();
        const std::from_chars_result parsed = std::from_chars(begin, end, multiple);
        if (parsed.ec != std::errc{} || parsed.ptr != end || !(multiple > 0.0))
        {
            error = "a raise multiple must look like 2.5x";
            return false;
        }
        out = multiple_spec(multiple);
        return true;
    }
    if (!lower.empty() && lower.back() == '%')
    {
        const std::string_view prefix(lower.data(), lower.size() - 1);
        double percent = 0.0;
        const char* begin = prefix.data();
        const char* end = begin + prefix.size();
        const std::from_chars_result parsed = std::from_chars(begin, end, percent);
        if (parsed.ec != std::errc{} || parsed.ptr != end || !std::isfinite(percent))
        {
            error = "a percent size must look like 75%";
            return false;
        }
        out = percent / 100.0;
        return true;
    }
    if (!lower.empty() && lower.back() == 'c')
    {
        const std::string_view prefix(lower.data(), lower.size() - 1);
        double chips = 0.0;
        const char* begin = prefix.data();
        const char* end = begin + prefix.size();
        const std::from_chars_result parsed = std::from_chars(begin, end, chips);
        if (parsed.ec != std::errc{} || parsed.ptr != end || !(chips > 0.0))
        {
            error = "a chip size must be a positive amount such as 20c";
            return false;
        }
        out = -chips;
        return true;
    }
    double fraction = 0.0;
    const char* begin = lower.data();
    const char* end = begin + lower.size();
    const std::from_chars_result parsed = std::from_chars(begin, end, fraction);
    if (parsed.ec != std::errc{} || parsed.ptr != end || !std::isfinite(fraction) || fraction < 0.0)
    {
        error = "a size must be a pot fraction, 75%, 20c, e, 2e, 3e, a, or 2.5x";
        return false;
    }
    out = fraction;
    return true;
}

} // namespace poker::streets
