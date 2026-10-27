#include "game/kuhn_game.hpp"
#include "solver/cfr.hpp"

#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace
{

void print_usage(const char* argv0)
{
    std::cerr << "Usage: " << argv0
              << " [--iterations N] [--algorithm vanilla|cfr_plus|linear]"
              << " [--gap-threshold X] [--eval-interval N]"
              << " [--print-strategies] [--json PATH]\n";
}

void print_strategies(const std::vector<double>& strategy, std::ostream& out)
{
    using namespace poker::kuhn;
    out << std::fixed << std::setprecision(6);
    for (int infoset = 0; infoset < kNumInfosets; ++infoset)
    {
        const Action a0 = local_action_to_action(infoset, 0);
        const Action a1 = local_action_to_action(infoset, 1);
        const double p0 = strategy[infoset * kActionsPerInfoset + 0];
        const double p1 = strategy[infoset * kActionsPerInfoset + 1];
        out << "  " << infoset_label(infoset) << ": "
            << action_name(a0) << "=" << p0 << "  "
            << action_name(a1) << "=" << p1 << "\n";
    }
}

void write_json(const poker::solver::SolveStats& stats,
                const std::vector<double>& strategy,
                const std::string& path,
                const char* algorithm)
{
    using namespace poker::kuhn;
    std::ofstream out(path);
    if (!out)
    {
        throw std::runtime_error("failed to write JSON: " + path);
    }
    out << std::setprecision(17);
    out << "{\n";
    out << "  \"iterations\": " << stats.iterations << ",\n";
    out << "  \"runtime_seconds\": " << stats.runtime_seconds << ",\n";
    out << "  \"memory_bytes_estimate\": " << stats.memory_bytes_estimate << ",\n";
    out << "  \"player1_expected_utility\": " << stats.p1_expected_utility << ",\n";
    out << "  \"player1_best_response_utility\": " << stats.p1_best_response_utility << ",\n";
    out << "  \"player2_best_response_utility\": " << stats.p2_best_response_utility << ",\n";
    out << "  \"nash_gap\": " << stats.nash_gap << ",\n";
    out << "  \"theoretical_player1_value\": " << kEquilibriumP1Value << ",\n";
    out << "  \"algorithm\": \"" << algorithm << "\",\n";
    out << "  \"strategies\": [\n";
    for (int infoset = 0; infoset < kNumInfosets; ++infoset)
    {
        out << "    {\n";
        out << "      \"infoset\": \"" << infoset_label(infoset) << "\",\n";
        const Action a0 = local_action_to_action(infoset, 0);
        const Action a1 = local_action_to_action(infoset, 1);
        out << "      \"" << action_name(a0) << "\": "
            << strategy[infoset * kActionsPerInfoset] << ",\n";
        out << "      \"" << action_name(a1) << "\": "
            << strategy[infoset * kActionsPerInfoset + 1] << "\n";
        out << "    }" << (infoset + 1 == kNumInfosets ? "\n" : ",\n");
    }
    out << "  ]\n";
    out << "}\n";
}

} // namespace

int main(int argc, char** argv)
{
    int iterations = 100000;
    bool print_strat = false;
    std::string json_path;
    poker::solver::Algorithm algorithm = poker::solver::Algorithm::VanillaCfr;
    double gap_threshold = -1.0;
    int eval_interval = 1000;

    for (int i = 1; i < argc; ++i)
    {
        const std::string arg = argv[i];
        if (arg == "--iterations" && i + 1 < argc)
        {
            iterations = std::atoi(argv[++i]);
        }
        else if (arg == "--print-strategies")
        {
            print_strat = true;
        }
        else if (arg == "--json" && i + 1 < argc)
        {
            json_path = argv[++i];
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
            else if (name == "linear" || name == "linear_cfr")
            {
                algorithm = poker::solver::Algorithm::LinearCfr;
            }
            else
            {
                std::cerr << "unknown algorithm: " << name << "\n";
                return 2;
            }
        }
        else if (arg == "--gap-threshold" && i + 1 < argc)
        {
            gap_threshold = std::atof(argv[++i]);
        }
        else if (arg == "--eval-interval" && i + 1 < argc)
        {
            eval_interval = std::atoi(argv[++i]);
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

    poker::solver::SolveConfig config;
    config.max_iterations = iterations;
    config.nash_gap_threshold = gap_threshold;
    config.eval_interval = eval_interval;

    poker::solver::CfrTrainer<poker::kuhn::KuhnGame> trainer(poker::kuhn::KuhnGame{}, algorithm);
    const auto stats = trainer.solve(config);
    const auto strategy = trainer.average_strategy();
    const char* algorithm_label = poker::solver::algorithm_name(algorithm);

    std::cout << std::setprecision(12);
    std::cout << "algorithm: " << algorithm_label << "\n";
    std::cout << "iterations: " << stats.iterations << "\n";
    std::cout << "runtime_seconds: " << stats.runtime_seconds << "\n";
    std::cout << "memory_bytes_estimate: " << stats.memory_bytes_estimate << "\n";
    std::cout << "player1_expected_utility: " << stats.p1_expected_utility << "\n";
    std::cout << "theoretical_player1_value: " << poker::kuhn::kEquilibriumP1Value << "\n";
    std::cout << "player1_best_response_utility: " << stats.p1_best_response_utility << "\n";
    std::cout << "player2_best_response_utility: " << stats.p2_best_response_utility << "\n";
    std::cout << "nash_gap: " << stats.nash_gap << "\n";
    std::cout << "deterministic: yes (chance enumerated; no RNG)\n";

    if (print_strat)
    {
        std::cout << "average_strategy:\n";
        print_strategies(strategy, std::cout);
    }

    if (!json_path.empty())
    {
        write_json(stats, strategy, json_path, algorithm_label);
        std::cout << "wrote " << json_path << "\n";
    }

    return 0;
}
