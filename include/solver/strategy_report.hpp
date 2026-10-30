#pragma once

#include <charconv>
#include <cmath>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace poker::solver
{

// strategy-report 1 is a versioned post-solve summary for scripts.
// Probabilities on root-action lines are a single mixture over the root
// decision: either reach-weighted across the acting player's hands
// (weighting reach) or an unweighted mean across root infosets
// (weighting unweighted_infoset). Document the measure on the weighting line.

struct StrategyReportAction
{
    std::string label;
    double probability = 0.0;
};

struct StrategyReport
{
    std::string board;
    int pot = 0;
    int stack = 0;
    std::string algorithm;
    int iterations = 0;
    bool has_nash_gap = false;
    double nash_gap = 0.0;
    // reach | unweighted_infoset
    std::string weighting = "reach";
    int root_player = 0;
    std::vector<StrategyReportAction> root_actions;
};

namespace strategy_report_detail
{

inline std::string format_number(double value)
{
    char buffer[64];
    const std::to_chars_result result = std::to_chars(
        buffer, buffer + sizeof(buffer), value, std::chars_format::general);
    if (result.ec != std::errc{})
    {
        throw std::invalid_argument("strategy report could not format a number");
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
        throw std::invalid_argument("bad number in strategy report");
    }
    return value;
}

inline int parse_int(std::string_view text)
{
    const double value = parse_finite(text);
    if (value != static_cast<double>(static_cast<int>(value)))
    {
        throw std::invalid_argument("bad integer in strategy report");
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

} // namespace strategy_report_detail

inline std::string format_strategy_report(const StrategyReport& report)
{
    using strategy_report_detail::append_line;
    using strategy_report_detail::format_number;

    if (report.weighting != "reach" && report.weighting != "unweighted_infoset")
    {
        throw std::invalid_argument("strategy report weighting must be reach or unweighted_infoset");
    }
    if (report.root_player != 0 && report.root_player != 1)
    {
        throw std::invalid_argument("strategy report root-player must be 0 or 1");
    }

    std::string out;
    out += "strategy-report 1\n";
    append_line(out, "board", report.board);
    append_line(out, "pot", std::to_string(report.pot));
    append_line(out, "stack", std::to_string(report.stack));
    append_line(out, "algorithm", report.algorithm);
    append_line(out, "iterations", std::to_string(report.iterations));
    if (report.has_nash_gap)
    {
        append_line(out, "nash_gap", format_number(report.nash_gap));
    }
    append_line(out, "weighting", report.weighting);
    append_line(out, "root-player", std::to_string(report.root_player));
    for (const StrategyReportAction& action : report.root_actions)
    {
        append_line(
            out,
            "root-action",
            action.label + " " + format_number(action.probability));
    }
    return out;
}

inline StrategyReport parse_strategy_report(std::string_view text)
{
    using strategy_report_detail::parse_finite;
    using strategy_report_detail::parse_int;
    using strategy_report_detail::split_key_value;
    using strategy_report_detail::split_lines;

    const std::vector<std::string_view> lines = split_lines(text);
    if (lines.empty() || lines[0] != "strategy-report 1")
    {
        throw std::invalid_argument("unsupported strategy-report version");
    }

    StrategyReport report;
    bool seen_board = false;
    bool seen_pot = false;
    bool seen_stack = false;
    bool seen_algorithm = false;
    bool seen_iterations = false;
    bool seen_weighting = false;
    bool seen_root_player = false;

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
                throw std::invalid_argument("duplicate board in strategy report");
            }
            seen_board = true;
            report.board = std::string(value);
        }
        else if (key == "pot")
        {
            if (seen_pot)
            {
                throw std::invalid_argument("duplicate pot in strategy report");
            }
            seen_pot = true;
            report.pot = parse_int(value);
        }
        else if (key == "stack")
        {
            if (seen_stack)
            {
                throw std::invalid_argument("duplicate stack in strategy report");
            }
            seen_stack = true;
            report.stack = parse_int(value);
        }
        else if (key == "algorithm")
        {
            if (seen_algorithm)
            {
                throw std::invalid_argument("duplicate algorithm in strategy report");
            }
            seen_algorithm = true;
            report.algorithm = std::string(value);
        }
        else if (key == "iterations")
        {
            if (seen_iterations)
            {
                throw std::invalid_argument("duplicate iterations in strategy report");
            }
            seen_iterations = true;
            report.iterations = parse_int(value);
        }
        else if (key == "nash_gap")
        {
            if (report.has_nash_gap)
            {
                throw std::invalid_argument("duplicate nash_gap in strategy report");
            }
            report.has_nash_gap = true;
            report.nash_gap = parse_finite(value);
        }
        else if (key == "weighting")
        {
            if (seen_weighting)
            {
                throw std::invalid_argument("duplicate weighting in strategy report");
            }
            seen_weighting = true;
            report.weighting = std::string(value);
            if (report.weighting != "reach" && report.weighting != "unweighted_infoset")
            {
                throw std::invalid_argument(
                    "strategy report weighting must be reach or unweighted_infoset");
            }
        }
        else if (key == "root-player")
        {
            if (seen_root_player)
            {
                throw std::invalid_argument("duplicate root-player in strategy report");
            }
            seen_root_player = true;
            report.root_player = parse_int(value);
            if (report.root_player != 0 && report.root_player != 1)
            {
                throw std::invalid_argument("strategy report root-player must be 0 or 1");
            }
        }
        else if (key == "root-action")
        {
            const std::size_t split = value.rfind(' ');
            if (split == std::string_view::npos || split == 0)
            {
                throw std::invalid_argument("bad root-action in strategy report");
            }
            StrategyReportAction action;
            action.label = std::string(value.substr(0, split));
            action.probability = parse_finite(value.substr(split + 1));
            report.root_actions.push_back(std::move(action));
        }
        else
        {
            throw std::invalid_argument(
                "unknown field in strategy report: " + std::string(key));
        }
    }

    if (!seen_board || !seen_pot || !seen_stack || !seen_algorithm || !seen_iterations
        || !seen_weighting || !seen_root_player)
    {
        throw std::invalid_argument("strategy report is missing a required field");
    }
    return report;
}

