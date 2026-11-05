#include "poker/equity_calculator.hpp"

#include "poker/card.hpp"
#include "poker/hand_eval.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <functional>
#include <numeric>
#include <sstream>
#include <stdexcept>

namespace poker::holdem
{
namespace
{

struct Accumulator
{
    double sum = 0.0;
    double compensation = 0.0;

    void add(double value)
    {
        const double adjusted = value - compensation;
        const double next = sum + adjusted;
        compensation = (next - sum) - adjusted;
        sum = next;
    }

    double value() const { return sum; }
};

struct HandRef
{
    int index = 0;
    int card0 = 0;
    int card1 = 0;
    double weight = 0.0;
};

struct PlayerHands
{
    std::string id;
    std::vector<HandRef> hands;
};

[[noreturn]] void fail(
    EquityCalcFailure failure,
    const std::string& message,
    std::uint64_t required = 0,
    std::uint64_t allowed = 0)
{
    throw EquityCalcError(failure, message, required, allowed);
}

void check_cancel(const EquityCalcOptions& options)
{
    if (options.cancel_poll != nullptr && options.cancel_poll(options.cancel_context))
    {
        fail(EquityCalcFailure::Cancelled, "equity calculation cancelled");
    }
}

void report_progress(const EquityCalcOptions& options, std::uint64_t done, std::uint64_t total)
{
    if (options.progress != nullptr)
    {
        options.progress(options.progress_context, done, total);
    }
}

void validate_board_and_dead(std::span<const int> board, std::span<const int> dead)
{
    const std::size_t n = board.size();
    if (!(n == 0 || n == 3 || n == 4 || n == 5))
    {
        fail(
            EquityCalcFailure::InvalidInput,
            "invalid equity input: board must contain 0, 3, 4, or 5 distinct cards");
    }
    std::uint64_t seen = 0;
    auto consume = [&](int card, const char* label) {
        if (!valid_card(card))
        {
            fail(EquityCalcFailure::InvalidInput, std::string("invalid equity input: ") + label + " contains an invalid card");
        }
        const std::uint64_t bit = std::uint64_t{1} << card;
        if ((seen & bit) != 0)
        {
            fail(EquityCalcFailure::InvalidInput, std::string("invalid equity input: duplicate card in ") + label);
        }
        seen |= bit;
    };
    for (int card : board)
    {
        consume(card, "board");
    }
    for (int card : dead)
    {
        consume(card, "dead cards / board");
    }
}

void validate_weights(const Range& range)
{
    for (double weight : range.weights())
    {
        if (!std::isfinite(weight) || weight < 0.0)
        {
            fail(EquityCalcFailure::InvalidWeight, "invalid equity weight: a range weight must be finite and nonnegative");
        }
    }
}

std::uint64_t card_mask(std::span<const int> cards)
{
    std::uint64_t mask = 0;
    for (int card : cards)
    {
        mask |= std::uint64_t{1} << card;
    }
    return mask;
}

bool blocked_by(int card0, int card1, std::uint64_t dead)
{
    const std::uint64_t hand = (std::uint64_t{1} << card0) | (std::uint64_t{1} << card1);
    return (hand & dead) != 0;
}

std::uint64_t saturating_choose(std::uint64_t n, std::uint64_t k)
{
    if (k > n)
    {
        return 0;
    }
    if (k == 0 || k == n)
    {
        return 1;
    }
    if (k > n - k)
    {
        k = n - k;
    }
    std::uint64_t result = 1;
    for (std::uint64_t i = 1; i <= k; ++i)
    {
        const std::uint64_t numerator = n - k + i;
        // Divide first when possible to reduce overflow risk, then multiply.
        const std::uint64_t g = std::gcd(result, i);
        const std::uint64_t reduced_result = result / g;
        const std::uint64_t reduced_i = i / g;
        if (numerator > UINT64_MAX / reduced_result)
        {
            return UINT64_MAX;
        }
        result = (reduced_result * numerator) / reduced_i;
    }
    return result;
}

std::uint64_t saturating_mul(std::uint64_t a, std::uint64_t b)
{
    if (a == 0 || b == 0)
    {
        return 0;
    }
    if (a > UINT64_MAX / b)
    {
        return UINT64_MAX;
    }
    return a * b;
}

std::uint64_t completions_for(std::size_t board_count, int cards_removed)
{
    const int need = 5 - static_cast<int>(board_count);
    if (need < 0)
    {
        return 0;
    }
    const int remaining = 52 - cards_removed;
    if (remaining < need)
    {
        return 0;
    }
    return saturating_choose(static_cast<std::uint64_t>(remaining), static_cast<std::uint64_t>(need));
}

std::vector<HandRef> collect_hands(const Range& range, std::uint64_t dead)
{
    std::vector<HandRef> hands;
    for (int index = 0; index < kComboCount; ++index)
    {
        const double weight = range.weight(index);
        if (!(weight > 0.0))
        {
            continue;
        }
        HandRef hand;
        hand.index = index;
        Range::combo_cards(index, hand.card0, hand.card1);
        hand.weight = weight;
        if (!blocked_by(hand.card0, hand.card1, dead))
        {
            hands.push_back(hand);
        }
    }
    return hands;
}

std::vector<PlayerHands> prepare_players(
    std::span<const EquityCalcPlayerInput> players,
    std::uint64_t dead)
{
    if (players.size() < static_cast<std::size_t>(kEquityCalculatorMinPlayers)
        || players.size() > static_cast<std::size_t>(kEquityCalculatorMaxPlayers))
    {
        fail(
            EquityCalcFailure::InvalidInput,
            "invalid equity input: calculator requires 2 to 6 active players");
    }
    std::vector<PlayerHands> prepared;
    prepared.reserve(players.size());
    for (const EquityCalcPlayerInput& player : players)
    {
        if (player.id.empty())
        {
            fail(EquityCalcFailure::InvalidInput, "invalid equity input: player id is required");
        }
        validate_weights(player.range);
        PlayerHands row;
        row.id = player.id;
        row.hands = collect_hands(player.range, dead);
        if (row.hands.empty())
        {
            // Structurally empty after blockers — joint will be empty.
        }
        prepared.push_back(std::move(row));
    }
    return prepared;
}

bool shares_any(int card0, int card1, std::uint64_t used)
{
    return ((std::uint64_t{1} << card0) & used) != 0 || ((std::uint64_t{1} << card1) & used) != 0;
}

// Count legal tuples with early abort once product exceeds limit.
std::uint64_t count_legal_tuples(
    const std::vector<PlayerHands>& players,
    std::uint64_t limit,
    bool& capped)
{
    capped = false;
    const int n = static_cast<int>(players.size());
    std::vector<int> pick(static_cast<std::size_t>(n), -1);
    std::uint64_t count = 0;

    std::function<void(int, std::uint64_t)> walk = [&](int depth, std::uint64_t used) {
        if (capped)
        {
            return;
        }
        if (depth == n)
        {
            if (count == UINT64_MAX)
            {
                capped = true;
                return;
            }
            ++count;
            if (count > limit)
            {
                capped = true;
            }
            return;
        }
        for (std::size_t i = 0; i < players[static_cast<std::size_t>(depth)].hands.size(); ++i)
        {
            if (capped)
            {
                return;
            }
            const HandRef& hand = players[static_cast<std::size_t>(depth)].hands[i];
            if (shares_any(hand.card0, hand.card1, used))
            {
                continue;
            }
            pick[static_cast<std::size_t>(depth)] = static_cast<int>(i);
            const std::uint64_t next =
                used | (std::uint64_t{1} << hand.card0) | (std::uint64_t{1} << hand.card1);
            walk(depth + 1, next);
        }
    };

    walk(0, 0);
    return count;
}

void assign_shares(
    std::span<const HandValue> values,
    std::span<double> equity_share,
    std::span<double> win_event,
    std::span<double> tie_event,
    std::span<double> loss_event)
{
    const int n = static_cast<int>(values.size());
    int best = 0;
    for (int i = 1; i < n; ++i)
    {
        if (values[static_cast<std::size_t>(best)] < values[static_cast<std::size_t>(i)])
        {
            best = i;
        }
    }
    int winners = 0;
    for (int i = 0; i < n; ++i)
    {
        if (values[static_cast<std::size_t>(i)] == values[static_cast<std::size_t>(best)])
        {
            ++winners;
        }
    }
    const double share = 1.0 / static_cast<double>(winners);
    for (int i = 0; i < n; ++i)
    {
        if (values[static_cast<std::size_t>(i)] == values[static_cast<std::size_t>(best)])
        {
            equity_share[static_cast<std::size_t>(i)] = share;
            if (winners == 1)
            {
                win_event[static_cast<std::size_t>(i)] = 1.0;
                tie_event[static_cast<std::size_t>(i)] = 0.0;
            }
            else
            {
                win_event[static_cast<std::size_t>(i)] = 0.0;
                tie_event[static_cast<std::size_t>(i)] = 1.0;
            }
            loss_event[static_cast<std::size_t>(i)] = 0.0;
        }
        else
        {
            equity_share[static_cast<std::size_t>(i)] = 0.0;
            win_event[static_cast<std::size_t>(i)] = 0.0;
            tie_event[static_cast<std::size_t>(i)] = 0.0;
            loss_event[static_cast<std::size_t>(i)] = 1.0;
        }
    }
}

void evaluate_deal(
    std::span<const HandRef* const> hands,
    std::span<const int> full_board,
    std::span<double> equity_share,
    std::span<double> win_event,
    std::span<double> tie_event,
    std::span<double> loss_event)
{
    const int n = static_cast<int>(hands.size());
    std::array<HandValue, kEquityCalculatorMaxPlayers> values{};
    int cards[7];
    for (int i = 0; i < 5; ++i)
    {
        cards[i + 2] = full_board[static_cast<std::size_t>(i)];
    }
    for (int i = 0; i < n; ++i)
    {
        cards[0] = hands[static_cast<std::size_t>(i)]->card0;
        cards[1] = hands[static_cast<std::size_t>(i)]->card1;
        values[static_cast<std::size_t>(i)] = evaluate(std::span<const int>(cards, 7));
    }
    assign_shares(
        std::span<const HandValue>(values.data(), static_cast<std::size_t>(n)),
        equity_share,
        win_event,
        tie_event,
        loss_event);
}

void enumerate_completions(
    std::span<const int> board,
    std::uint64_t dead,
    const EquityCalcOptions& options,
    std::uint64_t& scored,
    const std::function<void(std::span<const int>)>& accept)
{
    int full[5];
    const int board_count = static_cast<int>(board.size());
    for (int i = 0; i < board_count; ++i)
    {
        full[i] = board[static_cast<std::size_t>(i)];
    }
    int available[52];
    int available_count = 0;
    for (int card = 0; card < kDeckSize; ++card)
    {
        if ((dead & (std::uint64_t{1} << card)) == 0)
        {
            available[available_count++] = card;
        }
    }
    const int need = 5 - board_count;
    if (need == 0)
    {
        accept(std::span<const int>(full, 5));
        ++scored;
        if (scored % 64 == 0)
        {
            check_cancel(options);
        }
        return;
    }
    if (need == 1)
    {
        for (int i = 0; i < available_count; ++i)
        {
            full[4] = available[i];
            accept(std::span<const int>(full, 5));
            ++scored;
            if (scored % 64 == 0)
            {
                check_cancel(options);
            }
        }
        return;
    }
    // need >= 2: unordered combinations of remaining cards.
    std::function<void(int, int)> choose = [&](int start, int depth) {
        if (depth == need)
        {
            accept(std::span<const int>(full, 5));
            ++scored;
            if (scored % 64 == 0)
            {
                check_cancel(options);
            }
            return;
        }
        for (int i = start; i <= available_count - (need - depth); ++i)
        {
            full[board_count + depth] = available[i];
            choose(i + 1, depth + 1);
        }
    };
    choose(0, 0);
}

struct ExactBins
{
    Accumulator equity;
    Accumulator win;
    Accumulator tie;
    Accumulator loss;
    Accumulator mass;
};

EquityCalcResult run_exact(
    const std::vector<PlayerHands>& players,
    std::span<const int> board,
    std::uint64_t known_dead,
    const EquityCalcOptions& options,
    const EquityCalcWorkEstimate& work,
    EquityCalcMethod requested)
{
    const int n = static_cast<int>(players.size());
    if (work.exact_deals > options.max_exact_deals || work.estimate_capped)
    {
        fail(
            EquityCalcFailure::WorkLimit,
            "equity work limit exceeded: exact enumeration would exceed the calculator ceiling",
            work.estimate_capped ? 0 : work.exact_deals,
            options.max_exact_deals);
    }

    std::vector<ExactBins> bins(static_cast<std::size_t>(n));
    std::vector<const HandRef*> pick(static_cast<std::size_t>(n));
    std::vector<double> equity_share(static_cast<std::size_t>(n));
    std::vector<double> win_event(static_cast<std::size_t>(n));
    std::vector<double> tie_event(static_cast<std::size_t>(n));
    std::vector<double> loss_event(static_cast<std::size_t>(n));
    std::uint64_t deals_done = 0;
    const std::uint64_t total = work.exact_deals;

    std::function<void(int, std::uint64_t, double)> walk = [&](int depth, std::uint64_t used, double weight) {
        check_cancel(options);
        if (depth == n)
        {
            enumerate_completions(
                board,
                used,
                options,
                deals_done,
                [&](std::span<const int> full_board) {
                    evaluate_deal(pick, full_board, equity_share, win_event, tie_event, loss_event);
                    for (int i = 0; i < n; ++i)
                    {
                        bins[static_cast<std::size_t>(i)].equity.add(weight * equity_share[static_cast<std::size_t>(i)]);
                        bins[static_cast<std::size_t>(i)].win.add(weight * win_event[static_cast<std::size_t>(i)]);
                        bins[static_cast<std::size_t>(i)].tie.add(weight * tie_event[static_cast<std::size_t>(i)]);
                        bins[static_cast<std::size_t>(i)].loss.add(weight * loss_event[static_cast<std::size_t>(i)]);
                        bins[static_cast<std::size_t>(i)].mass.add(weight);
                    }
                    report_progress(options, deals_done, total);
                });
            return;
        }
        for (const HandRef& hand : players[static_cast<std::size_t>(depth)].hands)
        {
            if (shares_any(hand.card0, hand.card1, used))
            {
                continue;
            }
            pick[static_cast<std::size_t>(depth)] = &hand;
            const std::uint64_t next =
                used | (std::uint64_t{1} << hand.card0) | (std::uint64_t{1} << hand.card1);
            const double next_weight = weight * hand.weight;
            if (!std::isfinite(next_weight) || next_weight < 0.0)
            {
                fail(EquityCalcFailure::NumericalRange, "equity numerical range exceeded: joint weight is not representable");
            }
            if (!(next_weight > 0.0))
            {
                continue;
            }
            walk(depth + 1, next, next_weight);
        }
    };

    walk(0, known_dead, 1.0);

    EquityCalcResult result;
    result.requested_method = requested;
    result.actual_method = EquityCalcMethod::Exact;
    result.method_reason = "exact enumeration completed";
    result.exact_complete = true;
    result.work = work;
    result.seed = options.seed;

    double mass = 0.0;
    for (int i = 0; i < n; ++i)
    {
        mass = bins[static_cast<std::size_t>(i)].mass.value();
        break;
    }
    if (!(mass > 0.0) || !std::isfinite(mass))
    {
        result.joint_defined = false;
        for (int i = 0; i < n; ++i)
        {
            EquityCalcPlayerResult row;
            row.id = players[static_cast<std::size_t>(i)].id;
            row.defined = false;
            result.players.push_back(row);
        }
        return result;
    }

    result.joint_defined = true;
    for (int i = 0; i < n; ++i)
    {
        EquityCalcPlayerResult row;
        row.id = players[static_cast<std::size_t>(i)].id;
        row.defined = true;
        row.equity = bins[static_cast<std::size_t>(i)].equity.value() / mass;
        row.win = bins[static_cast<std::size_t>(i)].win.value() / mass;
        row.tie = bins[static_cast<std::size_t>(i)].tie.value() / mass;
        row.loss = bins[static_cast<std::size_t>(i)].loss.value() / mass;
        if (!std::isfinite(row.equity) || !std::isfinite(row.win) || !std::isfinite(row.tie)
            || !std::isfinite(row.loss))
        {
            fail(EquityCalcFailure::NumericalRange, "equity numerical range exceeded: result fraction is not representable");
        }
        result.players.push_back(row);
    }
    return result;
}

// SplitMix64 — dedicated calculator RNG; does not touch solver sampling.
struct SplitMix64
{
    std::uint64_t state;

