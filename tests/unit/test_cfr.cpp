#include "harness.hpp"

#include "game/street_game.hpp"
#include "poker/card.hpp"
#include "poker/range.hpp"
#include "solver/node_lock.hpp"
#include "solver/regret_matching.hpp"
#include "solver/trainer.hpp"

#include <cmath>
#include <span>
#include <vector>

namespace
{

using poker::solver::Algorithm;
using poker::solver::CfrTrainer;
using poker::solver::SolveConfig;
using poker::streets::StreetConfig;
using poker::streets::StreetGame;

int card(const char* text)
{
    return poker::holdem::parse_card(text);
}

StreetConfig tiny_river()
{
    StreetConfig config;
    config.board = {
        card("Ah"), card("Kd"), card("7c"), card("4s"), card("2h")};
    config.pot = 1000;
    config.stack = 1000;
    config.oop = poker::holdem::Range::parse("AcAd");
    config.ip = poker::holdem::Range::parse("KsKc");
    config.oop_river_bets = {0.5};
    config.ip_river_bets = {0.5};
    config.max_raises = 1;
    config.allow_all_in = false;
    config.memory_mib = 64;
    return config;
}

// Chance hides the outcome. One infoset chooses A or B.
// The two outcomes cancel, so a CFR+ pass that floors the sum leaves both
// regrets at zero. Flooring each history first would not.
class CancelGame
{
public:
    struct State
    {
        int stage = 0;
        int outcome = 0;
        int action = 0;
    };

    int infoset_count() const
    {
        return 1;
    }

    State root() const
    {
        return {};
    }

    bool is_chance(const State& state) const
    {
        return state.stage == 0;
    }

    bool is_terminal(const State& state) const
    {
        return state.stage == 2;
    }

    double p1_utility(const State& state) const
    {
        const double pay[2][2] = {{-2.0, 2.0}, {2.0, -2.0}};
        return pay[state.outcome][state.action];
    }

    int chance_count(const State& state) const
    {
        return state.stage == 0 ? 2 : 0;
    }

    double chance_probability(const State&, int) const
    {
        return 0.5;
    }

    State child_chance(const State&, int outcome) const
    {
        State next;
        next.stage = 1;
        next.outcome = outcome;
        return next;
    }

    int infoset(const State&) const
    {
        return 0;
    }

    int acting_player(int) const
    {
        return 0;
    }

    int action_count(int) const
    {
        return 2;
    }

    State child_action(const State& state, int action) const
    {
        State next = state;
        next.stage = 2;
        next.action = action;
        return next;
    }
};

// Action 0 at the root is terminal. Action 1 leads to a later infoset of the
// same player, then a player-1 infoset sits on the way there.
class ZeroReachGame
{
public:
    struct State
    {
        int node = 0;
    };

    int infoset_count() const
    {
        return 3;
    }

    State root() const
    {
        return {};
    }

    bool is_chance(const State&) const
    {
        return false;
    }

    bool is_terminal(const State& state) const
    {
        return state.node == 1 || state.node == 4 || state.node == 5 || state.node == 6;
    }

    double p1_utility(const State& state) const
    {
        if (state.node == 1)
        {
            return 1.0;
        }
        if (state.node == 4)
        {
            return -1.0;
        }
        if (state.node == 5)
        {
            return 5.0;
        }
        if (state.node == 6)
        {
            return -5.0;
        }
        return 0.0;
    }

    int chance_count(const State&) const
    {
        return 0;
    }

    double chance_probability(const State&, int) const
    {
        return 0.0;
    }

    State child_chance(const State& state, int) const
    {
        return state;
    }

    int infoset(const State& state) const
    {
        if (state.node == 2)
        {
            return 2;
        }
        if (state.node == 3)
        {
            return 1;
        }
        return 0;
    }

    int acting_player(int infoset) const
    {
        return infoset == 2 ? 1 : 0;
    }

    int action_count(int) const
    {
        return 2;
    }

