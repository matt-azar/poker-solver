#pragma once

#include "solver/node_lock.hpp"

#include <cstddef>
#include <span>

namespace poker::solver
{

// Fills current[0..n) from regrets using regret matching.
// If the sum of positive regrets is zero, uses a uniform strategy.
void regret_matching(const double* regrets, double* current, int n);

// Adds reach_i * current[a] into strategy_sum[a] for each action.
void accumulate_average(double* strategy_sum, const double* current, int n, double reach_i);

// Normalizes strategy_sum into out. Uniform if the sum is zero.
void normalize_average(const double* strategy_sum, double* out, int n);

// After regret matching (or any current mixture), overwrite probs with the locked
// row when the lock applies to combo_index. Null lock, unlocked (empty) row, or
// SelectedCombos that omit this combo leave probs unchanged. A zero probability
// on a locked action is still a lock. Returns true when a lock was applied.
// Requires probs.size() == lock->actions.size() when applying.
inline bool apply_lock_to_strategy(
    std::span<double> probs,
    const NodeLock* lock,
    std::size_t combo_index)
{
    if (lock == nullptr || lock->actions.unlocked())
    {
        return false;
    }
    if (lock->kind == LockKind::SelectedCombos && !combo_is_selected(*lock, combo_index))
    {
        return false;
    }
    if (probs.size() != lock->actions.probs.size())
    {
        throw std::invalid_argument("lock action count does not match strategy size");
    }
    for (std::size_t action = 0; action < probs.size(); ++action)
    {
        probs[action] = lock->actions.probs[action];
    }
    return true;
}

} // namespace poker::solver
