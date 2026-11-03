#pragma once

// Shared solve configuration and result types used by CfrTrainer and the
// production batch solvers. Keep the generic trainer implementation out of
// headers that only need these declarations.

#include "solver/dcfr.hpp"
#include "solver/evaluation.hpp"
#include "solver/node_lock.hpp"

#include <cstdint>
#include <stdexcept>
#include <vector>

namespace poker::solver
{

enum class Algorithm
{
    VanillaCfr,
    CfrPlus,
    // Regret and the average strategy are both weighted by the iteration index.
    // Regrets are not floored. Both players update in one traversal.
    LinearCfr,
    // Fixed DCFR(1.5, 0, 2): alternating passes, signed regrets with
    // pass-level discounting, quadratic own-reach average weights.
    Dcfr,
    // Predictive CFR+ (PRM+): alternating frozen passes; regret matching on
    // R+m with m = last instantaneous CF regret; CFR+ floor after the pass;
    // linear (t) own-reach average. Cold-starts m=0.
    PcfrPlus
};

struct SolveConfig
{
    int max_iterations = 1;
    // Negative: do not stop early. Otherwise stop when the Nash gap is at or below this value.
    double nash_gap_threshold = -1.0;
    // How often to measure (and record) the Nash gap when a threshold is set.
    // Must be positive for mid-loop evaluation. Default evaluates every iteration.
    // eval_interval is a legacy alias for the same storage.
    union
    {
        int eval_every = 1;
        int eval_interval;
    };
    // Negative: no wall-clock cap. Otherwise stop after a completed iteration when
    // steady_clock time since solve start meets or exceeds this many seconds.
    // Checked at iteration boundaries only (safe for continue/stop semantics).
    double max_wall_seconds = -1.0;
    // Non-owning. Null keeps today's unlocked regret-matching behavior bit-identical.
    // When set, locked rows replace the current strategy after RM for matching infosets.
    const LockSet* locks = nullptr;
    // Used when algorithm is DCFR. Defaults are the fixed product triple (1.5,0,2).
    // Not stored in PSOL; reload / continue after checkpoint uses solver defaults
    // unless the caller sets them again.
    DcfrParams dcfr{};
};

struct SolveStats
{
    int iterations = 0;
    double runtime_seconds = 0.0;
    std::size_t memory_bytes_estimate = 0;
    double p1_expected_utility = 0.0;
    double p1_best_response_utility = 0.0;
    double p2_best_response_utility = 0.0;
    double nash_gap = 0.0;
    // True when the loop halted because max_wall_seconds was reached.
    bool time_limit_reached = false;
    // Nash gaps recorded at each accuracy evaluation when nash_gap_threshold >= 0
    // (including a final evaluate that was not already a mid-loop checkpoint).
    // Cleared at solve start. Empty when no threshold was armed.
    std::vector<double> nash_gap_history;
    std::vector<int> nash_gap_iterations;
};

struct BestResponseResult
{
    // Modeled utility for player 0 under (BR0, σ1). Chip EV only when the
    // payoff model is plain chips (no rake/ICM/incentives).
    double p1_utility_when_p1_responds = 0.0;
    // Modeled utility for player 1 under (σ0, BR1). Under zero-sum chip EV this
    // equals -u0(σ0, BR1); with incentives it is utility[1] directly.
    double p2_utility_when_p2_responds = 0.0;
    // Sum of unilateral BR gains in modeled utility. Valid as general-sum
    // NashConv; do not claim chip Nash-gap under active incentives.
    double nash_gap = 0.0;
};

inline void apply_evaluation(SolveStats& stats, const EvaluationResult& evaluation)
{
    stats.p1_expected_utility = evaluation.u0;
    stats.p1_best_response_utility = evaluation.br0;
    stats.p2_best_response_utility = evaluation.br1;
    stats.nash_gap = evaluation.nash_gap;
}

inline BestResponseResult best_response_from_evaluation(const EvaluationResult& evaluation)
{
    BestResponseResult result;
    result.p1_utility_when_p1_responds = evaluation.br0;
    result.p2_utility_when_p2_responds = evaluation.br1;
    result.nash_gap = evaluation.nash_gap;
    return result;
}

inline const char* algorithm_name(Algorithm algorithm)
{
    if (algorithm == Algorithm::CfrPlus)
    {
        return "cfr_plus";
    }
    if (algorithm == Algorithm::LinearCfr)
    {
        return "linear_cfr";
    }
    if (algorithm == Algorithm::Dcfr)
    {
        return "dcfr";
    }
    if (algorithm == Algorithm::PcfrPlus)
    {
        return "pcfr_plus";
    }
    return "vanilla_cfr";
}

// Checkpoint / PSOL algorithm tags. Do not renumber existing values.
inline constexpr std::uint8_t kAlgorithmTagVanilla = 0;
inline constexpr std::uint8_t kAlgorithmTagCfrPlus = 1;
inline constexpr std::uint8_t kAlgorithmTagLinear = 2;
inline constexpr std::uint8_t kAlgorithmTagDcfr = 3;
inline constexpr std::uint8_t kAlgorithmTagPcfrPlus = 4;
inline constexpr std::uint8_t kAlgorithmTagMax = kAlgorithmTagPcfrPlus;

inline std::uint8_t algorithm_tag(Algorithm algorithm)
{
    if (algorithm == Algorithm::VanillaCfr)
    {
        return kAlgorithmTagVanilla;
    }
    if (algorithm == Algorithm::CfrPlus)
    {
        return kAlgorithmTagCfrPlus;
    }
    if (algorithm == Algorithm::LinearCfr)
    {
        return kAlgorithmTagLinear;
    }
    if (algorithm == Algorithm::Dcfr)
    {
        return kAlgorithmTagDcfr;
    }
    if (algorithm == Algorithm::PcfrPlus)
    {
        return kAlgorithmTagPcfrPlus;
    }
    throw std::invalid_argument("algorithm has no checkpoint tag");
}

inline Algorithm algorithm_from_tag(std::uint8_t tag)
{
    if (tag == kAlgorithmTagVanilla)
    {
        return Algorithm::VanillaCfr;
    }
    if (tag == kAlgorithmTagCfrPlus)
    {
        return Algorithm::CfrPlus;
    }
    if (tag == kAlgorithmTagLinear)
    {
        return Algorithm::LinearCfr;
    }
    if (tag == kAlgorithmTagDcfr)
    {
        return Algorithm::Dcfr;
    }
    if (tag == kAlgorithmTagPcfrPlus)
    {
        return Algorithm::PcfrPlus;
    }
    throw std::invalid_argument("checkpoint algorithm is unknown");
}

}  // namespace poker::solver
