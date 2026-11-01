#pragma once

#include "solver/incentives.hpp"

#include <cctype>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace poker::explorer
{

// Minimal JSON helpers for incentive Job fields. Kept out of explorer_main.cpp
// so solve/status wiring stays thin. Expects the same lightweight JSON dialect
// used elsewhere in the explorer (no nested objects inside string values).

inline std::size_t incentive_find_key(std::string_view text, std::string_view key)
{
    const std::string needle = "\"" + std::string(key) + "\"";
    return text.find(needle);
}

inline std::size_t incentive_value_at(std::string_view text, std::size_t key_at)
{
    const std::size_t colon = text.find(':', key_at);
    if (colon == std::string_view::npos)
    {
        throw std::invalid_argument("incentive JSON key is missing a value");
    }
    std::size_t cursor = colon + 1;
    while (cursor < text.size()
           && std::isspace(static_cast<unsigned char>(text[cursor])))
    {
        ++cursor;
    }
    return cursor;
}

inline std::string incentive_read_string_field(std::string_view object, std::string_view key)
{
    const std::size_t at = incentive_find_key(object, key);
    if (at == std::string_view::npos)
    {
        throw std::invalid_argument(std::string(key) + " is required on incentive rules");
    }
    const std::size_t cursor = incentive_value_at(object, at);
    if (cursor >= object.size() || object[cursor] != '"')
    {
        throw std::invalid_argument(std::string(key) + " must be a string");
    }
    std::string value;
    for (std::size_t i = cursor + 1; i < object.size(); ++i)
    {
        if (object[i] == '\\' && i + 1 < object.size())
        {
            value.push_back(object[i + 1]);
            ++i;
            continue;
        }
        if (object[i] == '"')
        {
            return value;
        }
        value.push_back(object[i]);
    }
    throw std::invalid_argument(std::string(key) + " is missing an end quote");
}

inline double incentive_read_number_field(std::string_view object, std::string_view key)
{
    const std::size_t at = incentive_find_key(object, key);
    if (at == std::string_view::npos)
    {
        throw std::invalid_argument(std::string(key) + " is required on incentive rules");
    }
    const std::size_t cursor = incentive_value_at(object, at);
    return std::atof(std::string(object.substr(cursor)).c_str());
}

inline int incentive_read_int_field(std::string_view object, std::string_view key, int fallback)
{
    const std::size_t at = incentive_find_key(object, key);
    if (at == std::string_view::npos)
    {
        return fallback;
    }
    const std::size_t cursor = incentive_value_at(object, at);
    return std::atoi(std::string(object.substr(cursor)).c_str());
}

inline std::vector<std::string_view> incentive_split_objects(std::string_view array_body)
{
    std::vector<std::string_view> objects;
    int depth = 0;
    std::size_t start = std::string_view::npos;
    for (std::size_t i = 0; i < array_body.size(); ++i)
    {
        const char ch = array_body[i];
        if (ch == '{')
        {
            if (depth == 0)
            {
                start = i;
            }
            ++depth;
        }
        else if (ch == '}')
        {
            if (depth == 0)
            {
                throw std::invalid_argument("incentives array has a stray '}'");
            }
            --depth;
            if (depth == 0 && start != std::string_view::npos)
            {
                objects.push_back(array_body.substr(start, i - start + 1));
                start = std::string_view::npos;
            }
        }
    }
    if (depth != 0)
    {
        throw std::invalid_argument("incentives array has an unclosed object");
    }
    return objects;
}

inline std::string_view incentive_array_body(std::string_view text, std::string_view key)
{
    const std::size_t at = incentive_find_key(text, key);
    if (at == std::string_view::npos)
    {
        return {};
    }
    const std::size_t start = text.find('[', incentive_value_at(text, at));
    if (start == std::string_view::npos)
    {
        throw std::invalid_argument(std::string(key) + " must be an array");
    }
    int depth = 0;
    for (std::size_t i = start; i < text.size(); ++i)
    {
        if (text[i] == '[')
        {
            ++depth;
        }
        else if (text[i] == ']')
        {
            --depth;
            if (depth == 0)
            {
                return text.substr(start + 1, i - start - 1);
            }
        }
    }
    throw std::invalid_argument(std::string(key) + " array is unclosed");
}

inline std::vector<std::string> incentive_read_string_array_field(
    std::string_view object, std::string_view key)
{
    std::vector<std::string> values;
    const std::string_view body = incentive_array_body(object, key);
    if (body.empty() && incentive_find_key(object, key) == std::string_view::npos)
    {
        return values;
    }
    std::size_t cursor = 0;
    while (cursor < body.size())
    {
        while (cursor < body.size()
               && (std::isspace(static_cast<unsigned char>(body[cursor])) || body[cursor] == ','))
        {
            ++cursor;
        }
        if (cursor >= body.size())
        {
            break;
        }
        if (body[cursor] != '"')
        {
            throw std::invalid_argument(std::string(key) + " entries must be strings");
        }
        std::string item;
        ++cursor;
        while (cursor < body.size())
        {
            if (body[cursor] == '\\' && cursor + 1 < body.size())
            {
                item.push_back(body[cursor + 1]);
                cursor += 2;
                continue;
            }
            if (body[cursor] == '"')
            {
                ++cursor;
                break;
            }
            item.push_back(body[cursor++]);
        }
        values.push_back(std::move(item));
    }
    return values;
}

inline poker::solver::IncentiveConfig parse_incentive_config_json(std::string_view text)
{
    poker::solver::IncentiveConfig config;
    const std::string_view rules_body = incentive_array_body(text, "incentives");
    if (!rules_body.empty() || incentive_find_key(text, "incentives") != std::string_view::npos)
    {
        for (const std::string_view object : incentive_split_objects(rules_body))
        {
            poker::solver::IncentiveRule rule;
            const std::string kind = incentive_read_string_field(object, "kind");
            if (kind == "label")
            {
                rule.kind = poker::solver::IncentiveKind::ActionLabelMatch;
            }
            else if (kind == "tag")
            {
                rule.kind = poker::solver::IncentiveKind::CategoryTag;
            }
            else
            {
                throw std::invalid_argument("incentive kind must be \"label\" or \"tag\"");
            }
            rule.player = incentive_read_int_field(object, "player", -1);
            rule.key = incentive_read_string_field(object, "key");
            rule.delta = incentive_read_number_field(object, "delta");
            config.add(std::move(rule));
        }
    }
    const std::string_view tags_body = incentive_array_body(text, "edge_tags");
    if (!tags_body.empty() || incentive_find_key(text, "edge_tags") != std::string_view::npos)
    {
        for (const std::string_view object : incentive_split_objects(tags_body))
        {
            poker::solver::IncentiveEdgeTagSpec spec;
            spec.player = incentive_read_int_field(object, "player", -1);
            // Accept either "action" or "key" for the action label.
            if (incentive_find_key(object, "action") != std::string_view::npos)
            {
                spec.action_key = incentive_read_string_field(object, "action");
            }
            else
            {
                spec.action_key = incentive_read_string_field(object, "key");
            }
            spec.tags = incentive_read_string_array_field(object, "tags");
            config.add_edge_tag(std::move(spec));
        }
    }
    config.validate();
    return config;
}

inline void append_escaped_incentive(std::string& out, std::string_view text)
{
    out.push_back('"');
    for (const char ch : text)
    {
        if (ch == '\\' || ch == '"')
        {
            out.push_back('\\');
        }
        out.push_back(ch);
    }
    out.push_back('"');
}

inline void append_incentive_config_json(
    std::string& out, const poker::solver::IncentiveConfig& incentives)
{
    out += "\"incentives\":[";
    for (std::size_t i = 0; i < incentives.rules.size(); ++i)
    {
        if (i > 0)
        {
            out += ',';
        }
        const poker::solver::IncentiveRule& rule = incentives.rules[i];
        out += "{\"kind\":";
        append_escaped_incentive(
            out, rule.kind == poker::solver::IncentiveKind::CategoryTag ? "tag" : "label");
        out += ",\"player\":";
        out += std::to_string(rule.player);
        out += ",\"key\":";
        append_escaped_incentive(out, rule.key);
        out += ",\"delta\":";
        {
            std::ostringstream stream;
            stream.setf(std::ios::fmtflags(0), std::ios::floatfield);
            stream.precision(12);
            stream << rule.delta;
            out += stream.str();
        }
        out += '}';
    }
    out += "],\"edge_tags\":[";
    for (std::size_t i = 0; i < incentives.edge_tags.size(); ++i)
    {
        if (i > 0)
        {
            out += ',';
        }
        const poker::solver::IncentiveEdgeTagSpec& spec = incentives.edge_tags[i];
        out += "{\"player\":";
        out += std::to_string(spec.player);
        out += ",\"action\":";
        append_escaped_incentive(out, spec.action_key);
        out += ",\"tags\":[";
        for (std::size_t t = 0; t < spec.tags.size(); ++t)
        {
            if (t > 0)
            {
                out += ',';
            }
            append_escaped_incentive(out, spec.tags[t]);
        }
        out += "]}";
    }
    out += ']';
}

} // namespace poker::explorer
