#pragma once

#include "solver/dcfr.hpp"
#include "solver/node_lock.hpp"
#include "solver/regret_matching.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <concepts>
#include <cstdint>
#include <cstddef>
#include <span>
#include <stdexcept>
#include <utility>
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
    Dcfr
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
    double p1_utility_when_p1_responds = 0.0;
    double p2_utility_when_p2_responds = 0.0;
    double nash_gap = 0.0;
};

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
    return "vanilla_cfr";
}

// Checkpoint / PSOL algorithm tags. Do not renumber existing values.
inline constexpr std::uint8_t kAlgorithmTagVanilla = 0;
inline constexpr std::uint8_t kAlgorithmTagCfrPlus = 1;
inline constexpr std::uint8_t kAlgorithmTagLinear = 2;
inline constexpr std::uint8_t kAlgorithmTagDcfr = 3;
inline constexpr std::uint8_t kAlgorithmTagMax = kAlgorithmTagDcfr;

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
    throw std::invalid_argument("checkpoint algorithm is unknown");
}

// Two-player zero-sum extensive game with perfect recall.
// Utilities returned by the game are player 1's net chips. Player 2's are the negation.
// acting_player is 0 or 1. Local actions are 0 .. action_count(infoset)-1.
template <typename Game>
concept ExtensiveGame = requires(Game game, typename Game::State state, int index)
{
    { game.infoset_count() } -> std::convertible_to<int>;
    { game.root() } -> std::same_as<typename Game::State>;
    { game.is_chance(state) } -> std::convertible_to<bool>;
    { game.is_terminal(state) } -> std::convertible_to<bool>;
    { game.p1_utility(state) } -> std::convertible_to<double>;
    { game.chance_count(state) } -> std::convertible_to<int>;
    { game.chance_probability(state, index) } -> std::convertible_to<double>;
    { game.child_chance(state, index) } -> std::same_as<typename Game::State>;
    { game.infoset(state) } -> std::convertible_to<int>;
    { game.acting_player(index) } -> std::convertible_to<int>;
    { game.action_count(index) } -> std::convertible_to<int>;
    { game.child_action(state, index) } -> std::same_as<typename Game::State>;
};

inline constexpr int kMaxActionsPerInfoset = 8;

template <ExtensiveGame Game>
std::vector<int> action_offsets(const Game& game)
{
    const int infoset_count = game.infoset_count();
    std::vector<int> offset(static_cast<std::size_t>(infoset_count) + 1, 0);
    int cursor = 0;
    for (int infoset = 0; infoset < infoset_count; ++infoset)
    {
        offset[static_cast<std::size_t>(infoset)] = cursor;
        const int count = game.action_count(infoset);
        if (count <= 0 || count > kMaxActionsPerInfoset)
        {
            throw std::logic_error("infoset action count is outside the solver scratch limit");
        }
        cursor += count;
    }
    offset[static_cast<std::size_t>(infoset_count)] = cursor;
    return offset;
}

template <ExtensiveGame Game>
std::vector<int> decision_depths(const Game& game)
{
    std::vector<int> depth(static_cast<std::size_t>(game.infoset_count()), 0x7fffffff);

    struct Walker
    {
        const Game& game;
        std::vector<int>& depth;

        void walk(const typename Game::State& state, int decision_depth) const
        {
            if (game.is_terminal(state))
            {
                return;
            }
            if (game.is_chance(state))
            {
                const int count = game.chance_count(state);
                for (int outcome = 0; outcome < count; ++outcome)
                {
                    walk(game.child_chance(state, outcome), decision_depth);
                }
                return;
            }
            const int infoset = game.infoset(state);
            const std::size_t index = static_cast<std::size_t>(infoset);
            if (decision_depth < depth[index])
            {
                depth[index] = decision_depth;
            }
            const int count = game.action_count(infoset);
            for (int action = 0; action < count; ++action)
            {
                walk(game.child_action(state, action), decision_depth + 1);
            }
        }
    };

    Walker{game, depth}.walk(game.root(), 0);
    return depth;
}

