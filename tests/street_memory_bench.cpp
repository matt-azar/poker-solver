#include "poker/card.hpp"
#include "poker/range.hpp"
#include "solver/street_batch.hpp"

#include <chrono>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

namespace
{

void require(bool condition, const std::string& message)
{
    if (!condition)
    {
        throw std::runtime_error(message);
    }
}

void solve_case(
    const char* name,
    const std::vector<int>& board,
    int public_decisions,
    std::uint64_t runouts,
    std::uint64_t decision_factor,
    std::uint64_t expected_deals)
{
    poker::streets::StreetConfig config;
    config.board = board;
    config.pot = 100;
    config.stack = 100;
    config.oop = poker::holdem::Range::parse("random");
    config.ip = poker::holdem::Range::parse("random");
    config.oop_bet_sizes = {1.0};
    config.allow_all_in = false;
    config.max_raises = 0;
    config.memory_mib = 1024;

    const auto wall_started = std::chrono::steady_clock::now();
    poker::solver::StreetBatchSolver solver(config);
    poker::solver::SolveConfig solve;
    solve.max_iterations = 1;
    const poker::solver::SolveStats stats = solver.solve_frozen(
        solve, poker::solver::Algorithm::CfrPlus);
    const poker::solver::StreetMemoryReport report = solver.memory_report();
    const double wall = std::chrono::duration<double>(
        std::chrono::steady_clock::now() - wall_started).count();

    std::cout.setf(std::ios::fmtflags(0), std::ios::floatfield);
    std::cout.precision(12);
    std::cout << "case: " << name << "\n";
    std::cout << "deals: " << solver.deal_count() << "\n";
    std::cout << "infosets: " << solver.infoset_count() << "\n";
    std::cout << "public_decisions: " << solver.public_decisions() << "\n";
    std::cout << "public_terminals: " << solver.public_terminals() << "\n";
    std::cout << "expanded_terminals: " << solver.terminal_count() << "\n";
    std::cout << "expanded_decisions: " << solver.decision_node_count() << "\n";
    std::cout << "player0_expected_utility: " << stats.p1_expected_utility << "\n";
    std::cout << "nash_gap: " << stats.nash_gap << "\n";
    std::cout << "construction_seconds: " << report.construction_seconds << "\n";
    std::cout << "train_seconds: " << report.train_seconds << "\n";
    std::cout << "evaluation_seconds: " << report.evaluation_seconds << "\n";
    std::cout << "solve_runtime_seconds: " << stats.runtime_seconds << "\n";
    std::cout << "wall_seconds: " << wall << "\n";
    std::cout << "memory_budget_bytes: " << report.memory_budget_bytes << "\n";
    std::cout << "allocated_bytes: " << report.allocated_bytes << "\n";
    std::cout << "peak_allocated_bytes: " << report.peak_allocated_bytes << "\n";
    std::cout << "reserved_bytes: " << report.reserved_bytes << "\n";
    std::cout << "estimated_peak_bytes: " << report.estimated_peak_bytes << "\n";
    std::cout << "regret_strategy_sum_bytes: " << report.regret_strategy_sum_bytes << "\n";
    std::cout << "process_peak_working_set_bytes: "
              << report.process_peak_working_set_bytes << "\n";
    for (const poker::solver::StreetMemoryComponent& component : report.components)
    {
        std::cout << "memory_component " << component.name << " " << component.bytes << "\n";
    }

    const double tolerance = 1e-8 * static_cast<double>(config.pot);
    require(std::isfinite(stats.p1_expected_utility), std::string(name) + " value is not finite");
    require(std::abs(stats.p1_expected_utility) <= tolerance, std::string(name) + " value is not centered");
    require(std::isfinite(stats.nash_gap), std::string(name) + " NashConv is not finite");
    require(std::abs(stats.nash_gap) <= tolerance, std::string(name) + " NashConv is above tolerance");
    require(solver.public_decisions() == public_decisions, std::string(name) + " public decision count changed");
    require(solver.public_terminals() == 1, std::string(name) + " public terminal count changed");
    require(
        solver.terminal_count() == solver.deal_count() * runouts,
        std::string(name) + " expanded terminals " + std::to_string(solver.terminal_count()));
    require(
        solver.decision_node_count() == solver.deal_count() * decision_factor,
        std::string(name) + " expanded decisions " + std::to_string(solver.decision_node_count()));
    if (expected_deals != 0)
    {
        require(
            solver.deal_count() == expected_deals,
            std::string(name) + " deals " + std::to_string(solver.deal_count()));
    }
    require(report.memory_budget_bytes == 1024ull * 1048576ull, std::string(name) + " budget");
    require(report.allocated_bytes <= report.peak_allocated_bytes, std::string(name) + " allocated exceeds peak");
    require(report.reserved_bytes == 0, std::string(name) + " reservation credit is outstanding");
    require(report.peak_allocated_bytes <= report.memory_budget_bytes, std::string(name) + " peak exceeded the budget");
    require(report.peak_allocated_bytes > report.regret_strategy_sum_bytes, std::string(name) + " peak is only the two arrays");
    require(report.train_seconds > 0.0, std::string(name) + " training time");
    require(report.evaluation_seconds > 0.0, std::string(name) + " evaluation time");
    if (runouts > 44)
    {
        require(
            solver.terminal_count() > static_cast<std::uint64_t>(std::numeric_limits<int>::max()),
            std::string(name) + " expanded terminals still fit in a 32-bit int");
        require(
            solver.decision_node_count() > static_cast<std::uint64_t>(std::numeric_limits<int>::max()),
            std::string(name) + " expanded decisions still fit in a 32-bit int");
        require(
            solver.terminal_count() == report.expanded_terminals
                && solver.decision_node_count() == report.expanded_decisions,
            std::string(name) + " report narrowed an expanded count");
    }
}

} // namespace

int main()
{
    try
    {
        const int ah = poker::holdem::parse_card("Ah");
        const int kd = poker::holdem::parse_card("Kd");
        const int seven = poker::holdem::parse_card("7c");
        const int four = poker::holdem::parse_card("4s");
        solve_case("turn", {ah, kd, seven, four}, 4, 44, 2ull * (1ull + 44ull), 0);
        solve_case(
            "flop",
            {ah, kd, seven},
            6,
            45ull * 44ull,
            2ull * (1ull + 45ull + 45ull * 44ull),
            1271256ull);
    }
    catch (const std::exception& error)
    {
        std::cerr << error.what() << "\n";
        return 1;
    }
    return 0;
}
