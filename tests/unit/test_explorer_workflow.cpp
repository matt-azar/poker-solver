// Desktop acceptance path: real explorer HTTP lifecycle on Linux and Windows.
// Covers Build dry-run → solve → pause/inspect → save → open → continue →
// lock/compare, plus a few failure paths. Does not drive the React/Tauri shell
// (see docs/DESKTOP_UI.md and docs/auxiliary/engineering/TESTING.md for gaps).

#include "harness.hpp"

#include <chrono>
#include <cstdio>
#include <cstdlib>
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

int g_port = 0;

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
                if (waited == pid_ || (waited < 0 && errno == ECHILD))
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
    address.sin_port = htons(static_cast<unsigned short>(g_port));
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

bool json_bool(const std::string& body, const std::string& key, bool& value)
{
    const std::string pattern = "\"" + key + "\":";
    const std::size_t at = body.find(pattern);
    if (at == std::string::npos)
    {
        return false;
    }
    const std::size_t cursor = at + pattern.size();
    if (body.compare(cursor, 4, "true") == 0)
    {
        value = true;
        return true;
    }
    if (body.compare(cursor, 5, "false") == 0)
    {
        value = false;
        return true;
    }
    return false;
}

bool wait_until_idle(HttpResult& status)
{
    for (int attempt = 0; attempt < 400; ++attempt)
    {
        if (!http_exchange("GET", "/api/status", "", status))
        {
            return false;
        }
        bool running = true;
        if (json_bool(status.body, "running", running) && !running)
        {
            return true;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(25));
    }
    return false;
}

