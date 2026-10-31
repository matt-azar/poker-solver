#include "explorer/checkpoint.hpp"
#include "explorer/range_library.hpp"
#include "explorer/recent_files.hpp"
#include "explorer/retained_training.hpp"
#include "explorer/session.hpp"
#include "explorer/templates.hpp"
#include "explorer/value_worker.hpp"
#include "game/river_config_text.hpp"
#include "game/river_game.hpp"
#include "game/street_config_text.hpp"
#include "game/street_game.hpp"
#include "poker/equity.hpp"
#include "poker/card.hpp"
#include "poker/hand_categories.hpp"
#include "poker/range.hpp"
#include "solver/node_lock.hpp"
#include "solver/river_batch.hpp"
#include "solver/street_batch.hpp"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <charconv>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <limits>
#include <fstream>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <system_error>
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

namespace explorer_detail
{

std::thread g_worker;
poker::explorer::Session g_session;
std::string g_ui_root = "ui";
// Process-wide equity work limit. Defaults to kDefaultMaxPairRunouts; overridden
// by POKER_EQUITY_MAX_PAIR_RUNOUTS or --max-pair-runouts before listen.
std::uint64_t g_equity_max_pair_runouts = poker::holdem::kDefaultMaxPairRunouts;
std::filesystem::path g_templates_root;
std::filesystem::path g_ranges_root;

// One action-value query. The accept loop only queues it. Status and node
// pages stay on the accept thread. A newer node or a new solve cancels the
// walk at the next public node. The worker is joined on server teardown.
poker::explorer::ValueWorker* g_values = nullptr;

bool parse_u64(std::string_view text, std::uint64_t& value)
{
    const char* begin = text.data();
    const char* end = begin + text.size();
    const auto parsed = std::from_chars(begin, end, value);
    return parsed.ec == std::errc{} && parsed.ptr == end;
}

poker::holdem::ShowdownEquityOptions equity_options(const std::atomic<bool>& cancel)
{
    poker::holdem::ShowdownEquityOptions options;
    options.max_pair_runouts = g_equity_max_pair_runouts;
    options.cancel_poll = [](void* context)
    {
        return static_cast<const std::atomic<bool>*>(context)->load(std::memory_order_relaxed);
    };
    options.cancel_context = const_cast<std::atomic<bool>*>(&cancel);
    return options;
}

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
                const char escaped = text[i + 1];
                if (escaped == 'n')
                {
                    value.push_back('\n');
                }
                else if (escaped == 'r')
                {
                    value.push_back('\r');
                }
                else if (escaped == 't')
                {
                    value.push_back('\t');
                }
                else
                {
                    value.push_back(escaped);
                }
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
    double time_limit = -1.0;
    int max_raises = 2;
    int iterations = 200;
    int samples = 5;
    int memory_mib = 1024;
    int threads = 1;
    poker::solver::Algorithm algorithm = poker::solver::Algorithm::CfrPlus;
};

