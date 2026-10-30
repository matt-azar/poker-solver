#pragma once

#include <cmath>
#include <stdexcept>

namespace poker::solver
{

// Pot-rake taken from the terminal pot before winner attribution.
//
// rate is a fraction of pot chips in [0, 1]. cap is a chip ceiling; cap == 0
// means uncapped. Collection uses whole chips: floor(rate * pot), then min with
// cap when cap > 0. See docs/RAKE.md.
struct RakeConfig
{
    double rate = 0.0;
    double cap = 0.0;

    bool valid() const noexcept
    {
        return rate >= 0.0 && rate <= 1.0 && cap >= 0.0
            && std::isfinite(rate) && std::isfinite(cap);
    }

    void validate() const
    {
        if (!valid())
        {
            throw std::invalid_argument("rake rate must be in [0, 1] and cap >= 0");
        }
    }
};

// Rake chips removed from pot_chips. Invalid configs are rejected by validate();
// this helper returns 0 for nonpositive pots or a zero rate.
inline double collect(double pot_chips, const RakeConfig& rake) noexcept
{
    if (!(pot_chips > 0.0) || !(rake.rate > 0.0))
    {
        return 0.0;
    }
    double taken = std::floor(rake.rate * pot_chips);
    if (rake.cap > 0.0 && taken > rake.cap)
    {
        taken = rake.cap;
    }
    if (taken > pot_chips)
    {
        taken = pot_chips;
    }
    return taken;
}

} // namespace poker::solver
