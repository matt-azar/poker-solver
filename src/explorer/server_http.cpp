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
    if (path.size() >= 4 && path.substr(path.size() - 4) == ".svg")
    {
        return "image/svg+xml";
    }
    if (path.size() >= 5 && path.substr(path.size() - 5) == ".json")
    {
        return "application/json";
    }
    if (path.size() >= 4 && path.substr(path.size() - 4) == ".map")
    {
        return "application/json";
    }
    if ((path.size() >= 3 && path.substr(path.size() - 3) == ".js")
        || (path.size() >= 4 && path.substr(path.size() - 4) == ".mjs"))
    {
        return "text/javascript; charset=utf-8";
    }
    return "application/octet-stream";
}

bool safe_static_asset_path(const std::string& path)
{
    if (path.rfind("/assets/", 0) != 0 || path.size() <= 8)
    {
        return false;
    }
    for (std::size_t index = 8; index < path.size(); ++index)
    {
        const unsigned char ch = static_cast<unsigned char>(path[index]);
        const bool ok = (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')
            || (ch >= '0' && ch <= '9') || ch == '.' || ch == '_' || ch == '-' || ch == '/';
        if (!ok)
        {
            return false;
        }
    }
    return path.find("..") == std::string::npos;
}

// Study UI in the Tauri webview is cross-origin (https://tauri.localhost →
// http://127.0.0.1:8765). Without these headers the browser reports
// TypeError: Failed to fetch even when the sidecar is listening.
constexpr const char* kCorsHeaders =
    "Access-Control-Allow-Origin: *\r\n"
    "Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS\r\n"
    "Access-Control-Allow-Headers: Content-Type\r\n"
    "Access-Control-Allow-Private-Network: true\r\n";

void send_response(
    socket_t client,
    int status,
    const std::string& type,
    const std::string& body,
    const std::string& extra_headers)
{
    const char* reason = status == 200 ? "OK"
        : status == 202 ? "Accepted"
        : status == 204 ? "No Content"
        : status == 404 ? "Not Found"
        : status == 409 ? "Conflict"
        : "Bad Request";
    std::string header = "HTTP/1.1 " + std::to_string(status) + " " + reason + "\r\n";
    header += "Content-Type: " + type + "\r\n";
    header += "Content-Length: " + std::to_string(body.size()) + "\r\n";
    header += "Cache-Control: no-store\r\n";
    header += kCorsHeaders;
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

std::uint8_t algorithm_code(poker::solver::Algorithm algorithm)
{
    return poker::solver::algorithm_tag(algorithm);
}

poker::solver::Algorithm algorithm_from_code(std::uint8_t code)
{
    return poker::solver::algorithm_from_tag(code);
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
    job.oop_flop_raises = config.oop_flop_raises;
    job.oop_turn_raises = config.oop_turn_raises;
    job.oop_river_raises = config.oop_river_raises;
    job.ip_flop_raises = config.ip_flop_raises;
    job.ip_turn_raises = config.ip_turn_raises;
    job.ip_river_raises = config.ip_river_raises;
    job.oop_donk = config.oop_donk_sizes;
    job.oop_flop_donk = config.oop_flop_donk;
    job.oop_turn_donk = config.oop_turn_donk;
    job.oop_river_donk = config.oop_river_donk;
    job.oop_raise_multiples = config.oop_raise_multiples;
    job.merge_threshold = config.merge_threshold;
    job.ip_raise_multiples = config.ip_raise_multiples;
    job.pot_cap = config.pot_cap;
    job.allow_three_bet = config.allow_three_bet;
    job.allow_all_in = config.allow_all_in;
    job.all_in_threshold = config.all_in_threshold;
    job.max_raises = config.max_raises;
    job.rake_rate = config.rake.rate;
    job.rake_cap = config.rake.cap;
    job.icm_stacks = config.icm.stacks;
    job.icm_payouts = config.icm.payouts;
    job.incentives = config.incentives;
    job.memory_mib = config.memory_mib;
    job.threads = config.threads;
    job.tree_edits = config.tree_edits;
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
    job.rake_rate = config.rake.rate;
    job.rake_cap = config.rake.cap;
    job.icm_stacks = config.icm.stacks;
    job.icm_payouts = config.icm.payouts;
    job.incentives = config.incentives;
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
        // Identity only; Save streams float tables via CheckpointScalarTables.
        held.street->export_training_identity(document.tables);
        if (held.job.algorithm == poker::solver::Algorithm::Dcfr)
        {
            document.has_dcfr_params = true;
            document.dcfr = held.street->dcfr_params();
        }
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

void write_held_checkpoint(const std::string& path, const HeldSolution& held)
{
    poker::explorer::CheckpointDocument document = checkpoint_from_held(held);
    if (held.street)
    {
        poker::explorer::CheckpointScalarTables scalars;
        scalars.regret = held.street->regret_table();
        scalars.strategy_sum = held.street->strategy_sum_table();
        if (held.job.algorithm == poker::solver::Algorithm::PcfrPlus)
        {
            scalars.prediction = held.street->prediction_table();
        }
        poker::explorer::write_checkpoint(
            path,
            document,
            poker::explorer::CheckpointFault::None,
            poker::explorer::kMaxCheckpointBytes,
            &scalars);
        return;
    }
    poker::explorer::write_checkpoint(
        path,
        document,
        poker::explorer::CheckpointFault::None,
        poker::explorer::kMaxCheckpointBytes);
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
    const poker::solver::Algorithm loaded_algorithm = algorithm_from_code(document.algorithm);
    if ((loaded_algorithm == poker::solver::Algorithm::Dcfr
            || loaded_algorithm == poker::solver::Algorithm::PcfrPlus)
        && !document.frozen)
    {
        throw std::invalid_argument(
            "dcfr/pcfr_plus checkpoint requires the frozen combo pass");
    }
    if (document.kind == 1)
    {
        const poker::streets::StreetConfig config = poker::streets::parse_street_config(document.config_text);
        held->job = job_from_street(config);
        held->street = std::make_shared<poker::solver::StreetBatchSolver>(config);
        held->street->install_training_tables(document.tables);
        held->street->bind_training_algorithm(loaded_algorithm);
        if (document.has_dcfr_params)
        {
            held->street->set_dcfr_params(document.dcfr);
        }
        if (!document.prediction.empty())
        {
            held->street->install_prediction_table(document.prediction);
        }
        held->street->prepare_inspection();
        held->root_id = held->street->root_node_id();
        held->memory = held->street->memory_report();
        held->has_memory = true;
    }
    else if (document.kind == 2)
    {
        if (loaded_algorithm == poker::solver::Algorithm::Dcfr
            || loaded_algorithm == poker::solver::Algorithm::PcfrPlus)
        {
            throw std::invalid_argument(
                "DCFR/PCFR+ is not supported on legacy river-kind checkpoints; use a street-kind solve");
        }
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
    held->job.algorithm = loaded_algorithm;
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

void append_size_array_json(std::string& out, const char* key, const std::vector<double>& sizes)
{
    out += ",\"";
    out += key;
    out += "\":[";
    for (std::size_t index = 0; index < sizes.size(); ++index)
    {
        if (index > 0)
        {
            out += ',';
        }
        out += format_number(sizes[index]);
    }
    out += ']';
}

// Structured spot config for an opened / completed solution so Study Open can
// replace the Build draft wholesale (ranges, bets, tree edits, optional settings).
std::string solution_config_json(const HeldSolution& held)
{
    if (!held.street && !held.river)
    {
        throw std::invalid_argument("solution has no solver");
    }
    const Job& job = held.job;
    const bool street = held.street != nullptr;
    std::string payload = "{\"kind\":";
    payload += street ? "\"street\"" : "\"river\"";
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
    payload += poker::format_chips(job.pot);
    payload += ",\"stack\":";
    payload += poker::format_chips(job.stack);
    payload += ",\"oop_range\":";
    append_escaped(payload, job.oop.to_combo_list());
    payload += ",\"ip_range\":";
    append_escaped(payload, job.ip.to_combo_list());
    payload += ",\"max_raises\":";
    payload += std::to_string(job.max_raises);
    payload += ",\"allow_all_in\":";
    payload += job.allow_all_in ? "true" : "false";
    append_size_array_json(payload, "oop_bets", job.oop_bets);
    append_size_array_json(payload, "ip_bets", job.ip_bets);
    append_size_array_json(payload, "oop_raises", job.oop_raises);
    append_size_array_json(payload, "ip_raises", job.ip_raises);
    append_size_array_json(payload, "oop_raise_multiples", job.oop_raise_multiples);
    append_size_array_json(payload, "ip_raise_multiples", job.ip_raise_multiples);
    if (street)
    {
        payload += ",\"allow_three_bet\":";
        payload += job.allow_three_bet ? "true" : "false";
        payload += ",\"pot_cap\":";
        payload += format_number(job.pot_cap);
        payload += ",\"all_in_threshold\":";
        payload += format_number(job.all_in_threshold);
        payload += ",\"memory_mib\":";
        payload += std::to_string(job.memory_mib);
        payload += ",\"threads\":";
        payload += std::to_string(job.threads);
        append_size_array_json(payload, "oop_flop_bets", job.oop_flop_bets);
        append_size_array_json(payload, "ip_flop_bets", job.ip_flop_bets);
        append_size_array_json(payload, "oop_turn_bets", job.oop_turn_bets);
        append_size_array_json(payload, "ip_turn_bets", job.ip_turn_bets);
        append_size_array_json(payload, "oop_river_bets", job.oop_river_bets);
        append_size_array_json(payload, "ip_river_bets", job.ip_river_bets);
        append_size_array_json(payload, "oop_flop_raises", job.oop_flop_raises);
        append_size_array_json(payload, "ip_flop_raises", job.ip_flop_raises);
        append_size_array_json(payload, "oop_turn_raises", job.oop_turn_raises);
        append_size_array_json(payload, "ip_turn_raises", job.ip_turn_raises);
        append_size_array_json(payload, "oop_river_raises", job.oop_river_raises);
        append_size_array_json(payload, "ip_river_raises", job.ip_river_raises);
        append_size_array_json(payload, "oop_donk", job.oop_donk);
        append_size_array_json(payload, "oop_flop_donk", job.oop_flop_donk);
        append_size_array_json(payload, "oop_turn_donk", job.oop_turn_donk);
        append_size_array_json(payload, "oop_river_donk", job.oop_river_donk);
        payload += ",\"merge_threshold\":";
        payload += format_number(job.merge_threshold);
        payload += ',';
        append_tree_edits_json(payload, job.tree_edits);
    }
    payload += ",\"algorithm\":";
    append_escaped(payload, poker::solver::algorithm_name(job.algorithm));
    payload += ",\"frozen\":";
    payload += job.frozen ? "true" : "false";
    payload += ",\"samples\":";
    payload += std::to_string(job.samples);
    payload += ",\"accuracy\":";
    payload += format_number(job.accuracy);
    payload += ",\"time_limit\":";
    if (job.time_limit < 0.0)
    {
        payload += "null";
    }
    else
    {
        payload += format_number(job.time_limit);
    }
    payload += ",\"iterations\":";
    payload += std::to_string(job.iterations);
    payload += ",\"rake_rate\":";
    payload += format_number(job.rake_rate);
    payload += ",\"rake_cap\":";
    payload += format_number(job.rake_cap);
    payload += ",\"icm_stacks\":[";
    for (std::size_t i = 0; i < job.icm_stacks.size(); ++i)
    {
        if (i > 0)
        {
            payload += ',';
        }
        payload += format_number(job.icm_stacks[i]);
    }
    payload += "],\"icm_payouts\":[";
    for (std::size_t i = 0; i < job.icm_payouts.size(); ++i)
    {
        if (i > 0)
        {
            payload += ',';
        }
        payload += format_number(job.icm_payouts[i]);
    }
    payload += "],";
    poker::explorer::append_incentive_config_json(payload, job.incentives);
    if (street)
    {
        payload += ",\"text\":";
        append_escaped(payload, poker::streets::format_street_config(held.street->config()));
    }
    else
    {
        payload += ",\"text\":";
        append_escaped(payload, poker::river::format_river_config(held.river->config()));
    }
    payload += '}';
    return payload;
}

std::string publish_loaded(const std::shared_ptr<HeldSolution>& held)
{
    // Build outside install_completed: draft_for reads g_app.session.generation(),
    // and the install callback already holds the session mutex.
    StatusDraft base = draft_for(
        held->job, 0, held->iterations, held->runtime_seconds, true,
        held->value, held->p1_best_response, held->p2_best_response, held->nash_gap,
        held->sample_iterations, held->sample_values, held->sample_gaps,
        held->has_memory ? &held->memory : nullptr);
    base.root_id = held->root_id;
    std::uint64_t solution_id = 0;
    std::string status;
    const bool installed = g_app.session.install_completed(held, solution_id, [&](std::uint64_t generation, std::uint64_t id)
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

    // Preflight for JSON POSTs/PUTs from the Tauri webview (and Private Network Access).
    if (line.rfind("OPTIONS ", 0) == 0)
    {
        send_response(client, 204, "text/plain", "");
        return;
    }

    if (line.rfind("GET /api/status", 0) == 0)
    {
        send_response(client, 200, "application/json", g_app.session.status());
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
            poker::explorer::list_templates(g_app.templates_root);
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
            poker::explorer::read_template(g_app.templates_root, id);
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
            poker::explorer::list_range_presets(g_app.ranges_root);
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
            payload += ",\"folder\":";
            append_escaped(payload, presets[index].folder);
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
        std::string id = end == std::string::npos ? rest : rest.substr(0, end);
        // Accept nested ids as path segments or a single %2F-encoded id.
        for (std::size_t index = 0; index + 2 < id.size(); ++index)
        {
            if (id[index] != '%')
            {
                continue;
            }
            const auto hex = [](char character) -> int
            {
                if (character >= '0' && character <= '9')
                {
                    return character - '0';
                }
                if (character >= 'a' && character <= 'f')
                {
                    return 10 + character - 'a';
                }
                if (character >= 'A' && character <= 'F')
                {
                    return 10 + character - 'A';
                }
                return -1;
            };
            const int high = hex(id[index + 1]);
            const int low = hex(id[index + 2]);
            if (high < 0 || low < 0)
            {
                continue;
            }
            id.replace(index, 3, 1, static_cast<char>((high << 4) | low));
        }
        if (!poker::explorer::is_safe_range_id(id))
        {
            send_response(client, 404, "application/json", "{\"error\":\"unknown range\"}");
            return;
        }
        const std::optional<std::string> text =
            poker::explorer::read_range_preset(g_app.ranges_root, id);
        if (!text.has_value())
        {
            send_response(client, 404, "application/json", "{\"error\":\"unknown range\"}");
            return;
        }
        std::string payload = "{\"id\":";
        append_escaped(payload, id);
        payload += ",\"folder\":";
        append_escaped(payload, poker::explorer::range_folder_of(id));
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
        poker::explorer::ReaderLease baseline_lease(g_app.session, g_app.session.borrow(baseline_id));
        poker::explorer::ReaderLease scenario_lease(g_app.session, g_app.session.borrow(scenario_id));
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
        if (g_app.session.running())
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
        bool warm_start = false;
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
            if (find_key(body, "warm_start") != std::string::npos)
            {
                warm_start = read_number(body, "warm_start", 0.0) != 0.0;
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
        if (g_app.values != nullptr)
        {
            g_app.values->cancel();
        }
        if (g_app.worker.joinable())
        {
            g_app.worker.join();
        }
        const poker::explorer::Session::Claim claim = g_app.session.claim_completed(id);
        if (!claim.allowed)
        {
            send_response(client, 404, "application/json", "{\"error\":\"expired solution\"}");
            return;
        }
        try
        {
            const std::shared_ptr<HeldSolution> held =
                std::static_pointer_cast<HeldSolution>(g_app.session.training_resource(claim.job_id));
            if (!held || !held->street)
            {
                g_app.session.abort_continuation(
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
            g_app.session.set_progress(claim.job_id, build_status(starting));
            g_app.worker = std::thread(
                [job_id = claim.job_id,
                    extra,
                    resolve_accuracy,
                    resolve_samples,
                    resolve_time_limit,
                    warm_start]()
                {
                    resolve_locked_job(
                        job_id,
                        extra,
                        resolve_accuracy,
                        resolve_samples,
                        resolve_time_limit,
                        warm_start);
                });
        }
        catch (const std::exception& error)
        {
            g_app.session.abort_continuation(
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
        accepted += warm_start ? ",\"warm_start\":1}" : ",\"warm_start\":0}";
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
        if (g_app.session.running())
        {
            send_response(client, 409, "application/json", "{\"error\":\"a solve is already running\"}");
            return;
        }
        poker::explorer::ReaderLease lease(g_app.session, g_app.session.borrow(id));
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
        if (g_app.session.running())
        {
            send_response(client, 409, "application/json", "{\"error\":\"a solve is already running\"}");
            return;
        }
        std::string node_id;
        bool have_hand_index = false;
        std::size_t hand_index = 0;
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
                const auto query_value = [&](const char* key) -> std::string
                {
                    const std::string needle = std::string(key) + "=";
                    const std::size_t at = after.find(needle);
                    if (at == std::string::npos)
                    {
                        return {};
                    }
                    const std::size_t start = at + needle.size();
                    const std::size_t amp = after.find('&', start);
                    const std::size_t space = after.find(' ', start);
                    const std::size_t end = std::min(
                        amp == std::string::npos ? after.size() : amp,
                        space == std::string::npos ? after.size() : space);
                    return after.substr(start, end - start);
                };
                node_id = query_value("node_id");
                const std::string hand_text = query_value("hand_index");
                if (!hand_text.empty())
                {
                    char* end = nullptr;
                    const unsigned long parsed = std::strtoul(hand_text.c_str(), &end, 10);
                    if (end == hand_text.c_str() || *end != '\0')
                    {
                        send_response(
                            client, 400, "application/json", "{\"error\":\"bad hand_index\"}");
                        return;
                    }
                    hand_index = static_cast<std::size_t>(parsed);
                    have_hand_index = true;
                }
            }
        }
        poker::explorer::ReaderLease lease(g_app.session, g_app.session.borrow(id));
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
                if (have_hand_index)
                {
                    const poker::solver::NodeLock* existing = held->locks.find(infoset_id);
                    if (existing != nullptr && existing->kind == poker::solver::LockKind::FullNode)
                    {
                        throw std::invalid_argument(
                            "full-node locks unlock with node_id only; omit hand_index");
                    }
                    held->locks.erase_combo(infoset_id, hand_index);
                }
                else
                {
                    held->locks.erase(infoset_id);
                }
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
    if (line.rfind("PUT /api/solutions/", 0) == 0 && line.find("/strategy-edits ") != std::string::npos)
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
        if (g_app.session.running())
        {
            send_response(client, 409, "application/json", "{\"error\":\"a solve is already running\"}");
            return;
        }
        g_app.session.wait_until_quiet();
        poker::explorer::ReaderLease lease(g_app.session, g_app.session.borrow(id));
        if (!lease)
        {
            send_response(client, 404, "application/json", "{\"error\":\"expired solution\"}");
            return;
        }
        try
        {
            auto held = std::static_pointer_cast<HeldSolution>(lease.resource());
            const std::string node_id = read_string(body, "node_id", "");
            const std::string kind = read_string(body, "kind", "selected");
            std::size_t infoset_id = 0;
            if (!parse_public_node_index(node_id, infoset_id))
            {
                throw std::invalid_argument("bad node_id");
            }
            const poker::solver::StreetInspection view = inspect_held_node(*held, node_id);
            if (view.kind != "decision")
            {
                throw std::invalid_argument("strategy edits apply only to decision nodes");
            }
            const int action_count = static_cast<int>(view.actions.size());
            const std::vector<double> probs = read_number_array(body, "probs");
            poker::solver::StrategyEdit edit;
            edit.infoset_id = infoset_id;
            edit.probs = poker::solver::make_strategy_probs(probs, action_count);
            if (kind == "full")
            {
                edit.kind = poker::solver::StrategyEditKind::FullNode;
            }
            else if (kind == "selected")
            {
                edit.kind = poker::solver::StrategyEditKind::SelectedCombos;
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
                    if (!view.hands[index].structural)
                    {
                        throw std::invalid_argument("hand has no information set on this node");
                    }
                    edit.hand_indices.push_back(index);
                }
            }
            else
            {
                throw std::invalid_argument("kind must be full or selected");
            }
            // Upsert then rebuild overlays so a selected row can replace a prior
            // full-node edit without leaving stale hands edited.
            held->strategy_edits.upsert(std::move(edit));
            reapply_strategy_edits(*held);
            send_response(client, 200, "application/json", json_strategy_edits(held->strategy_edits));
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
        && (line.find("/strategy-edits?") != std::string::npos
            || line.find("/strategy-edits/") != std::string::npos
            || line.find("/strategy-edits ") != std::string::npos))
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
        if (g_app.session.running())
        {
            send_response(client, 409, "application/json", "{\"error\":\"a solve is already running\"}");
            return;
        }
        std::string node_id;
        bool have_hand_index = false;
        std::size_t hand_index = 0;
        const std::size_t edits_at = rest.find("/strategy-edits");
        if (edits_at != std::string::npos)
        {
            const std::string after = rest.substr(edits_at + 15);
            if (!after.empty() && after[0] == '/')
            {
                const std::size_t end = after.find(' ');
                node_id = end == std::string::npos ? after.substr(1) : after.substr(1, end - 1);
            }
            else if (!after.empty() && after[0] == '?')
            {
                const auto query_value = [&](const char* key) -> std::string
                {
                    const std::string needle = std::string(key) + "=";
                    const std::size_t at = after.find(needle);
                    if (at == std::string::npos)
                    {
                        return {};
                    }
                    const std::size_t start = at + needle.size();
                    const std::size_t amp = after.find('&', start);
                    const std::size_t space = after.find(' ', start);
                    const std::size_t end = std::min(
                        amp == std::string::npos ? after.size() : amp,
                        space == std::string::npos ? after.size() : space);
                    return after.substr(start, end - start);
                };
                node_id = query_value("node_id");
                const std::string hand_text = query_value("hand_index");
                if (!hand_text.empty())
                {
                    char* end = nullptr;
                    const unsigned long parsed = std::strtoul(hand_text.c_str(), &end, 10);
                    if (end == hand_text.c_str() || *end != '\0')
                    {
                        send_response(
                            client, 400, "application/json", "{\"error\":\"bad hand_index\"}");
                        return;
                    }
                    hand_index = static_cast<std::size_t>(parsed);
                    have_hand_index = true;
                }
            }
        }
        g_app.session.wait_until_quiet();
        poker::explorer::ReaderLease lease(g_app.session, g_app.session.borrow(id));
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
                clear_strategy_edits(*held);
            }
            else
            {
                std::size_t infoset_id = 0;
                if (!parse_public_node_index(node_id, infoset_id))
                {
                    throw std::invalid_argument("bad node_id");
                }
                if (have_hand_index)
                {
                    const poker::solver::StrategyEdit* existing =
                        held->strategy_edits.find(infoset_id);
                    if (existing != nullptr
                        && existing->kind == poker::solver::StrategyEditKind::FullNode)
                    {
                        throw std::invalid_argument(
                            "full-node strategy edits clear with node_id only; omit hand_index");
                    }
                    held->strategy_edits.erase_hand(infoset_id, hand_index);
                }
                else
                {
                    held->strategy_edits.erase(infoset_id);
                }
                reapply_strategy_edits(*held);
            }
            send_response(client, 200, "application/json", json_strategy_edits(held->strategy_edits));
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
        if (g_app.session.running())
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
        if (g_app.values != nullptr)
        {
            g_app.values->cancel();
        }
        if (g_app.worker.joinable())
        {
            g_app.worker.join();
        }
        // Claim is non-blocking: cancelled value readers may still hold the
        // engine. continue_job waits for quiet before mutating.
        const poker::explorer::Session::Claim claim = g_app.session.claim_completed(id);
        if (!claim.allowed)
        {
            send_response(client, 404, "application/json", "{\"error\":\"expired solution\"}");
            return;
        }
        try
        {
            const std::shared_ptr<HeldSolution> held =
                std::static_pointer_cast<HeldSolution>(g_app.session.training_resource(claim.job_id));
            if (!held)
            {
                g_app.session.abort_continuation(
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
            g_app.session.set_progress(claim.job_id, build_status(starting));
            g_app.worker = std::thread(
                [job_id = claim.job_id, extra, continue_time_limit]()
                { continue_job(job_id, extra, continue_time_limit); });
        }
        catch (const std::exception& error)
        {
            const std::shared_ptr<HeldSolution> held =
                std::static_pointer_cast<HeldSolution>(g_app.session.training_resource(claim.job_id));
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
                g_app.session.abort_continuation(claim.job_id, build_status(failed));
            }
            else
            {
                g_app.session.abort_continuation(
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
    if (line.rfind("POST /api/plan-memory", 0) == 0)
    {
        try
        {
            poker::streets::StreetConfig config;
            const std::string text = read_string(body, "text", "");
            if (!text.empty())
            {
                if (text.rfind("street-config ", 0) != 0)
                {
                    throw std::invalid_argument("plan-memory text must be a street-config 1 document");
                }
                config = poker::streets::parse_street_config(text);
            }
            else
            {
                config = street_config(parse_job(body));
            }
            const poker::solver::StreetMemoryPlan plan = poker::solver::plan_street_memory(std::move(config));
            send_response(client, 200, "application/json", memory_plan_json(plan));
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
    if (line.rfind("POST /api/tree-preview", 0) == 0)
    {
        try
        {
            poker::streets::StreetConfig config;
            const std::string text = read_string(body, "text", "");
            if (!text.empty())
            {
                if (text.rfind("street-config ", 0) != 0)
                {
                    throw std::invalid_argument("tree-preview text must be a street-config 1 document");
                }
                config = poker::streets::parse_street_config(text);
            }
            else
            {
                config = street_config(parse_job(body));
            }
            poker::solver::StreetBatchSolver preview(std::move(config), poker::solver::kPlanOnly);
            send_response(
                client,
                200,
                "application/json",
                public_tree_json(preview.public_tree(), preview.config().tree_edits));
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
                payload += poker::format_chips(job.pot);
                payload += ",\"stack\":";
                payload += poker::format_chips(job.stack);
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
                write_sizes("oop_raises", job.oop_raises);
                write_sizes("ip_raises", job.ip_raises);
                write_sizes("oop_raise_multiples", job.oop_raise_multiples);
                write_sizes("ip_raise_multiples", job.ip_raise_multiples);
                write_sizes("oop_flop_bets", job.oop_flop_bets);
                write_sizes("ip_flop_bets", job.ip_flop_bets);
                write_sizes("oop_turn_bets", job.oop_turn_bets);
                write_sizes("ip_turn_bets", job.ip_turn_bets);
                write_sizes("oop_river_bets", job.oop_river_bets);
                write_sizes("ip_river_bets", job.ip_river_bets);
                write_sizes("oop_flop_raises", job.oop_flop_raises);
                write_sizes("ip_flop_raises", job.ip_flop_raises);
                write_sizes("oop_turn_raises", job.oop_turn_raises);
                write_sizes("ip_turn_raises", job.ip_turn_raises);
                write_sizes("oop_river_raises", job.oop_river_raises);
                write_sizes("ip_river_raises", job.ip_river_raises);
                write_sizes("oop_donk", job.oop_donk);
                write_sizes("oop_flop_donk", job.oop_flop_donk);
                write_sizes("oop_turn_donk", job.oop_turn_donk);
                write_sizes("oop_river_donk", job.oop_river_donk);
                payload += ",\"merge_threshold\":";
                payload += format_number(job.merge_threshold);
                // Utility model: rake / ICM / incentives (explicit zeros preserved).
                payload += ",\"rake_rate\":";
                payload += format_number(job.rake_rate);
                payload += ",\"rake_cap\":";
                payload += format_number(job.rake_cap);
                payload += ",\"icm_stacks\":[";
                for (std::size_t index = 0; index < job.icm_stacks.size(); ++index)
                {
                    if (index > 0)
                    {
                        payload += ',';
                    }
                    payload += format_number(job.icm_stacks[index]);
                }
                payload += "],\"icm_payouts\":[";
                for (std::size_t index = 0; index < job.icm_payouts.size(); ++index)
                {
                    if (index > 0)
                    {
                        payload += ',';
                    }
                    payload += format_number(job.icm_payouts[index]);
                }
                payload += "],";
                poker::explorer::append_incentive_config_json(payload, job.incentives);
                payload += ',';
                append_tree_edits_json(payload, job.tree_edits);
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
                payload += poker::format_chips(job.pot);
                payload += ",\"stack\":";
                payload += poker::format_chips(job.stack);
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
                payload += "],\"rake_rate\":";
                payload += format_number(job.rake_rate);
                payload += ",\"rake_cap\":";
                payload += format_number(job.rake_cap);
                payload += ",\"icm_stacks\":[";
                for (std::size_t index = 0; index < job.icm_stacks.size(); ++index)
                {
                    if (index > 0)
                    {
                        payload += ',';
                    }
                    payload += format_number(job.icm_stacks[index]);
                }
                payload += "],\"icm_payouts\":[";
                for (std::size_t index = 0; index < job.icm_payouts.size(); ++index)
                {
                    if (index > 0)
                    {
                        payload += ',';
                    }
                    payload += format_number(job.icm_payouts[index]);
                }
                payload += "],";
                poker::explorer::append_incentive_config_json(payload, job.incentives);
                payload += '}';
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
        if (g_app.session.running())
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
            if (g_app.values != nullptr)
            {
                g_app.values->cancel_and_drain();
            }
            const poker::explorer::CheckpointDocument document =
                poker::explorer::read_checkpoint(path, poker::explorer::kMaxCheckpointBytes);
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
        poker::explorer::ReaderLease lease(g_app.session, g_app.session.borrow(id));
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
            write_held_checkpoint(path, *held);
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
        poker::explorer::ReaderLease lease(g_app.session, g_app.session.borrow(id));
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
            if (tail == "config")
            {
                send_response(client, 200, "application/json", solution_config_json(*held));
                return;
            }
            if (tail == "strategy-edits")
            {
                send_response(
                    client, 200, "application/json", json_strategy_edits(held->strategy_edits));
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
                    // Prefer holdem::category_composition so flop/turn draws are
                    // available even when StreetBatchSolver still gates made-hand.
                    const poker::solver::StreetReachWeights weights =
                        held->street->reaching_weights(node_path);
                    const poker::holdem::Range oop = weights.oop.empty()
                        ? poker::holdem::Range{}
                        : poker::holdem::Range::parse(weights.oop);
                    const poker::holdem::Range ip = weights.ip.empty()
                        ? poker::holdem::Range{}
                        : poker::holdem::Range::parse(weights.ip);
                    const poker::holdem::CategoryComposition report =
                        poker::holdem::category_composition(weights.board, oop, ip);
                    const double query_seconds = std::chrono::duration<double>(
                        std::chrono::steady_clock::now() - query_started).count();
                    const std::string payload = json_categories(
                        report,
                        held->id,
                        held->job_id,
                        node_path,
                        g_app.session.generation(),
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
                    g_app.session.generation(),
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
                draft.generation = g_app.session.generation();
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
        std::uint64_t job_id = g_app.session.current_job();
        if (find_key(body, "job_id") != std::string::npos)
        {
            const std::string token = read_string(body, "job_id", "");
            if (!parse_prefixed_id(token, 'j', job_id))
            {
                send_response(client, 400, "application/json", "{\"error\":\"bad job id\"}");
                return;
            }
        }
        const poker::explorer::StopResult result = g_app.session.request_stop(job_id);
        std::string payload = "{\"result\":";
        if (result == poker::explorer::StopResult::Accepted)
        {
            payload += "\"accepted\"";
        }
        else if (result == poker::explorer::StopResult::AlreadyComplete)
        {
            payload += "\"complete\",\"solution_id\":";
            const std::uint64_t solution = g_app.session.current_solution();
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
        std::uint64_t job_id = g_app.session.current_job();
        if (find_key(body, "job_id") != std::string::npos)
        {
            const std::string token = read_string(body, "job_id", "");
            if (!parse_prefixed_id(token, 'j', job_id))
            {
                send_response(client, 400, "application/json", "{\"error\":\"bad job id\"}");
                return;
            }
        }
        const poker::explorer::PauseResult result = g_app.session.request_pause(job_id);
        std::string payload = "{\"result\":";
        if (result == poker::explorer::PauseResult::Accepted)
        {
            payload += "\"accepted\"";
        }
        else if (result == poker::explorer::PauseResult::AlreadyComplete)
        {
            payload += "\"complete\",\"solution_id\":";
            const std::uint64_t solution = g_app.session.current_solution();
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
        if (g_app.session.running())
        {
            send_response(client, 409, "application/json", "{\"error\":\"a solve is already running\"}");
            return;
        }
        if (g_app.values != nullptr)
        {
            g_app.values->cancel();
        }
        try
        {
            Job job = parse_job(body);
            if (g_app.worker.joinable())
            {
                g_app.worker.join();
            }
            std::shared_ptr<void> retiring;
            // begin() retires the prior engine without waiting; the worker
            // joins quiet before destroying it so value readers can finish.
            const std::uint64_t job_id = g_app.session.begin(retiring);
            StatusDraft starting;
            starting.running = true;
            starting.job = &job;
            starting.job_id = job_id;
            starting.generation = g_app.session.generation() + 1;
            g_app.session.set_progress(job_id, build_status(starting));
            try
            {
                g_app.worker = std::thread([job, retiring = std::move(retiring), job_id]() mutable
                {
                    g_app.session.wait_until_quiet();
                    retiring.reset();
                    g_app.session.notify_released();
                    solve_job(job_id, std::move(job));
                });
            }
            catch (const std::exception& error)
            {
                g_app.session.wait_until_quiet();
                retiring.reset();
                StatusDraft failed;
                failed.job = &job;
                failed.job_id = job_id;
                failed.error = error.what();
                failed.generation = g_app.session.generation() + 1;
                g_app.session.finish_failed(job_id, build_status(failed));
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
    else if (line.rfind("GET /favicon.svg", 0) == 0)
    {
        path = "/favicon.svg";
    }
    else if (line.rfind("GET /assets/", 0) == 0)
    {
        const std::size_t end = line.find(' ', 4);
        const std::string request = end == std::string::npos ? line.substr(4) : line.substr(4, end - 4);
        if (!safe_static_asset_path(request))
        {
            send_response(client, 400, "text/plain", "not found");
            return;
        }
        path = request;
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
    const std::string file = read_file(g_app.ui_root + path);
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
    // Prefer the built Study client when present; fall back to legacy/ui.
    const std::string candidates[] = {
        "desktop/dist",
        exe + "\\desktop\\dist",
        exe + "\\..\\desktop\\dist",
        exe + "\\..\\..\\desktop\\dist",
        exe + "/desktop/dist",
        exe + "/../desktop/dist",
        exe + "/../../desktop/dist",
        "legacy/ui",
        exe + "\\legacy\\ui",
        exe + "\\..\\legacy\\ui",
        exe + "\\..\\..\\legacy\\ui",
        exe + "/legacy/ui",
        exe + "/../legacy/ui",
        exe + "/../../legacy/ui"};
    for (const std::string& candidate : candidates)
    {
        std::ifstream probe(candidate + "/index.html");
        if (probe)
        {
            g_app.ui_root = candidate;
            return;
        }
    }
}


}  // namespace explorer_detail