template <ExtensiveGame Game>
double expected_p1_from_strategy(const Game& game,
                                 const typename Game::State& state,
                                 const std::vector<double>& strategy,
                                 const std::vector<int>& offset)
{
    if (game.is_terminal(state))
    {
        return game.p1_utility(state);
    }
    if (game.is_chance(state))
    {
        double value = 0.0;
        const int count = game.chance_count(state);
        for (int outcome = 0; outcome < count; ++outcome)
        {
            const double probability = game.chance_probability(state, outcome);
            value += probability * expected_p1_from_strategy(
                game, game.child_chance(state, outcome), strategy, offset);
        }
        return value;
    }

    const int infoset = game.infoset(state);
    const int count = game.action_count(infoset);
    const int base = offset[static_cast<std::size_t>(infoset)];
    double value = 0.0;
    for (int action = 0; action < count; ++action)
    {
        const double probability = strategy[static_cast<std::size_t>(base + action)];
        value += probability * expected_p1_from_strategy(
            game, game.child_action(state, action), strategy, offset);
    }
    return value;
}

// Exact best response. Infosets of the responding player are solved deepest-first,
// so continuation values already use an optimal action at every later infoset.
// The chosen action maximizes the sum of opponent-and-chance-weighted utilities
// over histories in the infoset. It does not depend on the responder's own reach.
template <ExtensiveGame Game>
double p1_utility_of_best_response(const Game& game,
                                   const std::vector<double>& strategy,
                                   int responding_player)
{
    const std::vector<int> offset = action_offsets(game);
    const std::vector<int> depth = decision_depths(game);
    const int infoset_count = game.infoset_count();
    if (static_cast<int>(strategy.size()) != offset.back())
    {
        throw std::logic_error("strategy vector has the wrong length");
    }

    std::vector<int> order;
    order.reserve(static_cast<std::size_t>(infoset_count));
    for (int infoset = 0; infoset < infoset_count; ++infoset)
    {
        if (game.acting_player(infoset) == responding_player
            && depth[static_cast<std::size_t>(infoset)] != 0x7fffffff)
        {
            order.push_back(infoset);
        }
    }
    std::sort(order.begin(), order.end(), [&depth](int left, int right)
    {
        const int left_depth = depth[static_cast<std::size_t>(left)];
        const int right_depth = depth[static_cast<std::size_t>(right)];
        if (left_depth != right_depth)
        {
            return left_depth > right_depth;
        }
        return left < right;
    });

    std::vector<int> response(static_cast<std::size_t>(infoset_count), -1);

    struct Visitor
    {
        const Game& game;
        const std::vector<double>& strategy;
        const std::vector<double>& profile;
        const std::vector<int>& offset;
        const std::vector<int>& response;
        int responding_player;
        int target;
        std::vector<double>& action_value;

        void visit(const typename Game::State& state, double reach) const
        {
            if (game.is_terminal(state))
            {
                return;
            }
            if (game.is_chance(state))
            {
                const int count = game.chance_count(state);
                for (int outcome = 0; outcome < count; ++outcome)
                {
                    visit(game.child_chance(state, outcome),
                          reach * game.chance_probability(state, outcome));
                }
                return;
            }

            const int infoset = game.infoset(state);
            const int count = game.action_count(infoset);
            if (game.acting_player(infoset) != responding_player)
            {
                const int base = offset[static_cast<std::size_t>(infoset)];
                for (int action = 0; action < count; ++action)
                {
                    visit(game.child_action(state, action),
                          reach * strategy[static_cast<std::size_t>(base + action)]);
                }
                return;
            }
            if (infoset == target)
            {
                for (int action = 0; action < count; ++action)
                {
                    const double utility = expected_p1_from_strategy(
                        game, game.child_action(state, action), profile, offset);
                    const double responder_utility = responding_player == 0 ? utility : -utility;
                    action_value[static_cast<std::size_t>(action)] += reach * responder_utility;
                }
                return;
            }

            const int chosen = response[static_cast<std::size_t>(infoset)];
            if (chosen >= 0)
            {
                visit(game.child_action(state, chosen), reach);
                return;
            }
            for (int action = 0; action < count; ++action)
            {
                visit(game.child_action(state, action), reach);
            }
        }
    };

    for (const int target : order)
    {
        std::vector<double> profile = strategy;
        for (int infoset = 0; infoset < infoset_count; ++infoset)
        {
            const int chosen = response[static_cast<std::size_t>(infoset)];
            if (chosen < 0)
            {
                continue;
            }
            const int count = game.action_count(infoset);
            const int base = offset[static_cast<std::size_t>(infoset)];
            for (int action = 0; action < count; ++action)
            {
                profile[static_cast<std::size_t>(base + action)] = action == chosen ? 1.0 : 0.0;
            }
        }

        const int count = game.action_count(target);
        std::vector<double> action_value(static_cast<std::size_t>(count), 0.0);
        Visitor{game, strategy, profile, offset, response, responding_player, target, action_value}
            .visit(game.root(), 1.0);

        int best_action = 0;
        for (int action = 1; action < count; ++action)
        {
            if (action_value[static_cast<std::size_t>(action)]
                > action_value[static_cast<std::size_t>(best_action)])
            {
                best_action = action;
            }
        }
        response[static_cast<std::size_t>(target)] = best_action;
    }

    std::vector<double> profile = strategy;
    for (int infoset = 0; infoset < infoset_count; ++infoset)
    {
        const int chosen = response[static_cast<std::size_t>(infoset)];
        if (chosen < 0)
        {
            continue;
        }
        const int count = game.action_count(infoset);
        const int base = offset[static_cast<std::size_t>(infoset)];
        for (int action = 0; action < count; ++action)
        {
            profile[static_cast<std::size_t>(base + action)] = action == chosen ? 1.0 : 0.0;
        }
    }
    return expected_p1_from_strategy(game, game.root(), profile, offset);
}

