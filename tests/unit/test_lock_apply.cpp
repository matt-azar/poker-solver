#include "harness.hpp"

#include "game/kuhn_game.hpp"
#include "game/river_game.hpp"
#include "poker/card.hpp"
#include "poker/range.hpp"
#include "solver/node_lock.hpp"
#include "solver/regret_matching.hpp"
#include "solver/river_batch.hpp"
#include "solver/street_batch.hpp"
#include "solver/trainer.hpp"

#include <cmath>
#include <cstdint>
#include <string>
#include <vector>

namespace
{

using poker::holdem::Range;
using poker::river::RiverConfig;
using poker::solver::Algorithm;
using poker::solver::CfrTrainer;
using poker::solver::LockKind;
using poker::solver::LockScope;
using poker::solver::LockSet;
using poker::solver::NodeLock;
using poker::solver::RiverBatchSolver;
using poker::solver::RiverStrategyEntry;
using poker::solver::SolveConfig;
using poker::solver::StreetBatchSolver;
using poker::solver::StreetStrategyEntry;
using poker::solver::apply_lock_to_strategy;
using poker::solver::make_action_lock_row;
using poker::solver::regret_matching;
using poker::streets::StreetConfig;

int card_id(const char* text)
{
    return poker::holdem::parse_card(text);
}

std::string combo_name(const char* a, const char* b)
{
    return Range::combo_text(Range::combo_index(card_id(a), card_id(b)));
}

StreetConfig tiny_turn_lock_config(const char* oop, const char* ip)
{
    StreetConfig config;
    config.board = {card_id("Kh"), card_id("Kd"), card_id("7c"), card_id("4s")};
    config.pot = 1000;
    config.stack = 1000;
    config.oop = Range::parse(oop);
    config.ip = Range::parse(ip);
    config.oop_turn_bets = {1.0};
    config.allow_all_in = false;
    config.max_raises = 1;
    config.memory_mib = 64;
    return config;
}

// Turn board with river betting so sibling river decisions have arity ≥ 2.
StreetConfig tiny_turn_river_lock_config(const char* oop, const char* ip)
{
    StreetConfig config = tiny_turn_lock_config(oop, ip);
    config.oop_river_bets = {1.0};
    config.ip_river_bets = {1.0};
    return config;
}

double open_action_prob(
    const std::vector<StreetStrategyEntry>& entries,
    const std::string& combo,
    const char* action_prefix)
{
    const std::string needle = "OOP " + combo + " | turn | open";
    for (const StreetStrategyEntry& entry : entries)
    {
        if (entry.infoset == needle && entry.action.rfind(action_prefix, 0) == 0)
        {
            return entry.probability;
        }
    }
    CHECK(false);
    return 0.0;
}

void set_river_board(RiverConfig& config)
{
    const char* names[] = {"Ah", "Kd", "7c", "4s", "2h"};
    for (int i = 0; i < 5; ++i)
    {
        config.board[static_cast<std::size_t>(i)] = card_id(names[i]);
    }
}

RiverConfig tiny_river_lock_config(const char* oop, const char* ip)
{
    RiverConfig config;
    set_river_board(config);
    config.pot = 1000;
    config.stack = 1000;
    config.oop = Range::parse(oop);
    config.ip = Range::parse(ip);
    config.oop_bet_sizes = {1.0};
    config.allow_all_in = false;
    config.max_raises = 1;
    return config;
}

double river_open_action_prob(
    const std::vector<RiverStrategyEntry>& entries,
    const std::string& combo,
    const char* action_prefix)
{
    const std::string needle = "OOP " + combo + " | open";
    for (const RiverStrategyEntry& entry : entries)
    {
        if (entry.infoset == needle && entry.action.rfind(action_prefix, 0) == 0)
        {
            return entry.probability;
        }
    }
    CHECK(false);
    return 0.0;
}

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

void test_street_batch_reads_config_locks_full_node()
{
    // Public node 0 is OOP's open. Lock forces always bet for every hand.
    LockSet locks;
    NodeLock lock;
    lock.infoset_id = 0;
    lock.kind = LockKind::FullNode;
    const double locked[] = {0.0, 1.0}; // Check, Bet
    lock.actions = make_action_lock_row(locked, 2);
    locks.upsert(lock);

    StreetConfig config = tiny_turn_lock_config("2c3d", "AhAd");
    StreetBatchSolver solver(config);
    SolveConfig solve;
    solve.max_iterations = 20;
    solve.locks = &locks;
    solver.solve(solve, Algorithm::VanillaCfr);

    // Bet labels are "Bet N" / "Bet N all-in"; open_action_prob matches by prefix.
    const auto entries = solver.average_strategy_entries();
    const std::string air = combo_name("2c", "3d");
    CHECK_NEAR(open_action_prob(entries, air, "Check"), 0.0, 1e-12);
    CHECK_NEAR(open_action_prob(entries, air, "Bet"), 1.0, 1e-12);
}

void test_street_batch_selected_combos_only_listed_hand()
{
    // Two OOP hands. Lock only hand index 0 (acting-player slot.hand, not holdem id).
    StreetConfig config = tiny_turn_lock_config("2c3d,KcKs", "AhAd");
    const auto free_entries = [&]()
    {
        StreetBatchSolver free_solver(config);
        SolveConfig free_config;
        free_config.max_iterations = 15;
        free_solver.solve(free_config, Algorithm::VanillaCfr);
        return free_solver.average_strategy_entries();
    }();

    LockSet locks;
    NodeLock lock;
    lock.infoset_id = 0;
    lock.kind = LockKind::SelectedCombos;
    lock.combo_indices = {0};
    const double locked[] = {0.0, 1.0};
    lock.actions = make_action_lock_row(locked, 2);
    locks.upsert(lock);

    StreetBatchSolver locked_solver(config);
    SolveConfig locked_config;
    locked_config.max_iterations = 15;
    locked_config.locks = &locks;
    locked_solver.solve(locked_config, Algorithm::VanillaCfr);
    const auto locked_entries = locked_solver.average_strategy_entries();

    locked_solver.prepare_inspection();
    const auto root = locked_solver.inspect_node(locked_solver.root_node_id());
    CHECK(root.hands.size() >= 2);
    const std::string locked_combo = root.hands[0].combo;
    const std::string free_combo = root.hands[1].combo;
    CHECK_NEAR(open_action_prob(locked_entries, locked_combo, "Check"), 0.0, 1e-12);
    CHECK_NEAR(open_action_prob(locked_entries, locked_combo, "Bet"), 1.0, 1e-12);

    // Unlisted hand matches the null-locks solve for the same iteration count.
    CHECK_NEAR(
        open_action_prob(locked_entries, free_combo, "Check"),
        open_action_prob(free_entries, free_combo, "Check"),
        1e-12);
    CHECK_NEAR(
        open_action_prob(locked_entries, free_combo, "Bet"),
        open_action_prob(free_entries, free_combo, "Bet"),
        1e-12);
}

void test_street_batch_null_locks_bit_identical_to_unlocked_row()
{
    StreetConfig config = tiny_turn_lock_config("2c3d", "AhAd");

    LockSet locks;
    NodeLock lock;
    lock.infoset_id = 0;
    lock.kind = LockKind::FullNode;
    locks.upsert(lock); // empty probs = unlocked

    StreetBatchSolver with_unlocked(config);
    StreetBatchSolver with_null(config);

    SolveConfig unlocked_config;
    unlocked_config.max_iterations = 12;
    unlocked_config.locks = &locks;
    with_unlocked.solve(unlocked_config, Algorithm::VanillaCfr);

    SolveConfig null_config;
    null_config.max_iterations = 12;
    with_null.solve(null_config, Algorithm::VanillaCfr);

    const auto a = with_unlocked.average_strategy_entries();
    const auto b = with_null.average_strategy_entries();
    CHECK(a.size() == b.size());
    for (std::size_t i = 0; i < a.size(); ++i)
    {
        CHECK(a[i].infoset == b[i].infoset);
        CHECK(a[i].action == b[i].action);
        CHECK(a[i].probability == b[i].probability);
    }
}

void test_street_batch_frozen_solve_honors_locks()
{
    LockSet locks;
    NodeLock lock;
    lock.infoset_id = 0;
    lock.kind = LockKind::FullNode;
    const double locked[] = {1.0, 0.0}; // always check
    lock.actions = make_action_lock_row(locked, 2);
    locks.upsert(lock);

    StreetConfig config = tiny_turn_lock_config("2c3d", "AhAd");
    StreetBatchSolver solver(config);
    SolveConfig solve;
    solve.max_iterations = 10;
    solve.locks = &locks;
    solver.solve_frozen(solve, Algorithm::CfrPlus);

    const auto entries = solver.average_strategy_entries();
    const std::string air = combo_name("2c", "3d");
    CHECK_NEAR(open_action_prob(entries, air, "Check"), 1.0, 1e-12);
    CHECK_NEAR(open_action_prob(entries, air, "Bet"), 0.0, 1e-12);
}

void test_street_batch_continue_iterations_honors_locks()
{
    LockSet locks;
    NodeLock lock;
    lock.infoset_id = 0;
    lock.kind = LockKind::FullNode;
    const double locked[] = {0.0, 1.0}; // always bet
    lock.actions = make_action_lock_row(locked, 2);
    locks.upsert(lock);

    StreetConfig config = tiny_turn_lock_config("2c3d", "AhAd");
    StreetBatchSolver solver(config);
    solver.continue_iterations(15, Algorithm::VanillaCfr, &locks);

    const auto entries = solver.average_strategy_entries();
    const std::string air = combo_name("2c", "3d");
    CHECK_NEAR(open_action_prob(entries, air, "Check"), 0.0, 1e-12);
    CHECK_NEAR(open_action_prob(entries, air, "Bet"), 1.0, 1e-12);
}

void test_street_batch_continue_null_locks_bit_identical()
{
    StreetConfig config = tiny_turn_lock_config("2c3d", "AhAd");
    StreetBatchSolver with_null(config);
    StreetBatchSolver with_default(config);
    with_null.continue_iterations(10, Algorithm::VanillaCfr, nullptr);
    with_default.continue_iterations(10, Algorithm::VanillaCfr);

    const auto a = with_null.average_strategy_entries();
    const auto b = with_default.average_strategy_entries();
    CHECK(a.size() == b.size());
    for (std::size_t i = 0; i < a.size(); ++i)
    {
        CHECK(a[i].infoset == b[i].infoset);
        CHECK(a[i].action == b[i].action);
        CHECK(a[i].probability == b[i].probability);
    }
}

void test_river_batch_reads_config_locks_full_node()
{
    // Public node 0 is OOP's open. Lock forces always bet for every hand.
    LockSet locks;
    NodeLock lock;
    lock.infoset_id = 0;
    lock.kind = LockKind::FullNode;
    const double locked[] = {0.0, 1.0}; // Check, Bet
    lock.actions = make_action_lock_row(locked, 2);
    locks.upsert(lock);

    // Board is Ah Kd 7c 4s 2h; avoid hole cards that collide with it.
    RiverConfig config = tiny_river_lock_config("5c5d", "KsKc");
    RiverBatchSolver solver(config);
    SolveConfig solve;
    solve.max_iterations = 20;
    solve.locks = &locks;
    solver.solve(solve, Algorithm::VanillaCfr);

    const auto entries = solver.average_strategy_entries();
    const std::string air = combo_name("5c", "5d");
    CHECK_NEAR(river_open_action_prob(entries, air, "Check"), 0.0, 1e-12);
    CHECK_NEAR(river_open_action_prob(entries, air, "Bet"), 1.0, 1e-12);
}

void test_river_batch_selected_combos_only_listed_hand()
{
    // Two OOP hands. Lock only hand index 0 (acting-player slot.hand, not holdem id).
    RiverConfig config = tiny_river_lock_config("5c5d,QcQd", "KsKc");
    const auto free_entries = [&]()
    {
        RiverBatchSolver free_solver(config);
        SolveConfig free_config;
        free_config.max_iterations = 15;
        free_solver.solve(free_config, Algorithm::VanillaCfr);
        return free_solver.average_strategy_entries();
    }();

    LockSet locks;
    NodeLock lock;
    lock.infoset_id = 0;
    lock.kind = LockKind::SelectedCombos;
    lock.combo_indices = {0};
    const double locked[] = {0.0, 1.0};
    lock.actions = make_action_lock_row(locked, 2);
    locks.upsert(lock);

    RiverBatchSolver locked_solver(config);
    SolveConfig locked_config;
    locked_config.max_iterations = 15;
    locked_config.locks = &locks;
    locked_solver.solve(locked_config, Algorithm::VanillaCfr);
    const auto locked_entries = locked_solver.average_strategy_entries();

    locked_solver.prepare_inspection();
    const auto root = locked_solver.inspect_node(locked_solver.root_node_id());
    CHECK(root.hands.size() >= 2);
    const std::string locked_combo = root.hands[0].combo;
    const std::string free_combo = root.hands[1].combo;
    CHECK_NEAR(river_open_action_prob(locked_entries, locked_combo, "Check"), 0.0, 1e-12);
    CHECK_NEAR(river_open_action_prob(locked_entries, locked_combo, "Bet"), 1.0, 1e-12);

    // Unlisted hand matches the null-locks solve for the same iteration count.
    CHECK_NEAR(
        river_open_action_prob(locked_entries, free_combo, "Check"),
        river_open_action_prob(free_entries, free_combo, "Check"),
        1e-12);
    CHECK_NEAR(
        river_open_action_prob(locked_entries, free_combo, "Bet"),
        river_open_action_prob(free_entries, free_combo, "Bet"),
        1e-12);
}

void test_river_batch_null_locks_bit_identical_to_unlocked_row()
{
    RiverConfig config = tiny_river_lock_config("5c5d", "KsKc");

    LockSet locks;
    NodeLock lock;
    lock.infoset_id = 0;
    lock.kind = LockKind::FullNode;
    locks.upsert(lock); // empty probs = unlocked

    RiverBatchSolver with_unlocked(config);
    RiverBatchSolver with_null(config);

    SolveConfig unlocked_config;
    unlocked_config.max_iterations = 12;
    unlocked_config.locks = &locks;
    with_unlocked.solve(unlocked_config, Algorithm::VanillaCfr);

    SolveConfig null_config;
    null_config.max_iterations = 12;
    with_null.solve(null_config, Algorithm::VanillaCfr);

    const auto a = with_unlocked.average_strategy_entries();
    const auto b = with_null.average_strategy_entries();
    CHECK(a.size() == b.size());
    for (std::size_t i = 0; i < a.size(); ++i)
    {
        CHECK(a[i].infoset == b[i].infoset);
        CHECK(a[i].action == b[i].action);
        CHECK(a[i].probability == b[i].probability);
    }
}

void test_river_batch_continue_iterations_honors_locks()
{
    LockSet locks;
    NodeLock lock;
    lock.infoset_id = 0;
    lock.kind = LockKind::FullNode;
    const double locked[] = {0.0, 1.0}; // always bet
    lock.actions = make_action_lock_row(locked, 2);
    locks.upsert(lock);

    RiverConfig config = tiny_river_lock_config("5c5d", "KsKc");
    RiverBatchSolver solver(config);
    solver.continue_iterations(15, Algorithm::VanillaCfr, &locks);

    const auto entries = solver.average_strategy_entries();
    const std::string air = combo_name("5c", "5d");
    CHECK_NEAR(river_open_action_prob(entries, air, "Check"), 0.0, 1e-12);
    CHECK_NEAR(river_open_action_prob(entries, air, "Bet"), 1.0, 1e-12);
}

void test_river_batch_continue_null_locks_bit_identical()
{
    RiverConfig config = tiny_river_lock_config("5c5d", "KsKc");
    RiverBatchSolver with_null(config);
    RiverBatchSolver with_default(config);
    with_null.continue_iterations(10, Algorithm::VanillaCfr, nullptr);
    with_default.continue_iterations(10, Algorithm::VanillaCfr);

    const auto a = with_null.average_strategy_entries();
    const auto b = with_default.average_strategy_entries();
    CHECK(a.size() == b.size());
    for (std::size_t i = 0; i < a.size(); ++i)
    {
        CHECK(a[i].infoset == b[i].infoset);
        CHECK(a[i].action == b[i].action);
        CHECK(a[i].probability == b[i].probability);
    }
}

void test_river_batch_cfr_plus_solve_honors_locks()
{
    LockSet locks;
    NodeLock lock;
    lock.infoset_id = 0;
    lock.kind = LockKind::FullNode;
    const double locked[] = {1.0, 0.0}; // always check
    lock.actions = make_action_lock_row(locked, 2);
    locks.upsert(lock);

    RiverConfig config = tiny_river_lock_config("5c5d", "KsKc");
    RiverBatchSolver solver(config);
    SolveConfig solve;
    solve.max_iterations = 10;
    solve.locks = &locks;
    solver.solve(solve, Algorithm::CfrPlus);

    const auto entries = solver.average_strategy_entries();
    const std::string air = combo_name("5c", "5d");
    CHECK_NEAR(river_open_action_prob(entries, air, "Check"), 1.0, 1e-12);
    CHECK_NEAR(river_open_action_prob(entries, air, "Bet"), 0.0, 1e-12);
}

// Reproduce the Explorer bug: locking one river must not force the same
// mixture on a sibling river that shares the betting line.
void test_street_batch_node_lock_does_not_cross_rivers()
{
    StreetConfig config = tiny_turn_river_lock_config("2c3d", "AhAd");
    StreetBatchSolver probe(config);
    SolveConfig warm;
    warm.max_iterations = 4;
    probe.solve(warm, Algorithm::VanillaCfr);
    probe.prepare_inspection();

    const auto root = probe.inspect_node(probe.root_node_id());
    CHECK(root.kind == "decision");
    CHECK(!root.actions.empty());
    // Walk Check (or first action) toward the river deal.
    std::string cursor = root.actions[0].child_id;
    std::string river_chance;
    for (int depth = 0; depth < 8; ++depth)
    {
        const auto view = probe.inspect_node(cursor);
        if (view.kind == "chance" && !view.cards.empty())
        {
            river_chance = cursor;
            break;
        }
        if (view.kind != "decision" || view.actions.empty())
        {
            break;
        }
        cursor = view.actions[0].child_id;
    }
    CHECK(!river_chance.empty());
    const auto chance = probe.inspect_node(river_chance);
    CHECK(chance.cards.size() >= 2);

    const std::string locked_node = chance.cards[0].child_id;
    const std::string sibling_node = chance.cards[1].child_id;
    CHECK(locked_node != sibling_node);

    auto locked_view = probe.inspect_node(locked_node);
    CHECK(locked_view.kind == "decision");
    CHECK(locked_view.actions.size() >= 2);

    // Parse public index + river from the selected child id.
    const auto parse_parts = [](const std::string& text, std::size_t& infoset, int& turn, int& river)
    {
        CHECK(text.size() > 2 && text[0] == 'p');
        const std::size_t t_at = text.find(".t");
        const std::size_t r_at = text.find(".r");
        CHECK(t_at != std::string::npos && r_at != std::string::npos && r_at > t_at);
        infoset = static_cast<std::size_t>(std::stoull(text.substr(1, t_at - 1)));
        turn = std::stoi(text.substr(t_at + 2, r_at - (t_at + 2)));
        river = std::stoi(text.substr(r_at + 2));
    };
    std::size_t infoset = 0;
    int turn = -1;
    int river = -1;
    parse_parts(locked_node, infoset, turn, river);
    CHECK(river >= 0);

    LockSet locks;
    NodeLock lock;
    lock.infoset_id = infoset;
    lock.turn = static_cast<std::int8_t>(turn);
    lock.river = static_cast<std::int8_t>(river);
    lock.scope = LockScope::Node;
    lock.kind = LockKind::FullNode;
    // Force pure fold/check on the first action (index 0).
    std::vector<double> pure(locked_view.actions.size(), 0.0);
    pure[0] = 1.0;
    lock.actions = make_action_lock_row(pure, static_cast<int>(pure.size()));
    locks.upsert(lock);

    StreetBatchSolver locked_solver(config);
    SolveConfig solve;
    solve.max_iterations = 12;
    solve.locks = &locks;
    locked_solver.solve(solve, Algorithm::VanillaCfr);
    locked_solver.prepare_inspection();

    const auto locked_after = locked_solver.inspect_node(locked_node);
    const auto sibling_after = locked_solver.inspect_node(sibling_node);
    CHECK(locked_after.kind == "decision");
    CHECK(sibling_after.kind == "decision");
    CHECK(!locked_after.hands.empty());
    CHECK(!sibling_after.hands.empty());

    // Locked river: every structural hand is pure on action 0.
    for (const auto& hand : locked_after.hands)
    {
        if (!hand.structural || hand.strategy.empty())
        {
            continue;
        }
        CHECK_NEAR(hand.strategy[0], 1.0, 1e-9);
        for (std::size_t a = 1; a < hand.strategy.size(); ++a)
        {
            CHECK_NEAR(hand.strategy[a], 0.0, 1e-9);
        }
    }

    // Sibling river must not be forced to the same pure row.
    bool sibling_differs = false;
    for (const auto& hand : sibling_after.hands)
    {
        if (!hand.structural || hand.strategy.size() < 2)
        {
            continue;
        }
        if (hand.strategy[0] < 0.999)
        {
            sibling_differs = true;
            break;
        }
    }
    CHECK(sibling_differs);
}

void test_street_batch_line_lock_applies_across_rivers()
{
    StreetConfig config = tiny_turn_river_lock_config("2c3d", "AhAd");
    StreetBatchSolver probe(config);
    SolveConfig warm;
    warm.max_iterations = 3;
    probe.solve(warm, Algorithm::VanillaCfr);
    probe.prepare_inspection();

    const auto root = probe.inspect_node(probe.root_node_id());
    std::string cursor = root.actions[0].child_id;
    std::string river_chance;
    for (int depth = 0; depth < 8; ++depth)
    {
        const auto view = probe.inspect_node(cursor);
        if (view.kind == "chance" && !view.cards.empty())
        {
            river_chance = cursor;
            break;
        }
        if (view.kind != "decision" || view.actions.empty())
        {
            break;
        }
        cursor = view.actions[0].child_id;
    }
    CHECK(!river_chance.empty());
    const auto chance = probe.inspect_node(river_chance);
    CHECK(chance.cards.size() >= 2);
    const std::string first = chance.cards[0].child_id;
    const std::string second = chance.cards[1].child_id;
    const auto first_view = probe.inspect_node(first);
    CHECK(first_view.actions.size() >= 2);

    const std::size_t t_at = first.find(".t");
    CHECK(t_at != std::string::npos);
    const std::size_t infoset = static_cast<std::size_t>(std::stoull(first.substr(1, t_at - 1)));

    LockSet locks;
    NodeLock lock;
    lock.infoset_id = infoset; // line scope: turn=river=-1
    lock.scope = LockScope::Line;
    lock.kind = LockKind::FullNode;
    std::vector<double> pure(first_view.actions.size(), 0.0);
    pure[0] = 1.0;
    lock.actions = make_action_lock_row(pure, static_cast<int>(pure.size()));
    locks.upsert(lock);

    StreetBatchSolver locked_solver(config);
    SolveConfig solve;
    solve.max_iterations = 10;
    solve.locks = &locks;
    locked_solver.solve(solve, Algorithm::VanillaCfr);
    locked_solver.prepare_inspection();

    for (const std::string& node_id : {first, second})
    {
        const auto view = locked_solver.inspect_node(node_id);
        for (const auto& hand : view.hands)
        {
            if (!hand.structural || hand.strategy.empty())
            {
                continue;
            }
            CHECK_NEAR(hand.strategy[0], 1.0, 1e-9);
        }
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
    test_street_batch_reads_config_locks_full_node();
    test_street_batch_selected_combos_only_listed_hand();
    test_street_batch_null_locks_bit_identical_to_unlocked_row();
    test_street_batch_frozen_solve_honors_locks();
    test_street_batch_continue_iterations_honors_locks();
    test_street_batch_continue_null_locks_bit_identical();
    test_river_batch_reads_config_locks_full_node();
    test_river_batch_selected_combos_only_listed_hand();
    test_river_batch_null_locks_bit_identical_to_unlocked_row();
    test_river_batch_continue_iterations_honors_locks();
    test_river_batch_continue_null_locks_bit_identical();
    test_river_batch_cfr_plus_solve_honors_locks();
    test_street_batch_node_lock_does_not_cross_rivers();
    test_street_batch_line_lock_applies_across_rivers();
}
