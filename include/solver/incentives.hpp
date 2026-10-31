#pragma once

#include "solver/payoff.hpp"

#include <cmath>
#include <span>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace poker::solver
{

// How an IncentiveRule selects an action at a node. String keys are enough for
// the standalone overlay; richer category enums can wrap the same tags later.
enum class IncentiveKind
{
    ActionLabelMatch, // rule.key equals the taken action's label
    CategoryTag,      // rule.key appears in the context tag list
};

// One utility bias for one player when a match fires.
//
// On a match, `delta` is added to utility[player]; the other seat is unchanged
// unless a second rule targets them. See docs/INCENTIVES.md.
struct IncentiveRule
{
    IncentiveKind kind = IncentiveKind::ActionLabelMatch;
    std::string key;
    int player = 0; // 0 or 1
    double delta = 0.0;
};

// Acting seat plus the label/tags of the action under consideration.
struct IncentiveContext
{
    int player = 0; // acting player; must equal a rule's player for that rule to apply
    std::string action_label;
    std::vector<std::string> tags;
};

inline bool incentive_rule_matches(
    const IncentiveRule& rule,
    const IncentiveContext& ctx) noexcept
{
    if (rule.player != ctx.player)
    {
        return false;
    }
    if (rule.kind == IncentiveKind::ActionLabelMatch)
    {
        return rule.key == ctx.action_label;
    }
    for (const std::string& tag : ctx.tags)
    {
        if (tag == rule.key)
        {
            return true;
        }
    }
    return false;
}

inline void validate_incentive_rule(const IncentiveRule& rule)
{
    if (rule.player != 0 && rule.player != 1)
    {
        throw std::invalid_argument("incentive rule player must be 0 or 1");
    }
    if (!std::isfinite(rule.delta))
    {
        throw std::invalid_argument("incentive rule delta must be finite");
    }
}

inline void validate_incentive_context(const IncentiveContext& ctx)
{
    if (ctx.player != 0 && ctx.player != 1)
    {
        throw std::invalid_argument("incentive context player must be 0 or 1");
    }
}

// Copy base utilities and add every matching rule's delta to that rule's player.
// Empty rules leave the payoff unchanged (identity). Matching rules stack.
inline PlayerPayoff apply_incentives(
    const PlayerPayoff& base,
    std::span<const IncentiveRule> rules,
    const IncentiveContext& ctx)
{
    validate_incentive_context(ctx);
    if (!std::isfinite(base.utility[0]) || !std::isfinite(base.utility[1]))
    {
        throw std::invalid_argument("incentive base utilities must be finite");
    }

    PlayerPayoff out = base;
    for (const IncentiveRule& rule : rules)
    {
        validate_incentive_rule(rule);
        if (incentive_rule_matches(rule, ctx))
        {
            out.utility[rule.player] += rule.delta;
        }
    }
    return out;
}

// Owned rule list for a node or scenario. apply() forwards to apply_incentives.
struct IncentiveTable
{
    std::vector<IncentiveRule> rules;

    void clear() noexcept
    {
        rules.clear();
    }

    void add(IncentiveRule rule)
    {
        validate_incentive_rule(rule);
        rules.push_back(std::move(rule));
    }

    PlayerPayoff apply(const PlayerPayoff& base, const IncentiveContext& ctx) const
    {
        return apply_incentives(base, rules, ctx);
    }
};

// Compact action token used as the preferred IncentiveRule.key on the solve path
// (same spelling as tree-edit path tokens: f, c, call, b50, r100, …).
inline std::string incentive_compact_token(
    int code, int add, int street_total, bool all_in, bool facing)
{
    if (code == 0)
    {
        return "f";
    }
    if (code == 1)
    {
        return facing ? "call" : "c";
    }
    std::string text = facing ? "r" + std::to_string(street_total) : "b" + std::to_string(add);
    if (all_in)
    {
        text += "ai";
    }
    return text;
}

// Inverse of incentive_chip_label for batch nodes that store display labels only.
// Returns empty when the string is not a known chip label.
inline std::string incentive_compact_from_display(std::string_view label)
{
    if (label == "Fold")
    {
        return "f";
    }
    if (label == "Check")
    {
        return "c";
    }
    if (label == "Call")
    {
        return "call";
    }
    bool all_in = false;
    std::string_view core = label;
    constexpr std::string_view k_all_in = " all-in";
    if (core.size() > k_all_in.size() && core.substr(core.size() - k_all_in.size()) == k_all_in)
    {
        all_in = true;
        core.remove_suffix(k_all_in.size());
    }
    if (core.size() > 4 && core.substr(0, 4) == "Bet ")
    {
        std::string token = "b";
        token.append(core.substr(4));
        if (all_in)
        {
            token += "ai";
        }
        return token;
    }
    constexpr std::string_view k_raise = "Raise to ";
    if (core.size() > k_raise.size() && core.substr(0, k_raise.size()) == k_raise)
    {
        std::string token = "r";
        token.append(core.substr(k_raise.size()));
        if (all_in)
        {
            token += "ai";
        }
        return token;
    }
    return {};
}

// Display chip label ("Fold", "Bet 100", …). ActionLabelMatch also accepts this.
inline std::string incentive_chip_label(
    int code, int add, int street_total, bool all_in, bool facing)
{
    std::string text;
    if (code == 0)
    {
        text = "Fold";
    }
    else if (code == 1 && !facing)
    {
        text = "Check";
    }
    else if (code == 1)
    {
        text = "Call";
    }
    else if (!facing)
    {
        text = "Bet " + std::to_string(add);
    }
    else
    {
        text = "Raise to " + std::to_string(street_total);
    }
    if (all_in && code != 0)
    {
        text += " all-in";
    }
    return text;
}

// One taken action on a root-to-terminal path. Category tags stay empty until a
// later PR attaches hand-category tags mid-tree.
struct IncentiveEdge
{
    int player = 0;
    std::string display_label;
    std::string compact_label;
};

// Optional solve-path overlay. Empty rules leave chip/ICM terminals unchanged.
// See docs/INCENTIVES.md.
struct IncentiveConfig
{
    std::vector<IncentiveRule> rules{};

    bool enabled() const noexcept
    {
        return !rules.empty();
    }

    void validate() const
    {
        for (const IncentiveRule& rule : rules)
        {
            validate_incentive_rule(rule);
        }
    }

    void add(IncentiveRule rule)
    {
        validate_incentive_rule(rule);
        rules.push_back(std::move(rule));
    }
};

// ActionLabelMatch accepts display or compact keys. CategoryTag needs tags on
// the edge (solve-path edges currently carry none, so those rules never fire).
inline void apply_incentive_edge(
    PlayerPayoff& inout,
    std::span<const IncentiveRule> rules,
    const IncentiveEdge& edge,
    std::span<const std::string> tags = {})
{
    if (edge.player != 0 && edge.player != 1)
    {
        throw std::invalid_argument("incentive edge player must be 0 or 1");
    }
    if (!std::isfinite(inout.utility[0]) || !std::isfinite(inout.utility[1]))
    {
        throw std::invalid_argument("incentive base utilities must be finite");
    }
    for (const IncentiveRule& rule : rules)
    {
        validate_incentive_rule(rule);
        if (rule.player != edge.player)
        {
            continue;
        }
        if (rule.kind == IncentiveKind::ActionLabelMatch)
        {
            if (rule.key == edge.compact_label || rule.key == edge.display_label)
            {
                inout.utility[rule.player] += rule.delta;
            }
            continue;
        }
        for (const std::string& tag : tags)
        {
            if (tag == rule.key)
            {
                inout.utility[rule.player] += rule.delta;
                break;
            }
        }
    }
}

// Path-attributed terminal wrap: sum matching edge deltas onto the base payoff.
// Empty rules are identity. Used after ChipPayoff (+ optional ICM).
inline PlayerPayoff apply_path_incentives(
    const IncentiveConfig& incentives,
    const PlayerPayoff& base,
    std::span<const IncentiveEdge> path)
{
    if (!incentives.enabled())
    {
        return base;
    }
    incentives.validate();
    if (!std::isfinite(base.utility[0]) || !std::isfinite(base.utility[1]))
    {
        throw std::invalid_argument("incentive base utilities must be finite");
    }
    PlayerPayoff out = base;
    for (const IncentiveEdge& edge : path)
    {
        apply_incentive_edge(out, incentives.rules, edge);
    }
    return out;
}

} // namespace poker::solver
