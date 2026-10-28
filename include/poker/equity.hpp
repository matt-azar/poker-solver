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
inline constexpr std::uint64_t kDefaultMaxPairRunouts = 1000000;
inline constexpr char kEquityModel[] = "check-down";
inline constexpr char kEquityUnits[] = "fraction of the pot";

enum class EquityFailure
{
    InvalidInput,
    InvalidWeight,
    WorkLimit,
    Cancelled
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
