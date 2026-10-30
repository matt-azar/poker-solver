#include "harness.hpp"

#include "solver/node_lock.hpp"

#include <cmath>
#include <limits>
#include <optional>
#include <string>
#include <vector>

namespace
{

using poker::solver::ActionLockRow;
using poker::solver::LockKind;
using poker::solver::LockSet;
using poker::solver::NodeLock;
using poker::solver::format_node_lock;
using poker::solver::locked_probability;
using poker::solver::make_action_lock_row;
using poker::solver::parse_lock_set;
using poker::solver::parse_node_lock;
using poker::solver::validate_action_row;

void test_validate_action_row_accepts()
{
    CHECK(validate_action_row({}, 0));
    CHECK(validate_action_row({}, 3));

    const double uniform2[] = {0.5, 0.5};
    CHECK(validate_action_row(uniform2, 2));

    const double pure[] = {1.0, 0.0, 0.0};
    CHECK(validate_action_row(pure, 3));

    const double near[] = {0.333333333333, 0.333333333333, 0.333333333334};
    CHECK(validate_action_row(near, 3));

    const ActionLockRow row = make_action_lock_row(pure, 3);
    CHECK(!row.unlocked());
    CHECK(row.size() == 3);
    CHECK(row.probs[0] == 1.0);
    CHECK(row.probs[1] == 0.0);
}

void test_validate_action_row_rejects()
{
    const double wrong_len[] = {0.5, 0.5};
    CHECK(!validate_action_row(wrong_len, 3));
    CHECK(!validate_action_row(wrong_len, 1));

    const double negative[] = {1.2, -0.2};
    CHECK(!validate_action_row(negative, 2));

    const double nan_row[] = {0.5, std::numeric_limits<double>::quiet_NaN()};
    CHECK(!validate_action_row(nan_row, 2));

    const double inf_row[] = {0.5, std::numeric_limits<double>::infinity()};
    CHECK(!validate_action_row(inf_row, 2));

    const double bad_sum[] = {0.4, 0.4};
    CHECK(!validate_action_row(bad_sum, 2));

    const double over[] = {0.6, 0.6};
    CHECK(!validate_action_row(over, 2));

    bool threw = false;
    try
    {
        (void)make_action_lock_row(bad_sum, 2);
    }
    catch (const std::invalid_argument&)
    {
        threw = true;
    }
    CHECK(threw);
}

void test_full_node_vs_selected_combos()
{
    NodeLock full;
    full.infoset_id = 7;
    full.kind = LockKind::FullNode;
    const double probs[] = {0.25, 0.75};
    full.actions = make_action_lock_row(probs, 2);

    CHECK(locked_probability(full, 0, 0).value() == 0.25);
    CHECK(locked_probability(full, 99, 1).value() == 0.75);
    CHECK(!locked_probability(full, 0, 2).has_value());

    NodeLock selected;
    selected.infoset_id = 7;
    selected.kind = LockKind::SelectedCombos;
    selected.combo_indices = {3, 5};
    selected.actions = make_action_lock_row(probs, 2);

    CHECK(locked_probability(selected, 3, 0).value() == 0.25);
    CHECK(locked_probability(selected, 5, 1).value() == 0.75);
    CHECK(!locked_probability(selected, 4, 0).has_value());
    CHECK(!locked_probability(selected, 0, 1).has_value());
}

void test_unlocked_distinct_from_zero_lock()
{
    NodeLock unlocked;
    unlocked.infoset_id = 1;
    unlocked.kind = LockKind::FullNode;
    CHECK(unlocked.actions.unlocked());
    CHECK(!locked_probability(unlocked, 0, 0).has_value());
    CHECK(!locked_probability(unlocked, 0, 1).has_value());

    NodeLock zero_lock;
    zero_lock.infoset_id = 1;
    zero_lock.kind = LockKind::FullNode;
    const double probs[] = {0.0, 1.0};
    zero_lock.actions = make_action_lock_row(probs, 2);
    CHECK(!zero_lock.actions.unlocked());
    CHECK(locked_probability(zero_lock, 0, 0).has_value());
    CHECK(locked_probability(zero_lock, 0, 0).value() == 0.0);
    CHECK(locked_probability(zero_lock, 0, 1).value() == 1.0);

    NodeLock selected_empty;
    selected_empty.infoset_id = 2;
    selected_empty.kind = LockKind::SelectedCombos;
    selected_empty.actions = make_action_lock_row(probs, 2);
    CHECK(!locked_probability(selected_empty, 0, 0).has_value());
}

void test_lock_set_upsert_erase()
{
    LockSet locks;
    CHECK(locks.empty());
    CHECK(locks.size() == 0);
    CHECK(locks.find(1) == nullptr);

    NodeLock a;
    a.infoset_id = 10;
    a.kind = LockKind::FullNode;
    const double p_a[] = {1.0, 0.0};
    a.actions = make_action_lock_row(p_a, 2);
    locks.upsert(a);
    CHECK(!locks.empty());
    CHECK(locks.size() == 1);
    CHECK(locks.find(10) != nullptr);
    CHECK(locks.find(10)->actions.probs[0] == 1.0);

    NodeLock b = a;
    b.infoset_id = 10;
    const double p_b[] = {0.0, 1.0};
    b.actions = make_action_lock_row(p_b, 2);
    locks.upsert(b);
    CHECK(locks.size() == 1);
    CHECK(locks.find(10)->actions.probs[0] == 0.0);

    NodeLock c;
    c.infoset_id = 11;
    c.kind = LockKind::SelectedCombos;
    c.combo_indices = {1};
    c.actions = make_action_lock_row(p_a, 2);
    locks.upsert(c);
    CHECK(locks.size() == 2);

    CHECK(locks.erase(10));
    CHECK(locks.size() == 1);
    CHECK(locks.find(10) == nullptr);
    CHECK(locks.find(11) != nullptr);
    CHECK(!locks.erase(10));

    locks.clear();
    CHECK(locks.empty());
    CHECK(locks.size() == 0);
}

void test_text_round_trip()
{
    NodeLock full;
    full.infoset_id = 42;
    full.kind = LockKind::FullNode;
    const double probs[] = {0.2, 0.3, 0.5};
    full.actions = make_action_lock_row(probs, 3);
    const std::string full_line = format_node_lock(full);
    const NodeLock full_back = parse_node_lock(full_line);
    CHECK(full_back.infoset_id == 42);
    CHECK(full_back.kind == LockKind::FullNode);
    CHECK(full_back.actions.size() == 3);
    CHECK_NEAR(full_back.actions.probs[0], 0.2, 1e-15);
    CHECK_NEAR(full_back.actions.probs[1], 0.3, 1e-15);
    CHECK_NEAR(full_back.actions.probs[2], 0.5, 1e-15);

    NodeLock selected;
    selected.infoset_id = 9;
    selected.kind = LockKind::SelectedCombos;
    selected.combo_indices = {0, 4, 7};
    selected.actions = make_action_lock_row(probs, 3);
    const NodeLock selected_back = parse_node_lock(format_node_lock(selected));
    CHECK(selected_back.infoset_id == 9);
    CHECK(selected_back.kind == LockKind::SelectedCombos);
    CHECK(selected_back.combo_indices.size() == 3);
    CHECK(selected_back.combo_indices[0] == 0);
    CHECK(selected_back.combo_indices[1] == 4);
    CHECK(selected_back.combo_indices[2] == 7);

    NodeLock unlocked;
    unlocked.infoset_id = 3;
    unlocked.kind = LockKind::FullNode;
    const NodeLock unlocked_back = parse_node_lock(format_node_lock(unlocked));
    CHECK(unlocked_back.actions.unlocked());

    LockSet set;
    set.upsert(full);
    set.upsert(selected);
    const std::string text = format_node_lock(full) + "\n" + format_node_lock(selected) + "\n";
    const LockSet round = parse_lock_set(text);
    CHECK(round.size() == 2);
    CHECK(round.find(42) != nullptr);
    CHECK(round.find(9) != nullptr);
    CHECK(locked_probability(*round.find(9), 4, 2).value() == 0.5);
    CHECK(!locked_probability(*round.find(9), 1, 2).has_value());
}

} // namespace

void run_node_lock_tests()
{
    test_validate_action_row_accepts();
    test_validate_action_row_rejects();
    test_full_node_vs_selected_combos();
    test_unlocked_distinct_from_zero_lock();
    test_lock_set_upsert_erase();
    test_text_round_trip();
}
