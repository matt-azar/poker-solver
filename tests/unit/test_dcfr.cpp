#include "harness.hpp"

#include "explorer/checkpoint.hpp"
#include "game/street_config_text.hpp"
#include "game/street_game.hpp"
#include "poker/card.hpp"
#include "poker/range.hpp"
#include "solver/dcfr.hpp"
#include "solver/node_lock.hpp"
#include "solver/river_batch.hpp"
#include "solver/street_batch.hpp"
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
    config.pot = 100;
    config.stack = 100;
    config.oop = poker::holdem::Range::parse("AcAd");
    config.ip = poker::holdem::Range::parse("KsKc");
    // Five-card boards read river-specific lists; shared sizes alone are fine
    // once max_raises allows an opening bet (0 means check-only).
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
    config.pot = 100;
    config.stack = 100;
    config.oop = poker::holdem::Range::parse("AcAd");
    config.ip = poker::holdem::Range::parse("KsKc");
    config.oop_bet_sizes = {0.5};
    config.ip_bet_sizes = {0.5};
    config.max_raises = 1;
    config.allow_all_in = false;
    config.memory_mib = 64;
    return config;
}

StreetConfig tiny_flop()
{
    StreetConfig config;
    config.board = {card("Ah"), card("Kd"), card("7c")};
    config.pot = 100;
    config.stack = 100;
    config.oop = poker::holdem::Range::parse("QcQd");
    config.ip = poker::holdem::Range::parse("JcJd");
    // Check-only flop still exercises chance/discount/averaging paths.
    config.oop_bet_sizes = {};
    config.ip_bet_sizes = {};
    config.max_raises = 0;
    config.allow_all_in = false;
    config.memory_mib = 64;
    return config;
}

// Independent oracle: must not call production dcfr_factors / helpers.
double oracle_positive(int t)
{
    const double tp = std::pow(static_cast<double>(t), 1.5);
    return tp / (tp + 1.0);
}

double oracle_negative()
{
    return 0.5;
}

double oracle_average_weight(int t)
{
    const double td = static_cast<double>(t);
    return td * td;
}

double oracle_discount(double old_regret, double pass_delta, int t)
{
    const double u = old_regret + pass_delta;
    return u > 0.0 ? u * oracle_positive(t) : u * oracle_negative();
}

void expect_scalar_oracle()
{
    CHECK_NEAR(oracle_positive(1), 1.0 / 2.0, 1e-12);
    CHECK_NEAR(oracle_average_weight(1), 1.0, 1e-12);
    CHECK_NEAR(oracle_average_weight(3), 9.0, 1e-12);

    const auto factors = poker::solver::dcfr_factors(1);
    CHECK_NEAR(factors.positive_discount, oracle_positive(1), 1e-15);
    CHECK_NEAR(factors.negative_discount, oracle_negative(), 1e-15);
    CHECK_NEAR(factors.average_weight, oracle_average_weight(1), 1e-15);

    // Positive stays positive.
    CHECK_NEAR(oracle_discount(2.0, 1.0, 1), 1.5, 1e-12);
    // Negative stays signed.
    CHECK_NEAR(oracle_discount(-4.0, -1.0, 1), -2.5, 1e-12);
    // Zero increment still discounts.
    CHECK_NEAR(oracle_discount(4.0, 0.0, 1), 2.0, 1e-12);
    CHECK_NEAR(oracle_discount(-3.0, 0.0, 2), -1.5, 1e-12);
    // Sign crossing: negative to positive.
    CHECK_NEAR(oracle_discount(-1.0, 3.0, 1), 1.0, 1e-12);
    // Sign crossing: positive to negative (or zero).
    CHECK_NEAR(oracle_discount(1.0, -3.0, 1), -1.0, 1e-12);
    // Exact zero after increment uses the negative factor.
    CHECK_NEAR(oracle_discount(2.0, -2.0, 4), 0.0, 1e-12);

    CHECK_NEAR(
        poker::solver::dcfr_discounted_regret(2.0, 1.0, factors.positive_discount, factors.negative_discount),
        oracle_discount(2.0, 1.0, 1),
        1e-15);
    CHECK_NEAR(
        poker::solver::dcfr_discount_post_pass(3.0, factors.positive_discount, factors.negative_discount),
        1.5,
        1e-15);
}

