#include "harness.hpp"

#include <iostream>

int main()
{
    run_smoke_tests();
    run_kuhn_tests();
    run_cfr_tests();

    std::cout << "passed=" << g_passed << " failed=" << g_failures << "\n";
    return g_failures == 0 ? 0 : 1;
}
