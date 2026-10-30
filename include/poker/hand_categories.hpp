#pragma once

#include "poker/hand_eval.hpp"
#include "poker/range.hpp"

#include <array>
#include <span>
#include <string>
#include <vector>

namespace poker::holdem
{

inline constexpr int kHandCategoryCount = 9;
inline constexpr char kCategoryModel[] = "made-hand";

// Strategy-weighted made-hand category mass for one player on the current board.
// Fractions sum to 1 when defined. This is the current five-card made hand only;
// draws and backdoors are out of scope.
struct PlayerCategoryMass
{
    bool defined = false;
    double total_mass = 0.0;
    std::array<double, kHandCategoryCount> mass{};
    std::array<double, kHandCategoryCount> fraction{};
};

struct CategoryComposition
{
    std::string model = kCategoryModel;
    // False when the board is not five cards. Callers omit or hide the report.
    bool available = false;
    std::string reason;
    std::vector<int> board;
    PlayerCategoryMass player0;
    PlayerCategoryMass player1;
};

// Board must be five distinct cards for available=true. Hole cards that share a
// board card are skipped. Positive reach mass is normalized per player.
CategoryComposition category_composition(
    std::span<const int> board,
    const Range& player0,
    const Range& player1);

std::string category_composition_json(
    const CategoryComposition& report,
    double elapsed_seconds = 0.0);

} // namespace poker::holdem