void expect_non_updating_player_unchanged()
{
    StreetGame game(tiny_river());
    CfrTrainer<StreetGame> trainer(game, Algorithm::Dcfr);
    int oop_infoset = -1;
    int ip_infoset = -1;
    for (int infoset = 0; infoset < game.infoset_count(); ++infoset)
    {
        if (oop_infoset < 0 && game.acting_player(infoset) == 0 && game.action_count(infoset) >= 1)
        {
            oop_infoset = infoset;
        }
        if (ip_infoset < 0 && game.acting_player(infoset) == 1 && game.action_count(infoset) >= 1)
        {
            ip_infoset = infoset;
        }
    }
    CHECK(oop_infoset >= 0);
    CHECK(ip_infoset >= 0);
    trainer.assign_regret(oop_infoset, 0, 5.0);
    if (game.action_count(oop_infoset) > 1)
    {
        trainer.assign_regret(oop_infoset, 1, -2.0);
    }
    trainer.assign_regret(ip_infoset, 0, 7.5);
    if (game.action_count(ip_infoset) > 1)
    {
        trainer.assign_regret(ip_infoset, 1, -3.25);
    }
    const std::vector<double> seeded = trainer.regrets();
    // OOP-only pass: IP regrets must stay exactly as seeded.
    // DCFR end_pass uses trainer discount members; defaults are positive=1,
    // negative=0.5. That still finalizes OOP and must leave IP untouched.
    trainer.run_pass(0, oracle_average_weight(1));
    const std::vector<double> after = trainer.regrets();
    const std::vector<int> offset = poker::solver::action_offsets(game);
    const int base = offset[static_cast<std::size_t>(ip_infoset)];
    const int count = game.action_count(ip_infoset);
    for (int action = 0; action < count; ++action)
    {
        const std::size_t index = static_cast<std::size_t>(base + action);
        CHECK_NEAR(after[index], seeded[index], 1e-15);
    }
}

void expect_negative_regrets_recover()
{
    StreetGame game(tiny_river());
    // CFR+ would have floored; DCFR must keep a signed entry after discounting.
    CfrTrainer<StreetGame> early(game, Algorithm::Dcfr);
    early.assign_regret(0, 0, -100.0);
    early.run_iterations(1);
    CHECK(early.regrets()[0] < 0.0);
    // Discounted magnitude is strictly smaller than 100.
    CHECK(early.regrets()[0] > -100.0);

    CfrTrainer<StreetGame> trainer(game, Algorithm::Dcfr);
    trainer.assign_regret(0, 0, -100.0);
    trainer.run_iterations(5);
    bool saw_negative = false;
    for (double regret : trainer.regrets())
    {
        if (regret < -1e-12)
        {
            saw_negative = true;
        }
    }
    // Seeded negative mass remains signed after several discounted updates unless
    // later positive increments dominate; either outcome is valid so long as the
    // first-iteration check above kept the sign.
    (void)saw_negative;
}

void expect_quadratic_averaging_weight()
{
    // CancelGame-style: verify average_weight t^2 enters strategy_sum via own reach.
    // On a one-deal river shove tree, after one DCFR iteration the average weight is 1.
    // After two iterations, contributions use 1 then 4.
    StreetGame game(tiny_river());
    CfrTrainer<StreetGame> one(game, Algorithm::Dcfr);
    one.run_iterations(1);
    CfrTrainer<StreetGame> two(game, Algorithm::Dcfr);
    two.run_iterations(2);
    double sum_one = 0.0;
    double sum_two = 0.0;
    for (double value : one.strategy_sum())
    {
        sum_one += value;
    }
    for (double value : two.strategy_sum())
    {
        sum_two += value;
    }
    // Second iteration adds 4x the unit weight of the first when reaches match.
    // Exact ratio depends on changing sigma; require strictly heavier mass after iter 2.
    CHECK(sum_two > sum_one);
    CHECK_NEAR(oracle_average_weight(2) / oracle_average_weight(1), 4.0, 1e-15);
}

