add_library(poker_equity STATIC
    src/poker/equity.cpp
)
target_link_libraries(poker_equity PUBLIC poker_solver_core)
poker_set_warnings(poker_equity)

add_executable(equity_calculator src/equity_main.cpp)
target_link_libraries(equity_calculator PRIVATE poker_equity)
poker_set_warnings(equity_calculator)

add_executable(equity_tests tests/equity/test_equity.cpp)
target_link_libraries(equity_tests PRIVATE poker_equity)
poker_set_warnings(equity_tests)

add_test(NAME equity_tests COMMAND equity_tests)
