#pragma once

#include "poker/range.hpp"

#include <cstdint>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace poker::holdem
{

// Check-down showdown equity. A tie contributes one half of the pot.
// Values are fractions in [0, 1]. This is a separate quantity from chip EV.
//
// A full off-board random-vs-random river is 1,070,190 pair-runouts
// (`As Kd Qc Jh 9c`). The default admits that common study case with a little
// headroom. A full-range turn is about 51M pair-runouts and still rejects.
inline constexpr std::uint64_t kFullRangeRiverPairRunouts = 1070190;
inline constexpr std::uint64_t kDefaultMaxPairRunouts = 1100000;
static_assert(kDefaultMaxPairRunouts >= kFullRangeRiverPairRunouts);
inline constexpr char kEquityModel[] = "check-down";
inline constexpr char kEquityUnits[] = "fraction of the pot";

enum class EquityFailure
{
    InvalidInput,
    InvalidWeight,
    WorkLimit,
    Cancelled,
    // Finite inputs whose joint exists, but a derived weight, mass, or ratio is not a finite double.
    NumericalRange
};

class EquityError : public std::runtime_error
{
public:
    EquityError(
        EquityFailure failure,
        const std::string& message,
        std::uint64_t required_pair_runouts = 0,
        std::uint64_t allowed_pair_runouts = 0);

    EquityFailure failure() const noexcept { return failure_; }
    std::uint64_t required_pair_runouts() const noexcept { return required_; }
    std::uint64_t allowed_pair_runouts() const noexcept { return allowed_; }

private:
    EquityFailure failure_;
    std::uint64_t required_ = 0;
    std::uint64_t allowed_ = 0;
};

// Null never cancels. The probe is called after validation, before each legal
// pair, and after every 16 runouts inside a pair. A true return throws
// EquityFailure::Cancelled and discards partial sums.
struct ShowdownEquityOptions
{
    std::uint64_t max_pair_runouts = kDefaultMaxPairRunouts;
    bool (*cancel_poll)(void* context) = nullptr;
    void* cancel_context = nullptr;
};

struct ComboShowdown
{
    int index = 0;
    std::string combo;
    double input_weight = 0.0;
    bool defined = false;
    // Unnormalized sum of compatible opponent input weights. Meaningful when defined.
    double compatible_mass = 0.0;
    double marginal = 0.0;
    double win = 0.0;
    double tie = 0.0;
    double loss = 0.0;
    double equity = 0.0;
};

struct PlayerShowdown
{
    bool defined = false;
    double win = 0.0;
    double tie = 0.0;
    double loss = 0.0;
    double equity = 0.0;
    // Positive input-weight combos, ascending combo index. Zero-weight combos are omitted.
    std::vector<ComboShowdown> combos;
};

struct ShowdownWork
{
    std::uint64_t legal_pairs = 0;
    std::uint64_t completions_per_pair = 0;
    std::uint64_t pair_runouts = 0;
};

struct ShowdownEquity
{
    bool joint_defined = false;
    ShowdownWork work;
    PlayerShowdown player0;
    PlayerShowdown player1;
};

// Fixed check-down equity histogram over [0, 1]. Ten equal-width buckets:
// [0, 0.1), [0.1, 0.2), ..., [0.8, 0.9), [0.9, 1.0]. The last bucket includes 1.
// Bucket weights are the raw (unnormalized) nonnegative input masses that land
// in that interval. Their sum equals the total finite nonnegative weight that
// was counted. Equities outside [0, 1] are clamped. This is check-down equity,
// not chip EV.
inline constexpr int kEquityDistributionBuckets = 10;

struct EquityDistributionBucket
{
    double lo = 0.0;
    double hi = 0.0;
    double weight = 0.0;
};

// equities and weights must have the same length. Weights must be finite and
// nonnegative. Empty input yields ten zero-weight buckets.
std::vector<EquityDistributionBucket> equity_distribution(
    std::span<const double> equities,
    std::span<const double> weights);

// Defined combos only, weighted by each combo's input_weight. Undefined or
// zero-weight rows do not contribute.
std::vector<EquityDistributionBucket> equity_distribution(const PlayerShowdown& player);

// Board length is 3, 4, or 5. Weights must be finite and nonnegative.
// An empty legal joint is a successful undefined result.
ShowdownWork measure_showdown_work(
    std::span<const int> board,
    const Range& player0,
    const Range& player1);

ShowdownEquity showdown_equity(
    std::span<const int> board,
    const Range& player0,
    const Range& player1,
    const ShowdownEquityOptions& options = {});

std::vector<int> parse_equity_board(std::string_view text);
Range parse_equity_range(std::string_view text);

// Undefined numerical fields are JSON null. Input weights stay distinct from marginals.
std::string showdown_equity_json(
    const ShowdownEquity& equity,
    std::span<const int> board,
    double elapsed_seconds);

} // namespace poker::holdem