    explicit SplitMix64(std::uint64_t seed)
        : state(seed)
    {
    }

    std::uint64_t next()
    {
        std::uint64_t z = (state += 0x9e3779b97f4a7c15ULL);
        z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ULL;
        z = (z ^ (z >> 27)) * 0x94d049bb133111ebULL;
        return z ^ (z >> 31);
    }

    double uniform()
    {
        return (next() >> 11) * (1.0 / 9007199254740992.0);
    }

    int uniform_int(int n)
    {
        if (n <= 0)
        {
            return 0;
        }
        return static_cast<int>(next() % static_cast<std::uint64_t>(n));
    }
};

struct WeightedSampler
{
    std::vector<const HandRef*> hands;
    std::vector<double> cumulative;
    double total = 0.0;

    explicit WeightedSampler(const std::vector<HandRef>& source)
    {
        hands.reserve(source.size());
        cumulative.reserve(source.size());
        for (const HandRef& hand : source)
        {
            if (!(hand.weight > 0.0))
            {
                continue;
            }
            total += hand.weight;
            hands.push_back(&hand);
            cumulative.push_back(total);
        }
    }

    const HandRef* sample(SplitMix64& rng) const
    {
        if (hands.empty() || !(total > 0.0))
        {
            return nullptr;
        }
        const double draw = rng.uniform() * total;
        const auto it = std::lower_bound(cumulative.begin(), cumulative.end(), draw);
        const std::size_t index =
            static_cast<std::size_t>(std::min<std::ptrdiff_t>(
                it - cumulative.begin(),
                static_cast<std::ptrdiff_t>(hands.size()) - 1));
        return hands[index];
    }
};

EquityCalcResult run_monte_carlo(
    const std::vector<PlayerHands>& players,
    std::span<const int> board,
    std::uint64_t known_dead,
    const EquityCalcOptions& options,
    const EquityCalcWorkEstimate& work,
    EquityCalcMethod requested,
    const std::string& reason,
    bool allow_partial_stop)
{
    const int n = static_cast<int>(players.size());
    std::vector<WeightedSampler> samplers;
    samplers.reserve(static_cast<std::size_t>(n));
    for (const PlayerHands& player : players)
    {
        samplers.emplace_back(player.hands);
        if (samplers.back().hands.empty())
        {
            EquityCalcResult empty;
            empty.requested_method = requested;
            empty.actual_method = EquityCalcMethod::MonteCarlo;
            empty.method_reason = reason;
            empty.work = work;
            empty.seed = options.seed;
            empty.joint_defined = false;
            for (const PlayerHands& row : players)
            {
                EquityCalcPlayerResult player_row;
                player_row.id = row.id;
                empty.players.push_back(player_row);
            }
            return empty;
        }
    }

    SplitMix64 rng(options.seed);
    std::vector<const HandRef*> pick(static_cast<std::size_t>(n));
    std::vector<double> equity_share(static_cast<std::size_t>(n));
    std::vector<double> win_event(static_cast<std::size_t>(n));
    std::vector<double> tie_event(static_cast<std::size_t>(n));
    std::vector<double> loss_event(static_cast<std::size_t>(n));
    std::vector<Accumulator> equity_sum(static_cast<std::size_t>(n));
    std::vector<Accumulator> win_sum(static_cast<std::size_t>(n));
    std::vector<Accumulator> tie_sum(static_cast<std::size_t>(n));
    std::vector<Accumulator> loss_sum(static_cast<std::size_t>(n));
    std::vector<Accumulator> equity_sq(static_cast<std::size_t>(n));

    std::uint64_t accepted = 0;
    std::uint64_t attempted = 0;
    bool stopped = false;

    auto sample_board = [&](std::uint64_t used, int* full) {
        const int board_count = static_cast<int>(board.size());
        for (int i = 0; i < board_count; ++i)
        {
            full[i] = board[static_cast<std::size_t>(i)];
        }
        int available[52];
        int available_count = 0;
        for (int card = 0; card < kDeckSize; ++card)
        {
            if ((used & (std::uint64_t{1} << card)) == 0)
            {
                available[available_count++] = card;
            }
        }
        const int need = 5 - board_count;
        for (int i = 0; i < need; ++i)
        {
            const int pick_i = rng.uniform_int(available_count - i);
            const int card = available[pick_i];
            available[pick_i] = available[available_count - 1 - i];
            full[board_count + i] = card;
        }
    };

    while (accepted < options.target_samples && attempted < options.max_attempts)
    {
        if (options.cancel_poll != nullptr && options.cancel_poll(options.cancel_context))
        {
            if (allow_partial_stop && accepted > 0)
            {
                stopped = true;
                break;
            }
            fail(EquityCalcFailure::Cancelled, "equity calculation cancelled");
        }

        ++attempted;
        bool ok = true;
        std::uint64_t used = known_dead;
        for (int i = 0; i < n; ++i)
        {
            const HandRef* hand = samplers[static_cast<std::size_t>(i)].sample(rng);
            if (hand == nullptr || shares_any(hand->card0, hand->card1, used))
            {
                ok = false;
                break;
            }
            pick[static_cast<std::size_t>(i)] = hand;
            used |= (std::uint64_t{1} << hand->card0) | (std::uint64_t{1} << hand->card1);
        }
        if (!ok)
        {
            continue;
        }

        int full[5];
        sample_board(used, full);
        evaluate_deal(pick, std::span<const int>(full, 5), equity_share, win_event, tie_event, loss_event);
        for (int i = 0; i < n; ++i)
        {
            equity_sum[static_cast<std::size_t>(i)].add(equity_share[static_cast<std::size_t>(i)]);
            win_sum[static_cast<std::size_t>(i)].add(win_event[static_cast<std::size_t>(i)]);
            tie_sum[static_cast<std::size_t>(i)].add(tie_event[static_cast<std::size_t>(i)]);
            loss_sum[static_cast<std::size_t>(i)].add(loss_event[static_cast<std::size_t>(i)]);
            equity_sq[static_cast<std::size_t>(i)].add(
                equity_share[static_cast<std::size_t>(i)] * equity_share[static_cast<std::size_t>(i)]);
        }
        ++accepted;
        if (accepted % 256 == 0)
        {
            report_progress(options, accepted, options.target_samples);
        }
    }

    EquityCalcResult result;
    result.requested_method = requested;
    result.actual_method = EquityCalcMethod::MonteCarlo;
    result.method_reason = reason;
    result.exact_complete = false;
    result.stopped = stopped;
    result.work = work;
    result.accepted_samples = accepted;
    result.attempted_tuples = attempted;
    result.seed = options.seed;

    if (accepted == 0)
    {
        if (attempted >= options.max_attempts)
        {
            fail(
                EquityCalcFailure::SampleLimit,
                "equity sample limit exceeded: no accepted deals before the attempt ceiling",
                attempted,
                options.max_attempts);
        }
        result.joint_defined = false;
        for (const PlayerHands& row : players)
        {
            EquityCalcPlayerResult player_row;
            player_row.id = row.id;
            result.players.push_back(player_row);
        }
        return result;
    }

    result.joint_defined = true;
    const double samples = static_cast<double>(accepted);
    const double z = 1.959963984540054; // ~95% normal quantile
    for (int i = 0; i < n; ++i)
    {
        EquityCalcPlayerResult row;
        row.id = players[static_cast<std::size_t>(i)].id;
        row.defined = true;
        row.equity = equity_sum[static_cast<std::size_t>(i)].value() / samples;
        row.win = win_sum[static_cast<std::size_t>(i)].value() / samples;
        row.tie = tie_sum[static_cast<std::size_t>(i)].value() / samples;
        row.loss = loss_sum[static_cast<std::size_t>(i)].value() / samples;
        const double mean_sq = equity_sq[static_cast<std::size_t>(i)].value() / samples;
        const double var = std::max(0.0, mean_sq - row.equity * row.equity);
        const double se = std::sqrt(var / samples);
        row.equity_ci_low = std::clamp(row.equity - z * se, 0.0, 1.0);
        row.equity_ci_high = std::clamp(row.equity + z * se, 0.0, 1.0);
        result.players.push_back(row);
    }
    return result;
}

// Fast path: reuse existing HU showdown equity when contract matches.
bool try_hu_postflop_fast_path(
    const std::vector<PlayerHands>& /*players*/,
    std::span<const EquityCalcPlayerInput> inputs,
    std::span<const int> board,
    std::span<const int> dead,
    const EquityCalcOptions& options,
    EquityCalcResult& out)
{
    if (inputs.size() != 2 || board.size() < 3 || board.size() > 5 || !dead.empty())
    {
        return false;
    }
    ShowdownEquityOptions hu_options;
    hu_options.max_pair_runouts = options.max_exact_deals;
    hu_options.cancel_poll = options.cancel_poll;
    hu_options.cancel_context = options.cancel_context;
    try
    {
        const ShowdownEquity equity = showdown_equity(board, inputs[0].range, inputs[1].range, hu_options);
        out.requested_method = options.method;
        out.actual_method = EquityCalcMethod::Exact;
        out.method_reason = "exact heads-up postflop fast path";
        out.exact_complete = true;
        out.joint_defined = equity.joint_defined;
        out.work.legal_tuples = equity.work.legal_pairs;
        out.work.completions_per_tuple = equity.work.completions_per_pair;
        out.work.exact_deals = equity.work.pair_runouts;
        out.seed = options.seed;
        auto push = [&](const std::string& id, const PlayerShowdown& player) {
            EquityCalcPlayerResult row;
            row.id = id;
            row.defined = player.defined;
            if (player.defined)
            {
                row.equity = player.equity;
                row.win = player.win;
                row.tie = player.tie;
                row.loss = player.loss;
            }
            out.players.push_back(row);
        };
        push(inputs[0].id, equity.player0);
        push(inputs[1].id, equity.player1);
        return true;
    }
    catch (const EquityError& error)
    {
        if (error.failure() == EquityFailure::WorkLimit)
        {
            return false; // fall through to Auto/MC or generalized exact rejection
        }
        if (error.failure() == EquityFailure::Cancelled)
        {
            fail(EquityCalcFailure::Cancelled, error.what());
        }
        if (error.failure() == EquityFailure::InvalidWeight)
        {
            fail(EquityCalcFailure::InvalidWeight, error.what());
        }
        if (error.failure() == EquityFailure::NumericalRange)
        {
            fail(EquityCalcFailure::NumericalRange, error.what());
        }
        fail(EquityCalcFailure::InvalidInput, error.what());
    }
}

} // namespace

EquityCalcError::EquityCalcError(
    EquityCalcFailure failure,
    const std::string& message,
    std::uint64_t required_work,
    std::uint64_t allowed_work)
    : std::runtime_error(message)
    , failure_(failure)
    , required_(required_work)
    , allowed_(allowed_work)
{
}

EquityCalcMethod parse_equity_calc_method(std::string_view text)
{
    if (text == "auto" || text == "Auto")
    {
        return EquityCalcMethod::Auto;
    }
    if (text == "exact" || text == "Exact")
    {
        return EquityCalcMethod::Exact;
    }
    if (text == "monte_carlo" || text == "monte-carlo" || text == "MonteCarlo" || text == "mc")
    {
        return EquityCalcMethod::MonteCarlo;
    }
    throw std::invalid_argument("unknown equity calculator method");
}

std::string_view equity_calc_method_name(EquityCalcMethod method)
{
    switch (method)
    {
    case EquityCalcMethod::Auto:
        return "auto";
    case EquityCalcMethod::Exact:
        return "exact";
    case EquityCalcMethod::MonteCarlo:
        return "monte_carlo";
    }
    return "auto";
}

std::vector<int> parse_equity_calc_cards(std::string_view text)
{
    std::vector<int> cards;
    std::size_t cursor = 0;
    while (cursor < text.size())
    {
        while (cursor < text.size() && (text[cursor] == ' ' || text[cursor] == ',' || text[cursor] == '\t'))
        {
            ++cursor;
        }
        if (cursor >= text.size())
        {
            break;
        }
        std::size_t end = cursor;
        while (end < text.size() && text[end] != ' ' && text[end] != ',' && text[end] != '\t')
        {
            ++end;
        }
        cards.push_back(parse_card(text.substr(cursor, end - cursor)));
        cursor = end;
    }
    return cards;
}

EquityCalcWorkEstimate estimate_equity_work(
    std::span<const EquityCalcPlayerInput> players,
    std::span<const int> board,
    std::span<const int> dead_cards)
{
    validate_board_and_dead(board, dead_cards);
    const std::uint64_t dead = card_mask(board) | card_mask(dead_cards);
    const std::vector<PlayerHands> prepared = prepare_players(players, dead);
    const int hole_cards = static_cast<int>(prepared.size()) * 2;
    const int removed = hole_cards + static_cast<int>(board.size()) + static_cast<int>(dead_cards.size());
    EquityCalcWorkEstimate work;
    work.completions_per_tuple = completions_for(board.size(), removed);
    bool capped = false;
    // Cap tuple counting so broad preflop requests do not stall in preflight.
    const std::uint64_t count_limit = 2'000'000;
    work.legal_tuples = count_legal_tuples(prepared, count_limit, capped);
    work.estimate_capped = capped;
    work.exact_deals = capped ? UINT64_MAX : saturating_mul(work.legal_tuples, work.completions_per_tuple);
    return work;
}

EquityCalcResult calculate_equity(
    std::span<const EquityCalcPlayerInput> players,
    std::span<const int> board,
    std::span<const int> dead_cards,
    const EquityCalcOptions& options)
{
    const auto started = std::chrono::steady_clock::now();
    validate_board_and_dead(board, dead_cards);
    const std::uint64_t dead = card_mask(board) | card_mask(dead_cards);
    const std::vector<PlayerHands> prepared = prepare_players(players, dead);
    check_cancel(options);

    EquityCalcWorkEstimate work = estimate_equity_work(players, board, dead_cards);

    EquityCalcMethod actual = options.method;
    std::string reason;
    if (options.method == EquityCalcMethod::Auto)
    {
        if (!work.estimate_capped && work.exact_deals <= options.auto_exact_threshold
            && work.exact_deals <= options.max_exact_deals)
        {
            actual = EquityCalcMethod::Exact;
            reason = "auto selected exact (work estimate within threshold)";
        }
        else
        {
            actual = EquityCalcMethod::MonteCarlo;
            reason = "auto selected monte_carlo (work estimate above exact threshold)";
        }
    }
    else if (options.method == EquityCalcMethod::Exact)
    {
        actual = EquityCalcMethod::Exact;
        reason = "exact requested";
    }
    else
    {
        actual = EquityCalcMethod::MonteCarlo;
        reason = "monte_carlo requested";
    }

    if (actual == EquityCalcMethod::Exact)
    {
        EquityCalcResult fast;
        if (try_hu_postflop_fast_path(prepared, players, board, dead_cards, options, fast))
        {
            const auto ended = std::chrono::steady_clock::now();
            fast.elapsed_seconds = std::chrono::duration<double>(ended - started).count();
            fast.requested_method = options.method;
            fast.method_reason = reason;
            return fast;
        }
    }

    EquityCalcResult result;
    if (actual == EquityCalcMethod::Exact)
    {
        result = run_exact(prepared, board, dead, options, work, options.method);
        result.method_reason = reason;
    }
    else
    {
        const bool allow_stop = options.method != EquityCalcMethod::Exact;
        result = run_monte_carlo(
            prepared,
            board,
            dead,
            options,
            work,
            options.method,
            reason,
            allow_stop);
    }

    const auto ended = std::chrono::steady_clock::now();
    result.elapsed_seconds = std::chrono::duration<double>(ended - started).count();
    result.method_version = kEquityCalculatorMethodVersion;
    return result;
}

std::string equity_calc_result_json(
    const EquityCalcResult& result,
    std::span<const int> board,
    std::span<const int> dead_cards)
{
    std::ostringstream out;
    out.setf(std::ios::fmtflags(0), std::ios::floatfield);
    out.precision(12);
    auto num_or_null = [&](bool defined, double value) {
        if (!defined || !std::isfinite(value))
        {
            out << "null";
        }
        else
        {
            out << value;
        }
    };

    out << "{\"model\":\"" << kEquityCalculatorModel << "\",\"units\":\"" << kEquityCalculatorUnits
        << "\",\"method_version\":\"" << result.method_version << "\",\"requested_method\":\""
        << equity_calc_method_name(result.requested_method) << "\",\"actual_method\":\""
        << equity_calc_method_name(result.actual_method) << "\",\"method_reason\":";
    out << '"';
    for (char character : result.method_reason)
    {
        if (character == '"' || character == '\\')
        {
            out << '\\';
        }
        out << character;
    }
    out << "\",\"joint_defined\":" << (result.joint_defined ? "true" : "false")
        << ",\"exact_complete\":" << (result.exact_complete ? "true" : "false")
        << ",\"stopped\":" << (result.stopped ? "true" : "false")
        << ",\"legal_tuples\":" << result.work.legal_tuples
        << ",\"completions_per_tuple\":" << result.work.completions_per_tuple
        << ",\"exact_deals\":" << result.work.exact_deals
        << ",\"estimate_capped\":" << (result.work.estimate_capped ? "true" : "false")
        << ",\"accepted_samples\":" << result.accepted_samples
        << ",\"attempted_tuples\":" << result.attempted_tuples << ",\"seed\":" << result.seed
        << ",\"elapsed_seconds\":" << result.elapsed_seconds << ",\"board\":[";
    for (std::size_t i = 0; i < board.size(); ++i)
    {
        if (i)
        {
            out << ',';
        }
        out << '"' << format_card(board[i]) << '"';
    }
    out << "],\"dead_cards\":[";
    for (std::size_t i = 0; i < dead_cards.size(); ++i)
    {
        if (i)
        {
            out << ',';
        }
        out << '"' << format_card(dead_cards[i]) << '"';
    }
    out << "],\"players\":[";
    for (std::size_t i = 0; i < result.players.size(); ++i)
    {
        if (i)
        {
            out << ',';
        }
        const EquityCalcPlayerResult& player = result.players[i];
        out << "{\"id\":\"" << player.id << "\",\"defined\":" << (player.defined ? "true" : "false")
            << ",\"equity\":";
        num_or_null(player.defined, player.equity);
        out << ",\"win\":";
        num_or_null(player.defined, player.win);
        out << ",\"tie\":";
        num_or_null(player.defined, player.tie);
        out << ",\"loss\":";
        num_or_null(player.defined, player.loss);
        out << ",\"equity_ci_low\":";
        num_or_null(player.defined && std::isfinite(player.equity_ci_low), player.equity_ci_low);
        out << ",\"equity_ci_high\":";
        num_or_null(player.defined && std::isfinite(player.equity_ci_high), player.equity_ci_high);
        out << '}';
    }
    out << "]}";
    return out.str();
}

} // namespace poker::holdem
