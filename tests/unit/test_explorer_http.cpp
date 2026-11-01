#include "harness.hpp"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <string>
#include <thread>

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
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <netinet/in.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/wait.h>
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

int g_explorer_port = 0;

class ExplorerProcess
{
public:
#ifdef _WIN32
    explicit ExplorerProcess(const std::string& command)
    {
        STARTUPINFOA startup{};
        startup.cb = sizeof(startup);
        std::string mutable_command = command;
        if (!CreateProcessA(
                nullptr,
                mutable_command.data(),
                nullptr,
                nullptr,
                FALSE,
                0,
                nullptr,
                nullptr,
                &startup,
                &process_))
        {
            process_.hProcess = nullptr;
        }
    }

    ~ExplorerProcess()
    {
        if (process_.hProcess != nullptr)
        {
            TerminateProcess(process_.hProcess, 1);
            WaitForSingleObject(process_.hProcess, 5000);
            CloseHandle(process_.hProcess);
            CloseHandle(process_.hThread);
        }
    }

    bool started() const
    {
        return process_.hProcess != nullptr;
    }

private:
    PROCESS_INFORMATION process_{};
#else
    ExplorerProcess(const std::string& executable, int port)
    {
        const std::string port_text = std::to_string(port);
        pid_ = fork();
        if (pid_ == 0)
        {
            // Detach from the test harness stdio so a blocked write cannot stall the server.
            const int null_fd = ::open("/dev/null", O_RDWR);
            if (null_fd >= 0)
            {
                dup2(null_fd, STDIN_FILENO);
                dup2(null_fd, STDOUT_FILENO);
                dup2(null_fd, STDERR_FILENO);
                if (null_fd > STDERR_FILENO)
                {
                    ::close(null_fd);
                }
            }
            execl(executable.c_str(), executable.c_str(), "--port", port_text.c_str(), static_cast<char*>(nullptr));
            _exit(127);
        }
    }

