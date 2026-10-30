#include "harness.hpp"

#include <chrono>
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
    HttpResult river_values;
    CHECK(http_exchange(
        "GET",
        "/api/solutions/" + solution + "/nodes/p0.t-1.r-1/values",
        "",
        river_values));
    CHECK(river_values.status == 400);
    CHECK(river_values.body.find("no street nodes") != std::string::npos);

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

#ifdef _WIN32
    WSACleanup();
#endif
}
