#pragma once

#include <span>
#include <string_view>

namespace poker::holdem
{

// Category order is the poker order. Straight flush is best. An ace-high
// straight flush is a royal flush; it is not a separate category.
enum class HandCategory
{
    HighCard = 0,
    Pair = 1,
    TwoPair = 2,
    ThreeOfAKind = 3,
    Straight = 4,
    Flush = 5,
    FullHouse = 6,
    FourOfAKind = 7,
    StraightFlush = 8
};

struct HandValue
{
    HandCategory category = HandCategory::HighCard;
    int tiebreak[5] = {};

    friend bool operator==(const HandValue& left, const HandValue& right);
    friend bool operator<(const HandValue& left, const HandValue& right);
};

std::string_view category_name(HandCategory category);

// Cards must be 5, 6, or 7 distinct valid cards. The value is the best
// five-card hand inside that set.
HandValue evaluate(std::span<const int> cards);

// Positive if left wins, negative if right wins, zero on a tie.
int compare_values(const HandValue& left, const HandValue& right);

// Positive if the first hole cards win at showdown.
int compare_showdown(int left0, int left1, int right0, int right1, std::span<const int> board);

} // namespace poker::holdem
