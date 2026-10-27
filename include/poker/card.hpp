#pragma once

#include <array>
#include <string>
#include <string_view>
#include <vector>

namespace poker::holdem
{

inline constexpr int kDeckSize = 52;
inline constexpr int kRankCount = 13;
inline constexpr int kSuitCount = 4;
inline constexpr int kComboCount = 1326;

// card = rank * 4 + suit.
// Rank 0 is the deuce and rank 12 is the ace.
// Suit 0 is clubs, 1 diamonds, 2 hearts, 3 spades.

int rank_of(int card);
int suit_of(int card);
int make_card(int rank, int suit);
bool valid_card(int card);

// Accepts "Ah", "Td", "10h", and lowercase. Rank "T" or "10" is a ten.
int parse_card(std::string_view text);
std::string format_card(int card);

// A Hold'em board has 0, 3, 4, or 5 distinct cards.
void validate_board(const int* cards, int count);
void validate_private(int card0, int card1, const int* board, int board_count);

class Deck
{
public:
    Deck();

    bool contains(int card) const;
    void remove(int card);
    int count() const;
    std::vector<int> cards() const;

private:
    std::array<bool, kDeckSize> remaining_{};
    int count_ = kDeckSize;
};

} // namespace poker::holdem
