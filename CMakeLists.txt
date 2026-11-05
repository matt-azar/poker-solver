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

find_package(Threads REQUIRED)

# --- Library boundaries (dependency direction is one-way) ---
# poker_primitives            cards, evaluator, ranges
# poker_solver                production postflop engine (StreetBatch + regret matching)
# poker_solver_reference      Kuhn/Leduc wrappers + reference CLIs/tests (optional)
# poker_solver_legacy_river   RiverBatchSolver for PSOL kind=2 / oracle fixtures (optional)
# poker_study                 explorer session services: workers, checkpoints (uses solver)
# poker_equity                check-down equity (uses primitives only)
#
# Reference enumerators (StreetGame, RiverGame, CfrTrainer) are header-only and
# stay available to TUs that include them; the reference *library* owns Kuhn
# object files. Production poker_solver must not link the reference or legacy
# targets.

option(POKER_SOLVER_ENABLE_REFERENCE
    "Build reference enumerators support: Kuhn/Leduc, --reference CLIs, oracle tests"
    ON)
option(POKER_SOLVER_ENABLE_LEGACY_RIVER
    "Build RiverBatchSolver and PSOL kind=2 open/continue support"
    ON)

add_library(poker_primitives STATIC
    src/poker/card.cpp
    src/poker/hand_eval.cpp
    src/poker/hand_categories.cpp
    src/poker/range.cpp
)
target_include_directories(poker_primitives PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
)
poker_set_warnings(poker_primitives)

add_library(poker_solver STATIC
    src/solver/regret_matching.cpp
    src/solver/street_batch.cpp
    src/solver/postflop/tree.cpp
    src/solver/postflop/tables.cpp
    src/solver/postflop/showdown.cpp
    src/solver/postflop/traversal.cpp
    src/solver/postflop/evaluation.cpp
    src/solver/postflop/inspection.cpp
    src/solver/postflop/execution.cpp
    src/solver/postflop/schedules.cpp
)
target_include_directories(poker_solver PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
)
target_link_libraries(poker_solver PUBLIC poker_primitives Threads::Threads)
if(WIN32)
    target_link_libraries(poker_solver PUBLIC psapi)
endif()
poker_set_warnings(poker_solver)

if(POKER_SOLVER_ENABLE_REFERENCE)
    add_library(poker_solver_reference STATIC
        src/reference/kuhn.cpp
        src/reference/kuhn_cfr.cpp
        src/reference/kuhn_best_response.cpp
    )
    target_include_directories(poker_solver_reference PUBLIC
        "${CMAKE_CURRENT_SOURCE_DIR}/include"
    )
    target_link_libraries(poker_solver_reference PUBLIC poker_solver)
    target_compile_definitions(poker_solver_reference PUBLIC POKER_SOLVER_HAS_REFERENCE=1)
    poker_set_warnings(poker_solver_reference)
endif()

if(POKER_SOLVER_ENABLE_LEGACY_RIVER)
    add_library(poker_solver_legacy_river STATIC
        src/legacy/river_batch.cpp
    )
    target_include_directories(poker_solver_legacy_river PUBLIC
        "${CMAKE_CURRENT_SOURCE_DIR}/include"
    )
    target_link_libraries(poker_solver_legacy_river PUBLIC poker_solver)
    target_compile_definitions(poker_solver_legacy_river PUBLIC POKER_SOLVER_HAS_LEGACY_RIVER=1)
    poker_set_warnings(poker_solver_legacy_river)
endif()

add_library(poker_study STATIC
    src/explorer/value_worker.cpp
    src/explorer/checkpoint.cpp
)
target_include_directories(poker_study PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
)
target_link_libraries(poker_study PUBLIC poker_solver)
if(POKER_SOLVER_ENABLE_LEGACY_RIVER)
    target_link_libraries(poker_study PUBLIC poker_solver_legacy_river)
endif()
poker_set_warnings(poker_study)

# Compatibility alias: historical target name used by benches/docs.
add_library(poker_solver_core INTERFACE)
target_link_libraries(poker_solver_core INTERFACE poker_study)

include(cmake/EquityTargets.cmake)

if(POKER_SOLVER_ENABLE_REFERENCE)
    add_executable(kuhn_solver src/cli/kuhn_main.cpp)
    target_link_libraries(kuhn_solver PRIVATE poker_solver_reference)
    poker_set_warnings(kuhn_solver)

    add_executable(leduc_solver src/cli/leduc_main.cpp)
    target_link_libraries(leduc_solver PRIVATE poker_solver_reference)
    poker_set_warnings(leduc_solver)
endif()

add_executable(river_solver src/cli/river_main.cpp)
target_link_libraries(river_solver PRIVATE poker_solver)
if(POKER_SOLVER_ENABLE_REFERENCE)
    # StreetGame + CfrTrainer are header-only; the define gates --reference.
    target_compile_definitions(river_solver PRIVATE POKER_SOLVER_HAS_REFERENCE=1)
endif()
poker_set_warnings(river_solver)

add_executable(street_solver src/cli/street_main.cpp)
target_link_libraries(street_solver PRIVATE poker_solver)
if(POKER_SOLVER_ENABLE_REFERENCE)
    target_compile_definitions(street_solver PRIVATE POKER_SOLVER_HAS_REFERENCE=1)
endif()
poker_set_warnings(street_solver)