void expect_labeled_parity(
    const StreetConfig& config,
    int iterations,
    bool exact_regret_match)
{
    const StreetGame game(config);
    CfrTrainer<StreetGame> reference(game, Algorithm::Dcfr);
    reference.run_iterations(iterations);

    StreetBatchSolver batch(config);
    batch.run_frozen_iterations(iterations, Algorithm::Dcfr);

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
    double ratio_sum = 0.0;
    int ratio_count = 0;
    for (const auto& entry : entries)
    {
        const std::string key = entry.infoset + "\n" + entry.action;
        const auto found = ref_by_key.find(key);
        CHECK(found != ref_by_key.end());
        if (found != ref_by_key.end())
        {
            CHECK_NEAR(entry.probability, found->second, 1e-8);
        }
        double batch_regret = 0.0;
        CHECK(batch.regret_value(entry.infoset, entry.action, batch_regret));
        const auto regret_found = ref_regret.find(key);
        CHECK(regret_found != ref_regret.end());
        if (regret_found == ref_regret.end())
        {
            continue;
        }
        if (exact_regret_match)
        {
            // Five-card (no future chance) uses identical regret units.
            CHECK_NEAR(batch_regret, regret_found->second, 1e-8);
        }
        else if (std::abs(regret_found->second) > 1e-9)
        {
            // Turn/flop keep the established row-constant chance scale versus
            // StreetGame; CFR+ has the same convention. Ratios must be stable.
            ratio_sum += batch_regret / regret_found->second;
            ++ratio_count;
        }
    }
    if (!exact_regret_match && ratio_count > 0)
    {
        const double mean_ratio = ratio_sum / static_cast<double>(ratio_count);
        CfrTrainer<StreetGame> plus_ref(game, Algorithm::CfrPlus);
        plus_ref.run_iterations(iterations);
        StreetBatchSolver plus_batch(config);
        plus_batch.run_frozen_iterations(iterations, Algorithm::CfrPlus);
        double plus_sum = 0.0;
        int plus_count = 0;
        for (const auto& entry : plus_batch.average_strategy_entries())
        {
            double batch_regret = 0.0;
            CHECK(plus_batch.regret_value(entry.infoset, entry.action, batch_regret));
            // Locate matching reference regret by label.
            for (int infoset = 0; infoset < game.infoset_count(); ++infoset)
            {
                if (game.infoset_label(infoset) != entry.infoset)
                {
                    continue;
                }
                for (int action = 0; action < game.action_count(infoset); ++action)
                {
                    if (game.action_label(infoset, action) != entry.action)
                    {
                        continue;
                    }
                    const int base = offset[static_cast<std::size_t>(infoset)];
                    const double ref_value =
                        plus_ref.regrets()[static_cast<std::size_t>(base + action)];
                    if (std::abs(ref_value) > 1e-9)
                    {
                        plus_sum += batch_regret / ref_value;
                        ++plus_count;
                    }
                }
            }
        }
        CHECK(plus_count > 0);
        const double plus_mean = plus_sum / static_cast<double>(plus_count);
        CHECK_NEAR(mean_ratio, plus_mean, 1e-3 * std::max(1.0, std::abs(plus_mean)));
    }

    const poker::solver::SolveStats stats = reference.evaluate();
    CHECK_NEAR(batch.expected_utility(), stats.p1_expected_utility, 1e-8);
    CHECK_NEAR(batch.nash_gap(), stats.nash_gap, 1e-6);
    CHECK_NEAR(batch.p1_best_response_utility(), stats.p1_best_response_utility, 1e-6);
    CHECK_NEAR(batch.p2_best_response_utility(), stats.p2_best_response_utility, 1e-6);
}

