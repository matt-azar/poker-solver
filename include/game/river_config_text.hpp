#pragma once

#include "game/river_game.hpp"
#include "game/street_config_text.hpp"

#include <string>
#include <string_view>
#include <vector>

namespace poker::river
{

// river-config 1 is the versioned spelling of RiverConfig.
// format_river_config writes one document. parse_river_config reads it.

inline std::string format_river_board(const std::array<int, 5>& board)
{
    std::string value;
    for (int index = 0; index < 5; ++index)
    {
        if (index > 0)
        {
            value.push_back(' ');
        }
        value += holdem::format_card(board[static_cast<std::size_t>(index)]);
    }
    return value;
}

inline std::string format_river_config(const RiverConfig& config)
{
    std::string out;
    out += "river-config 1\n";
    streets::append_line(out, "board", format_river_board(config.board));
    streets::append_ints(out, "pot", config.pot);
    streets::append_ints(out, "stack", config.stack);
    streets::append_line(out, "oop-range", config.oop.to_combo_list());
    streets::append_line(out, "ip-range", config.ip.to_combo_list());
    streets::append_ints(out, "first-to-act", config.first_to_act);
    streets::append_ints(out, "max-raises", config.max_raises);
    streets::append_flag(out, "allow-all-in", config.allow_all_in);
    streets::append_line(out, "rake-rate", streets::format_number(config.rake.rate));
    streets::append_line(out, "rake-cap", streets::format_number(config.rake.cap));
    streets::append_numbers(out, "icm-stacks", config.icm.stacks);
    streets::append_numbers(out, "icm-payouts", config.icm.payouts);
    for (const poker::solver::IncentiveRule& rule : config.incentives.rules)
    {
        std::string value;
        value += rule.kind == poker::solver::IncentiveKind::CategoryTag ? "tag" : "label";
        value.push_back(' ');
        value += std::to_string(rule.player);
        value.push_back(' ');
        value += rule.key;
        value.push_back(' ');
        value += streets::format_number(rule.delta);
        streets::append_line(out, "incentive", value);
    }
    streets::append_specs(out, "oop-bets", config.oop_bet_sizes);
    streets::append_specs(out, "ip-bets", config.ip_bet_sizes);
    streets::append_specs(out, "oop-raises", config.oop_raise_sizes);
    streets::append_specs(out, "ip-raises", config.ip_raise_sizes);
    return out;
}

inline RiverConfig parse_river_config(std::string_view text)
{
    if (text.empty() || text.back() != '\n')
    {
        throw std::invalid_argument("river config needs a trailing newline");
    }
    if (text.find('\r') != std::string_view::npos)
    {
        throw std::invalid_argument("river config must use LF line endings");
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
    if (lines.empty() || lines[0] != "river-config 1")
    {
        throw std::invalid_argument("unsupported river-config version");
    }
    RiverConfig config;
    std::vector<std::string> seen;
    for (std::size_t line_index = 1; line_index < lines.size(); ++line_index)
    {
        const std::string_view line = lines[line_index];
        if (line.empty())
        {
            throw std::invalid_argument("river config contains a blank line");
        }
        const std::size_t space = line.find(' ');
        const std::string key(space == std::string_view::npos ? line : line.substr(0, space));
        const std::string_view value = space == std::string_view::npos ? std::string_view{} : line.substr(space + 1);
        if (key == "incentive")
        {
            const std::vector<std::string_view> tokens = streets::split_tokens(value);
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
            rule.player = streets::parse_int(tokens[1]);
            rule.key = std::string(tokens[2]);
            rule.delta = streets::parse_finite(tokens[3]);
            config.incentives.add(std::move(rule));
            continue;
        }
        streets::take_field(seen, key);
        if (key == "board")
        {
            const std::vector<std::string_view> tokens = streets::split_tokens(value);
            if (tokens.size() != 5)
            {
                throw std::invalid_argument("river config board must contain 5 cards");
            }
            for (int index = 0; index < 5; ++index)
            {
                config.board[static_cast<std::size_t>(index)] = holdem::parse_card(tokens[static_cast<std::size_t>(index)]);
            }
        }
        else if (key == "pot")
        {
            config.pot = streets::parse_int(value);
        }
        else if (key == "stack")
        {
            config.stack = streets::parse_int(value);
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
            config.first_to_act = streets::parse_int(value);
        }
        else if (key == "max-raises")
        {
            config.max_raises = streets::parse_int(value);
        }
        else if (key == "allow-all-in")
        {
            config.allow_all_in = streets::parse_flag(value);
        }
        else if (key == "rake-rate")
        {
            config.rake.rate = streets::parse_finite(value);
        }
        else if (key == "rake-cap")
        {
            config.rake.cap = streets::parse_finite(value);
        }
        else if (key == "icm-stacks")
        {
            config.icm.stacks = streets::parse_numbers(value);
        }
        else if (key == "icm-payouts")
        {
            config.icm.payouts = streets::parse_numbers(value);
        }
        else if (key == "oop-bets")
        {
            config.oop_bet_sizes = streets::parse_specs(value);
        }
        else if (key == "ip-bets")
        {
            config.ip_bet_sizes = streets::parse_specs(value);
        }
        else if (key == "oop-raises")
        {
            config.oop_raise_sizes = streets::parse_specs(value);
        }
        else if (key == "ip-raises")
        {
            config.ip_raise_sizes = streets::parse_specs(value);
        }
        else
        {
            throw std::invalid_argument("unknown river config field " + key);
        }
    }
    return config;
}

} // namespace poker::river
