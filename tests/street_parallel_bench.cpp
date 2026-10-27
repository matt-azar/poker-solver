#include "poker/card.hpp"
#include "poker/range.hpp"
#include "solver/street_batch.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <span>
#include <string>
#include <utility>
#include <vector>

namespace
{

constexpr int kThreads[] = {1, 2, 4, 8};
constexpr int kCheckpoints[] = {0, 1, 3, 10, 30, 100, 300, 1000};
constexpr double kWallBudgetSeconds = 600.0;
int g_checkpoint_limit = 1000;

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

double median_of(double a, double b, double c)
{
    double values[3] = {a, b, c};
    std::sort(values, values + 3);
    return values[1];
}

double relative_delta(const std::vector<double>& left, std::span<const double> right)
{
    require(left.size() == right.size(), "table length changed");
    double worst = 0.0;
    for (std::size_t index = 0; index < left.size(); ++index)
    {
        const double scale = 1.0 + std::max(std::abs(left[index]), std::abs(right[index]));
        worst = std::max(worst, std::abs(left[index] - right[index]) / scale);
    }
    return worst;
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

void print_memory(const poker::solver::StreetMemoryReport& report)
{
    std::cout << "memory allocated " << report.allocated_bytes
              << " peak " << report.peak_allocated_bytes
              << " reserved " << report.reserved_bytes
              << " estimated " << report.estimated_peak_bytes
              << " regret_strategy_sum " << report.regret_strategy_sum_bytes
              << " rss " << report.process_peak_working_set_bytes
              << " threads " << report.thread_count
              << "\n";
}

void profile_case(const char* name, poker::streets::StreetConfig config, int threads)
{
    config.threads = threads;
    poker::solver::StreetBatchSolver solver(config);
    solver.enable_walk_profile(true);
    solver.run_frozen_iterations(3, poker::solver::Algorithm::CfrPlus);
    const poker::solver::StreetWalkProfile profile = solver.walk_profile();
    const poker::solver::StreetMemoryReport report = solver.memory_report();
    std::cout << "profile " << name << " threads " << threads
              << " order_seconds " << profile.order_seconds
              << " showdown_seconds " << profile.showdown_seconds
              << " decision_seconds " << profile.decision_seconds
              << " chance_seconds " << profile.chance_seconds
              << " train_seconds " << report.train_seconds
              << " cache_init_seconds " << report.cache_init_seconds
              << "\n";
    require(report.train_seconds > 0.0, "profile training time");
    require(profile.showdown_seconds > 0.0, "profile missed showdown");
    require(profile.order_seconds > 0.0, "profile missed ordering");
    require(profile.order_seconds <= profile.showdown_seconds * 1.000000001, "order outside showdown");
}

struct SpeedResult
{
    int threads = 1;
    double median_train = 0.0;
    double range_train = 0.0;
};

SpeedResult speed_case(const char* name, poker::streets::StreetConfig config, int threads)
{
    config.threads = threads;
    const auto wall_started = std::chrono::steady_clock::now();
    poker::solver::StreetBatchSolver solver(config);
    const poker::solver::StreetMemoryReport built = solver.memory_report();
    std::cout << "speed " << name << " threads " << threads
              << " construction " << built.construction_seconds
              << " worker_setup " << built.worker_setup_seconds
              << "\n";
    print_memory(built);
    solver.run_frozen_iterations(1, poker::solver::Algorithm::CfrPlus);
    const poker::solver::StreetMemoryReport warmed = solver.memory_report();
    std::cout << "speed " << name << " threads " << threads
              << " warmup_train " << warmed.train_seconds
              << " cache_init " << warmed.cache_init_seconds
              << "\n";
    require(warmed.cache_init_seconds > 0.0, "rank cache was not initialized");
    require(warmed.allocated_bytes == built.allocated_bytes, "warmup allocated");
    require(warmed.peak_allocated_bytes == built.peak_allocated_bytes, "warmup raised peak");
    double samples[3] = {};
    for (int rep = 0; rep < 3; ++rep)
    {
        const double before = solver.memory_report().train_seconds;
        const auto rep_started = std::chrono::steady_clock::now();
        solver.run_frozen_iterations(30, poker::solver::Algorithm::CfrPlus);
        const double train = solver.memory_report().train_seconds - before;
        const double wall = seconds_since(rep_started);
        samples[rep] = train;
        std::cout << "speed " << name << " threads " << threads
                  << " rep " << (rep + 1)
                  << " train " << train
                  << " wall " << wall
                  << "\n";
        require(train > 0.0, "empty training rep");
    }
    const double med = median_of(samples[0], samples[1], samples[2]);
    const double low = std::min(samples[0], std::min(samples[1], samples[2]));
    const double high = std::max(samples[0], std::max(samples[1], samples[2]));
    const poker::solver::StreetMemoryReport done = solver.memory_report();
    std::cout << "speed " << name << " threads " << threads
              << " median_train " << med
              << " range_train " << (high - low)
              << " total_wall " << seconds_since(wall_started)
              << "\n";
    print_memory(done);
    require(done.peak_allocated_bytes <= done.memory_budget_bytes, "speed run exceeded the budget");
    require(done.reserved_bytes == 0, "speed run left a reservation");
    SpeedResult result;
    result.threads = threads;
    result.median_train = med;
    result.range_train = high - low;
    return result;
}

struct Snapshot
{
    int iteration = 0;
    double ev = 0.0;
    double br0 = 0.0;
    double br1 = 0.0;
    double nash = 0.0;
    std::vector<double> regret;
    std::vector<double> strategy_sum;
};

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

std::vector<Snapshot> converge_case(
    const char* name,
    poker::streets::StreetConfig config,
    int threads,
    const std::vector<Snapshot>* reference)
{
    config.threads = threads;
    const auto wall_started = std::chrono::steady_clock::now();
    poker::solver::StreetBatchSolver solver(config);
    const poker::solver::StreetMemoryReport built = solver.memory_report();
    std::cout << "converge " << name << " threads " << threads
              << " deals " << solver.deal_count()
              << " infosets " << solver.infoset_count()
              << " public_decisions " << solver.public_decisions()
              << " expanded_terminals " << solver.terminal_count()
              << " expanded_decisions " << solver.decision_node_count()
              << " construction " << built.construction_seconds
              << " worker_setup " << built.worker_setup_seconds
              << "\n";
    print_memory(built);
    std::vector<Snapshot> saved;
    Crossing cross_01;
    Crossing cross_001;
    int done = 0;
    for (int target : kCheckpoints)
    {
        if (target > g_checkpoint_limit)
        {
            break;
        }
        while (done < target)
        {
            if (seconds_since(wall_started) >= kWallBudgetSeconds)
            {
                std::cout << "converge " << name << " threads " << threads << " hit_wall " << done << "\n";
                return saved;
            }
            solver.continue_frozen_iterations(1, poker::solver::Algorithm::CfrPlus);
            ++done;
        }
        const double ev = solver.expected_utility();
        const double br0 = solver.p1_best_response_utility();
        const double br1 = solver.p2_best_response_utility();
        const double gain0 = br0 - ev;
        const double gain1 = br1 + ev;
        const double nash = br0 + br1;
        const double nash_per_pot = nash / static_cast<double>(config.pot);
        const poker::solver::StreetMemoryReport report = solver.memory_report();
        std::cout << "converge " << name << " threads " << threads
                  << " iteration " << done
                  << " ev " << ev
                  << " br0 " << br0
                  << " br1 " << br1
                  << " gain0 " << gain0
                  << " gain1 " << gain1
                  << " nash " << nash
                  << " nash_per_pot " << nash_per_pot
                  << " train " << report.train_seconds
                  << " cache_init " << report.cache_init_seconds
                  << " eval " << report.evaluation_seconds
                  << " wall " << seconds_since(wall_started)
                  << "\n";
        print_memory(report);
        require(std::isfinite(ev) && std::isfinite(nash), "non-finite convergence value");
        require(gain0 >= -1e-6 && gain1 >= -1e-6, "negative exploitability");
        require(std::abs((gain0 + gain1) - nash) <= 1e-6, "gains do not sum to NashConv");
        require(report.allocated_bytes == built.allocated_bytes, "training allocated");
        require(report.peak_allocated_bytes == built.peak_allocated_bytes, "training raised peak");
        note_crossing(cross_01, done, nash_per_pot, 0.01);
        note_crossing(cross_001, done, nash_per_pot, 0.001);
        if (done == 3 || done == 30 || done == 100 || done == 300)
        {
            Snapshot shot;
            shot.iteration = done;
            shot.ev = ev;
            shot.br0 = br0;
            shot.br1 = br1;
            shot.nash = nash;
            const auto regret = solver.regret_table();
            const auto sum = solver.strategy_sum_table();
            shot.regret.assign(regret.begin(), regret.end());
            shot.strategy_sum.assign(sum.begin(), sum.end());
            if (reference != nullptr)
            {
                const Snapshot* match = nullptr;
                for (const Snapshot& item : *reference)
                {
                    if (item.iteration == done)
                    {
                        match = &item;
                        break;
                    }
                }
                if (match == nullptr)
                {
                    std::cout << "parity " << name << " threads " << threads
                              << " iteration " << done << " skipped\n";
                }
                else
                {
                    const double regret_delta = relative_delta(match->regret, regret);
                    const double sum_delta = relative_delta(match->strategy_sum, sum);
                    std::cout << "parity " << name << " threads " << threads
                              << " iteration " << done
                              << " regret " << regret_delta
                              << " strategy_sum " << sum_delta
                              << "\n";
                    require(regret_delta <= 1e-12, "regret table drifted");
                    require(sum_delta <= 1e-12, "strategy sum drifted");
                    require(std::abs(ev - match->ev) <= 1e-8 * config.pot, "EV drifted");
                    require(std::abs(nash - match->nash) <= 1e-8 * config.pot, "NashConv drifted");
                }
            }
            saved.push_back(std::move(shot));
        }
        if (cross_001.reached)
        {
            break;
        }
    }
    std::cout << "converge " << name << " threads " << threads
              << " cross_0.01 " << (cross_01.reached ? cross_01.iteration : -1)
              << " cross_0.001 " << (cross_001.reached ? cross_001.iteration : -1)
              << "\n";
    return saved;
}

void set_checkpoint_limit(int limit)
{
    g_checkpoint_limit = limit;
}

void converge_against_one_thread(const char* name, poker::streets::StreetConfig config, const int* threads, int count)
{
    const std::vector<Snapshot> reference = converge_case(name, config, 1, nullptr);
    for (int index = 0; index < count; ++index)
    {
        if (threads[index] == 1)
        {
            continue;
        }
        converge_case(name, config, threads[index], &reference);
    }
}

} // namespace

int main(int argc, char** argv)
{
    try
    {
        std::cout << std::unitbuf;
        std::cout.setf(std::ios::fmtflags(0), std::ios::floatfield);
        std::cout.precision(12);
        const bool converge_only = argc > 1 && std::string(argv[1]) == "converge";
        if (argc > 2)
        {
            set_checkpoint_limit(std::stoi(argv[2]));
        }
        if (!converge_only)
        {
            profile_case("turn_half_pot", turn_config(), 1);
            profile_case("turn_half_pot", turn_config(), 4);
            profile_case("flop_paired", flop_config(), 1);
            profile_case("flop_paired", flop_config(), 4);

            SpeedResult turn_speed[4];
            SpeedResult flop_speed[4];
            for (int index = 0; index < 4; ++index)
            {
                turn_speed[index] = speed_case("turn_half_pot", turn_config(), kThreads[index]);
                flop_speed[index] = speed_case("flop_paired", flop_config(), kThreads[index]);
            }
            int best_turn = 2;
            int best_flop = 2;
            double best_turn_time = turn_speed[1].median_train;
            double best_flop_time = flop_speed[1].median_train;
            for (int index = 2; index < 4; ++index)
            {
                if (turn_speed[index].median_train < best_turn_time)
                {
                    best_turn_time = turn_speed[index].median_train;
                    best_turn = kThreads[index];
                }
                if (flop_speed[index].median_train < best_flop_time)
                {
                    best_flop_time = flop_speed[index].median_train;
                    best_flop = kThreads[index];
                }
            }
            std::cout << "best turn_threads " << best_turn
                      << " speedup " << (turn_speed[0].median_train / best_turn_time)
                      << " flop_threads " << best_flop
                      << " speedup " << (flop_speed[0].median_train / best_flop_time)
                      << "\n";
        }
        constexpr int kCompareThreads[] = {1, 2, 4, 8};
        converge_against_one_thread("turn_half_pot", turn_config(), kCompareThreads, 4);
        converge_against_one_thread("flop_paired", flop_config(), kCompareThreads, 4);
    }
    catch (const std::exception& error)
    {
        std::cerr << error.what() << "\n";
        return 1;
    }
    return 0;
}
