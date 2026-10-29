#pragma once

#include <cstdint>
#include <vector>

namespace poker::solver
{

// Regret and strategy-sum tables for one solved tree, plus the identity those
// tables are laid out against. A reload rebuilds the tree from the same
// configuration and refuses the tables when the combo order or action counts differ.
struct TrainingTables
{
    int iterations = 0;
    std::vector<int> oop_combos;
    std::vector<int> ip_combos;
    std::vector<std::uint16_t> slot_actions;
    std::vector<double> regret;
    std::vector<double> strategy_sum;
};

} // namespace poker::solver
