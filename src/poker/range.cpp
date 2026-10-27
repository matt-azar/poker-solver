#include "poker/range.hpp"

#include "poker/card.hpp"

#include <charconv>
#include <cmath>
#include <sstream>
#include <stdexcept>
#include <utility>

namespace poker::holdem
{
namespace
{

[[noreturn]] void bad_range(const std::string& message)
{
    throw std::invalid_argument(message);
}

std::string_view trim(std::string_view text)
{
    while (!text.empty() && (text.front() == ' ' || text.front() == '\t'))
    {
        text.remove_prefix(1);
    }
    while (!text.empty() && (text.back() == ' ' || text.back() == '\t'))
    {
        text.remove_suffix(1);
    }
    return text;
}

int rank_char(char character)
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

int suit_char(char character)
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

struct Cursor
{
    std::string_view text;
    std::size_t index = 0;

    bool done() const
    {
        return index >= text.size();
    }

    char peek() const
    {
        return done() ? '\0' : text[index];
    }

    char get()
    {
        if (done())
        {
            bad_range("unexpected end of range token");
        }
        return text[index++];
    }
};

int read_rank(Cursor& cursor)
{
    if (cursor.peek() == '1')
    {
        const std::size_t next = cursor.index + 1;
        if (next < cursor.text.size() && cursor.text[next] == '0')
        {
            cursor.index += 2;
            return 8;
        }
    }
    const int rank = rank_char(cursor.get());
    if (rank < 0)
    {
        bad_range("expected a card rank in range token");
    }
    return rank;
}

bool consume_suit_marker(Cursor& cursor, char marker)
{
    if (cursor.peek() == marker || cursor.peek() == (marker - 'a' + 'A'))
    {
        cursor.get();
        return true;
    }
    return false;
}

enum class Shape
{
    Pair,
    Suited,
    Offsuit,
    Both
};

struct Group
{
    Shape shape = Shape::Both;
    int high = 0;
    int low = 0;
    bool plus = false;
    bool spanned = false;
    int low_end = 0;
};

bool at_card(const Cursor& cursor)
{
    if (cursor.done())
    {
        return false;
    }
    if (cursor.peek() == '1')
    {
        const std::size_t next = cursor.index + 1;
        if (next + 1 < cursor.text.size() && cursor.text[next] == '0')
        {
            return suit_char(cursor.text[next + 1]) >= 0;
        }
    }
    if (cursor.index + 1 >= cursor.text.size())
    {
        return false;
    }
    return rank_char(cursor.peek()) >= 0 && suit_char(cursor.text[cursor.index + 1]) >= 0;
}

int read_specific_card(Cursor& cursor)
{
    const int rank = read_rank(cursor);
    const int suit = suit_char(cursor.get());
    if (suit < 0)
    {
        bad_range("expected a suit");
    }
    return make_card(rank, suit);
}

void skip_spaces(Cursor& cursor)
{
    while (cursor.peek() == ' ' || cursor.peek() == '\t')
    {
        cursor.get();
    }
}

Group read_group(Cursor& cursor)
{
    Group group;
    const int first = read_rank(cursor);
    if (cursor.peek() == '-' || cursor.peek() == '+')
    {
        bad_range("incomplete range token");
    }
    if (rank_char(cursor.peek()) < 0 && cursor.peek() != '1')
    {
        bad_range("expected a second rank");
    }
    const int second = read_rank(cursor);
    if (first == second)
    {
        group.shape = Shape::Pair;
        group.high = first;
        group.low = first;
    }
    else
    {
        group.high = std::max(first, second);
        group.low = std::min(first, second);
        if (consume_suit_marker(cursor, 's'))
        {
            group.shape = Shape::Suited;
        }
        else if (consume_suit_marker(cursor, 'o'))
        {
            group.shape = Shape::Offsuit;
        }
        else
        {
            group.shape = Shape::Both;
        }
    }

    if (cursor.peek() == '+')
    {
        cursor.get();
        group.plus = true;
        if (group.shape == Shape::Pair)
        {
            group.low_end = 12;
        }
        else
        {
            group.low_end = group.high - 1;
        }
        group.spanned = true;
    }
    else if (cursor.peek() == '-')
    {
        cursor.get();
        Group tail = read_group(cursor);
        if (tail.shape != group.shape || tail.plus || tail.spanned)
        {
            bad_range("a dashed range must join two groups of the same shape");
        }
        if (group.shape == Shape::Pair)
        {
            group.low = std::min(group.high, tail.high);
            group.high = std::max(group.high, tail.high);
        }
        else
        {
            if (tail.high != group.high)
            {
                bad_range("a dashed non-pair range must share its high card");
            }
            const int kicker_a = group.low;
            const int kicker_b = tail.low;
            group.low = std::min(kicker_a, kicker_b);
            group.low_end = std::max(kicker_a, kicker_b);
        }
        group.spanned = true;
    }
    return group;
}

void add_pair(Range& range, int rank, double weight)
{
    for (int suit0 = 0; suit0 < kSuitCount; ++suit0)
    {
        for (int suit1 = suit0 + 1; suit1 < kSuitCount; ++suit1)
        {
            range.set_weight(make_card(rank, suit0), make_card(rank, suit1), weight);
        }
    }
}

void add_suited(Range& range, int high, int low, double weight)
{
    for (int suit = 0; suit < kSuitCount; ++suit)
    {
        range.set_weight(make_card(high, suit), make_card(low, suit), weight);
    }
}

void add_offsuit(Range& range, int high, int low, double weight)
{
    for (int suit0 = 0; suit0 < kSuitCount; ++suit0)
    {
        for (int suit1 = 0; suit1 < kSuitCount; ++suit1)
        {
            if (suit0 == suit1)
            {
                continue;
            }
            range.set_weight(make_card(high, suit0), make_card(low, suit1), weight);
        }
    }
}

void apply_group(Range& range, const Group& group, double weight)
{
    if (group.shape == Shape::Pair)
    {
        if (!group.spanned && !group.plus)
        {
            add_pair(range, group.high, weight);
            return;
        }
        const int low_rank = group.plus ? group.high : group.low;
        const int high_rank = group.plus ? 12 : group.high;
        for (int rank = low_rank; rank <= high_rank; ++rank)
        {
            add_pair(range, rank, weight);
        }
        return;
    }

    const int kicker_begin = group.spanned ? group.low : group.low;
    const int kicker_end = group.spanned ? (group.plus ? group.high - 1 : group.low_end) : group.low;
    for (int kicker = std::min(kicker_begin, kicker_end); kicker <= std::max(kicker_begin, kicker_end); ++kicker)
    {
        if (kicker == group.high)
        {
            continue;
        }
        if (group.shape == Shape::Suited || group.shape == Shape::Both)
        {
            add_suited(range, group.high, kicker, weight);
        }
        if (group.shape == Shape::Offsuit || group.shape == Shape::Both)
        {
            add_offsuit(range, group.high, kicker, weight);
        }
    }
}

bool uses_card(int index, int card)
{
    int card0 = 0;
    int card1 = 0;
    Range::combo_cards(index, card0, card1);
    return card0 == card || card1 == card;
}

bool combos_overlap(int left, int right)
{
    int a0 = 0;
    int a1 = 0;
    int b0 = 0;
    int b1 = 0;
    Range::combo_cards(left, a0, a1);
    Range::combo_cards(right, b0, b1);
    return a0 == b0 || a0 == b1 || a1 == b0 || a1 == b1;
}

bool blocked_by_board(int index, const int* board, int board_count)
{
    for (int i = 0; i < board_count; ++i)
    {
        if (uses_card(index, board[i]))
        {
            return true;
        }
    }
    return false;
}

void apply_token(Range& range, std::string_view piece)
{
    piece = trim(piece);
    if (piece.empty())
    {
        return;
    }
    double weight = 1.0;
    const std::size_t colon = piece.find(':');
    if (colon != std::string_view::npos)
    {
        const std::string_view number = trim(piece.substr(colon + 1));
        piece = trim(piece.substr(0, colon));
        const std::string number_text(number);
        std::size_t consumed = 0;
        try
        {
            weight = std::stod(number_text, &consumed);
        }
        catch (const std::exception&)
        {
            bad_range("bad range weight");
        }
        if (consumed != number_text.size() || !std::isfinite(weight) || weight < 0.0)
        {
            bad_range("range weight must be a nonnegative number");
        }
    }

    if (piece == "random" || piece == "*")
    {
        for (int card0 = 0; card0 < kDeckSize; ++card0)
        {
            for (int card1 = card0 + 1; card1 < kDeckSize; ++card1)
            {
                range.set_weight(card0, card1, weight);
            }
        }
        return;
    }

    Cursor cursor{piece, 0};
    skip_spaces(cursor);
    if (at_card(cursor))
    {
        const int first = read_specific_card(cursor);
        skip_spaces(cursor);
        if (!at_card(cursor))
        {
            bad_range("a specific combo needs two cards");
        }
        const int second = read_specific_card(cursor);
        skip_spaces(cursor);
        if (!cursor.done())
        {
            bad_range("extra text after a specific combo");
        }
        if (first == second)
        {
            bad_range("a combo cannot repeat a card");
        }
        range.set_weight(first, second, weight);
        return;
    }

    Group group = read_group(cursor);
    skip_spaces(cursor);
    if (!cursor.done())
    {
        bad_range("extra text in range token " + std::string(piece));
    }
    apply_group(range, group, weight);
}

} // namespace

Range::Range() = default;

int Range::combo_index(int card0, int card1)
{
    if (!valid_card(card0) || !valid_card(card1) || card0 == card1)
    {
        bad_range("combo index requires two distinct cards");
    }
    if (card0 > card1)
    {
        std::swap(card0, card1);
    }
    return card0 * (103 - card0) / 2 + (card1 - card0 - 1);
}

void Range::combo_cards(int index, int& card0, int& card1)
{
    if (index < 0 || index >= kComboCount)
    {
        bad_range("combo index out of range");
    }
    int cursor = index;
    for (int low = 0; low < kDeckSize; ++low)
    {
        const int width = kDeckSize - 1 - low;
        if (cursor < width)
        {
            card0 = low;
            card1 = low + 1 + cursor;
            return;
        }
        cursor -= width;
    }
    bad_range("combo index out of range");
}

std::string Range::combo_text(int index)
{
    int card0 = 0;
    int card1 = 0;
    combo_cards(index, card0, card1);
    if (rank_of(card0) < rank_of(card1) || (rank_of(card0) == rank_of(card1) && suit_of(card0) < suit_of(card1)))
    {
        std::swap(card0, card1);
    }
    return format_card(card0) + format_card(card1);
}

Range Range::parse(std::string_view text)
{
    Range range;
    std::size_t start = 0;
    const std::string_view body = trim(text);
    if (body.empty())
    {
        return range;
    }
    while (start <= body.size())
    {
        const std::size_t comma = body.find(',', start);
        const std::string_view piece = body.substr(
            start, comma == std::string_view::npos ? std::string_view::npos : comma - start);
        apply_token(range, piece);
        if (comma == std::string_view::npos)
        {
            break;
        }
        start = comma + 1;
    }
    return range;
}

Range Range::from_json(std::string_view json)
{
    json = trim(json);
    if (json.empty() || json.front() != '[')
    {
        bad_range("range JSON must be an array of 1326 weights");
    }
    Range range;
    std::size_t cursor = 1;
    for (int index = 0; index < kComboCount; ++index)
    {
        while (cursor < json.size() && (json[cursor] == ' ' || json[cursor] == '\n' || json[cursor] == '\t'))
        {
            ++cursor;
        }
        const char* begin = json.data() + cursor;
        const char* end = json.data() + json.size();
        double value = 0.0;
        const auto parsed = std::from_chars(begin, end, value);
        if (parsed.ec != std::errc{} || !std::isfinite(value) || value < 0.0)
        {
            bad_range("bad weight in range JSON");
        }
        int card0 = 0;
        int card1 = 0;
        combo_cards(index, card0, card1);
        range.set_weight(card0, card1, value);
        cursor = static_cast<std::size_t>(parsed.ptr - json.data());
        while (cursor < json.size() && (json[cursor] == ' ' || json[cursor] == '\n' || json[cursor] == '\t'))
        {
            ++cursor;
        }
        if (index + 1 < kComboCount)
        {
            if (cursor >= json.size() || json[cursor] != ',')
            {
                bad_range("range JSON must contain 1326 weights");
            }
            ++cursor;
        }
    }
    while (cursor < json.size() && (json[cursor] == ' ' || json[cursor] == '\n' || json[cursor] == '\t'))
    {
        ++cursor;
    }
    if (cursor >= json.size() || json[cursor] != ']')
    {
        bad_range("range JSON must contain 1326 weights");
    }
    return range;
}

double Range::weight(int index) const
{
    if (index < 0 || index >= kComboCount)
    {
        bad_range("combo index out of range");
    }
    return weights_[static_cast<std::size_t>(index)];
}

double Range::weight_of(int card0, int card1) const
{
    return weight(combo_index(card0, card1));
}

void Range::set_weight(int card0, int card1, double value)
{
    if (!std::isfinite(value) || value < 0.0)
    {
        bad_range("a range weight must be nonnegative");
    }
    weights_[static_cast<std::size_t>(combo_index(card0, card1))] = value;
}

double Range::total() const
{
    double sum = 0.0;
    for (double value : weights_)
    {
        sum += value;
    }
    return sum;
}

void Range::normalize()
{
    const double sum = total();
    if (sum == 0.0)
    {
        return;
    }
    for (double& value : weights_)
    {
        value /= sum;
    }
}

void Range::remove_blockers(const int* dead, int dead_count)
{
    for (int card = 0; card < dead_count; ++card)
    {
        if (!valid_card(dead[card]))
        {
            bad_range("dead card is invalid");
        }
    }
    for (int index = 0; index < kComboCount; ++index)
    {
        if (blocked_by_board(index, dead, dead_count))
        {
            weights_[static_cast<std::size_t>(index)] = 0.0;
        }
    }
}

Range Range::conditioned(const int* dead, int dead_count) const
{
    Range copy = *this;
    copy.remove_blockers(dead, dead_count);
    copy.normalize();
    return copy;
}

std::string Range::to_json() const
{
    std::ostringstream out;
    out.precision(17);
    out << '[';
    for (int index = 0; index < kComboCount; ++index)
    {
        if (index > 0)
        {
            out << ',';
        }
        out << weights_[static_cast<std::size_t>(index)];
    }
    out << ']';
    return out.str();
}

std::string Range::to_combo_list() const
{
    std::ostringstream out;
    out.precision(17);
    bool first = true;
    for (int index = 0; index < kComboCount; ++index)
    {
        const double value = weights_[static_cast<std::size_t>(index)];
        if (value == 0.0)
        {
            continue;
        }
        if (!first)
        {
            out << ',';
        }
        first = false;
        out << combo_text(index) << ':' << value;
    }
    return out.str();
}

double joint_mass(const Range& left, const Range& right, const int* board, int board_count)
{
    validate_board(board, board_count);
    double mass = 0.0;
    for (int first = 0; first < kComboCount; ++first)
    {
        const double left_weight = left.weight(first);
        if (left_weight == 0.0 || blocked_by_board(first, board, board_count))
        {
            continue;
        }
        for (int second = 0; second < kComboCount; ++second)
        {
            const double right_weight = right.weight(second);
            if (right_weight == 0.0 || blocked_by_board(second, board, board_count))
            {
                continue;
            }
            if (combos_overlap(first, second))
            {
                continue;
            }
            mass += left_weight * right_weight;
        }
    }
    return mass;
}

std::vector<HandPairProbability> joint_distribution(
    const Range& left,
    const Range& right,
    const int* board,
    int board_count)
{
    const double mass = joint_mass(left, right, board, board_count);
    std::vector<HandPairProbability> rows;
    if (mass == 0.0)
    {
        return rows;
    }
    for (int first = 0; first < kComboCount; ++first)
    {
        const double left_weight = left.weight(first);
        if (left_weight == 0.0 || blocked_by_board(first, board, board_count))
        {
            continue;
        }
        for (int second = 0; second < kComboCount; ++second)
        {
            const double right_weight = right.weight(second);
            if (right_weight == 0.0 || blocked_by_board(second, board, board_count))
            {
                continue;
            }
            if (combos_overlap(first, second))
            {
                continue;
            }
            HandPairProbability row;
            row.combo0 = first;
            row.combo1 = second;
            row.probability = left_weight * right_weight / mass;
            rows.push_back(row);
        }
    }
    return rows;
}

} // namespace poker::holdem
