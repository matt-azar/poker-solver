#pragma once

#include <cstddef>

namespace poker::solver
{

// Persistent StreetBatchSolver table storage. Regret, strategy-sum, the shared
// sigma workspace (frozen strategy during a pass / normalized average during
// evaluation), and the optional PCFR+ prediction table use this width.
// Counterfactual values, NashConv, and other sensitive reductions stay double.
using TableScalar = float;

inline constexpr std::size_t kTableScalarBytes = sizeof(TableScalar);

// Bytes per hand-action entry for the three persistent tables that always exist:
// regret + strategy_sum + shared sigma workspace.
inline constexpr std::size_t kPersistentTableBytesPerEntry = 3 * kTableScalarBytes;

} // namespace poker::solver