# Study HTTP server needs legacy river for PSOL kind=2 open/continue.
if(POKER_SOLVER_ENABLE_LEGACY_RIVER)
    add_executable(explorer
        src/cli/explorer_main.cpp
        src/explorer/server_globals.cpp
        src/explorer/server_json.cpp
        src/explorer/server_jobs.cpp
        src/explorer/server_http.cpp
        src/explorer/server_run.cpp
        src/explorer/equity_jobs.cpp
        src/explorer/equity_http.cpp
    )
    target_include_directories(explorer PRIVATE
        "${CMAKE_CURRENT_SOURCE_DIR}/src/explorer"
    )
    target_link_libraries(explorer PRIVATE poker_study poker_equity)
    if(WIN32)
        target_link_libraries(explorer PRIVATE ws2_32)
    endif()
    poker_set_warnings(explorer)
endif()

enable_testing()

# Engine / solver unit tests — no explorer process dependency.
set(POKER_ENGINE_TEST_SOURCES
    tests/unit/engine_main.cpp
    tests/unit/test_smoke.cpp
    tests/unit/test_holdem.cpp
    tests/unit/test_hand_categories.cpp
    tests/unit/test_payoff.cpp
    tests/unit/test_rake.cpp
    tests/unit/test_icm.cpp
    tests/unit/test_icm_solve.cpp
    tests/unit/test_incentives.cpp
    tests/unit/test_incentives_solve.cpp
    tests/unit/test_nashconv.cpp
    tests/unit/test_streets.cpp
    tests/unit/test_budget.cpp
    tests/unit/test_chance.cpp
    tests/unit/test_action_ev.cpp
    tests/unit/test_strategy_report.cpp
    tests/unit/test_equity_dist.cpp
    tests/unit/test_node_lock.cpp
    tests/unit/test_lock_apply.cpp
    tests/unit/test_strategy_edit.cpp
    tests/unit/test_tree_edit.cpp
    tests/unit/test_hand_history.cpp
    tests/unit/test_dcfr.cpp
    tests/unit/test_pcfr.cpp
)
if(POKER_SOLVER_ENABLE_REFERENCE)
    list(APPEND POKER_ENGINE_TEST_SOURCES
        tests/unit/test_kuhn.cpp
        tests/unit/test_cfr.cpp
        tests/unit/test_leduc.cpp
    )
endif()
if(POKER_SOLVER_ENABLE_LEGACY_RIVER)
    list(APPEND POKER_ENGINE_TEST_SOURCES
        tests/unit/test_river.cpp
    )
endif()

add_executable(poker_engine_tests ${POKER_ENGINE_TEST_SOURCES})
target_include_directories(poker_engine_tests PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/tests"
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
)
# poker_study for PSOL round-trip coverage inside DCFR/PCFR tests (no explorer process).
target_link_libraries(poker_engine_tests PRIVATE poker_study poker_equity)
if(POKER_SOLVER_ENABLE_REFERENCE)
    target_link_libraries(poker_engine_tests PRIVATE poker_solver_reference)
endif()
poker_set_warnings(poker_engine_tests)
if(MSVC)
    target_link_options(poker_engine_tests PRIVATE "/STACK:8388608")
endif()
add_test(NAME poker_engine_tests COMMAND poker_engine_tests)

# Study-service tests (session, checkpoint, value worker, libraries) — no HTTP process.
add_executable(poker_study_tests
    tests/unit/study_main.cpp
    tests/unit/test_session.cpp
    tests/unit/test_value_worker.cpp
    tests/unit/test_checkpoint.cpp
    tests/unit/test_recent_files.cpp
    tests/unit/test_templates.cpp
    tests/unit/test_range_library.cpp
)
target_include_directories(poker_study_tests PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/tests"
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
)
target_link_libraries(poker_study_tests PRIVATE poker_study poker_equity)
poker_set_warnings(poker_study_tests)
add_test(NAME poker_study_tests COMMAND poker_study_tests)

# HTTP / process integration tests — require the explorer binary.
if(POKER_SOLVER_ENABLE_LEGACY_RIVER)
    add_executable(poker_http_tests
        tests/unit/http_main.cpp
        tests/unit/test_explorer_http.cpp
        tests/unit/test_explorer_workflow.cpp
    )
    target_include_directories(poker_http_tests PRIVATE
        "${CMAKE_CURRENT_SOURCE_DIR}/tests"
        "${CMAKE_CURRENT_SOURCE_DIR}/include"
    )
    target_link_libraries(poker_http_tests PRIVATE poker_study poker_equity)
    if(WIN32)
        target_link_libraries(poker_http_tests PRIVATE ws2_32)
    endif()
    add_dependencies(poker_http_tests explorer)
    poker_set_warnings(poker_http_tests)
    add_test(NAME poker_http_tests COMMAND poker_http_tests)
endif()

# Compatibility meta-target used by CI and local "build all unit suites".
if(POKER_SOLVER_ENABLE_LEGACY_RIVER)
    add_custom_target(poker_solver_tests
        DEPENDS poker_engine_tests poker_study_tests poker_http_tests
    )
else()
    add_custom_target(poker_solver_tests
        DEPENDS poker_engine_tests poker_study_tests
    )
endif()

# Full-range check-down. Not part of ctest: it allocates hundreds of mebibytes.
add_executable(street_memory_bench benchmarks/bin/street_memory_bench.cpp)
target_link_libraries(street_memory_bench PRIVATE poker_solver)
poker_set_warnings(street_memory_bench)

# Betting convergence. Not part of ctest: each case may run for ten minutes.
add_executable(street_betting_bench benchmarks/bin/street_betting_bench.cpp)
target_link_libraries(street_betting_bench PRIVATE poker_solver)
poker_set_warnings(street_betting_bench)

# Thread scaling for the two betting trees. Not part of ctest.
add_executable(street_parallel_bench benchmarks/bin/street_parallel_bench.cpp)
target_link_libraries(street_parallel_bench PRIVATE poker_solver)
poker_set_warnings(street_parallel_bench)
