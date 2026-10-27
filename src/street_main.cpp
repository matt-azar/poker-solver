#include "game/street_game.hpp"
#include "poker/card.hpp"
#include "poker/range.hpp"
#include "solver/trainer.hpp"

#include <cstdlib>
#include <iostream>
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
              << " [--geometric] [--all-in-threshold 0.4]"
              << " [--all-in | --no-all-in] [--max-raises N]"
              << " [--iterations N] [--algorithm vanilla|cfr_plus]"
              << " [--accuracy 0.05]\n";
}

std::vector<double> parse_sizes(const std::string& text)
{
    std::vector<double> sizes;
    std::size_t start = 0;
    while (start < text.size())
    {
        const std::size_t comma = text.find(',', start);
        const std::string piece = text.substr(
            start, comma == std::string::npos ? std::string::npos : comma - start);
        if (!piece.empty())
        {
            sizes.push_back(std::atof(piece.c_str()));
        }
        if (comma == std::string::npos)
        {
            break;
        }
        start = comma + 1;
    }
    return sizes;
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
                config.oop_bet_sizes = parse_sizes(need("--oop-bets"));
            }
            else if (arg == "--ip-bets")
            {
                config.ip_bet_sizes = parse_sizes(need("--ip-bets"));
            }
            else if (arg == "--oop-flop-bets")
            {
                config.oop_flop_bets = parse_sizes(need("--oop-flop-bets"));
            }
            else if (arg == "--oop-turn-bets")
            {
                config.oop_turn_bets = parse_sizes(need("--oop-turn-bets"));
            }
            else if (arg == "--oop-river-bets")
            {
                config.oop_river_bets = parse_sizes(need("--oop-river-bets"));
            }
            else if (arg == "--ip-flop-bets")
            {
                config.ip_flop_bets = parse_sizes(need("--ip-flop-bets"));
            }
            else if (arg == "--ip-turn-bets")
            {
                config.ip_turn_bets = parse_sizes(need("--ip-turn-bets"));
            }
            else if (arg == "--ip-river-bets")
            {
                config.ip_river_bets = parse_sizes(need("--ip-river-bets"));
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

        if (config.oop_raise_sizes.empty())
        {
            config.oop_raise_sizes = config.oop_bet_sizes;
        }
        if (config.ip_raise_sizes.empty())
        {
            config.ip_raise_sizes = config.ip_bet_sizes;
        }

        const poker::streets::StreetGame game(config);
        poker::solver::SolveConfig solve_config;
        solve_config.max_iterations = iterations;
        if (accuracy >= 0.0)
        {
            solve_config.nash_gap_threshold = accuracy * static_cast<double>(config.pot);
            solve_config.eval_interval = 20;
        }
        poker::solver::CfrTrainer<poker::streets::StreetGame> trainer(game, algorithm);
        const poker::solver::SolveStats stats = trainer.solve(solve_config);

        std::cout.setf(std::ios::fmtflags(0), std::ios::floatfield);
        std::cout.precision(12);
        std::cout << "game: " << (config.board.size() == 3 ? "flop" : "turn") << "\n";
        std::cout << "board: " << board_text(config.board) << "\n";
        std::cout << "algorithm: " << poker::solver::algorithm_name(algorithm) << "\n";
        std::cout << "pot: " << config.pot << "\n";
        std::cout << "stack: " << config.stack << "\n";
        std::cout << "deals: " << game.deal_count() << "\n";
        std::cout << "infosets: " << game.infoset_count() << "\n";
        std::cout << "decision_nodes: " << game.decision_node_count() << "\n";
        std::cout << "terminals: " << game.terminal_count() << "\n";
        std::cout << "iterations: " << stats.iterations << "\n";
        std::cout << "runtime_seconds: " << stats.runtime_seconds << "\n";
        std::cout << "memory_bytes_estimate: " << stats.memory_bytes_estimate << "\n";
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
