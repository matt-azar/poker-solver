#pragma once

#include "solver/training_state.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace poker::explorer
{

// One resumable solution. The config text rebuilds the tree. The tables are the
// regrets, strategy sums, and completed iteration count for that exact tree.
// utility is always root-centered zero-sum chips.
struct CheckpointDocument
{
    // 1 is a street tree. 2 is a river tree.
    std::uint8_t kind = 1;
    // 0 vanilla, 1 CFR+, 2 linear.
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
};

enum class CheckpointFault
{
    None,
    // The temporary file is removed and the destination is left untouched.
    BeforeReplace
};

// Rejects a payload larger than max_payload_bytes before allocating it.
// A failed write leaves any previous destination file in place.
void write_checkpoint(
    const std::string& path,
    const CheckpointDocument& document,
    CheckpointFault fault = CheckpointFault::None);

CheckpointDocument read_checkpoint(const std::string& path, std::uint64_t max_payload_bytes);

} // namespace poker::explorer
