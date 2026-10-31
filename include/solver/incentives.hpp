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

} // namespace poker::solver
