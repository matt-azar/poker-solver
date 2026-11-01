#pragma once

#include "game/street_game.hpp"
#include "solver/tree_edit.hpp"

#include <charconv>
#include <cmath>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace poker::streets
{

// street-config 1 is the versioned spelling of StreetConfig.
// format_street_config writes one document. parse_street_config reads it.
// Formatting a parsed document produces the same text. Building a StreetGame
// from either value uses the same sizes, ranges, and limits.

inline std::string format_number(double value)
{
    char buffer[64];
    const std::to_chars_result result = std::to_chars(
        buffer, buffer + sizeof(buffer), value, std::chars_format::general);
    if (result.ec != std::errc{})
    {
        throw std::invalid_argument("street config could not format a number");
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
        throw std::invalid_argument("bad number in street config");
    }
    return value;
}

inline std::string format_spec(double spec)
{
    if (spec < 0.0)
    {
        return format_number(-spec) + "c";
    }
    return format_number(spec);
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

inline void append_ints(std::string& out, std::string_view key, int value)
{
    append_line(out, key, std::to_string(value));
}

inline void append_flag(std::string& out, std::string_view key, bool value)
{
    append_line(out, key, value ? "1" : "0");
}

inline void append_specs(std::string& out, std::string_view key, const std::vector<double>& specs)
{
    if (specs.empty())
    {
        return;
    }
    std::string value;
    for (double spec : specs)
    {
        if (!value.empty())
        {
            value.push_back(' ');
        }
        value += format_spec(spec);
    }
    append_line(out, key, value);
}

inline void append_numbers(std::string& out, std::string_view key, const std::vector<double>& values)
{
    if (values.empty())
    {
        return;
    }
    std::string value;
    for (double number : values)
    {
        if (!value.empty())
        {
            value.push_back(' ');
        }
        value += format_number(number);
    }
    append_line(out, key, value);
}

inline std::string format_board(const std::vector<int>& board)
{
    std::string value;
    for (int card : board)
    {
        if (!value.empty())
        {
            value.push_back(' ');
        }
        value += holdem::format_card(card);
    }
    return value;
}

inline std::string format_street_config(const StreetConfig& config)
{
    std::string out;
    out += "street-config 1\n";
    append_line(out, "board", format_board(config.board));
    append_ints(out, "pot", config.pot);
    append_ints(out, "stack", config.stack);
    append_line(out, "oop-range", config.oop.to_combo_list());
    append_line(out, "ip-range", config.ip.to_combo_list());
    append_ints(out, "first-to-act", config.first_to_act);
    append_ints(out, "max-raises", config.max_raises);
    append_flag(out, "allow-all-in", config.allow_all_in);
    append_flag(out, "allow-three-bet", config.allow_three_bet);
    append_flag(out, "geometric", config.geometric);
    append_line(out, "all-in-threshold", format_number(config.all_in_threshold));
    append_line(out, "pot-cap", format_number(config.pot_cap));
    append_line(out, "rake-rate", format_number(config.rake.rate));
    append_line(out, "rake-cap", format_number(config.rake.cap));
    append_numbers(out, "icm-stacks", config.icm.stacks);
    append_numbers(out, "icm-payouts", config.icm.payouts);
    for (const poker::solver::IncentiveRule& rule : config.incentives.rules)
    {
        std::string value;
        value += rule.kind == poker::solver::IncentiveKind::CategoryTag ? "tag" : "label";
        value.push_back(' ');
        value += std::to_string(rule.player);
        value.push_back(' ');
        value += rule.key;
        value.push_back(' ');
        value += format_number(rule.delta);
        append_line(out, "incentive", value);
    }
    for (const poker::solver::IncentiveEdgeTagSpec& spec : config.incentives.edge_tags)
    {
        std::string value;
        if (spec.player >= 0)
        {
            value += std::to_string(spec.player);
            value.push_back(' ');
        }
        value += spec.action_key;
        for (const std::string& tag : spec.tags)
        {
            value.push_back(' ');
            value += tag;
        }
        append_line(out, "edge-tag", value);
    }
    append_ints(out, "memory-mib", config.memory_mib);
    append_ints(out, "threads", config.threads);
    append_specs(out, "oop-bets", config.oop_bet_sizes);
    append_specs(out, "ip-bets", config.ip_bet_sizes);
    append_specs(out, "oop-raises", config.oop_raise_sizes);
    append_specs(out, "ip-raises", config.ip_raise_sizes);
    append_specs(out, "oop-flop-bets", config.oop_flop_bets);
    append_specs(out, "oop-turn-bets", config.oop_turn_bets);
    append_specs(out, "oop-river-bets", config.oop_river_bets);
    append_specs(out, "ip-flop-bets", config.ip_flop_bets);
    append_specs(out, "ip-turn-bets", config.ip_turn_bets);
    append_specs(out, "ip-river-bets", config.ip_river_bets);
    append_specs(out, "oop-flop-raises", config.oop_flop_raises);
    append_specs(out, "oop-turn-raises", config.oop_turn_raises);
    append_specs(out, "oop-river-raises", config.oop_river_raises);
    append_specs(out, "ip-flop-raises", config.ip_flop_raises);
    append_specs(out, "ip-turn-raises", config.ip_turn_raises);
    append_specs(out, "ip-river-raises", config.ip_river_raises);
    append_specs(out, "oop-donk", config.oop_donk_sizes);
    append_numbers(out, "oop-raise-multiples", config.oop_raise_multiples);
    append_numbers(out, "ip-raise-multiples", config.ip_raise_multiples);
    if (!config.tree_edits.empty())
    {
        if (!config.tree_edits.valid())
        {
            throw std::invalid_argument("street config tree_edits are invalid");
        }
        const std::string edits = poker::solver::format_tree_edits(config.tree_edits);
        std::size_t cursor = 0;
        while (cursor < edits.size())
        {
            std::size_t end = edits.find('\n', cursor);
            if (end == std::string::npos)
            {
                end = edits.size();
            }
            const std::string_view line(edits.data() + cursor, end - cursor);
            if (!line.empty())
            {
                append_line(out, "tree-edit", line);
            }
            cursor = end < edits.size() ? end + 1 : end;
        }
    }
    return out;
}

inline std::vector<std::string_view> split_tokens(std::string_view value)
{
    std::vector<std::string_view> tokens;
    std::size_t index = 0;
    while (index < value.size())
    {
        if (value[index] == ' ')
        {
            throw std::invalid_argument("street config value has extra space");
        }
        const std::size_t next = value.find(' ', index);
        if (next == std::string_view::npos)
        {
            tokens.push_back(value.substr(index));
            break;
        }
        tokens.push_back(value.substr(index, next - index));
        index = next + 1;
        if (index == value.size())
        {
            throw std::invalid_argument("street config value has extra space");
        }
    }
    return tokens;
}

inline std::vector<double> parse_specs(std::string_view value)
{
    std::vector<double> specs;
    for (const std::string_view token : split_tokens(value))
    {
        if (!token.empty() && token.back() == 'c')
        {
            const double magnitude = parse_finite(token.substr(0, token.size() - 1));
            if (!(magnitude > 0.0))
            {
                throw std::invalid_argument("a chip size must be positive");
            }
            specs.push_back(-magnitude);
            continue;
        }
        if (!token.empty() && (token.back() == 'x' || token.back() == 'X'))
        {
            throw std::invalid_argument(
                "a street config size is a pot fraction or a chip amount such as 20c");
        }
        const double fraction = parse_finite(token);
        if (fraction < 0.0)
        {
            throw std::invalid_argument(
                "a negative size must be written as a chip amount such as 20c");
        }
        specs.push_back(fraction);
    }
    return specs;
}

inline std::vector<double> parse_numbers(std::string_view value)
{
    std::vector<double> numbers;
    for (const std::string_view token : split_tokens(value))
    {
        if (!token.empty() && (token.back() == 'c' || token.back() == 'x' || token.back() == 'X'))
        {
            throw std::invalid_argument("a raise multiple is a plain number");
        }
        numbers.push_back(parse_finite(token));
    }
    return numbers;
}

inline int parse_int(std::string_view text)
{
    int value = 0;
    const char* const begin = text.data();
    const char* const end = begin + text.size();
    const std::from_chars_result result = std::from_chars(begin, end, value);
    if (result.ec != std::errc{} || result.ptr != end)
    {
        throw std::invalid_argument("bad integer in street config");
    }
    return value;
}

inline bool parse_flag(std::string_view text)
{
    if (text == "0")
    {
        return false;
    }
    if (text == "1")
    {
        return true;
    }
    throw std::invalid_argument("a street config flag must be 0 or 1");
}

inline void take_field(std::vector<std::string>& seen, const std::string& key)
{
    for (const std::string& prior : seen)
    {
        if (prior == key)
        {
            throw std::invalid_argument("duplicate street config field " + key);
        }
    }
    seen.push_back(key);
}

struct SizeField
{
    const char* key;
    std::vector<double> StreetConfig::* member;
};

inline StreetConfig parse_street_config(std::string_view text)
{
    if (text.empty() || text.back() != '\n')
    {
        throw std::invalid_argument("street config needs a trailing newline");
    }
    if (text.find('\r') != std::string_view::npos)
    {
        throw std::invalid_argument("street config must use LF line endings");
    }

    std::vector<std::string_view> lines;
    std::size_t start = 0;
    while (start < text.size())
    {
        const std::size_t end = text.find('\n', start);
        lines.push_back(text.substr(start, end - start));
        start = end + 1;
    }
    if (!lines.empty() && lines.back().empty())
    {
        lines.pop_back();
    }
    if (lines.empty() || lines[0] != "street-config 1")
    {
        throw std::invalid_argument("unsupported street-config version");
    }

    static constexpr SizeField kSizeFields[] = {
        {"oop-bets", &StreetConfig::oop_bet_sizes},
        {"ip-bets", &StreetConfig::ip_bet_sizes},
        {"oop-raises", &StreetConfig::oop_raise_sizes},
        {"ip-raises", &StreetConfig::ip_raise_sizes},
        {"oop-flop-bets", &StreetConfig::oop_flop_bets},
        {"oop-turn-bets", &StreetConfig::oop_turn_bets},
        {"oop-river-bets", &StreetConfig::oop_river_bets},
        {"ip-flop-bets", &StreetConfig::ip_flop_bets},
        {"ip-turn-bets", &StreetConfig::ip_turn_bets},
        {"ip-river-bets", &StreetConfig::ip_river_bets},
        {"oop-flop-raises", &StreetConfig::oop_flop_raises},
        {"oop-turn-raises", &StreetConfig::oop_turn_raises},
        {"oop-river-raises", &StreetConfig::oop_river_raises},
        {"ip-flop-raises", &StreetConfig::ip_flop_raises},
        {"ip-turn-raises", &StreetConfig::ip_turn_raises},
        {"ip-river-raises", &StreetConfig::ip_river_raises},
        {"oop-donk", &StreetConfig::oop_donk_sizes},
    };

    StreetConfig config;
    std::vector<std::string> seen;
    for (std::size_t line_index = 1; line_index < lines.size(); ++line_index)
    {
        const std::string_view line = lines[line_index];
        if (line.empty())
        {
            throw std::invalid_argument("street config contains a blank line");
        }
        const std::size_t space = line.find(' ');
        const std::string key(space == std::string_view::npos ? line : line.substr(0, space));
        const std::string_view value = space == std::string_view::npos ? std::string_view{} : line.substr(space + 1);
        // tree-edit may repeat (one LineEdit per line). Other keys stay unique.
        if (key == "tree-edit")
        {
            if (value.empty())
            {
                throw std::invalid_argument("tree-edit needs a value");
            }
            std::string edit_line(value);
            edit_line.push_back('\n');
            const poker::solver::TreeEditSet parsed = poker::solver::parse_tree_edits(edit_line);
            if (parsed.size() != 1)
            {
                throw std::invalid_argument("tree-edit must describe one edit");
            }
            config.tree_edits.append(parsed.edits[0]);
            continue;
        }
        if (key == "incentive")
        {
            // Repeatable: one rule per line. Spelling: incentive label|tag PLAYER KEY DELTA
            const std::vector<std::string_view> tokens = split_tokens(value);
            if (tokens.size() != 4)
            {
                throw std::invalid_argument(
                    "incentive needs kind player key delta (e.g. label 0 b100 3.5)");
            }
            poker::solver::IncentiveRule rule;
            if (tokens[0] == "label")
            {
                rule.kind = poker::solver::IncentiveKind::ActionLabelMatch;
            }
            else if (tokens[0] == "tag")
            {
                rule.kind = poker::solver::IncentiveKind::CategoryTag;
            }
            else
            {
                throw std::invalid_argument("incentive kind must be label or tag");
            }
            rule.player = parse_int(tokens[1]);
            rule.key = std::string(tokens[2]);
            rule.delta = parse_finite(tokens[3]);
            config.incentives.add(std::move(rule));
            continue;
        }
        if (key == "edge-tag")
        {
            // Repeatable. Spelling: edge-tag [PLAYER] ACTION TAG [TAG...]
            // PLAYER is optional 0/1; omitted means either seat. ACTION matches
            // compact or display labels on the solve path.
            const std::vector<std::string_view> tokens = split_tokens(value);
            if (tokens.size() < 2)
            {
                throw std::invalid_argument(
                    "edge-tag needs ACTION TAG (optional PLAYER first)");
            }
            poker::solver::IncentiveEdgeTagSpec spec;
            std::size_t tag_at = 1;
            if (!tokens[0].empty()
                && (tokens[0][0] == '0' || tokens[0][0] == '1')
                && tokens[0].size() == 1
                && tokens.size() >= 3)
            {
                spec.player = parse_int(tokens[0]);
                spec.action_key = std::string(tokens[1]);
                tag_at = 2;
            }
            else
            {
                spec.action_key = std::string(tokens[0]);
            }
            for (std::size_t i = tag_at; i < tokens.size(); ++i)
            {
                spec.tags.emplace_back(tokens[i]);
            }
            config.incentives.add_edge_tag(std::move(spec));
            continue;
        }
        take_field(seen, key);

        if (key == "board")
        {
            config.board.clear();
            for (const std::string_view token : split_tokens(value))
            {
                config.board.push_back(holdem::parse_card(token));
            }
        }
        else if (key == "pot")
        {
            config.pot = parse_int(value);
        }
        else if (key == "stack")
        {
            config.stack = parse_int(value);
        }
        else if (key == "oop-range")
        {
            config.oop = holdem::Range::parse(value);
        }
        else if (key == "ip-range")
        {
            config.ip = holdem::Range::parse(value);
        }
        else if (key == "first-to-act")
        {
            config.first_to_act = parse_int(value);
        }
        else if (key == "max-raises")
        {
            config.max_raises = parse_int(value);
        }
        else if (key == "allow-all-in")
        {
            config.allow_all_in = parse_flag(value);
        }
        else if (key == "allow-three-bet")
        {
            config.allow_three_bet = parse_flag(value);
        }
        else if (key == "geometric")
        {
            config.geometric = parse_flag(value);
        }
        else if (key == "all-in-threshold")
        {
            config.all_in_threshold = parse_finite(value);
        }
        else if (key == "pot-cap")
        {
            config.pot_cap = parse_finite(value);
        }
        else if (key == "rake-rate")
        {
            config.rake.rate = parse_finite(value);
        }
        else if (key == "rake-cap")
        {
            config.rake.cap = parse_finite(value);
        }
        else if (key == "icm-stacks")
        {
            config.icm.stacks = parse_numbers(value);
        }
        else if (key == "icm-payouts")
        {
            config.icm.payouts = parse_numbers(value);
        }
        else if (key == "memory-mib")
        {
            config.memory_mib = parse_int(value);
        }
        else if (key == "threads")
        {
            config.threads = parse_int(value);
        }
        else if (key == "oop-raise-multiples")
        {
            config.oop_raise_multiples = parse_numbers(value);
        }
        else if (key == "ip-raise-multiples")
        {
            config.ip_raise_multiples = parse_numbers(value);
        }
        else
        {
            bool matched = false;
            for (const SizeField& field : kSizeFields)
            {
                if (key == field.key)
                {
                    config.*(field.member) = parse_specs(value);
                    matched = true;
                    break;
                }
            }
            if (!matched)
            {
                throw std::invalid_argument("unknown street config field " + key);
            }
        }
    }
    return config;
}

} // namespace poker::streets
