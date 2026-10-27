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
)
target_include_directories(poker_solver_core PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
)
poker_set_warnings(poker_solver_core)

add_executable(kuhn_solver src/main.cpp)
target_link_libraries(kuhn_solver PRIVATE poker_solver_core)
poker_set_warnings(kuhn_solver)

add_executable(leduc_solver src/leduc_main.cpp)
target_link_libraries(leduc_solver PRIVATE poker_solver_core)
poker_set_warnings(leduc_solver)

enable_testing()

add_executable(poker_solver_tests
    tests/unit/test_main.cpp
    tests/unit/test_smoke.cpp
    tests/unit/test_kuhn.cpp
    tests/unit/test_cfr.cpp
    tests/unit/test_leduc.cpp
)
target_include_directories(poker_solver_tests PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/tests"
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
)
target_link_libraries(poker_solver_tests PRIVATE poker_solver_core)
poker_set_warnings(poker_solver_tests)

add_test(NAME poker_solver_tests COMMAND poker_solver_tests)
