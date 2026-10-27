#include "game/river_game.hpp"
#include "poker/card.hpp"
#include "poker/range.hpp"
#include "solver/trainer.hpp"

#include <array>
#include <cstdlib>
#include <fstream>
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
              << " [--config file.json]"
              << " [--board Ah,Kd,7c,4s,2h] [--pot N] [--stack N]"
              << " [--oop-range TEXT] [--ip-range TEXT]"
              << " [--oop-bets 0.5,1] [--ip-bets 0.5,1]"
              << " [--oop-raises 1] [--ip-raises 1]"
              << " [--all-in | --no-all-in] [--max-raises N]"
              << " [--first oop|ip]"
              << " [--iterations N] [--algorithm vanilla|cfr_plus]"
              << " [--gap-threshold X] [--eval-interval N]"
              << " [--print-strategies]\n";
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

std::array<int, 5> parse_board(const std::string& text)
{
    std::vector<std::string> tokens;
    std::string current;
    for (char character : text)
    {
        if (character == ',' || character == ' ')
        {
            if (!current.empty())
            {
                tokens.push_back(current);
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
        tokens.push_back(current);
    }
    if (tokens.size() != 5)
    {
        throw std::invalid_argument("board must contain five cards");
    }
    std::array<int, 5> board{};
    for (int i = 0; i < 5; ++i)
    {
        board[static_cast<std::size_t>(i)] = poker::holdem::parse_card(tokens[static_cast<std::size_t>(i)]);
    }
    return board;
}

std::string read_file(const std::string& path)
{
    std::ifstream input(path);
    if (!input)
    {
        throw std::runtime_error("cannot read config " + path);
    }
    std::ostringstream buffer;
    buffer << input.rdbuf();
    return buffer.str();
}

std::size_t find_key(const std::string& text, const char* key)
{
    return text.find(std::string("\"") + key + "\"");
}

std::size_t value_at(const std::string& text, std::size_t key_at)
{
    const std::size_t colon = text.find(':', key_at);
    if (colon == std::string::npos)
    {
        throw std::invalid_argument("config key is missing a value");
    }
    std::size_t cursor = colon + 1;
    while (cursor < text.size() && (text[cursor] == ' ' || text[cursor] == '\n' || text[cursor] == '\t'))
    {
        ++cursor;
    }
    return cursor;
}

bool read_string(const std::string& text, const char* key, std::string& out)
{
    const std::size_t key_at = find_key(text, key);
    if (key_at == std::string::npos)
    {
        return false;
    }
    const std::size_t cursor = value_at(text, key_at);
    if (cursor >= text.size() || text[cursor] != '"')
    {
        throw std::invalid_argument(std::string("config value for ") + key + " must be a string");
    }
    const std::size_t end = text.find('"', cursor + 1);
    if (end == std::string::npos)
    {
        throw std::invalid_argument("unterminated config string");
    }
    out = text.substr(cursor + 1, end - cursor - 1);
    return true;
}

bool read_number(const std::string& text, const char* key, double& out)
{
    const std::size_t key_at = find_key(text, key);
    if (key_at == std::string::npos)
    {
        return false;
    }
    const std::size_t cursor = value_at(text, key_at);
    try
    {
        std::size_t consumed = 0;
        out = std::stod(text.substr(cursor), &consumed);
    }
    catch (const std::exception&)
    {
        throw std::invalid_argument(std::string("bad number for ") + key);
    }
    return true;
}

bool read_bool(const std::string& text, const char* key, bool& out)
{
    const std::size_t key_at = find_key(text, key);
    if (key_at == std::string::npos)
    {
        return false;
    }
    const std::size_t cursor = value_at(text, key_at);
    if (text.compare(cursor, 4, "true") == 0)
    {
        out = true;
        return true;
    }
    if (text.compare(cursor, 5, "false") == 0)
    {
        out = false;
        return true;
    }
    throw std::invalid_argument(std::string("bad boolean for ") + key);
}

bool read_numbers(const std::string& text, const char* key, std::vector<double>& out)
{
    const std::size_t key_at = find_key(text, key);
    if (key_at == std::string::npos)
    {
        return false;
    }
    const std::size_t cursor = value_at(text, key_at);
    if (cursor >= text.size() || text[cursor] != '[')
    {
        throw std::invalid_argument(std::string(key) + " must be an array");
    }
    const std::size_t end = text.find(']', cursor);
    if (end == std::string::npos)
    {
        throw std::invalid_argument("unterminated config array");
    }
    out = parse_sizes(text.substr(cursor + 1, end - cursor - 1));
    return true;
}

bool read_board(const std::string& text, std::array<int, 5>& board)
{
    const std::size_t key_at = find_key(text, "board");
    if (key_at == std::string::npos)
    {
        return false;
    }
    const std::size_t cursor = value_at(text, key_at);
    if (cursor >= text.size() || text[cursor] != '[')
    {
        throw std::invalid_argument("board must be an array of five cards");
    }
    const std::size_t end = text.find(']', cursor);
    if (end == std::string::npos)
    {
        throw std::invalid_argument("unterminated board array");
    }
    std::string body = text.substr(cursor + 1, end - cursor - 1);
    for (char& character : body)
    {
        if (character == '"')
        {
            character = ' ';
        }
    }
    board = parse_board(body);
    return true;
}

struct Options
{
    poker::river::RiverConfig config;
    int iterations = 500;
    double gap_threshold = -1.0;
    int eval_interval = 1000;
    bool print_strategies = false;
    bool have_oop_raises = false;
    bool have_ip_raises = false;
    poker::solver::Algorithm algorithm = poker::solver::Algorithm::CfrPlus;
};

Options defaults()
{
    Options options;
    options.config.board = parse_board("Ah,Kd,7c,4s,2h");
    options.config.pot = 100;
    options.config.stack = 200;
    options.config.oop = poker::holdem::Range::parse("AA");
    options.config.ip = poker::holdem::Range::parse("KK");
    options.config.oop_bet_sizes = {0.5, 1.0};
    options.config.ip_bet_sizes = {0.5, 1.0};
    options.config.allow_all_in = true;
    options.config.max_raises = 2;
    return options;
}

void apply_config_text(const std::string& text, Options& options)
{
    std::string value;
    if (read_board(text, options.config.board))
    {
    }
    double number = 0.0;
    if (read_number(text, "pot", number))
    {
        options.config.pot = static_cast<int>(number);
    }
    if (read_number(text, "effective_stack", number) || read_number(text, "stack", number))
    {
        options.config.stack = static_cast<int>(number);
    }
    if (read_string(text, "oop_range", value))
    {
        options.config.oop = poker::holdem::Range::parse(value);
    }
    if (read_string(text, "ip_range", value))
    {
        options.config.ip = poker::holdem::Range::parse(value);
    }
    read_numbers(text, "oop_bet_sizes", options.config.oop_bet_sizes);
    read_numbers(text, "ip_bet_sizes", options.config.ip_bet_sizes);
    if (read_numbers(text, "oop_raise_sizes", options.config.oop_raise_sizes))
    {
        options.have_oop_raises = true;
    }
    if (read_numbers(text, "ip_raise_sizes", options.config.ip_raise_sizes))
    {
        options.have_ip_raises = true;
    }
    read_bool(text, "allow_all_in", options.config.allow_all_in);
    if (read_number(text, "max_raises", number))
    {
        options.config.max_raises = static_cast<int>(number);
    }
    if (read_string(text, "first_to_act", value))
    {
        if (value == "oop")
        {
            options.config.first_to_act = 0;
        }
        else if (value == "ip")
        {
            options.config.first_to_act = 1;
        }
        else
        {
            throw std::invalid_argument("first_to_act must be oop or ip");
        }
    }
    if (read_string(text, "algorithm", value))
    {
        if (value == "vanilla" || value == "vanilla_cfr")
        {
            options.algorithm = poker::solver::Algorithm::VanillaCfr;
        }
        else if (value == "cfr_plus" || value == "cfr+")
        {
            options.algorithm = poker::solver::Algorithm::CfrPlus;
        }
        else
        {
            throw std::invalid_argument("unknown algorithm");
        }
    }
    if (read_number(text, "iterations", number))
    {
        options.iterations = static_cast<int>(number);
    }
    if (read_number(text, "gap_threshold", number))
    {
        options.gap_threshold = number;
    }
    if (read_number(text, "eval_interval", number))
    {
        options.eval_interval = static_cast<int>(number);
    }
}

std::string board_text(const std::array<int, 5>& board)
{
    std::string text;
    for (int i = 0; i < 5; ++i)
    {
        if (i > 0)
        {
            text += ' ';
        }
        text += poker::holdem::format_card(board[static_cast<std::size_t>(i)]);
    }
    return text;
}

} // namespace

int main(int argc, char** argv)
{
    try
    {
        Options options = defaults();
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
            if (arg == "--config")
            {
                apply_config_text(read_file(need("--config")), options);
            }
            else if (arg == "--board")
            {
                options.config.board = parse_board(need("--board"));
            }
            else if (arg == "--pot")
            {
                options.config.pot = std::atoi(need("--pot"));
            }
            else if (arg == "--stack")
            {
                options.config.stack = std::atoi(need("--stack"));
            }
            else if (arg == "--oop-range")
            {
                options.config.oop = poker::holdem::Range::parse(need("--oop-range"));
            }
            else if (arg == "--ip-range")
            {
                options.config.ip = poker::holdem::Range::parse(need("--ip-range"));
            }
            else if (arg == "--oop-bets")
            {
                options.config.oop_bet_sizes = parse_sizes(need("--oop-bets"));
            }
            else if (arg == "--ip-bets")
            {
                options.config.ip_bet_sizes = parse_sizes(need("--ip-bets"));
            }
            else if (arg == "--oop-raises")
            {
                options.config.oop_raise_sizes = parse_sizes(need("--oop-raises"));
                options.have_oop_raises = true;
            }
            else if (arg == "--ip-raises")
            {
                options.config.ip_raise_sizes = parse_sizes(need("--ip-raises"));
                options.have_ip_raises = true;
            }
            else if (arg == "--all-in")
            {
                options.config.allow_all_in = true;
            }
            else if (arg == "--no-all-in")
            {
                options.config.allow_all_in = false;
            }
            else if (arg == "--max-raises")
            {
                options.config.max_raises = std::atoi(need("--max-raises"));
            }
            else if (arg == "--first")
            {
                const std::string who = need("--first");
                if (who == "oop")
                {
                    options.config.first_to_act = 0;
                }
                else if (who == "ip")
                {
                    options.config.first_to_act = 1;
                }
                else
                {
                    throw std::invalid_argument("first player must be oop or ip");
                }
            }
            else if (arg == "--iterations")
            {
                options.iterations = std::atoi(need("--iterations"));
            }
            else if (arg == "--algorithm")
            {
                const std::string name = need("--algorithm");
                if (name == "vanilla" || name == "vanilla_cfr")
                {
                    options.algorithm = poker::solver::Algorithm::VanillaCfr;
                }
                else if (name == "cfr_plus" || name == "cfr+")
                {
                    options.algorithm = poker::solver::Algorithm::CfrPlus;
                }
                else
                {
                    throw std::invalid_argument("unknown algorithm");
                }
            }
            else if (arg == "--gap-threshold")
            {
                options.gap_threshold = std::atof(need("--gap-threshold"));
            }
            else if (arg == "--eval-interval")
            {
                options.eval_interval = std::atoi(need("--eval-interval"));
            }
            else if (arg == "--print-strategies")
            {
                options.print_strategies = true;
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

        if (!options.have_oop_raises)
        {
            options.config.oop_raise_sizes = options.config.oop_bet_sizes;
        }
        if (!options.have_ip_raises)
        {
            options.config.ip_raise_sizes = options.config.ip_bet_sizes;
        }
        if (options.iterations <= 0)
        {
            throw std::invalid_argument("iterations must be positive");
        }

        const poker::river::RiverGame game(options.config);
        poker::solver::SolveConfig solve_config;
        solve_config.max_iterations = options.iterations;
        solve_config.nash_gap_threshold = options.gap_threshold;
        solve_config.eval_interval = options.eval_interval;
        poker::solver::CfrTrainer<poker::river::RiverGame> trainer(game, options.algorithm);
        const poker::solver::SolveStats stats = trainer.solve(solve_config);
        const std::vector<double> strategy = trainer.average_strategy();

        std::cout.setf(std::ios::fmtflags(0), std::ios::floatfield);
        std::cout.precision(12);
        std::cout << "game: river\n";
        std::cout << "board: " << board_text(options.config.board) << "\n";
        std::cout << "algorithm: " << poker::solver::algorithm_name(options.algorithm) << "\n";
        std::cout << "pot: " << options.config.pot << "\n";
        std::cout << "stack: " << options.config.stack << "\n";
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
        std::cout << "deterministic: yes (deals enumerated; no RNG)\n";
        std::cout << "abstraction: fixed bet sizes, not every legal chip amount\n";

        if (options.print_strategies)
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
    }
    catch (const std::exception& error)
    {
        std::cerr << error.what() << "\n";
        return 2;
    }
    return 0;
}
