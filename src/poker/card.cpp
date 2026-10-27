#include "poker/card.hpp"

#include <stdexcept>

namespace poker::holdem
{
namespace
{

[[noreturn]] void invalid(const std::string& message)
{
    throw std::invalid_argument(message);
}

int rank_from_char(char character)
{
    switch (character)
    {
    case '2': return 0;
    case '3': return 1;
    case '4': return 2;
    case '5': return 3;
    case '6': return 4;
    case '7': return 5;
    case '8': return 6;
    case '9': return 7;
    case 'T':
    case 't': return 8;
    case 'J':
    case 'j': return 9;
    case 'Q':
    case 'q': return 10;
    case 'K':
    case 'k': return 11;
    case 'A':
    case 'a': return 12;
    default: return -1;
    }
}

int suit_from_char(char character)
{
    switch (character)
    {
    case 'c':
    case 'C': return 0;
    case 'd':
    case 'D': return 1;
    case 'h':
    case 'H': return 2;
    case 's':
    case 'S': return 3;
    default: return -1;
    }
}

} // namespace

int rank_of(int card)
{
    return card / kSuitCount;
}

int suit_of(int card)
{
    return card % kSuitCount;
}

int make_card(int rank, int suit)
{
    return rank * kSuitCount + suit;
}

bool valid_card(int card)
{
    return card >= 0 && card < kDeckSize;
}

int parse_card(std::string_view text)
{
    if (text.size() == 3 && text[0] == '1' && text[1] == '0')
    {
        const int suit = suit_from_char(text[2]);
        if (suit < 0)
        {
            invalid("bad suit in card");
        }
        return make_card(8, suit);
    }
    if (text.size() != 2)
    {
        invalid("card must be a rank and a suit, such as Ah or Td");
    }
    const int rank = rank_from_char(text[0]);
    const int suit = suit_from_char(text[1]);
    if (rank < 0 || suit < 0)
    {
        invalid(std::string("cannot parse card ") + std::string(text));
    }
    return make_card(rank, suit);
}

std::string format_card(int card)
{
    if (!valid_card(card))
    {
        invalid("cannot format an invalid card");
    }
    static const char ranks[] = "23456789TJQKA";
    static const char suits[] = "cdhs";
    std::string text;
    text.push_back(ranks[rank_of(card)]);
    text.push_back(suits[suit_of(card)]);
    return text;
}

void validate_board(const int* cards, int count)
{
    if (count != 0 && count != 3 && count != 4 && count != 5)
    {
        invalid("a Hold'em board has 0, 3, 4, or 5 cards");
    }
    for (int i = 0; i < count; ++i)
    {
        if (!valid_card(cards[i]))
        {
            invalid("board contains an invalid card");
        }
        for (int j = 0; j < i; ++j)
        {
            if (cards[i] == cards[j])
            {
                invalid("board contains a duplicate card");
            }
        }
    }
}

void validate_private(int card0, int card1, const int* board, int board_count)
{
    if (!valid_card(card0) || !valid_card(card1) || card0 == card1)
    {
        invalid("a private hand is two distinct cards");
    }
    for (int i = 0; i < board_count; ++i)
    {
        if (board[i] == card0 || board[i] == card1)
        {
            invalid("private hand uses a board card");
        }
    }
}

Deck::Deck()
{
    remaining_.fill(true);
}

bool Deck::contains(int card) const
{
    return valid_card(card) && remaining_[static_cast<std::size_t>(card)];
}

void Deck::remove(int card)
{
    if (!contains(card))
    {
        invalid("cannot remove a card that is not in the deck");
    }
    remaining_[static_cast<std::size_t>(card)] = false;
    --count_;
}

int Deck::count() const
{
    return count_;
}

std::vector<int> Deck::cards() const
{
    std::vector<int> out;
    out.reserve(static_cast<std::size_t>(count_));
    for (int card = 0; card < kDeckSize; ++card)
    {
        if (remaining_[static_cast<std::size_t>(card)])
        {
            out.push_back(card);
        }
    }
    return out;
}

} // namespace poker::holdem
