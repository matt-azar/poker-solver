#include "poker/equity_calculator.hpp"

#include <cmath>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

namespace
{

int g_failed = 0;
int g_passed = 0;

void expect(bool condition, const std::string& label)
{
    if (condition)
    {
        ++g_passed;
        return;
    }
    ++g_failed;
    std::cerr << "FAIL: " << label << '\n';
}

void expect_near(double actual, double expected, double tol, const std::string& label)
{
    expect(
        std::isfinite(actual) && std::fabs(actual - expected) <= tol,
        label + " actual=" + std::to_string(actual));
}

std::uint64_t choose(std::uint64_t n, std::uint64_t k)
{
    if (k > n)
    {
        return 0;
    }
    if (k > n - k)
    {
        k = n - k;
    }
    std::uint64_t result = 1;
    for (std::uint64_t i = 1; i <= k; ++i)
    {
        result = result * (n - k + i) / i;
    }
    return result;
}

std::vector<int> cards(const char* text)
{
    return poker::holdem::parse_equity_calc_cards(text);
}

poker::holdem::EquityCalcPlayerInput player(const char* id, const char* range_text)
{
    poker::holdem::EquityCalcPlayerInput row;
    row.id = id;
    row.range = poker::holdem::Range::parse(range_text);
    return row;
}

} // namespace