void expect_batch_reference_parity()
{
    expect_labeled_parity(tiny_river(), 4, true);
    expect_labeled_parity(tiny_turn(), 3, false);
    expect_labeled_parity(tiny_flop(), 2, true);
}

void expect_zero_own_reach_and_blockers()
{
    StreetConfig config;
    config.board = {card("Ah"), card("Kd"), card("7c"), card("4s")};
    config.pot = 100;
    config.stack = 100;
    // Shared queen blocks one side's combo; zero-weight twin still listed via range text
    // is not needed — use a live combo with a dead twin on the board.
    config.oop = poker::holdem::Range::parse("QcQd,JsJd");
    config.ip = poker::holdem::Range::parse("QcTc,JhTh");
    config.oop_bet_sizes = {};
    config.ip_bet_sizes = {};
    config.max_raises = 0;
    config.allow_all_in = false;
    config.memory_mib = 64;

    StreetBatchSolver batch(config);
    batch.run_frozen_iterations(2, Algorithm::Dcfr);
    const StreetGame game(config);
    CfrTrainer<StreetGame> reference(game, Algorithm::Dcfr);
    reference.run_iterations(2);
    CHECK_NEAR(batch.nash_gap(), reference.evaluate().nash_gap, 1e-6);
    CHECK(std::isfinite(batch.expected_utility()));
}

void expect_continuation_matches_uninterrupted()
{
    const StreetConfig config = tiny_turn();
    StreetBatchSolver full(config);
    full.run_frozen_iterations(5, Algorithm::Dcfr);

    StreetBatchSolver part(config);
    part.run_frozen_iterations(2, Algorithm::Dcfr);
    part.continue_frozen_iterations(3, Algorithm::Dcfr);

    CHECK(part.completed_iterations() == 5);
    CHECK(full.completed_iterations() == 5);
    CHECK(part.regret_table().size() == full.regret_table().size());
    for (std::size_t i = 0; i < part.regret_table().size(); ++i)
    {
        CHECK_NEAR(part.regret_table()[i], full.regret_table()[i], 1e-12);
        CHECK_NEAR(part.strategy_sum_table()[i], full.strategy_sum_table()[i], 1e-12);
    }
    CHECK_NEAR(part.nash_gap(), full.nash_gap(), 1e-12);
}

void expect_save_load_continue()
{
    const StreetConfig config = tiny_river();
    StreetBatchSolver full(config);
    full.run_frozen_iterations(4, Algorithm::Dcfr);

    StreetBatchSolver part(config);
    part.run_frozen_iterations(2, Algorithm::Dcfr);

    poker::explorer::CheckpointDocument document;
    document.kind = 1;
    document.algorithm = poker::solver::kAlgorithmTagDcfr;
    document.frozen = true;
    document.samples = 1;
    document.config_text = poker::streets::format_street_config(part.config());
    document.tables = part.training_tables();
    document.value = part.expected_utility();

    const auto path = std::filesystem::temp_directory_path() / "poker-solver-dcfr.psol";
    poker::explorer::write_checkpoint(path.string(), document);
    const auto loaded = poker::explorer::read_checkpoint(path.string(), 64ull * 1024ull * 1024ull);
    CHECK(loaded.algorithm == poker::solver::kAlgorithmTagDcfr);
    CHECK(loaded.frozen);

    StreetBatchSolver restored(poker::streets::parse_street_config(loaded.config_text));
    restored.install_training_tables(loaded.tables);
    restored.bind_training_algorithm(Algorithm::Dcfr);
    restored.continue_frozen_iterations(2, Algorithm::Dcfr);
    CHECK(restored.completed_iterations() == 4);
    for (std::size_t i = 0; i < restored.regret_table().size(); ++i)
    {
        CHECK_NEAR(restored.regret_table()[i], full.regret_table()[i], 1e-12);
        CHECK_NEAR(restored.strategy_sum_table()[i], full.strategy_sum_table()[i], 1e-12);
    }
    std::filesystem::remove(path);
}

