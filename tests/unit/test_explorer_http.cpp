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
#endif

namespace
{

#ifdef _WIN32

class ExplorerProcess
{
public:
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
    SOCKET sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock == INVALID_SOCKET)
    {
        return false;
    }
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(18765);
    inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
    if (connect(sock, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0)
    {
        closesocket(sock);
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
        const int wrote = send(sock, request.data() + sent, static_cast<int>(request.size() - sent), 0);
        if (wrote <= 0)
        {
            closesocket(sock);
            return false;
        }
        sent += static_cast<std::size_t>(wrote);
    }
    std::string raw;
    char buffer[4096];
    while (true)
    {
        const int got = recv(sock, buffer, static_cast<int>(sizeof(buffer)), 0);
        if (got <= 0)
        {
            break;
        }
        raw.append(buffer, buffer + got);
    }
    closesocket(sock);
    const std::size_t split = raw.find("\r\n\r\n");
    if (split == std::string::npos || raw.size() < 12)
    {
        return false;
    }
    result.status = std::atoi(raw.c_str() + 9);
    result.body = raw.substr(split + 4);
    return true;
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

#endif

} // namespace

void run_explorer_http_tests()
{
#ifdef _WIN32
    WSADATA data;
    CHECK(WSAStartup(MAKEWORD(2, 2), &data) == 0);
    char module[MAX_PATH];
    const DWORD length = GetModuleFileNameA(nullptr, module, MAX_PATH);
    CHECK(length > 0 && length < MAX_PATH);
    std::string executable(module, module + length);
    const std::size_t slash = executable.find_last_of("\\/");
    CHECK(slash != std::string::npos);
    executable = executable.substr(0, slash + 1) + "explorer.exe";
    ExplorerProcess server("\"" + executable + "\" --port 18765");
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

    WSACleanup();
#else
    std::cout << "explorer HTTP tests run on Windows\n";
#endif
}
