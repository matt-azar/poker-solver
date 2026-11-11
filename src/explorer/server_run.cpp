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

int run(int argc, char** argv)
{
    poker::explorer::ValueWorker values(
        g_app.session,
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
                std::vector<poker::holdem::EquityHandRow> oop_hands;
                std::vector<poker::holdem::EquityHandRow> ip_hands;
                if (page.defined)
                {
                    page.oop_equity = equity.player0.equity;
                    page.ip_equity = equity.player1.equity;
                    oop_distribution = poker::holdem::equity_distribution(equity.player0);
                    ip_distribution = poker::holdem::equity_distribution(equity.player1);
                    oop_hands = poker::holdem::equity_hand_rows(equity.player0);
                    ip_hands = poker::holdem::equity_hand_rows(equity.player1);
                }
                else
                {
                    oop_distribution = poker::holdem::equity_distribution(
                        std::span<const double>{}, std::span<const double>{});
                    ip_distribution = oop_distribution;
                }
                page.query_seconds = std::chrono::duration<double>(
                    std::chrono::steady_clock::now() - started).count();
                if (cancel.load() || g_app.session.current_solution() != request.solution_id)
                {
                    throw poker::solver::StreetValueCancelled();
                }
                return json_node_equity(
                    page,
                    request.solution_id,
                    request.job_id,
                    g_app.session.generation(),
                    oop_distribution,
                    ip_distribution,
                    oop_hands,
                    ip_hands,
                    request.profile_revision);
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
                if (cancel.load() || g_app.session.current_solution() != request.solution_id)
                {
                    throw poker::solver::StreetValueCancelled();
                }
                return json_action_values(
                    page,
                    request.solution_id,
                    request.job_id,
                    g_app.session.generation(),
                    request.profile_revision);
            }
            if (!held->street)
            {
                throw std::invalid_argument("this solution has no nodes");
            }
            if (request.kind == "runout")
            {
                const poker::solver::StreetRunoutValues page = held->street->runout_values(request.node_id, &cancel);
                if (cancel.load() || g_app.session.current_solution() != request.solution_id)
                {
                    throw poker::solver::StreetValueCancelled();
                }
                return json_runout_values(
                    page,
                    request.solution_id,
                    request.job_id,
                    g_app.session.generation(),
                    request.profile_revision);
            }
            if (request.kind == "equity")
            {
                const auto started = std::chrono::steady_clock::now();
                poker::solver::StreetNodeEquity page;
                page.node_id = request.node_id;
                page.units = poker::holdem::kEquityUnits;
                page.model = poker::holdem::kEquityModel;
                std::vector<poker::holdem::EquityDistributionBucket> oop_distribution =
                    poker::holdem::equity_distribution(
                        std::span<const double>{}, std::span<const double>{});
                std::vector<poker::holdem::EquityDistributionBucket> ip_distribution = oop_distribution;
                std::vector<poker::holdem::EquityHandRow> oop_hands;
                std::vector<poker::holdem::EquityHandRow> ip_hands;
                // Solver-native check-down equity: typed reaches + rank tables.
                // Keeps the standalone pair enumerator for Equity Calculator / CLI.
                const poker::holdem::ShowdownEquity equity =
                    held->street->checkdown_equity(request.node_id, &cancel);
                page.defined = equity.joint_defined && equity.player0.defined && equity.player1.defined;
                if (page.defined)
                {
                    page.oop_equity = equity.player0.equity;
                    page.ip_equity = equity.player1.equity;
                    oop_distribution = poker::holdem::equity_distribution(equity.player0);
                    ip_distribution = poker::holdem::equity_distribution(equity.player1);
                    oop_hands = poker::holdem::equity_hand_rows(equity.player0);
                    ip_hands = poker::holdem::equity_hand_rows(equity.player1);
                }
                else
                {
                    oop_distribution = poker::holdem::equity_distribution(
                        std::span<const double>{}, std::span<const double>{});
                    ip_distribution = oop_distribution;
                }
                page.query_seconds = std::chrono::duration<double>(
                    std::chrono::steady_clock::now() - started).count();
                if (cancel.load() || g_app.session.current_solution() != request.solution_id)
                {
                    throw poker::solver::StreetValueCancelled();
                }
                return json_node_equity(
                    page,
                    request.solution_id,
                    request.job_id,
                    g_app.session.generation(),
                    oop_distribution,
                    ip_distribution,
                    oop_hands,
                    ip_hands,
                    request.profile_revision);
            }
            const poker::solver::StreetActionValues page = held->street->action_values(request.node_id, &cancel);
            if (cancel.load() || g_app.session.current_solution() != request.solution_id)
            {
                throw poker::solver::StreetValueCancelled();
            }
            return json_action_values(
                page,
                request.solution_id,
                request.job_id,
                g_app.session.generation(),
                request.profile_revision);
        },
        [](const std::string& what, const poker::explorer::ValueRequest& request)
        {
            return json_value_error(
                what,
                request.solution_id,
                request.job_id,
                request.node_id,
                g_app.session.generation(),
                request.profile_revision);
        });
    g_app.values = &values;
    struct Teardown
    {
        ~Teardown()
        {
            if (g_app.values != nullptr)
            {
                g_app.values->shutdown();
                g_app.values = nullptr;
            }
            if (g_app.worker.joinable())
            {
                g_app.worker.join();
            }
        }
    } teardown;

    int port = 8765;
    bool study_packaged = false;
    bool max_pair_explicit = false;
    if (const char* env_limit = std::getenv("POKER_EQUITY_MAX_PAIR_RUNOUTS"))
    {
        std::uint64_t parsed = 0;
        if (!parse_u64(env_limit, parsed))
        {
            std::cerr << "invalid POKER_EQUITY_MAX_PAIR_RUNOUTS\n";
            return 1;
        }
        g_app.equity_max_pair_runouts = parsed;
        max_pair_explicit = true;
    }
    for (int i = 1; i < argc; ++i)
    {
        const std::string arg = argv[i];
        if (arg == "--port" && i + 1 < argc)
        {
            port = std::atoi(argv[++i]);
            if (port < 0 || port > 65535)
            {
                std::cerr << "invalid --port\n";
                return 1;
            }
        }
        else if (arg == "--max-pair-runouts" && i + 1 < argc)
        {
            std::uint64_t parsed = 0;
            if (!parse_u64(argv[++i], parsed))
            {
                std::cerr << "invalid --max-pair-runouts\n";
                return 1;
            }
            g_app.equity_max_pair_runouts = parsed;
            max_pair_explicit = true;
        }
        else if (arg == "--launch-id" && i + 1 < argc)
        {
            g_app.launch_id = argv[++i];
            if (g_app.launch_id.empty() || g_app.launch_id.size() > 128)
            {
                std::cerr << "invalid --launch-id\n";
                return 1;
            }
        }
        else if (arg == "--study-packaged")
        {
            study_packaged = true;
        }
    }
    if (study_packaged && !max_pair_explicit)
    {
        g_app.equity_max_pair_runouts = poker::holdem::kStudyExplorerMaxPairRunouts;
    }
    choose_ui_root();
    g_app.templates_root = poker::explorer::resolve_templates_directory(executable_directory());
    g_app.ranges_root = poker::explorer::resolve_ranges_directory(executable_directory());

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
    if (port == 0)
    {
        socklen_t length = sizeof(address);
        if (getsockname(server, reinterpret_cast<sockaddr*>(&address), &length) != 0)
        {
            std::cerr << "getsockname failed after --port 0 bind\n";
            close_socket(server);
            return 1;
        }
        port = static_cast<int>(ntohs(address.sin_port));
        if (port <= 0)
        {
            std::cerr << "OS assigned an invalid port\n";
            close_socket(server);
            return 1;
        }
    }
    if (listen(server, 8) != 0)
    {
        std::cerr << "listen failed\n";
        close_socket(server);
        return 1;
    }
    g_app.listen_port = port;
    std::cout << "explorer http://127.0.0.1:" << port << "\n";
    std::cout << "ui " << g_app.ui_root << "\n";
    std::cout << "recent "
              << poker::explorer::resolve_recent_file_path().string() << "\n";
    if (!g_app.templates_root.empty())
    {
        std::cout << "templates " << g_app.templates_root.string() << "\n";
    }
    if (!g_app.ranges_root.empty())
    {
        std::cout << "ranges " << g_app.ranges_root.string() << "\n";
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


}  // namespace explorer_detail
