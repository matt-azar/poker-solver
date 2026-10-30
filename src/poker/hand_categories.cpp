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

PlayerCategoryMass compose_player(std::span<const int> board, const Range& range)
{
    PlayerCategoryMass out;
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
    for (int slot = 0; slot < kHandCategoryCount; ++slot)
    {
        if (slot > 0)
        {
            out += ',';
        }
        if (player.defined)
        {
            append_number(out, player.fraction[static_cast<std::size_t>(slot)]);
        }
        else
        {
            out += "null";
        }
    }
    out += "],\"mass\":[";
    for (int slot = 0; slot < kHandCategoryCount; ++slot)
    {
        if (slot > 0)
        {
            out += ',';
        }
        if (player.defined)
        {
            append_number(out, player.mass[static_cast<std::size_t>(slot)]);
        }
        else
        {
            out += "null";
        }
    }
    out += "]}";
}

} // namespace

CategoryComposition category_composition(
    std::span<const int> board,
    const Range& player0,
    const Range& player1)
{
    CategoryComposition report;
    report.board.assign(board.begin(), board.end());
    if (board.size() != 5)
    {
        report.available = false;
        report.reason = "made-hand categories require a five-card board";
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
    report.player0 = compose_player(board, player0);
    report.player1 = compose_player(board, player1);
    return report;
}

std::string category_composition_json(const CategoryComposition& report, double elapsed_seconds)
{
    std::string out = "{\"kind\":\"categories\",\"model\":";
    append_escaped(out, report.model);
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
    for (int slot = 0; slot < kHandCategoryCount; ++slot)
    {
        if (slot > 0)
        {
            out += ',';
        }
        append_escaped(out, category_name(static_cast<HandCategory>(slot)));
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
