#include "server_shared.hpp"

#include "explorer/equity_jobs.hpp"

#include <cctype>
#include <sstream>
#include <stdexcept>

namespace explorer_detail
{
namespace
{

poker::explorer::EquityJobManager& equity_jobs()
{
    static poker::explorer::EquityJobManager manager;
    return manager;
}

std::string json_escape(const std::string& text)
{
    std::string out;
    out.push_back('"');
    for (char character : text)
    {
        if (character == '"' || character == '\\')
        {
            out.push_back('\\');
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
    return out;
}

std::string snapshot_status_json(const poker::explorer::EquityJobSnapshot& snap, bool include_result)
{
    std::ostringstream out;
    out.setf(std::ios::fmtflags(0), std::ios::floatfield);
    out.precision(12);
    out << "{\"job_id\":" << json_escape(snap.id) << ",\"state\":"
        << json_escape(std::string(poker::explorer::equity_job_state_name(snap.state)))
        << ",\"client_revision\":" << json_escape(snap.request.client_revision)
        << ",\"progress_done\":" << snap.progress_done << ",\"progress_total\":" << snap.progress_total
        << ",\"elapsed_seconds\":" << snap.elapsed_seconds;
    if (!snap.error.empty())
    {
        out << ",\"error\":" << json_escape(snap.error) << ",\"error_kind\":"
            << json_escape(snap.error_kind);
    }
    if (include_result
        && (snap.state == poker::explorer::EquityJobState::Completed
            || snap.state == poker::explorer::EquityJobState::Stopped))
    {
        out << ",\"result\":"
            << poker::holdem::equity_calc_result_json(
                   snap.result,
                   snap.request.board,
                   snap.request.dead_cards);
    }
    else
    {
        // Compact running summary: method selection once known.
        if (snap.state == poker::explorer::EquityJobState::Running
            || snap.state == poker::explorer::EquityJobState::Preparing)
        {
            out << ",\"requested_method\":"
                << json_escape(std::string(
                       poker::holdem::equity_calc_method_name(snap.request.options.method)));
        }
    }
    out << '}';
    return out.str();
}

poker::explorer::EquityJobRequest parse_equity_job_body(const std::string& body)
{
    poker::explorer::EquityJobRequest request;
    request.version = static_cast<int>(read_number(body, "version", 1));
    request.client_revision = read_string(body, "client_revision", "");
    const std::string method = read_string(body, "method", "auto");
    request.options.method = poker::holdem::parse_equity_calc_method(method);
    request.options.max_exact_deals = static_cast<std::uint64_t>(
        read_number(body, "max_exact_deals", static_cast<double>(poker::holdem::kEquityCalculatorDefaultMaxExactDeals)));
    request.options.auto_exact_threshold = static_cast<std::uint64_t>(
        read_number(
            body,
            "auto_exact_threshold",
            static_cast<double>(poker::holdem::kEquityCalculatorAutoExactThreshold)));
    request.options.target_samples = static_cast<std::uint64_t>(
        read_number(
            body,
            "target_samples",
            static_cast<double>(poker::holdem::kEquityCalculatorDefaultTargetSamples)));
    request.options.max_attempts = static_cast<std::uint64_t>(
        read_number(
            body,
            "max_attempts",
            static_cast<double>(poker::holdem::kEquityCalculatorDefaultMaxAttempts)));
    request.options.seed = static_cast<std::uint64_t>(read_number(body, "seed", 1));

    const std::vector<std::string> board = read_string_array(body, "board");
    for (const std::string& card : board)
    {
        request.board.push_back(poker::holdem::parse_card(card));
    }
    const std::vector<std::string> dead = read_string_array(body, "dead_cards");
    for (const std::string& card : dead)
    {
        request.dead_cards.push_back(poker::holdem::parse_card(card));
    }

    // Players: prefer array of {id, range}; also accept oop_range/ip_range for two-player convenience.
    const std::size_t players_key = find_key(body, "players");
    if (players_key != std::string::npos)
    {
        // Minimal array walk: find objects with "id" and "range".
        const std::size_t array_at = value_at(body, players_key);
        if (array_at >= body.size() || body[array_at] != '[')
        {
            throw std::invalid_argument("players must be an array");
        }
        std::size_t cursor = array_at + 1;
        while (cursor < body.size())
        {
            while (cursor < body.size()
                   && (std::isspace(static_cast<unsigned char>(body[cursor])) || body[cursor] == ','))
            {
                ++cursor;
            }
            if (cursor < body.size() && body[cursor] == ']')
            {
                break;
            }
            if (cursor >= body.size() || body[cursor] != '{')
            {
                throw std::invalid_argument("player entry must be an object");
            }
            int depth = 0;
            const std::size_t start = cursor;
            for (; cursor < body.size(); ++cursor)
            {
                if (body[cursor] == '{')
                {
                    ++depth;
                }
                else if (body[cursor] == '}')
                {
                    --depth;
                    if (depth == 0)
                    {
                        ++cursor;
                        break;
                    }
                }
            }
            const std::string object = body.substr(start, cursor - start);
            poker::holdem::EquityCalcPlayerInput player;
            player.id = read_string(object, "id", "");
            const std::string range_text = read_string(object, "range", "");
            if (player.id.empty())
            {
                throw std::invalid_argument("player id is required");
            }
            if (range_text.empty())
            {
                throw std::invalid_argument("player range is required");
            }
            try
            {
                player.range = poker::holdem::Range::parse(range_text);
            }
            catch (const std::invalid_argument& error)
            {
                throw std::invalid_argument(std::string("invalid range for ") + player.id + ": " + error.what());
            }
            request.players.push_back(std::move(player));
        }
    }
    else
    {
        const std::string oop = read_string(body, "oop_range", "");
        const std::string ip = read_string(body, "ip_range", "");
        if (oop.empty() || ip.empty())
        {
            throw std::invalid_argument("players array or oop_range/ip_range required");
        }
        poker::holdem::EquityCalcPlayerInput p0;
        p0.id = "p1";
        p0.range = poker::holdem::Range::parse(oop);
        poker::holdem::EquityCalcPlayerInput p1;
        p1.id = "p2";
        p1.range = poker::holdem::Range::parse(ip);
        request.players.push_back(std::move(p0));
        request.players.push_back(std::move(p1));
    }

    if (request.players.size() < 2 || request.players.size() > 6)
    {
        throw std::invalid_argument("equity job requires 2 to 6 players");
    }
    return request;
}

bool extract_equity_job_id(const std::string& line, const char* method_prefix, std::string& id, std::string& rest)
{
    const std::string prefix = std::string(method_prefix) + " /api/equity/jobs/";
    if (line.rfind(prefix, 0) != 0)
    {
        return false;
    }
    const std::string after = line.substr(prefix.size());
    const std::size_t space = after.find(' ');
    const std::string path = space == std::string::npos ? after : after.substr(0, space);
    const std::size_t slash = path.find('/');
    if (slash == std::string::npos)
    {
        id = path;
        rest.clear();
    }
    else
    {
        id = path.substr(0, slash);
        rest = path.substr(slash + 1);
    }
    return !id.empty();
}

} // namespace

bool handle_equity_api(socket_t client, const std::string& line, const std::string& body)
{
    if (line.rfind("POST /api/equity/jobs", 0) == 0
        && (line.size() == std::string("POST /api/equity/jobs").size()
            || line[std::string("POST /api/equity/jobs").size()] == ' '
            || line[std::string("POST /api/equity/jobs").size()] == '?'))
    {
        try
        {
            poker::explorer::EquityJobRequest request = parse_equity_job_body(body);
            const std::string id = equity_jobs().enqueue(std::move(request));
            std::string accepted = "{\"job_id\":";
            accepted += json_escape(id);
            accepted += ",\"state\":\"queued\"}";
            send_response(client, 202, "application/json", accepted);
        }
        catch (const std::invalid_argument& error)
        {
            send_response(
                client,
                400,
                "application/json",
                std::string("{\"error\":") + json_escape(error.what()) + "}");
        }
        catch (const std::exception& error)
        {
            send_response(
                client,
                409,
                "application/json",
                std::string("{\"error\":") + json_escape(error.what()) + "}");
        }
        return true;
    }

    std::string job_id;
    std::string rest;
    if (extract_equity_job_id(line, "GET", job_id, rest))
    {
        const auto snap = rest == "result" ? equity_jobs().result(job_id) : equity_jobs().status(job_id);
        if (!snap)
        {
            send_response(client, 404, "application/json", "{\"error\":\"equity job not found\"}");
            return true;
        }
        if (rest == "result"
            && snap->state != poker::explorer::EquityJobState::Completed
            && snap->state != poker::explorer::EquityJobState::Stopped
            && snap->state != poker::explorer::EquityJobState::Failed
            && snap->state != poker::explorer::EquityJobState::Cancelled)
        {
            send_response(client, 409, "application/json", "{\"error\":\"equity job result is not ready\"}");
            return true;
        }
        const bool include_result = rest == "result"
            || snap->state == poker::explorer::EquityJobState::Completed
            || snap->state == poker::explorer::EquityJobState::Stopped;
        send_response(client, 200, "application/json", snapshot_status_json(*snap, include_result));
        return true;
    }

    if (extract_equity_job_id(line, "POST", job_id, rest) && rest == "cancel")
    {
        if (!equity_jobs().cancel(job_id))
        {
            send_response(client, 404, "application/json", "{\"error\":\"equity job not found\"}");
            return true;
        }
        send_response(client, 200, "application/json", "{\"ok\":true,\"job_id\":" + json_escape(job_id) + "}");
        return true;
    }

    return false;
}

} // namespace explorer_detail
