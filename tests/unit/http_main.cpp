#include "harness.hpp"

#include <exception>
#include <iostream>

int main()
{
    std::cout << std::unitbuf;
    std::cerr << std::unitbuf;
    try
    {
    run_explorer_http_tests();
    run_explorer_workflow_tests();
    }
    catch (const std::exception& error)
    {
        std::cerr << "exception " << error.what() << "\n";
        return 1;
    }

    std::cout << "passed=" << g_passed << " failed=" << g_failures << "\n";
    return g_failures == 0 ? 0 : 1;
}
