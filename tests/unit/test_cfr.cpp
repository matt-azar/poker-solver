#include "game/kuhn.hpp"
#include "game/kuhn_game.hpp"
#include "harness.hpp"
#include "solver/best_response.hpp"
#include "solver/cfr.hpp"
#include "solver/regret_matching.hpp"
#include "solver/trainer.hpp"

#include <cmath>
#include <iomanip>
#include <iostream>
#include <limits>
#include <vector>

namespace
{

void report_solve(const char* name,
                  const poker::solver::SolveStats& stats,
                  const std::vector<double>& strategy)
{
    using namespace poker::kuhn;
    std::cout << std::setprecision(12);
    std::cout << "REPORT " << name << "\n";
    std::cout << "  iterations " << stats.iterations << "\n";
    std::cout << "  runtime_seconds " << stats.runtime_seconds << "\n";
    std::cout << "  memory_bytes_estimate " << stats.memory_bytes_estimate << "\n";
    std::cout << "  player1_expected_utility " << stats.p1_expected_utility << "\n";
    std::cout << "  nash_gap " << stats.nash_gap << "\n";
    std::cout << "  average_strategy\n";
    for (int infoset = 0; infoset < kNumInfosets; ++infoset)
    {
        const double p0 = strategy[static_cast<std::size_t>(infoset * kActionsPerInfoset)];
        const double p1 = strategy[static_cast<std::size_t>(infoset * kActionsPerInfoset + 1)];
        std::cout << "    " << infoset_label(infoset) << " "
                  << action_name(local_action_to_action(infoset, 0)) << "=" << p0 << " "
                  << action_name(local_action_to_action(infoset, 1)) << "=" << p1 << "\n";
    }
}

double enumerated_p1_best_response(const std::vector<double>& mixed)
{
    double best = -std::numeric_limits<double>::infinity();
    for (int mask = 0; mask < 64; ++mask)
    {
        std::vector<double> profile = mixed;
        for (int local = 0; local < 6; ++local)
        {
            const int bit = (mask >> local) & 1;
            profile[static_cast<std::size_t>(local * 2)] = bit == 0 ? 1.0 : 0.0;
            profile[static_cast<std::size_t>(local * 2 + 1)] = bit == 1 ? 1.0 : 0.0;
        }
        best = std::max(best, poker::solver::expected_p1_utility(profile));
    }
    return best;
}

void check_equilibrium_family(const std::vector<double>& strategy)
{
    auto freq = [&](int infoset, int local_action)
    {
        return strategy[static_cast<std::size_t>(
            infoset * poker::kuhn::kActionsPerInfoset + local_action)];
    };

    // Equilibrium family for alpha in [0, 1/3], not one hardcoded profile.
    // P1 bets Jack with alpha and King with 3*alpha (King is not always a bet).
    // P1 calls a Queen with alpha + 1/3. See docs/MATHEMATICS.md.
    const double p1_jack_bet = freq(0, 1);
    const double p1_queen_bet = freq(1, 1);
    const double p1_king_bet = freq(2, 1);
    const double p1_jack_call = freq(3, 1);
    const double p1_queen_call = freq(4, 1);
    const double p1_king_call = freq(5, 1);
    const double p2_jack_bet = freq(6, 1);
    const double p2_queen_bet = freq(7, 1);
    const double p2_king_bet = freq(8, 1);
    const double p2_jack_call = freq(9, 1);
    const double p2_queen_call = freq(10, 1);
    const double p2_king_call = freq(11, 1);

    CHECK(p1_jack_bet <= (1.0 / 3.0) + 0.02);
    CHECK(p1_queen_bet <= 0.02);
    CHECK_NEAR(p1_king_bet, 3.0 * p1_jack_bet, 0.02);
    CHECK(p1_jack_call <= 0.02);
    CHECK_NEAR(p1_queen_call, p1_jack_bet + (1.0 / 3.0), 0.02);
    CHECK(p1_king_call >= 0.98);
    CHECK_NEAR(p2_jack_bet, 1.0 / 3.0, 0.02);
    CHECK(p2_queen_bet <= 0.02);
    CHECK(p2_king_bet >= 0.98);
    CHECK(p2_jack_call <= 0.02);
    CHECK_NEAR(p2_queen_call, 1.0 / 3.0, 0.02);
    CHECK(p2_king_call >= 0.98);
}

double enumerated_p2_best_response(const std::vector<double>& mixed)
{
    double best = -std::numeric_limits<double>::infinity();
    for (int mask = 0; mask < 64; ++mask)
    {
        std::vector<double> profile = mixed;
        for (int local = 0; local < 6; ++local)
        {
            const int infoset = 6 + local;
            const int bit = (mask >> local) & 1;
            profile[static_cast<std::size_t>(infoset * 2)] = bit == 0 ? 1.0 : 0.0;
            profile[static_cast<std::size_t>(infoset * 2 + 1)] = bit == 1 ? 1.0 : 0.0;
        }
        best = std::max(best, -poker::solver::expected_p1_utility(profile));
    }
    return best;
}

} // namespace

