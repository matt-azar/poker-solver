#include "harness.hpp"

#include "game/street_config_text.hpp"
#include "game/street_game.hpp"
#include "poker/card.hpp"
#include "poker/range.hpp"
#include "solver/compressed_tables.hpp"
#include "solver/street_batch.hpp"
#include "solver/trainer.hpp"

#include <cmath>
#include <cstdint>
#include <iostream>
#include <span>
#include <string>
#include <vector>

using poker::holdem::Range;
using poker::streets::StreetConfig;

namespace
{

// Declared tolerance for compressed vs float on the tiny fixture below.
// Not bit-identical; quantization noise is expected.
constexpr double kNashConvPerPotTol = 1e-3;
constexpr double kEvChipsTol = 0.02;

int card(const char* text)
{
    return poker::holdem::parse_card(text);
}

// Tiny turn tree with Check/Bet (enough entries for block-scale int16 to beat float).
StreetConfig tiny_bet_tree()
{
    StreetConfig config;
    config.board = {card("Ah"), card("Kd"), card("7c"), card("2s")};
    config.pot = 1000;
    config.stack = 2000;
    config.oop = Range::parse("QcQd");
    config.ip = Range::parse("JcJd");
    config.oop_bet_sizes = {1.0};
    config.ip_bet_sizes = {1.0};
    config.max_raises = 0;
    config.allow_all_in = false;
    config.memory_mib = 64;
    config.threads = 1;
    return config;
}

void expect_codec_roundtrip()
{
    float values[4] = {0.0f, -12.5f, 3.25f, 100.0f};
    std::int16_t stored[4] = {};
    const float scale = poker::solver::compress_i16_row(
        std::span<const float>(values, 4),
        std::span<std::int16_t>(stored, 4));
    CHECK(scale > 0.0f);
    float back[4] = {};
    poker::solver::expand_i16_row(
        std::span<const std::int16_t>(stored, 4),
        scale,
        std::span<float>(back, 4));
    for (int index = 0; index < 4; ++index)
    {
        CHECK_NEAR(back[index], values[index], 0.01);
    }

    float zeros[2] = {0.0f, 0.0f};
    std::int16_t zero_store[2] = {1, 1};
    const float zero_scale = poker::solver::compress_i16_row(
        std::span<const float>(zeros, 2),
        std::span<std::int16_t>(zero_store, 2));
    CHECK(zero_scale == 0.0f);
    CHECK(zero_store[0] == 0);
    CHECK(zero_store[1] == 0);
}

void expect_config_roundtrip()
{
    StreetConfig config = tiny_bet_tree();
    config.table_i16 = true;
    const std::string text = poker::streets::format_street_config(config);
    CHECK(text.find("table-i16 1\n") != std::string::npos);
    const StreetConfig parsed = poker::streets::parse_street_config(text);
    CHECK(parsed.table_i16);
    CHECK(poker::streets::format_street_config(parsed) == text);
}

void expect_memory_reports_compressed()
{
    StreetConfig plain = tiny_bet_tree();
    plain.table_i16 = false;
    StreetConfig compressed = tiny_bet_tree();
    compressed.table_i16 = true;

    poker::solver::StreetBatchSolver float_solver(plain);
    poker::solver::StreetBatchSolver i16_solver(compressed);

    const auto float_report = float_solver.memory_report();
    const auto i16_report = i16_solver.memory_report();

    CHECK(!float_report.table_i16);
    CHECK(i16_report.table_i16);
    CHECK(float_report.table_i16_workspace_bytes == 0);
    CHECK(i16_report.table_i16_workspace_bytes > 0);
    CHECK(i16_report.regret_strategy_sum_bytes < float_report.regret_strategy_sum_bytes);
    CHECK(i16_solver.regret_entries() == float_solver.regret_entries());
    CHECK(i16_solver.memory_bytes_estimate() < float_solver.memory_bytes_estimate());
    CHECK(i16_report.estimated_peak_bytes > i16_report.regret_strategy_sum_bytes);
    CHECK(i16_report.estimated_peak_bytes > 0);

    std::cout << "REPORT table_i16_bytes\n"
              << "  entries " << float_solver.regret_entries() << "\n"
              << "  float_regret_strategy_sum_bytes "
              << float_report.regret_strategy_sum_bytes << "\n"
              << "  i16_regret_strategy_sum_bytes "
              << i16_report.regret_strategy_sum_bytes << "\n"
              << "  i16_workspace_bytes "
              << i16_report.table_i16_workspace_bytes << "\n";
}

void expect_exploitability_within_tolerance()
{
    constexpr int kIters = 40;

    StreetConfig plain = tiny_bet_tree();
    StreetConfig compressed = tiny_bet_tree();
    compressed.table_i16 = true;

    poker::solver::StreetBatchSolver float_solver(plain);
    poker::solver::StreetBatchSolver i16_solver(compressed);

    poker::solver::SolveConfig solve;
    solve.max_iterations = kIters;
    float_solver.solve_frozen(solve, poker::solver::Algorithm::CfrPlus);
    i16_solver.solve_frozen(solve, poker::solver::Algorithm::CfrPlus);

    const double pot_chips = plain.pot / 10.0;
    const double float_gap = float_solver.nash_gap();
    const double i16_gap = i16_solver.nash_gap();
    const double float_ev = float_solver.expected_utility();
    const double i16_ev = i16_solver.expected_utility();

    CHECK(std::fabs(i16_gap - float_gap) / pot_chips <= kNashConvPerPotTol);
    CHECK(std::fabs(i16_ev - float_ev) <= kEvChipsTol);

    const auto float_sum = float_solver.strategy_sum_table();
    const auto i16_sum = i16_solver.strategy_sum_table();
    CHECK(float_sum.size() == i16_sum.size());
    CHECK(float_sum.size() > 0);
    double abs_err = 0.0;
    double abs_mass = 0.0;
    for (std::size_t index = 0; index < float_sum.size(); ++index)
    {
        abs_err += std::fabs(static_cast<double>(float_sum[index] - i16_sum[index]));
        abs_mass += std::fabs(static_cast<double>(float_sum[index]));
    }
    CHECK(abs_mass > 0.0);
    CHECK(abs_err / abs_mass <= 0.05);
}

void expect_psol_tables_stay_double()
{
    StreetConfig compressed = tiny_bet_tree();
    compressed.table_i16 = true;
    poker::solver::StreetBatchSolver solver(compressed);
    poker::solver::SolveConfig solve;
    solve.max_iterations = 8;
    solver.solve_frozen(solve, poker::solver::Algorithm::CfrPlus);

    const poker::solver::TrainingTables tables = solver.training_tables();
    CHECK(tables.regret.size() == static_cast<std::size_t>(solver.regret_entries()));
    CHECK(tables.strategy_sum.size() == tables.regret.size());

    StreetConfig reload_cfg = compressed;
    poker::solver::StreetBatchSolver reloaded(reload_cfg);
    reloaded.install_training_tables(tables);
    reloaded.bind_training_algorithm(poker::solver::Algorithm::CfrPlus);
    CHECK_NEAR(reloaded.expected_utility(), solver.expected_utility(), kEvChipsTol);
}

} // namespace

void run_table_i16_tests()
{
    expect_codec_roundtrip();
    expect_config_roundtrip();
    expect_memory_reports_compressed();
    expect_exploitability_within_tolerance();
    expect_psol_tables_stay_double();
}