    State child_action(const State& state, int action) const
    {
        State next;
        if (state.node == 0)
        {
            next.node = action == 0 ? 1 : 2;
        }
        else if (state.node == 2)
        {
            next.node = action == 0 ? 3 : 4;
        }
        else
        {
            next.node = action == 0 ? 5 : 6;
        }
        return next;
    }
};

void expect_pass_contract()
{
    CfrTrainer<CancelGame> plus(CancelGame{}, Algorithm::CfrPlus);
    plus.run_pass(0, 1.0);
    CHECK_NEAR(plus.regrets()[0], 0.0, 1e-12);
    CHECK_NEAR(plus.regrets()[1], 0.0, 1e-12);

    CfrTrainer<CancelGame> vanilla(CancelGame{}, Algorithm::VanillaCfr);
    vanilla.assign_regret(0, 0, -3.0);
    vanilla.run_pass(-1, 1.0);
    CHECK_NEAR(vanilla.regrets()[0], -3.0, 1e-12);

    CfrTrainer<ZeroReachGame> reach(ZeroReachGame{}, Algorithm::CfrPlus);
    reach.assign_regret(0, 0, 1.0);
    reach.assign_regret(2, 0, -4.0);
    reach.run_pass(0, 1.0);
    const std::vector<double>& regrets = reach.regrets();
    CHECK_NEAR(regrets[0], 1.0, 1e-12);
    CHECK_NEAR(regrets[1], 0.0, 1e-12);
    CHECK_NEAR(regrets[2], 2.5, 1e-12);
    CHECK_NEAR(regrets[3], 0.0, 1e-12);
    CHECK_NEAR(regrets[4], -4.0, 1e-12);
    CHECK_NEAR(regrets[5], 0.0, 1e-12);
    CHECK_NEAR(reach.strategy_sum()[2], 0.0, 1e-12);
    CHECK_NEAR(reach.strategy_sum()[3], 0.0, 1e-12);
}

void expect_regret_matching_primitives()
{
    {
        double regrets[2] = {-1.0, -4.0};
        double current[2] = {0.0, 0.0};
        poker::solver::regret_matching(regrets, current, 2);
        CHECK_NEAR(current[0], 0.5, 1e-12);
        CHECK_NEAR(current[1], 0.5, 1e-12);
    }
    {
        double regrets[2] = {3.0, 1.0};
        double current[2] = {0.0, 0.0};
        poker::solver::regret_matching(regrets, current, 2);
        CHECK_NEAR(current[0], 0.75, 1e-12);
        CHECK_NEAR(current[1], 0.25, 1e-12);
    }
    {
        double regrets[2] = {-2.0, 5.0};
        double current[2] = {0.0, 0.0};
        poker::solver::regret_matching(regrets, current, 2);
        CHECK_NEAR(current[0], 0.0, 1e-12);
        CHECK_NEAR(current[1], 1.0, 1e-12);
    }

    {
        double strategy_sum[2] = {0.0, 0.0};
        double current[2] = {0.5, 0.5};
        poker::solver::accumulate_average(strategy_sum, current, 2, 1.0);
        CHECK_NEAR(strategy_sum[0], 0.5, 1e-12);
        CHECK_NEAR(strategy_sum[1], 0.5, 1e-12);

        current[0] = 1.0;
        current[1] = 0.0;
        poker::solver::accumulate_average(strategy_sum, current, 2, 0.5);
        CHECK_NEAR(strategy_sum[0], 1.0, 1e-12);
        CHECK_NEAR(strategy_sum[1], 0.5, 1e-12);

        double avg[2] = {0.0, 0.0};
        poker::solver::normalize_average(strategy_sum, avg, 2);
        CHECK_NEAR(avg[0], 2.0 / 3.0, 1e-12);
        CHECK_NEAR(avg[1], 1.0 / 3.0, 1e-12);
    }

    {
        double zeros[2] = {0.0, 0.0};
        double avg[2] = {0.0, 0.0};
        poker::solver::normalize_average(zeros, avg, 2);
        CHECK_NEAR(avg[0], 0.5, 1e-12);
        CHECK_NEAR(avg[1], 0.5, 1e-12);
    }
}

void expect_street_trainer_lifecycle()
{
    const StreetGame game(tiny_river());

    SolveConfig stop_config;
    stop_config.max_iterations = 100000;
    stop_config.accuracy_threshold = 1e-2;
    stop_config.eval_every = 50;
    CfrTrainer<StreetGame> stopping(game, Algorithm::CfrPlus);
    const auto stopped = stopping.solve(stop_config);
    CHECK(stopped.iterations > 0);
    CHECK(stopped.iterations < stop_config.max_iterations);
    CHECK(stopped.iterations % stop_config.eval_every == 0);
    CHECK(stopped.accuracy <= stop_config.accuracy_threshold);
    CHECK_NEAR(stopped.accuracy, 0.5 * stopped.nash_gap, 1e-12);
    CHECK(stopped.runtime_seconds > 0.0);
    CHECK(stopped.memory_bytes_estimate > 0);
    CHECK(!stopped.time_limit_reached);
    CHECK(stopped.accuracy_history.size() >= 1);
    CHECK(stopped.accuracy_history.size() == stopped.accuracy_iterations.size());
    CHECK(stopped.accuracy_history.back() == stopped.accuracy);
    CHECK(stopped.accuracy_iterations.back() == stopped.iterations);

    SolveConfig dense_config;
    dense_config.max_iterations = 8;
    dense_config.accuracy_threshold = 0.0;
    dense_config.eval_every = 1;
    CfrTrainer<StreetGame> dense_trainer(game, Algorithm::VanillaCfr);
    const auto dense = dense_trainer.solve(dense_config);
    SolveConfig sparse_config = dense_config;
    sparse_config.eval_every = 2;
    CfrTrainer<StreetGame> sparse_trainer(game, Algorithm::VanillaCfr);
    const auto sparse = sparse_trainer.solve(sparse_config);
    CHECK(dense.iterations == 8);
    CHECK(sparse.iterations == 8);
    CHECK(dense.accuracy_history.size() == 8);
    CHECK(sparse.accuracy_history.size() == 4);
    CHECK(sparse.accuracy_history.size() < dense.accuracy_history.size());
    CHECK(dense.accuracy_history.size() == dense.accuracy_iterations.size());
    CHECK(sparse.accuracy_history.size() == sparse.accuracy_iterations.size());
    CHECK(sparse.accuracy_iterations[0] == 2);
    CHECK(sparse.accuracy_iterations.back() == 8);

    SolveConfig time_config;
    time_config.max_iterations = 1000000;
    time_config.max_wall_seconds = 0.0;
    CfrTrainer<StreetGame> timed(game, Algorithm::CfrPlus);
    const auto timed_out = timed.solve(time_config);
    CHECK(timed_out.time_limit_reached);
    CHECK(timed_out.iterations >= 1);
    CHECK(timed_out.iterations < time_config.max_iterations);

    SolveConfig linear_config;
    linear_config.max_iterations = 200;
    CfrTrainer<StreetGame> linear(game, Algorithm::LinearCfr);
    const auto linear_stats = linear.solve(linear_config);
    const auto linear_strategy = linear.average_strategy();
    CfrTrainer<StreetGame> linear_again(game, Algorithm::LinearCfr);
    linear_again.solve(linear_config);
    const auto linear_again_strategy = linear_again.average_strategy();
    CHECK(linear_strategy.size() == linear_again_strategy.size());
    for (std::size_t i = 0; i < linear_strategy.size(); ++i)
    {
        CHECK_NEAR(linear_strategy[i], linear_again_strategy[i], 1e-12);
    }
    CfrTrainer<StreetGame> vanilla_same(game, Algorithm::VanillaCfr);
    vanilla_same.solve(linear_config);
    const auto vanilla_same_strategy = vanilla_same.average_strategy();
    double strategy_gap = 0.0;
    for (std::size_t i = 0; i < linear_strategy.size(); ++i)
    {
        strategy_gap += std::abs(linear_strategy[i] - vanilla_same_strategy[i]);
    }
    CHECK(strategy_gap > 1e-6);
    bool negative_regret = false;
    for (double regret : linear.regrets())
    {
        if (regret < -1e-8)
        {
            negative_regret = true;
        }
    }
    CHECK(negative_regret);
    CHECK(linear_stats.iterations == 200);
    CHECK(linear_stats.runtime_seconds > 0.0);
}

void expect_street_trainer_full_node_lock()
{
    // CfrTrainer always applies locks at combo_index 0. Pin FullNode and
    // unlocked-row semantics on a tiny river StreetGame (the --reference path).
    const StreetGame game(tiny_river());
    const int infoset = 0;
    const int actions = game.action_count(infoset);
    CHECK(actions >= 2);

    poker::solver::LockSet locks;
    poker::solver::NodeLock lock;
    lock.infoset_id = infoset;
    lock.kind = poker::solver::LockKind::FullNode;
    std::vector<double> locked(static_cast<std::size_t>(actions), 0.0);
    locked[static_cast<std::size_t>(actions - 1)] = 1.0;
    lock.actions = poker::solver::make_action_lock_row(
        std::span<const double>(locked), actions);
    locks.upsert(lock);

    SolveConfig config;
    config.max_iterations = 40;
    config.locks = &locks;
    CfrTrainer<StreetGame> trainer(game, Algorithm::VanillaCfr);
    trainer.solve(config);

    // Infoset 0 is packed at the front of the flat average strategy table.
    const std::vector<double> strategy = trainer.average_strategy();
    for (int action = 0; action < actions; ++action)
    {
        const double expected = action == actions - 1 ? 1.0 : 0.0;
        CHECK_NEAR(strategy[static_cast<std::size_t>(action)], expected, 1e-12);
    }

    poker::solver::LockSet unlocked_locks;
    poker::solver::NodeLock unlocked;
    unlocked.infoset_id = infoset;
    unlocked.kind = poker::solver::LockKind::FullNode;
    unlocked_locks.upsert(unlocked);

    SolveConfig unlocked_config;
    unlocked_config.max_iterations = 25;
    unlocked_config.locks = &unlocked_locks;
    CfrTrainer<StreetGame> with_unlocked(game, Algorithm::VanillaCfr);
    with_unlocked.solve(unlocked_config);

    SolveConfig null_config;
    null_config.max_iterations = 25;
    CfrTrainer<StreetGame> with_null(game, Algorithm::VanillaCfr);
    with_null.solve(null_config);

    const auto a = with_unlocked.average_strategy();
    const auto b = with_null.average_strategy();
    CHECK(a.size() == b.size());
    for (std::size_t i = 0; i < a.size(); ++i)
    {
        CHECK_NEAR(a[i], b[i], 1e-12);
    }
}

} // namespace

void run_cfr_tests()
{
    expect_pass_contract();
    expect_regret_matching_primitives();
    expect_street_trainer_lifecycle();
    expect_street_trainer_full_node_lock();
}