// Reach-weighted mixture of per-hand average strategies at one decision.
// reaches[i] weights strategies[i]; strategies[i].size() must match labels.size().
inline std::vector<StrategyReportAction> aggregate_reach_weighted(
    const std::vector<std::string>& labels,
    const std::vector<double>& reaches,
    const std::vector<std::vector<double>>& strategies)
{
    if (reaches.size() != strategies.size())
    {
        throw std::invalid_argument("reach-weighted aggregate size mismatch");
    }
    std::vector<StrategyReportAction> actions;
    actions.reserve(labels.size());
    for (const std::string& label : labels)
    {
        StrategyReportAction action;
        action.label = label;
        actions.push_back(std::move(action));
    }
    double total = 0.0;
    for (std::size_t hand = 0; hand < reaches.size(); ++hand)
    {
        const double weight = reaches[hand];
        if (!(weight > 0.0) || !std::isfinite(weight))
        {
            continue;
        }
        const std::vector<double>& row = strategies[hand];
        if (row.size() != labels.size())
        {
            throw std::invalid_argument("reach-weighted strategy width mismatch");
        }
        total += weight;
        for (std::size_t action = 0; action < labels.size(); ++action)
        {
            actions[action].probability += weight * row[action];
        }
    }
    if (total > 0.0)
    {
        for (StrategyReportAction& action : actions)
        {
            action.probability /= total;
        }
    }
    return actions;
}

// Unweighted mean across infosets whose label ends with " | open".
// Entries for one infoset must be contiguous and share the same action order.
inline std::vector<StrategyReportAction> aggregate_open_infosets_unweighted(
    const std::vector<std::string>& infosets,
    const std::vector<std::string>& actions,
    const std::vector<double>& probabilities)
{
    if (infosets.size() != actions.size() || actions.size() != probabilities.size())
    {
        throw std::invalid_argument("open-infoset aggregate size mismatch");
    }

    std::vector<std::string> labels;
    std::vector<double> sums;
    int infoset_count = 0;
    std::string current;
    bool current_is_open = false;
    int action_index = 0;

    for (std::size_t i = 0; i < infosets.size(); ++i)
    {
        if (infosets[i] != current)
        {
            current = infosets[i];
            current_is_open = current.size() >= 7 && current.compare(current.size() - 7, 7, " | open") == 0;
            action_index = 0;
            if (current_is_open)
            {
                ++infoset_count;
            }
        }
        if (!current_is_open)
        {
            continue;
        }
        if (static_cast<std::size_t>(action_index) >= labels.size())
        {
            labels.push_back(actions[i]);
            sums.push_back(0.0);
        }
        else if (labels[static_cast<std::size_t>(action_index)] != actions[i])
        {
            throw std::invalid_argument("open infosets disagree on action order");
        }
        sums[static_cast<std::size_t>(action_index)] += probabilities[i];
        ++action_index;
    }

    std::vector<StrategyReportAction> out;
    out.reserve(labels.size());
    for (std::size_t i = 0; i < labels.size(); ++i)
    {
        StrategyReportAction action;
        action.label = labels[i];
        action.probability = infoset_count > 0 ? sums[i] / static_cast<double>(infoset_count) : 0.0;
        out.push_back(std::move(action));
    }
    return out;
}

inline void write_strategy_report(const std::string& path, const StrategyReport& report)
{
    const std::string text = format_strategy_report(report);
    if (path == "-")
    {
        std::cout << text;
        std::cout.flush();
        return;
    }
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    if (!output)
    {
        throw std::runtime_error("cannot write strategy report " + path);
    }
    output << text;
    if (!output)
    {
        throw std::runtime_error("cannot write strategy report " + path);
    }
}

} // namespace poker::solver
