cmake_minimum_required(VERSION 3.16)
project(poker_solver VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

function(poker_set_warnings target)
    if(MSVC)
        target_compile_options(${target} PRIVATE /W4)
    else()
        target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic)
    endif()
endfunction()

add_library(poker_solver_core STATIC
    src/game/kuhn.cpp
    src/solver/regret_matching.cpp
    src/solver/cfr.cpp
    src/solver/best_response.cpp
    src/solver/river_batch.cpp
    src/solver/street_batch.cpp
    src/explorer/value_worker.cpp
    src/explorer/checkpoint.cpp
    src/poker/card.cpp
    src/poker/hand_eval.cpp
    src/poker/range.cpp
)
target_include_directories(poker_solver_core PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
)
find_package(Threads REQUIRED)
if(WIN32)
    target_link_libraries(poker_solver_core PUBLIC psapi)
endif()
target_link_libraries(poker_solver_core PUBLIC Threads::Threads)
poker_set_warnings(poker_solver_core)

include(cmake/EquityTargets.cmake)

add_executable(kuhn_solver src/main.cpp)
target_link_libraries(kuhn_solver PRIVATE poker_solver_core)
poker_set_warnings(kuhn_solver)

add_executable(leduc_solver src/leduc_main.cpp)
target_link_libraries(leduc_solver PRIVATE poker_solver_core)
poker_set_warnings(leduc_solver)

add_executable(river_solver src/river_main.cpp)
target_link_libraries(river_solver PRIVATE poker_solver_core)
poker_set_warnings(river_solver)

add_executable(street_solver src/street_main.cpp)
target_link_libraries(street_solver PRIVATE poker_solver_core)
poker_set_warnings(street_solver)

add_executable(explorer src/explorer_main.cpp)
target_link_libraries(explorer PRIVATE poker_solver_core poker_equity)
if(WIN32)
    target_link_libraries(explorer PRIVATE ws2_32)
endif()
poker_set_warnings(explorer)

enable_testing()

add_executable(poker_solver_tests
    tests/unit/test_main.cpp
    tests/unit/test_smoke.cpp
    tests/unit/test_kuhn.cpp
    tests/unit/test_cfr.cpp
    tests/unit/test_leduc.cpp
    tests/unit/test_holdem.cpp
    tests/unit/test_river.cpp
    tests/unit/test_streets.cpp
    tests/unit/test_budget.cpp
    tests/unit/test_session.cpp
    tests/unit/test_explorer_http.cpp
    tests/unit/test_chance.cpp
    tests/unit/test_action_ev.cpp
    tests/unit/test_value_worker.cpp
    tests/unit/test_checkpoint.cpp
    tests/unit/test_recent_files.cpp
)
target_include_directories(poker_solver_tests PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/tests"
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
)
target_link_libraries(poker_solver_tests PRIVATE poker_solver_core poker_equity)
if(WIN32)
    target_link_libraries(poker_solver_tests PRIVATE ws2_32)
endif()
add_dependencies(poker_solver_tests explorer)
poker_set_warnings(poker_solver_tests)
if(MSVC)
    target_link_options(poker_solver_tests PRIVATE "/STACK:8388608")
endif()

add_test(NAME poker_solver_tests COMMAND poker_solver_tests)

# Full-range check-down. Not part of ctest: it allocates hundreds of mebibytes.
add_executable(street_memory_bench tests/street_memory_bench.cpp)
target_link_libraries(street_memory_bench PRIVATE poker_solver_core)
poker_set_warnings(street_memory_bench)

# Betting convergence. Not part of ctest: each case may run for ten minutes.
add_executable(street_betting_bench tests/street_betting_bench.cpp)
target_link_libraries(street_betting_bench PRIVATE poker_solver_core)
poker_set_warnings(street_betting_bench)

# Thread scaling for the two betting trees. Not part of ctest.
add_executable(street_parallel_bench tests/street_parallel_bench.cpp)
target_link_libraries(street_parallel_bench PRIVATE poker_solver_core)
poker_set_warnings(street_parallel_bench)
