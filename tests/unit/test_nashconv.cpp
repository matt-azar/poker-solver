#include "harness.hpp"

#include "game/street_game.hpp"
#include "solver/street_batch.hpp"
#include "solver/trainer.hpp"

#include <cmath>

using poker::holdem::Range;
using poker::solver::Algorithm;
using poker::solver::CfrTrainer;
using poker::solver::EvaluationResult;
using poker::solver::IncentiveKind;
using poker::solver::IncentiveRule;
using poker::solver::RakeConfig;
using poker::solver::SolveConfig;
using poker::solver::StreetBatchSolver;
using poker::streets::StreetConfig;
using poker::streets::StreetGame;

namespace
{

int card(const char* text)
{
    return poker::holdem::parse_card(text);
}

StreetConfig check_only_river(const char* oop, const char* ip)
{
    StreetConfig cfg;
    cfg.board = {
        card("Ah"), card("Kd"), card("7c"), card("4s"), card("2h")};
    cfg.pot = 1000;
    cfg.stack = 1000;
    cfg.oop = Range::parse(oop);
    cfg.ip = Range::parse(ip);
    cfg.allow_all_in = false;
    cfg.max_raises = 0;
    cfg.memory_mib = 64;
    return cfg;
}

SolveConfig short_cfr_plus()
{
    SolveConfig solve;
    solve.max_iterations = 20;
    solve.accuracy_threshold = 0.1; // Pio Accuracy chips; pot is 100
    solve.eval_every = 1;
    return solve;
}

void check_zero_gap(const EvaluationResult& evaluation, double tol = 1e-9)
{
    CHECK_NEAR(evaluation.gain0, 0.0, tol);
    CHECK_NEAR(evaluation.gain1, 0.0, tol);
    CHECK_NEAR(evaluation.nash_gap, 0.0, tol);
    CHECK_NEAR(evaluation.accuracy, 0.0, tol);
    CHECK_NEAR(evaluation.nash_gap, evaluation.gain0 + evaluation.gain1, tol);
    CHECK_NEAR(evaluation.accuracy, 0.5 * evaluation.nash_gap, tol);
}

void check_batch_matches_reference(StreetConfig cfg, double tol = 1e-6)
{
    StreetBatchSolver batch(cfg);
    const SolveConfig solve = short_cfr_plus();
    const auto batch_stats = batch.solve_frozen(solve, Algorithm::CfrPlus);
    const EvaluationResult batch_eval = batch.evaluate();
    CHECK_NEAR(batch_stats.nash_gap, batch_eval.nash_gap, 1e-12);
    CHECK_NEAR(batch_stats.p1_expected_utility, batch_eval.u0, 1e-12);
    CHECK_NEAR(batch_stats.p1_best_response_utility, batch_eval.br0, 1e-12);
    CHECK_NEAR(batch_stats.p2_best_response_utility, batch_eval.br1, 1e-12);

    StreetGame game(cfg);
    CfrTrainer<StreetGame> trainer(game, Algorithm::CfrPlus);
    const auto ref_stats = trainer.solve(solve);
    CHECK_NEAR(batch_eval.nash_gap, ref_stats.nash_gap, tol);
    CHECK_NEAR(batch_eval.u0, ref_stats.p1_expected_utility, tol);
    CHECK_NEAR(batch_eval.br0, ref_stats.p1_best_response_utility, tol);
    CHECK_NEAR(batch_eval.br1, ref_stats.p2_best_response_utility, tol);
}

} // namespace

void run_nashconv_tests()
{
    // Forced check-only river: neither seat has a profitable deviation.
    // Plain chips, 5% rake, and an IP check incentive must all report zero gap.
    // Absolute BR0+BR1 wrongly reports -5 under rake and +7 under the incentive.
    {
        StreetConfig plain = check_only_river("AcAd", "KsKc");
        StreetBatchSolver batch(plain);
        SolveConfig solve = short_cfr_plus();
        const auto stats = batch.solve_frozen(solve, Algorithm::CfrPlus);
        CHECK(stats.iterations == 1);
        const EvaluationResult evaluation = batch.evaluate();
        check_zero_gap(evaluation);
        CHECK_NEAR(evaluation.u0, 50.0, 1e-9);
        CHECK_NEAR(evaluation.u1, -50.0, 1e-9);
        // Zero-sum chip identity still holds.
        CHECK_NEAR(evaluation.br0 + evaluation.br1, evaluation.nash_gap, 1e-9);
        check_batch_matches_reference(plain);
    }

    {
        StreetConfig raked = check_only_river("AcAd", "KsKc");
        raked.rake = RakeConfig{0.05, 0.0};
        StreetBatchSolver batch(raked);
        SolveConfig solve = short_cfr_plus();
        const auto stats = batch.solve_frozen(solve, Algorithm::CfrPlus);
        CHECK(stats.iterations == 1);
        const EvaluationResult evaluation = batch.evaluate();
        check_zero_gap(evaluation);
        CHECK_NEAR(evaluation.u0, 45.0, 1e-9);
        CHECK_NEAR(evaluation.u1, -50.0, 1e-9);
        // Old absolute-sum formula would equal u0+u1 = -5 here.
        CHECK(std::abs((evaluation.br0 + evaluation.br1) - evaluation.nash_gap) > 1.0);
        check_batch_matches_reference(raked);
    }

    {
        StreetConfig incentivized = check_only_river("AcAd", "KsKc");
        incentivized.incentives.add(IncentiveRule{
            IncentiveKind::ActionLabelMatch, "c", 1, 7.0});
        StreetBatchSolver batch(incentivized);
        SolveConfig solve = short_cfr_plus();
        const auto stats = batch.solve_frozen(solve, Algorithm::CfrPlus);
        CHECK(stats.iterations == 1);
        const EvaluationResult evaluation = batch.evaluate();
        check_zero_gap(evaluation);
        CHECK_NEAR(evaluation.u0, 50.0, 1e-9);
        CHECK_NEAR(evaluation.u1, -50.0 + 7.0, 1e-9);
        // Old absolute-sum formula would equal +7 here and miss the accuracy stop.
        CHECK(std::abs((evaluation.br0 + evaluation.br1) - evaluation.nash_gap) > 1.0);
        check_batch_matches_reference(incentivized);
    }

    // Zero-rake chip path: corrected gap stays within existing batch↔reference
    // tolerance on a tiny strategic river (not check-only).
    {
        StreetConfig cfg;
        cfg.board = {
            card("Ah"), card("Kd"), card("7c"), card("4s"), card("2h")};
        cfg.pot = 1000;
        cfg.stack = 1000;
        cfg.oop = Range::parse("AcAd,5c5d");
        cfg.ip = Range::parse("KsKc");
        cfg.allow_all_in = true;
        cfg.max_raises = 0;
        cfg.oop_bet_sizes = {1.0};
        cfg.memory_mib = 64;
        StreetBatchSolver batch(cfg);
        SolveConfig solve;
        solve.max_iterations = 40;
        const auto batch_stats = batch.solve_frozen(solve, Algorithm::CfrPlus);
        StreetGame game(cfg);
        CfrTrainer<StreetGame> trainer(game, Algorithm::CfrPlus);
        const auto ref_stats = trainer.solve(solve);
        CHECK_NEAR(batch_stats.nash_gap, ref_stats.nash_gap, 1e-4);
        CHECK_NEAR(batch.evaluate().nash_gap, batch_stats.nash_gap, 1e-12);
        CHECK(batch_stats.nash_gap >= -1e-9);
    }
}
