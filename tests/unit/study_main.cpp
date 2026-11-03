#include "harness.hpp"

#include <exception>
#include <iostream>

int main()
{
    std::cout << std::unitbuf;
    std::cerr << std::unitbuf;
    try
    {
    run_session_tests();
    run_value_worker_tests();
    run_checkpoint_tests();
    run_recent_files_tests();
    run_template_tests();
    run_range_library_tests();
    }
    catch (const std::exception& error)
    {
        std::cerr << "exception " << error.what() << "\n";
        return 1;
    }

    std::cout << "passed=" << g_passed << " failed=" << g_failures << "\n";
    return g_failures == 0 ? 0 : 1;
}