void run_cfr_tests()
{
    {
        double regrets[2] = {-1.0, -4.0};
        double current[2] = {0.0, 0.0};
        poker::solver::regret_matching(regrets, current, 2);
        CHECK_NEAR(current[0], 0.5, 1e-12);
        CHECK_NEAR(current[1], 0.5, 1e-12);
    }
    {
        double regrets[2] = {3.0, 1.0};
        double current[2] = {0.0, 0.0};
        poker::solver::regret_matching(regrets, current, 2);
        CHECK_NEAR(current[0], 0.75, 1e-12);
        CHECK_NEAR(current[1], 0.25, 1e-12);
    }
    {
        double regrets[2] = {-2.0, 5.0};
        double current[2] = {0.0, 0.0};
        poker::solver::regret_matching(regrets, current, 2);
        CHECK_NEAR(current[0], 0.0, 1e-12);
        CHECK_NEAR(current[1], 1.0, 1e-12);
    }

    {
        double strategy_sum[2] = {0.0, 0.0};
        double current[2] = {0.5, 0.5};
        poker::solver::accumulate_average(strategy_sum, current, 2, 1.0);
        CHECK_NEAR(strategy_sum[0], 0.5, 1e-12);
        CHECK_NEAR(strategy_sum[1], 0.5, 1e-12);

        current[0] = 1.0;
        current[1] = 0.0;
        poker::solver::accumulate_average(strategy_sum, current, 2, 0.5);
        CHECK_NEAR(strategy_sum[0], 1.0, 1e-12);
        CHECK_NEAR(strategy_sum[1], 0.5, 1e-12);

        double avg[2] = {0.0, 0.0};
        poker::solver::normalize_average(strategy_sum, avg, 2);
        CHECK_NEAR(avg[0], 2.0 / 3.0, 1e-12);
        CHECK_NEAR(avg[1], 1.0 / 3.0, 1e-12);
    }

    {
        double zeros[2] = {0.0, 0.0};
        double avg[2] = {0.0, 0.0};
        poker::solver::normalize_average(zeros, avg, 2);
        CHECK_NEAR(avg[0], 0.5, 1e-12);
        CHECK_NEAR(avg[1], 0.5, 1e-12);
    }

    {
        std::vector<double> uniform(static_cast<std::size_t>(poker::kuhn::kStrategyEntries), 0.5);
        CHECK_NEAR(poker::solver::best_response_p1_utility(uniform),
                   enumerated_p1_best_response(uniform),
                   1e-9);
        CHECK_NEAR(poker::solver::best_response_p2_utility(uniform),
                   enumerated_p2_best_response(uniform),
                   1e-9);
    }

    // 200k iterations: measured Nash gap is below 1e-3. 50k is not.
    poker::solver::CfrTrainer<poker::kuhn::KuhnGame> trainer_a(
        poker::kuhn::KuhnGame{}, poker::solver::Algorithm::VanillaCfr);
    poker::solver::SolveConfig vanilla_config;
    vanilla_config.max_iterations = 200000;
    const auto stats_a = trainer_a.solve(vanilla_config);
    const auto strategy_a = trainer_a.average_strategy();
    report_solve("vanilla_cfr", stats_a, strategy_a);

    CHECK(stats_a.iterations == 200000);
    CHECK(stats_a.runtime_seconds > 0.0);
    CHECK(stats_a.memory_bytes_estimate > 0);
    CHECK_NEAR(stats_a.p1_expected_utility, poker::kuhn::kEquilibriumP1Value, 1e-3);
    CHECK_NEAR(stats_a.p1_expected_utility,
               poker::solver::expected_p1_utility(strategy_a),
               1e-12);
    CHECK(stats_a.nash_gap < 1e-3);
    CHECK(stats_a.nash_gap >= -1e-12);
    CHECK_NEAR(stats_a.p1_best_response_utility, enumerated_p1_best_response(strategy_a), 1e-8);
    CHECK_NEAR(stats_a.p2_best_response_utility, enumerated_p2_best_response(strategy_a), 1e-8);

    bool vanilla_has_negative_regret = false;
    for (double regret : trainer_a.regrets())
    {
        if (regret < 0.0)
        {
            vanilla_has_negative_regret = true;
        }
    }
    CHECK(vanilla_has_negative_regret);

    poker::solver::CfrTrainer<poker::kuhn::KuhnGame> trainer_b(
        poker::kuhn::KuhnGame{}, poker::solver::Algorithm::VanillaCfr);
    trainer_b.solve(vanilla_config);
    const auto strategy_b = trainer_b.average_strategy();
    CHECK_NEAR(poker::solver::expected_p1_utility(strategy_a),
               poker::solver::expected_p1_utility(strategy_b),
               1e-12);
    for (std::size_t i = 0; i < strategy_a.size(); ++i)
    {
        CHECK_NEAR(strategy_a[i], strategy_b[i], 1e-12);
    }

    check_equilibrium_family(strategy_a);

    poker::solver::CfrTrainer<poker::kuhn::KuhnGame> short_run(
        poker::kuhn::KuhnGame{}, poker::solver::Algorithm::VanillaCfr);
    poker::solver::SolveConfig short_config;
    short_config.max_iterations = 200;
    const auto early = short_run.solve(short_config);
    CHECK(stats_a.nash_gap < early.nash_gap);

    poker::solver::CfrTrainer<poker::kuhn::KuhnGame> plus(
        poker::kuhn::KuhnGame{}, poker::solver::Algorithm::CfrPlus);
    poker::solver::SolveConfig plus_config;
    plus_config.max_iterations = 200000;
    const auto plus_stats = plus.solve(plus_config);
    const auto plus_strategy = plus.average_strategy();
    report_solve("cfr_plus", plus_stats, plus_strategy);

    CHECK(plus_stats.iterations == 200000);
    CHECK(plus_stats.runtime_seconds > 0.0);
    CHECK(plus_stats.memory_bytes_estimate == stats_a.memory_bytes_estimate);
    CHECK_NEAR(plus_stats.p1_expected_utility, poker::kuhn::kEquilibriumP1Value, 1e-3);
    CHECK(plus_stats.nash_gap < 1e-3);
    CHECK(plus_stats.nash_gap >= -1e-12);
    CHECK(plus_stats.nash_gap < stats_a.nash_gap);
    check_equilibrium_family(plus_strategy);
    for (double regret : plus.regrets())
    {
        CHECK(regret >= 0.0);
    }
    CHECK_NEAR(plus_stats.p1_best_response_utility,
               enumerated_p1_best_response(plus_strategy),
               1e-8);
    CHECK_NEAR(plus_stats.p2_best_response_utility,
               enumerated_p2_best_response(plus_strategy),
               1e-8);

    poker::solver::SolveConfig plus_repro_config;
    plus_repro_config.max_iterations = 2000;
    poker::solver::CfrTrainer<poker::kuhn::KuhnGame> plus_again(
        poker::kuhn::KuhnGame{}, poker::solver::Algorithm::CfrPlus);
    plus_again.solve(plus_repro_config);
    poker::solver::CfrTrainer<poker::kuhn::KuhnGame> plus_third(
        poker::kuhn::KuhnGame{}, poker::solver::Algorithm::CfrPlus);
    plus_third.solve(plus_repro_config);
    const auto plus_strategy_again = plus_again.average_strategy();
    const auto plus_strategy_third = plus_third.average_strategy();
    for (std::size_t i = 0; i < plus_strategy_again.size(); ++i)
    {
        CHECK_NEAR(plus_strategy_again[i], plus_strategy_third[i], 1e-12);
    }

    poker::solver::CfrTrainer<poker::kuhn::KuhnGame> plus_short(
        poker::kuhn::KuhnGame{}, poker::solver::Algorithm::CfrPlus);
    poker::solver::SolveConfig plus_short_config;
    plus_short_config.max_iterations = 200;
    const auto plus_early = plus_short.solve(plus_short_config);
    CHECK(plus_stats.nash_gap < plus_early.nash_gap);

    poker::solver::CfrTrainer<poker::kuhn::KuhnGame> stopping(
        poker::kuhn::KuhnGame{}, poker::solver::Algorithm::CfrPlus);
    poker::solver::SolveConfig stop_config;
    stop_config.max_iterations = 100000;
    stop_config.nash_gap_threshold = 1e-2;
    stop_config.eval_interval = 200;
    const auto stopped = stopping.solve(stop_config);
    const auto stopped_strategy = stopping.average_strategy();
    report_solve("cfr_plus_early_stop", stopped, stopped_strategy);
    CHECK(stopped.iterations > 0);
    CHECK(stopped.iterations < stop_config.max_iterations);
    CHECK(stopped.iterations % stop_config.eval_interval == 0);
    CHECK(stopped.nash_gap <= stop_config.nash_gap_threshold);
    CHECK(stopped.runtime_seconds > 0.0);
    CHECK(stopped.memory_bytes_estimate > 0);

    poker::solver::SolveConfig linear_config;
    linear_config.max_iterations = 2000;
    poker::solver::CfrTrainer<poker::kuhn::KuhnGame> linear(
        poker::kuhn::KuhnGame{}, poker::solver::Algorithm::LinearCfr);
    const auto linear_stats = linear.solve(linear_config);
    const auto linear_strategy = linear.average_strategy();
    report_solve("linear_cfr", linear_stats, linear_strategy);
    poker::solver::CfrTrainer<poker::kuhn::KuhnGame> linear_again(
        poker::kuhn::KuhnGame{}, poker::solver::Algorithm::LinearCfr);
    linear_again.solve(linear_config);
    const auto linear_again_strategy = linear_again.average_strategy();
    for (std::size_t i = 0; i < linear_strategy.size(); ++i)
    {
        CHECK_NEAR(linear_strategy[i], linear_again_strategy[i], 1e-12);
    }
    poker::solver::CfrTrainer<poker::kuhn::KuhnGame> vanilla_same(
        poker::kuhn::KuhnGame{}, poker::solver::Algorithm::VanillaCfr);
    vanilla_same.solve(linear_config);
    const auto vanilla_same_strategy = vanilla_same.average_strategy();
    double strategy_gap = 0.0;
    for (std::size_t i = 0; i < linear_strategy.size(); ++i)
    {
        strategy_gap += std::abs(linear_strategy[i] - vanilla_same_strategy[i]);
    }
    CHECK(strategy_gap > 1e-3);
    bool negative_regret = false;
    for (double regret : linear.regrets())
    {
        if (regret < -1e-8)
        {
            negative_regret = true;
        }
    }
    CHECK(negative_regret);
    CHECK_NEAR(linear_stats.p1_expected_utility, -1.0 / 18.0, 0.01);
    CHECK(linear_stats.nash_gap < 0.05);
}