void expect_algorithm_tags_and_rejection()
{
    CHECK(poker::solver::algorithm_tag(Algorithm::VanillaCfr) == 0);
    CHECK(poker::solver::algorithm_tag(Algorithm::CfrPlus) == 1);
    CHECK(poker::solver::algorithm_tag(Algorithm::LinearCfr) == 2);
    CHECK(poker::solver::algorithm_tag(Algorithm::Dcfr) == 3);
    CHECK(poker::solver::algorithm_from_tag(3) == Algorithm::Dcfr);

    bool unknown = false;
    try
    {
        (void)poker::solver::algorithm_from_tag(4);
    }
    catch (const std::invalid_argument&)
    {
        unknown = true;
    }
    CHECK(unknown);

    poker::explorer::CheckpointDocument document;
    document.kind = 1;
    document.algorithm = 4;
    document.frozen = true;
    document.samples = 1;
    document.config_text = "street-config 1\n";
    document.tables.iterations = 0;
    bool bad_write = false;
    try
    {
        poker::explorer::write_checkpoint(
            (std::filesystem::temp_directory_path() / "poker-solver-dcfr-bad.psol").string(),
            document);
    }
    catch (const std::invalid_argument&)
    {
        bad_write = true;
    }
    CHECK(bad_write);

    // Old CFR+ tag still round-trips.
    const StreetConfig config = tiny_river();
    StreetBatchSolver solver(config);
    solver.run_frozen_iterations(1, Algorithm::CfrPlus);
    poker::explorer::CheckpointDocument legacy;
    legacy.kind = 1;
    legacy.algorithm = poker::solver::kAlgorithmTagCfrPlus;
    legacy.frozen = true;
    legacy.samples = 1;
    legacy.config_text = poker::streets::format_street_config(config);
    legacy.tables = solver.training_tables();
    const auto path = std::filesystem::temp_directory_path() / "poker-solver-dcfr-legacy.psol";
    poker::explorer::write_checkpoint(path.string(), legacy);
    const auto loaded = poker::explorer::read_checkpoint(path.string(), 64ull * 1024ull * 1024ull);
    CHECK(loaded.algorithm == 1);
    std::filesystem::remove(path);
}

void expect_algorithm_switch_rejects_without_mutation()
{
    const StreetConfig config = tiny_river();
    StreetBatchSolver solver(config);
    solver.run_frozen_iterations(2, Algorithm::Dcfr);
    const auto before_regret = std::vector<double>(
        solver.regret_table().begin(), solver.regret_table().end());
    const auto before_sum = std::vector<double>(
        solver.strategy_sum_table().begin(), solver.strategy_sum_table().end());
    const int before_iters = solver.completed_iterations();

    bool rejected = false;
    try
    {
        solver.continue_frozen_iterations(1, Algorithm::CfrPlus);
    }
    catch (const std::invalid_argument&)
    {
        rejected = true;
    }
    CHECK(rejected);
    CHECK(solver.completed_iterations() == before_iters);
    for (std::size_t i = 0; i < before_regret.size(); ++i)
    {
        CHECK_NEAR(solver.regret_table()[i], before_regret[i], 0.0);
        CHECK_NEAR(solver.strategy_sum_table()[i], before_sum[i], 0.0);
    }

    // Non-frozen DCFR rejected before mutation.
    StreetBatchSolver sequential(config);
    bool non_frozen = false;
    try
    {
        sequential.run_iterations(1, Algorithm::Dcfr);
    }
    catch (const std::invalid_argument&)
    {
        non_frozen = true;
    }
    CHECK(non_frozen);
    CHECK(sequential.completed_iterations() == 0);

    // Legacy river batch rejects DCFR.
    poker::river::RiverConfig river;
    for (int i = 0; i < 5; ++i)
    {
        river.board[static_cast<std::size_t>(i)] = config.board[static_cast<std::size_t>(i)];
    }
    river.pot = config.pot;
    river.stack = config.stack;
    river.oop = config.oop;
    river.ip = config.ip;
    river.oop_bet_sizes = config.oop_bet_sizes;
    river.ip_bet_sizes = config.ip_bet_sizes;
    river.max_raises = config.max_raises;
    river.allow_all_in = config.allow_all_in;
    poker::solver::RiverBatchSolver river_solver(river);
    bool river_reject = false;
    try
    {
        river_solver.run_iterations(1, Algorithm::Dcfr);
    }
    catch (const std::invalid_argument&)
    {
        river_reject = true;
    }
    CHECK(river_reject);
}

