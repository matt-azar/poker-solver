#include "harness.hpp"

#include "explorer/checkpoint.hpp"
#include "game/river_config_text.hpp"
#include "game/street_config_text.hpp"
#include "poker/card.hpp"
#include "poker/equity.hpp"
#include "poker/range.hpp"
#include "solver/node_lock.hpp"
#include "solver/river_batch.hpp"
#include "solver/street_batch.hpp"
#include "solver/trainer.hpp"

#include <cmath>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

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
    config.pot = 1000;
    config.stack = 1000;
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

std::filesystem::path test_file(const char* prefix)
{
    return unique_temp_path(prefix);
}

std::filesystem::path fixture_path(const char* relative)
{
#ifdef POKER_SOLVER_SOURCE_DIR
    return std::filesystem::path(POKER_SOLVER_SOURCE_DIR) / relative;
#else
    return std::filesystem::path(relative);
#endif
}

void test_release_fixture_street_kind1_continue()
{
    const std::filesystem::path path =
        fixture_path("tests/fixtures/psol/street_kind1_v2_cfrplus_tiny.psol");
    CHECK(std::filesystem::is_regular_file(path));
    const CheckpointDocument loaded =
        poker::explorer::read_checkpoint(path.string(), 64ull * 1024ull * 1024ull);
    CHECK(loaded.kind == 1);
    CHECK(loaded.algorithm == 1);
    CHECK(loaded.tables.iterations == 4);
    CHECK(loaded.tables.oop_combos.size() == 1);
    CHECK(loaded.tables.ip_combos.size() == 1);
    CHECK(!loaded.tables.slot_actions.empty());
    for (const std::uint32_t actions : loaded.tables.slot_actions)
    {
        CHECK(actions == 2);
    }
    CHECK_NEAR(loaded.value, 55.7904, 1e-3);

    const poker::streets::StreetConfig config =
        poker::streets::parse_street_config(loaded.config_text);
    StreetBatchSolver full(config);
    full.continue_iterations(6, Algorithm::CfrPlus);
    StreetBatchSolver restored(config);
    restored.install_training_tables(loaded.tables);
    restored.bind_training_algorithm(Algorithm::CfrPlus);
    restored.continue_iterations(2, Algorithm::CfrPlus);
    CHECK(same_tables(restored.training_tables(), full.training_tables()));
    CHECK(restored.completed_iterations() == 6);
}

void test_release_fixture_river_kind2_continue()
{
    const std::filesystem::path path =
        fixture_path("tests/fixtures/psol/river_kind2_v2_cfrplus_tiny.psol");
    CHECK(std::filesystem::is_regular_file(path));
    const CheckpointDocument loaded =
        poker::explorer::read_checkpoint(path.string(), 64ull * 1024ull * 1024ull);
    CHECK(loaded.kind == 2);
    CHECK(loaded.algorithm == 1);
    CHECK(loaded.tables.iterations == 3);
    CHECK(loaded.tables.oop_combos.size() == 1);
    CHECK(loaded.tables.ip_combos.size() == 1);
    for (const std::uint32_t actions : loaded.tables.slot_actions)
    {
        CHECK(actions == 2);
    }

    const poker::river::RiverConfig config =
        poker::river::parse_river_config(loaded.config_text);
    poker::solver::RiverBatchSolver full(config);
    full.continue_iterations(5, Algorithm::CfrPlus);
    poker::solver::RiverBatchSolver restored(config);
    restored.install_training_tables(loaded.tables);
    restored.continue_iterations(2, Algorithm::CfrPlus);
    CHECK(same_tables(restored.training_tables(), full.training_tables()));
}

void test_checkpoint_unique_temps_concurrent_writers()
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
    document.value = solver.expected_utility();

    const std::filesystem::path path_a = test_file("poker-solver-conc-a.psol");
    const std::filesystem::path path_b = test_file("poker-solver-conc-b.psol");
    poker::explorer::write_checkpoint(path_a.string(), document);
    poker::explorer::write_checkpoint(path_b.string(), document);
    const CheckpointDocument loaded_a =
        poker::explorer::read_checkpoint(path_a.string(), 64ull * 1024ull * 1024ull);
    const CheckpointDocument loaded_b =
        poker::explorer::read_checkpoint(path_b.string(), 64ull * 1024ull * 1024ull);
    CHECK(same_tables(loaded_a.tables, document.tables));
    CHECK(same_tables(loaded_b.tables, document.tables));
    // Fixed sibling `.tmp` must not remain after a successful replace.
    CHECK(!std::filesystem::exists(path_a.string() + ".tmp"));
    CHECK(!std::filesystem::exists(path_b.string() + ".tmp"));
    std::filesystem::remove(path_a);
    std::filesystem::remove(path_b);
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
    restored.bind_training_algorithm(Algorithm::CfrPlus);
    restored.continue_iterations(2, Algorithm::CfrPlus);
    CHECK(same_tables(restored.training_tables(), full.training_tables()));
    CHECK(restored.completed_iterations() == 6);
    std::filesystem::remove(path);
}

