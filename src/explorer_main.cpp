#include "game/river_game.hpp"
#include "game/street_game.hpp"
#include "poker/card.hpp"
#include "poker/range.hpp"
#include "solver/river_batch.hpp"
#include "solver/street_batch.hpp"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
using socket_t = SOCKET;
static constexpr socket_t kInvalidSocket = INVALID_SOCKET;
static void close_socket(socket_t socket)
{
    closesocket(socket);
}
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
using socket_t = int;
static constexpr socket_t kInvalidSocket = -1;
static void close_socket(socket_t socket)
{
    ::close(socket);
}
#endif

namespace
{

std::mutex g_mu;
std::thread g_worker;
std::atomic<bool> g_running{false};
std::atomic<bool> g_cancel{false};
std::string g_status = "{\"running\":false}";
std::string g_ui_root = "ui";

void append_escaped(std::string& out, const std::string& text)
{
    out.push_back('"');
    for (char character : text)
    {
        if (character == '"' || character == '\\')
        {
            out.push_back('\\');
            out.push_back(character);
        }
        else if (character == '\n')
        {
            out += "\\n";
        }
        else
        {
            out.push_back(character);
        }
    }
    out.push_back('"');
}

std::string format_number(double value)
{
    std::ostringstream stream;
    stream.setf(std::ios::fmtflags(0), std::ios::floatfield);
    stream.precision(12);
    stream << value;
    return stream.str();
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
    while (cursor < text.size() && std::isspace(static_cast<unsigned char>(text[cursor])))
    {
        ++cursor;
    }
    return cursor;
}

std::string read_string(const std::string& text, const char* key, const std::string& fallback)
{
    const std::size_t at = find_key(text, key);
    if (at == std::string::npos)
    {
        return fallback;
    }
    const std::size_t cursor = value_at(text, at);
    if (cursor >= text.size() || text[cursor] != '"')
    {
        throw std::invalid_argument(std::string(key) + " must be a string");
    }
    std::string value;
    for (std::size_t i = cursor + 1; i < text.size(); ++i)
    {
        if (text[i] == '\\' && i + 1 < text.size())
        {
            value.push_back(text[i + 1]);
            ++i;
            continue;
        }
        if (text[i] == '"')
        {
            return value;
        }
        value.push_back(text[i]);
    }
    throw std::invalid_argument(std::string(key) + " is missing an end quote");
}

double read_number(const std::string& text, const char* key, double fallback)
{
    const std::size_t at = find_key(text, key);
    if (at == std::string::npos)
    {
        return fallback;
    }
    const std::size_t cursor = value_at(text, at);
    return std::atof(text.c_str() + cursor);
}

std::vector<double> read_number_array(const std::string& text, const char* key)
{
    std::vector<double> values;
    const std::size_t at = find_key(text, key);
    if (at == std::string::npos)
    {
        return values;
    }
    const std::size_t start = text.find('[', value_at(text, at));
    const std::size_t end = text.find(']', start);
    if (start == std::string::npos || end == std::string::npos)
    {
        throw std::invalid_argument(std::string(key) + " must be an array");
    }
    const std::string body = text.substr(start + 1, end - start - 1);
    std::size_t cursor = 0;
    while (cursor < body.size())
    {
        while (cursor < body.size() && (std::isspace(static_cast<unsigned char>(body[cursor])) || body[cursor] == ','))
        {
            ++cursor;
        }
        if (cursor >= body.size())
        {
            break;
        }
        values.push_back(std::atof(body.c_str() + cursor));
        while (cursor < body.size() && body[cursor] != ',')
        {
            ++cursor;
        }
    }
    return values;
}

std::vector<std::string> read_string_array(const std::string& text, const char* key)
{
    std::vector<std::string> values;
    const std::size_t at = find_key(text, key);
    if (at == std::string::npos)
    {
        return values;
    }
    const std::size_t start = text.find('[', value_at(text, at));
    const std::size_t end = text.find(']', start);
    if (start == std::string::npos || end == std::string::npos)
    {
        throw std::invalid_argument(std::string(key) + " must be an array");
    }
    std::string current;
    bool inside = false;
    for (std::size_t i = start + 1; i < end; ++i)
    {
        const char character = text[i];
        if (character == '"')
        {
            if (inside)
            {
                values.push_back(current);
                current.clear();
            }
            inside = !inside;
            continue;
        }
        if (inside)
        {
            current.push_back(character);
        }
    }
    return values;
}

struct Job
{
    std::vector<int> board;
    int pot = 100;
    int stack = 200;
    poker::holdem::Range oop{};
    poker::holdem::Range ip{};
    std::vector<double> oop_bets{};
    std::vector<double> ip_bets{};
    std::vector<double> oop_raises{};
    std::vector<double> ip_raises{};
    std::vector<double> oop_flop_bets{};
    std::vector<double> oop_turn_bets{};
    std::vector<double> oop_river_bets{};
    std::vector<double> ip_flop_bets{};
    std::vector<double> ip_turn_bets{};
    std::vector<double> ip_river_bets{};
    std::vector<double> oop_donk{};
    std::vector<double> oop_raise_multiples{};
    std::vector<double> ip_raise_multiples{};
    double pot_cap = 0.0;
    bool allow_three_bet = true;
    bool allow_all_in = true;
    bool geometric = false;
    bool frozen = false;
    double all_in_threshold = 0.0;
    double accuracy = -1.0;
    int max_raises = 2;
    int iterations = 200;
    int samples = 5;
    poker::solver::Algorithm algorithm = poker::solver::Algorithm::CfrPlus;
};

std::vector<double> optional_sizes(const std::string& text, const char* key)
{
    if (find_key(text, key) == std::string::npos)
    {
        return {};
    }
    return read_number_array(text, key);
}

Job parse_job(const std::string& text)
{
    Job job;
    const std::vector<std::string> board = read_string_array(text, "board");
    const std::vector<std::string> cards = board.empty()
        ? std::vector<std::string>{"Ah", "Kd", "7c", "4s", "2h"}
        : board;
    if (cards.size() < 3 || cards.size() > 5)
    {
        throw std::invalid_argument("board must contain 3, 4, or 5 cards");
    }
    for (const std::string& card : cards)
    {
        job.board.push_back(poker::holdem::parse_card(card));
    }
    job.pot = static_cast<int>(read_number(text, "pot", 100));
    job.stack = static_cast<int>(read_number(text, "stack", 200));
    job.oop = poker::holdem::Range::parse(read_string(text, "oop_range", "AA"));
    job.ip = poker::holdem::Range::parse(read_string(text, "ip_range", "KK"));
    job.oop_bets = read_number_array(text, "oop_bets");
    job.ip_bets = read_number_array(text, "ip_bets");
    if (job.oop_bets.empty())
    {
        job.oop_bets = {0.5, 1.0};
    }
    if (job.ip_bets.empty())
    {
        job.ip_bets = {0.5, 1.0};
    }
    job.oop_raises = optional_sizes(text, "oop_raises");
    job.ip_raises = optional_sizes(text, "ip_raises");
    if (job.oop_raises.empty())
    {
        job.oop_raises = job.oop_bets;
    }
    if (job.ip_raises.empty())
    {
        job.ip_raises = job.ip_bets;
    }
    job.oop_flop_bets = optional_sizes(text, "oop_flop_bets");
    job.oop_turn_bets = optional_sizes(text, "oop_turn_bets");
    job.oop_river_bets = optional_sizes(text, "oop_river_bets");
    job.ip_flop_bets = optional_sizes(text, "ip_flop_bets");
    job.ip_turn_bets = optional_sizes(text, "ip_turn_bets");
    job.ip_river_bets = optional_sizes(text, "ip_river_bets");
    job.oop_donk = optional_sizes(text, "oop_donk");
    job.oop_raise_multiples = optional_sizes(text, "oop_raise_multiples");
    job.ip_raise_multiples = optional_sizes(text, "ip_raise_multiples");
    job.pot_cap = read_number(text, "pot_cap", 0);
    job.allow_three_bet = read_number(text, "allow_three_bet", 1) != 0.0;
    job.allow_all_in = read_number(text, "allow_all_in", 1) != 0.0;
    job.geometric = read_number(text, "geometric", 0) != 0.0;
    job.frozen = read_number(text, "frozen", 0) != 0.0;
    job.all_in_threshold = read_number(text, "all_in_threshold", 0);
    job.accuracy = read_number(text, "accuracy", -1);
    job.max_raises = static_cast<int>(read_number(text, "max_raises", 2));
    job.iterations = static_cast<int>(read_number(text, "iterations", 200));
    job.samples = static_cast<int>(read_number(text, "samples", 5));
    const std::string algorithm = read_string(text, "algorithm", "cfr_plus");
    if (algorithm == "vanilla" || algorithm == "vanilla_cfr")
    {
        job.algorithm = poker::solver::Algorithm::VanillaCfr;
    }
    else if (algorithm == "cfr_plus" || algorithm == "cfr+")
    {
        job.algorithm = poker::solver::Algorithm::CfrPlus;
    }
    else
    {
        throw std::invalid_argument("unknown algorithm");
    }
    if (job.iterations <= 0)
    {
        throw std::invalid_argument("iterations must be positive");
    }
    if (job.frozen && job.board.size() == 5)
    {
        throw std::invalid_argument("the frozen pass is for a flop or a turn");
    }
    if (job.samples < 1)
    {
        job.samples = 1;
    }
    if (job.samples > 20)
    {
        job.samples = 20;
    }
    return job;
}

const char* spot_name(const Job& job)
{
    if (job.board.size() == 3)
    {
        return "flop";
    }
    if (job.board.size() == 4)
    {
        return "turn";
    }
    return "river";
}

const char* plays_name(const Job& job)
{
    if (job.board.size() == 3)
    {
        return "flop, turn, and river";
    }
    if (job.board.size() == 4)
    {
        return "turn and river";
    }
    return "river";
}

int rank_index(char rank)
{
    const char* order = "AKQJT98765432";
    for (int i = 0; i < 13; ++i)
    {
        if (order[i] == rank)
        {
            return i;
        }
    }
    return -1;
}

std::string cell_name(int row, int column)
{
    const char* ranks = "AKQJT98765432";
    if (row == column)
    {
        return std::string(2, ranks[row]);
    }
    const int high = std::min(row, column);
    const int low = std::max(row, column);
    std::string name;
    name.push_back(ranks[high]);
    name.push_back(ranks[low]);
    name.push_back(row < column ? 's' : 'o');
    return name;
}

struct HandLine
{
    std::string combo;
    std::string player;
    std::vector<std::pair<std::string, double>> actions;
};

void publish(const std::string& json)
{
    std::lock_guard<std::mutex> lock(g_mu);
    g_status = json;
}

std::string build_status(
    bool running,
    bool cancelled,
    const Job& job,
    int iterations_done,
    double runtime_seconds,
    double value,
    double gap,
    const std::vector<int>& sample_iterations,
    const std::vector<double>& sample_values,
    const std::vector<double>& sample_gaps,
    const std::vector<poker::solver::RiverStrategyEntry>& entries,
    const std::string& error)
{
    std::string out = "{\"running\":";
    out += running ? "true" : "false";
    out += ",\"cancelled\":";
    out += cancelled ? "true" : "false";
    out += ",\"error\":";
    append_escaped(out, error);
    out += ",\"pot\":";
    out += std::to_string(job.pot);
    out += ",\"stack\":";
    out += std::to_string(job.stack);
    out += ",\"spot\":";
    append_escaped(out, spot_name(job));
    out += ",\"plays\":";
    append_escaped(out, plays_name(job));
    out += ",\"iterations\":";
    out += std::to_string(iterations_done);
    out += ",\"runtime_seconds\":";
    out += format_number(runtime_seconds);
    out += ",\"player0_expected_utility\":";
    out += format_number(value);
    out += ",\"nash_gap\":";
    out += format_number(gap);
    out += ",\"algorithm\":";
    append_escaped(out, poker::solver::algorithm_name(job.algorithm));
    out += ",\"board\":[";
    for (std::size_t i = 0; i < job.board.size(); ++i)
    {
        if (i > 0)
        {
            out += ',';
        }
        append_escaped(out, poker::holdem::format_card(job.board[i]));
    }
    out += "],\"gap_series\":[";
    for (std::size_t i = 0; i < sample_gaps.size(); ++i)
    {
        if (i > 0)
        {
            out += ',';
        }
        out += "{\"iterations\":";
        out += std::to_string(sample_iterations[i]);
        out += ",\"value\":";
        out += format_number(sample_values[i]);
        out += ",\"nash_gap\":";
        out += format_number(sample_gaps[i]);
        out += '}';
    }
    out += "],\"paths\":[";
    std::vector<std::string> paths;
    for (const poker::solver::RiverStrategyEntry& entry : entries)
    {
        const std::size_t bar = entry.infoset.find(" | ");
        const std::string path = bar == std::string::npos ? entry.infoset : entry.infoset.substr(bar + 3);
        bool seen = false;
        for (const std::string& item : paths)
        {
            if (item == path)
            {
                seen = true;
                break;
            }
        }
        if (!seen)
        {
            paths.push_back(path);
        }
    }
    for (std::size_t i = 0; i < paths.size(); ++i)
    {
        if (i > 0)
        {
            out += ',';
        }
        append_escaped(out, paths[i]);
    }
    out += "],\"entries\":[";
    for (std::size_t i = 0; i < entries.size(); ++i)
    {
        if (i > 0)
        {
            out += ',';
        }
        out += "{\"infoset\":";
        append_escaped(out, entries[i].infoset);
        out += ",\"action\":";
        append_escaped(out, entries[i].action);
        out += ",\"probability\":";
        out += format_number(entries[i].probability);
        out += '}';
    }
    out += ']';

    int range_count[2][13][13] = {};
    auto count_range = [&](const poker::holdem::Range& range, int player)
    {
        for (int combo = 0; combo < 1326; ++combo)
        {
            if (range.weight(combo) <= 0.0)
            {
                continue;
            }
            int left = 0;
            int right = 0;
            poker::holdem::Range::combo_cards(combo, left, right);
            bool blocked = false;
            for (int card : job.board)
            {
                if (card == left || card == right)
                {
                    blocked = true;
                }
            }
            if (blocked)
            {
                continue;
            }
            const std::string text = poker::holdem::Range::combo_text(combo);
            const int high = rank_index(text[0]);
            const int low = rank_index(text[2]);
            if (high < 0 || low < 0)
            {
                continue;
            }
            const bool suited = text[1] == text[3];
            if (text[0] == text[2])
            {
                range_count[player][high][low] += 1;
            }
            else if (suited)
            {
                range_count[player][high][low] += 1;
            }
            else
            {
                range_count[player][low][high] += 1;
            }
        }
    };
    count_range(job.oop, 0);
    count_range(job.ip, 1);

    std::vector<HandLine> open_lines;
    for (std::size_t i = 0; i < entries.size();)
    {
        const std::string& infoset = entries[i].infoset;
        std::size_t j = i;
        while (j < entries.size() && entries[j].infoset == infoset)
        {
            ++j;
        }
        const std::size_t bar = infoset.find(" | ");
        const std::string path = bar == std::string::npos ? "" : infoset.substr(bar + 3);
        const bool root_open = path == "open" || path == "flop | open" || path == "turn | open";
        if (root_open && infoset.size() >= 8)
        {
            HandLine line;
            line.player = infoset.substr(0, 3);
            line.combo = infoset.substr(4, 4);
            for (std::size_t k = i; k < j; ++k)
            {
                line.actions.emplace_back(entries[k].action, entries[k].probability);
            }
            open_lines.push_back(std::move(line));
        }
        i = j;
    }

    auto write_matrix = [&](const char* name, const char* player)
    {
        out += ",\"";
        out += name;
        out += "\":[";
        bool first_cell = true;
        const int player_index = player[0] == 'O' ? 0 : 1;
        for (int row = 0; row < 13; ++row)
        {
            for (int column = 0; column < 13; ++column)
            {
                std::vector<const HandLine*> hands;
                double bet = 0.0;
                int bet_count = 0;
                for (const HandLine& line : open_lines)
                {
                    if (line.player != player || line.combo.size() != 4)
                    {
                        continue;
                    }
                    const int high = rank_index(line.combo[0]);
                    const int low = rank_index(line.combo[2]);
                    const bool suited = line.combo[1] == line.combo[3];
                    int cell_row = high;
                    int cell_col = low;
                    if (high == low)
                    {
                        cell_row = high;
                        cell_col = low;
                    }
                    else if (suited)
                    {
                        cell_row = std::min(high, low);
                        cell_col = std::max(high, low);
                    }
                    else
                    {
                        cell_row = std::max(high, low);
                        cell_col = std::min(high, low);
                    }
                    if (cell_row != row || cell_col != column)
                    {
                        continue;
                    }
                    hands.push_back(&line);
                    double aggressive = 0.0;
                    for (const auto& action : line.actions)
                    {
                        if (action.first.rfind("Bet", 0) == 0 || action.first.rfind("Raise", 0) == 0)
                        {
                            aggressive += action.second;
                        }
                    }
                    bet += aggressive;
                    ++bet_count;
                }
                if (hands.empty() && range_count[player_index][row][column] == 0)
                {
                    continue;
                }
                if (!first_cell)
                {
                    out += ',';
                }
                first_cell = false;
                out += "{\"row\":";
                out += std::to_string(row);
                out += ",\"col\":";
                out += std::to_string(column);
                out += ",\"text\":";
                append_escaped(out, cell_name(row, column));
                out += ",\"range_combos\":";
                out += std::to_string(range_count[player_index][row][column]);
                out += ",\"bet\":";
                out += format_number(bet_count == 0 ? 0.0 : bet / static_cast<double>(bet_count));
                out += ",\"hands\":[";
                for (std::size_t h = 0; h < hands.size(); ++h)
                {
                    if (h > 0)
                    {
                        out += ',';
                    }
                    out += "{\"combo\":";
                    append_escaped(out, hands[h]->combo);
                    out += ",\"actions\":[";
                    for (std::size_t a = 0; a < hands[h]->actions.size(); ++a)
                    {
                        if (a > 0)
                        {
                            out += ',';
                        }
                        out += "{\"action\":";
                        append_escaped(out, hands[h]->actions[a].first);
                        out += ",\"probability\":";
                        out += format_number(hands[h]->actions[a].second);
                        out += '}';
                    }
                    out += "]}";
                }
                out += "]}";
            }
        }
        out += ']';
    };
    write_matrix("oop_matrix", "OOP");
    write_matrix("ip_matrix", "IP ");
    out += '}';
    return out;
}

poker::river::RiverConfig river_config(const Job& job)
{
    poker::river::RiverConfig config;
    for (int i = 0; i < 5; ++i)
    {
        config.board[static_cast<std::size_t>(i)] = job.board[static_cast<std::size_t>(i)];
    }
    config.pot = job.pot;
    config.stack = job.stack;
    config.oop = job.oop;
    config.ip = job.ip;
    config.oop_bet_sizes = job.oop_bets;
    config.ip_bet_sizes = job.ip_bets;
    config.oop_raise_sizes = job.oop_raises;
    config.ip_raise_sizes = job.ip_raises;
    config.allow_all_in = job.allow_all_in;
    config.max_raises = job.max_raises;
    return config;
}

poker::streets::StreetConfig street_config(const Job& job)
{
    poker::streets::StreetConfig config;
    config.board = job.board;
    config.pot = job.pot;
    config.stack = job.stack;
    config.oop = job.oop;
    config.ip = job.ip;
    config.oop_bet_sizes = job.oop_bets;
    config.ip_bet_sizes = job.ip_bets;
    config.oop_raise_sizes = job.oop_raises;
    config.ip_raise_sizes = job.ip_raises;
    config.oop_flop_bets = job.oop_flop_bets;
    config.oop_turn_bets = job.oop_turn_bets;
    config.oop_river_bets = job.oop_river_bets;
    config.ip_flop_bets = job.ip_flop_bets;
    config.ip_turn_bets = job.ip_turn_bets;
    config.ip_river_bets = job.ip_river_bets;
    config.oop_donk_sizes = job.oop_donk;
    config.oop_raise_multiples = job.oop_raise_multiples;
    config.ip_raise_multiples = job.ip_raise_multiples;
    config.pot_cap = job.pot_cap;
    config.allow_three_bet = job.allow_three_bet;
    config.allow_all_in = job.allow_all_in;
    config.geometric = job.geometric;
    config.all_in_threshold = job.all_in_threshold;
    config.max_raises = job.max_raises;
    return config;
}

std::vector<poker::solver::RiverStrategyEntry> street_entries(
    const std::vector<poker::solver::StreetStrategyEntry>& source)
{
    std::vector<poker::solver::RiverStrategyEntry> entries;
    entries.reserve(source.size());
    for (const poker::solver::StreetStrategyEntry& item : source)
    {
        poker::solver::RiverStrategyEntry entry;
        entry.infoset = item.infoset;
        entry.action = item.action;
        entry.probability = item.probability;
        entries.push_back(std::move(entry));
    }
    return entries;
}

void solve_job(Job job)
{
    std::vector<int> sample_iterations;
    std::vector<double> sample_values;
    std::vector<double> sample_gaps;
    std::vector<poker::solver::RiverStrategyEntry> entries;
    double value = 0.0;
    double gap = 0.0;
    int done = 0;
    bool cancelled = false;
    const auto started = std::chrono::steady_clock::now();
    try
    {
        const int chunk = std::max(1, job.iterations / job.samples);
        auto record = [&]()
        {
            const double seconds = std::chrono::duration<double>(
                std::chrono::steady_clock::now() - started).count();
            publish(build_status(
                true, false, job, done, seconds, value, gap,
                sample_iterations, sample_values, sample_gaps, entries, ""));
        };
        if (job.board.size() == 5)
        {
            poker::solver::RiverBatchSolver batch(river_config(job));
            while (done < job.iterations)
            {
                if (g_cancel.load())
                {
                    cancelled = true;
                    break;
                }
                const int step = std::min(chunk, job.iterations - done);
                batch.continue_iterations(step, job.algorithm);
                done += step;
                value = batch.expected_utility();
                gap = batch.nash_gap();
                sample_iterations.push_back(done);
                sample_values.push_back(value);
                sample_gaps.push_back(gap);
                record();
                if (job.accuracy >= 0.0 && gap <= job.accuracy * static_cast<double>(job.pot))
                {
                    break;
                }
            }
            entries = batch.average_strategy_entries();
            if (done > 0)
            {
                value = batch.expected_utility();
                gap = batch.nash_gap();
            }
        }
        else
        {
            poker::solver::StreetBatchSolver batch(street_config(job));
            while (done < job.iterations)
            {
                if (g_cancel.load())
                {
                    cancelled = true;
                    break;
                }
                const int step = std::min(chunk, job.iterations - done);
                if (job.frozen)
                {
                    batch.continue_frozen_iterations(step, job.algorithm);
                }
                else
                {
                    batch.continue_iterations(step, job.algorithm);
                }
                done += step;
                value = batch.expected_utility();
                gap = batch.nash_gap();
                sample_iterations.push_back(done);
                sample_values.push_back(value);
                sample_gaps.push_back(gap);
                record();
                if (job.accuracy >= 0.0 && gap <= job.accuracy * static_cast<double>(job.pot))
                {
                    break;
                }
            }
            entries = street_entries(batch.average_strategy_entries());
            if (done > 0)
            {
                value = batch.expected_utility();
                gap = batch.nash_gap();
            }
        }
    }
    catch (const std::exception& error)
    {
        const double seconds = std::chrono::duration<double>(
            std::chrono::steady_clock::now() - started).count();
        publish(build_status(
            false, cancelled, job, done, seconds, value, gap,
            sample_iterations, sample_values, sample_gaps, entries, error.what()));
        g_running = false;
        return;
    }
    const double seconds = std::chrono::duration<double>(
        std::chrono::steady_clock::now() - started).count();
    publish(build_status(
        false, cancelled, job, done, seconds, value, gap,
        sample_iterations, sample_values, sample_gaps, entries, ""));
    g_running = false;
}

std::string read_file(const std::string& path)
{
    std::ifstream input(path, std::ios::binary);
    if (!input)
    {
        return {};
    }
    std::ostringstream buffer;
    buffer << input.rdbuf();
    return buffer.str();
}

std::string content_type(const std::string& path)
{
    if (path.size() >= 5 && path.substr(path.size() - 5) == ".html")
    {
        return "text/html; charset=utf-8";
    }
    if (path.size() >= 4 && path.substr(path.size() - 4) == ".css")
    {
        return "text/css; charset=utf-8";
    }
    if (path.size() >= 3 && path.substr(path.size() - 3) == ".js")
    {
        return "text/javascript; charset=utf-8";
    }
    return "application/octet-stream";
}

void send_response(socket_t client, int status, const std::string& type, const std::string& body)
{
    const char* reason = status == 200 ? "OK" : status == 202 ? "Accepted" : status == 409 ? "Conflict" : "Bad Request";
    std::string header = "HTTP/1.1 " + std::to_string(status) + " " + reason + "\r\n";
    header += "Content-Type: " + type + "\r\n";
    header += "Content-Length: " + std::to_string(body.size()) + "\r\n";
    header += "Cache-Control: no-store\r\n";
    header += "Connection: close\r\n\r\n";
    header += body;
    std::size_t sent = 0;
    while (sent < header.size())
    {
        const int wrote = send(
            client,
            header.data() + sent,
            static_cast<int>(header.size() - sent),
            0);
        if (wrote <= 0)
        {
            break;
        }
        sent += static_cast<std::size_t>(wrote);
    }
}

std::string receive_request(socket_t client)
{
    std::string request;
    char buffer[4096];
    while (request.find("\r\n\r\n") == std::string::npos)
    {
        const int got = recv(client, buffer, static_cast<int>(sizeof(buffer)), 0);
        if (got <= 0)
        {
            break;
        }
        request.append(buffer, buffer + got);
        if (request.size() > 2000000)
        {
            break;
        }
    }
    const std::size_t header_end = request.find("\r\n\r\n");
    if (header_end == std::string::npos)
    {
        return request;
    }
    const std::string header = request.substr(0, header_end);
    std::size_t length = 0;
    const std::size_t marker = header.find("Content-Length:");
    if (marker != std::string::npos)
    {
        length = static_cast<std::size_t>(std::atoi(header.c_str() + marker + 15));
    }
    while (request.size() < header_end + 4 + length)
    {
        const int got = recv(client, buffer, static_cast<int>(sizeof(buffer)), 0);
        if (got <= 0)
        {
            break;
        }
        request.append(buffer, buffer + got);
    }
    return request;
}

void handle_client(socket_t client)
{
    const std::string request = receive_request(client);
    const std::size_t line_end = request.find("\r\n");
    if (line_end == std::string::npos)
    {
        send_response(client, 400, "text/plain", "bad request");
        return;
    }
    const std::string line = request.substr(0, line_end);
    const std::size_t body_at = request.find("\r\n\r\n");
    const std::string body = body_at == std::string::npos ? std::string() : request.substr(body_at + 4);

    if (line.rfind("GET /api/status", 0) == 0)
    {
        std::string status;
        {
            std::lock_guard<std::mutex> lock(g_mu);
            status = g_status;
        }
        send_response(client, 200, "application/json", status);
        return;
    }
    if (line.rfind("POST /api/stop", 0) == 0)
    {
        g_cancel = true;
        send_response(client, 200, "application/json", "{\"stopping\":true}");
        return;
    }
    if (line.rfind("POST /api/solve", 0) == 0)
    {
        if (g_running.load())
        {
            send_response(client, 409, "application/json", "{\"error\":\"a solve is already running\"}");
            return;
        }
        try
        {
            Job job = parse_job(body);
            if (g_worker.joinable())
            {
                g_worker.join();
            }
            g_cancel = false;
            g_running = true;
            publish(build_status(true, false, job, 0, 0.0, 0.0, 0.0, {}, {}, {}, {}, ""));
            g_worker = std::thread(solve_job, std::move(job));
            send_response(client, 202, "application/json", "{\"running\":true}");
        }
        catch (const std::exception& error)
        {
            std::string payload = "{\"error\":";
            append_escaped(payload, error.what());
            payload += "}";
            send_response(client, 400, "application/json", payload);
        }
        return;
    }

    std::string path = "/index.html";
    if (line.rfind("GET /app.css", 0) == 0)
    {
        path = "/app.css";
    }
    else if (line.rfind("GET /app.js", 0) == 0)
    {
        path = "/app.js";
    }
    else if (line.rfind("GET / ", 0) == 0 || line.rfind("GET /index.html", 0) == 0)
    {
        path = "/index.html";
    }
    else if (line.rfind("GET /", 0) == 0)
    {
        send_response(client, 400, "text/plain", "not found");
        return;
    }
    else
    {
        send_response(client, 400, "text/plain", "not found");
        return;
    }
    const std::string file = read_file(g_ui_root + path);
    if (file.empty())
    {
        send_response(client, 400, "text/plain", "missing " + path);
        return;
    }
    send_response(client, 200, content_type(path), file);
}

std::string executable_directory()
{
#ifdef _WIN32
    char buffer[1024];
    const DWORD length = GetModuleFileNameA(nullptr, buffer, static_cast<DWORD>(sizeof(buffer)));
    std::string path(buffer, buffer + length);
    const std::size_t slash = path.find_last_of("\\/");
    if (slash == std::string::npos)
    {
        return ".";
    }
    return path.substr(0, slash);
#else
    return ".";
#endif
}

void choose_ui_root()
{
    const std::string exe = executable_directory();
    const std::string candidates[] = {
        "ui",
        exe + "\\ui",
        exe + "\\..\\..\\ui",
        exe + "/ui",
        exe + "/../../ui"};
    for (const std::string& candidate : candidates)
    {
        std::ifstream probe(candidate + "/index.html");
        if (probe)
        {
            g_ui_root = candidate;
            return;
        }
    }
}

} // namespace

