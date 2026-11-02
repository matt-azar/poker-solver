#pragma once

#include "poker/card.hpp"
#include "poker/range.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <span>
#include <vector>

namespace poker::holdem
{

// Suit permutation: new_suit = perm[old_suit]. The 24 elements of S4 act on
// cards by (rank, suit) -> (rank, perm[suit]). Exact suit isomorphism for a
// fixed board keeps only those permutations that map the board set to itself
// and leave both players' combo weights unchanged.
using SuitPerm = std::array<int, kSuitCount>;

inline constexpr double kSuitIsoWeightTol = 1e-12;

inline SuitPerm identity_suit_perm()
{
    return SuitPerm{0, 1, 2, 3};
}

inline int map_card(int card, const SuitPerm& perm)
{
    if (card < 0)
    {
        return card;
    }
    return make_card(rank_of(card), perm[static_cast<std::size_t>(suit_of(card))]);
}

inline int map_combo_index(int combo, const SuitPerm& perm)
{
    int c0 = 0;
    int c1 = 0;
    Range::combo_cards(combo, c0, c1);
    return Range::combo_index(map_card(c0, perm), map_card(c1, perm));
}

// All 24 suit permutations.
inline std::vector<SuitPerm> all_suit_perms()
{
    std::vector<SuitPerm> out;
    out.reserve(24);
    SuitPerm perm = identity_suit_perm();
    do
    {
        out.push_back(perm);
    } while (std::next_permutation(perm.begin(), perm.end()));
    return out;
}

inline bool board_set_equal(std::span<const int> left, std::span<const int> right)
{
    if (left.size() != right.size())
    {
        return false;
    }
    std::vector<int> a(left.begin(), left.end());
    std::vector<int> b(right.begin(), right.end());
    std::sort(a.begin(), a.end());
    std::sort(b.begin(), b.end());
    return a == b;
}

// Suit permutations that map the board card set to itself.
inline std::vector<SuitPerm> board_suit_stabilizer(std::span<const int> board)
{
    std::vector<SuitPerm> group;
    group.reserve(8);
    int mapped[5];
    for (const SuitPerm& perm : all_suit_perms())
    {
        for (std::size_t i = 0; i < board.size(); ++i)
        {
            mapped[i] = map_card(board[i], perm);
        }
        if (board_set_equal(board, std::span<const int>(mapped, board.size())))
        {
            group.push_back(perm);
        }
    }
    return group;
}

inline bool range_invariant_under(const Range& range, const SuitPerm& perm)
{
    const std::array<double, kComboCount>& w = range.weights();
    for (int combo = 0; combo < kComboCount; ++combo)
    {
        const int image = map_combo_index(combo, perm);
        if (std::abs(w[static_cast<std::size_t>(combo)] - w[static_cast<std::size_t>(image)])
            > kSuitIsoWeightTol)
        {
            return false;
        }
    }
    return true;
}

// Board stabilizer intersected with range-preserving permutations.
// Always includes the identity. Empty board span is rejected by callers.
inline std::vector<SuitPerm> suit_iso_group(
    std::span<const int> board, const Range& oop, const Range& ip)
{
    std::vector<SuitPerm> group;
    for (const SuitPerm& perm : board_suit_stabilizer(board))
    {
        if (range_invariant_under(oop, perm) && range_invariant_under(ip, perm))
        {
            group.push_back(perm);
        }
    }
    if (group.empty())
    {
        group.push_back(identity_suit_perm());
    }
    return group;
}

// Lexicographic key for a public runout plus acting hand under a permutation.
// Lower is better. hand_index is the player's indexed hand after remapping; -1
// means the image combo is not in the indexed range (caller must not pick it).
inline std::uint64_t suit_iso_key(int turn, int river, int hand_index)
{
    const std::uint32_t t = static_cast<std::uint32_t>(turn + 1);
    const std::uint32_t r = static_cast<std::uint32_t>(river + 1);
    const std::uint32_t h = static_cast<std::uint32_t>(hand_index + 1);
    return (static_cast<std::uint64_t>(t) << 42) | (static_cast<std::uint64_t>(r) << 21)
        | static_cast<std::uint64_t>(h);
}

} // namespace poker::holdem