template <ExtensiveGame Game>
BestResponseResult compute_best_response(const Game& game, const std::vector<double>& strategy)
{
    BestResponseResult result;
    result.p1_utility_when_p1_responds = p1_utility_of_best_response(game, strategy, 0);
    const double p1_when_p2_responds = p1_utility_of_best_response(game, strategy, 1);
    result.p2_utility_when_p2_responds = -p1_when_p2_responds;
    result.nash_gap = result.p1_utility_when_p1_responds + result.p2_utility_when_p2_responds;
    return result;
}

template <ExtensiveGame Game>
class CfrTrainer
{
public:
    CfrTrainer(Game game, Algorithm algorithm)
        : game_(std::move(game))
        , algorithm_(algorithm)
        , offset_(action_offsets(game_))
    {
        const int entries = offset_.back();
        regret_.assign(static_cast<std::size_t>(entries), 0.0);
        strategy_sum_.assign(static_cast<std::size_t>(entries), 0.0);
        pass_sigma_.assign(static_cast<std::size_t>(entries), 0.0);
        pass_delta_.assign(static_cast<std::size_t>(entries), 0.0);
    }

    void run_iterations(int count)
    {
        for (int step = 0; step < count; ++step)
        {
            ++iterations_completed_;
            if (algorithm_ == Algorithm::VanillaCfr)
            {
                run_pass(-1, 1.0);
            }
            else if (algorithm_ == Algorithm::LinearCfr)
            {
                const double weight = static_cast<double>(iterations_completed_);
                run_pass(-1, weight);
            }
            else if (algorithm_ == Algorithm::Dcfr)
            {
                const DcfrFactors factors = dcfr_factors(iterations_completed_);
                dcfr_positive_ = factors.positive_discount;
                dcfr_negative_ = factors.negative_discount;
                run_pass(0, factors.average_weight);
                run_pass(1, factors.average_weight);
            }
            else
            {
                // CFR+: floor after each alternating pass; average weight is t.
                const double weight = static_cast<double>(iterations_completed_);
                run_pass(0, weight);
                run_pass(1, weight);
            }
        }
    }

    // runtime_seconds covers regret updates only. A final exploitability pass,
    // if it was not just performed as an early-stop check, is excluded.
    // Early-stop checks are inside the timer because they decide when to halt.
    SolveStats solve(const SolveConfig& config)
    {
        const LockSet* const previous_locks = locks_;
        locks_ = config.locks;
        const auto start = std::chrono::steady_clock::now();
        int completed = 0;
        SolveStats stats;
        std::vector<double> gap_history;
        std::vector<int> gap_iterations;
        bool fresh_evaluation = false;
        for (int step = 0; step < config.max_iterations; ++step)
        {
            run_iterations(1);
            ++completed;
            fresh_evaluation = false;
            const bool check_gap = config.nash_gap_threshold >= 0.0
                && config.eval_every > 0
                && completed % config.eval_every == 0;
            if (check_gap)
            {
                stats = evaluate();
                gap_history.push_back(stats.nash_gap);
                gap_iterations.push_back(completed);
                fresh_evaluation = true;
                if (stats.nash_gap <= config.nash_gap_threshold)
                {
                    break;
                }
            }
            if (config.max_wall_seconds >= 0.0)
            {
                const double elapsed = std::chrono::duration<double>(
                    std::chrono::steady_clock::now() - start).count();
                if (elapsed >= config.max_wall_seconds)
                {
                    stats.time_limit_reached = true;
                    break;
                }
            }
        }
        const auto end = std::chrono::steady_clock::now();
        if (!fresh_evaluation)
        {
            const bool hit_time = stats.time_limit_reached;
            stats = evaluate();
            stats.time_limit_reached = hit_time;
            if (config.nash_gap_threshold >= 0.0)
            {
                gap_history.push_back(stats.nash_gap);
                gap_iterations.push_back(completed);
            }
        }
        stats.iterations = completed;
        stats.runtime_seconds = std::chrono::duration<double>(end - start).count();
        stats.memory_bytes_estimate = memory_bytes_estimate();
        stats.nash_gap_history = std::move(gap_history);
        stats.nash_gap_iterations = std::move(gap_iterations);
        locks_ = previous_locks;
        return stats;
    }

