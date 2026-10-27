#include "poker/card.hpp"
#include "poker/range.hpp"
#include "solver/street_batch.hpp"

#include <chrono>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

namespace
{

constexpr double kWallBudgetSeconds = 600.0;
constexpr int kCheckpoints[] = {0, 1, 3, 10, 30, 100, 300, 1000};

void require(bool condition, const std::string& message)
{
    if (!condition)
    {
        throw std::runtime_error(message);
    }
}

double seconds_since(std::chrono::steady_clock::time_point started)
{
    return std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
}

struct Crossing
{
    bool reached = false;
    int iteration = 0;
};

void note_crossing(Crossing& crossing, int iteration, double nash_per_pot, double target)
{
    if (!crossing.reached && nash_per_pot <= target)
    {
        crossing.reached = true;
        crossing.iteration = iteration;
    }
}

void run_case(const char* name, poker::streets::StreetConfig config)
{
    const auto wall_started = std::chrono::steady_clock::now();
    poker::solver::StreetBatchSolver solver(config);
    const poker::solver::StreetMemoryReport built = solver.memory_report();

    std::cout.setf(std::ios::fmtflags(0), std::ios::floatfield);
    std::cout.precision(12);
    std::cout << "case: " << name << "\n";
    std::cout << "deals: " << solver.deal_count() << "\n";
    std::cout << "infosets: " << solver.infoset_count() << "\n";
    std::cout << "public_decisions: " << solver.public_decisions() << "\n";
    std::cout << "public_terminals: " << solver.public_terminals() << "\n";
    std::cout << "expanded_terminals: " << solver.terminal_count() << "\n";
    std::cout << "expanded_decisions: " << solver.decision_node_count() << "\n";
    std::cout << "construction_seconds: " << built.construction_seconds << "\n";
    std::cout << "checkpoint iteration player0_ev player0_br player1_br gain0 gain1 nashconv nashconv_per_pot "
                 "train_seconds evaluation_seconds wall_seconds allocated_bytes peak_allocated_bytes "
                 "reserved_bytes estimated_peak_bytes regret_strategy_sum_bytes process_peak_working_set_bytes\n";

    Crossing cross_01;
    Crossing cross_001;
    int done = 0;
    int reported = -1;
    const char* stop = "iterations";
    bool hit_wall = false;
    for (int target : kCheckpoints)
    {
        while (done < target)
        {
            if (seconds_since(wall_started) >= kWallBudgetSeconds)
            {
                hit_wall = true;
                break;
            }
            solver.continue_frozen_iterations(1, poker::solver::Algorithm::CfrPlus);
            ++done;
        }
        if (done == reported)
        {
            stop = "wall";
            break;
        }
        const double ev = solver.expected_utility();
        const double br0 = solver.p1_best_response_utility();
        const double br1 = solver.p2_best_response_utility();
        const double gain0 = br0 - ev;
        const double gain1 = br1 + ev;
        const double nash = br0 + br1;
        const double nash_per_pot = nash / static_cast<double>(config.pot);
        const poker::solver::StreetMemoryReport report = solver.memory_report();
        const double wall = seconds_since(wall_started);
        std::cout << "checkpoint " << done
                  << " " << ev
                  << " " << br0
                  << " " << br1
                  << " " << gain0
                  << " " << gain1
                  << " " << nash
                  << " " << nash_per_pot
                  << " " << report.train_seconds
                  << " " << report.evaluation_seconds
                  << " " << wall
                  << " " << report.allocated_bytes
                  << " " << report.peak_allocated_bytes
                  << " " << report.reserved_bytes
                  << " " << report.estimated_peak_bytes
                  << " " << report.regret_strategy_sum_bytes
                  << " " << report.process_peak_working_set_bytes
                  << "\n";
        require(std::isfinite(ev) && std::isfinite(br0) && std::isfinite(br1), std::string(name) + " non-finite value");
        require(std::isfinite(nash) && std::isfinite(nash_per_pot), std::string(name) + " non-finite NashConv");
        require(gain0 >= -1e-6 && gain1 >= -1e-6, std::string(name) + " negative exploitability");
        require(std::abs((gain0 + gain1) - nash) <= 1e-6, std::string(name) + " gains do not sum to NashConv");
        require(report.peak_allocated_bytes <= report.memory_budget_bytes, std::string(name) + " peak exceeded the budget");
        note_crossing(cross_01, done, nash_per_pot, 0.01);
        note_crossing(cross_001, done, nash_per_pot, 0.001);
        reported = done;
        if (hit_wall)
        {
            stop = "wall";
            break;
        }
        if (nash_per_pot <= 0.001)
        {
            stop = "accuracy";
            break;
        }
    }
    std::cout << "first_nashconv_per_pot_at_or_below_0.01: "
              << (cross_01.reached ? std::to_string(cross_01.iteration) : "not reached") << "\n";
    std::cout << "first_nashconv_per_pot_at_or_below_0.001: "
              << (cross_001.reached ? std::to_string(cross_001.iteration) : "not reached") << "\n";
    std::cout << "stop: " << stop << "\n";
}

poker::streets::StreetConfig turn_config()
{
    poker::streets::StreetConfig config;
    config.board = {
        poker::holdem::parse_card("Ah"),
        poker::holdem::parse_card("Kd"),
        poker::holdem::parse_card("7c"),
        poker::holdem::parse_card("4s"),
    };
    config.pot = 100;
    config.stack = 100;
    config.oop = poker::holdem::Range::parse("random");
    config.ip = poker::holdem::Range::parse("random");
    config.oop_bet_sizes = {0.5};
    config.ip_bet_sizes = {0.5};
    config.oop_raise_sizes = {0.5};
    config.ip_raise_sizes = {0.5};
    config.allow_all_in = true;
    config.max_raises = 1;
    config.memory_mib = 1024;
    return config;
}

poker::streets::StreetConfig flop_config()
{
    poker::streets::StreetConfig config;
    config.board = {
        poker::holdem::parse_card("Ah"),
        poker::holdem::parse_card("Kd"),
        poker::holdem::parse_card("7c"),
    };
    config.pot = 100;
    config.stack = 100;
    config.oop = poker::holdem::Range::parse("QQ,JJ,TT,99");
    config.ip = poker::holdem::Range::parse("QQ,JJ,TT,99");
    config.oop_bet_sizes = {0.5};
    config.ip_bet_sizes = {0.5};
    config.oop_raise_sizes = {0.5};
    config.ip_raise_sizes = {0.5};
    config.allow_all_in = true;
    config.max_raises = 1;
    config.memory_mib = 1024;
    return config;
}

} // namespace

int main()
{
    try
    {
        std::cout << std::unitbuf;
        run_case("turn_half_pot", turn_config());
        run_case("flop_paired", flop_config());
    }
    catch (const std::exception& error)
    {
        std::cerr << error.what() << "\n";
        return 1;
    }
    return 0;
}
