#include "harness.hpp"

#include "poker/equity.hpp"

#include <cmath>
#include <span>
#include <stdexcept>
#include <vector>

using poker::holdem::ComboShowdown;
using poker::holdem::EquityDistributionBucket;
using poker::holdem::EquityError;
using poker::holdem::EquityHandRow;
using poker::holdem::PlayerShowdown;
using poker::holdem::equity_distribution;
using poker::holdem::equity_hand_rows;
using poker::holdem::equity_hand_rows_json;
using poker::holdem::kEquityDistributionBuckets;

namespace
{

double bucket_weight_sum(const std::vector<EquityDistributionBucket>& buckets)
{
    double total = 0.0;
    for (const EquityDistributionBucket& bucket : buckets)
    {
        total += bucket.weight;
    }
    return total;
}

void expect_edges(const std::vector<EquityDistributionBucket>& buckets)
{
    CHECK(static_cast<int>(buckets.size()) == kEquityDistributionBuckets);
    for (int i = 0; i < kEquityDistributionBuckets; ++i)
    {
        CHECK_NEAR(buckets[static_cast<std::size_t>(i)].lo, i / 10.0, 1e-15);
        CHECK_NEAR(buckets[static_cast<std::size_t>(i)].hi, (i + 1) / 10.0, 1e-15);
    }
}

} // namespace

void run_equity_dist_tests()
{
    {
        const std::vector<EquityDistributionBucket> empty =
            equity_distribution(std::span<const double>{}, std::span<const double>{});
        expect_edges(empty);
        CHECK_NEAR(bucket_weight_sum(empty), 0.0, 1e-15);
        for (const EquityDistributionBucket& bucket : empty)
        {
            CHECK_NEAR(bucket.weight, 0.0, 1e-15);
        }
    }

    {
        const double equities[] = {0.42};
        const double weights[] = {3.0};
        const std::vector<EquityDistributionBucket> single =
            equity_distribution(equities, weights);
        expect_edges(single);
        CHECK_NEAR(bucket_weight_sum(single), 3.0, 1e-15);
        for (int i = 0; i < kEquityDistributionBuckets; ++i)
        {
            const double expected = (i == 4) ? 3.0 : 0.0;
            CHECK_NEAR(single[static_cast<std::size_t>(i)].weight, expected, 1e-15);
        }
    }

    {
        // Mass at 0 and at 1 lands in the first and last buckets.
        const double equities[] = {0.0, 1.0};
        const double weights[] = {2.0, 5.0};
        const std::vector<EquityDistributionBucket> two =
            equity_distribution(equities, weights);
        expect_edges(two);
        CHECK_NEAR(bucket_weight_sum(two), 7.0, 1e-15);
        CHECK_NEAR(two[0].weight, 2.0, 1e-15);
        CHECK_NEAR(two[9].weight, 5.0, 1e-15);
        for (int i = 1; i < 9; ++i)
        {
            CHECK_NEAR(two[static_cast<std::size_t>(i)].weight, 0.0, 1e-15);
        }
    }

    {
        // Boundary 0.1 is the start of the second bucket; 0.9 starts the last.
        const double equities[] = {0.1, 0.9, 0.099999999999, 1.5, -0.2};
        const double weights[] = {1.0, 1.0, 1.0, 1.0, 1.0};
        const std::vector<EquityDistributionBucket> edges =
            equity_distribution(equities, weights);
        expect_edges(edges);
        CHECK_NEAR(bucket_weight_sum(edges), 5.0, 1e-15);
        CHECK_NEAR(edges[0].weight, 2.0, 1e-12); // -0.2 clamped + just under 0.1
        CHECK_NEAR(edges[1].weight, 1.0, 1e-15); // 0.1
        CHECK_NEAR(edges[9].weight, 2.0, 1e-15); // 0.9 and 1.5 clamped
    }

    {
        PlayerShowdown player;
        ComboShowdown low;
        low.defined = true;
        low.equity = 0.05;
        low.input_weight = 4.0;
        ComboShowdown undefined;
        undefined.defined = false;
        undefined.equity = 0.99;
        undefined.input_weight = 100.0;
        ComboShowdown zero;
        zero.defined = true;
        zero.equity = 0.55;
        zero.input_weight = 0.0;
        ComboShowdown high;
        high.defined = true;
        high.equity = 0.95;
        high.input_weight = 1.5;
        player.combos = {low, undefined, zero, high};
        const std::vector<EquityDistributionBucket> from_player = equity_distribution(player);
        expect_edges(from_player);
        CHECK_NEAR(bucket_weight_sum(from_player), 5.5, 1e-15);
        CHECK_NEAR(from_player[0].weight, 4.0, 1e-15);
        CHECK_NEAR(from_player[9].weight, 1.5, 1e-15);

        player.combos[0].combo = "2c3d";
        player.combos[3].combo = "AhAd";
        const std::vector<EquityHandRow> hands = equity_hand_rows(player);
        CHECK(hands.size() == 2);
        CHECK(hands[0].combo == "2c3d");
        CHECK_NEAR(hands[0].equity, 0.05, 1e-15);
        CHECK_NEAR(hands[0].weight, 4.0, 1e-15);
        CHECK(hands[1].combo == "AhAd");
        CHECK_NEAR(hands[1].equity, 0.95, 1e-15);
        const std::string hands_json = equity_hand_rows_json(hands);
        CHECK(hands_json.find("\"combo\":\"2c3d\"") != std::string::npos);
        CHECK(hands_json.find("\"combo\":\"AhAd\"") != std::string::npos);
    }

    {
        bool threw = false;
        try
        {
            const double equities[] = {0.5};
            const double weights[] = {-1.0};
            (void)equity_distribution(equities, weights);
        }
        catch (const EquityError&)
        {
            threw = true;
        }
        CHECK(threw);
    }

    {
        bool threw = false;
        try
        {
            const double equities[] = {0.5};
            (void)equity_distribution(equities, std::span<const double>{});
        }
        catch (const std::invalid_argument&)
        {
            threw = true;
        }
        CHECK(threw);
    }
}