int main(int argc, char** argv)
{
    int port = 8765;
    for (int i = 1; i < argc; ++i)
    {
        const std::string arg = argv[i];
        if (arg == "--port" && i + 1 < argc)
        {
            port = std::atoi(argv[++i]);
        }
    }
    choose_ui_root();

#ifdef _WIN32
    WSADATA data;
    if (WSAStartup(MAKEWORD(2, 2), &data) != 0)
    {
        std::cerr << "winsock startup failed\n";
        return 1;
    }
#endif

    const socket_t server = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (server == kInvalidSocket)
    {
        std::cerr << "socket failed\n";
        return 1;
    }
    int reuse = 1;
    setsockopt(server, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&reuse), sizeof(reuse));
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(static_cast<unsigned short>(port));
    inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
    if (bind(server, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0)
    {
        std::cerr << "bind failed on 127.0.0.1:" << port << "\n";
        close_socket(server);
        return 1;
    }
    if (listen(server, 8) != 0)
    {
        std::cerr << "listen failed\n";
        close_socket(server);
        return 1;
    }
    std::cout << "explorer http://127.0.0.1:" << port << "\n";
    std::cout << "ui " << g_ui_root << "\n";
    std::cout.flush();

    while (true)
    {
        const socket_t client = accept(server, nullptr, nullptr);
        if (client == kInvalidSocket)
        {
            continue;
        }
        handle_client(client);
        close_socket(client);
    }
}
