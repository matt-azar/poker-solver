#include "server_shared.hpp"

#include <algorithm>
#include <cctype>
#include <charconv>
#include <cmath>
#include <condition_variable>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <limits>
#include <mutex>
#include <optional>
#include <span>
#include <sstream>
#include <stdexcept>
#include <system_error>

namespace explorer_detail
{

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
    options.max_pair_runouts = g_app.equity_max_pair_runouts;
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
    job.pot = poker::chips_to_tenths(read_number(text, "pot", 100));
    job.stack = poker::chips_to_tenths(read_number(text, "stack", 200));
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
    // Present empty raise arrays stay empty (separate from bets). Absent keys
    // still copy that player's bet list when raise multiples are also empty.
    const bool oop_raises_present = find_key(text, "oop_raises") != std::string::npos;
    const bool ip_raises_present = find_key(text, "ip_raises") != std::string::npos;
    job.oop_raises = optional_sizes(text, "oop_raises");
    job.ip_raises = optional_sizes(text, "ip_raises");
    job.oop_flop_bets = optional_sizes(text, "oop_flop_bets");
    job.oop_turn_bets = optional_sizes(text, "oop_turn_bets");
    job.oop_river_bets = optional_sizes(text, "oop_river_bets");
    job.ip_flop_bets = optional_sizes(text, "ip_flop_bets");
    job.ip_turn_bets = optional_sizes(text, "ip_turn_bets");
    job.ip_river_bets = optional_sizes(text, "ip_river_bets");
    job.oop_donk = optional_sizes(text, "oop_donk");
    job.oop_raise_multiples = optional_sizes(text, "oop_raise_multiples");
    job.ip_raise_multiples = optional_sizes(text, "ip_raise_multiples");
    if (!oop_raises_present && job.oop_raises.empty() && job.oop_raise_multiples.empty())
    {
        job.oop_raises = job.oop_bets;
    }
    if (!ip_raises_present && job.ip_raises.empty() && job.ip_raise_multiples.empty())
    {
        job.ip_raises = job.ip_bets;
    }
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
    job.rake_rate = read_number(text, "rake_rate", 0);
    job.rake_cap = read_number(text, "rake_cap", 0);
    if (!std::isfinite(job.rake_rate) || job.rake_rate < 0.0 || job.rake_rate > 1.0)
    {
        throw std::invalid_argument("rake_rate must be a number in [0, 1]");
    }
    if (!std::isfinite(job.rake_cap) || job.rake_cap < 0.0)
    {
        throw std::invalid_argument("rake_cap must be a non-negative number of chips");
    }
    job.icm_stacks = optional_sizes(text, "icm_stacks");
    job.icm_payouts = optional_sizes(text, "icm_payouts");
    {
        poker::solver::IcmConfig icm;
        icm.stacks = job.icm_stacks;
        icm.payouts = job.icm_payouts;
        icm.validate(job.pot, job.stack);
    }
    job.incentives = poker::explorer::parse_incentive_config_json(text);
    job.max_raises = static_cast<int>(read_number(text, "max_raises", 2));
    job.iterations = static_cast<int>(read_number(text, "iterations", 200));
    job.samples = static_cast<int>(read_number(text, "samples", 5));
    if (find_key(text, "tree_edits") != std::string::npos)
    {
        // Accept either a single TreeEditSet text blob or an array of edit lines.
        const std::size_t at = find_key(text, "tree_edits");
        const std::size_t value = value_at(text, at);
        if (value < text.size() && text[value] == '[')
        {
            std::string joined;
            for (const std::string& line : read_string_array(text, "tree_edits"))
            {
                if (line.empty())
                {
                    continue;
                }
                joined += line;
                if (joined.back() != '\n')
                {
                    joined += '\n';
                }
            }
            if (!joined.empty())
            {
                job.tree_edits = poker::solver::parse_tree_edits(joined);
            }
        }
        else
        {
            const std::string edits_text = read_string(text, "tree_edits", "");
            if (!edits_text.empty())
            {
                job.tree_edits = poker::solver::parse_tree_edits(edits_text);
            }
        }
    }
    const std::string algorithm = read_string(text, "algorithm", "cfr_plus");
    if (algorithm == "vanilla" || algorithm == "vanilla_cfr")
    {
        job.algorithm = poker::solver::Algorithm::VanillaCfr;
    }
    else if (algorithm == "cfr_plus" || algorithm == "cfr+")
    {
        job.algorithm = poker::solver::Algorithm::CfrPlus;
    }
    else if (algorithm == "dcfr")
    {
        job.algorithm = poker::solver::Algorithm::Dcfr;
    }
    else if (algorithm == "pcfr_plus")
    {
        job.algorithm = poker::solver::Algorithm::PcfrPlus;
    }
    else
    {
        throw std::invalid_argument("unknown algorithm");
    }
    if ((job.algorithm == poker::solver::Algorithm::Dcfr
            || job.algorithm == poker::solver::Algorithm::PcfrPlus)
        && !job.frozen)
    {
        throw std::invalid_argument("dcfr/pcfr_plus requires the frozen combo pass");
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
    out += poker::format_chips(job.pot);
    out += ",\"stack\":";
    out += poker::format_chips(job.stack);
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
    out += ",\"rake_rate\":";
    out += format_number(job.rake_rate);
    out += ",\"rake_cap\":";
    out += format_number(job.rake_cap);
    out += ",\"icm_stacks\":[";
    for (std::size_t i = 0; i < job.icm_stacks.size(); ++i)
    {
        if (i > 0)
        {
            out += ',';
        }
        out += format_number(job.icm_stacks[i]);
    }
    out += "],\"icm_payouts\":[";
    for (std::size_t i = 0; i < job.icm_payouts.size(); ++i)
    {
        if (i > 0)
        {
            out += ',';
        }
        out += format_number(job.icm_payouts[i]);
    }
    out += "],";
    poker::explorer::append_incentive_config_json(out, job.incentives);
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
    config.rake.rate = job.rake_rate;
    config.rake.cap = job.rake_cap;
    config.icm.stacks = job.icm_stacks;
    config.icm.payouts = job.icm_payouts;
    config.incentives = job.incentives;
    config.memory_mib = job.memory_mib;
    config.threads = job.threads;
    config.tree_edits = job.tree_edits;
    return config;
}

void append_tree_edits_json(std::string& out, const poker::solver::TreeEditSet& edits)
{
    out += "\"tree_edits\":[";
    if (!edits.empty())
    {
        const std::string text = poker::solver::format_tree_edits(edits);
        std::size_t cursor = 0;
        bool first = true;
        while (cursor < text.size())
        {
            std::size_t end = text.find('\n', cursor);
            if (end == std::string::npos)
            {
                end = text.size();
            }
            const std::string line = text.substr(cursor, end - cursor);
            cursor = end < text.size() ? end + 1 : end;
            if (line.empty())
            {
                continue;
            }
            if (!first)
            {
                out += ',';
            }
            first = false;
            append_escaped(out, line);
        }
    }
    out += ']';
}

std::string memory_plan_json(const poker::solver::StreetMemoryPlan& plan)
{
    std::string out = "{\"estimated_peak_bytes\":";
    out += std::to_string(plan.estimated_peak_bytes);
    out += ",\"memory_budget_bytes\":";
    out += std::to_string(plan.memory_budget_bytes);
    out += ",\"deals\":";
    out += std::to_string(plan.deals);
    out += ",\"infosets\":";
    out += std::to_string(plan.infosets);
    out += ",\"decision_nodes\":";
    out += std::to_string(plan.decision_nodes);
    out += ",\"terminals\":";
    out += std::to_string(plan.terminals);
    out += ",\"public_decisions\":";
    out += std::to_string(plan.public_decisions);
    out += ",\"threads\":";
    out += std::to_string(plan.thread_count);
    out += ",\"fits_budget\":";
    out += poker::solver::plan_fits_budget(plan) ? "true" : "false";
    out += ",\"dry_run\":";
    out += plan.dry_run ? "true" : "false";
    out += '}';
    return out;
}

std::string public_tree_json(
    const std::vector<poker::solver::StreetPublicNode>& nodes,
    const poker::solver::TreeEditSet& edits)
{
    std::string out = "{\"nodes\":[";
    for (std::size_t i = 0; i < nodes.size(); ++i)
    {
        if (i > 0)
        {
            out += ',';
        }
        const poker::solver::StreetPublicNode& node = nodes[i];
        out += "{\"index\":";
        out += std::to_string(node.index);
        out += ",\"terminal\":";
        out += node.terminal ? "true" : "false";
        out += ",\"chance\":";
        out += node.chance ? "true" : "false";
        out += ",\"player\":";
        out += std::to_string(node.player);
        out += ",\"street\":";
        out += std::to_string(node.street);
        out += ",\"path\":";
        append_escaped(out, node.path);
        out += ",\"chance_child\":";
        out += std::to_string(node.chance_child);
        out += ",\"actions\":[";
        for (std::size_t a = 0; a < node.actions.size(); ++a)
        {
            if (a > 0)
            {
                out += ',';
            }
            out += "{\"label\":";
            append_escaped(out, node.actions[a].label);
            out += ",\"compact\":";
            append_escaped(out, node.actions[a].compact);
            out += ",\"child_index\":";
            out += std::to_string(node.actions[a].child_index);
            out += '}';
        }
        out += "],\"children\":[";
        for (std::size_t c = 0; c < node.children.size(); ++c)
        {
            if (c > 0)
            {
                out += ',';
            }
            out += std::to_string(node.children[c]);
        }
        out += "]}";
    }
    out += "],";
    append_tree_edits_json(out, edits);
    out += '}';
    return out;
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

std::string json_strategy_edits(const poker::solver::StrategyEditSet& edits)
{
    std::string out = "{\"edits\":[";
    const std::vector<std::size_t> ids = edits.infoset_ids();
    for (std::size_t i = 0; i < ids.size(); ++i)
    {
        const poker::solver::StrategyEdit* edit = edits.find(ids[i]);
        if (edit == nullptr)
        {
            continue;
        }
        if (i > 0)
        {
            out += ',';
        }
        out += "{\"node_id\":";
        append_escaped(out, node_id_for_infoset(edit->infoset_id));
        out += ",\"infoset_id\":";
        out += std::to_string(edit->infoset_id);
        out += ",\"kind\":";
        append_escaped(
            out, edit->kind == poker::solver::StrategyEditKind::FullNode ? "full" : "selected");
        out += ",\"hand_indices\":[";
        for (std::size_t h = 0; h < edit->hand_indices.size(); ++h)
        {
            if (h > 0)
            {
                out += ',';
            }
            out += std::to_string(edit->hand_indices[h]);
        }
        out += "],\"probs\":[";
        for (std::size_t a = 0; a < edit->probs.size(); ++a)
        {
            if (a > 0)
            {
                out += ',';
            }
            out += format_number(edit->probs[a]);
        }
        out += "]}";
    }
    out += "],\"persisted\":false}";
    return out;
}

poker::solver::StreetInspection inspect_held_node(HeldSolution& held, const std::string& node_id)
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
}

void set_held_average_strategy(
    HeldSolution& held,
    const std::string& node_id,
    int hand,
    std::span<const double> probs)
{
    if (held.street)
    {
        held.street->set_average_strategy(node_id, hand, probs);
        return;
    }
    if (held.river)
    {
        held.river->set_average_strategy(node_id, hand, probs);
        return;
    }
    throw std::invalid_argument("solution has no solver");
}

void invalidate_held_average(HeldSolution& held)
{
    if (held.street)
    {
        held.street->invalidate_prepared_average();
    }
    else if (held.river)
    {
        held.river->invalidate_prepared_average();
    }
}

void apply_strategy_edit_row(
    HeldSolution& held,
    const std::string& node_id,
    const poker::solver::StrategyEdit& edit,
    const poker::solver::StreetInspection& view)
{
    const std::span<const double> probs(edit.probs.data(), edit.probs.size());
    if (edit.kind == poker::solver::StrategyEditKind::FullNode)
    {
        for (std::size_t hand = 0; hand < view.hands.size(); ++hand)
        {
            if (!view.hands[hand].structural)
            {
                continue;
            }
            set_held_average_strategy(held, node_id, static_cast<int>(hand), probs);
        }
        return;
    }
    for (const std::size_t hand : edit.hand_indices)
    {
        if (hand >= view.hands.size())
        {
            throw std::invalid_argument("hand index out of range");
        }
        if (!view.hands[hand].structural)
        {
            throw std::invalid_argument("hand has no information set on this node");
        }
        set_held_average_strategy(held, node_id, static_cast<int>(hand), probs);
    }
}

void reapply_strategy_edits(HeldSolution& held)
{
    invalidate_held_average(held);
    for (const std::size_t infoset_id : held.strategy_edits.infoset_ids())
    {
        const poker::solver::StrategyEdit* edit = held.strategy_edits.find(infoset_id);
        if (edit == nullptr)
        {
            continue;
        }
        const std::string node_id = node_id_for_infoset(infoset_id);
        const poker::solver::StreetInspection view = inspect_held_node(held, node_id);
        apply_strategy_edit_row(held, node_id, *edit, view);
    }
}

void clear_strategy_edits(HeldSolution& held)
{
    if (held.strategy_edits.empty())
    {
        invalidate_held_average(held);
        return;
    }
    held.strategy_edits.clear();
    invalidate_held_average(held);
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
    try
    {
        if (source.street)
        {
            // Float→float copy; no TrainingTables double intermediate.
            copy->street = std::make_shared<poker::solver::StreetBatchSolver>(source.street->config());
            copy->street->copy_training_state_from(*source.street);
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
    }
    catch (const std::bad_alloc&)
    {
        throw std::runtime_error("baseline clone could not fit in memory");
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
    // StreetInspection stores tenths; public JSON matches status chip units.
    out += ",\"pot\":";
    out += poker::format_chips(view.pot);
    out += ",\"contrib\":[";
    out += poker::format_chips(view.contrib[0]);
    out += ',';
    out += poker::format_chips(view.contrib[1]);
    out += "],\"stacks\":[";
    out += poker::format_chips(view.stacks[0]);
    out += ',';
    out += poker::format_chips(view.stacks[1]);
    out += "],\"stack\":";
    out += poker::format_chips(
        view.stacks[0] < view.stacks[1] ? view.stacks[0] : view.stacks[1]);
    out += ",\"to_call\":";
    out += poker::format_chips(view.to_call);
    out += ",\"parent_id\":";
    if (view.parent_id.empty())
    {
        out += "null";
    }
    else
    {
        append_escaped(out, view.parent_id);
    }
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
    out += "],\"opponent_player\":";
    out += view.opponent_player < 0 ? "null" : std::to_string(view.opponent_player);
    out += ",\"opponent_combos\":[";
    for (std::size_t i = 0; i < view.opponent_hands.size(); ++i)
    {
        if (i > 0)
        {
            out += ',';
        }
        append_escaped(out, view.opponent_hands[i].combo);
    }
    out += "],\"opponent_reach\":[";
    for (std::size_t i = 0; i < view.opponent_hands.size(); ++i)
    {
        if (i > 0)
        {
            out += ',';
        }
        out += format_number(view.opponent_hands[i].reach);
    }
    out += "],\"opponent_marginal\":";
    if (!view.reach_defined || view.opponent_hands.empty())
    {
        out += "null";
    }
    else
    {
        out += '[';
        for (std::size_t i = 0; i < view.opponent_hands.size(); ++i)
        {
            if (i > 0)
            {
                out += ',';
            }
            out += format_number(view.opponent_hands[i].marginal);
        }
        out += ']';
    }
    out += ",\"cards\":[";
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
    out += ",\"local_offset\":";
    out += format_number(page.local_offset);
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
    const std::vector<poker::holdem::EquityDistributionBucket>& oop_distribution,
    const std::vector<poker::holdem::EquityDistributionBucket>& ip_distribution,
    const std::vector<poker::holdem::EquityHandRow>& oop_hands,
    const std::vector<poker::holdem::EquityHandRow>& ip_hands)
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
    // Compact combo rows for study filtering / composition (check-down only).
    out += ",\"oop_hands\":";
    out += poker::holdem::equity_hand_rows_json(oop_hands);
    out += ",\"ip_hands\":";
    out += poker::holdem::equity_hand_rows_json(ip_hands);
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
    // Made-hand (river) or multi-label draw/backdoor (flop/turn) composition.
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


void respond_value_query(
    socket_t client,
    std::uint64_t solution_id,
    std::uint64_t job_id,
    const std::string& node_id,
    std::chrono::steady_clock::time_point started,
    const std::string& kind)
{
    const std::uint64_t generation = g_app.session.generation();
    poker::explorer::ValueRequest request;
    request.solution_id = solution_id;
    request.job_id = job_id;
    request.node_id = node_id;
    request.kind = kind;
    const poker::explorer::ValueReply reply = g_app.values->submit(request);
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
    draft.generation = g_app.session.generation() + 1;
    return draft;
}


}  // namespace explorer_detail
