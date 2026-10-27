#include "game/street_game.hpp"
#include "poker/card.hpp"
#include "poker/range.hpp"
#include "solver/street_batch.hpp"
#include "solver/trainer.hpp"

#include <cctype>
#include <cerrno>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace
{

void print_usage(const char* argv0)
{
    std::cerr << "Usage: " << argv0
              << " [--board Ah,Kd,7c,4s] [--pot N] [--stack N]"
              << " [--oop-range TEXT] [--ip-range TEXT]"
              << " [--oop-bets 0.5,1] [--ip-bets 0.5,1]"
              << " [--oop-turn-bets 0.5] [--oop-river-bets 1]"
              << " [--ip-turn-bets 0.5] [--ip-river-bets 1]"
              << " [--oop-donk 0.5,20c] [--pot-cap 1] [--no-three-bet]"
              << " [--geometric] [--all-in-threshold 0.4]"
              << " [--all-in | --no-all-in] [--max-raises N]"
              << " [--iterations N] [--algorithm vanilla|cfr_plus]"
              << " [--accuracy 0.05] [--memory-mib N] [--reference] [--frozen]\n";
}

std::string trim_copy(const std::string& text)
{
    std::size_t begin = 0;
    while (begin < text.size() && std::isspace(static_cast<unsigned char>(text[begin])))
    {
        ++begin;
    }
    std::size_t end = text.size();
    while (end > begin && std::isspace(static_cast<unsigned char>(text[end - 1])))
    {
        --end;
    }
    return text.substr(begin, end - begin);
}

void parse_sizes(const std::string& text, std::vector<double>& fractions, std::vector<double>* multiples)
{
    std::size_t start = 0;
    while (start < text.size())
    {
        const std::size_t comma = text.find(',', start);
        const std::string piece = trim_copy(text.substr(
            start, comma == std::string::npos ? std::string::npos : comma - start));
        if (!piece.empty())
        {
            const char last = piece[piece.size() - 1];
            if (last == 'x' || last == 'X')
            {
                if (multiples == nullptr)
                {
                    throw std::invalid_argument("a bet size cannot be a multiple; put 3x on a raise list");
                }
                multiples->push_back(std::atof(piece.c_str()));
            }
            else if (last == 'c' || last == 'C')
            {
                const int chips = std::atoi(piece.c_str());
                if (chips <= 0)
                {
                    throw std::invalid_argument("a fixed size must be a positive chip amount");
                }
                fractions.push_back(-static_cast<double>(chips));
            }
            else
            {
                fractions.push_back(std::atof(piece.c_str()));
            }
        }
        if (comma == std::string::npos)
        {
            break;
        }
        start = comma + 1;
    }
}

std::vector<int> parse_board(const std::string& text)
{
    std::vector<int> board;
    std::string current;
    for (char character : text)
    {
        if (character == ',' || character == ' ')
        {
            if (!current.empty())
            {
                board.push_back(poker::holdem::parse_card(current));
                current.clear();
            }
        }
        else
        {
            current.push_back(character);
        }
    }
    if (!current.empty())
    {
        board.push_back(poker::holdem::parse_card(current));
    }
    return board;
}

std::string board_text(const std::vector<int>& board)
{
    std::string text;
    for (std::size_t i = 0; i < board.size(); ++i)
    {
        if (i > 0)
        {
            text += ' ';
        }
        text += poker::holdem::format_card(board[i]);
    }
    return text;
}

} // namespace