bool wait_for_progress(HttpResult& status)
{
    for (int attempt = 0; attempt < 400; ++attempt)
    {
        if (!http_exchange("GET", "/api/status", "", status))
        {
            return false;
        }
        double iterations = 0.0;
        if (json_number(status.body, "iterations", iterations) && iterations > 0.0)
        {
            return true;
        }
        bool running = true;
        if (json_bool(status.body, "running", running) && !running)
        {
            return true;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(25));
    }
    return false;
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

std::string checkpoint_path()
{
    return unique_temp_path("poker_solver_desktop_acceptance.psol").string();
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

void check_failure_paths()
{
    // Failed Open — missing path is sync 400; missing file is 202 then status error.
    // Deeper Open races live in test_explorer_http.cpp / test_session.cpp.
    HttpResult missing_path;
    CHECK(http_exchange("POST", "/api/open", "{}", missing_path));
    CHECK(missing_path.status == 400);
    CHECK(missing_path.body.find("path") != std::string::npos);

    HttpResult missing_file;
    CHECK(http_exchange(
        "POST",
        "/api/open",
        ("{\"path\":\"" + json_escape_path(unique_temp_path("poker_solver_no_such_checkpoint.psol").string())
         + "\"}"),
        missing_file));
    CHECK(missing_file.status == 202);
    HttpResult missing_status;
    CHECK(wait_until_idle(missing_status));
    CHECK(missing_status.body.find("\"error\":\"\"") == std::string::npos);

    // Memory rejection via dry-run plan (Build). Engine budget refusals for the
    // same shape are covered in test_streets.cpp / test_budget.cpp.
    const std::string tight_plan =
        "{\"board\":[\"Ah\",\"Kd\",\"7c\"],\"oop_range\":\"77+\",\"ip_range\":\"77+\","
        "\"pot\":100,\"stack\":100,\"iterations\":1,\"samples\":1,\"max_raises\":0,"
        "\"allow_all_in\":0,\"oop_bets\":[],\"ip_bets\":[],\"memory_mib\":1}";
    HttpResult plan;
    CHECK(http_exchange("POST", "/api/plan-memory", tight_plan, plan));
    CHECK(plan.status == 200);
    CHECK(plan.body.find("\"fits_budget\":false") != std::string::npos);
    CHECK(plan.body.find("\"dry_run\":true") != std::string::npos);

    HttpResult rejected;
    CHECK(http_exchange("POST", "/api/solve", tight_plan, rejected));
    CHECK(rejected.status == 202);
    HttpResult failed;
    CHECK(wait_until_idle(failed));
    CHECK(failed.body.find("\"error\":\"\"") == std::string::npos);
    CHECK(failed.body.find("memory") != std::string::npos
        || failed.body.find("budget") != std::string::npos
        || failed.body.find("alloc") != std::string::npos);
}

void check_happy_path_lifecycle()
{
    const std::string checkpoint = checkpoint_path();
    CHECK(!checkpoint.empty());
    std::remove(checkpoint.c_str());
    const std::string path_json = json_escape_path(checkpoint);

    // Build dry-run before solving (Study Build → plan-memory).
    const std::string spot =
        "{\"board\":[\"Kh\",\"Kd\",\"7c\",\"4s\",\"2h\"],"
        "\"oop_range\":\"AhAd,AcAs\",\"ip_range\":\"2c3d,2h3h\","
        // Keep the initial solve short so pause/save/open still fit CI time budgets;
        // continue/resolve-locked below add a few more iters explicitly.
        "\"pot\":100,\"stack\":100,\"iterations\":12,\"samples\":4,\"max_raises\":0,"
        "\"allow_all_in\":0,\"oop_bets\":[],\"ip_bets\":[],\"memory_mib\":128}";
    HttpResult plan;
    CHECK(http_exchange("POST", "/api/plan-memory", spot, plan));
    CHECK(plan.status == 200);
    CHECK(plan.body.find("\"fits_budget\":true") != std::string::npos);
    double peak = 0.0;
    CHECK(json_number(plan.body, "estimated_peak_bytes", peak));
    CHECK(peak > 0.0);

    HttpResult accepted;
    CHECK(http_exchange("POST", "/api/solve", spot, accepted));
    CHECK(accepted.status == 202);
    const std::string job = json_string(accepted.body, "job_id");
    CHECK(!job.empty());

    HttpResult progressing;
    CHECK(wait_for_progress(progressing));

    HttpResult pause;
    CHECK(http_exchange("POST", "/api/pause", "{\"job_id\":\"" + job + "\"}", pause));
    CHECK(pause.status == 200);
    // Tiny trees may finish before pause lands; either Accepted or AlreadyComplete.
    CHECK(pause.body.find("\"result\":\"accepted\"") != std::string::npos
        || pause.body.find("\"result\":\"complete\"") != std::string::npos);

    HttpResult after_pause;
    CHECK(wait_until_idle(after_pause));
    CHECK(after_pause.body.find("\"error\":\"\"") != std::string::npos
        || after_pause.body.find("\"error\":null") != std::string::npos
        || after_pause.body.find("\"error\":\"") == std::string::npos);
    const std::string solution = json_string(after_pause.body, "solution_id");
    CHECK(!solution.empty());
    const std::string root = json_string(after_pause.body, "root_node_id");
    CHECK(root == "p0.t-1.r-1");
    double paused_iters = 0.0;
    CHECK(json_number(after_pause.body, "iterations", paused_iters));
    CHECK(paused_iters > 0.0);
    CHECK(paused_iters <= 12.0);

    // Inspect: browse root + action EV.
    HttpResult node;
    CHECK(http_exchange("GET", "/api/solutions/" + solution + "/nodes/" + root, "", node));
    CHECK(node.status == 200);
    CHECK(node.body.find("\"kind\":\"decision\"") != std::string::npos);

    HttpResult values;
    CHECK(wait_for_values("/api/solutions/" + solution + "/nodes/" + root + "/values", values));
    CHECK(values.status == 200);
    CHECK(values.body.find("\"units\":\"chips\"") != std::string::npos);

    // Save → Open → Continue (CFR+ default; omit algorithm field).
    HttpResult saved;
    CHECK(http_exchange(
        "POST",
        "/api/solutions/" + solution + "/save",
        "{\"path\":\"" + path_json + "\"}",
        saved));
    CHECK(saved.status == 202);
    HttpResult saved_status;
    CHECK(wait_until_idle(saved_status));
    CHECK(saved_status.body.find("\"error\":\"\"") != std::string::npos);
    CHECK(saved_status.body.find("\"file_op\":\"saved\"") != std::string::npos);

    HttpResult opened;
    CHECK(http_exchange("POST", "/api/open", "{\"path\":\"" + path_json + "\"}", opened));
    CHECK(opened.status == 202);
    HttpResult opened_status;
    CHECK(wait_until_idle(opened_status));
    const std::string reopened = json_string(opened_status.body, "solution_id");
    CHECK(!reopened.empty());
    CHECK(reopened != solution);
    double opened_iters = 0.0;
    CHECK(json_number(opened_status.body, "iterations", opened_iters));
    CHECK(opened_iters == paused_iters);

    HttpResult continued;
    CHECK(http_exchange(
        "POST",
        "/api/solutions/" + reopened + "/continue",
        "{\"iterations\":4,\"samples\":2}",
        continued));
    CHECK(continued.status == 202);
    CHECK(json_string(continued.body, "solution_id") == reopened);
    HttpResult after_continue;
    CHECK(wait_until_idle(after_continue));
    CHECK(json_string(after_continue.body, "solution_id") == reopened);
    double continued_iters = 0.0;
    CHECK(json_number(after_continue.body, "iterations", continued_iters));
    CHECK(continued_iters >= opened_iters + 4.0 - 1e-9);

    // Lock → resolve-locked → compare (Study lock / compare workspace).
    HttpResult locked;
    CHECK(http_exchange(
        "PUT",
        "/api/solutions/" + reopened + "/locks",
        "{\"node_id\":\"" + root + "\",\"kind\":\"selected\",\"hand_indices\":[0],\"probs\":[1]}",
        locked));
    CHECK(locked.status == 200);
    CHECK(locked.body.find(root) != std::string::npos);

    const std::string baseline = reopened;
    HttpResult resolve_accepted;
    CHECK(http_exchange(
        "POST",
        "/api/solutions/" + baseline + "/resolve-locked",
        "{\"iterations\":2,\"samples\":1}",
        resolve_accepted));
    CHECK(resolve_accepted.status == 202);
    HttpResult resolved;
    CHECK(wait_until_idle(resolved));
    const std::string scenario = json_string(resolved.body, "solution_id");
    CHECK(!scenario.empty());
    CHECK(scenario != baseline);
    CHECK(json_string(resolved.body, "baseline_solution_id") == baseline);

    HttpResult compared;
    CHECK(http_exchange(
        "GET",
        "/api/compare?baseline=" + baseline + "&scenario=" + scenario + "&node_id=" + root,
        "",
        compared));
    CHECK(compared.status == 200);
    CHECK(compared.body.find("\"value_delta\"") != std::string::npos);
    CHECK(compared.body.find("\"locked\":true") != std::string::npos);

    std::remove(checkpoint.c_str());
}

}  // namespace

void run_explorer_workflow_tests()
{
#ifdef _WIN32
    WSADATA data;
    if (WSAStartup(MAKEWORD(2, 2), &data) != 0)
    {
        CHECK(false);
        return;
    }
#endif

    g_port = find_free_port();
    CHECK(g_port > 0);
    const std::string executable = explorer_executable_path();
    CHECK(!executable.empty());

#ifdef _WIN32
    const std::string command = "\"" + executable + "\" --port " + std::to_string(g_port);
    ExplorerProcess process(command);
#else
    ExplorerProcess process(executable, g_port);
#endif
    CHECK(process.started());
    CHECK(wait_until_listening());

    check_failure_paths();
    check_happy_path_lifecycle();

#ifdef _WIN32
    WSACleanup();
#endif
}
