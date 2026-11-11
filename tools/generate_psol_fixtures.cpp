// One-shot generator for tests/fixtures/psol/*.psol.
// Build: cmake --build build --target generate_psol_fixtures
// Run:   ./build/generate_psol_fixtures [output_dir]
#include "explorer/checkpoint.hpp"
#include "game/river_config_text.hpp"
#include "game/street_config_text.hpp"
#include "poker/card.hpp"
#include "poker/range.hpp"
#include "solver/river_batch.hpp"
#include "solver/street_batch.hpp"

#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>

namespace
{

int card(const char* text)
{
    return poker::holdem::parse_card(text);
}

} // namespace

int main(int argc, char** argv)
{
    const std::filesystem::path out_dir = argc > 1
        ? std::filesystem::path(argv[1])
        : std::filesystem::path("tests/fixtures/psol");
    std::filesystem::create_directories(out_dir);

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
        poker::solver::StreetBatchSolver solver(config);
        solver.continue_iterations(4, poker::solver::Algorithm::CfrPlus);
        poker::explorer::CheckpointDocument document;
        document.kind = 1;
        document.algorithm = 1;
        document.samples = 1;
        document.config_text = poker::streets::format_street_config(solver.config());
        document.tables = solver.training_tables();
        document.value = solver.expected_utility();
        const auto path = out_dir / "street_kind1_v2_cfrplus_tiny.psol";
        poker::explorer::write_checkpoint(path.string(), document);
        std::ofstream meta(out_dir / "street_kind1_v2_cfrplus_tiny.expected.txt");
        meta << "kind=1\n";
        meta << "algorithm=1\n";
        meta << "iterations=" << document.tables.iterations << "\n";
        meta << "value=" << document.value << "\n";
        meta << "oop_combos=" << document.tables.oop_combos.size() << "\n";
        meta << "ip_combos=" << document.tables.ip_combos.size() << "\n";
        meta << "slot_actions=";
        for (std::size_t i = 0; i < document.tables.slot_actions.size(); ++i)
        {
            if (i > 0)
            {
                meta << ',';
            }
            meta << document.tables.slot_actions[i];
        }
        meta << "\n";
        std::cout << "wrote " << path << " value=" << document.value << "\n";
    }

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
        poker::solver::RiverBatchSolver solver(config);
        solver.continue_iterations(3, poker::solver::Algorithm::CfrPlus);
        poker::explorer::CheckpointDocument document;
        document.kind = 2;
        document.algorithm = 1;
        document.samples = 1;
        document.config_text = poker::river::format_river_config(solver.config());
        document.tables = solver.training_tables();
        const auto path = out_dir / "river_kind2_v2_cfrplus_tiny.psol";
        poker::explorer::write_checkpoint(path.string(), document);
        std::ofstream meta(out_dir / "river_kind2_v2_cfrplus_tiny.expected.txt");
        meta << "kind=2\n";
        meta << "algorithm=1\n";
        meta << "iterations=" << document.tables.iterations << "\n";
        meta << "oop_combos=" << document.tables.oop_combos.size() << "\n";
        meta << "ip_combos=" << document.tables.ip_combos.size() << "\n";
        meta << "slot_actions=";
        for (std::size_t i = 0; i < document.tables.slot_actions.size(); ++i)
        {
            if (i > 0)
            {
                meta << ',';
            }
            meta << document.tables.slot_actions[i];
        }
        meta << "\n";
        std::cout << "wrote " << path << "\n";
    }
    return 0;
}