    SolveStats evaluate() const
    {
        SolveStats stats;
        const std::vector<double> strategy = average_strategy();
        stats.p1_expected_utility = expected_p1_from_strategy(
            game_, game_.root(), strategy, offset_);
        const BestResponseResult response = compute_best_response(game_, strategy);
        stats.p1_best_response_utility = response.p1_utility_when_p1_responds;
        stats.p2_best_response_utility = response.p2_utility_when_p2_responds;
        stats.nash_gap = response.nash_gap;
        stats.memory_bytes_estimate = memory_bytes_estimate();
        return stats;
    }

    std::vector<double> average_strategy() const
    {
        std::vector<double> strategy(regret_.size(), 0.0);
        const int infoset_count = game_.infoset_count();
        for (int infoset = 0; infoset < infoset_count; ++infoset)
        {
            const int count = game_.action_count(infoset);
            const int base = offset_[static_cast<std::size_t>(infoset)];
            normalize_average(
                strategy_sum_.data() + base,
                strategy.data() + base,
                count);
        }
        return strategy;
    }

    std::size_t memory_bytes_estimate() const
    {
        return regret_.size() * sizeof(double)
            + strategy_sum_.size() * sizeof(double)
            + offset_.size() * sizeof(int);
    }

    const std::vector<double>& regrets() const
    {
        return regret_;
    }

    const std::vector<double>& strategy_sum() const
    {
        return strategy_sum_;
    }

    int iterations_completed() const
    {
        return iterations_completed_;
    }

    Algorithm algorithm() const
    {
        return algorithm_;
    }

    // One frozen pass. updating_player < 0 updates both players and does not floor.
    // CFR+ calls this twice: player 0, then player 1, refreshing the snapshot in between.
    void run_pass(int updating_player, double weight)
    {
        begin_pass();
        cfr(game_.root(), 1.0, 1.0, 1.0, updating_player, weight);
        end_pass(updating_player);
    }

    void assign_regret(int infoset, int action, double value)
    {
        if (infoset < 0 || infoset >= game_.infoset_count())
        {
            throw std::invalid_argument("regret infoset is out of range");
        }
        const int count = game_.action_count(infoset);
        if (action < 0 || action >= count)
        {
            throw std::invalid_argument("regret action is out of range");
        }
        const int base = offset_[static_cast<std::size_t>(infoset)];
        regret_[static_cast<std::size_t>(base + action)] = value;
    }

private:
    // updating_player < 0 updates both players (vanilla). Otherwise only that player.
    // weight is 1 for vanilla and the 1-based iteration index for CFR+.
    double cfr(typename Game::State state,
               double pi1,
               double pi2,
               double pi_chance,
               int updating_player,
               double weight)
    {
        if (game_.is_terminal(state))
        {
            return game_.p1_utility(state);
        }
        if (game_.is_chance(state))
        {
            double value = 0.0;
            const int count = game_.chance_count(state);
            for (int outcome = 0; outcome < count; ++outcome)
            {
                const double probability = game_.chance_probability(state, outcome);
                value += probability * cfr(
                    game_.child_chance(state, outcome),
                    pi1,
                    pi2,
                    pi_chance * probability,
                    updating_player,
                    weight);
            }
            return value;
        }

        const int infoset = game_.infoset(state);
        const int actor = game_.acting_player(infoset);
        const int count = game_.action_count(infoset);
        const int base = offset_[static_cast<std::size_t>(infoset)];
        const bool update_this = updating_player < 0 || updating_player == actor;

        const double* sigma = pass_sigma_.data() + base;
        if (update_this)
        {
            const double reach = actor == 0 ? pi1 : pi2;
            accumulate_average(strategy_sum_.data() + base, sigma, count, weight * reach);
        }

        std::array<double, kMaxActionsPerInfoset> action_utility{};
        double node_utility = 0.0;
        for (int action = 0; action < count; ++action)
        {
            if (actor == 0)
            {
                action_utility[static_cast<std::size_t>(action)] = cfr(
                    game_.child_action(state, action),
                    pi1 * sigma[action],
                    pi2,
                    pi_chance,
                    updating_player,
                    weight);
            }
            else
            {
                action_utility[static_cast<std::size_t>(action)] = cfr(
                    game_.child_action(state, action),
                    pi1,
                    pi2 * sigma[action],
                    pi_chance,
                    updating_player,
                    weight);
            }
            node_utility += sigma[action] * action_utility[static_cast<std::size_t>(action)];
        }

        if (update_this)
        {
            const double opponent_reach = (actor == 0 ? pi2 : pi1) * pi_chance;
            for (int action = 0; action < count; ++action)
            {
                const double instantaneous = actor == 0
                    ? (action_utility[static_cast<std::size_t>(action)] - node_utility)
                    : (node_utility - action_utility[static_cast<std::size_t>(action)]);
                const double regret_weight = algorithm_ == Algorithm::LinearCfr ? weight : 1.0;
                pass_delta_[static_cast<std::size_t>(base + action)] +=
                    regret_weight * opponent_reach * instantaneous;
            }
        }
        return node_utility;
    }

