#pragma once

#include "solver/dcfr.hpp"
#include "solver/table_scalar.hpp"
#include "solver/training_state.hpp"

#include <cstdint>
#include <span>
#include <string>
#include <vector>

namespace poker::explorer
{

// Shared Open/Save ceiling. Open already rejected larger files; Save must not
// silently produce a file that Open cannot reload.
constexpr std::uint64_t kMaxCheckpointBytes = 2ull * 1024ull * 1024ull * 1024ull;

// One resumable solution. The config text rebuilds the tree. The tables are the
// regrets, strategy sums, and completed iteration count for that exact tree.
// utility is always root-centered zero-sum chips.
struct CheckpointDocument
{
    // 1 is a street tree. 2 is a river tree.
    std::uint8_t kind = 1;
    // 0 vanilla, 1 CFR+, 2 linear, 3 DCFR, 4 PCFR+. Do not renumber.
    std::uint8_t algorithm = 1;
    bool frozen = false;
    int samples = 5;
    double accuracy = -1.0;
    std::string config_text;
    solver::TrainingTables tables;
    double value = 0.0;
    double p1_best_response = 0.0;
    double p2_best_response = 0.0;
    double nash_gap = 0.0;
    double runtime_seconds = 0.0;
    std::vector<int> sample_iterations;
    std::vector<double> sample_values;
    std::vector<double> sample_gaps;
    // Empty means no locks. Writers emit PSOL payload version 2+ with this
    // field (format_lock_set text). Version 1 readers still open with empty locks.
    std::string locks_text;
    // PSOL v3 continuation: actual DCFR(α,β,γ) used for training. When false,
    // readers keep solver defaults (1.5, 0, 2).
    bool has_dcfr_params = false;
    solver::DcfrParams dcfr{};
    // PSOL v3 continuation: PCFR+ prediction m. Empty means cold-start m=0
    // (v1/v2 files, or non-PCFR solves).
    std::vector<double> prediction;
};

enum class CheckpointFault
{
    None,
    // The temporary file is removed and the destination is left untouched.
    BeforeReplace
};

// Optional float-table views for StreetBatch export. When set, regret /
// strategy_sum / prediction are streamed as f64 without materializing the
// corresponding double vectors on CheckpointDocument.
struct CheckpointScalarTables
{
    std::span<const solver::TableScalar> regret{};
    std::span<const solver::TableScalar> strategy_sum{};
    std::span<const solver::TableScalar> prediction{};
};

// Serialized payload size (excluding the 32-byte file header). Rejects shapes
// that cannot be written. Does not allocate the payload.
std::uint64_t estimate_checkpoint_payload_bytes(
    const CheckpointDocument& document,
    const CheckpointScalarTables* scalars = nullptr);

// Rejects a payload larger than max_payload_bytes before/while writing.
// Streams the payload with incremental checksums so a complete payload string
// and a complete file string are never held at once. A failed write leaves any
// previous destination file in place.
void write_checkpoint(
    const std::string& path,
    const CheckpointDocument& document,
    CheckpointFault fault = CheckpointFault::None,
    std::uint64_t max_payload_bytes = kMaxCheckpointBytes,
    const CheckpointScalarTables* scalars = nullptr);

CheckpointDocument read_checkpoint(const std::string& path, std::uint64_t max_payload_bytes);

} // namespace poker::explorer
