#include "harness.hpp"

#include "solver/incentives.hpp"
#include "solver/payoff.hpp"

#include <stdexcept>

using poker::solver::IncentiveConfig;
using poker::solver::IncentiveContext;
using poker::solver::IncentiveEdge;
using poker::solver::IncentiveEdgeTagSpec;
using poker::solver::IncentiveKind;
using poker::solver::IncentiveRule;
using poker::solver::IncentiveTable;
using poker::solver::PlayerPayoff;
using poker::solver::apply_incentive_edge;
using poker::solver::apply_incentives;
using poker::solver::attach_edge_tags;

void run_incentives_tests()
{
    const PlayerPayoff base{10.0, -10.0};

    // No rules: identity overlay.
    {
        const IncentiveContext ctx{0, "b50", {"value"}};
        const PlayerPayoff out = apply_incentives(base, {}, ctx);
        CHECK(out.utility[0] == base.utility[0]);
        CHECK(out.utility[1] == base.utility[1]);
    }
    {
        IncentiveTable table;
        const IncentiveContext ctx{1, "c", {"bluff"}};
        const PlayerPayoff out = table.apply(base, ctx);
        CHECK(out.utility[0] == base.utility[0]);
        CHECK(out.utility[1] == base.utility[1]);
    }

    // Single ActionLabelMatch rule shifts only the matched player.
    {
        const IncentiveRule rules[] = {
            {IncentiveKind::ActionLabelMatch, "b75", 0, 3.5},
        };
        const IncentiveContext hit{0, "b75", {"bluff"}};
        const PlayerPayoff out = apply_incentives(base, rules, hit);
        CHECK_NEAR(out.utility[0], 13.5, 1e-12);
        CHECK_NEAR(out.utility[1], -10.0, 1e-12);

        const IncentiveContext miss_label{0, "b50", {"bluff"}};
        const PlayerPayoff same = apply_incentives(base, rules, miss_label);
        CHECK(same.utility[0] == base.utility[0]);
        CHECK(same.utility[1] == base.utility[1]);

        const IncentiveContext miss_player{1, "b75", {"bluff"}};
        const PlayerPayoff same_player = apply_incentives(base, rules, miss_player);
        CHECK(same_player.utility[0] == base.utility[0]);
        CHECK(same_player.utility[1] == base.utility[1]);
    }

    // Single CategoryTag rule shifts only the matched player.
    {
        IncentiveTable table;
        table.add(IncentiveRule{
            IncentiveKind::CategoryTag,
            "bluff",
            1,
            2.0,
        });
        const IncentiveContext hit{1, "b33", {"semi", "bluff"}};
        const PlayerPayoff out = table.apply(base, hit);
        CHECK_NEAR(out.utility[0], 10.0, 1e-12);
        CHECK_NEAR(out.utility[1], -8.0, 1e-12);

        const IncentiveContext miss{1, "b33", {"value"}};
        const PlayerPayoff same = table.apply(base, miss);
        CHECK(same.utility[0] == base.utility[0]);
        CHECK(same.utility[1] == base.utility[1]);
    }

    // Multiple matching rules stack; non-matching rules are ignored.
    {
        const IncentiveRule rules[] = {
            {IncentiveKind::ActionLabelMatch, "b50", 0, 1.0},
            {IncentiveKind::CategoryTag, "bluff", 0, 4.0},
            {IncentiveKind::CategoryTag, "bluff", 1, -2.0}, // other player: skip
            {IncentiveKind::ActionLabelMatch, "x", 0, 9.0},  // other label: skip
        };
        const IncentiveContext ctx{0, "b50", {"bluff", "overbet"}};
        const PlayerPayoff out = apply_incentives(base, rules, ctx);
        CHECK_NEAR(out.utility[0], 15.0, 1e-12); // 10 + 1 + 4
        CHECK_NEAR(out.utility[1], -10.0, 1e-12);
    }

    // Separate acting contexts: each player's rule fires only for that seat.
    {
        IncentiveTable table;
        table.add({IncentiveKind::ActionLabelMatch, "c", 0, 1.0});
        table.add({IncentiveKind::ActionLabelMatch, "c", 1, 2.0});
        const PlayerPayoff p0 = table.apply(base, IncentiveContext{0, "c", {}});
        CHECK_NEAR(p0.utility[0], 11.0, 1e-12);
        CHECK_NEAR(p0.utility[1], -10.0, 1e-12);
        const PlayerPayoff p1 = table.apply(base, IncentiveContext{1, "c", {}});
        CHECK_NEAR(p1.utility[0], 10.0, 1e-12);
        CHECK_NEAR(p1.utility[1], -8.0, 1e-12);
    }

    // Edge-tag attachment feeds CategoryTag matching on IncentiveEdge.
    {
        IncentiveConfig config;
        config.add_edge_tag(IncentiveEdgeTagSpec{-1, "b100", {"bluff", "overbet"}});
        config.add_edge_tag(IncentiveEdgeTagSpec{1, "f", {"give_up"}});
        IncentiveEdge edge;
        edge.player = 0;
        edge.compact_label = "b100";
        edge.display_label = "Bet 100";
        attach_edge_tags(edge, config);
        CHECK(edge.tags.size() == 2);
        CHECK(edge.tags[0] == "bluff");
        CHECK(edge.tags[1] == "overbet");

        IncentiveEdge fold;
        fold.player = 0;
        fold.compact_label = "f";
        fold.display_label = "Fold";
        attach_edge_tags(fold, config);
        CHECK(fold.tags.empty()); // player filter is seat 1 only

        fold.player = 1;
        attach_edge_tags(fold, config);
        CHECK(fold.tags.size() == 1);
        CHECK(fold.tags[0] == "give_up");

        config.add(IncentiveRule{IncentiveKind::CategoryTag, "bluff", 0, 4.0});
        PlayerPayoff paid{10.0, -10.0};
        apply_incentive_edge(paid, config.rules, edge);
        CHECK_NEAR(paid.utility[0], 14.0, 1e-12);
        CHECK_NEAR(paid.utility[1], -10.0, 1e-12);
    }

    // Reject bad player / non-finite inputs.
    {
        bool threw = false;
        try
        {
            IncentiveTable table;
            table.add({IncentiveKind::CategoryTag, "x", 2, 1.0});
        }
        catch (const std::invalid_argument&)
        {
            threw = true;
        }
        CHECK(threw);
    }
    {
        bool threw = false;
        try
        {
            const IncentiveRule rules[] = {
                {IncentiveKind::ActionLabelMatch, "b", 0, 1.0},
            };
            (void)apply_incentives(base, rules, IncentiveContext{3, "b", {}});
        }
        catch (const std::invalid_argument&)
        {
            threw = true;
        }
        CHECK(threw);
    }
}
