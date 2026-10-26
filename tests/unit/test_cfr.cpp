#include "game/kuhn.hpp"
#include "harness.hpp"
#include "solver/best_response.hpp"
#include "solver/cfr.hpp"
#include "solver/regret_matching.hpp"

#include <cmath>
#include <vector>

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

    // 200k iterations: measured Nash gap is below 1e-3. 50k is not.
    poker::solver::KuhnCfrTrainer trainer_a;
    trainer_a.solve(200000);
    const auto strategy_a = trainer_a.average_strategy();
    const auto stats_a = poker::solver::evaluate_average_strategy(strategy_a);

    CHECK_NEAR(stats_a.p1_expected_utility, poker::kuhn::kEquilibriumP1Value, 1e-3);
    CHECK(stats_a.nash_gap < 1e-3);
    CHECK(stats_a.nash_gap >= -1e-12);

    poker::solver::KuhnCfrTrainer trainer_b;
    trainer_b.solve(200000);
    const auto strategy_b = trainer_b.average_strategy();
    CHECK_NEAR(poker::solver::expected_p1_utility(strategy_a),
               poker::solver::expected_p1_utility(strategy_b),
               1e-12);
    for (std::size_t i = 0; i < strategy_a.size(); ++i)
    {
        CHECK_NEAR(strategy_a[i], strategy_b[i], 1e-12);
    }

    auto freq = [&](int infoset, int local_action)
    {
        return strategy_a[infoset * poker::kuhn::kActionsPerInfoset + local_action];
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

    poker::solver::KuhnCfrTrainer short_run;
    short_run.solve(200);
    const auto early = poker::solver::evaluate_average_strategy(short_run.average_strategy());
    CHECK(stats_a.nash_gap < early.nash_gap);
}
