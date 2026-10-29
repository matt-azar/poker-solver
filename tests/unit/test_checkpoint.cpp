#include "harness.hpp"

#include "explorer/checkpoint.hpp"
#include "game/river_config_text.hpp"
#include "game/street_config_text.hpp"
#include "poker/card.hpp"
#include "poker/equity.hpp"
#include "poker/range.hpp"
#include "solver/river_batch.hpp"
#include "solver/street_batch.hpp"
#include "solver/trainer.hpp"

#include <cmath>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <stdexcept>
#include <string>

namespace
{

using poker::explorer::CheckpointDocument;
using poker::explorer::CheckpointFault;
using poker::solver::Algorithm;
using poker::solver::StreetBatchSolver;
using poker::solver::TrainingTables;

int card(const char* text)
{
    return poker::holdem::parse_card(text);
}

poker::streets::StreetConfig turn_config()
{
    poker::streets::StreetConfig config;
    config.board = {card("Ah"), card("Kd"), card("7c"), card("4s")};
    config.pot = 100;
    config.stack = 100;
    config.oop = poker::holdem::Range::parse("AcAd");
    config.ip = poker::holdem::Range::parse("KsKc");
    config.oop_bet_sizes = {0.5};
    config.ip_bet_sizes = {0.5};
    config.max_raises = 0;
    config.allow_all_in = false;
    config.memory_mib = 64;
    return config;
}

bool same_tables(const TrainingTables& left, const TrainingTables& right)
{
    return left.iterations == right.iterations
        && left.oop_combos == right.oop_combos
        && left.ip_combos == right.ip_combos
        && left.slot_actions == right.slot_actions
        && left.regret == right.regret
        && left.strategy_sum == right.strategy_sum;
}

std::filesystem::path test_file(const char* name)
{
    return std::filesystem::temp_directory_path() / name;
}

void test_resume_matches_uninterrupted_street()
{
    const poker::streets::StreetConfig config = turn_config();
    StreetBatchSolver full(config);
    full.continue_iterations(6, Algorithm::CfrPlus);
    StreetBatchSolver part(config);
    part.continue_iterations(4, Algorithm::CfrPlus);
    CheckpointDocument document;
    document.kind = 1;
    document.algorithm = 1;
    document.samples = 1;
    document.config_text = poker::streets::format_street_config(part.config());
    document.tables = part.training_tables();
    document.value = part.expected_utility();
    const std::filesystem::path path = test_file("poker-solver-street.psol");
    poker::explorer::write_checkpoint(path.string(), document);
    const CheckpointDocument loaded = poker::explorer::read_checkpoint(path.string(), 64ull * 1024ull * 1024ull);
    CHECK(loaded.config_text == document.config_text);
    CHECK(same_tables(loaded.tables, document.tables));
    StreetBatchSolver restored(poker::streets::parse_street_config(loaded.config_text));
    restored.install_training_tables(loaded.tables);
    restored.continue_iterations(2, Algorithm::CfrPlus);
    CHECK(same_tables(restored.training_tables(), full.training_tables()));
    CHECK(restored.completed_iterations() == 6);
    std::filesystem::remove(path);
}

void test_resume_matches_uninterrupted_river()
{
    poker::river::RiverConfig config;
    config.board = {card("Ah"), card("Kd"), card("7c"), card("4s"), card("2h")};
    config.pot = 100;
    config.stack = 100;
    config.oop = poker::holdem::Range::parse("AcAd");
    config.ip = poker::holdem::Range::parse("KsKc");
    config.oop_bet_sizes = {0.5};
    config.ip_bet_sizes = {0.5};
    config.max_raises = 0;
    config.allow_all_in = false;
    poker::solver::RiverBatchSolver full(config);
    full.continue_iterations(5, Algorithm::CfrPlus);
    poker::solver::RiverBatchSolver part(config);
    part.continue_iterations(3, Algorithm::CfrPlus);
    const std::string text = poker::river::format_river_config(part.config());
    CHECK(poker::river::format_river_config(poker::river::parse_river_config(text)) == text);
    CheckpointDocument document;
    document.kind = 2;
    document.algorithm = 1;
    document.samples = 1;
    document.config_text = text;
    document.tables = part.training_tables();
    const std::filesystem::path path = test_file("poker-solver-river.psol");
    poker::explorer::write_checkpoint(path.string(), document);
    const CheckpointDocument loaded = poker::explorer::read_checkpoint(path.string(), 64ull * 1024ull * 1024ull);
    poker::solver::RiverBatchSolver restored(poker::river::parse_river_config(loaded.config_text));
    restored.install_training_tables(loaded.tables);
    restored.continue_iterations(2, Algorithm::CfrPlus);
    CHECK(same_tables(restored.training_tables(), full.training_tables()));
    std::filesystem::remove(path);
}

void test_checkpoint_rejects_bad_files()
{
    const poker::streets::StreetConfig config = turn_config();
    StreetBatchSolver solver(config);
    solver.continue_iterations(1, Algorithm::CfrPlus);
    CheckpointDocument document;
    document.kind = 1;
    document.algorithm = 1;
    document.samples = 1;
    document.config_text = poker::streets::format_street_config(config);
    document.tables = solver.training_tables();
    const std::filesystem::path path = test_file("poker-solver-guard.psol");
    {
        std::ofstream previous(path, std::ios::binary | std::ios::trunc);
        previous << "keep";
    }
    bool aborted = false;
    try
    {
        poker::explorer::write_checkpoint(path.string(), document, CheckpointFault::BeforeReplace);
    }
    catch (const std::runtime_error&)
    {
        aborted = true;
    }
    CHECK(aborted);
    {
        std::ifstream previous(path, std::ios::binary);
        std::string text;
        std::getline(previous, text);
        CHECK(text == "keep");
    }
    poker::explorer::write_checkpoint(path.string(), document);
    bool limited = false;
    try
    {
        poker::explorer::read_checkpoint(path.string(), 8);
    }
    catch (const std::invalid_argument&)
    {
        limited = true;
    }
    CHECK(limited);
    {
        std::ifstream input(path, std::ios::binary);
        std::string bytes((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
        CHECK(!bytes.empty());
        bytes.back() = static_cast<char>(static_cast<unsigned char>(bytes.back()) ^ 0x5au);
        std::ofstream output(path, std::ios::binary | std::ios::trunc);
        output.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
    }
    bool checksum = false;
    try
    {
        poker::explorer::read_checkpoint(path.string(), 64ull * 1024ull * 1024ull);
    }
    catch (const std::invalid_argument&)
    {
        checksum = true;
    }
    CHECK(checksum);
    StreetBatchSolver other(config);
    TrainingTables wrong = solver.training_tables();
    if (!wrong.oop_combos.empty())
    {
        wrong.oop_combos[0] ^= 1;
    }
    bool mismatch = false;
    try
    {
        other.install_training_tables(wrong);
    }
    catch (const std::invalid_argument&)
    {
        mismatch = true;
    }
    CHECK(mismatch);
    std::filesystem::remove(path);
}

std::string chance_after_checks(StreetBatchSolver& solver)
{
    std::string node = solver.root_node_id();
    for (int step = 0; step < 6; ++step)
    {
        const poker::solver::StreetInspection view = solver.inspect_node(node);
        if (view.kind == "chance")
        {
            return node;
        }
        int check = -1;
        for (int index = 0; index < static_cast<int>(view.actions.size()); ++index)
        {
            if (view.actions[static_cast<std::size_t>(index)].label == "Check")
            {
                check = index;
            }
        }
        CHECK(check >= 0);
        node = view.actions[static_cast<std::size_t>(check)].child_id;
    }
    CHECK(false);
    return node;
}

void test_runout_and_equity()
{
    StreetBatchSolver solver(turn_config());
    solver.continue_iterations(2, Algorithm::CfrPlus);
    const poker::solver::StreetReachWeights weights = solver.reaching_weights(solver.root_node_id());
    const poker::holdem::ShowdownEquity equity = poker::holdem::showdown_equity(
        weights.board,
        poker::holdem::Range::parse(weights.oop),
        poker::holdem::Range::parse(weights.ip));
    CHECK(equity.joint_defined);
    CHECK(equity.player0.defined);
    CHECK(equity.player1.defined);
    CHECK_NEAR(equity.player0.equity + equity.player1.equity, 1.0, 1e-9);
    const std::string chance = chance_after_checks(solver);
    const poker::solver::StreetRunoutValues runout = solver.runout_values(chance, nullptr);
    CHECK(!runout.cards.empty());
    double probability = 0.0;
    double weighted_oop = 0.0;
    double weighted_ip = 0.0;
    bool any = false;
    for (const poker::solver::StreetRunoutCard& card : runout.cards)
    {
        if (!card.probability_defined)
        {
            continue;
        }
        probability += card.probability;
        if (card.probability == 0.0)
        {
            CHECK(!card.ev_defined);
            continue;
        }
        CHECK(card.ev_defined);
        CHECK_NEAR(card.oop_ev + card.ip_ev, 0.0, 1e-6);
        weighted_oop += card.probability * card.oop_ev;
        weighted_ip += card.probability * card.ip_ev;
        any = true;
    }
    CHECK(any);
    CHECK_NEAR(probability, 1.0, 1e-9);
    CHECK(runout.parent_ev_defined);
    CHECK_NEAR(runout.parent_oop_ev, weighted_oop, 1e-6);
    CHECK_NEAR(runout.parent_ip_ev, weighted_ip, 1e-6);
    CHECK_NEAR(runout.parent_oop_ev + runout.parent_ip_ev, 0.0, 1e-6);
    CHECK(runout.utility_basis == "root_centered");
}

} // namespace

void run_checkpoint_tests()
{
    test_resume_matches_uninterrupted_street();
    test_resume_matches_uninterrupted_river();
    test_checkpoint_rejects_bad_files();
    test_runout_and_equity();
}
