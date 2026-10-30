#pragma once

#include <cmath>
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

void run_smoke_tests();
void run_kuhn_tests();
void run_cfr_tests();
void run_leduc_tests();
void run_holdem_tests();
void run_hand_category_tests();
void run_river_tests();
void run_payoff_tests();
void run_street_tests();
void run_street_memory_tests();
void run_street_workspace_tests();
void run_street_parallel_tests();
void run_street_showdown_tests();
void run_street_inspect_tests();
void run_budget_tests();
void run_session_tests();
void run_explorer_http_tests();
void run_street_chance_tests();
void run_action_value_tests();
void run_value_worker_tests();
void run_checkpoint_tests();
void run_strategy_report_tests();
void run_equity_dist_tests();
void run_recent_files_tests();
