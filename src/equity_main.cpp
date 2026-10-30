#include "poker/equity.hpp"

#include <charconv>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <string>
#include <string_view>

namespace
{

int fail(poker::holdem::EquityFailure failure, const std::string& message)
{
    std::cerr << message << "\n";
    if (failure == poker::holdem::EquityFailure::InvalidWeight)
    {
        return 2;
    }
    if (failure == poker::holdem::EquityFailure::WorkLimit)
    {
        return 3;
    }
    if (failure == poker::holdem::EquityFailure::Cancelled)
    {
        return 4;
    }
    if (failure == poker::holdem::EquityFailure::NumericalRange)
    {
        return 5;
    }
    return 1;
}

bool parse_u64(std::string_view text, std::uint64_t& value)
{
    const char* begin = text.data();
    const char* end = begin + text.size();
    const auto parsed = std::from_chars(begin, end, value);
    return parsed.ec == std::errc{} && parsed.ptr == end;
}

void print_text(const poker::holdem::ShowdownEquity& equity, double elapsed_seconds)
{
    std::cout << "model: " << poker::holdem::kEquityModel << "\n";
    std::cout << "units: " << poker::holdem::kEquityUnits << "\n";
    std::cout << "joint_defined: " << (equity.joint_defined ? "true" : "false") << "\n";
    std::cout << "legal_pairs: " << equity.work.legal_pairs << "\n";
    std::cout << "completions_per_pair: " << equity.work.completions_per_pair << "\n";
    std::cout << "pair_runouts: " << equity.work.pair_runouts << "\n";
    std::cout << "elapsed_seconds: " << elapsed_seconds << "\n";
    const poker::holdem::PlayerShowdown* players[2] = {&equity.player0, &equity.player1};
    for (int player = 0; player < 2; ++player)
    {
        std::cout << "player" << player << " equity: ";
        if (!players[player]->defined)
        {
            std::cout << "undefined\n";
        }
        else
        {
            std::cout << players[player]->equity << "\n";
        }
        for (const poker::holdem::ComboShowdown& row : players[player]->combos)
        {
            std::cout << "  " << row.combo << " weight " << row.input_weight << " ";
            if (!row.defined)
            {
                std::cout << "undefined\n";
            }
            else
            {
                std::cout << "equity " << row.equity << " marginal " << row.marginal << "\n";
            }
        }
    }
}

} // namespace

int main(int argc, char** argv)
{
    std::string_view board_text;
    std::string_view oop_text;
    std::string_view ip_text;
    std::uint64_t max_pair_runouts = poker::holdem::kDefaultMaxPairRunouts;
    if (const char* env_limit = std::getenv("POKER_EQUITY_MAX_PAIR_RUNOUTS"))
    {
        if (!parse_u64(env_limit, max_pair_runouts))
        {
            return fail(
                poker::holdem::EquityFailure::InvalidInput,
                "invalid equity input: POKER_EQUITY_MAX_PAIR_RUNOUTS needs an integer");
        }
    }
    bool json = false;
    for (int i = 1; i < argc; ++i)
    {
        const std::string_view arg = argv[i];
        auto take = [&](std::string_view& slot) {
            if (i + 1 >= argc)
            {
                return false;
            }
            slot = argv[++i];
            return true;
        };
        if (arg == "--json")
        {
            json = true;
        }
        else if (arg == "--board")
        {
            if (!take(board_text))
            {
                return fail(poker::holdem::EquityFailure::InvalidInput, "invalid equity input: missing --board value");
            }
        }
        else if (arg == "--oop")
        {
            if (!take(oop_text))
            {
                return fail(poker::holdem::EquityFailure::InvalidInput, "invalid equity input: missing --oop value");
            }
        }
        else if (arg == "--ip")
        {
            if (!take(ip_text))
            {
                return fail(poker::holdem::EquityFailure::InvalidInput, "invalid equity input: missing --ip value");
            }
        }
        else if (arg == "--max-pair-runouts")
        {
            if (i + 1 >= argc || !parse_u64(argv[++i], max_pair_runouts))
            {
                return fail(
                    poker::holdem::EquityFailure::InvalidInput,
                    "invalid equity input: --max-pair-runouts needs an integer");
            }
        }
        else
        {
            return fail(poker::holdem::EquityFailure::InvalidInput, "invalid equity input: unknown argument");
        }
    }
    if (board_text.empty() || oop_text.empty() || ip_text.empty())
    {
        return fail(
            poker::holdem::EquityFailure::InvalidInput,
            "invalid equity input: require --board, --oop, and --ip");
    }

    try
    {
        const std::vector<int> board = poker::holdem::parse_equity_board(board_text);
        const poker::holdem::Range oop = poker::holdem::parse_equity_range(oop_text);
        const poker::holdem::Range ip = poker::holdem::parse_equity_range(ip_text);
        poker::holdem::ShowdownEquityOptions options;
        options.max_pair_runouts = max_pair_runouts;
        const auto started = std::chrono::steady_clock::now();
        const poker::holdem::ShowdownEquity equity = poker::holdem::showdown_equity(board, oop, ip, options);
        const double elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
        if (json)
        {
            std::cout << poker::holdem::showdown_equity_json(equity, board, elapsed) << "\n";
        }
        else
        {
            print_text(equity, elapsed);
        }
    }
    catch (const poker::holdem::EquityError& error)
    {
        return fail(error.failure(), error.what());
    }
    return 0;
}
