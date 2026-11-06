#pragma once

#include "poker/equity.hpp"
#include "poker/range.hpp"

#include <cstdint>
#include <limits>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace poker::holdem
{

// Standalone multiway equity calculator (2–6 players). Independent of Study
// node equity. Equity is expected fractional ownership of one common pot.
// Outright win → 1; k-way tie → 1/k. Win/Tie/Loss are exclusive event
// probabilities (Win + Tie + Loss = 1 per player). Across players, Equity
// sums to 1 when the joint is defined.

inline constexpr int kEquityCalculatorMinPlayers = 2;
inline constexpr int kEquityCalculatorMaxPlayers = 6;

// Exact enumeration ceiling for calculator jobs (deal evaluations =
// legal tuples × board completions). Distinct from Study pair-runout limits.
inline constexpr std::uint64_t kEquityCalculatorDefaultMaxExactDeals = 5'000'000;
// Auto uses Exact when the bounded work estimate is at or below this.
inline constexpr std::uint64_t kEquityCalculatorAutoExactThreshold = 2'000'000;
inline constexpr std::uint64_t kEquityCalculatorDefaultTargetSamples = 100'000;
inline constexpr std::uint64_t kEquityCalculatorDefaultMaxAttempts = 5'000'000;
inline constexpr char kEquityCalculatorModel[] = "check-down";
inline constexpr char kEquityCalculatorUnits[] = "fraction of the pot";
inline constexpr char kEquityCalculatorMethodVersion[] = "equity-calc-1";

enum class EquityCalcMethod
{
    Auto,
    Exact,
    MonteCarlo
};

enum class EquityCalcFailure
{
    InvalidInput,
    InvalidWeight,
    NoLegalJoint,
    WorkLimit,
    SampleLimit,
    Cancelled,
    NumericalRange
};

class EquityCalcError : public std::runtime_error
{
public:
    EquityCalcError(
        EquityCalcFailure failure,
        const std::string& message,
        std::uint64_t required_work = 0,
        std::uint64_t allowed_work = 0);

    EquityCalcFailure failure() const noexcept { return failure_; }
    std::uint64_t required_work() const noexcept { return required_; }
    std::uint64_t allowed_work() const noexcept { return allowed_; }

private:
    EquityCalcFailure failure_;
    std::uint64_t required_ = 0;
    std::uint64_t allowed_ = 0;
};

struct EquityCalcPlayerInput
{
    std::string id;
    Range range;
};

struct EquityCalcOptions
{
    EquityCalcMethod method = EquityCalcMethod::Auto;
    std::uint64_t max_exact_deals = kEquityCalculatorDefaultMaxExactDeals;
    std::uint64_t auto_exact_threshold = kEquityCalculatorAutoExactThreshold;
    std::uint64_t target_samples = kEquityCalculatorDefaultTargetSamples;
    std::uint64_t max_attempts = kEquityCalculatorDefaultMaxAttempts;
    std::uint64_t seed = 1;
    bool (*cancel_poll)(void* context) = nullptr;
    void* cancel_context = nullptr;
    // Optional progress: deals_or_samples evaluated so far, estimated total (0 if unknown).
    void (*progress)(void* context, std::uint64_t done, std::uint64_t total_or_zero) = nullptr;
    void* progress_context = nullptr;
};

struct EquityCalcWorkEstimate
{
    std::uint64_t legal_tuples = 0;
    std::uint64_t completions_per_tuple = 0;
    std::uint64_t exact_deals = 0; // saturates at UINT64_MAX
    bool estimate_capped = false; // true when enumeration was abandoned as over-limit
};

struct EquityCalcPlayerResult
{
    std::string id;
    bool defined = false;
    double equity = 0.0;
    double win = 0.0;
    double tie = 0.0;
    double loss = 0.0;
    // Approximate 95% mean interval from sample variance (Monte Carlo only).
    // NaN when unavailable (exact, or insufficient samples).
    double equity_ci_low = std::numeric_limits<double>::quiet_NaN();
    double equity_ci_high = std::numeric_limits<double>::quiet_NaN();
};

struct EquityCalcResult
{
    bool joint_defined = false;
    EquityCalcMethod requested_method = EquityCalcMethod::Auto;
    EquityCalcMethod actual_method = EquityCalcMethod::Exact;
    std::string method_reason;
    bool exact_complete = false;
    bool stopped = false; // Monte Carlo published after Stop
    EquityCalcWorkEstimate work;
    std::uint64_t accepted_samples = 0;
    std::uint64_t attempted_tuples = 0;
    std::uint64_t seed = 0;
    std::string method_version = kEquityCalculatorMethodVersion;
    double elapsed_seconds = 0.0;
    std::vector<EquityCalcPlayerResult> players;
};

// Board length must be 0, 3, 4, or 5. Dead cards are removed from private
// hands and from board completion. Active player count is 2–6.
EquityCalcWorkEstimate estimate_equity_work(
    std::span<const EquityCalcPlayerInput> players,
    std::span<const int> board,
    std::span<const int> dead_cards);

EquityCalcResult calculate_equity(
    std::span<const EquityCalcPlayerInput> players,
    std::span<const int> board,
    std::span<const int> dead_cards,
    const EquityCalcOptions& options = {});

EquityCalcMethod parse_equity_calc_method(std::string_view text);
std::string_view equity_calc_method_name(EquityCalcMethod method);

std::vector<int> parse_equity_calc_cards(std::string_view text);

std::string equity_calc_result_json(
    const EquityCalcResult& result,
    std::span<const int> board,
    std::span<const int> dead_cards);

} // namespace poker::holdem
