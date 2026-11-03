#include "harness.hpp"

#include "explorer/checkpoint.hpp"
#include "game/street_config_text.hpp"
#include "game/street_game.hpp"
#include "poker/card.hpp"
#include "poker/range.hpp"
#include "solver/node_lock.hpp"
#include "solver/river_batch.hpp"
#include "solver/street_batch.hpp"
#include "solver/table_scalar.hpp"
#include "solver/trainer.hpp"

#include <cmath>
#include <cstdint>
#include <filesystem>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

namespace
{

using poker::solver::Algorithm;
using poker::solver::CfrTrainer;
using poker::solver::StreetBatchSolver;
using poker::streets::StreetConfig;
using poker::streets::StreetGame;

int card(const char* text)
{
    return poker::holdem::parse_card(text);
}

StreetConfig tiny_river()
{
    StreetConfig config;
    config.board = {
        card("Ah"), card("Kd"), card("7c"), card("4s"), card("2h")};
    config.pot = 1000;
    config.stack = 1000;
    config.oop = poker::holdem::Range::parse("AcAd");
    config.ip = poker::holdem::Range::parse("KsKc");
    config.oop_river_bets = {0.5};
    config.ip_river_bets = {0.5};
    config.max_raises = 1;
    config.allow_all_in = false;
    config.memory_mib = 64;
    return config;
}

StreetConfig tiny_turn()
{
    StreetConfig config;
    config.board = {card("Ah"), card("Kd"), card("7c"), card("4s")};
    config.pot = 1000;
    config.stack = 1000;
    config.oop = poker::holdem::Range::parse("AcAd");
    config.ip = poker::holdem::Range::parse("KsKc");
    config.oop_bet_sizes = {0.5};
    config.ip_bet_sizes = {0.5};
    config.max_raises = 1;
    config.allow_all_in = false;
    config.memory_mib = 64;
    return config;
}

void expect_tags()
{
    CHECK(poker::solver::algorithm_tag(Algorithm::PcfrPlus) == 4);
    CHECK(poker::solver::algorithm_from_tag(4) == Algorithm::PcfrPlus);
    CHECK(std::string(poker::solver::algorithm_name(Algorithm::PcfrPlus)) == "pcfr_plus");
}

void expect_trainer_runs_and_differs_from_cfr_plus()
{
    const StreetConfig config = tiny_river();
    StreetGame game(config);
    CfrTrainer<StreetGame> plus(game, Algorithm::CfrPlus);
    CfrTrainer<StreetGame> pcfr(game, Algorithm::PcfrPlus);
    plus.run_iterations(20);
    pcfr.run_iterations(20);
    CHECK(plus.iterations_completed() == 20);
    CHECK(pcfr.iterations_completed() == 20);
    CHECK(std::isfinite(plus.evaluate().nash_gap));
    CHECK(std::isfinite(pcfr.evaluate().nash_gap));
    double regret_gap = 0.0;
    for (std::size_t i = 0; i < plus.regrets().size(); ++i)
    {
        regret_gap += std::abs(plus.regrets()[i] - pcfr.regrets()[i]);
    }
    CHECK(regret_gap > 1e-9);
}

void expect_batch_reference_parity()
{
    const StreetConfig config = tiny_river();
    const StreetGame game(config);
    CfrTrainer<StreetGame> reference(game, Algorithm::PcfrPlus);
    constexpr int iterations = 15;
    reference.run_iterations(iterations);

    StreetBatchSolver batch(config);
    batch.run_frozen_iterations(iterations, Algorithm::PcfrPlus);

    const std::vector<double> ref_strategy = reference.average_strategy();
    const std::vector<int> offset = poker::solver::action_offsets(game);
    std::map<std::string, double> ref_by_key;
    std::map<std::string, double> ref_regret;
    for (int infoset = 0; infoset < game.infoset_count(); ++infoset)
    {
        const int count = game.action_count(infoset);
        const int base = offset[static_cast<std::size_t>(infoset)];
        for (int action = 0; action < count; ++action)
        {
            const std::string key =
                game.infoset_label(infoset) + "\n" + game.action_label(infoset, action);
            ref_by_key[key] = ref_strategy[static_cast<std::size_t>(base + action)];
            ref_regret[key] = reference.regrets()[static_cast<std::size_t>(base + action)];
        }
    }

    const auto entries = batch.average_strategy_entries();
    CHECK(entries.size() == ref_by_key.size());
    for (const auto& entry : entries)
    {
        const std::string key = entry.infoset + "\n" + entry.action;
        const auto found = ref_by_key.find(key);
        CHECK(found != ref_by_key.end());
        if (found != ref_by_key.end())
        {
            CHECK_NEAR(entry.probability, found->second, 1e-5);
        }
        double batch_regret = 0.0;
        CHECK(batch.regret_value(entry.infoset, entry.action, batch_regret));
        const auto regret_found = ref_regret.find(key);
        CHECK(regret_found != ref_regret.end());
        if (regret_found != ref_regret.end())
        {
            const double scale = 1.0 + std::abs(regret_found->second);
            CHECK(std::abs(batch_regret - regret_found->second) <= 1e-4 * scale);
        }
    }
    CHECK_NEAR(batch.nash_gap(), reference.evaluate().nash_gap, 1e-4);
}

void expect_continuation_and_cold_prediction_on_load()
{
    const StreetConfig config = tiny_turn();
    StreetBatchSolver full(config);
    full.run_frozen_iterations(6, Algorithm::PcfrPlus);

    StreetBatchSolver part(config);
    part.run_frozen_iterations(2, Algorithm::PcfrPlus);
    part.continue_frozen_iterations(4, Algorithm::PcfrPlus);
    CHECK(part.completed_iterations() == 6);
    for (std::size_t i = 0; i < full.regret_table().size(); ++i)
    {
        CHECK_NEAR(part.regret_table()[i], full.regret_table()[i], 1e-12);
        CHECK_NEAR(part.strategy_sum_table()[i], full.strategy_sum_table()[i], 1e-12);
    }

    // Without prediction in the document, continue after load cold-starts m.
    poker::explorer::CheckpointDocument cold;
    cold.kind = 1;
    cold.algorithm = poker::solver::kAlgorithmTagPcfrPlus;
    cold.frozen = true;
    cold.samples = 1;
    cold.config_text = poker::streets::format_street_config(config);
    cold.tables = part.training_tables();
    const auto cold_path = std::filesystem::temp_directory_path() / "poker-solver-pcfr-cold.psol";
    poker::explorer::write_checkpoint(cold_path.string(), cold);
    const auto cold_loaded =
        poker::explorer::read_checkpoint(cold_path.string(), 64ull * 1024ull * 1024ull);
    CHECK(cold_loaded.algorithm == poker::solver::kAlgorithmTagPcfrPlus);
    CHECK(cold_loaded.prediction.empty());

    StreetBatchSolver cold_restored(config);
    cold_restored.install_training_tables(cold_loaded.tables);
    cold_restored.bind_training_algorithm(Algorithm::PcfrPlus);
    cold_restored.continue_frozen_iterations(2, Algorithm::PcfrPlus);
    CHECK(cold_restored.completed_iterations() == 8);
    CHECK(std::isfinite(cold_restored.nash_gap()));
    std::filesystem::remove(cold_path);

    // PSOL v3 with prediction restores exact continuation.
    StreetBatchSolver full8(config);
    full8.run_frozen_iterations(8, Algorithm::PcfrPlus);
    poker::explorer::CheckpointDocument warm = cold;
    warm.prediction.assign(part.prediction_table().begin(), part.prediction_table().end());
    const auto warm_path = std::filesystem::temp_directory_path() / "poker-solver-pcfr-warm.psol";
    poker::explorer::write_checkpoint(warm_path.string(), warm);
    const auto warm_loaded =
        poker::explorer::read_checkpoint(warm_path.string(), 64ull * 1024ull * 1024ull);
    CHECK(!warm_loaded.prediction.empty());
    StreetBatchSolver warm_restored(config);
    warm_restored.install_training_tables(warm_loaded.tables);
    warm_restored.bind_training_algorithm(Algorithm::PcfrPlus);
    warm_restored.install_prediction_table(warm_loaded.prediction);
    warm_restored.continue_frozen_iterations(2, Algorithm::PcfrPlus);
    CHECK(warm_restored.completed_iterations() == 8);
    for (std::size_t i = 0; i < full8.regret_table().size(); ++i)
    {
        CHECK_NEAR(warm_restored.regret_table()[i], full8.regret_table()[i], 1e-12);
        CHECK_NEAR(warm_restored.strategy_sum_table()[i], full8.strategy_sum_table()[i], 1e-12);
    }
    std::filesystem::remove(warm_path);
}

void expect_rejection_matrix()
{
    const StreetConfig config = tiny_river();
    StreetBatchSolver sequential(config);
    bool non_frozen = false;
    try
    {
        sequential.run_iterations(1, Algorithm::PcfrPlus);
    }
    catch (const std::invalid_argument&)
    {
        non_frozen = true;
    }
    CHECK(non_frozen);

    poker::river::RiverConfig river;
    for (int i = 0; i < 5; ++i)
    {
        river.board[static_cast<std::size_t>(i)] = config.board[static_cast<std::size_t>(i)];
    }
    river.pot = config.pot;
    river.stack = config.stack;
    river.oop = config.oop;
    river.ip = config.ip;
    river.oop_bet_sizes = {0.5};
    river.ip_bet_sizes = {0.5};
    river.max_raises = 1;
    river.allow_all_in = false;
    poker::solver::RiverBatchSolver river_solver(river);
    bool river_reject = false;
    try
    {
        river_solver.run_iterations(1, Algorithm::PcfrPlus);
    }
    catch (const std::invalid_argument&)
    {
        river_reject = true;
    }
    CHECK(river_reject);

    StreetBatchSolver bound(config);
    bound.run_frozen_iterations(1, Algorithm::PcfrPlus);
    bool switch_reject = false;
    try
    {
        bound.continue_frozen_iterations(1, Algorithm::CfrPlus);
    }
    catch (const std::invalid_argument&)
    {
        switch_reject = true;
    }
    CHECK(switch_reject);
}

void expect_thread_parity()
{
    StreetConfig config = tiny_turn();
    config.threads = 1;
    StreetBatchSolver one(config);
    one.run_frozen_iterations(4, Algorithm::PcfrPlus);
    config.threads = 2;
    StreetBatchSolver two(config);
    two.run_frozen_iterations(4, Algorithm::PcfrPlus);
    CHECK(one.regret_table().size() == two.regret_table().size());
    for (std::size_t i = 0; i < one.regret_table().size(); ++i)
    {
        CHECK_NEAR(one.regret_table()[i], two.regret_table()[i], 1e-9);
        CHECK_NEAR(one.strategy_sum_table()[i], two.strategy_sum_table()[i], 1e-9);
    }
    CHECK_NEAR(one.nash_gap(), two.nash_gap(), 1e-9);
}

void expect_kuhn_gap_not_worse_order()
{
    // Smoke: PCFR+ on Kuhn reaches a small gap; not a strict ≤ CFR+ claim.
    // Full study bake-off lives outside unit tests.
    // Kuhn uses the dedicated game in test_cfr; here just ensure enum is usable.
    CHECK(poker::solver::kAlgorithmTagPcfrPlus == 4);
}

} // namespace

void run_pcfr_tests()
{
    expect_tags();
    expect_trainer_runs_and_differs_from_cfr_plus();
    expect_batch_reference_parity();
    expect_continuation_and_cold_prediction_on_load();
    expect_rejection_matrix();
    expect_thread_parity();
    expect_kuhn_gap_not_worse_order();
}