    ~ExplorerProcess()
    {
        if (pid_ > 0)
        {
            kill(pid_, SIGTERM);
            int status = 0;
            for (int attempt = 0; attempt < 50; ++attempt)
            {
                const pid_t waited = waitpid(pid_, &status, WNOHANG);
                if (waited == pid_)
                {
                    pid_ = -1;
                    return;
                }
                if (waited < 0 && errno == ECHILD)
                {
                    pid_ = -1;
                    return;
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
            }
            kill(pid_, SIGKILL);
            waitpid(pid_, &status, 0);
            pid_ = -1;
        }
    }

    bool started() const
    {
        return pid_ > 0;
    }

private:
    pid_t pid_ = -1;
#endif
};

struct HttpResult
{
    int status = 0;
    std::string body;
};

bool http_exchange(
    const std::string& method,
    const std::string& path,
    const std::string& payload,
    HttpResult& result)
{
    const socket_t sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock == kInvalidSocket)
    {
        return false;
    }
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(static_cast<unsigned short>(g_explorer_port));
    inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
    if (connect(sock, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0)
    {
        close_socket(sock);
        return false;
    }
    std::string request = method + " " + path + " HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n";
    if (!payload.empty())
    {
        request += "Content-Type: application/json\r\nContent-Length: " + std::to_string(payload.size()) + "\r\n";
    }
    request += "\r\n" + payload;
    std::size_t sent = 0;
    while (sent < request.size())
    {
        const int wrote = static_cast<int>(send(
            sock,
            request.data() + sent,
            static_cast<int>(request.size() - sent),
            0));
        if (wrote <= 0)
        {
            close_socket(sock);
            return false;
        }
        sent += static_cast<std::size_t>(wrote);
    }
    std::string raw;
    char buffer[4096];
    while (true)
    {
        const int got = static_cast<int>(recv(sock, buffer, static_cast<int>(sizeof(buffer)), 0));
        if (got <= 0)
        {
            break;
        }
        raw.append(buffer, buffer + got);
    }
    close_socket(sock);
    const std::size_t split = raw.find("\r\n\r\n");
    if (split == std::string::npos || raw.size() < 12)
    {
        return false;
    }
    result.status = std::atoi(raw.c_str() + 9);
    result.body = raw.substr(split + 4);
    return true;
}

int find_free_port()
{
    const socket_t sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock == kInvalidSocket)
    {
        return 0;
    }
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(0);
    inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
    if (bind(sock, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0)
    {
        close_socket(sock);
        return 0;
    }
    socklen_t length = sizeof(address);
    if (getsockname(sock, reinterpret_cast<sockaddr*>(&address), &length) != 0)
    {
        close_socket(sock);
        return 0;
    }
    const int port = static_cast<int>(ntohs(address.sin_port));
    close_socket(sock);
    return port;
}

bool wait_until_listening()
{
    for (int attempt = 0; attempt < 50; ++attempt)
    {
        HttpResult result;
        if (http_exchange("GET", "/api/status", "", result) && result.status == 200)
        {
            return true;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    return false;
}

std::string json_string(const std::string& body, const std::string& key)
{
    const std::string pattern = "\"" + key + "\":";
    const std::size_t at = body.find(pattern);
    if (at == std::string::npos)
    {
        return {};
    }
    std::size_t cursor = at + pattern.size();
    if (cursor < body.size() && body.compare(cursor, 4, "null") == 0)
    {
        return {};
    }
    if (cursor >= body.size() || body[cursor] != '"')
    {
        return {};
    }
    ++cursor;
    std::string value;
    while (cursor < body.size() && body[cursor] != '"')
    {
        value.push_back(body[cursor]);
        ++cursor;
    }
    return value;
}

bool json_number(const std::string& body, const std::string& key, double& value)
{
    const std::string pattern = "\"" + key + "\":";
    const std::size_t at = body.find(pattern);
    if (at == std::string::npos)
    {
        return false;
    }
    const std::size_t cursor = at + pattern.size();
    if (body.compare(cursor, 4, "null") == 0)
    {
        return false;
    }
    char* end = nullptr;
    value = std::strtod(body.c_str() + cursor, &end);
    return end != body.c_str() + cursor;
}

std::string json_array_string(const std::string& body, const std::string& key)
{
    const std::string pattern = "\"" + key + "\":[";
    const std::size_t at = body.find(pattern);
    if (at == std::string::npos)
    {
        return {};
    }
    const std::size_t quote = body.find('"', at + pattern.size());
    if (quote == std::string::npos)
    {
        return {};
    }
    std::size_t cursor = quote + 1;
    std::string value;
    while (cursor < body.size() && body[cursor] != '"')
    {
        value.push_back(body[cursor]);
        ++cursor;
    }
    return value;
}

bool wait_for_values(const std::string& path, HttpResult& result)
{
    for (int attempt = 0; attempt < 200; ++attempt)
    {
        if (!http_exchange("GET", path, "", result))
        {
            return false;
        }
        if (result.status != 202)
        {
            return true;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    return false;
}

bool wait_for_completion(HttpResult& status)
{
    for (int attempt = 0; attempt < 200; ++attempt)
    {
        if (!http_exchange("GET", "/api/status", "", status))
        {
            return false;
        }
        if (status.body.find("\"running\":false") != std::string::npos
            && status.body.find("\"iterations\":0") == std::string::npos)
        {
            return true;
        }
        if (status.body.find("\"error\":\"") != std::string::npos
            && status.body.find("\"error\":\"\"") == std::string::npos)
        {
            return true;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    return false;
}

void check_agreement(const HttpResult& status, const HttpResult& exported, double expected_ev, bool expect_exact_ev)
{
    CHECK(status.status == 200);
    CHECK(exported.status == 200);
    double status_iterations = 0.0;
    double export_iterations = 0.0;
    double status_ev = 0.0;
    double export_ev = 0.0;
    double status_gap = 0.0;
    double export_gap = 0.0;
    CHECK(json_number(status.body, "iterations", status_iterations));
    CHECK(json_number(exported.body, "iterations", export_iterations));
    CHECK(status_iterations == export_iterations);
    CHECK(status_iterations > 0.0);
    CHECK(json_number(status.body, "player0_expected_utility", status_ev));
    CHECK(json_number(exported.body, "player0_expected_utility", export_ev));
    CHECK_NEAR(status_ev, export_ev, 1e-9);
    CHECK(json_number(status.body, "nash_gap", status_gap));
    CHECK(json_number(exported.body, "nash_gap", export_gap));
    CHECK_NEAR(status_gap, export_gap, 1e-9);
    if (expect_exact_ev)
    {
        CHECK_NEAR(status_ev, expected_ev, 1e-9);
        CHECK(status_iterations == 3.0);
    }
    const std::string solution = json_string(status.body, "solution_id");
    const std::string job = json_string(status.body, "job_id");
    CHECK(solution == json_string(exported.body, "solution_id"));
    CHECK(job == json_string(exported.body, "job_id"));
    CHECK(!solution.empty());
    CHECK(!job.empty());
    CHECK(status.body.find("\"pot\":100") != std::string::npos);
    CHECK(exported.body.find("\"pot\":100") != std::string::npos);
}

std::string explorer_executable_path()
{
#ifdef _WIN32
    char module[MAX_PATH];
    const DWORD length = GetModuleFileNameA(nullptr, module, MAX_PATH);
    if (length == 0 || length >= MAX_PATH)
    {
        return {};
    }
    std::string executable(module, module + length);
    const std::size_t slash = executable.find_last_of("\\/");
    if (slash == std::string::npos)
    {
        return {};
    }
    return executable.substr(0, slash + 1) + "explorer.exe";
#else
    char module[PATH_MAX];
    const ssize_t length = ::readlink("/proc/self/exe", module, sizeof(module) - 1);
    if (length <= 0)
    {
        return {};
    }
    module[length] = '\0';
    std::string executable(module);
    const std::size_t slash = executable.find_last_of('/');
    if (slash == std::string::npos)
    {
        return {};
    }
    return executable.substr(0, slash + 1) + "explorer";
#endif
}

std::string workflow_checkpoint_path()
{
#ifdef _WIN32
    char directory[MAX_PATH];
    const DWORD length = GetTempPathA(MAX_PATH, directory);
    if (length == 0 || length >= MAX_PATH)
    {
        return {};
    }
    return std::string(directory, directory + length) + "poker_solver_http_workflow.psol";
#else
    return "/tmp/poker_solver_http_workflow.psol";
#endif
}

std::string json_escape_path(const std::string& path)
{
    std::string out;
    out.reserve(path.size() + 8);
    for (const char ch : path)
    {
        if (ch == '\\' || ch == '"')
        {
            out.push_back('\\');
        }
        out.push_back(ch);
    }
    return out;
}

// Weighted multi-combo river: save → open → continue with a pending /values
// query. Continue must accept without parking the accept loop; Open must finish
// while the value worker is drained/cancelled.
void check_persistence_workflow_under_value_load()
{
    const std::string checkpoint = workflow_checkpoint_path();
    CHECK(!checkpoint.empty());
    const std::string path_json = json_escape_path(checkpoint);
    const std::string solve =
        "{\"board\":[\"Ah\",\"Kd\",\"7c\",\"4s\",\"2h\"],"
        "\"oop_range\":\"AcAd:1,5c5d:3,QsQh:2\","
        "\"ip_range\":\"KsKc:2,JhJd:1,9c9d:1\","
        "\"pot\":100,\"stack\":100,\"iterations\":20,\"samples\":4,\"max_raises\":1,"
        "\"allow_all_in\":1,\"oop_bets\":[0.5],\"ip_bets\":[0.5],\"memory_mib\":256,"
        "\"algorithm\":\"cfr_plus\"}";
    HttpResult accepted;
    CHECK(http_exchange("POST", "/api/solve", solve, accepted));
    CHECK(accepted.status == 202);
    HttpResult solved;
    CHECK(wait_for_completion(solved));
    CHECK(solved.body.find("\"error\":\"\"") != std::string::npos);
    const std::string sid1 = json_string(solved.body, "solution_id");
    CHECK(!sid1.empty());
    const std::string root = json_string(solved.body, "root_node_id");
    CHECK(!root.empty());
    double iters1 = 0.0;
    CHECK(json_number(solved.body, "iterations", iters1));
    CHECK(iters1 == 20.0);

    const std::string values_path = "/api/solutions/" + sid1 + "/nodes/" + root + "/values";
    HttpResult first_values;
    CHECK(wait_for_values(values_path, first_values));
    CHECK(first_values.status == 200);
    CHECK(first_values.body.find("\"action_ev\"") != std::string::npos);

    HttpResult saved;
    CHECK(http_exchange(
        "POST",
        "/api/solutions/" + sid1 + "/save",
        "{\"path\":\"" + path_json + "\"}",
        saved));
    CHECK(saved.status == 200);
    CHECK(saved.body.find("\"saved\":true") != std::string::npos);

    // Start a values query, then Open while it may still be inflight.
    HttpResult pending_before_open;
    CHECK(http_exchange("GET", values_path, "", pending_before_open));
    CHECK(pending_before_open.status == 200 || pending_before_open.status == 202);
    const auto open_started = std::chrono::steady_clock::now();
    HttpResult opened;
    CHECK(http_exchange("POST", "/api/open", "{\"path\":\"" + path_json + "\"}", opened));
    const double open_seconds = std::chrono::duration<double>(
        std::chrono::steady_clock::now() - open_started).count();
    CHECK(opened.status == 200);
    CHECK(open_seconds < 5.0);
    const std::string sid2 = json_string(opened.body, "solution_id");
    CHECK(!sid2.empty());
    CHECK(sid2 != sid1);
    double opened_iters = 0.0;
    CHECK(json_number(opened.body, "iterations", opened_iters));
    CHECK(opened_iters == iters1);

    // Status must still answer after Open drained any cancelled value walk.
    HttpResult status_after_open;
    CHECK(http_exchange("GET", "/api/status", "", status_after_open));
    CHECK(status_after_open.status == 200);
    CHECK(json_string(status_after_open.body, "solution_id") == sid2);

    const std::string values2 = "/api/solutions/" + sid2 + "/nodes/" + root + "/values";
    HttpResult pending_before_continue;
    CHECK(http_exchange("GET", values2, "", pending_before_continue));
    CHECK(pending_before_continue.status == 200 || pending_before_continue.status == 202);
    const auto continue_started = std::chrono::steady_clock::now();
    HttpResult continued;
    CHECK(http_exchange(
        "POST",
        "/api/solutions/" + sid2 + "/continue",
        "{\"iterations\":20}",
        continued));
    const double continue_seconds = std::chrono::duration<double>(
        std::chrono::steady_clock::now() - continue_started).count();
    CHECK(continued.status == 202);
    CHECK(continue_seconds < 2.0);
    CHECK(json_string(continued.body, "solution_id") == sid2);

    HttpResult mid_status;
    CHECK(http_exchange("GET", "/api/status", "", mid_status));
    CHECK(mid_status.status == 200);
    CHECK(mid_status.body.find("\"running\":true") != std::string::npos);

    HttpResult finished;
    CHECK(wait_for_completion(finished));
    CHECK(json_string(finished.body, "solution_id") == sid2);
    double iters2 = 0.0;
    CHECK(json_number(finished.body, "iterations", iters2));
    CHECK(iters2 > iters1);

    HttpResult second_values;
    CHECK(wait_for_values(values2, second_values));
    CHECK(second_values.status == 200);
    CHECK(second_values.body.find("\"action_ev\"") != std::string::npos);
}

// Tiny turn: lock root → resolve-locked → compare vs retained baseline → save/open locks.
void check_lock_resolve_compare_workflow()
{
    const std::string checkpoint = workflow_checkpoint_path() + ".locks";
    const std::string path_json = json_escape_path(checkpoint);
    const std::string solve =
        "{\"board\":[\"Kh\",\"Kd\",\"7c\",\"4s\"],\"oop_range\":\"2c3d,2h3h\",\"ip_range\":\"AhAd\","
        "\"pot\":100,\"stack\":100,\"iterations\":8,\"samples\":2,\"max_raises\":1,"
        "\"allow_all_in\":0,\"oop_bets\":[1.0],\"ip_bets\":[],\"oop_turn_bets\":[1.0],"
        "\"memory_mib\":128,\"algorithm\":\"vanilla\"}";
    HttpResult accepted;
    CHECK(http_exchange("POST", "/api/solve", solve, accepted));
    CHECK(accepted.status == 202);
    HttpResult solved;
    CHECK(wait_for_completion(solved));
    const std::string baseline = json_string(solved.body, "solution_id");
    CHECK(!baseline.empty());
    const std::string root = json_string(solved.body, "root_node_id");
    CHECK(root == "p0.t-1.r-1");

    HttpResult locked;
    CHECK(http_exchange(
        "PUT",
        "/api/solutions/" + baseline + "/locks",
        "{\"node_id\":\"" + root + "\",\"kind\":\"selected\",\"hand_indices\":[0],\"probs\":[0,1]}",
        locked));
    CHECK(locked.status == 200);
    CHECK(locked.body.find("\"probs\"") != std::string::npos);
    CHECK(locked.body.find(root) != std::string::npos);

    HttpResult resolve_accepted;
    CHECK(http_exchange(
        "POST",
        "/api/solutions/" + baseline + "/resolve-locked",
        "{\"iterations\":6,\"samples\":2}",
        resolve_accepted));
    CHECK(resolve_accepted.status == 202);
    HttpResult resolved;
    CHECK(wait_for_completion(resolved));
    const std::string scenario = json_string(resolved.body, "solution_id");
    CHECK(!scenario.empty());
    CHECK(scenario != baseline);
    CHECK(json_string(resolved.body, "baseline_solution_id") == baseline);

    HttpResult locks;
    CHECK(http_exchange("GET", "/api/solutions/" + scenario + "/locks", "", locks));
    CHECK(locks.status == 200);
    CHECK(locks.body.find("\"locks\":[") != std::string::npos);
    CHECK(locks.body.find(root) != std::string::npos);

    HttpResult compared;
    CHECK(http_exchange(
        "GET",
        "/api/compare?baseline=" + baseline + "&scenario=" + scenario + "&node_id=" + root,
        "",
        compared));
    CHECK(compared.status == 200);
    CHECK(compared.body.find("\"value_delta\"") != std::string::npos);
    CHECK(compared.body.find("\"locked\":true") != std::string::npos);

    HttpResult baseline_export;
    CHECK(http_exchange("GET", "/api/solutions/" + baseline + "/export", "", baseline_export));
    CHECK(baseline_export.status == 200);

    HttpResult saved;
    CHECK(http_exchange(
        "POST",
        "/api/solutions/" + scenario + "/save",
        "{\"path\":\"" + path_json + "\"}",
        saved));
    CHECK(saved.status == 200);
    HttpResult opened;
    CHECK(http_exchange("POST", "/api/open", "{\"path\":\"" + path_json + "\"}", opened));
    CHECK(opened.status == 200);
    const std::string reopened = json_string(opened.body, "solution_id");
    CHECK(!reopened.empty());
    HttpResult reopened_locks;
    CHECK(http_exchange("GET", "/api/solutions/" + reopened + "/locks", "", reopened_locks));
    CHECK(reopened_locks.status == 200);
    CHECK(reopened_locks.body.find(root) != std::string::npos);

    // Combo unlock removes one selected hand; warm_start continues from stored tables.
    HttpResult locked_two;
    CHECK(http_exchange(
        "PUT",
        "/api/solutions/" + reopened + "/locks",
        "{\"node_id\":\"" + root + "\",\"kind\":\"selected\",\"hand_indices\":[0,1],\"probs\":[0,1]}",
        locked_two));
    CHECK(locked_two.status == 200);
    HttpResult unlocked_one;
    CHECK(http_exchange(
        "DELETE",
        "/api/solutions/" + reopened + "/locks?node_id=" + root + "&hand_index=1",
        "",
        unlocked_one));
    CHECK(unlocked_one.status == 200);
    CHECK(unlocked_one.body.find(root) != std::string::npos);
    double before_warm = 0.0;
    CHECK(json_number(opened.body, "iterations", before_warm));
    HttpResult warm_accepted;
    CHECK(http_exchange(
        "POST",
        "/api/solutions/" + reopened + "/resolve-locked",
        "{\"iterations\":2,\"samples\":1,\"warm_start\":1}",
        warm_accepted));
    CHECK(warm_accepted.status == 202);
    HttpResult warmed;
    CHECK(wait_for_completion(warmed));
    double after_warm = 0.0;
    CHECK(json_number(warmed.body, "iterations", after_warm));
    CHECK(after_warm >= before_warm + 2.0 - 1e-9);
    std::remove(checkpoint.c_str());
}

// Free-form strategy edit round-trip: PUT → node strategy changes → clear restores;
// locks remain independent.
void check_strategy_edit_workflow()
{
    const std::string solve =
        "{\"board\":[\"Kh\",\"Kd\",\"7c\",\"4s\"],\"oop_range\":\"2c3d,2h3h\",\"ip_range\":\"AhAd\","
        "\"pot\":100,\"stack\":100,\"iterations\":10,\"samples\":2,\"max_raises\":1,"
        "\"allow_all_in\":0,\"oop_bets\":[1.0],\"ip_bets\":[],\"oop_turn_bets\":[1.0],"
        "\"memory_mib\":128,\"algorithm\":\"vanilla\"}";
    HttpResult accepted;
    CHECK(http_exchange("POST", "/api/solve", solve, accepted));
    CHECK(accepted.status == 202);
    HttpResult solved;
    CHECK(wait_for_completion(solved));
    const std::string solution = json_string(solved.body, "solution_id");
    CHECK(!solution.empty());
    const std::string root = json_string(solved.body, "root_node_id");
    CHECK(root == "p0.t-1.r-1");

    HttpResult before_node;
    CHECK(http_exchange("GET", "/api/solutions/" + solution + "/nodes/" + root, "", before_node));
    CHECK(before_node.status == 200);
    CHECK(before_node.body.find("\"strategy\":[") != std::string::npos);

    HttpResult edited;
    CHECK(http_exchange(
        "PUT",
        "/api/solutions/" + solution + "/strategy-edits",
        "{\"node_id\":\"" + root + "\",\"kind\":\"selected\",\"hand_indices\":[0],\"probs\":[0,1]}",
        edited));
    CHECK(edited.status == 200);
    CHECK(edited.body.find("\"edits\":[") != std::string::npos);
    CHECK(edited.body.find("\"persisted\":false") != std::string::npos);
    CHECK(edited.body.find(root) != std::string::npos);

    HttpResult listed;
    CHECK(http_exchange("GET", "/api/solutions/" + solution + "/strategy-edits", "", listed));
    CHECK(listed.status == 200);
    CHECK(listed.body.find(root) != std::string::npos);

    HttpResult after_node;
    CHECK(http_exchange("GET", "/api/solutions/" + solution + "/nodes/" + root, "", after_node));
    CHECK(after_node.status == 200);
    // Hand 0 pure on the second action (check/bet).
    CHECK(after_node.body.find("[0,1]") != std::string::npos
        || after_node.body.find("[0, 1]") != std::string::npos
        || after_node.body.find("0,1") != std::string::npos);

    // Locks still work independently of strategy edits.
    HttpResult locked;
    CHECK(http_exchange(
        "PUT",
        "/api/solutions/" + solution + "/locks",
        "{\"node_id\":\"" + root + "\",\"kind\":\"selected\",\"hand_indices\":[1],\"probs\":[1,0]}",
        locked));
    CHECK(locked.status == 200);
    CHECK(locked.body.find(root) != std::string::npos);

    HttpResult cleared;
    CHECK(http_exchange(
        "DELETE",
        "/api/solutions/" + solution + "/strategy-edits",
        "",
        cleared));
    CHECK(cleared.status == 200);
    CHECK(cleared.body.find("\"edits\":[]") != std::string::npos);

    HttpResult locks_after;
    CHECK(http_exchange("GET", "/api/solutions/" + solution + "/locks", "", locks_after));
    CHECK(locks_after.status == 200);
    CHECK(locks_after.body.find(root) != std::string::npos);

    HttpResult bad_probs;
    CHECK(http_exchange(
        "PUT",
        "/api/solutions/" + solution + "/strategy-edits",
        "{\"node_id\":\"" + root + "\",\"kind\":\"selected\",\"hand_indices\":[0],\"probs\":[0,0]}",
        bad_probs));
    CHECK(bad_probs.status == 400);
}

} // namespace

void run_explorer_http_tests()
{
#ifdef _WIN32
    WSADATA data;
    CHECK(WSAStartup(MAKEWORD(2, 2), &data) == 0);
#endif

    g_explorer_port = find_free_port();
    CHECK(g_explorer_port > 0);

    const std::string executable = explorer_executable_path();
    CHECK(!executable.empty());

#ifdef _WIN32
    ExplorerProcess server("\"" + executable + "\" --port " + std::to_string(g_explorer_port));
#else
    ExplorerProcess server(executable, g_explorer_port);
#endif
    CHECK(server.started());
    CHECK(wait_until_listening());

    // Five-card boards publish a street solution (shared tree), not RiverBatch.
    const std::string river =
        "{\"board\":[\"Kh\",\"Kd\",\"7c\",\"4s\",\"2h\"],\"oop_range\":\"AhAd\",\"ip_range\":\"2c3d\","
        "\"pot\":100,\"stack\":100,\"iterations\":3,\"samples\":1,\"max_raises\":0,\"allow_all_in\":0,"
        "\"oop_bets\":[],\"ip_bets\":[],\"memory_mib\":128}";
    HttpResult accepted;
    CHECK(http_exchange("POST", "/api/solve", river, accepted));
    CHECK(accepted.status == 202);
    const std::string river_job = json_string(accepted.body, "job_id");
    CHECK(river_job == "j1");
    HttpResult status;
    CHECK(wait_for_completion(status));
    HttpResult exported;
    const std::string solution = json_string(status.body, "solution_id");
    CHECK(http_exchange("GET", "/api/solutions/" + solution + "/export", "", exported));
    check_agreement(status, exported, 50.0, true);
    const std::string river_root = json_string(status.body, "root_node_id");
    CHECK(river_root == "p0.t-1.r-1");
    CHECK(exported.body.find("\"root_node_id\":\"p0.t-1.r-1\"") != std::string::npos);
    HttpResult river_root_page;
    CHECK(http_exchange(
        "GET",
        "/api/solutions/" + solution + "/nodes/" + river_root,
        "",
        river_root_page));
    CHECK(river_root_page.status == 200);
    CHECK(river_root_page.body.find("\"kind\":\"decision\"") != std::string::npos);
    const std::string river_values_path =
        "/api/solutions/" + solution + "/nodes/" + river_root + "/values";
    HttpResult river_values;
    CHECK(wait_for_values(river_values_path, river_values));
    CHECK(river_values.status == 200);
    CHECK(river_values.body.find("\"pending\":false") != std::string::npos);
    CHECK(river_values.body.find("\"units\":\"chips\"") != std::string::npos);
    CHECK(river_values.body.find("\"utility_basis\":\"root_centered\"") != std::string::npos);
    CHECK(river_values.body.find("\"node_ev_defined\":true") != std::string::npos);
    double river_node_ev = 0.0;
    CHECK(json_number(river_values.body, "node_ev", river_node_ev));
    CHECK_NEAR(river_node_ev, 50.0, 1e-6);

    HttpResult stopped;
    CHECK(http_exchange("POST", "/api/stop", "{\"job_id\":\"" + river_job + "\"}", stopped));
    CHECK(stopped.status == 200);
    CHECK(stopped.body.find("\"result\":\"complete\"") != std::string::npos);
    HttpResult still;
    CHECK(http_exchange("GET", "/api/solutions/" + solution + "/export", "", still));
    CHECK(still.status == 200);
    CHECK(still.body.find("\"iterations\":3") != std::string::npos);

    HttpResult overflow;
    CHECK(http_exchange("GET", "/api/solutions/s18446744073709551617/export", "", overflow));
    CHECK(overflow.status == 400);
    HttpResult trailing;
    CHECK(http_exchange("GET", "/api/solutions/s1x/export", "", trailing));
    CHECK(trailing.status == 400);
    HttpResult plus;
    CHECK(http_exchange("GET", "/api/solutions/s+1/export", "", plus));
    CHECK(plus.status == 400);
    HttpResult missing;
    CHECK(http_exchange("GET", "/api/solutions/s2/export", "", missing));
    CHECK(missing.status == 404);
    HttpResult stale;
    CHECK(http_exchange("POST", "/api/stop", "{\"job_id\":\"j99\"}", stale));
    CHECK(stale.status == 200);
    CHECK(stale.body.find("\"result\":\"stale\"") != std::string::npos);

    const std::string street =
        "{\"board\":[\"Kh\",\"Kd\",\"7c\",\"4s\"],\"oop_range\":\"AhAd\",\"ip_range\":\"2c3d\","
        "\"pot\":100,\"stack\":100,\"iterations\":1,\"samples\":1,\"max_raises\":0,\"allow_all_in\":0,"
        "\"oop_bets\":[],\"ip_bets\":[],\"memory_mib\":128,\"frozen\":1}";
    HttpResult street_accepted;
    CHECK(http_exchange("POST", "/api/solve", street, street_accepted));
    CHECK(street_accepted.status == 202);
    HttpResult street_status;
    CHECK(wait_for_completion(street_status));
    const std::string street_solution = json_string(street_status.body, "solution_id");
    HttpResult street_export;
    CHECK(http_exchange("GET", "/api/solutions/" + street_solution + "/export", "", street_export));
    check_agreement(street_status, street_export, 0.0, false);
    CHECK(street_export.body.find("\"root_node_id\":\"p0.t-1.r-1\"") != std::string::npos);
    const std::string root = json_string(street_status.body, "root_node_id");
    CHECK(root == "p0.t-1.r-1");
    const std::string values_path = "/api/solutions/" + street_solution + "/nodes/" + root + "/values";
    HttpResult values;
    CHECK(wait_for_values(values_path, values));
    CHECK(values.status == 200);
    CHECK(values.body.find("\"pending\":false") != std::string::npos);
    CHECK(values.body.find("\"utility_basis\":\"root_centered\"") != std::string::npos);
    CHECK(values.body.find("\"units\":\"chips\"") != std::string::npos);
    CHECK(values.body.find("\"player\":0") != std::string::npos);
    double node_ev = 0.0;
    double query_seconds = 0.0;
    CHECK(json_number(values.body, "node_ev", node_ev));
    CHECK_NEAR(node_ev, 50.0, 1e-6);
    CHECK(json_number(values.body, "query_seconds", query_seconds));
    CHECK(query_seconds >= 0.0);
    HttpResult root_page;
    CHECK(http_exchange("GET", "/api/solutions/" + street_solution + "/nodes/" + root, "", root_page));
    CHECK(root_page.status == 200);
    const std::string ip_id = json_array_string(root_page.body, "children");
    CHECK(!ip_id.empty());
    HttpResult ip_page;
    CHECK(http_exchange("GET", "/api/solutions/" + street_solution + "/nodes/" + ip_id, "", ip_page));
    CHECK(ip_page.status == 200);
    const std::string chance_id = json_array_string(ip_page.body, "children");
    CHECK(!chance_id.empty());
    HttpResult chance_page;
    CHECK(http_exchange("GET", "/api/solutions/" + street_solution + "/nodes/" + chance_id, "", chance_page));
    CHECK(chance_page.status == 200);
    CHECK(chance_page.body.find("\"kind\":\"chance\"") != std::string::npos);
    HttpResult chance_values;
    CHECK(http_exchange(
        "GET",
        "/api/solutions/" + street_solution + "/nodes/" + chance_id + "/values",
        "",
        chance_values));
    CHECK(chance_values.status == 400);
    CHECK(chance_values.body.find("decision node") != std::string::npos);
    HttpResult values_again;
    CHECK(http_exchange("GET", values_path, "", values_again));
    CHECK(values_again.status == 200);
    CHECK(values_again.body == values.body);
    HttpResult status_after;
    CHECK(http_exchange("GET", "/api/status", "", status_after));
    CHECK(status_after.body == street_status.body);
    HttpResult export_after;
    CHECK(http_exchange("GET", "/api/solutions/" + street_solution + "/export", "", export_after));
    CHECK(export_after.body == street_export.body);
    CHECK(export_after.body.find("\"action_ev\"") == std::string::npos);
    CHECK(export_after.body.find("\"utility_basis\"") == std::string::npos);
    HttpResult node_overflow;
    CHECK(http_exchange(
        "GET",
        "/api/solutions/" + street_solution + "/nodes/p18446744073709551617.t-1.r-1",
        "",
        node_overflow));
    CHECK(node_overflow.status == 400);
    HttpResult old_river;
    CHECK(http_exchange("GET", "/api/solutions/" + solution + "/export", "", old_river));
    CHECK(old_river.status == 404);
    HttpResult old_values;
    CHECK(http_exchange("GET", "/api/solutions/" + solution + "/nodes/p0.t-1.r-1/values", "", old_values));
    CHECK(old_values.status == 404);

    HttpResult continued;
    CHECK(http_exchange(
        "POST",
        "/api/solutions/" + street_solution + "/continue",
        "{\"iterations\":1}",
        continued));
    CHECK(continued.status == 202);
    CHECK(json_string(continued.body, "solution_id") == street_solution);
    HttpResult continued_status;
    CHECK(wait_for_completion(continued_status));
    CHECK(json_string(continued_status.body, "solution_id") == street_solution);
    double continued_iterations = 0.0;
    double continued_ev = 0.0;
    CHECK(json_number(continued_status.body, "iterations", continued_iterations));
    CHECK(continued_iterations == 2.0);
    CHECK(json_number(continued_status.body, "player0_expected_utility", continued_ev));
    CHECK_NEAR(continued_ev, 50.0, 1e-6);
    HttpResult continued_export;
    CHECK(http_exchange("GET", "/api/solutions/" + street_solution + "/export", "", continued_export));
    CHECK(continued_export.status == 200);
    double export_iterations = 0.0;
    CHECK(json_number(continued_export.body, "iterations", export_iterations));
    CHECK(export_iterations == 2.0);
    HttpResult bad_continue;
    CHECK(http_exchange("POST", "/api/solutions/" + street_solution + "/continue", "{\"iterations\":0}", bad_continue));
    CHECK(bad_continue.status == 400);
    HttpResult missing_value;
    CHECK(http_exchange("POST", "/api/solutions/" + street_solution + "/continue", "{\"note\":\"iterations\"}", missing_value));
    CHECK(missing_value.status == 400);
    HttpResult huge_continue;
    CHECK(http_exchange("POST", "/api/solutions/" + street_solution + "/continue", "{\"iterations\":1e20}", huge_continue));
    CHECK(huge_continue.status == 400);
    HttpResult infinite_continue;
    CHECK(http_exchange("POST", "/api/solutions/" + street_solution + "/continue", "{\"iterations\":1e309}", infinite_continue));
    CHECK(infinite_continue.status == 400);
    HttpResult fractional_continue;
    CHECK(http_exchange("POST", "/api/solutions/" + street_solution + "/continue", "{\"iterations\":1.5}", fractional_continue));
    CHECK(fractional_continue.status == 400);
    HttpResult still_up;
    CHECK(http_exchange("GET", "/api/status", "", still_up));
    CHECK(still_up.status == 200);
    CHECK(json_string(still_up.body, "solution_id") == street_solution);
    HttpResult missing_continue;
    CHECK(http_exchange("POST", "/api/solutions/s99/continue", "{\"iterations\":1}", missing_continue));
    CHECK(missing_continue.status == 404);

    HttpResult bad_time_limit;
    CHECK(http_exchange(
        "POST",
        "/api/solve",
        "{\"board\":[\"Kh\",\"Kd\",\"7c\",\"4s\",\"2h\"],\"oop_range\":\"AhAd\",\"ip_range\":\"2c3d\","
        "\"pot\":100,\"stack\":100,\"iterations\":4,\"samples\":2,\"time_limit\":-1,"
        "\"max_raises\":0,\"allow_all_in\":0,\"oop_bets\":[],\"ip_bets\":[],\"memory_mib\":128}",
        bad_time_limit));
    CHECK(bad_time_limit.status == 400);
    CHECK(bad_time_limit.body.find("time_limit") != std::string::npos);

    HttpResult bad_rake_rate;
    CHECK(http_exchange(
        "POST",
        "/api/solve",
        "{\"board\":[\"Kh\",\"Kd\",\"7c\",\"4s\",\"2h\"],\"oop_range\":\"AhAd\",\"ip_range\":\"2c3d\","
        "\"pot\":100,\"stack\":100,\"iterations\":1,\"samples\":1,\"rake_rate\":1.5,"
        "\"max_raises\":0,\"allow_all_in\":0,\"oop_bets\":[],\"ip_bets\":[],\"memory_mib\":128}",
        bad_rake_rate));
    CHECK(bad_rake_rate.status == 400);
    CHECK(bad_rake_rate.body.find("rake_rate") != std::string::npos);

    HttpResult bad_rake_cap;
    CHECK(http_exchange(
        "POST",
        "/api/solve",
        "{\"board\":[\"Kh\",\"Kd\",\"7c\",\"4s\",\"2h\"],\"oop_range\":\"AhAd\",\"ip_range\":\"2c3d\","
        "\"pot\":100,\"stack\":100,\"iterations\":1,\"samples\":1,\"rake_rate\":0.05,\"rake_cap\":-1,"
        "\"max_raises\":0,\"allow_all_in\":0,\"oop_bets\":[],\"ip_bets\":[],\"memory_mib\":128}",
        bad_rake_cap));
    CHECK(bad_rake_cap.status == 400);
    CHECK(bad_rake_cap.body.find("rake_cap") != std::string::npos);

    // Positive rake on a tiny check-only river: winner EV is 50 - floor(0.05*100) = 45.
    const std::string raked =
        "{\"board\":[\"Kh\",\"Kd\",\"7c\",\"4s\",\"2h\"],\"oop_range\":\"AhAd\",\"ip_range\":\"2c3d\","
        "\"pot\":100,\"stack\":100,\"iterations\":3,\"samples\":1,\"rake_rate\":0.05,\"rake_cap\":0,"
        "\"max_raises\":0,\"allow_all_in\":0,\"oop_bets\":[],\"ip_bets\":[],\"memory_mib\":128}";
    HttpResult raked_accepted;
    CHECK(http_exchange("POST", "/api/solve", raked, raked_accepted));
    CHECK(raked_accepted.status == 202);
    HttpResult raked_status;
    CHECK(wait_for_completion(raked_status));
    double status_rake_rate = -1.0;
    double status_rake_cap = -1.0;
    CHECK(json_number(raked_status.body, "rake_rate", status_rake_rate));
    CHECK(json_number(raked_status.body, "rake_cap", status_rake_cap));
    CHECK_NEAR(status_rake_rate, 0.05, 1e-12);
    CHECK_NEAR(status_rake_cap, 0.0, 1e-12);
    double raked_ev = 0.0;
    CHECK(json_number(raked_status.body, "player0_expected_utility", raked_ev));
    CHECK_NEAR(raked_ev, 45.0, 1e-6);

    HttpResult bad_icm_stacks;
    CHECK(http_exchange(
        "POST",
        "/api/solve",
        "{\"board\":[\"Kh\",\"Kd\",\"7c\",\"4s\",\"2h\"],\"oop_range\":\"AhAd\",\"ip_range\":\"2c3d\","
        "\"pot\":100,\"stack\":100,\"iterations\":1,\"samples\":1,\"icm_stacks\":[1000],"
        "\"icm_payouts\":[100],\"max_raises\":0,\"allow_all_in\":0,\"oop_bets\":[],\"ip_bets\":[],"
        "\"memory_mib\":128}",
        bad_icm_stacks));
    CHECK(bad_icm_stacks.status == 400);
    CHECK(bad_icm_stacks.body.find("icm") != std::string::npos);

    HttpResult bad_icm_cover;
    CHECK(http_exchange(
        "POST",
        "/api/solve",
        "{\"board\":[\"Kh\",\"Kd\",\"7c\",\"4s\",\"2h\"],\"oop_range\":\"AhAd\",\"ip_range\":\"2c3d\","
        "\"pot\":100,\"stack\":100,\"iterations\":1,\"samples\":1,\"icm_stacks\":[40,40],"
        "\"icm_payouts\":[100],\"max_raises\":0,\"allow_all_in\":0,\"oop_bets\":[],\"ip_bets\":[],"
        "\"memory_mib\":128}",
        bad_icm_cover));
    CHECK(bad_icm_cover.status == 400);
    CHECK(bad_icm_cover.body.find("icm") != std::string::npos);

    // HU WTA on a tiny check-only river: chip EV 50 → ICM 2.5 (stacks 1000/1000, prize 100).
    const std::string icm_job =
        "{\"board\":[\"Kh\",\"Kd\",\"7c\",\"4s\",\"2h\"],\"oop_range\":\"AhAd\",\"ip_range\":\"2c3d\","
        "\"pot\":100,\"stack\":100,\"iterations\":3,\"samples\":1,\"icm_stacks\":[1000,1000],"
        "\"icm_payouts\":[100],\"max_raises\":0,\"allow_all_in\":0,\"oop_bets\":[],\"ip_bets\":[],"
        "\"memory_mib\":128}";
    HttpResult icm_accepted;
    CHECK(http_exchange("POST", "/api/solve", icm_job, icm_accepted));
    CHECK(icm_accepted.status == 202);
    HttpResult icm_status;
    CHECK(wait_for_completion(icm_status));
    CHECK(icm_status.body.find("\"icm_stacks\":[1000,1000]") != std::string::npos);
    CHECK(icm_status.body.find("\"icm_payouts\":[100]") != std::string::npos);
    double icm_ev = 0.0;
    CHECK(json_number(icm_status.body, "player0_expected_utility", icm_ev));
    CHECK_NEAR(icm_ev, 2.5, 1e-6);

    // time_limit 0 stops after the first completed sample chunk and keeps the solve.
    const std::string timed =
        "{\"board\":[\"Kh\",\"Kd\",\"7c\",\"4s\",\"2h\"],\"oop_range\":\"AhAd\",\"ip_range\":\"2c3d\","
        "\"pot\":100,\"stack\":100,\"iterations\":40,\"samples\":4,\"time_limit\":0,"
        "\"max_raises\":0,\"allow_all_in\":0,\"oop_bets\":[],\"ip_bets\":[],\"memory_mib\":128}";
    HttpResult timed_accepted;
    CHECK(http_exchange("POST", "/api/solve", timed, timed_accepted));
    CHECK(timed_accepted.status == 202);
    HttpResult timed_status;
    CHECK(wait_for_completion(timed_status));
    CHECK(timed_status.body.find("\"time_limit_reached\":true") != std::string::npos);
    CHECK(timed_status.body.find("\"cancelled\":false") != std::string::npos);
    double timed_iters = 0.0;
    CHECK(json_number(timed_status.body, "iterations", timed_iters));
    CHECK(timed_iters == 10.0);
    CHECK(timed_iters < 40.0);
    const std::string timed_solution = json_string(timed_status.body, "solution_id");
    CHECK(!timed_solution.empty());

    HttpResult timed_continue;
    CHECK(http_exchange(
        "POST",
        "/api/solutions/" + timed_solution + "/continue",
        "{\"iterations\":40,\"time_limit\":0}",
        timed_continue));
    CHECK(timed_continue.status == 202);
    HttpResult timed_continue_status;
    CHECK(wait_for_completion(timed_continue_status));
    CHECK(timed_continue_status.body.find("\"time_limit_reached\":true") != std::string::npos);
    double timed_continue_iters = 0.0;
    CHECK(json_number(timed_continue_status.body, "iterations", timed_continue_iters));
    CHECK(timed_continue_iters == 20.0);
    CHECK(json_string(timed_continue_status.body, "solution_id") == timed_solution);

    check_persistence_workflow_under_value_load();
    check_lock_resolve_compare_workflow();
    check_strategy_edit_workflow();

    // Mid-construction dry-run plan and visual tree-edit preview / config round-trip.
    {
        const std::string plan_body =
            "{\"board\":[\"Kh\",\"Kd\",\"7c\",\"4s\"],\"oop_range\":\"AhAd\",\"ip_range\":\"2c3d\","
            "\"pot\":100,\"stack\":100,\"max_raises\":1,\"allow_all_in\":0,"
            "\"oop_bets\":[1],\"ip_bets\":[1],\"memory_mib\":64,\"iterations\":1}";
        HttpResult plan_result;
        CHECK(http_exchange("POST", "/api/plan-memory", plan_body, plan_result));
        CHECK(plan_result.status == 200);
        CHECK(plan_result.body.find("\"dry_run\":true") != std::string::npos);
        double peak = 0.0;
        CHECK(json_number(plan_result.body, "estimated_peak_bytes", peak));
        CHECK(peak > 0.0);
        CHECK(plan_result.body.find("\"fits_budget\":") != std::string::npos);

        HttpResult preview;
        CHECK(http_exchange("POST", "/api/tree-preview", plan_body, preview));
        CHECK(preview.status == 200);
        CHECK(preview.body.find("\"nodes\":[") != std::string::npos);
        CHECK(preview.body.find("\"compact\"") != std::string::npos);

        const std::string forced =
            "{\"board\":[\"Kh\",\"Kd\",\"7c\",\"4s\"],\"oop_range\":\"AhAd\",\"ip_range\":\"2c3d\","
            "\"pot\":100,\"stack\":100,\"max_raises\":1,\"allow_all_in\":0,"
            "\"oop_bets\":[1],\"ip_bets\":[1],\"memory_mib\":64,\"iterations\":1,"
            "\"tree_edits\":[\"force - c\"]}";
        HttpResult forced_preview;
        CHECK(http_exchange("POST", "/api/tree-preview", forced, forced_preview));
        CHECK(forced_preview.status == 200);
        CHECK(forced_preview.body.find("\"tree_edits\":[\"force - c\"]") != std::string::npos);
        // Root decision keeps only Check after force.
        CHECK(forced_preview.body.find("\"compact\":\"c\"") != std::string::npos);

        std::string config_job = "{\"text\":\"";
        for (char character : std::string(
                 "street-config 1\n"
                 "board Kh Kd 7c 4s\n"
                 "pot 100\n"
                 "stack 100\n"
                 "oop-range AhAd\n"
                 "ip-range 2c3d\n"
                 "first-to-act 0\n"
                 "max-raises 1\n"
                 "allow-all-in 0\n"
                 "allow-three-bet 1\n"
                 "geometric 0\n"
                 "all-in-threshold 0\n"
                 "pot-cap 0\n"
                 "rake-rate 0\n"
                 "rake-cap 0\n"
                 "memory-mib 64\n"
                 "threads 1\n"
                 "oop-bets 1\n"
                 "ip-bets 1\n"
                 "tree-edit force - c\n"))
        {
            if (character == '\n')
            {
                config_job += "\\n";
            }
            else if (character == '"')
            {
                config_job += "\\\"";
            }
            else if (character == '\\')
            {
                config_job += "\\\\";
            }
            else
            {
                config_job += character;
            }
        }
        config_job += "\"}";
        HttpResult config_parsed;
        CHECK(http_exchange("POST", "/api/config", config_job, config_parsed));
        CHECK(config_parsed.status == 200);
        CHECK(config_parsed.body.find("\"tree_edits\":[\"force - c\"]") != std::string::npos);
    }

#ifdef _WIN32
    WSACleanup();
#endif
}
