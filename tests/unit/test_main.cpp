#include "harness.hpp"

#include <exception>
#include <iostream>

int main()
{
    std::cout << std::unitbuf;
    std::cerr << std::unitbuf;
    try
    {
    run_smoke_tests();
    run_kuhn_tests();
    run_cfr_tests();
    run_leduc_tests();
    run_holdem_tests();
    run_hand_category_tests();
    run_river_tests();
    run_payoff_tests();
    run_icm_tests();
    run_icm_solve_tests();
    run_incentives_tests();
    run_budget_tests();
    run_street_tests();
    run_street_memory_tests();
    run_street_workspace_tests();
    run_street_parallel_tests();
    run_street_showdown_tests();
    run_street_inspect_tests();
    run_session_tests();
    run_explorer_http_tests();
    run_street_chance_tests();
    run_action_value_tests();
    run_value_worker_tests();
    run_checkpoint_tests();
    run_strategy_report_tests();
    run_equity_dist_tests();
    run_recent_files_tests();
    run_template_tests();
    run_range_library_tests();
    run_node_lock_tests();
    run_lock_apply_tests();
    run_tree_edit_tests();
    run_hand_history_tests();
    }
    catch (const std::exception& error)
    {
        std::cerr << "exception " << error.what() << "\n";
        return 1;
    }

    std::cout << "passed=" << g_passed << " failed=" << g_failures << "\n";
    return g_failures == 0 ? 0 : 1;
}
