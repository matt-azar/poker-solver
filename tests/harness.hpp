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
void run_river_tests();
void run_street_tests();
void run_street_memory_tests();
void run_budget_tests();