int main()
{
    using namespace poker::holdem;

    // River certainty.
    {
        const auto board = cards("2c 3d 7h 9s Jc");
        std::vector<EquityCalcPlayerInput> players{
            player("a", "AsAd"),
            player("b", "KcKd"),
        };
        EquityCalcOptions options;
        options.method = EquityCalcMethod::Exact;
        const EquityCalcResult result = calculate_equity(players, board, {}, options);
        expect(result.joint_defined && result.exact_complete, "river certainty defined");
        expect_near(result.players[0].equity, 1.0, 1e-12, "AsAd river equity");
        expect_near(result.players[1].equity, 0.0, 1e-12, "KcKd river equity");
        expect_near(result.players[0].win, 1.0, 1e-12, "AsAd win");
        expect_near(result.players[0].tie, 0.0, 1e-12, "AsAd tie");
    }

    // Board-only royal flush splits three ways.
    {
        const auto board = cards("As Ks Qs Js Ts");
        std::vector<EquityCalcPlayerInput> players{
            player("a", "2c2d"),
            player("b", "3c3d"),
            player("c", "4c4d"),
        };
        EquityCalcOptions options;
        options.method = EquityCalcMethod::Exact;
        const EquityCalcResult result = calculate_equity(players, board, {}, options);
        expect(result.joint_defined, "royal split defined");
        expect_near(result.players[0].equity, 1.0 / 3.0, 1e-12, "royal a equity");
        expect_near(result.players[1].equity, 1.0 / 3.0, 1e-12, "royal b equity");
        expect_near(result.players[2].equity, 1.0 / 3.0, 1e-12, "royal c equity");
        expect_near(result.players[0].win, 0.0, 1e-12, "royal a win");
        expect_near(result.players[0].tie, 1.0, 1e-12, "royal a tie");
    }

    // Partial multiway split on river.
    {
        const auto board = cards("2c 3d 4h 5s 9c");
        std::vector<EquityCalcPlayerInput> players{
            player("a", "AcKd"),
            player("b", "AhQd"),
            player("c", "KhQs"),
        };
        EquityCalcOptions options;
        options.method = EquityCalcMethod::Exact;
        const EquityCalcResult result = calculate_equity(players, board, {}, options);
        expect(result.joint_defined, "partial split defined");
        expect_near(result.players[0].equity, 0.5, 1e-12, "AcKd equity");
        expect_near(result.players[1].equity, 0.5, 1e-12, "AhQd equity");
        expect_near(result.players[2].equity, 0.0, 1e-12, "KhQs equity");
    }

    // Fixed HU preflop completions.
    {
        std::vector<EquityCalcPlayerInput> players{
            player("a", "AsAd"),
            player("b", "KcKd"),
        };
        const EquityCalcWorkEstimate work = estimate_equity_work(players, {}, {});
        expect(work.completions_per_tuple == 1712304, "preflop C(48,5)");
        expect(work.legal_tuples == 1, "one legal preflop pair");
        expect(work.exact_deals == 1712304, "preflop exact deals");
    }

    // Dead cards reduce completions.
    {
        std::vector<EquityCalcPlayerInput> players{
            player("a", "AsAd"),
            player("b", "KcKd"),
        };
        const auto dead = cards("2c");
        const EquityCalcWorkEstimate work = estimate_equity_work(players, {}, dead);
        expect(work.completions_per_tuple == choose(47, 5), "dead card completions");
    }

    // Rescale invariance.
    {
        const auto board = cards("2c 3d 7h 9s Jc");
        std::vector<EquityCalcPlayerInput> base{
            player("a", "AsAd"),
            player("b", "KcKd:0.5"),
        };
        std::vector<EquityCalcPlayerInput> scaled{
            player("a", "AsAd"),
            player("b", "KcKd:2.5"),
        };
        EquityCalcOptions options;
        options.method = EquityCalcMethod::Exact;
        const EquityCalcResult left = calculate_equity(base, board, {}, options);
        const EquityCalcResult right = calculate_equity(scaled, board, {}, options);
        expect_near(left.players[0].equity, right.players[0].equity, 1e-12, "rescale equity");
    }

    // Equities sum to 1; win+tie+loss = 1.
    {
        const auto board = cards("Kh Kd 7c");
        std::vector<EquityCalcPlayerInput> players{
            player("a", "AhAd"),
            player("b", "2c2d"),
        };
        EquityCalcOptions options;
        options.method = EquityCalcMethod::Exact;
        const EquityCalcResult result = calculate_equity(players, board, {}, options);
        expect(result.joint_defined, "flop joint");
        expect_near(result.players[0].equity + result.players[1].equity, 1.0, 1e-9, "equity sum");
        expect_near(
            result.players[0].win + result.players[0].tie + result.players[0].loss,
            1.0,
            1e-9,
            "wtl sum");
    }

    // Monte Carlo agrees with exact on small river fixture.
    {
        const auto board = cards("2c 3d 7h 9s Jc");
        std::vector<EquityCalcPlayerInput> players{
            player("a", "AsAd"),
            player("b", "KcKd"),
        };
        EquityCalcOptions exact_opts;
        exact_opts.method = EquityCalcMethod::Exact;
        const EquityCalcResult exact = calculate_equity(players, board, {}, exact_opts);
        EquityCalcOptions mc_opts;
        mc_opts.method = EquityCalcMethod::MonteCarlo;
        mc_opts.target_samples = 5000;
        mc_opts.max_attempts = 50000;
        mc_opts.seed = 42;
        const EquityCalcResult mc = calculate_equity(players, board, {}, mc_opts);
        expect(mc.joint_defined && mc.accepted_samples == 5000, "mc samples");
        expect_near(mc.players[0].equity, exact.players[0].equity, 0.02, "mc vs exact");
    }

    // Overlapping asymmetric ranges: three legal pairs.
    {
        const auto board = cards("3h 4h 7s 9d Jc");
        std::vector<EquityCalcPlayerInput> players{
            player("a", "AsAh,KcKd"),
            player("b", "AsQs,2c2d"),
        };
        EquityCalcOptions options;
        options.method = EquityCalcMethod::Exact;
        const EquityCalcResult result = calculate_equity(players, board, {}, options);
        expect(result.joint_defined, "overlap fixture defined");
        expect(result.work.legal_tuples == 3, "three legal pairs");
        expect_near(result.players[0].equity + result.players[1].equity, 1.0, 1e-9, "overlap sum");
    }

    // Empty joint is undefined success.
    {
        const auto board = cards("As Ad Ac");
        std::vector<EquityCalcPlayerInput> players{
            player("a", "AsKh"),
            player("b", "AdKd"),
        };
        EquityCalcOptions options;
        options.method = EquityCalcMethod::Exact;
        const EquityCalcResult result = calculate_equity(players, board, {}, options);
        expect(!result.joint_defined, "blocked joint undefined");
    }

    // Exact over limit rejects.
    {
        std::vector<EquityCalcPlayerInput> players{
            player("a", "random"),
            player("b", "random"),
        };
        EquityCalcOptions options;
        options.method = EquityCalcMethod::Exact;
        options.max_exact_deals = 1000;
        bool threw = false;
        try
        {
            calculate_equity(players, {}, {}, options);
        }
        catch (const EquityCalcError& error)
        {
            threw = error.failure() == EquityCalcFailure::WorkLimit;
        }
        expect(threw, "exact work limit");
    }

    std::cout << "equity_calculator_tests passed=" << g_passed << " failed=" << g_failed << '\n';
    return g_failed == 0 ? 0 : 1;
}
