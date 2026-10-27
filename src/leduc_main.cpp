#include "game/leduc_game.hpp"
#include "solver/trainer.hpp"

#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace
{

void print_usage(const char* argv0)
{
    std::cerr << "Usage: " << argv0
              << " [--iterations N] [--algorithm vanilla|cfr_plus]"
              << " [--max-raises N] [--max-raises-round2 N]"
              << " [--gap-threshold X] [--eval-interval N]"
              << " [--print-strategies]\n";
}

} // namespace

int main(int argc, char** argv)
{
    int iterations = 1000;
    int max_raises = poker::leduc::kDefaultMaxRaises;
    int max_raises_round2 = -1;
    double gap_threshold = -1.0;
    int eval_interval = 1000;
    bool print_strategies = false;
    poker::solver::Algorithm algorithm = poker::solver::Algorithm::VanillaCfr;

    for (int i = 1; i < argc; ++i)
    {
        const std::string arg = argv[i];
        if (arg == "--iterations" && i + 1 < argc)
        {
            iterations = std::atoi(argv[++i]);
        }
        else if (arg == "--algorithm" && i + 1 < argc)
        {
            const std::string name = argv[++i];
            if (name == "vanilla" || name == "vanilla_cfr")
            {
                algorithm = poker::solver::Algorithm::VanillaCfr;
            }
            else if (name == "cfr_plus" || name == "cfr+")
            {
                algorithm = poker::solver::Algorithm::CfrPlus;
            }
            else
            {
                std::cerr << "unknown algorithm: " << name << "\n";
                return 2;
            }
        }
        else if (arg == "--max-raises" && i + 1 < argc)
        {
            max_raises = std::atoi(argv[++i]);
        }
        else if (arg == "--max-raises-round2" && i + 1 < argc)
        {
            max_raises_round2 = std::atoi(argv[++i]);
        }
        else if (arg == "--gap-threshold" && i + 1 < argc)
        {
            gap_threshold = std::atof(argv[++i]);
        }
        else if (arg == "--eval-interval" && i + 1 < argc)
        {
            eval_interval = std::atoi(argv[++i]);
        }
        else if (arg == "--print-strategies")
        {
            print_strategies = true;
        }
        else if (arg == "--help" || arg == "-h")
        {
            print_usage(argv[0]);
            return 0;
        }
        else
        {
            print_usage(argv[0]);
            return 2;
        }
    }

    if (iterations <= 0)
    {
        std::cerr << "iterations must be positive\n";
        return 2;
    }

    poker::leduc::LeducConfig config;
    config.max_raises_round1 = max_raises;
    config.max_raises_round2 = max_raises_round2 >= 0 ? max_raises_round2 : max_raises;
    const poker::leduc::LeducGame game(config);

    poker::solver::SolveConfig solve_config;
    solve_config.max_iterations = iterations;
    solve_config.nash_gap_threshold = gap_threshold;
    solve_config.eval_interval = eval_interval;

    poker::solver::CfrTrainer<poker::leduc::LeducGame> trainer(game, algorithm);
    const poker::solver::SolveStats stats = trainer.solve(solve_config);
    const std::vector<double> strategy = trainer.average_strategy();

    std::cout.setf(std::ios::fmtflags(0), std::ios::floatfield);
    std::cout.precision(12);
    std::cout << "game: leduc\n";
    std::cout << "algorithm: " << poker::solver::algorithm_name(algorithm) << "\n";
    std::cout << "max_raises_round1: " << config.max_raises_round1 << "\n";
    std::cout << "max_raises_round2: " << config.max_raises_round2 << "\n";
    std::cout << "infosets: " << game.infoset_count() << "\n";
    std::cout << "iterations: " << stats.iterations << "\n";
    std::cout << "runtime_seconds: " << stats.runtime_seconds << "\n";
    std::cout << "memory_bytes_estimate: " << stats.memory_bytes_estimate << "\n";
    std::cout << "player0_expected_utility: " << stats.p1_expected_utility << "\n";
    std::cout << "player0_best_response_utility: " << stats.p1_best_response_utility << "\n";
    std::cout << "player1_best_response_utility: " << stats.p2_best_response_utility << "\n";
    std::cout << "nash_gap: " << stats.nash_gap << "\n";
    std::cout << "deterministic: yes (chance enumerated; no RNG)\n";

    if (print_strategies)
    {
        const auto offsets = poker::solver::action_offsets(game);
        std::cout << "average_strategy:\n";
        for (int infoset = 0; infoset < game.infoset_count(); ++infoset)
        {
            std::cout << "  " << game.infoset_label(infoset) << ":";
            const int count = game.action_count(infoset);
            const int base = offsets[static_cast<std::size_t>(infoset)];
            for (int action = 0; action < count; ++action)
            {
                std::cout << " " << game.action_label(infoset, action) << "="
                          << strategy[static_cast<std::size_t>(base + action)];
            }
            std::cout << "\n";
        }
    }
    return 0;
}
