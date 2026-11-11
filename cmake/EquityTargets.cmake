add_library(poker_equity STATIC
    src/poker/equity.cpp
    src/poker/equity_calculator.cpp
)
target_link_libraries(poker_equity PUBLIC poker_primitives)
poker_set_warnings(poker_equity)

add_executable(equity_calculator src/cli/equity_main.cpp)
target_link_libraries(equity_calculator PRIVATE poker_equity)
poker_set_warnings(equity_calculator)

if(BUILD_TESTING)
    add_executable(equity_tests tests/equity/test_equity.cpp)
    target_link_libraries(equity_tests PRIVATE poker_equity)
    poker_set_warnings(equity_tests)

    add_executable(equity_calculator_tests tests/equity/test_equity_calculator.cpp)
    target_link_libraries(equity_calculator_tests PRIVATE poker_equity)
    poker_set_warnings(equity_calculator_tests)

    add_test(NAME equity_tests COMMAND equity_tests
        WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
    add_test(NAME equity_calculator_tests COMMAND equity_calculator_tests
        WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
endif()
