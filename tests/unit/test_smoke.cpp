#include "game/kuhn.hpp"
#include "harness.hpp"

void run_smoke_tests()
{
    CHECK(poker::kuhn::kNumInfosets == 12);
    CHECK(poker::kuhn::kNumDeals == 6);
    CHECK(poker::kuhn::kActionsPerInfoset == 2);
}
