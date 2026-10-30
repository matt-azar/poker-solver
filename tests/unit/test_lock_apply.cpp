#include "harness.hpp"

#include "game/kuhn_game.hpp"
#include "solver/node_lock.hpp"
#include "solver/regret_matching.hpp"
#include "solver/trainer.hpp"

#include <cmath>
#include <vector>

namespace
{

using poker::solver::Algorithm;
using poker::solver::CfrTrainer;
using poker::solver::LockKind;
using poker::solver::LockSet;
using poker::solver::NodeLock;
using poker::solver::SolveConfig;
using poker::solver::apply_lock_to_strategy;
using poker::solver::make_action_lock_row;
using poker::solver::regret_matching;

void test_apply_full_node_overwrites_rm()
{
    double regrets[] = {10.0, 0.0};
    double probs[2] = {};
    regret_matching(regrets, probs, 2);
    CHECK_NEAR(probs[0], 1.0, 1e-15);
    CHECK_NEAR(probs[1], 0.0, 1e-15);

    NodeLock lock;
    lock.infoset_id = 0;
    lock.kind = LockKind::FullNode;
    const double locked[] = {0.25, 0.75};
    lock.actions = make_action_lock_row(locked, 2);

    CHECK(apply_lock_to_strategy(probs, &lock, 0));
    CHECK_NEAR(probs[0], 0.25, 1e-15);
    CHECK_NEAR(probs[1], 0.75, 1e-15);

    // FullNode ignores combo index.
    double again[] = {1.0, 0.0};
    CHECK(apply_lock_to_strategy(again, &lock, 99));
    CHECK_NEAR(again[0], 0.25, 1e-15);
    CHECK_NEAR(again[1], 0.75, 1e-15);
}

void test_apply_selected_combos_only_listed()
{
    NodeLock lock;
    lock.infoset_id = 3;
    lock.kind = LockKind::SelectedCombos;
    lock.combo_indices = {2, 7};
    const double locked[] = {0.0, 1.0};
    lock.actions = make_action_lock_row(locked, 2);

    double listed[] = {0.6, 0.4};
    CHECK(apply_lock_to_strategy(listed, &lock, 2));
    CHECK_NEAR(listed[0], 0.0, 1e-15);
    CHECK_NEAR(listed[1], 1.0, 1e-15);

    double other[] = {0.6, 0.4};
    CHECK(!apply_lock_to_strategy(other, &lock, 1));
    CHECK_NEAR(other[0], 0.6, 1e-15);
    CHECK_NEAR(other[1], 0.4, 1e-15);

    double also_listed[] = {0.5, 0.5};
    CHECK(apply_lock_to_strategy(also_listed, &lock, 7));
    CHECK_NEAR(also_listed[0], 0.0, 1e-15);
    CHECK_NEAR(also_listed[1], 1.0, 1e-15);
}

void test_apply_unlocked_and_null_noop()
{
    double probs[] = {0.3, 0.7};
    CHECK(!apply_lock_to_strategy(probs, nullptr, 0));
    CHECK_NEAR(probs[0], 0.3, 1e-15);
    CHECK_NEAR(probs[1], 0.7, 1e-15);

    NodeLock unlocked;
    unlocked.infoset_id = 1;
    unlocked.kind = LockKind::FullNode;
    CHECK(unlocked.actions.unlocked());
    CHECK(!apply_lock_to_strategy(probs, &unlocked, 0));
    CHECK_NEAR(probs[0], 0.3, 1e-15);
    CHECK_NEAR(probs[1], 0.7, 1e-15);
}

void test_apply_zero_probability_is_lock()
{
    NodeLock lock;
    lock.infoset_id = 4;
    lock.kind = LockKind::FullNode;
    const double locked[] = {0.0, 1.0};
    lock.actions = make_action_lock_row(locked, 2);

    double probs[] = {0.9, 0.1};
    CHECK(apply_lock_to_strategy(probs, &lock, 0));
    CHECK(probs[0] == 0.0);
    CHECK(probs[1] == 1.0);
}

void test_kuhn_trainer_full_node_lock_forces_mixture()
{
    LockSet locks;
    NodeLock lock;
    lock.infoset_id = 0; // P1 Jack open
    lock.kind = LockKind::FullNode;
    const double locked[] = {0.0, 1.0}; // always bet
    lock.actions = make_action_lock_row(locked, 2);
    locks.upsert(lock);

    CfrTrainer<poker::kuhn::KuhnGame> trainer(poker::kuhn::KuhnGame{}, Algorithm::VanillaCfr);
    SolveConfig config;
    config.max_iterations = 50;
    config.locks = &locks;
    trainer.solve(config);

    const std::vector<double> strategy = trainer.average_strategy();
    CHECK_NEAR(strategy[0], 0.0, 1e-12);
    CHECK_NEAR(strategy[1], 1.0, 1e-12);
}

void test_kuhn_trainer_selected_combos_combo_zero_only()
{
    // Kuhn has no combo axis; begin_pass always uses combo_index 0.
    // SelectedCombos {0} therefore applies; {1} does not.
    {
        LockSet locks;
        NodeLock lock;
        lock.infoset_id = 1; // P1 Queen open
        lock.kind = LockKind::SelectedCombos;
        lock.combo_indices = {0};
        const double locked[] = {1.0, 0.0}; // always check
        lock.actions = make_action_lock_row(locked, 2);
        locks.upsert(lock);

        CfrTrainer<poker::kuhn::KuhnGame> trainer(poker::kuhn::KuhnGame{}, Algorithm::VanillaCfr);
        SolveConfig config;
        config.max_iterations = 40;
        config.locks = &locks;
        trainer.solve(config);

        const std::vector<double> strategy = trainer.average_strategy();
        CHECK_NEAR(strategy[2], 1.0, 1e-12);
        CHECK_NEAR(strategy[3], 0.0, 1e-12);
    }
    {
        LockSet locks;
        NodeLock lock;
        lock.infoset_id = 1;
        lock.kind = LockKind::SelectedCombos;
        lock.combo_indices = {1}; // not the trainer combo index
        const double locked[] = {1.0, 0.0};
        lock.actions = make_action_lock_row(locked, 2);
        locks.upsert(lock);

        CfrTrainer<poker::kuhn::KuhnGame> locked_trainer(
            poker::kuhn::KuhnGame{}, Algorithm::VanillaCfr);
        CfrTrainer<poker::kuhn::KuhnGame> free_trainer(
            poker::kuhn::KuhnGame{}, Algorithm::VanillaCfr);

        SolveConfig locked_config;
        locked_config.max_iterations = 30;
        locked_config.locks = &locks;
        locked_trainer.solve(locked_config);

        SolveConfig free_config;
        free_config.max_iterations = 30;
        free_trainer.solve(free_config);

        const auto locked_strategy = locked_trainer.average_strategy();
        const auto free_strategy = free_trainer.average_strategy();
        CHECK(locked_strategy.size() == free_strategy.size());
        for (std::size_t i = 0; i < locked_strategy.size(); ++i)
        {
            CHECK_NEAR(locked_strategy[i], free_strategy[i], 1e-12);
        }
    }
}

void test_kuhn_trainer_unlocked_row_matches_null_locks()
{
    LockSet locks;
    NodeLock lock;
    lock.infoset_id = 0;
    lock.kind = LockKind::FullNode;
    // Empty probs = unlocked; must not change strategy vs null locks.
    locks.upsert(lock);

    CfrTrainer<poker::kuhn::KuhnGame> with_unlocked(
        poker::kuhn::KuhnGame{}, Algorithm::VanillaCfr);
    CfrTrainer<poker::kuhn::KuhnGame> with_null(
        poker::kuhn::KuhnGame{}, Algorithm::VanillaCfr);

    SolveConfig unlocked_config;
    unlocked_config.max_iterations = 25;
    unlocked_config.locks = &locks;
    with_unlocked.solve(unlocked_config);

    SolveConfig null_config;
    null_config.max_iterations = 25;
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

void run_lock_apply_tests()
{
    test_apply_full_node_overwrites_rm();
    test_apply_selected_combos_only_listed();
    test_apply_unlocked_and_null_noop();
    test_apply_zero_probability_is_lock();
    test_kuhn_trainer_full_node_lock_forces_mixture();
    test_kuhn_trainer_selected_combos_combo_zero_only();
    test_kuhn_trainer_unlocked_row_matches_null_locks();
}