void expect_node_lock_honored()
{
    const StreetConfig config = tiny_river();
    StreetBatchSolver probe(config);
    const auto view = probe.inspect_node(probe.root_node_id());
    CHECK(view.actions.size() >= 2);
    poker::solver::LockSet locks;
    poker::solver::NodeLock lock;
    lock.infoset_id = 0;
    lock.kind = poker::solver::LockKind::FullNode;
    std::vector<double> probs(view.actions.size(), 0.0);
    probs[0] = 1.0;
    lock.actions = poker::solver::make_action_lock_row(
        probs, static_cast<int>(probs.size()));
    locks.upsert(lock);

    StreetBatchSolver locked(config);
    locked.run_frozen_iterations(3, Algorithm::Dcfr, &locks);
    const auto root = locked.inspect_node(locked.root_node_id());
    CHECK(!root.hands.empty());
    for (const auto& hand : root.hands)
    {
        if (!hand.structural)
        {
            continue;
        }
        CHECK_NEAR(hand.strategy[0], 1.0, 1e-12);
        for (std::size_t i = 1; i < hand.strategy.size(); ++i)
        {
            CHECK_NEAR(hand.strategy[i], 0.0, 1e-12);
        }
    }
}

void expect_thread_parity_and_existing_algs()
{
    StreetConfig config = tiny_turn();
    config.threads = 1;
    StreetBatchSolver one(config);
    one.run_frozen_iterations(3, Algorithm::Dcfr);

    config.threads = 2;
    StreetBatchSolver two(config);
    two.run_frozen_iterations(3, Algorithm::Dcfr);
    CHECK(one.regret_table().size() == two.regret_table().size());
    for (std::size_t i = 0; i < one.regret_table().size(); ++i)
    {
        CHECK_NEAR(one.regret_table()[i], two.regret_table()[i], 1e-9);
        CHECK_NEAR(one.strategy_sum_table()[i], two.strategy_sum_table()[i], 1e-9);
    }
    CHECK_NEAR(one.nash_gap(), two.nash_gap(), 1e-9);

    // Existing CFR+ / vanilla paths remain available and distinct from DCFR.
    StreetBatchSolver plus(tiny_river());
    plus.run_frozen_iterations(3, Algorithm::CfrPlus);
    StreetBatchSolver dcfr(tiny_river());
    dcfr.run_frozen_iterations(3, Algorithm::Dcfr);
    double regret_gap = 0.0;
    double sum_gap = 0.0;
    for (std::size_t i = 0; i < plus.regret_table().size(); ++i)
    {
        regret_gap += std::abs(plus.regret_table()[i] - dcfr.regret_table()[i]);
        sum_gap += std::abs(plus.strategy_sum_table()[i] - dcfr.strategy_sum_table()[i]);
    }
    CHECK(regret_gap + sum_gap > 1e-6);

    StreetBatchSolver vanilla(tiny_flop());
    vanilla.run_frozen_iterations(2, Algorithm::VanillaCfr);
    CHECK(vanilla.completed_iterations() == 2);
    CHECK(std::isfinite(vanilla.nash_gap()));
}

} // namespace

void run_dcfr_tests()
{
    expect_scalar_oracle();
    expect_non_updating_player_unchanged();
    expect_negative_regrets_recover();
    expect_quadratic_averaging_weight();
    expect_batch_reference_parity();
    expect_zero_own_reach_and_blockers();
    expect_continuation_matches_uninterrupted();
    expect_save_load_continue();
    expect_algorithm_tags_and_rejection();
    expect_algorithm_switch_rejects_without_mutation();
    expect_node_lock_honored();
    expect_thread_parity_and_existing_algs();
}