void test_resume_matches_uninterrupted_river()
{
    poker::river::RiverConfig config;
    config.board = {card("Ah"), card("Kd"), card("7c"), card("4s"), card("2h")};
    config.pot = 1000;
    config.stack = 1000;
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
    // Save preflight rejects over-budget payloads without replacing the destination.
    bool save_limited = false;
    try
    {
        poker::explorer::write_checkpoint(path.string(), document, CheckpointFault::None, 8);
    }
    catch (const std::invalid_argument&)
    {
        save_limited = true;
    }
    CHECK(save_limited);
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

std::uint64_t fnv1a64_bytes(std::string_view bytes)
{
    std::uint64_t hash = 14695981039346656037ull;
    for (unsigned char byte : bytes)
    {
        hash ^= byte;
        hash *= 1099511628211ull;
    }
    return hash;
}

std::uint32_t crc32_bytes(std::string_view bytes)
{
    std::uint32_t crc = 0xffffffffu;
    for (unsigned char byte : bytes)
    {
        crc ^= byte;
        for (int shift = 0; shift < 8; ++shift)
        {
            const bool low_bit = (crc & 1u) != 0;
            crc >>= 1;
            if (low_bit)
            {
                crc ^= 0xedb88320u;
            }
        }
    }
    return ~crc;
}

void write_u32_le(std::string& bytes, std::size_t at, std::uint32_t value)
{
    bytes[at] = static_cast<char>(value & 0xffu);
    bytes[at + 1] = static_cast<char>((value >> 8) & 0xffu);
    bytes[at + 2] = static_cast<char>((value >> 16) & 0xffu);
    bytes[at + 3] = static_cast<char>((value >> 24) & 0xffu);
}

void write_u64_le(std::string& bytes, std::size_t at, std::uint64_t value)
{
    for (int index = 0; index < 8; ++index)
    {
        bytes[at + static_cast<std::size_t>(index)] =
            static_cast<char>((value >> (8 * index)) & 0xffu);
    }
}

void test_checkpoint_locks_round_trip()
{
    const poker::streets::StreetConfig config = turn_config();
    StreetBatchSolver solver(config);
    solver.continue_iterations(2, Algorithm::CfrPlus);

    poker::solver::LockSet locks;
    poker::solver::NodeLock lock;
    lock.infoset_id = 0;
    lock.kind = poker::solver::LockKind::SelectedCombos;
    lock.combo_indices = {0};
    const double probs[] = {0.0, 1.0};
    lock.actions = poker::solver::make_action_lock_row(probs, 2);
    locks.upsert(lock);

    CheckpointDocument document;
    document.kind = 1;
    document.algorithm = 1;
    document.samples = 1;
    document.config_text = poker::streets::format_street_config(config);
    document.tables = solver.training_tables();
    document.locks_text = poker::solver::format_lock_set(locks);
    CHECK(!document.locks_text.empty());

    const std::filesystem::path path = test_file("poker-solver-locks.psol");
    poker::explorer::write_checkpoint(path.string(), document);
    const CheckpointDocument loaded =
        poker::explorer::read_checkpoint(path.string(), 64ull * 1024ull * 1024ull);
    CHECK(loaded.locks_text == document.locks_text);
    const poker::solver::LockSet back = poker::solver::parse_lock_set(loaded.locks_text);
    CHECK(back.size() == 1);
    const poker::solver::NodeLock* found = back.find(0);
    CHECK(found != nullptr);
    CHECK(found->kind == poker::solver::LockKind::SelectedCombos);
    CHECK(found->combo_indices.size() == 1);
    CHECK(found->combo_indices[0] == 0);
    CHECK(found->actions.probs.size() == 2);
    CHECK_NEAR(found->actions.probs[0], 0.0, 1e-15);
    CHECK_NEAR(found->actions.probs[1], 1.0, 1e-15);
    std::filesystem::remove(path);
}

void test_checkpoint_v1_loads_empty_locks()
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
    // Empty locks_text still writes a trailing u32(0) in v2; strip it for a v1 file.
    const std::filesystem::path path = test_file("poker-solver-v1.psol");
    poker::explorer::write_checkpoint(path.string(), document);
    {
        std::ifstream input(path, std::ios::binary);
        std::string bytes((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
        CHECK(bytes.size() > 32);
        CHECK(bytes.compare(0, 4, "PSOL") == 0);
        // Drop the final empty locks string (4 zero length bytes) from the payload.
        CHECK(bytes.size() >= 36);
        bytes.resize(bytes.size() - 4);
        const std::uint64_t payload_size = bytes.size() - 32;
        write_u32_le(bytes, 4, 1); // version 1
        write_u64_le(bytes, 8, payload_size);
        const std::string_view payload(bytes.data() + 32, static_cast<std::size_t>(payload_size));
        write_u64_le(bytes, 16, fnv1a64_bytes(payload));
        write_u32_le(bytes, 24, crc32_bytes(payload));
        std::ofstream output(path, std::ios::binary | std::ios::trunc);
        output.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
    }
    const CheckpointDocument loaded =
        poker::explorer::read_checkpoint(path.string(), 64ull * 1024ull * 1024ull);
    CHECK(loaded.locks_text.empty());
    CHECK(same_tables(loaded.tables, document.tables));
    std::filesystem::remove(path);
}

void test_checkpoint_scalar_stream_and_size_estimate()
{
    const poker::streets::StreetConfig config = turn_config();
    StreetBatchSolver solver(config);
    solver.continue_iterations(2, Algorithm::CfrPlus);
    CheckpointDocument document;
    document.kind = 1;
    document.algorithm = 1;
    document.samples = 1;
    document.config_text = poker::streets::format_street_config(config);
    solver.export_training_identity(document.tables);
    poker::explorer::CheckpointScalarTables scalars;
    scalars.regret = solver.regret_table();
    scalars.strategy_sum = solver.strategy_sum_table();
    const std::uint64_t estimated =
        poker::explorer::estimate_checkpoint_payload_bytes(document, &scalars);
    CHECK(estimated > 0);
    CHECK(estimated < poker::explorer::kMaxCheckpointBytes);
    const std::filesystem::path path = test_file("poker-solver-scalar.psol");
    poker::explorer::write_checkpoint(
        path.string(),
        document,
        CheckpointFault::None,
        poker::explorer::kMaxCheckpointBytes,
        &scalars);
    const CheckpointDocument loaded =
        poker::explorer::read_checkpoint(path.string(), poker::explorer::kMaxCheckpointBytes);
    CHECK(same_tables(loaded.tables, solver.training_tables()));
    std::filesystem::remove(path);
}

void test_checkpoint_dcfr_params_round_trip()
{
    const poker::streets::StreetConfig config = turn_config();
    StreetBatchSolver solver(config);
    const poker::solver::DcfrParams params{2.0, 0.5, 1.0};
    solver.set_dcfr_params(params);
    solver.run_frozen_iterations(2, Algorithm::Dcfr);
    CheckpointDocument document;
    document.kind = 1;
    document.algorithm = poker::solver::kAlgorithmTagDcfr;
    document.frozen = true;
    document.samples = 1;
    document.config_text = poker::streets::format_street_config(config);
    document.tables = solver.training_tables();
    document.has_dcfr_params = true;
    document.dcfr = params;
    const std::filesystem::path path = test_file("poker-solver-dcfr-params.psol");
    poker::explorer::write_checkpoint(path.string(), document);
    const CheckpointDocument loaded =
        poker::explorer::read_checkpoint(path.string(), 64ull * 1024ull * 1024ull);
    CHECK(loaded.has_dcfr_params);
    CHECK_NEAR(loaded.dcfr.alpha, 2.0, 0.0);
    CHECK_NEAR(loaded.dcfr.beta, 0.5, 0.0);
    CHECK_NEAR(loaded.dcfr.gamma, 1.0, 0.0);
    StreetBatchSolver restored(config);
    restored.install_training_tables(loaded.tables);
    restored.bind_training_algorithm(Algorithm::Dcfr);
    restored.set_dcfr_params(loaded.dcfr);
    CHECK_NEAR(restored.dcfr_params().alpha, 2.0, 0.0);
    CHECK_NEAR(restored.dcfr_params().beta, 0.5, 0.0);
    CHECK_NEAR(restored.dcfr_params().gamma, 1.0, 0.0);
    std::filesystem::remove(path);
}

void test_checkpoint_pcfr_prediction_exact_continue()
{
    const poker::streets::StreetConfig config = turn_config();
    StreetBatchSolver full(config);
    full.run_frozen_iterations(6, Algorithm::PcfrPlus);

    StreetBatchSolver part(config);
    part.run_frozen_iterations(4, Algorithm::PcfrPlus);
    CHECK(!part.prediction_table().empty());

    CheckpointDocument document;
    document.kind = 1;
    document.algorithm = poker::solver::kAlgorithmTagPcfrPlus;
    document.frozen = true;
    document.samples = 1;
    document.config_text = poker::streets::format_street_config(config);
    document.tables = part.training_tables();
    document.prediction.assign(part.prediction_table().begin(), part.prediction_table().end());
    const std::filesystem::path path = test_file("poker-solver-pcfr-pred.psol");
    poker::explorer::write_checkpoint(path.string(), document);
    const CheckpointDocument loaded =
        poker::explorer::read_checkpoint(path.string(), 64ull * 1024ull * 1024ull);
    CHECK(loaded.prediction.size() == document.prediction.size());

    StreetBatchSolver restored(config);
    restored.install_training_tables(loaded.tables);
    restored.bind_training_algorithm(Algorithm::PcfrPlus);
    restored.install_prediction_table(loaded.prediction);
    restored.continue_frozen_iterations(2, Algorithm::PcfrPlus);
    CHECK(restored.completed_iterations() == 6);
    CHECK(same_tables(restored.training_tables(), full.training_tables()));
    std::filesystem::remove(path);
}

void expect_checkdown_matches_enumerator(StreetBatchSolver& solver, const std::string& node_id)
{
    const poker::solver::StreetReachWeights weights = solver.reaching_weights(node_id);
    const poker::holdem::ShowdownEquity equity = poker::holdem::showdown_equity(
        weights.board,
        poker::holdem::Range::parse(weights.oop),
        poker::holdem::Range::parse(weights.ip));
    const poker::holdem::ShowdownEquity native = solver.checkdown_equity(node_id, nullptr);
    CHECK(equity.joint_defined == native.joint_defined);
    if (!equity.joint_defined)
    {
        return;
    }
    CHECK(native.player0.defined);
    CHECK(native.player1.defined);
    CHECK_NEAR(native.player0.equity, equity.player0.equity, 1e-9);
    CHECK_NEAR(native.player1.equity, equity.player1.equity, 1e-9);
    CHECK_NEAR(native.player0.equity + native.player1.equity, 1.0, 1e-9);
}

void test_runout_and_equity()
{
    StreetBatchSolver solver(turn_config());
    solver.continue_iterations(2, Algorithm::CfrPlus);
    expect_checkdown_matches_enumerator(solver, solver.root_node_id());
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

void test_checkdown_equity_parity_flop_and_river()
{
    {
        poker::streets::StreetConfig config;
        config.board = {card("Ah"), card("Kd"), card("7c")};
        config.pot = 100;
        config.stack = 100;
        config.oop = poker::holdem::Range::parse("QcQd,JcJd");
        config.ip = poker::holdem::Range::parse("TcTd,9c9d");
        config.oop_bet_sizes = {};
        config.ip_bet_sizes = {};
        config.max_raises = 0;
        config.allow_all_in = false;
        config.memory_mib = 64;
        StreetBatchSolver solver(config);
        solver.continue_iterations(1, Algorithm::CfrPlus);
        expect_checkdown_matches_enumerator(solver, solver.root_node_id());
    }
    {
        poker::streets::StreetConfig config;
        config.board = {card("Ah"), card("Kd"), card("7c"), card("4s"), card("2h")};
        config.pot = 100;
        config.stack = 100;
        config.oop = poker::holdem::Range::parse("AcAd:1,KsKc:0.5");
        config.ip = poker::holdem::Range::parse("QsQc:1,JsJc:0.25");
        config.oop_bet_sizes = {};
        config.ip_bet_sizes = {};
        config.max_raises = 0;
        config.allow_all_in = false;
        config.memory_mib = 64;
        StreetBatchSolver solver(config);
        solver.continue_iterations(1, Algorithm::CfrPlus);
        expect_checkdown_matches_enumerator(solver, solver.root_node_id());
    }
}

} // namespace

void run_checkpoint_tests()
{
    test_resume_matches_uninterrupted_street();
    test_resume_matches_uninterrupted_river();
    test_release_fixture_street_kind1_continue();
    test_release_fixture_river_kind2_continue();
    test_checkpoint_unique_temps_concurrent_writers();
    test_checkpoint_rejects_bad_files();
    test_checkpoint_locks_round_trip();
    test_checkpoint_v1_loads_empty_locks();
    test_checkpoint_scalar_stream_and_size_estimate();
    test_checkpoint_dcfr_params_round_trip();
    test_checkpoint_pcfr_prediction_exact_continue();
    test_runout_and_equity();
    test_checkdown_equity_parity_flop_and_river();
}
