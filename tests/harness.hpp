#pragma once

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <string>

inline int g_failures = 0;
inline int g_passed = 0;

#define CHECK(cond)                                                                 \
    do                                                                              \
    {                                                                               \
        if (!(cond))                                                                \
        {                                                                           \
            std::cerr << "FAIL " << __FILE__ << ":" << __LINE__ << " " << #cond     \
                      << "\n";                                                      \
            ++g_failures;                                                           \
        }                                                                           \
        else                                                                        \
        {                                                                           \
            ++g_passed;                                                             \
        }                                                                           \
    } while (0)

#define CHECK_NEAR(a, b, eps) CHECK(std::abs(static_cast<double>(a) - static_cast<double>(b)) <= (eps))

/** Unique path under the OS temp directory for this process/invocation. */
inline std::filesystem::path unique_temp_path(const char* prefix)
{
    static std::atomic<unsigned> counter{0};
    const unsigned n = ++counter;
    const auto stamp = static_cast<unsigned long long>(
        std::chrono::steady_clock::now().time_since_epoch().count());
    const std::string name = std::string(prefix) + "-" + std::to_string(stamp) + "-"
        + std::to_string(n);
    return std::filesystem::temp_directory_path() / name;
}

/** Create a unique empty directory under the OS temp directory. */
inline std::filesystem::path make_unique_temp_dir(const char* prefix)
{
    const std::filesystem::path root = unique_temp_path(prefix);
    std::filesystem::create_directories(root);
    return root;
}

#if defined(POKER_SOLVER_SOURCE_DIR)
inline std::filesystem::path poker_source_dir()
{
    return std::filesystem::path(POKER_SOLVER_SOURCE_DIR);
}
#endif

void run_smoke_tests();
void run_cfr_tests();
void run_dcfr_tests();
void run_pcfr_tests();
void run_holdem_tests();
void run_hand_category_tests();
void run_river_tests();
void run_payoff_tests();
void run_icm_tests();
void run_icm_solve_tests();
void run_incentives_tests();
void run_incentives_solve_tests();
void run_nashconv_tests();
void run_street_tests();
void run_street_memory_tests();
void run_street_workspace_tests();
void run_street_parallel_tests();
void run_street_showdown_tests();
void run_street_inspect_tests();
void run_budget_tests();
void run_session_tests();
void run_explorer_http_tests();
void run_explorer_workflow_tests();
void run_street_chance_tests();
void run_action_value_tests();
void run_value_worker_tests();
void run_checkpoint_tests();
void run_strategy_report_tests();
void run_equity_dist_tests();
void run_recent_files_tests();
void run_template_tests();
void run_range_library_tests();
void run_node_lock_tests();
void run_lock_apply_tests();
void run_strategy_edit_tests();
void run_tree_edit_tests();
void run_hand_history_tests();
