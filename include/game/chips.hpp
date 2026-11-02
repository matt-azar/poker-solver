#pragma once

#include <charconv>
#include <cmath>
#include <stdexcept>
#include <string>
#include <string_view>

namespace poker
{

// Fixed-point chips stored as integer tenths of a chip (scale 10).
// Config / JSON / CLI values are written in chip units (pot 100 → 100.0 chips →
// 1000 tenths). Tree accounting (pot, stack, contrib, add, committed, last_raise)
// stays in tenths. Terminal utilities and reported EV convert back to chips.
using Chip = int;

inline constexpr int kChipScale = 10;
// Minimum aggressive add / opening bet: 0.1 chip.
inline constexpr Chip kMinChipAdd = 1;

inline constexpr Chip chip_units(int whole_chips) noexcept
{
    return whole_chips * kChipScale;
}

inline Chip chips_to_tenths(double chips)
{
    if (!std::isfinite(chips))
    {
        throw std::invalid_argument("chip amount must be finite");
    }
    return static_cast<Chip>(std::llround(chips * static_cast<double>(kChipScale)));
}

inline constexpr double tenths_to_chips(Chip tenths) noexcept
{
    return static_cast<double>(tenths) / static_cast<double>(kChipScale);
}

// Pot-fraction sizing: basis is already tenths, so the product is tenths.
inline Chip round_chips(double fraction, Chip basis_tenths)
{
    if (basis_tenths < 0)
    {
        throw std::logic_error("negative sizing basis");
    }
    return static_cast<Chip>(
        std::llround(fraction * static_cast<double>(basis_tenths)));
}

// Absolute chip amount from a negative size-list entry (-20 → 20.0 chips).
inline Chip absolute_chips_to_tenths(double absolute_chips)
{
    return chips_to_tenths(absolute_chips);
}

// Format tenths as a chip amount for labels / config. Whole chips omit ".0"
// when trim_whole is true ("100"); otherwise one decimal ("3.8", "100.0").
inline std::string format_chips(Chip tenths, bool trim_whole = true)
{
    const bool negative = tenths < 0;
    const Chip magnitude = negative ? -tenths : tenths;
    const Chip whole = magnitude / kChipScale;
    const Chip frac = magnitude % kChipScale;
    std::string text;
    if (negative)
    {
        text.push_back('-');
    }
    text += std::to_string(whole);
    if (!(trim_whole && frac == 0))
    {
        text.push_back('.');
        text.push_back(static_cast<char>('0' + frac));
    }
    return text;
}

// Parse a chip amount from text ("100", "5.0", "3.8") into tenths.
inline Chip parse_chips(std::string_view text)
{
    if (text.empty())
    {
        throw std::invalid_argument("empty chip amount");
    }
    double value = 0.0;
    const char* const begin = text.data();
    const char* const end = begin + text.size();
    const std::from_chars_result result = std::from_chars(begin, end, value);
    if (result.ec != std::errc{} || result.ptr != end || !std::isfinite(value))
    {
        throw std::invalid_argument("bad chip amount");
    }
    return chips_to_tenths(value);
}

} // namespace poker
