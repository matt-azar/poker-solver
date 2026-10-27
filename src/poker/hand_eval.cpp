#include "poker/hand_eval.hpp"

#include "poker/card.hpp"

#include <array>
#include <stdexcept>

namespace poker::holdem
{
namespace
{

[[noreturn]] void bad_hand(const char* message)
{
    throw std::invalid_argument(message);
}

bool better_rank(const HandValue& left, const HandValue& right)
{
    if (left.category != right.category)
    {
        return static_cast<int>(left.category) > static_cast<int>(right.category);
    }
    for (int i = 0; i < 5; ++i)
    {
        if (left.tiebreak[i] != right.tiebreak[i])
        {
            return left.tiebreak[i] > right.tiebreak[i];
        }
    }
    return false;
}

HandValue score_five(const std::array<int, 5>& cards)
{
    int rank_count[kRankCount] = {};
    int suit_count[kSuitCount] = {};
    for (int card : cards)
    {
        if (!valid_card(card))
        {
            bad_hand("hand contains an invalid card");
        }
        ++rank_count[rank_of(card)];
        ++suit_count[suit_of(card)];
    }

    bool flush = false;
    for (int count : suit_count)
    {
        if (count == 5)
        {
            flush = true;
        }
    }

    bool present[kRankCount] = {};
    for (int rank = 0; rank < kRankCount; ++rank)
    {
        present[rank] = rank_count[rank] > 0;
    }

    int straight_top = -1;
    for (int top = 12; top >= 4; --top)
    {
        bool consecutive = true;
        for (int step = 0; step < 5; ++step)
        {
            if (!present[top - step])
            {
                consecutive = false;
                break;
            }
        }
        if (consecutive)
        {
            straight_top = top;
            break;
        }
    }
    if (straight_top < 0 && present[12] && present[0] && present[1] && present[2] && present[3])
    {
        // A-2-3-4-5. The five is the top rank, so this loses to a six-high straight.
        straight_top = 3;
    }

    HandValue value;
    if (flush && straight_top >= 0)
    {
        value.category = HandCategory::StraightFlush;
        value.tiebreak[0] = straight_top;
        return value;
    }

    int four = -1;
    int three = -1;
    int pairs[2] = {-1, -1};
    int pair_count = 0;
    int singles[5] = {};
    int single_count = 0;
    for (int rank = kRankCount - 1; rank >= 0; --rank)
    {
        if (rank_count[rank] == 4)
        {
            four = rank;
        }
        else if (rank_count[rank] == 3)
        {
            three = rank;
        }
        else if (rank_count[rank] == 2)
        {
            pairs[pair_count++] = rank;
        }
        else if (rank_count[rank] == 1)
        {
            singles[single_count++] = rank;
        }
    }

    if (four >= 0)
    {
        value.category = HandCategory::FourOfAKind;
        value.tiebreak[0] = four;
        value.tiebreak[1] = singles[0];
        return value;
    }
    if (three >= 0 && pair_count == 1)
    {
        value.category = HandCategory::FullHouse;
        value.tiebreak[0] = three;
        value.tiebreak[1] = pairs[0];
        return value;
    }
    if (flush)
    {
        value.category = HandCategory::Flush;
        for (int i = 0; i < single_count; ++i)
        {
            value.tiebreak[i] = singles[i];
        }
        return value;
    }
    if (straight_top >= 0)
    {
        value.category = HandCategory::Straight;
        value.tiebreak[0] = straight_top;
        return value;
    }
    if (three >= 0)
    {
        value.category = HandCategory::ThreeOfAKind;
        value.tiebreak[0] = three;
        value.tiebreak[1] = singles[0];
        value.tiebreak[2] = singles[1];
        return value;
    }
    if (pair_count == 2)
    {
        value.category = HandCategory::TwoPair;
        value.tiebreak[0] = pairs[0];
        value.tiebreak[1] = pairs[1];
        value.tiebreak[2] = singles[0];
        return value;
    }
    if (pair_count == 1)
    {
        value.category = HandCategory::Pair;
        value.tiebreak[0] = pairs[0];
        value.tiebreak[1] = singles[0];
        value.tiebreak[2] = singles[1];
        value.tiebreak[3] = singles[2];
        return value;
    }

    value.category = HandCategory::HighCard;
    for (int i = 0; i < single_count; ++i)
    {
        value.tiebreak[i] = singles[i];
    }
    return value;
}

template <typename Consumer>
void for_each_five(std::span<const int> cards, Consumer consumer)
{
    const int count = static_cast<int>(cards.size());
    if (count == 5)
    {
        std::array<int, 5> hand{};
        for (int i = 0; i < 5; ++i)
        {
            hand[static_cast<std::size_t>(i)] = cards[static_cast<std::size_t>(i)];
        }
        consumer(hand);
        return;
    }
    if (count == 6)
    {
        for (int skip = 0; skip < 6; ++skip)
        {
            std::array<int, 5> hand{};
            int filled = 0;
            for (int i = 0; i < 6; ++i)
            {
                if (i == skip)
                {
                    continue;
                }
                hand[static_cast<std::size_t>(filled++)] = cards[static_cast<std::size_t>(i)];
            }
            consumer(hand);
        }
        return;
    }
    for (int skip0 = 0; skip0 < 7; ++skip0)
    {
        for (int skip1 = skip0 + 1; skip1 < 7; ++skip1)
        {
            std::array<int, 5> hand{};
            int filled = 0;
            for (int i = 0; i < 7; ++i)
            {
                if (i == skip0 || i == skip1)
                {
                    continue;
                }
                hand[static_cast<std::size_t>(filled++)] = cards[static_cast<std::size_t>(i)];
            }
            consumer(hand);
        }
    }
}

} // namespace

bool operator==(const HandValue& left, const HandValue& right)
{
    if (left.category != right.category)
    {
        return false;
    }
    for (int i = 0; i < 5; ++i)
    {
        if (left.tiebreak[i] != right.tiebreak[i])
        {
            return false;
        }
    }
    return true;
}

bool operator<(const HandValue& left, const HandValue& right)
{
    return better_rank(right, left);
}

std::string_view category_name(HandCategory category)
{
    switch (category)
    {
    case HandCategory::HighCard: return "high card";
    case HandCategory::Pair: return "pair";
    case HandCategory::TwoPair: return "two pair";
    case HandCategory::ThreeOfAKind: return "three of a kind";
    case HandCategory::Straight: return "straight";
    case HandCategory::Flush: return "flush";
    case HandCategory::FullHouse: return "full house";
    case HandCategory::FourOfAKind: return "four of a kind";
    case HandCategory::StraightFlush: return "straight flush";
    }
    return "unknown";
}

HandValue evaluate(std::span<const int> cards)
{
    const int count = static_cast<int>(cards.size());
    if (count < 5 || count > 7)
    {
        bad_hand("evaluate expects 5, 6, or 7 cards");
    }
    for (int i = 0; i < count; ++i)
    {
        if (!valid_card(cards[static_cast<std::size_t>(i)]))
        {
            bad_hand("evaluate received an invalid card");
        }
        for (int j = 0; j < i; ++j)
        {
            if (cards[static_cast<std::size_t>(i)] == cards[static_cast<std::size_t>(j)])
            {
                bad_hand("evaluate received a duplicate card");
            }
        }
    }

    HandValue best;
    bool have_best = false;
    for_each_five(cards, [&](const std::array<int, 5>& hand)
    {
        const HandValue value = score_five(hand);
        if (!have_best || better_rank(value, best))
        {
            best = value;
            have_best = true;
        }
    });
    return best;
}

int compare_values(const HandValue& left, const HandValue& right)
{
    if (left == right)
    {
        return 0;
    }
    return better_rank(left, right) ? 1 : -1;
}

int compare_showdown(int left0, int left1, int right0, int right1, std::span<const int> board)
{
    validate_board(board.data(), static_cast<int>(board.size()));
    if (board.empty())
    {
        bad_hand("showdown requires a flop, turn, or river");
    }
    validate_private(left0, left1, board.data(), static_cast<int>(board.size()));
    validate_private(right0, right1, board.data(), static_cast<int>(board.size()));
    if (left0 == right0 || left0 == right1 || left1 == right0 || left1 == right1)
    {
        bad_hand("showdown hands share a card");
    }

    std::array<int, 7> left_cards{};
    std::array<int, 7> right_cards{};
    const int total = 2 + static_cast<int>(board.size());
    left_cards[0] = left0;
    left_cards[1] = left1;
    right_cards[0] = right0;
    right_cards[1] = right1;
    for (int i = 0; i < static_cast<int>(board.size()); ++i)
    {
        left_cards[static_cast<std::size_t>(2 + i)] = board[static_cast<std::size_t>(i)];
        right_cards[static_cast<std::size_t>(2 + i)] = board[static_cast<std::size_t>(i)];
    }
    return compare_values(
        evaluate(std::span<const int>(left_cards.data(), static_cast<std::size_t>(total))),
        evaluate(std::span<const int>(right_cards.data(), static_cast<std::size_t>(total))));
}

} // namespace poker::holdem
