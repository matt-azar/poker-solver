#pragma once

#include <charconv>
#include <cmath>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace poker::solver
{

// hand-history 1 is a versioned export of one heads-up played hand.
// Self-play and the trainer fill this later; the document is the contract.
// Hole-card lines may be omitted when the export comes from a ranges-only
// solve. Range labels may still name the source ranges.

struct HandHistoryAction
{
    // 0 = out of position (player 0), 1 = in position (player 1).
    int player = 0;
    // Canonical engine labels: "Fold", "Check", "Call", "Bet N",
    // "Raise to N", optionally with a trailing " all-in".
    std::string label;
};

struct HandHistoryRecord
{
    std::string board;
    int pot = 0;
    int stack = 0;
    // Empty when the export does not name concrete hole cards.
    std::string oop_hole;
    std::string ip_hole;
    // Optional source-range or study labels when holes are omitted or as notes.
    std::string oop_label;
    std::string ip_label;
    std::vector<HandHistoryAction> actions;
    int terminal_pot = 0;
    // "showdown" or "fold"
    std::string outcome;
    // Player 0 net chips from the street start (same sign convention as river).
    int p0_net = 0;
};

namespace hand_history_detail
{

inline std::string format_number(double value)
{
    char buffer[64];
    const std::to_chars_result result = std::to_chars(
        buffer, buffer + sizeof(buffer), value, std::chars_format::general);
    if (result.ec != std::errc{})
    {
        throw std::invalid_argument("hand history could not format a number");
    }
    return std::string(buffer, result.ptr);
}

inline double parse_finite(std::string_view text)
{
    double value = 0.0;
    const char* const begin = text.data();
    const char* const end = begin + text.size();
    const std::from_chars_result result = std::from_chars(begin, end, value);
    if (result.ec != std::errc{} || result.ptr != end || !std::isfinite(value))
    {
        throw std::invalid_argument("bad number in hand history");
    }
    return value;
}

inline int parse_int(std::string_view text)
{
    const double value = parse_finite(text);
    if (value != static_cast<double>(static_cast<int>(value)))
    {
        throw std::invalid_argument("bad integer in hand history");
    }
    return static_cast<int>(value);
}

inline void append_line(std::string& out, std::string_view key, std::string_view value)
{
    out.append(key);
    if (!value.empty())
    {
        out.push_back(' ');
        out.append(value);
    }
    out.push_back('\n');
}

inline std::vector<std::string_view> split_lines(std::string_view text)
{
    std::vector<std::string_view> lines;
    std::size_t begin = 0;
    while (begin <= text.size())
    {
        const std::size_t end = text.find('\n', begin);
        if (end == std::string_view::npos)
        {
            lines.push_back(text.substr(begin));
            break;
        }
        lines.push_back(text.substr(begin, end - begin));
        begin = end + 1;
    }
    while (!lines.empty() && lines.back().empty())
    {
        lines.pop_back();
    }
    return lines;
}

inline std::string_view trim(std::string_view text)
{
    while (!text.empty()
        && (text.front() == ' ' || text.front() == '\t' || text.front() == '\r'))
    {
        text.remove_prefix(1);
    }
    while (!text.empty()
        && (text.back() == ' ' || text.back() == '\t' || text.back() == '\r'))
    {
        text.remove_suffix(1);
    }
    return text;
}

inline bool split_key_value(std::string_view line, std::string_view& key, std::string_view& value)
{
    line = trim(line);
    if (line.empty())
    {
        return false;
    }
    const std::size_t space = line.find(' ');
    if (space == std::string_view::npos)
    {
        key = line;
        value = {};
        return true;
    }
    key = line.substr(0, space);
    value = trim(line.substr(space + 1));
    return true;
}

inline void require_outcome(std::string_view outcome)
{
    if (outcome != "showdown" && outcome != "fold")
    {
        throw std::invalid_argument("hand history outcome must be showdown or fold");
    }
}

} // namespace hand_history_detail

inline std::string format_hand_history(const HandHistoryRecord& record)
{
    using hand_history_detail::append_line;
    using hand_history_detail::require_outcome;

    require_outcome(record.outcome);
    for (const HandHistoryAction& action : record.actions)
    {
        if (action.player != 0 && action.player != 1)
        {
            throw std::invalid_argument("hand history action player must be 0 or 1");
        }
        if (action.label.empty())
        {
            throw std::invalid_argument("hand history action label must be non-empty");
        }
    }

    std::string out;
    out += "hand-history 1\n";
    append_line(out, "board", record.board);
    append_line(out, "pot", std::to_string(record.pot));
    append_line(out, "stack", std::to_string(record.stack));
    if (!record.oop_hole.empty())
    {
        append_line(out, "oop-hole", record.oop_hole);
    }
    if (!record.ip_hole.empty())
    {
        append_line(out, "ip-hole", record.ip_hole);
    }
    if (!record.oop_label.empty())
    {
        append_line(out, "oop-label", record.oop_label);
    }
    if (!record.ip_label.empty())
    {
        append_line(out, "ip-label", record.ip_label);
    }
    for (const HandHistoryAction& action : record.actions)
    {
        append_line(out, "action", std::to_string(action.player) + " " + action.label);
    }
    append_line(out, "terminal-pot", std::to_string(record.terminal_pot));
    append_line(out, "outcome", record.outcome);
    append_line(out, "p0-net", std::to_string(record.p0_net));
    return out;
}

inline HandHistoryRecord parse_hand_history(std::string_view text)
{
    using hand_history_detail::parse_int;
    using hand_history_detail::require_outcome;
    using hand_history_detail::split_key_value;
    using hand_history_detail::split_lines;

    const std::vector<std::string_view> lines = split_lines(text);
    if (lines.empty() || lines[0] != "hand-history 1")
    {
        throw std::invalid_argument("unsupported hand-history version");
    }

    HandHistoryRecord record;
    bool seen_board = false;
    bool seen_pot = false;
    bool seen_stack = false;
    bool seen_oop_hole = false;
    bool seen_ip_hole = false;
    bool seen_oop_label = false;
    bool seen_ip_label = false;
    bool seen_terminal_pot = false;
    bool seen_outcome = false;
    bool seen_p0_net = false;

    for (std::size_t index = 1; index < lines.size(); ++index)
    {
        std::string_view key;
        std::string_view value;
        if (!split_key_value(lines[index], key, value))
        {
            continue;
        }
        if (key == "board")
        {
            if (seen_board)
            {
                throw std::invalid_argument("duplicate board in hand history");
            }
            seen_board = true;
            record.board = std::string(value);
        }
        else if (key == "pot")
        {
            if (seen_pot)
            {
                throw std::invalid_argument("duplicate pot in hand history");
            }
            seen_pot = true;
            record.pot = parse_int(value);
        }
        else if (key == "stack")
        {
            if (seen_stack)
            {
                throw std::invalid_argument("duplicate stack in hand history");
            }
            seen_stack = true;
            record.stack = parse_int(value);
        }
        else if (key == "oop-hole")
        {
            if (seen_oop_hole)
            {
                throw std::invalid_argument("duplicate oop-hole in hand history");
            }
            seen_oop_hole = true;
            record.oop_hole = std::string(value);
        }
        else if (key == "ip-hole")
        {
            if (seen_ip_hole)
            {
                throw std::invalid_argument("duplicate ip-hole in hand history");
            }
            seen_ip_hole = true;
            record.ip_hole = std::string(value);
        }
        else if (key == "oop-label")
        {
            if (seen_oop_label)
            {
                throw std::invalid_argument("duplicate oop-label in hand history");
            }
            seen_oop_label = true;
            record.oop_label = std::string(value);
        }
        else if (key == "ip-label")
        {
            if (seen_ip_label)
            {
                throw std::invalid_argument("duplicate ip-label in hand history");
            }
            seen_ip_label = true;
            record.ip_label = std::string(value);
        }
        else if (key == "action")
        {
            const std::size_t space = value.find(' ');
            if (space == std::string_view::npos)
            {
                throw std::invalid_argument("hand history action needs player and label");
            }
            HandHistoryAction action;
            action.player = parse_int(value.substr(0, space));
            if (action.player != 0 && action.player != 1)
            {
                throw std::invalid_argument("hand history action player must be 0 or 1");
            }
            action.label = std::string(hand_history_detail::trim(value.substr(space + 1)));
            if (action.label.empty())
            {
                throw std::invalid_argument("hand history action label must be non-empty");
            }
            record.actions.push_back(std::move(action));
        }
        else if (key == "terminal-pot")
        {
            if (seen_terminal_pot)
            {
                throw std::invalid_argument("duplicate terminal-pot in hand history");
            }
            seen_terminal_pot = true;
            record.terminal_pot = parse_int(value);
        }
        else if (key == "outcome")
        {
            if (seen_outcome)
            {
                throw std::invalid_argument("duplicate outcome in hand history");
            }
            seen_outcome = true;
            require_outcome(value);
            record.outcome = std::string(value);
        }
        else if (key == "p0-net")
        {
            if (seen_p0_net)
            {
                throw std::invalid_argument("duplicate p0-net in hand history");
            }
            seen_p0_net = true;
            record.p0_net = parse_int(value);
        }
        else
        {
            throw std::invalid_argument("unknown field in hand history");
        }
    }

    if (!seen_board || !seen_pot || !seen_stack || !seen_terminal_pot || !seen_outcome
        || !seen_p0_net)
    {
        throw std::invalid_argument("hand history missing a required field");
    }
    return record;
}

} // namespace poker::solver
