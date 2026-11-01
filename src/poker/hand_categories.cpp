#include "poker/hand_categories.hpp"

#include "poker/card.hpp"

#include <cmath>
#include <sstream>
#include <stdexcept>

namespace poker::holdem
{
namespace
{

bool board_blocks(int card0, int card1, std::span<const int> board)
{
    for (int card : board)
    {
        if (card == card0 || card == card1)
        {
            return true;
        }
    }
    return false;
}

bool card_used(int card, int hole0, int hole1, std::span<const int> board)
{
    if (card == hole0 || card == hole1)
    {
        return true;
    }
    for (int board_card : board)
    {
        if (board_card == card)
        {
            return true;
        }
    }
    return false;
}

int suit_counts(int hole0, int hole1, std::span<const int> board, int (&counts)[kSuitCount])
{
    for (int& count : counts)
    {
        count = 0;
    }
    ++counts[suit_of(hole0)];
    ++counts[suit_of(hole1)];
    for (int card : board)
    {
        ++counts[suit_of(card)];
    }
    int best = 0;
    for (int count : counts)
    {
        if (count > best)
        {
            best = count;
        }
    }
    return best;
}

void collect_ranks(int hole0, int hole1, std::span<const int> board, bool (&present)[kRankCount])
{
    for (bool& flag : present)
    {
        flag = false;
    }
    present[rank_of(hole0)] = true;
    present[rank_of(hole1)] = true;
    for (int card : board)
    {
        present[rank_of(card)] = true;
    }
}

bool rank_available(int rank, int hole0, int hole1, std::span<const int> board)
{
    for (int suit = 0; suit < kSuitCount; ++suit)
    {
        const int card = make_card(rank, suit);
        if (!card_used(card, hole0, hole1, board))
        {
            return true;
        }
    }
    return false;
}

void each_straight_window(void (*consume)(const int (&window)[5], void* ctx), void* ctx)
{
    for (int top = 4; top <= 12; ++top)
    {
        const int window[5] = {top - 4, top - 3, top - 2, top - 1, top};
        consume(window, ctx);
    }
    // Wheel: A-2-3-4-5.
    const int wheel[5] = {12, 0, 1, 2, 3};
    consume(wheel, ctx);
}

struct StraightDrawScan
{
    const bool* present = nullptr;
    int hole0 = 0;
    int hole1 = 0;
    std::span<const int> board;
    bool made_straight = false;
    bool completing_rank[kRankCount] = {};
    int completing_count = 0;
    bool backdoor = false;
};

void scan_straight_window(const int (&window)[5], void* ctx)
{
    auto* scan = static_cast<StraightDrawScan*>(ctx);
    int missing_ranks[5] = {};
    int missing_count = 0;
    const bool* present = scan->present;
    for (int rank : window)
    {
        if (!present[rank])
        {
            missing_ranks[missing_count++] = rank;
        }
    }
    if (missing_count == 0)
    {
        scan->made_straight = true;
        return;
    }
    if (missing_count == 1)
    {
        const int rank = missing_ranks[0];
        if (!scan->completing_rank[rank] && rank_available(rank, scan->hole0, scan->hole1, scan->board))
        {
            scan->completing_rank[rank] = true;
            ++scan->completing_count;
        }
        return;
    }
    if (missing_count == 2 && scan->board.size() == 3)
    {
        if (rank_available(missing_ranks[0], scan->hole0, scan->hole1, scan->board)
            && rank_available(missing_ranks[1], scan->hole0, scan->hole1, scan->board))
        {
            scan->backdoor = true;
        }
    }
}

PlayerCategoryMass compose_made_player(std::span<const int> board, const Range& range)
{
    PlayerCategoryMass out;
    out.mass.assign(static_cast<std::size_t>(kHandCategoryCount), 0.0);
    out.fraction.assign(static_cast<std::size_t>(kHandCategoryCount), 0.0);
    for (int index = 0; index < kComboCount; ++index)
    {
        const double weight = range.weight(index);
        if (!(weight > 0.0) || !std::isfinite(weight))
        {
            continue;
        }
        int card0 = 0;
        int card1 = 0;
        Range::combo_cards(index, card0, card1);
        if (board_blocks(card0, card1, board))
        {
            continue;
        }
        const HandCategory category = made_hand_category(card0, card1, board);
        const int slot = static_cast<int>(category);
        out.mass[static_cast<std::size_t>(slot)] += weight;
        out.total_mass += weight;
    }
    if (!(out.total_mass > 0.0) || !std::isfinite(out.total_mass))
    {
        return out;
    }
    out.defined = true;
    for (int slot = 0; slot < kHandCategoryCount; ++slot)
    {
        out.fraction[static_cast<std::size_t>(slot)] =
            out.mass[static_cast<std::size_t>(slot)] / out.total_mass;
    }
    return out;
}

PlayerCategoryMass compose_draw_player(std::span<const int> board, const Range& range)
{
    PlayerCategoryMass out;
    out.mass.assign(static_cast<std::size_t>(kDrawCategoryCount), 0.0);
    out.fraction.assign(static_cast<std::size_t>(kDrawCategoryCount), 0.0);
    for (int index = 0; index < kComboCount; ++index)
    {
        const double weight = range.weight(index);
        if (!(weight > 0.0) || !std::isfinite(weight))
        {
            continue;
        }
        int card0 = 0;
        int card1 = 0;
        Range::combo_cards(index, card0, card1);
        if (board_blocks(card0, card1, board))
        {
            continue;
        }
        const DrawFlags flags = classify_draws(card0, card1, board);
        out.total_mass += weight;
        if (flags.flush_draw)
        {
            out.mass[static_cast<std::size_t>(DrawCategory::FlushDraw)] += weight;
        }
        if (flags.oesd)
        {
            out.mass[static_cast<std::size_t>(DrawCategory::Oesd)] += weight;
        }
        if (flags.gutshot)
        {
            out.mass[static_cast<std::size_t>(DrawCategory::Gutshot)] += weight;
        }
        if (flags.backdoor_flush)
        {
            out.mass[static_cast<std::size_t>(DrawCategory::BackdoorFlush)] += weight;
        }
        if (flags.backdoor_straight)
        {
            out.mass[static_cast<std::size_t>(DrawCategory::BackdoorStraight)] += weight;
        }
    }
    if (!(out.total_mass > 0.0) || !std::isfinite(out.total_mass))
    {
        return out;
    }
    out.defined = true;
    for (int slot = 0; slot < kDrawCategoryCount; ++slot)
    {
        out.fraction[static_cast<std::size_t>(slot)] =
            out.mass[static_cast<std::size_t>(slot)] / out.total_mass;
    }
    return out;
}

void append_escaped(std::string& out, std::string_view text)
{
    out.push_back('"');
    for (char ch : text)
    {
        if (ch == '"' || ch == '\\')
        {
            out.push_back('\\');
        }
        out.push_back(ch);
    }
    out.push_back('"');
}

void append_number(std::string& out, double value)
{
    if (!std::isfinite(value))
    {
        out += "null";
        return;
    }
    std::ostringstream stream;
    stream.precision(17);
    stream << value;
    out += stream.str();
}

void append_player(std::string& out, const PlayerCategoryMass& player)
{
    out += "{\"defined\":";
    out += player.defined ? "true" : "false";
    out += ",\"total_mass\":";
    if (player.defined)
    {
        append_number(out, player.total_mass);
    }
    else
    {
        out += "null";
    }
    out += ",\"fractions\":[";
    for (std::size_t slot = 0; slot < player.fraction.size(); ++slot)
    {
        if (slot > 0)
        {
            out += ',';
        }
        if (player.defined)
        {
            append_number(out, player.fraction[slot]);
        }
        else
        {
            out += "null";
        }
    }
    out += "],\"mass\":[";
    for (std::size_t slot = 0; slot < player.mass.size(); ++slot)
    {
        if (slot > 0)
        {
            out += ',';
        }
        if (player.defined)
        {
            append_number(out, player.mass[slot]);
        }
        else
        {
            out += "null";
        }
    }
    out += "]}";
}

std::vector<std::string> made_category_names()
{
    std::vector<std::string> names;
    names.reserve(static_cast<std::size_t>(kHandCategoryCount));
    for (int slot = 0; slot < kHandCategoryCount; ++slot)
    {
        names.emplace_back(category_name(static_cast<HandCategory>(slot)));
    }
    return names;
}

std::vector<std::string> draw_category_names()
{
    std::vector<std::string> names;
    names.reserve(static_cast<std::size_t>(kDrawCategoryCount));
    for (int slot = 0; slot < kDrawCategoryCount; ++slot)
    {
        names.emplace_back(draw_category_name(static_cast<DrawCategory>(slot)));
    }
    return names;
}

} // namespace

std::string_view draw_category_name(DrawCategory category)
{
    switch (category)
    {
    case DrawCategory::FlushDraw: return "flush draw";
    case DrawCategory::Oesd: return "oesd";
    case DrawCategory::Gutshot: return "gutshot";
    case DrawCategory::BackdoorFlush: return "backdoor flush";
    case DrawCategory::BackdoorStraight: return "backdoor straight";
    }
    return "unknown";
}

DrawFlags classify_draws(int hole0, int hole1, std::span<const int> board)
{
    DrawFlags flags;
    if (board.size() != 3 && board.size() != 4)
    {
        return flags;
    }
    if (!valid_card(hole0) || !valid_card(hole1) || hole0 == hole1 || board_blocks(hole0, hole1, board))
    {
        return flags;
    }
    try
    {
        validate_board(board.data(), static_cast<int>(board.size()));
    }
    catch (const std::invalid_argument&)
    {
        return flags;
    }

    int suits[kSuitCount] = {};
    const int best_suit = suit_counts(hole0, hole1, board, suits);
    // Made flush needs five suited cards; with board size 3/4 that requires best_suit >= 5.
    const bool flush_made = best_suit >= 5;
    if (!flush_made && best_suit >= 4)
    {
        flags.flush_draw = true;
    }
    if (board.size() == 3 && !flush_made && best_suit == 3)
    {
        flags.backdoor_flush = true;
    }

    bool present[kRankCount] = {};
    collect_ranks(hole0, hole1, board, present);
    StraightDrawScan scan;
    scan.present = present;
    scan.hole0 = hole0;
    scan.hole1 = hole1;
    scan.board = board;
    each_straight_window(scan_straight_window, &scan);
    if (!scan.made_straight)
    {
        if (scan.completing_count >= 2)
        {
            flags.oesd = true;
        }
        else if (scan.completing_count == 1)
        {
            flags.gutshot = true;
        }
        else if (board.size() == 3 && scan.backdoor)
        {
            flags.backdoor_straight = true;
        }
    }
    return flags;
}

CategoryComposition category_composition(
    std::span<const int> board,
    const Range& player0,
    const Range& player1)
{
    CategoryComposition report;
    report.board.assign(board.begin(), board.end());
    if (board.size() != 3 && board.size() != 4 && board.size() != 5)
    {
        report.available = false;
        report.reason = "categories require a flop, turn, or river board";
        return report;
    }
    try
    {
        validate_board(board.data(), static_cast<int>(board.size()));
    }
    catch (const std::invalid_argument& error)
    {
        report.available = false;
        report.reason = error.what();
        return report;
    }

    report.available = true;
    if (board.size() == 5)
    {
        report.model = kCategoryModel;
        report.exclusive = true;
        report.categories = made_category_names();
        report.player0 = compose_made_player(board, player0);
        report.player1 = compose_made_player(board, player1);
        return report;
    }

    report.model = kDrawCategoryModel;
    report.exclusive = false;
    report.categories = draw_category_names();
    report.player0 = compose_draw_player(board, player0);
    report.player1 = compose_draw_player(board, player1);
    return report;
}

std::string category_composition_json(const CategoryComposition& report, double elapsed_seconds)
{
    std::string out = "{\"kind\":\"categories\",\"model\":";
    append_escaped(out, report.model);
    out += ",\"exclusive\":";
    out += report.exclusive ? "true" : "false";
    out += ",\"available\":";
    out += report.available ? "true" : "false";
    out += ",\"reason\":";
    if (report.reason.empty())
    {
        out += "null";
    }
    else
    {
        append_escaped(out, report.reason);
    }
    out += ",\"board\":[";
    for (std::size_t index = 0; index < report.board.size(); ++index)
    {
        if (index > 0)
        {
            out += ',';
        }
        append_escaped(out, format_card(report.board[index]));
    }
    out += "],\"categories\":[";
    for (std::size_t slot = 0; slot < report.categories.size(); ++slot)
    {
        if (slot > 0)
        {
            out += ',';
        }
        append_escaped(out, report.categories[slot]);
    }
    out += "],\"oop\":";
    append_player(out, report.player0);
    out += ",\"ip\":";
    append_player(out, report.player1);
    out += ",\"query_seconds\":";
    append_number(out, elapsed_seconds);
    out += '}';
    return out;
}

} // namespace poker::holdem
