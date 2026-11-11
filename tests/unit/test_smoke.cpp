#include "harness.hpp"

#include "poker/card.hpp"
#include "poker/range.hpp"

void run_smoke_tests()
{
    CHECK(poker::holdem::kDeckSize == 52);
    CHECK(poker::holdem::kComboCount == 1326);
    CHECK(poker::holdem::Range::combo_index(0, 1) == 0);
}