    // One strategy for the whole pass. Later histories in the same information
    // set do not see regrets written earlier in this pass.
    // When locks_ is set, locked action rows replace RM output for matching
    // infosets. Kuhn and other non-combo trainers pass combo_index 0.
    void begin_pass()
    {
        std::fill(pass_delta_.begin(), pass_delta_.end(), 0.0);
        const int infosets = game_.infoset_count();
        for (int infoset = 0; infoset < infosets; ++infoset)
        {
            const int count = game_.action_count(infoset);
            const int base = offset_[static_cast<std::size_t>(infoset)];
            regret_matching(
                regret_.data() + base,
                pass_sigma_.data() + base,
                count);
            if (locks_ != nullptr)
            {
                const NodeLock* lock = locks_->find(static_cast<std::size_t>(infoset));
                apply_lock_to_strategy(
                    std::span<double>(pass_sigma_.data() + base, static_cast<std::size_t>(count)),
                    lock,
                    0);
            }
        }
    }

    // Add this player's summed regret, then finalize that player once.
    // Vanilla and linear pass updating_player < 0 and keep signed regrets.
    // CFR+ floors the updating player. DCFR discounts the updating player
    // with the iteration's fixed (positive, negative) factors. The other
    // player's table is left unchanged.
    void end_pass(int updating_player)
    {
        const int infosets = game_.infoset_count();
        for (int infoset = 0; infoset < infosets; ++infoset)
        {
            const int actor = game_.acting_player(infoset);
            const bool active = updating_player < 0 || actor == updating_player;
            const bool floor_this = algorithm_ == Algorithm::CfrPlus && active && updating_player >= 0;
            const bool discount_this = algorithm_ == Algorithm::Dcfr && active && updating_player >= 0;
            const int count = game_.action_count(infoset);
            const int base = offset_[static_cast<std::size_t>(infoset)];
            for (int action = 0; action < count; ++action)
            {
                const std::size_t index = static_cast<std::size_t>(base + action);
                if (!active)
                {
                    if (pass_delta_[index] != 0.0)
                    {
                        throw std::logic_error("inactive player accumulated regret during this pass");
                    }
                    continue;
                }
                if (discount_this)
                {
                    regret_[index] = dcfr_discounted_regret(
                        regret_[index],
                        pass_delta_[index],
                        dcfr_positive_,
                        dcfr_negative_);
                    continue;
                }
                regret_[index] += pass_delta_[index];
                if (floor_this && regret_[index] < 0.0)
                {
                    regret_[index] = 0.0;
                }
            }
        }
    }

    Game game_;
    Algorithm algorithm_ = Algorithm::VanillaCfr;
    std::vector<int> offset_;
    std::vector<double> regret_;
    std::vector<double> strategy_sum_;
    std::vector<double> pass_sigma_;
    std::vector<double> pass_delta_;
    int iterations_completed_ = 0;
    double dcfr_positive_ = 1.0;
    double dcfr_negative_ = 0.5;
    // Non-owning; set for the duration of solve() from SolveConfig::locks.
    const LockSet* locks_ = nullptr;
};

} // namespace poker::solver