struct HeldSolution
{
    std::uint64_t id = 0;
    std::uint64_t job_id = 0;
    // Prior unlocked (or earlier locked) revision kept queryable after resolve-locked.
    std::uint64_t baseline_solution_id = 0;
    std::shared_ptr<poker::solver::StreetBatchSolver> street;
    std::shared_ptr<poker::solver::RiverBatchSolver> river;
    std::string root_id;
    bool has_memory = false;
    poker::solver::StreetMemoryReport memory{};
    Job job;
    int iterations = 0;
    double runtime_seconds = 0.0;
    double value = 0.0;
    double p1_best_response = 0.0;
    double p2_best_response = 0.0;
    double nash_gap = 0.0;
    bool time_limit_reached = false;
    std::vector<int> sample_iterations;
    std::vector<double> sample_values;
    std::vector<double> sample_gaps;
    poker::solver::LockSet locks;
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
    const bool oop_bets_present = find_key(text, "oop_bets") != std::string::npos;
    const bool ip_bets_present = find_key(text, "ip_bets") != std::string::npos;
    job.oop_bets = read_number_array(text, "oop_bets");
    job.ip_bets = read_number_array(text, "ip_bets");
    if (!oop_bets_present)
    {
        job.oop_bets = {0.5, 1.0};
    }
    if (!ip_bets_present)
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
    const double memory_raw = read_number(text, "memory_mib", 1024);
    if (!std::isfinite(memory_raw) || memory_raw < 1.0 || memory_raw != std::floor(memory_raw)
        || memory_raw > static_cast<double>(std::numeric_limits<int>::max()))
    {
        throw std::invalid_argument(
            "memory_mib must be a positive integer number of mebibytes");
    }
    job.memory_mib = static_cast<int>(memory_raw);
    const double threads_raw = read_number(text, "threads", 1);
    if (!std::isfinite(threads_raw) || threads_raw < 1.0 || threads_raw != std::floor(threads_raw)
        || threads_raw > 64.0)
    {
        throw std::invalid_argument("threads must be a positive integer from 1 through 64");
    }
    job.threads = static_cast<int>(threads_raw);
    // Five-card boards use the same street tree as flop/turn. Frozen is
    // allowed on any board length; threads above 1 still require frozen.
    if (job.threads > 1 && !job.frozen)
    {
        throw std::invalid_argument("multiple threads require the frozen street pass");
    }
    job.all_in_threshold = read_number(text, "all_in_threshold", 0);
    job.accuracy = read_number(text, "accuracy", -1);
    if (find_key(text, "time_limit") != std::string::npos)
    {
        const double time_limit_raw = read_number(text, "time_limit", -1);
        if (!std::isfinite(time_limit_raw) || time_limit_raw < 0.0)
        {
            throw std::invalid_argument("time_limit must be a non-negative number of seconds");
        }
        job.time_limit = time_limit_raw;
    }
    else
    {
        job.time_limit = -1.0;
    }
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

struct StatusDraft
{
    bool running = false;
    bool paused = false;
    bool cancelled = false;
    bool time_limit_reached = false;
    std::string error;
    const Job* job = nullptr;
    int iterations = 0;
    bool has_runtime = false;
    double runtime_seconds = 0.0;
    bool has_value = false;
    double value = 0.0;
    bool has_br = false;
    double p1_best_response = 0.0;
    double p2_best_response = 0.0;
    bool has_gap = false;
    double nash_gap = 0.0;
    const std::vector<int>* sample_iterations = nullptr;
    const std::vector<double>* sample_values = nullptr;
    const std::vector<double>* sample_gaps = nullptr;
    std::uint64_t job_id = 0;
    std::uint64_t solution_id = 0;
    std::uint64_t baseline_solution_id = 0;
    std::uint64_t generation = 0;
    std::string root_id;
    const poker::solver::StreetMemoryReport* memory = nullptr;
    bool include_strategy = false;
    const std::vector<poker::solver::RiverStrategyEntry>* entries = nullptr;
};

void append_optional(std::string& out, bool present, double value)
{
    if (!present)
    {
        out += "null";
        return;
    }
    out += format_number(value);
}

std::string build_status(const StatusDraft& draft)
{
    const Job& job = *draft.job;
    const std::vector<int> empty_iterations;
    const std::vector<double> empty_values;
    const std::vector<poker::solver::RiverStrategyEntry> empty_entries;
    const std::vector<int>& sample_iterations = draft.sample_iterations ? *draft.sample_iterations : empty_iterations;
    const std::vector<double>& sample_values = draft.sample_values ? *draft.sample_values : empty_values;
    const std::vector<double>& sample_gaps = draft.sample_gaps ? *draft.sample_gaps : empty_values;
    const std::vector<poker::solver::RiverStrategyEntry>& entries = draft.entries ? *draft.entries : empty_entries;
    const poker::solver::StreetMemoryReport* memory = draft.memory;
    std::string out = "{\"running\":";
    out += draft.running ? "true" : "false";
    out += ",\"paused\":";
    out += draft.paused ? "true" : "false";
    out += ",\"cancelled\":";
    out += draft.cancelled ? "true" : "false";
    out += ",\"time_limit_reached\":";
    out += draft.time_limit_reached ? "true" : "false";
    out += ",\"error\":";
    append_escaped(out, draft.error);
    out += ",\"job_id\":";
    if (draft.job_id == 0)
    {
        out += "null";
    }
    else
    {
        append_escaped(out, "j" + std::to_string(draft.job_id));
    }
    out += ",\"status_generation\":";
    out += std::to_string(draft.generation);
    out += ",\"pot\":";
    out += std::to_string(job.pot);
    out += ",\"stack\":";
    out += std::to_string(job.stack);
    out += ",\"spot\":";
    append_escaped(out, spot_name(job));
    out += ",\"plays\":";
    append_escaped(out, plays_name(job));
    out += ",\"iterations\":";
    out += std::to_string(draft.iterations);
    out += ",\"iterations_requested\":";
    out += std::to_string(job.iterations);
    out += ",\"samples\":";
    out += std::to_string(job.samples);
    out += ",\"accuracy\":";
    out += format_number(job.accuracy);
    out += ",\"time_limit\":";
    if (job.time_limit < 0.0)
    {
        out += "null";
    }
    else
    {
        out += format_number(job.time_limit);
    }
    out += ",\"frozen\":";
    out += job.frozen ? "true" : "false";
    out += ",\"memory_mib\":";
    out += std::to_string(job.memory_mib);
    out += ",\"max_raises\":";
    out += std::to_string(job.max_raises);
    out += ",\"runtime_seconds\":";
    append_optional(out, draft.has_runtime, draft.runtime_seconds);
    out += ",\"player0_expected_utility\":";
    append_optional(out, draft.has_value, draft.value);
    out += ",\"p1_best_response\":";
    append_optional(out, draft.has_br, draft.p1_best_response);
    out += ",\"p2_best_response\":";
    append_optional(out, draft.has_br, draft.p2_best_response);
    out += ",\"nash_gap\":";
    append_optional(out, draft.has_gap, draft.nash_gap);
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
    out += "],\"solution_id\":";
    if (draft.solution_id == 0)
    {
        out += "null";
    }
    else
    {
        append_escaped(out, "s" + std::to_string(draft.solution_id));
    }
    out += ",\"root_node_id\":";
    if (draft.root_id.empty())
    {
        out += "null";
    }
    else
    {
        append_escaped(out, draft.root_id);
    }
    out += ",\"baseline_solution_id\":";
    if (draft.baseline_solution_id == 0)
    {
        out += "null";
    }
    else
    {
        append_escaped(out, "s" + std::to_string(draft.baseline_solution_id));
    }
    out += ",\"engine_allocated\":";
    out += memory == nullptr ? "null" : std::to_string(memory->allocated_bytes);
    out += ",\"engine_peak\":";
    out += memory == nullptr ? "null" : std::to_string(memory->peak_allocated_bytes);
    out += ",\"engine_reserved\":";
    out += memory == nullptr ? "null" : std::to_string(memory->reserved_bytes);
    out += ",\"process_rss\":";
    out += memory == nullptr ? "null" : std::to_string(memory->process_peak_working_set_bytes);
    out += ",\"cache_init_seconds\":";
    append_optional(out, memory != nullptr, memory == nullptr ? 0.0 : memory->cache_init_seconds);
    out += ",\"construction_seconds\":";
    append_optional(out, memory != nullptr, memory == nullptr ? 0.0 : memory->construction_seconds);
    out += ",\"worker_setup_seconds\":";
    append_optional(out, memory != nullptr, memory == nullptr ? 0.0 : memory->worker_setup_seconds);
    out += ",\"train_seconds\":";
    append_optional(out, memory != nullptr, memory == nullptr ? 0.0 : memory->train_seconds);
    out += ",\"evaluation_seconds\":";
    append_optional(out, memory != nullptr, memory == nullptr ? 0.0 : memory->evaluation_seconds);
    out += ",\"threads\":";
    out += std::to_string(job.threads);
    if (!draft.include_strategy)
    {
        out += '}';
        return out;
    }
    out += ",\"paths\":[";
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
    config.memory_mib = job.memory_mib;
    config.threads = job.threads;
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

bool parse_prefixed_id(std::string_view text, char prefix, std::uint64_t& id)
{
    if (text.size() < 2 || text[0] != prefix)
    {
        return false;
    }
    const char* first = text.data() + 1;
    const char* last = text.data() + text.size();
    if (*first == '+' || *first == '-')
    {
        return false;
    }
    const std::from_chars_result parsed = std::from_chars(first, last, id);
    return parsed.ec == std::errc() && parsed.ptr == last;
}

const poker::solver::LockSet* locks_arg(const HeldSolution& held)
{
    return held.locks.empty() ? nullptr : &held.locks;
}

// Public node index from explorer ids like p0.t-1.r-1 (infoset_id for street locks).
bool parse_public_node_index(std::string_view text, std::size_t& infoset_id)
{
    if (text.empty() || text[0] != 'p')
    {
        return false;
    }
    const char* first = text.data() + 1;
    const char* last = text.data() + text.size();
    if (first >= last || *first == '+' || *first == '-')
    {
        return false;
    }
    unsigned long long value = 0;
    const std::from_chars_result parsed = std::from_chars(first, last, value);
    if (parsed.ec != std::errc() || parsed.ptr == first || parsed.ptr >= last || *parsed.ptr != '.')
    {
        return false;
    }
    infoset_id = static_cast<std::size_t>(value);
    return true;
}

std::string node_id_for_infoset(std::size_t infoset_id)
{
    return "p" + std::to_string(infoset_id) + ".t-1.r-1";
}

std::string json_locks(const poker::solver::LockSet& locks)
{
    std::string out = "{\"locks\":[";
    const std::vector<std::size_t> ids = locks.infoset_ids();
    for (std::size_t i = 0; i < ids.size(); ++i)
    {
        const poker::solver::NodeLock* lock = locks.find(ids[i]);
        if (lock == nullptr)
        {
            continue;
        }
        if (i > 0)
        {
            out += ',';
        }
        out += "{\"node_id\":";
        append_escaped(out, node_id_for_infoset(lock->infoset_id));
        out += ",\"infoset_id\":";
        out += std::to_string(lock->infoset_id);
        out += ",\"kind\":";
        append_escaped(out, lock->kind == poker::solver::LockKind::FullNode ? "full" : "selected");
        out += ",\"hand_indices\":[";
        for (std::size_t h = 0; h < lock->combo_indices.size(); ++h)
        {
            if (h > 0)
            {
                out += ',';
            }
            out += std::to_string(lock->combo_indices[h]);
        }
        out += "],\"probs\":[";
        for (std::size_t a = 0; a < lock->actions.probs.size(); ++a)
        {
            if (a > 0)
            {
                out += ',';
            }
            out += format_number(lock->actions.probs[a]);
        }
        out += "]}";
    }
    out += "]}";
    return out;
}

std::shared_ptr<HeldSolution> clone_held_baseline(const HeldSolution& source)
{
    auto copy = std::make_shared<HeldSolution>();
    copy->id = source.id;
    copy->job_id = source.job_id;
    copy->baseline_solution_id = 0;
    copy->root_id = source.root_id;
    copy->has_memory = source.has_memory;
    copy->memory = source.memory;
    copy->job = source.job;
    copy->iterations = source.iterations;
    copy->runtime_seconds = source.runtime_seconds;
    copy->value = source.value;
    copy->p1_best_response = source.p1_best_response;
    copy->p2_best_response = source.p2_best_response;
    copy->nash_gap = source.nash_gap;
    copy->time_limit_reached = source.time_limit_reached;
    copy->sample_iterations = source.sample_iterations;
    copy->sample_values = source.sample_values;
    copy->sample_gaps = source.sample_gaps;
    copy->locks = source.locks;
    if (source.street)
    {
        copy->street = std::make_shared<poker::solver::StreetBatchSolver>(source.street->config());
        copy->street->install_training_tables(source.street->training_tables());
        copy->street->prepare_inspection();
        copy->root_id = copy->street->root_node_id();
        copy->memory = copy->street->memory_report();
        copy->has_memory = true;
    }
    else if (source.river)
    {
        copy->river = std::make_shared<poker::solver::RiverBatchSolver>(source.river->config());
        copy->river->install_training_tables(source.river->training_tables());
        copy->river->prepare_inspection();
        copy->root_id = copy->river->root_node_id();
    }
    else
    {
        throw std::invalid_argument("solution has no solver");
    }
    return copy;
}

std::string json_inspection(
    const poker::solver::StreetInspection& view,
    const poker::solver::StreetMemoryReport& memory,
    std::uint64_t solution_id,
    std::uint64_t job_id)
{
    std::string out = "{\"solution_id\":";
    append_escaped(out, "s" + std::to_string(solution_id));
    out += ",\"job_id\":";
    append_escaped(out, "j" + std::to_string(job_id));
    out += ",\"kind\":";
    append_escaped(out, view.kind);
    out += ",\"node_id\":";
    append_escaped(out, view.node_id);
    out += ",\"line\":";
    append_escaped(out, view.line);
    out += ",\"place\":";
    append_escaped(out, view.place);
    out += ",\"player\":";
    out += view.player < 0 ? "null" : std::to_string(view.player);
    out += ",\"folded\":";
    out += view.kind == "terminal" && view.folded >= 0 ? std::to_string(view.folded) : "null";
    out += ",\"reach_defined\":";
    out += view.reach_defined ? "true" : "false";
    out += ",\"joint\":";
    out += format_number(view.joint);
    out += ",\"board\":[";
    for (std::size_t i = 0; i < view.board.size(); ++i)
    {
        if (i > 0)
        {
            out += ',';
        }
        append_escaped(out, view.board[i]);
    }
    out += "],\"actions\":[";
    for (std::size_t i = 0; i < view.actions.size(); ++i)
    {
        if (i > 0)
        {
            out += ',';
        }
        append_escaped(out, view.actions[i].label);
    }
    out += "],\"children\":[";
    for (std::size_t i = 0; i < view.actions.size(); ++i)
    {
        if (i > 0)
        {
            out += ',';
        }
        append_escaped(out, view.actions[i].child_id);
    }
    out += "],\"combos\":[";
    for (std::size_t i = 0; i < view.hands.size(); ++i)
    {
        if (i > 0)
        {
            out += ',';
        }
        append_escaped(out, view.hands[i].combo);
    }
    out += "],\"reach\":[";
    for (std::size_t i = 0; i < view.hands.size(); ++i)
    {
        if (i > 0)
        {
            out += ',';
        }
        out += format_number(view.hands[i].reach);
    }
    out += "],\"marginal\":";
    if (!view.reach_defined)
    {
        out += "null";
    }
    else
    {
        out += '[';
        for (std::size_t i = 0; i < view.hands.size(); ++i)
        {
            if (i > 0)
            {
                out += ',';
            }
            out += format_number(view.hands[i].marginal);
        }
        out += ']';
    }
    out += ",\"structural\":[";
    for (std::size_t i = 0; i < view.hands.size(); ++i)
    {
        if (i > 0)
        {
            out += ',';
        }
        out += view.hands[i].structural ? "1" : "0";
    }
    out += "],\"strategy\":[";
    for (std::size_t i = 0; i < view.hands.size(); ++i)
    {
        if (i > 0)
        {
            out += ',';
        }
        if (!view.hands[i].structural)
        {
            out += "null";
            continue;
        }
        out += '[';
        for (std::size_t action = 0; action < view.hands[i].strategy.size(); ++action)
        {
            if (action > 0)
            {
                out += ',';
            }
            out += format_number(view.hands[i].strategy[action]);
        }
        out += ']';
    }
    out += "],\"cards\":[";
    for (std::size_t i = 0; i < view.cards.size(); ++i)
    {
        if (i > 0)
        {
            out += ',';
        }
        out += "{\"card\":";
        append_escaped(out, view.cards[i].card);
        out += ",\"child_id\":";
        append_escaped(out, view.cards[i].child_id);
        out += ",\"weight\":";
        if (view.cards[i].weight_defined)
        {
            out += format_number(view.cards[i].weight);
        }
        else
        {
            out += "null";
        }
        out += '}';
    }
    out += "],\"engine_allocated\":";
    out += std::to_string(memory.allocated_bytes);
    out += ",\"engine_peak\":";
    out += std::to_string(memory.peak_allocated_bytes);
    out += ",\"process_rss\":";
    out += std::to_string(memory.process_peak_working_set_bytes);
    out += '}';
    return out;
}

std::string value_identity(
    std::uint64_t solution_id,
    std::uint64_t job_id,
    const std::string& node_id,
    std::uint64_t generation)
{
    std::string out = "\"solution_id\":";
    append_escaped(out, "s" + std::to_string(solution_id));
    out += ",\"job_id\":";
    append_escaped(out, "j" + std::to_string(job_id));
    out += ",\"node_id\":";
    append_escaped(out, node_id);
    out += ",\"status_generation\":";
    out += std::to_string(generation);
    return out;
}

std::string json_value_pending(
    std::uint64_t solution_id,
    std::uint64_t job_id,
    const std::string& node_id,
    std::uint64_t generation)
{
    return "{\"pending\":true," + value_identity(solution_id, job_id, node_id, generation) + "}";
}

std::string json_value_error(
    const std::string& message,
    std::uint64_t solution_id,
    std::uint64_t job_id,
    const std::string& node_id,
    std::uint64_t generation)
{
    std::string out = "{\"pending\":false,\"error\":";
    append_escaped(out, message);
    out += ',';
    out += value_identity(solution_id, job_id, node_id, generation);
    out += '}';
    return out;
}

std::string json_action_values(
    const poker::solver::StreetActionValues& page,
    std::uint64_t solution_id,
    std::uint64_t job_id,
    std::uint64_t generation)
{
    const std::size_t hands = page.combos.size();
    const std::size_t actions = page.actions.size();
    std::string out = "{\"pending\":false,";
    out += value_identity(solution_id, job_id, page.node_id, generation);
    out += ",\"player\":";
    out += std::to_string(page.player);
    out += ",\"units\":";
    append_escaped(out, page.units);
    out += ",\"utility_basis\":";
    append_escaped(out, page.utility_basis);
    out += ",\"reach_defined\":";
    out += page.reach_defined ? "true" : "false";
    out += ",\"node_ev_defined\":";
    out += page.node_ev_defined ? "true" : "false";
    out += ",\"node_ev\":";
    if (page.node_ev_defined)
    {
        out += format_number(page.node_ev);
    }
    else
    {
        out += "null";
    }
    out += ",\"actions\":[";
    for (std::size_t i = 0; i < actions; ++i)
    {
        if (i > 0)
        {
            out += ',';
        }
        append_escaped(out, page.actions[i]);
    }
    out += "],\"combos\":[";
    for (std::size_t i = 0; i < hands; ++i)
    {
        if (i > 0)
        {
            out += ',';
        }
        append_escaped(out, page.combos[i]);
    }
    out += "],\"ev_defined\":[";
    for (std::size_t i = 0; i < hands; ++i)
    {
        if (i > 0)
        {
            out += ',';
        }
        const bool defined = i < page.ev_defined.size() && page.ev_defined[i] != 0;
        out += defined ? "true" : "false";
    }
    out += "],\"action_ev\":[";
    for (std::size_t hand = 0; hand < hands; ++hand)
    {
        if (hand > 0)
        {
            out += ',';
        }
        const bool defined = hand < page.ev_defined.size() && page.ev_defined[hand] != 0;
        if (!defined)
        {
            out += "null";
            continue;
        }
        out += '[';
        for (std::size_t action = 0; action < actions; ++action)
        {
            if (action > 0)
            {
                out += ',';
            }
            const std::size_t index = hand * actions + action;
            const double value = index < page.action_ev.size() ? page.action_ev[index] : 0.0;
            out += format_number(value);
        }
        out += ']';
    }
    out += "],\"value\":[";
    for (std::size_t hand = 0; hand < hands; ++hand)
    {
        if (hand > 0)
        {
            out += ',';
        }
        const bool defined = hand < page.ev_defined.size() && page.ev_defined[hand] != 0;
        if (!defined || hand >= page.mixed_ev.size())
        {
            out += "null";
        }
        else
        {
            out += format_number(page.mixed_ev[hand]);
        }
    }
    out += "],\"query_seconds\":";
    out += format_number(page.query_seconds);
    out += '}';
    return out;
}

std::string json_runout_values(
    const poker::solver::StreetRunoutValues& page,
    std::uint64_t solution_id,
    std::uint64_t job_id,
    std::uint64_t generation)
{
    std::string out = "{\"pending\":false,\"kind\":\"runout\",";
    out += value_identity(solution_id, job_id, page.node_id, generation);
    out += ",\"units\":";
    append_escaped(out, page.units);
    out += ",\"utility_basis\":";
    append_escaped(out, page.utility_basis);
    out += ",\"parent_ev_defined\":";
    out += page.parent_ev_defined ? "true" : "false";
    out += ",\"parent_oop_ev\":";
    append_optional(out, page.parent_ev_defined, page.parent_oop_ev);
    out += ",\"parent_ip_ev\":";
    append_optional(out, page.parent_ev_defined, page.parent_ip_ev);
    out += ",\"cards\":[";
    for (std::size_t index = 0; index < page.cards.size(); ++index)
    {
        const poker::solver::StreetRunoutCard& card = page.cards[index];
        if (index > 0)
        {
            out += ',';
        }
        out += "{\"card\":";
        append_escaped(out, card.card);
        out += ",\"child_id\":";
        append_escaped(out, card.child_id);
        out += ",\"probability_defined\":";
        out += card.probability_defined ? "true" : "false";
        out += ",\"probability\":";
        append_optional(out, card.probability_defined, card.probability);
        out += ",\"ev_defined\":";
        out += card.ev_defined ? "true" : "false";
        out += ",\"oop_ev\":";
        append_optional(out, card.ev_defined, card.oop_ev);
        out += ",\"ip_ev\":";
        append_optional(out, card.ev_defined, card.ip_ev);
        out += '}';
    }
    out += "],\"query_seconds\":";
    out += format_number(page.query_seconds);
    out += '}';
    return out;
}

void append_equity_distribution(
    std::string& out,
    const std::vector<poker::holdem::EquityDistributionBucket>& buckets)
{
    out += '[';
    for (std::size_t i = 0; i < buckets.size(); ++i)
    {
        if (i != 0)
        {
            out += ',';
        }
        const poker::holdem::EquityDistributionBucket& bucket = buckets[i];
        out += "{\"lo\":";
        out += format_number(bucket.lo);
        out += ",\"hi\":";
        out += format_number(bucket.hi);
        out += ",\"weight\":";
        out += format_number(bucket.weight);
        out += '}';
    }
    out += ']';
}

std::string json_node_equity(
    const poker::solver::StreetNodeEquity& page,
    std::uint64_t solution_id,
    std::uint64_t job_id,
    std::uint64_t generation,
    const std::vector<poker::holdem::EquityDistributionBucket>& oop_distribution = {},
    const std::vector<poker::holdem::EquityDistributionBucket>& ip_distribution = {})
{
    std::string out = "{\"pending\":false,\"kind\":\"equity\",";
    out += value_identity(solution_id, job_id, page.node_id, generation);
    out += ",\"units\":";
    append_escaped(out, page.units);
    out += ",\"model\":";
    append_escaped(out, page.model);
    out += ",\"defined\":";
    out += page.defined ? "true" : "false";
    out += ",\"oop_equity\":";
    append_optional(out, page.defined, page.oop_equity);
    out += ",\"ip_equity\":";
    append_optional(out, page.defined, page.ip_equity);
    // Check-down equity histogram over combos (not chip EV). Ten fixed buckets
    // on [0, 1]; weights are raw input masses. equity_distribution is OOP;
    // ip_equity_distribution is IP. Always present for stable clients.
    out += ",\"equity_distribution\":";
    append_equity_distribution(out, oop_distribution);
    out += ",\"ip_equity_distribution\":";
    append_equity_distribution(out, ip_distribution);
    out += ",\"query_seconds\":";
    out += format_number(page.query_seconds);
    out += '}';
    return out;
}

std::string json_categories(
    const poker::holdem::CategoryComposition& report,
    std::uint64_t solution_id,
    std::uint64_t job_id,
    const std::string& node_id,
    std::uint64_t generation,
    double query_seconds)
{
    // Made-hand category mass on the current board only. Draws are out of scope.
    std::string body = poker::holdem::category_composition_json(report, query_seconds);
    if (body.size() < 2 || body.front() != '{' || body.back() != '}')
    {
        throw std::logic_error("category json must be an object");
    }
    std::string out = "{\"pending\":false,";
    out += value_identity(solution_id, job_id, node_id, generation);
    out += ',';
    out.append(body.begin() + 1, body.end());
    return out;
}

void send_response(
    socket_t client,
    int status,
    const std::string& type,
    const std::string& body,
    const std::string& extra_headers);

void respond_value_query(
    socket_t client,
    std::uint64_t solution_id,
    std::uint64_t job_id,
    const std::string& node_id,
    std::chrono::steady_clock::time_point started,
    const std::string& kind)
{
    const std::uint64_t generation = g_session.generation();
    poker::explorer::ValueRequest request;
    request.solution_id = solution_id;
    request.job_id = job_id;
    request.node_id = node_id;
    request.kind = kind;
    const poker::explorer::ValueReply reply = g_values->submit(request);
    const int status = reply.ready ? (reply.ok ? 200 : 400) : 202;
    const std::string body = reply.ready
        ? reply.body
        : json_value_pending(solution_id, reply.job_id, node_id, generation);
    const double handler_seconds = std::chrono::duration<double>(
        std::chrono::steady_clock::now() - started).count();
    send_response(
        client,
        status,
        "application/json",
        body,
        "X-Query-Seconds: " + format_number(handler_seconds) + "\r\n");
}

StatusDraft draft_for(
    const Job& job,
    std::uint64_t job_id,
    int done,
    double seconds,
    bool evaluated,
    double value,
    double p1,
    double p2,
    double gap,
    const std::vector<int>& sample_iterations,
    const std::vector<double>& sample_values,
    const std::vector<double>& sample_gaps,
    const poker::solver::StreetMemoryReport* memory)
{
    StatusDraft draft;
    draft.job = &job;
    draft.job_id = job_id;
    draft.iterations = done;
    draft.has_runtime = true;
    draft.runtime_seconds = seconds;
    draft.has_value = evaluated;
    draft.value = value;
    draft.has_br = evaluated;
    draft.p1_best_response = p1;
    draft.p2_best_response = p2;
    draft.has_gap = evaluated;
    draft.nash_gap = gap;
    draft.sample_iterations = &sample_iterations;
    draft.sample_values = &sample_values;
    draft.sample_gaps = &sample_gaps;
    draft.memory = memory;
    // Only call outside Session methods that already hold mu_. install/commit
    // callbacks must build the draft first or assign generation from the
    // callback argument.
    draft.generation = g_session.generation() + 1;
    return draft;
}

void solve_job(std::uint64_t job_id, Job job)
{
    std::vector<int> sample_iterations;
    std::vector<double> sample_values;
    std::vector<double> sample_gaps;
    double value = 0.0;
    double p1 = 0.0;
    double p2 = 0.0;
    double gap = 0.0;
    int done = 0;
    bool evaluated = false;
    bool time_limit_reached = false;
    const auto started = std::chrono::steady_clock::now();
    const auto seconds_now = [&]()
    {
        return std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
    };
    const auto wall_exhausted = [&]()
    {
        return job.time_limit >= 0.0 && seconds_now() >= job.time_limit;
    };
    const auto remember = [&](double utility, double response0, double response1)
    {
        value = utility;
        p1 = response0;
        p2 = response1;
        gap = response0 + response1;
        evaluated = true;
        sample_iterations.push_back(done);
        sample_values.push_back(value);
        sample_gaps.push_back(gap);
    };
    try
    {
        if (g_session.stop_requested(job_id))
        {
            g_session.finish_cancelled(job_id, build_status(draft_for(
                job, job_id, done, seconds_now(), evaluated, value, p1, p2, gap,
                sample_iterations, sample_values, sample_gaps, nullptr)));
            return;
        }
        const int chunk = std::max(1, job.iterations / job.samples);
        // Flop, turn, and river share StreetBatchSolver. RiverBatchSolver
        // remains only for opening older river-kind PSOL checkpoints and for
        // the river_solver CLI.
        auto street = std::make_shared<poker::solver::StreetBatchSolver>(street_config(job));
        poker::solver::StreetMemoryReport street_memory = street->memory_report();
        const poker::solver::StreetMemoryReport* memory_ptr = &street_memory;
        const auto hold_current = [&]()
        {
            auto kept_solution = std::make_shared<HeldSolution>();
            kept_solution->job = job;
            kept_solution->job_id = job_id;
            kept_solution->iterations = done;
            kept_solution->runtime_seconds = seconds_now();
            kept_solution->value = value;
            kept_solution->p1_best_response = p1;
            kept_solution->p2_best_response = p2;
            kept_solution->nash_gap = gap;
            kept_solution->time_limit_reached = time_limit_reached;
            kept_solution->sample_iterations = sample_iterations;
            kept_solution->sample_values = sample_values;
            kept_solution->sample_gaps = sample_gaps;
            street->prepare_inspection();
            kept_solution->street = street;
            kept_solution->root_id = street->root_node_id();
            kept_solution->memory = street->memory_report();
            kept_solution->has_memory = true;
            street_memory = kept_solution->memory;
            return kept_solution;
        };
        const auto publish_stopped = [&]()
        {
            if (done <= 0)
            {
                StatusDraft draft = draft_for(
                    job, job_id, done, seconds_now(), evaluated, value, p1, p2, gap,
                    sample_iterations, sample_values, sample_gaps, memory_ptr);
                draft.cancelled = true;
                g_session.finish_cancelled(job_id, build_status(draft));
                return;
            }
            auto kept_solution = hold_current();
            const poker::explorer::Session::Permit kept_permit = g_session.prepare_kept(job_id);
            StatusDraft kept = draft_for(
                job, job_id, done, kept_solution->runtime_seconds, true, value, p1, p2, gap,
                kept_solution->sample_iterations, kept_solution->sample_values, kept_solution->sample_gaps,
                kept_solution->has_memory ? &kept_solution->memory : nullptr);
            kept.cancelled = true;
            if (!kept_permit.allowed)
            {
                g_session.finish_cancelled(job_id, build_status(kept));
                return;
            }
            kept_solution->id = kept_permit.solution_id;
            kept.solution_id = kept_permit.solution_id;
            kept.root_id = kept_solution->root_id;
            const bool published = g_session.commit_kept(
                job_id, kept_solution, kept_permit.solution_id, [&](std::uint64_t generation)
                {
                    StatusDraft draft = kept;
                    draft.generation = generation;
                    return build_status(draft);
                });
            if (!published && g_session.phase() == poker::explorer::Phase::Running)
            {
                StatusDraft draft = kept;
                draft.error = "failed to keep the solve";
                draft.solution_id = 0;
                draft.root_id.clear();
                g_session.finish_failed(job_id, build_status(draft));
            }
        };
        const auto publish_paused = [&]()
        {
            if (done <= 0)
            {
                return false;
            }
            auto kept_solution = hold_current();
            const poker::explorer::Session::Permit kept_permit = g_session.prepare_kept(job_id);
            StatusDraft kept = draft_for(
                job, job_id, done, kept_solution->runtime_seconds, true, value, p1, p2, gap,
                kept_solution->sample_iterations, kept_solution->sample_values, kept_solution->sample_gaps,
                kept_solution->has_memory ? &kept_solution->memory : nullptr);
            kept.paused = true;
            if (!kept_permit.allowed)
            {
                return false;
            }
            kept_solution->id = kept_permit.solution_id;
            kept.solution_id = kept_permit.solution_id;
            kept.root_id = kept_solution->root_id;
            const bool published = g_session.commit_paused(
                job_id, kept_solution, kept_permit.solution_id, [&](std::uint64_t generation)
                {
                    StatusDraft draft = kept;
                    draft.generation = generation;
                    return build_status(draft);
                });
            if (!published && g_session.phase() == poker::explorer::Phase::Running)
            {
                StatusDraft draft = kept;
                draft.error = "failed to pause the solve";
                draft.solution_id = 0;
                draft.root_id.clear();
                g_session.finish_failed(job_id, build_status(draft));
            }
            return published || g_session.phase() != poker::explorer::Phase::Running;
        };
        while (done < job.iterations)
        {
            if (g_session.stop_requested(job_id))
            {
                publish_stopped();
                return;
            }
            if (g_session.pause_requested(job_id) && done > 0)
            {
                if (publish_paused())
                {
                    return;
                }
            }
            const int step = std::min(chunk, job.iterations - done);
            // Fresh solves start with empty locks; continue_job / resolve-locked pass HeldSolution locks.
            if (job.frozen)
            {
                street->continue_frozen_iterations(step, job.algorithm, nullptr);
            }
            else
            {
                street->continue_iterations(step, job.algorithm, nullptr);
            }
            done += step;
            remember(street->expected_utility(), street->p1_best_response_utility(), street->p2_best_response_utility());
            street_memory = street->memory_report();
            if (g_session.stop_requested(job_id))
            {
                publish_stopped();
                return;
            }
            if (g_session.pause_requested(job_id))
            {
                if (publish_paused())
                {
                    return;
                }
            }
            StatusDraft progress = draft_for(
                job, job_id, done, seconds_now(), evaluated, value, p1, p2, gap,
                sample_iterations, sample_values, sample_gaps, memory_ptr);
            progress.running = true;
            progress.time_limit_reached = time_limit_reached;
            g_session.set_progress(job_id, build_status(progress));
            if (job.accuracy >= 0.0 && gap <= job.accuracy * static_cast<double>(job.pot))
            {
                break;
            }
            if (wall_exhausted())
            {
                time_limit_reached = true;
                break;
            }
        }
        if (done == 0 || g_session.stop_requested(job_id))
        {
            publish_stopped();
            return;
        }
        if (g_session.pause_requested(job_id))
        {
            if (publish_paused())
            {
                return;
            }
        }
        auto held = std::make_shared<HeldSolution>();
        held->job = job;
        held->job_id = job_id;
        held->iterations = done;
        held->runtime_seconds = seconds_now();
        held->value = value;
        held->p1_best_response = p1;
        held->p2_best_response = p2;
        held->nash_gap = gap;
        held->time_limit_reached = time_limit_reached;
        held->sample_iterations = sample_iterations;
        held->sample_values = sample_values;
        held->sample_gaps = sample_gaps;
        street->prepare_inspection();
        held->street = std::move(street);
        held->root_id = held->street->root_node_id();
        held->memory = held->street->memory_report();
        held->has_memory = true;
        street_memory = held->memory;
        if (g_session.stop_requested(job_id))
        {
            const poker::explorer::Session::Permit kept_permit = g_session.prepare_kept(job_id);
            StatusDraft kept = draft_for(
                job, job_id, done, held->runtime_seconds, true, value, p1, p2, gap,
                held->sample_iterations, held->sample_values, held->sample_gaps,
                held->has_memory ? &held->memory : nullptr);
            kept.cancelled = true;
            if (!kept_permit.allowed)
            {
                g_session.finish_cancelled(job_id, build_status(kept));
                return;
            }
            held->id = kept_permit.solution_id;
            kept.solution_id = kept_permit.solution_id;
            kept.root_id = held->root_id;
            g_session.commit_kept(job_id, held, kept_permit.solution_id, [&](std::uint64_t generation)
            {
                StatusDraft draft = kept;
                draft.generation = generation;
                return build_status(draft);
            });
            return;
        }
        if (g_session.pause_requested(job_id))
        {
            const poker::explorer::Session::Permit kept_permit = g_session.prepare_kept(job_id);
            StatusDraft kept = draft_for(
                job, job_id, done, held->runtime_seconds, true, value, p1, p2, gap,
                held->sample_iterations, held->sample_values, held->sample_gaps,
                held->has_memory ? &held->memory : nullptr);
            kept.paused = true;
            if (kept_permit.allowed)
            {
                held->id = kept_permit.solution_id;
                kept.solution_id = kept_permit.solution_id;
                kept.root_id = held->root_id;
                g_session.commit_paused(job_id, held, kept_permit.solution_id, [&](std::uint64_t generation)
                {
                    StatusDraft draft = kept;
                    draft.generation = generation;
                    return build_status(draft);
                });
                return;
            }
        }
        const poker::explorer::Session::Permit permit = g_session.prepare_success(job_id);
        if (!permit.allowed)
        {
            if (g_session.stop_requested(job_id))
            {
                const poker::explorer::Session::Permit kept_permit = g_session.prepare_kept(job_id);
                StatusDraft kept = draft_for(
                    job, job_id, done, held->runtime_seconds, true, value, p1, p2, gap,
                    held->sample_iterations, held->sample_values, held->sample_gaps,
                    held->has_memory ? &held->memory : nullptr);
                kept.cancelled = true;
                if (kept_permit.allowed)
                {
                    held->id = kept_permit.solution_id;
                    kept.solution_id = kept_permit.solution_id;
                    kept.root_id = held->root_id;
                    g_session.commit_kept(job_id, held, kept_permit.solution_id, [&](std::uint64_t generation)
                    {
                        StatusDraft draft = kept;
                        draft.generation = generation;
                        return build_status(draft);
                    });
                    return;
                }
            }
            if (g_session.pause_requested(job_id))
            {
                const poker::explorer::Session::Permit kept_permit = g_session.prepare_kept(job_id);
                StatusDraft kept = draft_for(
                    job, job_id, done, held->runtime_seconds, true, value, p1, p2, gap,
                    held->sample_iterations, held->sample_values, held->sample_gaps,
                    held->has_memory ? &held->memory : nullptr);
                kept.paused = true;
                if (kept_permit.allowed)
                {
                    held->id = kept_permit.solution_id;
                    kept.solution_id = kept_permit.solution_id;
                    kept.root_id = held->root_id;
                    g_session.commit_paused(job_id, held, kept_permit.solution_id, [&](std::uint64_t generation)
                    {
                        StatusDraft draft = kept;
                        draft.generation = generation;
                        return build_status(draft);
                    });
                    return;
                }
            }
            StatusDraft draft = draft_for(
                job, job_id, done, held->runtime_seconds, true, value, p1, p2, gap,
                sample_iterations, sample_values, sample_gaps, held->has_memory ? &held->memory : nullptr);
            draft.cancelled = true;
            g_session.finish_cancelled(job_id, build_status(draft));
            return;
        }
        held->id = permit.solution_id;
        StatusDraft success = draft_for(
            job, job_id, done, held->runtime_seconds, true, value, p1, p2, gap,
            held->sample_iterations, held->sample_values, held->sample_gaps,
            held->has_memory ? &held->memory : nullptr);
        success.solution_id = permit.solution_id;
        success.root_id = held->root_id;
        success.time_limit_reached = time_limit_reached;
        const bool published = g_session.commit_success(job_id, held, permit.solution_id, [&](std::uint64_t generation, bool accepted)
        {
            StatusDraft draft = success;
            draft.generation = generation;
            draft.cancelled = !accepted;
            if (!accepted)
            {
                draft.solution_id = 0;
                draft.root_id.clear();
            }
            return build_status(draft);
        });
        if (!published && g_session.phase() == poker::explorer::Phase::Running)
        {
            StatusDraft draft = success;
            draft.generation = g_session.generation() + 1;
            draft.error = "failed to publish the solve";
            draft.solution_id = 0;
            draft.root_id.clear();
            g_session.finish_failed(job_id, build_status(draft));
        }
    }
    catch (const std::exception& error)
    {
        StatusDraft draft = draft_for(
            job, job_id, done, seconds_now(), evaluated, value, p1, p2, gap,
            sample_iterations, sample_values, sample_gaps, nullptr);
        draft.error = error.what();
        draft.cancelled = g_session.stop_requested(job_id);
        g_session.finish_failed(job_id, build_status(draft));
    }
}

poker::explorer::TrainingSnapshot completed_snapshot(
    const HeldSolution& held,
    int done,
    double value,
    double p1,
    double p2,
    double gap)
{
    poker::explorer::TrainingSnapshot snapshot;
    snapshot.iterations = done;
    snapshot.value = value;
    snapshot.p1_best_response = p1;
    snapshot.p2_best_response = p2;
    snapshot.nash_gap = gap;
    int trained = done;
    if (held.street)
    {
        trained = held.street->completed_iterations();
    }
    else if (held.river)
    {
        trained = held.river->completed_iterations();
    }
    snapshot.iterations = trained;
    if (trained == done)
    {
        return snapshot;
    }
    try
    {
        if (held.street)
        {
            snapshot.value = held.street->expected_utility();
            snapshot.p1_best_response = held.street->p1_best_response_utility();
            snapshot.p2_best_response = held.street->p2_best_response_utility();
        }
        else if (held.river)
        {
            snapshot.value = held.river->expected_utility();
            snapshot.p1_best_response = held.river->p1_best_response_utility();
            snapshot.p2_best_response = held.river->p2_best_response_utility();
        }
        snapshot.nash_gap = snapshot.p1_best_response + snapshot.p2_best_response;
    }
    catch (const std::exception&)
    {
        snapshot.value = held.value;
        snapshot.p1_best_response = held.p1_best_response;
        snapshot.p2_best_response = held.p2_best_response;
        snapshot.nash_gap = held.nash_gap;
    }
    return snapshot;
}

poker::explorer::RetainedTraining take_retained(HeldSolution& held)
{
    poker::explorer::RetainedTraining retained;
    retained.job_id = held.job_id;
    retained.iterations = held.iterations;
    retained.runtime_seconds = held.runtime_seconds;
    retained.value = held.value;
    retained.p1_best_response = held.p1_best_response;
    retained.p2_best_response = held.p2_best_response;
    retained.nash_gap = held.nash_gap;
    retained.sample_iterations.swap(held.sample_iterations);
    retained.sample_values.swap(held.sample_values);
    retained.sample_gaps.swap(held.sample_gaps);
    return retained;
}

void store_retained(HeldSolution& held, poker::explorer::RetainedTraining& retained)
{
    held.job_id = retained.job_id;
    held.iterations = retained.iterations;
    held.runtime_seconds = retained.runtime_seconds;
    held.value = retained.value;
    held.p1_best_response = retained.p1_best_response;
    held.p2_best_response = retained.p2_best_response;
    held.nash_gap = retained.nash_gap;
    held.sample_iterations.swap(retained.sample_iterations);
    held.sample_values.swap(retained.sample_values);
    held.sample_gaps.swap(retained.sample_gaps);
}

void adopt_completed_training(
    HeldSolution& held,
    std::uint64_t job_id,
    double seconds,
    const poker::explorer::TrainingSnapshot& snapshot)
{
    const int previous = held.iterations;
    poker::explorer::RetainedTraining retained = take_retained(held);
    try
    {
        poker::explorer::remember_completed_training(retained, job_id, seconds, snapshot);
        poker::explorer::append_completed_sample(retained, snapshot);
    }
    catch (const std::bad_alloc&)
    {
    }
    store_retained(held, retained);
    if (!held.street || snapshot.iterations == previous)
    {
        return;
    }
    try
    {
        held.street->prepare_inspection();
        held.memory = held.street->memory_report();
        held.has_memory = true;
    }
    catch (const std::exception&)
    {
    }
}

void continue_job(std::uint64_t job_id, int extra, double time_limit)
{
    // Claim returns while cancelled value queries may still hold the engine.
    // Match solve: wait for quiet off the accept thread before mutating.
    g_session.wait_until_quiet();
    const std::shared_ptr<HeldSolution> held =
        std::static_pointer_cast<HeldSolution>(g_session.training_resource(job_id));
    if (!held || (!held->street && !held->river))
    {
        g_session.abort_continuation(
            job_id,
            "{\"running\":false,\"cancelled\":false,\"error\":\"missing solution\",\"solution_id\":null}");
        return;
    }
    if (time_limit >= 0.0)
    {
        held->job.time_limit = time_limit;
    }
    held->time_limit_reached = false;
    const auto started = std::chrono::steady_clock::now();
    int done = held->iterations;
    if (extra > std::numeric_limits<int>::max() - done)
    {
        StatusDraft draft = draft_for(
            held->job, job_id, done, held->runtime_seconds, true,
            held->value, held->p1_best_response, held->p2_best_response, held->nash_gap,
            held->sample_iterations, held->sample_values, held->sample_gaps,
            held->has_memory ? &held->memory : nullptr);
        draft.error = "iteration count overflow";
        draft.solution_id = held->id;
        draft.root_id = held->root_id;
        g_session.abort_continuation(job_id, build_status(draft));
        return;
    }
    const int target = done + extra;
    double value = held->value;
    double p1 = held->p1_best_response;
    double p2 = held->p2_best_response;
    double gap = held->nash_gap;
    bool time_limit_reached = false;
    const int samples = std::max(1, held->job.samples);
    const int chunk = std::max(1, extra / samples);
    const auto seconds_now = [&]()
    {
        return held->runtime_seconds
            + std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
    };
    const auto continuation_seconds = [&]()
    {
        return std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
    };
    const auto wall_exhausted = [&]()
    {
        return time_limit >= 0.0 && continuation_seconds() >= time_limit;
    };
    try
    {
        const std::size_t chunks = static_cast<std::size_t>((extra + chunk - 1) / chunk);
        held->sample_iterations.reserve(held->sample_iterations.size() + chunks);
        held->sample_values.reserve(held->sample_values.size() + chunks);
        held->sample_gaps.reserve(held->sample_gaps.size() + chunks);
        while (done < target)
        {
            if (g_session.stop_requested(job_id) || g_session.pause_requested(job_id))
            {
                break;
            }
            const int step = std::min(chunk, target - done);
            const poker::solver::LockSet* const locks = locks_arg(*held);
            if (held->street)
            {
                if (held->job.frozen)
                {
                    held->street->continue_frozen_iterations(step, held->job.algorithm, locks);
                }
                else
                {
                    held->street->continue_iterations(step, held->job.algorithm, locks);
                }
                value = held->street->expected_utility();
                p1 = held->street->p1_best_response_utility();
                p2 = held->street->p2_best_response_utility();
            }
            else
            {
                held->river->continue_iterations(step, held->job.algorithm);
                value = held->river->expected_utility();
                p1 = held->river->p1_best_response_utility();
                p2 = held->river->p2_best_response_utility();
            }
            gap = p1 + p2;
            done += step;
            held->sample_iterations.push_back(done);
            held->sample_values.push_back(value);
            held->sample_gaps.push_back(gap);
            if (g_session.stop_requested(job_id) || g_session.pause_requested(job_id))
            {
                break;
            }
            poker::solver::StreetMemoryReport memory{};
            const poker::solver::StreetMemoryReport* memory_ptr = nullptr;
            if (held->street)
            {
                memory = held->street->memory_report();
                memory_ptr = &memory;
            }
            StatusDraft progress = draft_for(
                held->job, job_id, done, seconds_now(), true, value, p1, p2, gap,
                held->sample_iterations, held->sample_values, held->sample_gaps, memory_ptr);
            progress.running = true;
            progress.solution_id = held->id;
            progress.root_id = held->root_id;
            progress.time_limit_reached = time_limit_reached;
            g_session.set_progress(job_id, build_status(progress));
            if (held->job.accuracy >= 0.0 && gap <= held->job.accuracy * static_cast<double>(held->job.pot))
            {
                break;
            }
            if (wall_exhausted())
            {
                time_limit_reached = true;
                break;
            }
        }
        const double seconds = seconds_now();
        held->iterations = done;
        held->runtime_seconds = seconds;
        held->value = value;
        held->p1_best_response = p1;
        held->p2_best_response = p2;
        held->nash_gap = gap;
        held->time_limit_reached = time_limit_reached;
        held->job_id = job_id;
        if (held->street)
        {
            held->street->prepare_inspection();
            held->memory = held->street->memory_report();
            held->has_memory = true;
        }
        else if (held->river)
        {
            held->river->prepare_inspection();
            held->root_id = held->river->root_node_id();
        }
        const bool pause_after = g_session.pause_requested(job_id) && !g_session.stop_requested(job_id);
        StatusDraft success = draft_for(
            held->job, job_id, done, seconds, true, value, p1, p2, gap,
            held->sample_iterations, held->sample_values, held->sample_gaps,
            held->has_memory ? &held->memory : nullptr);
        success.solution_id = held->id;
        success.root_id = held->root_id;
        success.baseline_solution_id = held->baseline_solution_id;
        success.paused = pause_after;
        success.time_limit_reached = time_limit_reached;
        const bool published = g_session.commit_continuation(job_id, [&](std::uint64_t generation)
        {
            StatusDraft draft = success;
            draft.generation = generation;
            return build_status(draft);
        });
        if (!published && g_session.phase() == poker::explorer::Phase::Running)
        {
            StatusDraft draft = success;
            draft.error = "failed to publish the continuation";
            g_session.abort_continuation(job_id, build_status(draft));
        }
    }
    catch (const std::exception& error)
    {
        const poker::explorer::TrainingSnapshot snapshot =
            completed_snapshot(*held, done, value, p1, p2, gap);
        adopt_completed_training(*held, job_id, seconds_now(), snapshot);
        StatusDraft draft = draft_for(
            held->job, held->job_id, held->iterations, held->runtime_seconds, true,
            held->value, held->p1_best_response, held->p2_best_response, held->nash_gap,
            held->sample_iterations, held->sample_values, held->sample_gaps,
            held->has_memory ? &held->memory : nullptr);
        draft.error = error.what();
        draft.solution_id = held->id;
        draft.root_id = held->root_id;
        draft.baseline_solution_id = held->baseline_solution_id;
        draft.time_limit_reached = held->time_limit_reached;
        g_session.abort_continuation(job_id, build_status(draft));
    }
}

// Warm-start policy for v1: reset training tables and re-solve from zero with locks.
// Retains the prior revision as Session baseline so compare/export still work.
void resolve_locked_job(
    std::uint64_t job_id,
    int iterations,
    double accuracy,
    int samples,
    double time_limit)
{
    g_session.wait_until_quiet();
    const std::shared_ptr<HeldSolution> held =
        std::static_pointer_cast<HeldSolution>(g_session.training_resource(job_id));
    if (!held || !held->street)
    {
        g_session.abort_continuation(
            job_id,
            "{\"running\":false,\"cancelled\":false,\"error\":\"resolve-locked requires a street solution\","
            "\"solution_id\":null}");
        return;
    }
    if (accuracy >= 0.0)
    {
        held->job.accuracy = accuracy;
    }
    if (samples >= 1)
    {
        held->job.samples = samples;
    }
    if (time_limit >= 0.0)
    {
        held->job.time_limit = time_limit;
    }
    held->time_limit_reached = false;
    const std::uint64_t prior_id = held->id;
    try
    {
        if (g_session.baseline_solution() == 0)
        {
            const std::shared_ptr<HeldSolution> baseline = clone_held_baseline(*held);
            baseline->id = prior_id;
            g_session.set_baseline(baseline, prior_id);
        }
        held->baseline_solution_id = g_session.baseline_solution();

        const poker::streets::StreetConfig config = held->street->config();
        held->street = std::make_shared<poker::solver::StreetBatchSolver>(config);
        held->sample_iterations.clear();
        held->sample_values.clear();
        held->sample_gaps.clear();
        held->iterations = 0;
        held->runtime_seconds = 0.0;
        held->value = 0.0;
        held->p1_best_response = 0.0;
        held->p2_best_response = 0.0;
        held->nash_gap = 0.0;

        const auto started = std::chrono::steady_clock::now();
        int done = 0;
        double value = 0.0;
        double p1 = 0.0;
        double p2 = 0.0;
        double gap = 0.0;
        bool time_limit_reached = false;
        const int eval_samples = std::max(1, held->job.samples);
        const int chunk = std::max(1, iterations / eval_samples);
        const auto seconds_now = [&]()
        {
            return std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
        };
        const auto wall_exhausted = [&]()
        {
            return held->job.time_limit >= 0.0 && seconds_now() >= held->job.time_limit;
        };
        const poker::solver::LockSet* const locks = locks_arg(*held);
        while (done < iterations)
        {
            if (g_session.stop_requested(job_id) || g_session.pause_requested(job_id))
            {
                break;
            }
            const int step = std::min(chunk, iterations - done);
            if (held->job.frozen)
            {
                held->street->continue_frozen_iterations(step, held->job.algorithm, locks);
            }
            else
            {
                held->street->continue_iterations(step, held->job.algorithm, locks);
            }
            done += step;
            value = held->street->expected_utility();
            p1 = held->street->p1_best_response_utility();
            p2 = held->street->p2_best_response_utility();
            gap = p1 + p2;
            held->sample_iterations.push_back(done);
            held->sample_values.push_back(value);
            held->sample_gaps.push_back(gap);
            StatusDraft progress = draft_for(
                held->job, job_id, done, seconds_now(), true, value, p1, p2, gap,
                held->sample_iterations, held->sample_values, held->sample_gaps,
                nullptr);
            progress.running = true;
            progress.solution_id = held->id;
            progress.root_id = held->root_id;
            progress.baseline_solution_id = held->baseline_solution_id;
            progress.time_limit_reached = time_limit_reached;
            g_session.set_progress(job_id, build_status(progress));
            if (held->job.accuracy >= 0.0 && gap <= held->job.accuracy * static_cast<double>(held->job.pot))
            {
                break;
            }
            if (wall_exhausted())
            {
                time_limit_reached = true;
                break;
            }
        }
        if (done == 0)
        {
            StatusDraft draft = draft_for(
                held->job, job_id, 0, seconds_now(), false, 0.0, 0.0, 0.0, 0.0,
                held->sample_iterations, held->sample_values, held->sample_gaps, nullptr);
            draft.error = "resolve-locked produced no iterations";
            draft.solution_id = prior_id;
            draft.root_id = held->root_id;
            draft.baseline_solution_id = held->baseline_solution_id;
            g_session.abort_continuation(job_id, build_status(draft));
            return;
        }
        held->street->prepare_inspection();
        held->root_id = held->street->root_node_id();
        held->memory = held->street->memory_report();
        held->has_memory = true;
        held->iterations = done;
        held->runtime_seconds = seconds_now();
        held->value = value;
        held->p1_best_response = p1;
        held->p2_best_response = p2;
        held->nash_gap = gap;
        held->time_limit_reached = time_limit_reached;
        held->job_id = job_id;

        const poker::explorer::Session::Permit permit = g_session.prepare_success(job_id);
        if (!permit.allowed)
        {
            StatusDraft draft = draft_for(
                held->job, job_id, done, held->runtime_seconds, true, value, p1, p2, gap,
                held->sample_iterations, held->sample_values, held->sample_gaps,
                &held->memory);
            draft.error = "resolve-locked was stopped before publish";
            draft.solution_id = prior_id;
            draft.root_id = held->root_id;
            draft.baseline_solution_id = held->baseline_solution_id;
            g_session.abort_continuation(job_id, build_status(draft));
            return;
        }
        held->id = permit.solution_id;
        StatusDraft success = draft_for(
            held->job, job_id, done, held->runtime_seconds, true, value, p1, p2, gap,
            held->sample_iterations, held->sample_values, held->sample_gaps,
            &held->memory);
        success.solution_id = held->id;
        success.root_id = held->root_id;
        success.baseline_solution_id = held->baseline_solution_id;
        success.time_limit_reached = time_limit_reached;
        const bool published = g_session.commit_success(
            job_id,
            held,
            permit.solution_id,
            [&](std::uint64_t generation, bool accepted)
            {
                StatusDraft draft = success;
                draft.generation = generation;
                if (!accepted)
                {
                    draft.cancelled = true;
                    draft.solution_id = 0;
                    draft.root_id.clear();
                }
                return build_status(draft);
            });
        if (!published && g_session.phase() == poker::explorer::Phase::Running)
        {
            StatusDraft draft = success;
            draft.error = "failed to publish the locked resolve";
            g_session.abort_continuation(job_id, build_status(draft));
        }
    }
    catch (const std::exception& error)
    {
        StatusDraft draft = draft_for(
            held->job, job_id, held->iterations, held->runtime_seconds, true,
            held->value, held->p1_best_response, held->p2_best_response, held->nash_gap,
            held->sample_iterations, held->sample_values, held->sample_gaps,
            held->has_memory ? &held->memory : nullptr);
        draft.error = error.what();
        draft.solution_id = held->id;
        draft.root_id = held->root_id;
        draft.baseline_solution_id = held->baseline_solution_id;
        g_session.abort_continuation(job_id, build_status(draft));
    }
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

void send_response(
    socket_t client,
    int status,
    const std::string& type,
    const std::string& body,
    const std::string& extra_headers = {})
{
    const char* reason = status == 200 ? "OK"
        : status == 202 ? "Accepted"
        : status == 404 ? "Not Found"
        : status == 409 ? "Conflict"
        : "Bad Request";
    std::string header = "HTTP/1.1 " + std::to_string(status) + " " + reason + "\r\n";
    header += "Content-Type: " + type + "\r\n";
    header += "Content-Length: " + std::to_string(body.size()) + "\r\n";
    header += "Cache-Control: no-store\r\n";
    header += extra_headers;
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

constexpr std::uint64_t kMaxCheckpointBytes = 2ull * 1024ull * 1024ull * 1024ull;

std::uint8_t algorithm_code(poker::solver::Algorithm algorithm)
{
    if (algorithm == poker::solver::Algorithm::VanillaCfr)
    {
        return 0;
    }
    if (algorithm == poker::solver::Algorithm::CfrPlus)
    {
        return 1;
    }
    return 2;
}

poker::solver::Algorithm algorithm_from_code(std::uint8_t code)
{
    if (code == 0)
    {
        return poker::solver::Algorithm::VanillaCfr;
    }
    if (code == 1)
    {
        return poker::solver::Algorithm::CfrPlus;
    }
    if (code == 2)
    {
        return poker::solver::Algorithm::LinearCfr;
    }
    throw std::invalid_argument("checkpoint algorithm is unknown");
}

Job job_from_street(const poker::streets::StreetConfig& config)
{
    Job job;
    job.board = config.board;
    job.pot = config.pot;
    job.stack = config.stack;
    job.oop = config.oop;
    job.ip = config.ip;
    job.oop_bets = config.oop_bet_sizes;
    job.ip_bets = config.ip_bet_sizes;
    job.oop_raises = config.oop_raise_sizes;
    job.ip_raises = config.ip_raise_sizes;
    job.oop_flop_bets = config.oop_flop_bets;
    job.oop_turn_bets = config.oop_turn_bets;
    job.oop_river_bets = config.oop_river_bets;
    job.ip_flop_bets = config.ip_flop_bets;
    job.ip_turn_bets = config.ip_turn_bets;
    job.ip_river_bets = config.ip_river_bets;
    job.oop_donk = config.oop_donk_sizes;
    job.oop_raise_multiples = config.oop_raise_multiples;
    job.ip_raise_multiples = config.ip_raise_multiples;
    job.pot_cap = config.pot_cap;
    job.allow_three_bet = config.allow_three_bet;
    job.allow_all_in = config.allow_all_in;
    job.geometric = config.geometric;
    job.all_in_threshold = config.all_in_threshold;
    job.max_raises = config.max_raises;
    job.memory_mib = config.memory_mib;
    job.threads = config.threads;
    return job;
}

Job job_from_river(const poker::river::RiverConfig& config)
{
    Job job;
    job.board.assign(config.board.begin(), config.board.end());
    job.pot = config.pot;
    job.stack = config.stack;
    job.oop = config.oop;
    job.ip = config.ip;
    job.oop_bets = config.oop_bet_sizes;
    job.ip_bets = config.ip_bet_sizes;
    job.oop_raises = config.oop_raise_sizes;
    job.ip_raises = config.ip_raise_sizes;
    job.allow_all_in = config.allow_all_in;
    job.max_raises = config.max_raises;
    return job;
}

poker::explorer::CheckpointDocument checkpoint_from_held(const HeldSolution& held)
{
    poker::explorer::CheckpointDocument document;
    document.algorithm = algorithm_code(held.job.algorithm);
    document.frozen = held.job.frozen;
    document.samples = std::max(1, held.job.samples);
    document.accuracy = held.job.accuracy;
    document.value = held.value;
    document.p1_best_response = held.p1_best_response;
    document.p2_best_response = held.p2_best_response;
    document.nash_gap = held.nash_gap;
    document.runtime_seconds = held.runtime_seconds;
    document.sample_iterations = held.sample_iterations;
    document.sample_values = held.sample_values;
    document.sample_gaps = held.sample_gaps;
    document.locks_text = poker::solver::format_lock_set(held.locks);
    if (held.street)
    {
        document.kind = 1;
        document.config_text = poker::streets::format_street_config(held.street->config());
        document.tables = held.street->training_tables();
    }
    else if (held.river)
    {
        document.kind = 2;
        document.config_text = poker::river::format_river_config(held.river->config());
        document.tables = held.river->training_tables();
    }
    else
    {
        throw std::invalid_argument("solution has no solver");
    }
    return document;
}

std::shared_ptr<HeldSolution> solution_from_checkpoint(const poker::explorer::CheckpointDocument& document)
{
    auto held = std::make_shared<HeldSolution>();
    held->iterations = document.tables.iterations;
    held->runtime_seconds = document.runtime_seconds;
    held->value = document.value;
    held->p1_best_response = document.p1_best_response;
    held->p2_best_response = document.p2_best_response;
    held->nash_gap = document.nash_gap;
    held->sample_iterations = document.sample_iterations;
    held->sample_values = document.sample_values;
    held->sample_gaps = document.sample_gaps;
    if (!document.locks_text.empty())
    {
        held->locks = poker::solver::parse_lock_set(document.locks_text);
    }
    if (document.kind == 1)
    {
        const poker::streets::StreetConfig config = poker::streets::parse_street_config(document.config_text);
        held->job = job_from_street(config);
        held->street = std::make_shared<poker::solver::StreetBatchSolver>(config);
        held->street->install_training_tables(document.tables);
        held->street->prepare_inspection();
        held->root_id = held->street->root_node_id();
        held->memory = held->street->memory_report();
        held->has_memory = true;
    }
    else if (document.kind == 2)
    {
        const poker::river::RiverConfig config = poker::river::parse_river_config(document.config_text);
        held->job = job_from_river(config);
        held->river = std::make_shared<poker::solver::RiverBatchSolver>(config);
        held->river->install_training_tables(document.tables);
        held->river->prepare_inspection();
        held->root_id = held->river->root_node_id();
    }
    else
    {
        throw std::invalid_argument("checkpoint kind is not a street or river solve");
    }
    held->job.algorithm = algorithm_from_code(document.algorithm);
    held->job.frozen = document.frozen;
    held->job.samples = document.samples;
    held->job.accuracy = document.accuracy;
    held->job.iterations = document.tables.iterations;
    if (held->iterations != document.tables.iterations)
    {
        throw std::invalid_argument("checkpoint iteration count does not match the tables");
    }
    return held;
}

std::string publish_loaded(const std::shared_ptr<HeldSolution>& held)
{
    // Build outside install_completed: draft_for reads g_session.generation(),
    // and the install callback already holds the session mutex.
    StatusDraft base = draft_for(
        held->job, 0, held->iterations, held->runtime_seconds, true,
        held->value, held->p1_best_response, held->p2_best_response, held->nash_gap,
        held->sample_iterations, held->sample_values, held->sample_gaps,
        held->has_memory ? &held->memory : nullptr);
    base.root_id = held->root_id;
    std::uint64_t solution_id = 0;
    std::string status;
    const bool installed = g_session.install_completed(held, solution_id, [&](std::uint64_t generation, std::uint64_t id)
    {
        held->id = id;
        StatusDraft draft = base;
        draft.solution_id = id;
        draft.root_id = held->root_id;
        draft.generation = generation;
        status = build_status(draft);
        return status;
    });
    if (!installed)
    {
        throw std::runtime_error("a solve is already running");
    }
    return status;
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
        send_response(client, 200, "application/json", g_session.status());
        return;
    }
    if (line.rfind("GET /api/recent-solutions", 0) == 0)
    {
        const std::vector<poker::explorer::RecentFile> recent =
            poker::explorer::list_recent_files(true);
        std::string payload = "[";
        for (std::size_t index = 0; index < recent.size(); ++index)
        {
            if (index > 0)
            {
                payload += ',';
            }
            payload += "{\"path\":";
            append_escaped(payload, recent[index].path);
            payload += ",\"name\":";
            append_escaped(payload, recent[index].name);
            payload += ",\"mtime\":";
            payload += std::to_string(recent[index].mtime);
            payload += '}';
        }
        payload += ']';
        send_response(client, 200, "application/json", payload);
        return;
    }
    if (line.rfind("POST /api/recent-solutions/clear", 0) == 0)
    {
        poker::explorer::clear_recent_files();
        send_response(client, 200, "application/json", "{\"cleared\":true}");
        return;
    }
    if (line.rfind("GET /api/templates ", 0) == 0 || line.rfind("GET /api/templates?", 0) == 0)
    {
        const std::vector<poker::explorer::TemplateInfo> templates =
            poker::explorer::list_templates(g_templates_root);
        std::string payload = "[";
        for (std::size_t index = 0; index < templates.size(); ++index)
        {
            if (index != 0)
            {
                payload.push_back(',');
            }
            payload += "{\"id\":";
            append_escaped(payload, templates[index].id);
            payload += ",\"name\":";
            append_escaped(payload, templates[index].name);
            payload += '}';
        }
        payload += ']';
        send_response(client, 200, "application/json", payload);
        return;
    }
    if (line.rfind("GET /api/templates/", 0) == 0)
    {
        const std::string rest = line.substr(std::string("GET /api/templates/").size());
        const std::size_t end = rest.find(' ');
        const std::string id = end == std::string::npos ? rest : rest.substr(0, end);
        if (!poker::explorer::is_safe_template_id(id))
        {
            send_response(client, 404, "application/json", "{\"error\":\"unknown template\"}");
            return;
        }
        const std::optional<std::string> text =
            poker::explorer::read_template(g_templates_root, id);
        if (!text.has_value())
        {
            send_response(client, 404, "application/json", "{\"error\":\"unknown template\"}");
            return;
        }
        std::string payload = "{\"id\":";
        append_escaped(payload, id);
        payload += ",\"text\":";
        append_escaped(payload, *text);
        payload += '}';
        send_response(client, 200, "application/json", payload);
        return;
    }
    if (line.rfind("GET /api/ranges ", 0) == 0 || line.rfind("GET /api/ranges?", 0) == 0)
    {
        const std::vector<poker::explorer::RangePresetInfo> presets =
            poker::explorer::list_range_presets(g_ranges_root);
        std::string payload = "[";
        for (std::size_t index = 0; index < presets.size(); ++index)
        {
            if (index != 0)
            {
                payload.push_back(',');
            }
            payload += "{\"id\":";
            append_escaped(payload, presets[index].id);
            payload += ",\"name\":";
            append_escaped(payload, presets[index].name);
            payload += '}';
        }
        payload += ']';
        send_response(client, 200, "application/json", payload);
        return;
    }
    if (line.rfind("GET /api/ranges/", 0) == 0)
    {
        const std::string rest = line.substr(std::string("GET /api/ranges/").size());
        const std::size_t end = rest.find(' ');
        const std::string id = end == std::string::npos ? rest : rest.substr(0, end);
        if (!poker::explorer::is_safe_range_id(id))
        {
            send_response(client, 404, "application/json", "{\"error\":\"unknown range\"}");
            return;
        }
        const std::optional<std::string> text =
            poker::explorer::read_range_preset(g_ranges_root, id);
        if (!text.has_value())
        {
            send_response(client, 404, "application/json", "{\"error\":\"unknown range\"}");
            return;
        }
        std::string payload = "{\"id\":";
        append_escaped(payload, id);
        payload += ",\"text\":";
        append_escaped(payload, *text);
        payload += '}';
        send_response(client, 200, "application/json", payload);
        return;
    }
    if (line.rfind("GET /api/compare", 0) == 0)
    {
        const auto query_value = [&](const char* key) -> std::string
        {
            const std::size_t q = line.find('?');
            if (q == std::string::npos)
            {
                return {};
            }
            const std::size_t space = line.find(' ', q);
            const std::string query = space == std::string::npos
                ? line.substr(q + 1)
                : line.substr(q + 1, space - q - 1);
            const std::string needle = std::string(key) + "=";
            std::size_t at = 0;
            while (at < query.size())
            {
                const std::size_t amp = query.find('&', at);
                const std::string part = amp == std::string::npos
                    ? query.substr(at)
                    : query.substr(at, amp - at);
                if (part.rfind(needle, 0) == 0)
                {
                    return part.substr(needle.size());
                }
                if (amp == std::string::npos)
                {
                    break;
                }
                at = amp + 1;
            }
            return {};
        };
        std::uint64_t baseline_id = 0;
        std::uint64_t scenario_id = 0;
        const std::string baseline_token = query_value("baseline");
        const std::string scenario_token = query_value("scenario");
        const std::string node_token = query_value("node_id");
        if (!parse_prefixed_id(baseline_token, 's', baseline_id)
            || !parse_prefixed_id(scenario_token, 's', scenario_id)
            || node_token.empty())
        {
            send_response(
                client,
                400,
                "application/json",
                "{\"error\":\"baseline, scenario, and node_id are required\"}");
            return;
        }
        poker::explorer::ReaderLease baseline_lease(g_session, g_session.borrow(baseline_id));
        poker::explorer::ReaderLease scenario_lease(g_session, g_session.borrow(scenario_id));
        if (!baseline_lease || !scenario_lease)
        {
            send_response(client, 404, "application/json", "{\"error\":\"expired solution\"}");
            return;
        }
        try
        {
            const auto baseline =
                std::static_pointer_cast<HeldSolution>(baseline_lease.resource());
            const auto scenario =
                std::static_pointer_cast<HeldSolution>(scenario_lease.resource());
            const auto inspect = [&](const HeldSolution& held, const std::string& node_id)
                -> poker::solver::StreetInspection
            {
                if (held.street)
                {
                    return held.street->inspect_node(node_id);
                }
                if (held.river)
                {
                    return held.river->inspect_node(node_id);
                }
                throw std::invalid_argument("solution has no solver");
            };
            const poker::solver::StreetInspection base_view = inspect(*baseline, node_token);
            const poker::solver::StreetInspection scen_view = inspect(*scenario, node_token);
            if (base_view.kind != "decision" || scen_view.kind != "decision")
            {
                throw std::invalid_argument("compare requires a decision node");
            }
            if (base_view.actions.size() != scen_view.actions.size())
            {
                throw std::invalid_argument("solutions disagree on action arity at node");
            }
            std::size_t infoset_id = 0;
            parse_public_node_index(node_token, infoset_id);
            const poker::solver::NodeLock* lock = scenario->locks.find(infoset_id);
            std::string out = "{\"baseline_id\":";
            append_escaped(out, "s" + std::to_string(baseline_id));
            out += ",\"scenario_id\":";
            append_escaped(out, "s" + std::to_string(scenario_id));
            out += ",\"node_id\":";
            append_escaped(out, node_token);
            out += ",\"baseline_value\":";
            out += format_number(baseline->value);
            out += ",\"scenario_value\":";
            out += format_number(scenario->value);
            out += ",\"value_delta\":";
            out += format_number(scenario->value - baseline->value);
            out += ",\"baseline_nash_gap\":";
            out += format_number(baseline->nash_gap);
            out += ",\"scenario_nash_gap\":";
            out += format_number(scenario->nash_gap);
            out += ",\"actions\":[";
            for (std::size_t i = 0; i < base_view.actions.size(); ++i)
            {
                if (i > 0)
                {
                    out += ',';
                }
                append_escaped(out, base_view.actions[i].label);
            }
            out += "],\"hands\":[";
            const std::size_t hand_count = std::min(base_view.hands.size(), scen_view.hands.size());
            for (std::size_t h = 0; h < hand_count; ++h)
            {
                if (h > 0)
                {
                    out += ',';
                }
                const bool locked_hand = lock != nullptr
                    && !lock->actions.unlocked()
                    && (lock->kind == poker::solver::LockKind::FullNode
                        || poker::solver::combo_is_selected(*lock, h));
                out += "{\"combo\":";
                append_escaped(out, scen_view.hands[h].combo);
                out += ",\"locked\":";
                out += locked_hand ? "true" : "false";
                out += ",\"baseline\":[";
                for (std::size_t a = 0; a < base_view.hands[h].strategy.size(); ++a)
                {
                    if (a > 0)
                    {
                        out += ',';
                    }
                    out += format_number(base_view.hands[h].strategy[a]);
                }
                out += "],\"scenario\":[";
                for (std::size_t a = 0; a < scen_view.hands[h].strategy.size(); ++a)
                {
                    if (a > 0)
                    {
                        out += ',';
                    }
                    out += format_number(scen_view.hands[h].strategy[a]);
                }
                out += "],\"delta\":[";
                const std::size_t action_count =
                    std::min(base_view.hands[h].strategy.size(), scen_view.hands[h].strategy.size());
                for (std::size_t a = 0; a < action_count; ++a)
                {
                    if (a > 0)
                    {
                        out += ',';
                    }
                    out += format_number(
                        scen_view.hands[h].strategy[a] - base_view.hands[h].strategy[a]);
                }
                out += "]}";
            }
            out += "]}";
            send_response(client, 200, "application/json", out);
        }
        catch (const std::exception& error)
        {
            std::string payload = "{\"error\":";
            append_escaped(payload, error.what());
            payload += '}';
            send_response(client, 400, "application/json", payload);
        }
        return;
    }
    if (line.rfind("POST /api/solutions/", 0) == 0 && line.find("/resolve-locked ") != std::string::npos)
    {
        if (g_session.running())
        {
            send_response(client, 409, "application/json", "{\"error\":\"a solve is already running\"}");
            return;
        }
        const std::string prefix = "POST /api/solutions/";
        const std::string rest = line.substr(prefix.size());
        const std::size_t slash = rest.find('/');
        std::uint64_t id = 0;
        if (slash == std::string::npos || !parse_prefixed_id(rest.substr(0, slash), 's', id))
        {
            send_response(client, 400, "application/json", "{\"error\":\"bad solution id\"}");
            return;
        }
        double requested = 0.0;
        double resolve_accuracy = -1.0;
        double resolve_time_limit = -1.0;
        int resolve_samples = -1;
        try
        {
            requested = read_number(body, "iterations", 0.0);
            if (find_key(body, "accuracy") != std::string::npos)
            {
                resolve_accuracy = read_number(body, "accuracy", -1.0);
            }
            if (find_key(body, "samples") != std::string::npos)
            {
                resolve_samples = static_cast<int>(read_number(body, "samples", 5.0));
            }
            if (find_key(body, "time_limit") != std::string::npos)
            {
                resolve_time_limit = read_number(body, "time_limit", -1.0);
            }
        }
        catch (const std::exception&)
        {
            send_response(client, 400, "application/json", "{\"error\":\"iterations must be a positive integer\"}");
            return;
        }
        if (!std::isfinite(requested) || requested < 1.0 || requested > 1000000000.0
            || std::floor(requested) != requested)
        {
            send_response(client, 400, "application/json", "{\"error\":\"iterations must be a positive integer\"}");
            return;
        }
        if (find_key(body, "time_limit") != std::string::npos
            && (!std::isfinite(resolve_time_limit) || resolve_time_limit < 0.0))
        {
            send_response(
                client,
                400,
                "application/json",
                "{\"error\":\"time_limit must be a non-negative number of seconds\"}");
            return;
        }
        const int extra = static_cast<int>(requested);
        if (g_values != nullptr)
        {
            g_values->cancel();
        }
        if (g_worker.joinable())
        {
            g_worker.join();
        }
        const poker::explorer::Session::Claim claim = g_session.claim_completed(id);
        if (!claim.allowed)
        {
            send_response(client, 404, "application/json", "{\"error\":\"expired solution\"}");
            return;
        }
        try
        {
            const std::shared_ptr<HeldSolution> held =
                std::static_pointer_cast<HeldSolution>(g_session.training_resource(claim.job_id));
            if (!held || !held->street)
            {
                g_session.abort_continuation(
                    claim.job_id,
                    "{\"running\":false,\"cancelled\":false,\"error\":\"resolve-locked requires a street solution\","
                    "\"solution_id\":null}");
                send_response(
                    client,
                    400,
                    "application/json",
                    "{\"error\":\"resolve-locked requires a street solution\"}");
                return;
            }
            StatusDraft starting = draft_for(
                held->job, claim.job_id, held->iterations, held->runtime_seconds, true,
                held->value, held->p1_best_response, held->p2_best_response, held->nash_gap,
                held->sample_iterations, held->sample_values, held->sample_gaps,
                held->has_memory ? &held->memory : nullptr);
            starting.running = true;
            starting.solution_id = held->id;
            starting.root_id = held->root_id;
            starting.baseline_solution_id = held->baseline_solution_id;
            g_session.set_progress(claim.job_id, build_status(starting));
            g_worker = std::thread(
                [job_id = claim.job_id, extra, resolve_accuracy, resolve_samples, resolve_time_limit]()
                {
                    resolve_locked_job(
                        job_id, extra, resolve_accuracy, resolve_samples, resolve_time_limit);
                });
        }
        catch (const std::exception& error)
        {
            g_session.abort_continuation(
                claim.job_id,
                "{\"running\":false,\"cancelled\":false,\"error\":\"resolve-locked failed\",\"solution_id\":null}");
            std::string payload = "{\"error\":";
            append_escaped(payload, error.what());
            payload += '}';
            send_response(client, 400, "application/json", payload);
            return;
        }
        std::string accepted = "{\"running\":true,\"job_id\":";
        append_escaped(accepted, "j" + std::to_string(claim.job_id));
        accepted += ",\"solution_id\":";
        append_escaped(accepted, "s" + std::to_string(id));
        accepted += ",\"warm_start\":\"reset\"}";
        send_response(client, 202, "application/json", accepted);
        return;
    }
    if (line.rfind("PUT /api/solutions/", 0) == 0 && line.find("/locks ") != std::string::npos)
    {
        const std::string prefix = "PUT /api/solutions/";
        const std::string rest = line.substr(prefix.size());
        const std::size_t slash = rest.find('/');
        std::uint64_t id = 0;
        if (slash == std::string::npos || !parse_prefixed_id(rest.substr(0, slash), 's', id))
        {
            send_response(client, 400, "application/json", "{\"error\":\"bad solution id\"}");
            return;
        }
        if (g_session.running())
        {
            send_response(client, 409, "application/json", "{\"error\":\"a solve is already running\"}");
            return;
        }
        poker::explorer::ReaderLease lease(g_session, g_session.borrow(id));
        if (!lease)
        {
            send_response(client, 404, "application/json", "{\"error\":\"expired solution\"}");
            return;
        }
        try
        {
            auto held = std::static_pointer_cast<HeldSolution>(lease.resource());
            const std::string node_id = read_string(body, "node_id", "");
            const std::string kind = read_string(body, "kind", "full");
            std::size_t infoset_id = 0;
            if (!parse_public_node_index(node_id, infoset_id))
            {
                throw std::invalid_argument("bad node_id");
            }
            poker::solver::StreetInspection view;
            if (held->street)
            {
                view = held->street->inspect_node(node_id);
            }
            else if (held->river)
            {
                view = held->river->inspect_node(node_id);
            }
            else
            {
                throw std::invalid_argument("solution has no solver");
            }
            if (view.kind != "decision")
            {
                throw std::invalid_argument("locks apply only to decision nodes");
            }
            const int action_count = static_cast<int>(view.actions.size());
            const std::vector<double> probs = read_number_array(body, "probs");
            if (static_cast<int>(probs.size()) != action_count)
            {
                throw std::invalid_argument("probs length must match action arity");
            }
            poker::solver::NodeLock lock;
            lock.infoset_id = infoset_id;
            if (kind == "full")
            {
                lock.kind = poker::solver::LockKind::FullNode;
            }
            else if (kind == "selected")
            {
                lock.kind = poker::solver::LockKind::SelectedCombos;
                const std::vector<double> hands = read_number_array(body, "hand_indices");
                for (double hand : hands)
                {
                    if (!std::isfinite(hand) || hand < 0.0 || std::floor(hand) != hand)
                    {
                        throw std::invalid_argument("hand_indices must be non-negative integers");
                    }
                    const std::size_t index = static_cast<std::size_t>(hand);
                    if (index >= view.hands.size())
                    {
                        throw std::invalid_argument("hand index out of range");
                    }
                    lock.combo_indices.push_back(index);
                }
            }
            else
            {
                throw std::invalid_argument("kind must be full or selected");
            }
            lock.actions = poker::solver::make_action_lock_row(probs, action_count);
            held->locks.upsert(std::move(lock));
            send_response(client, 200, "application/json", json_locks(held->locks));
        }
        catch (const std::exception& error)
        {
            std::string payload = "{\"error\":";
            append_escaped(payload, error.what());
            payload += '}';
            send_response(client, 400, "application/json", payload);
        }
        return;
    }
    if (line.rfind("DELETE /api/solutions/", 0) == 0
        && (line.find("/locks?") != std::string::npos || line.find("/locks/") != std::string::npos
            || line.find("/locks ") != std::string::npos))
    {
        const std::string prefix = "DELETE /api/solutions/";
        const std::string rest = line.substr(prefix.size());
        const std::size_t slash = rest.find('/');
        std::uint64_t id = 0;
        if (slash == std::string::npos || !parse_prefixed_id(rest.substr(0, slash), 's', id))
        {
            send_response(client, 400, "application/json", "{\"error\":\"bad solution id\"}");
            return;
        }
        if (g_session.running())
        {
            send_response(client, 409, "application/json", "{\"error\":\"a solve is already running\"}");
            return;
        }
        std::string node_id;
        const std::size_t locks_at = rest.find("/locks");
        if (locks_at != std::string::npos)
        {
            const std::string after = rest.substr(locks_at + 6);
            if (!after.empty() && after[0] == '/')
            {
                const std::size_t end = after.find(' ');
                node_id = end == std::string::npos ? after.substr(1) : after.substr(1, end - 1);
            }
            else if (!after.empty() && after[0] == '?')
            {
                const std::string needle = "node_id=";
                const std::size_t at = after.find(needle);
                if (at != std::string::npos)
                {
                    const std::size_t start = at + needle.size();
                    const std::size_t amp = after.find('&', start);
                    const std::size_t space = after.find(' ', start);
                    const std::size_t end = std::min(
                        amp == std::string::npos ? after.size() : amp,
                        space == std::string::npos ? after.size() : space);
                    node_id = after.substr(start, end - start);
                }
            }
        }
        poker::explorer::ReaderLease lease(g_session, g_session.borrow(id));
        if (!lease)
        {
            send_response(client, 404, "application/json", "{\"error\":\"expired solution\"}");
            return;
        }
        try
        {
            auto held = std::static_pointer_cast<HeldSolution>(lease.resource());
            if (node_id.empty())
            {
                held->locks.clear();
            }
            else
            {
                std::size_t infoset_id = 0;
                if (!parse_public_node_index(node_id, infoset_id))
                {
                    throw std::invalid_argument("bad node_id");
                }
                held->locks.erase(infoset_id);
            }
            send_response(client, 200, "application/json", json_locks(held->locks));
        }
        catch (const std::exception& error)
        {
            std::string payload = "{\"error\":";
            append_escaped(payload, error.what());
            payload += '}';
            send_response(client, 400, "application/json", payload);
        }
        return;
    }
    if (line.rfind("POST /api/solutions/", 0) == 0 && line.find("/continue ") != std::string::npos)
    {
        if (g_session.running())
        {
            send_response(client, 409, "application/json", "{\"error\":\"a solve is already running\"}");
            return;
        }
        const std::string prefix = "POST /api/solutions/";
        const std::string rest = line.substr(prefix.size());
        const std::size_t slash = rest.find('/');
        std::uint64_t id = 0;
        if (slash == std::string::npos || !parse_prefixed_id(rest.substr(0, slash), 's', id))
        {
            send_response(client, 400, "application/json", "{\"error\":\"bad solution id\"}");
            return;
        }
        double requested = 0.0;
        double continue_time_limit = -1.0;
        try
        {
            requested = read_number(body, "iterations", 0.0);
            if (find_key(body, "time_limit") != std::string::npos)
            {
                continue_time_limit = read_number(body, "time_limit", -1.0);
            }
        }
        catch (const std::exception&)
        {
            send_response(client, 400, "application/json", "{\"error\":\"iterations must be a positive integer\"}");
            return;
        }
        if (!std::isfinite(requested) || requested < 1.0 || requested > 1000000000.0
            || std::floor(requested) != requested)
        {
            send_response(client, 400, "application/json", "{\"error\":\"iterations must be a positive integer\"}");
            return;
        }
        if (find_key(body, "time_limit") != std::string::npos
            && (!std::isfinite(continue_time_limit) || continue_time_limit < 0.0))
        {
            send_response(
                client,
                400,
                "application/json",
                "{\"error\":\"time_limit must be a non-negative number of seconds\"}");
            return;
        }
        const int extra = static_cast<int>(requested);
        if (g_values != nullptr)
        {
            g_values->cancel();
        }
        if (g_worker.joinable())
        {
            g_worker.join();
        }
        // Claim is non-blocking: cancelled value readers may still hold the
        // engine. continue_job waits for quiet before mutating.
        const poker::explorer::Session::Claim claim = g_session.claim_completed(id);
        if (!claim.allowed)
        {
            send_response(client, 404, "application/json", "{\"error\":\"expired solution\"}");
            return;
        }
        try
        {
            const std::shared_ptr<HeldSolution> held =
                std::static_pointer_cast<HeldSolution>(g_session.training_resource(claim.job_id));
            if (!held)
            {
                g_session.abort_continuation(
                    claim.job_id,
                    "{\"running\":false,\"cancelled\":false,\"error\":\"missing solution\",\"solution_id\":null}");
                send_response(client, 404, "application/json", "{\"error\":\"expired solution\"}");
                return;
            }
            StatusDraft starting = draft_for(
                held->job, claim.job_id, held->iterations, held->runtime_seconds, true,
                held->value, held->p1_best_response, held->p2_best_response, held->nash_gap,
                held->sample_iterations, held->sample_values, held->sample_gaps,
                held->has_memory ? &held->memory : nullptr);
            starting.running = true;
            starting.solution_id = held->id;
            starting.root_id = held->root_id;
            g_session.set_progress(claim.job_id, build_status(starting));
            g_worker = std::thread(
                [job_id = claim.job_id, extra, continue_time_limit]()
                { continue_job(job_id, extra, continue_time_limit); });
        }
        catch (const std::exception& error)
        {
            const std::shared_ptr<HeldSolution> held =
                std::static_pointer_cast<HeldSolution>(g_session.training_resource(claim.job_id));
            if (held)
            {
                StatusDraft failed = draft_for(
                    held->job, claim.job_id, held->iterations, held->runtime_seconds, true,
                    held->value, held->p1_best_response, held->p2_best_response, held->nash_gap,
                    held->sample_iterations, held->sample_values, held->sample_gaps,
                    held->has_memory ? &held->memory : nullptr);
                failed.error = error.what();
                failed.solution_id = held->id;
                failed.root_id = held->root_id;
                g_session.abort_continuation(claim.job_id, build_status(failed));
            }
            else
            {
                g_session.abort_continuation(
                    claim.job_id,
                    "{\"running\":false,\"cancelled\":false,\"error\":\"continuation failed\",\"solution_id\":null}");
            }
            std::string payload = "{\"error\":";
            append_escaped(payload, error.what());
            payload += "}";
            send_response(client, 400, "application/json", payload);
            return;
        }
        std::string accepted = "{\"running\":true,\"job_id\":";
        append_escaped(accepted, "j" + std::to_string(claim.job_id));
        accepted += ",\"solution_id\":";
        append_escaped(accepted, "s" + std::to_string(id));
        accepted += "}";
        send_response(client, 202, "application/json", accepted);
        return;
    }
    if (line.rfind("POST /api/config", 0) == 0)
    {
        try
        {
            const std::string text = read_string(body, "text", "");
            std::string payload = "{\"kind\":";
            if (text.rfind("street-config ", 0) == 0)
            {
                const poker::streets::StreetConfig config = poker::streets::parse_street_config(text);
                const Job job = job_from_street(config);
                payload += "\"street\"";
                payload += ",\"board\":[";
                for (std::size_t index = 0; index < job.board.size(); ++index)
                {
                    if (index > 0)
                    {
                        payload += ',';
                    }
                    append_escaped(payload, poker::holdem::format_card(job.board[index]));
                }
                payload += "],\"pot\":";
                payload += std::to_string(job.pot);
                payload += ",\"stack\":";
                payload += std::to_string(job.stack);
                payload += ",\"oop_range\":";
                append_escaped(payload, job.oop.to_combo_list());
                payload += ",\"ip_range\":";
                append_escaped(payload, job.ip.to_combo_list());
                payload += ",\"max_raises\":";
                payload += std::to_string(job.max_raises);
                payload += ",\"allow_all_in\":";
                payload += job.allow_all_in ? "true" : "false";
                payload += ",\"allow_three_bet\":";
                payload += job.allow_three_bet ? "true" : "false";
                payload += ",\"geometric\":";
                payload += job.geometric ? "true" : "false";
                payload += ",\"pot_cap\":";
                payload += format_number(job.pot_cap);
                payload += ",\"all_in_threshold\":";
                payload += format_number(job.all_in_threshold);
                payload += ",\"memory_mib\":";
                payload += std::to_string(job.memory_mib);
                payload += ",\"threads\":";
                payload += std::to_string(job.threads);
                const auto write_sizes = [&](const char* key, const std::vector<double>& sizes)
                {
                    payload += ",\"";
                    payload += key;
                    payload += "\":[";
                    for (std::size_t index = 0; index < sizes.size(); ++index)
                    {
                        if (index > 0)
                        {
                            payload += ',';
                        }
                        payload += format_number(sizes[index]);
                    }
                    payload += ']';
                };
                write_sizes("oop_bets", job.oop_bets);
                write_sizes("ip_bets", job.ip_bets);
                write_sizes("oop_flop_bets", job.oop_flop_bets);
                write_sizes("ip_flop_bets", job.ip_flop_bets);
                write_sizes("oop_turn_bets", job.oop_turn_bets);
                write_sizes("ip_turn_bets", job.ip_turn_bets);
                write_sizes("oop_river_bets", job.oop_river_bets);
                write_sizes("ip_river_bets", job.ip_river_bets);
                write_sizes("oop_donk", job.oop_donk);
                payload += '}';
            }
            else if (text.rfind("river-config ", 0) == 0)
            {
                const poker::river::RiverConfig config = poker::river::parse_river_config(text);
                const Job job = job_from_river(config);
                payload += "\"river\",\"board\":[";
                for (std::size_t index = 0; index < job.board.size(); ++index)
                {
                    if (index > 0)
                    {
                        payload += ',';
                    }
                    append_escaped(payload, poker::holdem::format_card(job.board[index]));
                }
                payload += "],\"pot\":";
                payload += std::to_string(job.pot);
                payload += ",\"stack\":";
                payload += std::to_string(job.stack);
                payload += ",\"oop_range\":";
                append_escaped(payload, job.oop.to_combo_list());
                payload += ",\"ip_range\":";
                append_escaped(payload, job.ip.to_combo_list());
                payload += ",\"max_raises\":";
                payload += std::to_string(job.max_raises);
                payload += ",\"allow_all_in\":";
                payload += job.allow_all_in ? "true" : "false";
                payload += ",\"oop_bets\":[";
                for (std::size_t index = 0; index < job.oop_bets.size(); ++index)
                {
                    if (index > 0)
                    {
                        payload += ',';
                    }
                    payload += format_number(job.oop_bets[index]);
                }
                payload += "],\"ip_bets\":[";
                for (std::size_t index = 0; index < job.ip_bets.size(); ++index)
                {
                    if (index > 0)
                    {
                        payload += ',';
                    }
                    payload += format_number(job.ip_bets[index]);
                }
                payload += "]}";
            }
            else
            {
                throw std::invalid_argument("configuration must start with street-config 1 or river-config 1");
            }
            send_response(client, 200, "application/json", payload);
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
    if (line.rfind("POST /api/open", 0) == 0)
    {
        if (g_session.running())
        {
            send_response(client, 409, "application/json", "{\"error\":\"a solve is already running\"}");
            return;
        }
        try
        {
            const std::string path = read_string(body, "path", "");
            if (path.empty())
            {
                throw std::invalid_argument("path is required");
            }
            if (g_values != nullptr)
            {
                g_values->cancel_and_drain();
            }
            const poker::explorer::CheckpointDocument document =
                poker::explorer::read_checkpoint(path, kMaxCheckpointBytes);
            const std::shared_ptr<HeldSolution> held = solution_from_checkpoint(document);
            poker::explorer::record_recent_file(path);
            send_response(client, 200, "application/json", publish_loaded(held));
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
    if (line.rfind("POST /api/solutions/", 0) == 0 && line.find("/save ") != std::string::npos)
    {
        const std::string prefix = "POST /api/solutions/";
        const std::string rest = line.substr(prefix.size());
        const std::size_t slash = rest.find('/');
        std::uint64_t id = 0;
        if (slash == std::string::npos || !parse_prefixed_id(rest.substr(0, slash), 's', id))
        {
            send_response(client, 400, "application/json", "{\"error\":\"bad solution id\"}");
            return;
        }
        poker::explorer::ReaderLease lease(g_session, g_session.borrow(id));
        if (!lease)
        {
            send_response(client, 404, "application/json", "{\"error\":\"expired solution\"}");
            return;
        }
        try
        {
            const std::string path = read_string(body, "path", "");
            if (path.empty())
            {
                throw std::invalid_argument("path is required");
            }
            const std::shared_ptr<HeldSolution> held =
                std::static_pointer_cast<HeldSolution>(lease.resource());
            poker::explorer::write_checkpoint(path, checkpoint_from_held(*held));
            poker::explorer::record_recent_file(path);
            send_response(client, 200, "application/json", "{\"saved\":true}");
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
    if (line.rfind("GET /api/solutions/", 0) == 0)
    {
        const std::string rest = line.substr(std::string("GET /api/solutions/").size());
        const std::size_t slash = rest.find('/');
        const std::size_t space = rest.find(' ');
        if (slash == std::string::npos || space == std::string::npos || slash > space)
        {
            send_response(client, 400, "application/json", "{\"error\":\"bad solution path\"}");
            return;
        }
        const std::string token = rest.substr(0, slash);
        const std::string tail = rest.substr(slash + 1, space - slash - 1);
        std::uint64_t id = 0;
        if (!parse_prefixed_id(token, 's', id))
        {
            send_response(client, 400, "application/json", "{\"error\":\"bad solution id\"}");
            return;
        }
        poker::explorer::ReaderLease lease(g_session, g_session.borrow(id));
        if (!lease)
        {
            send_response(client, 404, "application/json", "{\"error\":\"expired solution\"}");
            return;
        }
        std::shared_ptr<HeldSolution> held = std::static_pointer_cast<HeldSolution>(lease.resource());
        try
        {
            if (tail == "locks")
            {
                send_response(client, 200, "application/json", json_locks(held->locks));
                return;
            }
            if (tail.rfind("nodes/", 0) == 0)
            {
                if (!held->street && !held->river)
                {
                    send_response(client, 400, "application/json", "{\"error\":\"this solution has no nodes\"}");
                    return;
                }
                std::string node_path = tail.substr(6);
                std::string query_kind;
                if (node_path.size() >= 8 && node_path.ends_with("/runouts"))
                {
                    query_kind = "runout";
                    node_path.resize(node_path.size() - 8);
                }
                else if (node_path.size() >= 7 && node_path.ends_with("/equity"))
                {
                    query_kind = "equity";
                    node_path.resize(node_path.size() - 7);
                }
                else if (node_path.size() >= 11 && node_path.ends_with("/categories"))
                {
                    query_kind = "categories";
                    node_path.resize(node_path.size() - 11);
                }
                else if (node_path.size() >= 7 && node_path.ends_with("/values"))
                {
                    query_kind = "actions";
                    node_path.resize(node_path.size() - 7);
                }
                const auto query_started = std::chrono::steady_clock::now();
                const auto inspect = [&](const std::string& id) -> poker::solver::StreetInspection
                {
                    if (held->street)
                    {
                        return held->street->inspect_node(id);
                    }
                    return held->river->inspect_node(id);
                };
                if (query_kind == "categories")
                {
                    if (!held->street)
                    {
                        send_response(
                            client,
                            400,
                            "application/json",
                            "{\"error\":\"hand categories require a street solution\"}");
                        return;
                    }
                    held->street->inspect_node(node_path);
                    const poker::holdem::CategoryComposition report =
                        held->street->category_composition(node_path);
                    const double query_seconds = std::chrono::duration<double>(
                        std::chrono::steady_clock::now() - query_started).count();
                    const std::string payload = json_categories(
                        report,
                        held->id,
                        held->job_id,
                        node_path,
                        g_session.generation(),
                        query_seconds);
                    send_response(
                        client,
                        200,
                        "application/json",
                        payload,
                        "X-Query-Seconds: " + format_number(query_seconds) + "\r\n");
                    return;
                }
                if (!query_kind.empty())
                {
                    if (query_kind == "runout" && held->river)
                    {
                        send_response(
                            client,
                            400,
                            "application/json",
                            "{\"error\":\"runout values require a chance node\"}");
                        return;
                    }
                    const poker::solver::StreetInspection view = inspect(node_path);
                    if (query_kind == "actions" && view.kind != "decision")
                    {
                        send_response(
                            client,
                            400,
                            "application/json",
                            "{\"error\":\"action values require a decision node\"}");
                        return;
                    }
                    if (query_kind == "runout" && view.kind != "chance")
                    {
                        send_response(
                            client,
                            400,
                            "application/json",
                            "{\"error\":\"runout values require a chance node\"}");
                        return;
                    }
                    const std::uint64_t solution_id = held->id;
                    const std::uint64_t job_id = held->job_id;
                    held.reset();
                    lease.release();
                    respond_value_query(client, solution_id, job_id, node_path, query_started, query_kind);
                    return;
                }
                const poker::solver::StreetInspection view = inspect(node_path);
                const double query_seconds = std::chrono::duration<double>(
                    std::chrono::steady_clock::now() - query_started).count();
                const auto serialize_started = std::chrono::steady_clock::now();
                const std::string payload = json_inspection(view, held->memory, held->id, held->job_id);
                const double serialize_seconds = std::chrono::duration<double>(
                    std::chrono::steady_clock::now() - serialize_started).count();
                std::string timing = "X-Query-Seconds: " + format_number(query_seconds) + "\r\n";
                timing += "X-Serialize-Seconds: " + format_number(serialize_seconds) + "\r\n";
                send_response(client, 200, "application/json", payload, timing);
                return;
            }
            if (tail == "equity")
            {
                if (!held->river)
                {
                    send_response(
                        client,
                        400,
                        "application/json",
                        "{\"error\":\"street equity is requested on a node\"}");
                    return;
                }
                const std::uint64_t solution_id = held->id;
                const std::uint64_t job_id = held->job_id;
                held.reset();
                lease.release();
                respond_value_query(
                    client,
                    solution_id,
                    job_id,
                    "root",
                    std::chrono::steady_clock::now(),
                    "equity");
                return;
            }
            if (tail == "categories")
            {
                if (!held->river)
                {
                    send_response(
                        client,
                        400,
                        "application/json",
                        "{\"error\":\"street categories are requested on a node\"}");
                    return;
                }
                const auto query_started = std::chrono::steady_clock::now();
                const poker::holdem::CategoryComposition report = poker::holdem::category_composition(
                    held->job.board, held->job.oop, held->job.ip);
                const double query_seconds = std::chrono::duration<double>(
                    std::chrono::steady_clock::now() - query_started).count();
                const std::string payload = json_categories(
                    report,
                    held->id,
                    held->job_id,
                    "root",
                    g_session.generation(),
                    query_seconds);
                send_response(
                    client,
                    200,
                    "application/json",
                    payload,
                    "X-Query-Seconds: " + format_number(query_seconds) + "\r\n");
                return;
            }
            if (tail == "export")
            {
                std::vector<poker::solver::RiverStrategyEntry> entries;
                if (held->river)
                {
                    entries = held->river->average_strategy_entries();
                }
                else
                {
                    entries = street_entries(held->street->average_strategy_entries());
                }
                StatusDraft draft = draft_for(
                    held->job, held->job_id, held->iterations, held->runtime_seconds, true,
                    held->value, held->p1_best_response, held->p2_best_response, held->nash_gap,
                    held->sample_iterations, held->sample_values, held->sample_gaps,
                    held->has_memory ? &held->memory : nullptr);
                draft.solution_id = held->id;
                draft.root_id = held->root_id;
                draft.generation = g_session.generation();
                draft.include_strategy = true;
                draft.entries = &entries;
                send_response(client, 200, "application/json", build_status(draft));
                return;
            }
            send_response(client, 400, "application/json", "{\"error\":\"bad solution path\"}");
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
    if (line.rfind("POST /api/stop", 0) == 0)
    {
        std::uint64_t job_id = g_session.current_job();
        if (find_key(body, "job_id") != std::string::npos)
        {
            const std::string token = read_string(body, "job_id", "");
            if (!parse_prefixed_id(token, 'j', job_id))
            {
                send_response(client, 400, "application/json", "{\"error\":\"bad job id\"}");
                return;
            }
        }
        const poker::explorer::StopResult result = g_session.request_stop(job_id);
        std::string payload = "{\"result\":";
        if (result == poker::explorer::StopResult::Accepted)
        {
            payload += "\"accepted\"";
        }
        else if (result == poker::explorer::StopResult::AlreadyComplete)
        {
            payload += "\"complete\",\"solution_id\":";
            const std::uint64_t solution = g_session.current_solution();
            if (solution == 0)
            {
                payload += "null";
            }
            else
            {
                append_escaped(payload, "s" + std::to_string(solution));
            }
        }
        else
        {
            payload += "\"stale\"";
        }
        payload += ",\"job_id\":";
        if (job_id == 0)
        {
            payload += "null";
        }
        else
        {
            append_escaped(payload, "j" + std::to_string(job_id));
        }
        payload += "}";
        send_response(client, 200, "application/json", payload);
        return;
    }
    if (line.rfind("POST /api/pause", 0) == 0)
    {
        std::uint64_t job_id = g_session.current_job();
        if (find_key(body, "job_id") != std::string::npos)
        {
            const std::string token = read_string(body, "job_id", "");
            if (!parse_prefixed_id(token, 'j', job_id))
            {
                send_response(client, 400, "application/json", "{\"error\":\"bad job id\"}");
                return;
            }
        }
        const poker::explorer::PauseResult result = g_session.request_pause(job_id);
        std::string payload = "{\"result\":";
        if (result == poker::explorer::PauseResult::Accepted)
        {
            payload += "\"accepted\"";
        }
        else if (result == poker::explorer::PauseResult::AlreadyComplete)
        {
            payload += "\"complete\",\"solution_id\":";
            const std::uint64_t solution = g_session.current_solution();
            if (solution == 0)
            {
                payload += "null";
            }
            else
            {
                append_escaped(payload, "s" + std::to_string(solution));
            }
        }
        else
        {
            payload += "\"stale\"";
        }
        payload += ",\"job_id\":";
        if (job_id == 0)
        {
            payload += "null";
        }
        else
        {
            append_escaped(payload, "j" + std::to_string(job_id));
        }
        payload += "}";
        send_response(client, 200, "application/json", payload);
        return;
    }
    if (line.rfind("POST /api/solve", 0) == 0)
    {
        if (g_session.running())
        {
            send_response(client, 409, "application/json", "{\"error\":\"a solve is already running\"}");
            return;
        }
        if (g_values != nullptr)
        {
            g_values->cancel();
        }
        try
        {
            Job job = parse_job(body);
            if (g_worker.joinable())
            {
                g_worker.join();
            }
            std::shared_ptr<void> retiring;
            // begin() retires the prior engine without waiting; the worker
            // joins quiet before destroying it so value readers can finish.
            const std::uint64_t job_id = g_session.begin(retiring);
            StatusDraft starting;
            starting.running = true;
            starting.job = &job;
            starting.job_id = job_id;
            starting.generation = g_session.generation() + 1;
            g_session.set_progress(job_id, build_status(starting));
            try
            {
                g_worker = std::thread([job, retiring = std::move(retiring), job_id]() mutable
                {
                    g_session.wait_until_quiet();
                    retiring.reset();
                    g_session.notify_released();
                    solve_job(job_id, std::move(job));
                });
            }
            catch (const std::exception& error)
            {
                g_session.wait_until_quiet();
                retiring.reset();
                StatusDraft failed;
                failed.job = &job;
                failed.job_id = job_id;
                failed.error = error.what();
                failed.generation = g_session.generation() + 1;
                g_session.finish_failed(job_id, build_status(failed));
                throw;
            }
            std::string accepted = "{\"running\":true,\"job_id\":";
            append_escaped(accepted, "j" + std::to_string(job_id));
            accepted += "}";
            send_response(client, 202, "application/json", accepted);
        }
        catch (const std::exception& error)
        {
            std::string payload = "{\"error\":";
            append_escaped(payload, error.what());
            payload += "}";
            const int status = std::string(error.what()) == "a solve is already running" ? 409 : 400;
            send_response(client, status, "application/json", payload);
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
    else if (line.rfind("GET /browse.js", 0) == 0)
    {
        path = "/browse.js";
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
    char buffer[4096];
    const DWORD length = GetModuleFileNameA(nullptr, buffer, static_cast<DWORD>(sizeof(buffer)));
    if (length == 0 || length >= sizeof(buffer))
    {
        return ".";
    }
    std::string path(buffer, buffer + length);
    const std::size_t slash = path.find_last_of("\\/");
    if (slash == std::string::npos)
    {
        return ".";
    }
    return path.substr(0, slash);
#else
    char buffer[4096];
    const ssize_t length = ::readlink("/proc/self/exe", buffer, sizeof(buffer) - 1);
    if (length <= 0 || static_cast<std::size_t>(length) >= sizeof(buffer) - 1)
    {
        return ".";
    }
    std::string path(buffer, buffer + static_cast<std::size_t>(length));
    const std::size_t slash = path.find_last_of('/');
    if (slash == std::string::npos)
    {
        return ".";
    }
    return path.substr(0, slash);
#endif
}

void choose_ui_root()
{
    const std::string exe = executable_directory();
    const std::string candidates[] = {
        "ui",
        exe + "\\ui",
        exe + "\\..\\ui",
        exe + "\\..\\..\\ui",
        exe + "/ui",
        exe + "/../ui",
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

int run(int argc, char** argv)
{
    poker::explorer::ValueWorker values(
        g_session,
        [](const std::shared_ptr<void>& resource,
            const poker::explorer::ValueRequest& request,
            const std::atomic<bool>& cancel)
        {
            if (cancel.load())
            {
                throw poker::solver::StreetValueCancelled();
            }
            const std::shared_ptr<HeldSolution> held = std::static_pointer_cast<HeldSolution>(resource);
            if (request.kind == "equity" && held->river)
            {
                poker::solver::StreetNodeEquity page;
                page.node_id = "root";
                page.units = poker::holdem::kEquityUnits;
                page.model = poker::holdem::kEquityModel;
                const auto started = std::chrono::steady_clock::now();
                const poker::holdem::ShowdownEquityOptions options = equity_options(cancel);
                const poker::holdem::ShowdownEquity equity = poker::holdem::showdown_equity(
                    held->job.board, held->job.oop, held->job.ip, options);
                page.defined = equity.joint_defined && equity.player0.defined && equity.player1.defined;
                std::vector<poker::holdem::EquityDistributionBucket> oop_distribution;
                std::vector<poker::holdem::EquityDistributionBucket> ip_distribution;
                if (page.defined)
                {
                    page.oop_equity = equity.player0.equity;
                    page.ip_equity = equity.player1.equity;
                    oop_distribution = poker::holdem::equity_distribution(equity.player0);
                    ip_distribution = poker::holdem::equity_distribution(equity.player1);
                }
                else
                {
                    oop_distribution = poker::holdem::equity_distribution(
                        std::span<const double>{}, std::span<const double>{});
                    ip_distribution = oop_distribution;
                }
                page.query_seconds = std::chrono::duration<double>(
                    std::chrono::steady_clock::now() - started).count();
                if (cancel.load() || g_session.current_solution() != request.solution_id)
                {
                    throw poker::solver::StreetValueCancelled();
                }
                return json_node_equity(
                    page,
                    request.solution_id,
                    request.job_id,
                    g_session.generation(),
                    oop_distribution,
                    ip_distribution);
            }
            if (held->river)
            {
                if (request.kind == "runout")
                {
                    throw std::invalid_argument("runout values require a chance node");
                }
                if (request.kind == "equity")
                {
                    throw std::invalid_argument("river equity is requested on /equity");
                }
                const poker::solver::StreetActionValues page =
                    held->river->action_values(request.node_id, &cancel);
                if (cancel.load() || g_session.current_solution() != request.solution_id)
                {
                    throw poker::solver::StreetValueCancelled();
                }
                return json_action_values(page, request.solution_id, request.job_id, g_session.generation());
            }
            if (!held->street)
            {
                throw std::invalid_argument("this solution has no nodes");
            }
            if (request.kind == "runout")
            {
                const poker::solver::StreetRunoutValues page = held->street->runout_values(request.node_id, &cancel);
                if (cancel.load() || g_session.current_solution() != request.solution_id)
                {
                    throw poker::solver::StreetValueCancelled();
                }
                return json_runout_values(page, request.solution_id, request.job_id, g_session.generation());
            }
            if (request.kind == "equity")
            {
                const auto started = std::chrono::steady_clock::now();
                const poker::solver::StreetReachWeights weights = held->street->reaching_weights(request.node_id);
                poker::solver::StreetNodeEquity page;
                page.node_id = request.node_id;
                page.units = poker::holdem::kEquityUnits;
                page.model = poker::holdem::kEquityModel;
                std::vector<poker::holdem::EquityDistributionBucket> oop_distribution =
                    poker::holdem::equity_distribution(
                        std::span<const double>{}, std::span<const double>{});
                std::vector<poker::holdem::EquityDistributionBucket> ip_distribution = oop_distribution;
                if (!weights.oop.empty() && !weights.ip.empty())
                {
                    const poker::holdem::ShowdownEquityOptions options = equity_options(cancel);
                    const poker::holdem::ShowdownEquity equity = poker::holdem::showdown_equity(
                        weights.board,
                        poker::holdem::Range::parse(weights.oop),
                        poker::holdem::Range::parse(weights.ip),
                        options);
                    page.defined = equity.joint_defined && equity.player0.defined && equity.player1.defined;
                    if (page.defined)
                    {
                        page.oop_equity = equity.player0.equity;
                        page.ip_equity = equity.player1.equity;
                        oop_distribution = poker::holdem::equity_distribution(equity.player0);
                        ip_distribution = poker::holdem::equity_distribution(equity.player1);
                    }
                }
                page.query_seconds = std::chrono::duration<double>(
                    std::chrono::steady_clock::now() - started).count();
                if (cancel.load() || g_session.current_solution() != request.solution_id)
                {
                    throw poker::solver::StreetValueCancelled();
                }
                return json_node_equity(
                    page,
                    request.solution_id,
                    request.job_id,
                    g_session.generation(),
                    oop_distribution,
                    ip_distribution);
            }
            const poker::solver::StreetActionValues page = held->street->action_values(request.node_id, &cancel);
            if (cancel.load() || g_session.current_solution() != request.solution_id)
            {
                throw poker::solver::StreetValueCancelled();
            }
            return json_action_values(page, request.solution_id, request.job_id, g_session.generation());
        },
        [](const std::string& what, const poker::explorer::ValueRequest& request)
        {
            return json_value_error(
                what, request.solution_id, request.job_id, request.node_id, g_session.generation());
        });
    g_values = &values;
    struct Teardown
    {
        ~Teardown()
        {
            if (g_values != nullptr)
            {
                g_values->shutdown();
                g_values = nullptr;
            }
            if (g_worker.joinable())
            {
                g_worker.join();
            }
        }
    } teardown;

    int port = 8765;
    if (const char* env_limit = std::getenv("POKER_EQUITY_MAX_PAIR_RUNOUTS"))
    {
        std::uint64_t parsed = 0;
        if (!parse_u64(env_limit, parsed))
        {
            std::cerr << "invalid POKER_EQUITY_MAX_PAIR_RUNOUTS\n";
            return 1;
        }
        g_equity_max_pair_runouts = parsed;
    }
    for (int i = 1; i < argc; ++i)
    {
        const std::string arg = argv[i];
        if (arg == "--port" && i + 1 < argc)
        {
            port = std::atoi(argv[++i]);
        }
        else if (arg == "--max-pair-runouts" && i + 1 < argc)
        {
            std::uint64_t parsed = 0;
            if (!parse_u64(argv[++i], parsed))
            {
                std::cerr << "invalid --max-pair-runouts\n";
                return 1;
            }
            g_equity_max_pair_runouts = parsed;
        }
    }
    choose_ui_root();
    g_templates_root = poker::explorer::resolve_templates_directory(executable_directory());
    g_ranges_root = poker::explorer::resolve_ranges_directory(executable_directory());

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
    std::cout << "recent "
              << poker::explorer::resolve_recent_file_path().string() << "\n";
    if (!g_templates_root.empty())
    {
        std::cout << "templates " << g_templates_root.string() << "\n";
    }
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

} // namespace explorer_detail

int main(int argc, char** argv)
{
    return explorer_detail::run(argc, argv);
}
