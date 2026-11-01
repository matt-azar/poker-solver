#pragma once

#include "poker/hand_eval.hpp"
#include "poker/range.hpp"

#include <array>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace poker::holdem
{

inline constexpr int kHandCategoryCount = 9;
inline constexpr char kCategoryModel[] = "made-hand";

// Multi-label draw / backdoor tags for flop and turn boards. A combo may set
// more than one flag, so seat fractions need not sum to 1.
inline constexpr int kDrawCategoryCount = 5;
inline constexpr char kDrawCategoryModel[] = "draws";

enum class DrawCategory
{
    FlushDraw = 0,
    Oesd = 1,
    Gutshot = 2,
    BackdoorFlush = 3,
    BackdoorStraight = 4
};

// Strategy-weighted category mass for one player on the current board.
// For model "made-hand", fractions sum to 1 when defined (exclusive).
// For model "draws", each fraction is the share of positive reach mass that
// carries that draw/backdoor tag (multi-label; sum may exceed 1).
struct PlayerCategoryMass
{
    bool defined = false;
    double total_mass = 0.0;
    std::vector<double> mass;
    std::vector<double> fraction;
};

struct CategoryComposition
{
    std::string model = kCategoryModel;
    // True when the board length supports the selected model (3/4 for draws,
    // 5 for made-hand). Callers omit or hide the report when false.
    bool available = false;
    // False for multi-label draw tags; true for exclusive made-hand buckets.
    bool exclusive = true;
    std::string reason;
    std::vector<int> board;
    std::vector<std::string> categories;
    PlayerCategoryMass player0;
    PlayerCategoryMass player1;
};

std::string_view draw_category_name(DrawCategory category);

// Classify flush/straight draws and flop backdoors for one hole combo.
// Board length must be 3 or 4. Hole cards that collide with the board yield
// all-false flags. Made straights/flushes suppress the matching draw tags.
struct DrawFlags
{
    bool flush_draw = false;
    bool oesd = false;
    bool gutshot = false;
    bool backdoor_flush = false;
    bool backdoor_straight = false;
};

DrawFlags classify_draws(int hole0, int hole1, std::span<const int> board);

// Board length 5 → made-hand model. Board length 3 or 4 → draws model.
// Other lengths set available=false. Hole cards that share a board card are
// skipped. Positive reach mass is normalized per player against total_mass.
CategoryComposition category_composition(
    std::span<const int> board,
    const Range& player0,
    const Range& player1);

std::string category_composition_json(
    const CategoryComposition& report,
    double elapsed_seconds = 0.0);

} // namespace poker::holdem
