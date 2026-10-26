#include "game/kuhn.hpp"
#include "solver/best_response.hpp"
#include "solver/cfr.hpp"

#include <chrono>
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
              << " [--iterations N] [--print-strategies] [--json PATH]\n";
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
                const std::string& path)
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
    out << "  \"algorithm\": \"vanilla_cfr\",\n";
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

    poker::solver::KuhnCfrTrainer trainer;
    const auto start = std::chrono::steady_clock::now();
    trainer.solve(iterations);
    const auto end = std::chrono::steady_clock::now();

    const auto strategy = trainer.average_strategy();
    auto stats = trainer.evaluate();
    stats.iterations = iterations;
    stats.runtime_seconds = std::chrono::duration<double>(end - start).count();
    stats.memory_bytes_estimate = poker::solver::KuhnCfrTrainer::table_memory_bytes();

    std::cout << std::setprecision(12);
    std::cout << "algorithm: vanilla CFR\n";
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
        write_json(stats, strategy, json_path);
        std::cout << "wrote " << json_path << "\n";
    }

    return 0;
}
