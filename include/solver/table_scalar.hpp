#pragma once

#include <cstddef>

namespace poker::solver
{

// Default StreetBatchSolver table storage width. Regret, strategy-sum, the shared
// sigma workspace (frozen strategy during a pass / normalized average during
// evaluation), and the optional PCFR+ prediction table use this width when
// StreetConfig::table_i16 is false. With table_i16, regret/strategy-sum use
// int16 + per-block scales (see compressed_tables.hpp); sigma and PCFR+
// prediction stay float. Counterfactual values, NashConv, and other sensitive
// reductions stay double.
using TableScalar = float;

inline constexpr std::size_t kTableScalarBytes = sizeof(TableScalar);

// Bytes per hand-action entry for the three persistent tables that always exist:
// regret + strategy_sum + shared sigma workspace.
inline constexpr std::size_t kPersistentTableBytesPerEntry = 3 * kTableScalarBytes;

} // namespace poker::solver