int main(int argc, char** argv)
{
    try
    {
        poker::streets::StreetConfig config;
        config.board = parse_board("Kh,Kd,7c,4s");
        config.pot = 100;
        config.stack = 100;
        config.oop = poker::holdem::Range::parse("AhAd");
        config.ip = poker::holdem::Range::parse("2c3d");
        config.oop_bet_sizes = {1.0};
        config.allow_all_in = false;
        config.max_raises = 1;
        int iterations = 400;
        double accuracy = -1.0;
        bool reference = false;
        bool frozen = false;
        poker::solver::Algorithm algorithm = poker::solver::Algorithm::CfrPlus;

        for (int i = 1; i < argc; ++i)
        {
            const std::string arg = argv[i];
            const auto need = [&](const char* name) -> const char*
            {
                if (i + 1 >= argc)
                {
                    throw std::invalid_argument(std::string("missing value for ") + name);
                }
                return argv[++i];
            };
            if (arg == "--board")
            {
                config.board = parse_board(need("--board"));
            }
            else if (arg == "--pot")
            {
                config.pot = std::atoi(need("--pot"));
            }
            else if (arg == "--stack")
            {
                config.stack = std::atoi(need("--stack"));
            }
            else if (arg == "--oop-range")
            {
                config.oop = poker::holdem::Range::parse(need("--oop-range"));
            }
            else if (arg == "--ip-range")
            {
                config.ip = poker::holdem::Range::parse(need("--ip-range"));
            }
            else if (arg == "--oop-bets")
            {
                config.oop_bet_sizes.clear();
                parse_sizes(need("--oop-bets"), config.oop_bet_sizes, nullptr);
            }
            else if (arg == "--ip-bets")
            {
                config.ip_bet_sizes.clear();
                parse_sizes(need("--ip-bets"), config.ip_bet_sizes, nullptr);
            }
            else if (arg == "--oop-raises")
            {
                config.oop_raise_sizes.clear();
                config.oop_raise_multiples.clear();
                parse_sizes(need("--oop-raises"), config.oop_raise_sizes, &config.oop_raise_multiples);
            }
            else if (arg == "--ip-raises")
            {
                config.ip_raise_sizes.clear();
                config.ip_raise_multiples.clear();
                parse_sizes(need("--ip-raises"), config.ip_raise_sizes, &config.ip_raise_multiples);
            }
            else if (arg == "--oop-donk")
            {
                config.oop_donk_sizes.clear();
                parse_sizes(need("--oop-donk"), config.oop_donk_sizes, nullptr);
            }
            else if (arg == "--oop-flop-bets")
            {
                config.oop_flop_bets.clear();
                parse_sizes(need("--oop-flop-bets"), config.oop_flop_bets, nullptr);
            }
            else if (arg == "--oop-turn-bets")
            {
                config.oop_turn_bets.clear();
                parse_sizes(need("--oop-turn-bets"), config.oop_turn_bets, nullptr);
            }
            else if (arg == "--oop-river-bets")
            {
                config.oop_river_bets.clear();
                parse_sizes(need("--oop-river-bets"), config.oop_river_bets, nullptr);
            }
            else if (arg == "--ip-flop-bets")
            {
                config.ip_flop_bets.clear();
                parse_sizes(need("--ip-flop-bets"), config.ip_flop_bets, nullptr);
            }
            else if (arg == "--ip-turn-bets")
            {
                config.ip_turn_bets.clear();
                parse_sizes(need("--ip-turn-bets"), config.ip_turn_bets, nullptr);
            }
            else if (arg == "--ip-river-bets")
            {
                config.ip_river_bets.clear();
                parse_sizes(need("--ip-river-bets"), config.ip_river_bets, nullptr);
            }
            else if (arg == "--pot-cap")
            {
                config.pot_cap = std::atof(need("--pot-cap"));
            }
            else if (arg == "--no-three-bet")
            {
                config.allow_three_bet = false;
            }
            else if (arg == "--geometric")
            {
                config.geometric = true;
            }
            else if (arg == "--all-in-threshold")
            {
                config.all_in_threshold = std::atof(need("--all-in-threshold"));
            }
            else if (arg == "--accuracy")
            {
                accuracy = std::atof(need("--accuracy"));
            }
            else if (arg == "--reference")
            {
                reference = true;
            }
            else if (arg == "--frozen")
            {
                frozen = true;
            }
            else if (arg == "--all-in")
            {
                config.allow_all_in = true;
            }
            else if (arg == "--no-all-in")
            {
                config.allow_all_in = false;
            }
            else if (arg == "--max-raises")
            {
                config.max_raises = std::atoi(need("--max-raises"));
            }
            else if (arg == "--iterations")
            {
                iterations = std::atoi(need("--iterations"));
            }
            else if (arg == "--memory-mib")
            {
                const std::string text = need("--memory-mib");
                if (text.empty() || text.find_first_not_of("0123456789") != std::string::npos)
                {
                    throw std::invalid_argument(
                        "memory-mib must be a positive integer number of mebibytes");
                }
                errno = 0;
                char* end = nullptr;
                const unsigned long long value = std::strtoull(text.c_str(), &end, 10);
                if (end != text.c_str() + text.size() || errno == ERANGE || value == 0
                    || value > static_cast<unsigned long long>(std::numeric_limits<int>::max()))
                {
                    throw std::invalid_argument(
                        "memory-mib must be a positive integer number of mebibytes");
                }
                config.memory_mib = static_cast<int>(value);
            }
            else if (arg == "--algorithm")
            {
                const std::string name = need("--algorithm");
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
                    throw std::invalid_argument("unknown algorithm");
                }
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

        if (config.oop_raise_sizes.empty() && config.oop_raise_multiples.empty())
        {
            config.oop_raise_sizes = config.oop_bet_sizes;
        }
        if (config.ip_raise_sizes.empty() && config.ip_raise_multiples.empty())
        {
            config.ip_raise_sizes = config.ip_bet_sizes;
        }

        poker::solver::SolveConfig solve_config;
        solve_config.max_iterations = iterations;
        if (accuracy >= 0.0)
        {
            solve_config.nash_gap_threshold = accuracy * static_cast<double>(config.pot);
            solve_config.eval_interval = 20;
        }
        poker::solver::SolveStats stats;
        std::uint64_t deals = 0;
        std::uint64_t infosets = 0;
        std::uint64_t decision_nodes = 0;
        std::uint64_t terminals = 0;
        int public_decisions = 0;
        poker::solver::StreetMemoryReport memory;
        const char* solver_name = "public";
        if (reference)
        {
            const poker::streets::StreetGame game(config);
            poker::solver::CfrTrainer<poker::streets::StreetGame> trainer(game, algorithm);
            stats = trainer.solve(solve_config);
            deals = game.deal_count();
            infosets = game.infoset_count();
            decision_nodes = game.decision_node_count();
            terminals = game.terminal_count();
            solver_name = "reference";
        }
        else
        {
            poker::solver::StreetBatchSolver solver(config);
            stats = frozen ? solver.solve_frozen(solve_config, algorithm)
                           : solver.solve(solve_config, algorithm);
            if (frozen)
            {
                solver_name = "frozen";
            }
            deals = solver.deal_count();
            infosets = solver.infoset_count();
            decision_nodes = solver.decision_node_count();
            terminals = solver.terminal_count();
            public_decisions = solver.public_decisions();
            memory = solver.memory_report();
        }

        std::cout.setf(std::ios::fmtflags(0), std::ios::floatfield);
        std::cout.precision(12);
        std::cout << "game: " << (config.board.size() == 3 ? "flop" : "turn") << "\n";
        std::cout << "solver: " << solver_name << "\n";
        std::cout << "board: " << board_text(config.board) << "\n";
        std::cout << "algorithm: " << poker::solver::algorithm_name(algorithm) << "\n";
        std::cout << "pot: " << config.pot << "\n";
        std::cout << "stack: " << config.stack << "\n";
        std::cout << "deals: " << deals << "\n";
        std::cout << "infosets: " << infosets << "\n";
        if (public_decisions > 0)
        {
            std::cout << "public_decisions: " << public_decisions << "\n";
        }
        std::cout << "decision_nodes: " << decision_nodes << "\n";
        std::cout << "terminals: " << terminals << "\n";
        std::cout << "iterations: " << stats.iterations << "\n";
        std::cout << "runtime_seconds: " << stats.runtime_seconds << "\n";
        if (!reference)
        {
            std::cout << "construction_seconds: " << memory.construction_seconds << "\n";
            std::cout << "train_seconds: " << memory.train_seconds << "\n";
            std::cout << "evaluation_seconds: " << memory.evaluation_seconds << "\n";
            std::cout << "total_seconds: "
                      << (memory.construction_seconds + memory.train_seconds
                          + memory.evaluation_seconds)
                      << "\n";
            std::cout << "memory_budget_bytes: " << memory.memory_budget_bytes << "\n";
            std::cout << "allocated_bytes: " << memory.allocated_bytes << "\n";
            std::cout << "peak_allocated_bytes: " << memory.peak_allocated_bytes << "\n";
            std::cout << "estimated_peak_bytes: " << memory.estimated_peak_bytes << "\n";
            std::cout << "regret_strategy_sum_bytes: " << memory.regret_strategy_sum_bytes << "\n";
            std::cout << "process_peak_working_set_bytes: "
                      << memory.process_peak_working_set_bytes << "\n";
            for (const poker::solver::StreetMemoryComponent& component : memory.components)
            {
                std::cout << "memory_component " << component.name << " " << component.bytes << "\n";
            }
        }
        std::cout << "player0_expected_utility: " << stats.p1_expected_utility << "\n";
        std::cout << "player0_best_response_utility: " << stats.p1_best_response_utility << "\n";
        std::cout << "player1_best_response_utility: " << stats.p2_best_response_utility << "\n";
        std::cout << "nash_gap: " << stats.nash_gap << "\n";
        std::cout << "nash_gap_fraction_of_pot: "
                  << stats.nash_gap / static_cast<double>(config.pot) << "\n";
        std::cout << "deterministic: yes (runouts enumerated; no RNG)\n";
        std::cout << "abstraction: fixed bet sizes, not every legal chip amount\n";
    }
    catch (const std::exception& error)
    {
        std::cerr << error.what() << "\n";
        return 2;
    }
    return 0;
}
