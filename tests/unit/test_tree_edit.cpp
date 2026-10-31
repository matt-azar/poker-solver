#include "harness.hpp"

#include "game/street_config_text.hpp"
#include "game/street_game.hpp"
#include "poker/card.hpp"
#include "poker/range.hpp"
#include "solver/street_batch.hpp"
#include "solver/tree_edit.hpp"

#include <stdexcept>
#include <string>
#include <vector>

using poker::holdem::Range;
using poker::solver::LineEdit;
using poker::solver::LineEditKind;
using poker::solver::LinePath;
using poker::solver::LineStep;
using poker::solver::TreeEditSet;
using poker::solver::format_tree_edits;
using poker::solver::parse_tree_edits;
using poker::solver::validate_line_edit;
using poker::solver::StreetBatchSolver;
using poker::streets::StreetConfig;
using poker::streets::StreetGame;
using poker::streets::format_street_config;
using poker::streets::parse_street_config;

namespace
{

LineEdit force_root(const char* action)
{
    LineEdit edit;
    edit.kind = LineEditKind::Force;
    edit.action = action;
    return edit;
}

LineEdit remove_along(LinePath path, const char* action)
{
    LineEdit edit;
    edit.kind = LineEditKind::Remove;
    edit.path = std::move(path);
    edit.action = action;
    return edit;
}

LineEdit add_size_along(LinePath path, double pot_fraction)
{
    LineEdit edit;
    edit.kind = LineEditKind::AddSize;
    edit.path = std::move(path);
    edit.size_pot_fraction = pot_fraction;
    return edit;
}

LineEdit add_chips_along(LinePath path, int chips)
{
    LineEdit edit;
    edit.kind = LineEditKind::AddSize;
    edit.path = std::move(path);
    edit.size_chips = chips;
    return edit;
}

int card(const char* text)
{
    return poker::holdem::parse_card(text);
}

StreetConfig tiny_turn_one_bet()
{
    StreetConfig config;
    config.board = {card("Ah"), card("Kd"), card("7c"), card("2s")};
    config.pot = 100;
    config.stack = 200;
    config.oop = Range::parse("QcQd");
    config.ip = Range::parse("JcJd");
    config.oop_bet_sizes = {0.5};
    config.ip_bet_sizes = {0.5};
    config.oop_raise_sizes = {};
    config.ip_raise_sizes = {};
    config.allow_all_in = false;
    config.max_raises = 1;
    return config;
}

bool has_action_label(const StreetGame& game, const StreetGame::State& state, const char* label)
{
    const int infoset = game.infoset(state);
    const int count = game.action_count(infoset);
    for (int action = 0; action < count; ++action)
    {
        if (game.action_label(infoset, action) == label)
        {
            return true;
        }
    }
    return false;
}

} // namespace

void run_tree_edit_tests()
{
    {
        LineEdit edit = force_root("c");
        CHECK(validate_line_edit(edit));
        edit.action.clear();
        CHECK(!validate_line_edit(edit));
    }

    {
        LineEdit edit;
        edit.kind = LineEditKind::Force;
        edit.action = "b50";
        edit.size_chips = 1;
        CHECK(!validate_line_edit(edit));
    }

    {
        LineEdit edit;
        edit.kind = LineEditKind::AddSize;
        edit.size_pot_fraction = 0.5;
        CHECK(validate_line_edit(edit));
        edit.action = "x";
        CHECK(!validate_line_edit(edit));
    }

    {
        LineEdit edit;
        edit.kind = LineEditKind::AddSize;
        edit.size_chips = 20;
        CHECK(validate_line_edit(edit));
        CHECK(edit.uses_chip_size());
        edit.size_pot_fraction = 0.1;
        CHECK(!validate_line_edit(edit));
    }

    {
        LinePath path;
        path.steps.push_back(LineStep{"c"});
        path.steps.push_back(LineStep{""});
        LineEdit edit = remove_along(path, "b50");
        CHECK(!validate_line_edit(edit));
    }

    {
        TreeEditSet set;
        set.append(force_root("c"));
        LinePath path;
        path.steps.push_back(LineStep{"c"});
        set.append(remove_along(path, "b50"));
        LineEdit add;
        add.kind = LineEditKind::AddSize;
        add.size_pot_fraction = 0.33;
        set.append(std::move(add));
        LineEdit chips;
        chips.kind = LineEditKind::AddSize;
        chips.path.steps.push_back(LineStep{"b33"});
        chips.size_chips = 20;
        set.append(std::move(chips));

        CHECK(set.size() == 4);
        CHECK(set.valid());

        const std::string text = format_tree_edits(set);
        CHECK(text.find("force - c\n") != std::string::npos);
        CHECK(text.find("remove c b50\n") != std::string::npos);
        CHECK(text.find("add-size - 0.33\n") != std::string::npos);
        CHECK(text.find("add-size b33 20c\n") != std::string::npos);

        const TreeEditSet round_trip = parse_tree_edits(text);
        CHECK(round_trip.size() == set.size());
        CHECK(format_tree_edits(round_trip) == text);
        CHECK(round_trip.edits[0].kind == LineEditKind::Force);
        CHECK(round_trip.edits[0].action == "c");
        CHECK(round_trip.edits[0].path.empty());
        CHECK(round_trip.edits[1].kind == LineEditKind::Remove);
        CHECK(round_trip.edits[1].path.size() == 1);
        CHECK(round_trip.edits[1].path.steps[0].label == "c");
        CHECK(round_trip.edits[1].action == "b50");
        CHECK(round_trip.edits[2].size_pot_fraction == 0.33);
        CHECK(round_trip.edits[3].uses_chip_size());
        CHECK(round_trip.edits[3].size_chips == 20);
    }

    {
        bool rejected = false;
        try
        {
            parse_tree_edits("force - c extra\n");
        }
        catch (const std::invalid_argument&)
        {
            rejected = true;
        }
        CHECK(rejected);
    }

    {
        bool rejected = false;
        try
        {
            parse_tree_edits("lock - c\n");
        }
        catch (const std::invalid_argument&)
        {
            rejected = true;
        }
        CHECK(rejected);
    }

    {
        TreeEditSet set;
        bool rejected = false;
        try
        {
            LineEdit bad = force_root("");
            set.append(std::move(bad));
        }
        catch (const std::invalid_argument&)
        {
            rejected = true;
        }
        CHECK(rejected);
        CHECK(set.empty());
    }

    // Force and Remove are distinct from a zero-probability node lock: an empty
    // action is invalid here, and unlocked is not expressible as a line edit.
    {
        LineEdit edit = force_root("c");
        CHECK(validate_line_edit(edit));
        edit.action = "0";
        CHECK(validate_line_edit(edit)); // label "0" is a legal action name token
    }

    // StreetGame applies Force/Remove/AddSize to legal actions at matching paths.
    {
        StreetConfig plain = tiny_turn_one_bet();
        const StreetGame baseline(plain);
        const StreetGame::State open = baseline.child_chance(baseline.root(), 0);
        CHECK(has_action_label(baseline, open, "Check"));
        CHECK(has_action_label(baseline, open, "Bet 50"));
        CHECK(baseline.action_count(baseline.infoset(open)) == 2);
    }

    {
        StreetConfig forced = tiny_turn_one_bet();
        forced.tree_edits.append(force_root("Check"));
        const StreetGame game(forced);
        const StreetGame::State open = game.child_chance(game.root(), 0);
        CHECK(game.action_count(game.infoset(open)) == 1);
        CHECK(has_action_label(game, open, "Check"));
        CHECK(!has_action_label(game, open, "Bet 50"));
    }

    {
        StreetConfig forced = tiny_turn_one_bet();
        forced.tree_edits.append(force_root("c"));
        const StreetGame game(forced);
        const StreetGame::State open = game.child_chance(game.root(), 0);
        CHECK(game.action_count(game.infoset(open)) == 1);
        CHECK(has_action_label(game, open, "Check"));
        CHECK(!has_action_label(game, open, "Bet 50"));
    }

    {
        StreetConfig removed = tiny_turn_one_bet();
        removed.tree_edits.append(remove_along(LinePath{}, "b50"));
        const StreetGame game(removed);
        const StreetGame::State open = game.child_chance(game.root(), 0);
        CHECK(game.action_count(game.infoset(open)) == 1);
        CHECK(has_action_label(game, open, "Check"));
        CHECK(!has_action_label(game, open, "Bet 50"));
    }

    {
        StreetConfig removed = tiny_turn_one_bet();
        LineEdit edit;
        edit.kind = LineEditKind::Remove;
        edit.action = "Bet 50";
        removed.tree_edits.edits.push_back(std::move(edit));
        const StreetGame game(removed);
        const StreetGame::State open = game.child_chance(game.root(), 0);
        CHECK(!has_action_label(game, open, "Bet 50"));
        CHECK(has_action_label(game, open, "Check"));
    }

    {
        StreetConfig along = tiny_turn_one_bet();
        LinePath path;
        path.steps.push_back(LineStep{"Check"});
        along.tree_edits.append(remove_along(path, "b50"));
        const StreetGame game(along);
        StreetGame::State state = game.child_chance(game.root(), 0);
        CHECK(has_action_label(game, state, "Bet 50"));
        int check_action = -1;
        const int infoset = game.infoset(state);
        for (int action = 0; action < game.action_count(infoset); ++action)
        {
            if (game.action_label(infoset, action) == "Check")
            {
                check_action = action;
                break;
            }
        }
        CHECK(check_action >= 0);
        state = game.child_action(state, check_action);
        CHECK(has_action_label(game, state, "Check"));
        CHECK(!has_action_label(game, state, "Bet 50"));
    }

    {
        StreetConfig with_add = tiny_turn_one_bet();
        with_add.tree_edits.append(add_size_along(LinePath{}, 0.33));
        CHECK(with_add.tree_edits.size() == 1);
        const StreetGame game(with_add);
        const StreetGame::State open = game.child_chance(game.root(), 0);
        CHECK(game.action_count(game.infoset(open)) == 3);
        CHECK(has_action_label(game, open, "Check"));
        CHECK(has_action_label(game, open, "Bet 33"));
        CHECK(has_action_label(game, open, "Bet 50"));
    }

    {
        StreetConfig with_chips = tiny_turn_one_bet();
        with_chips.tree_edits.append(add_chips_along(LinePath{}, 20));
        const StreetGame game(with_chips);
        const StreetGame::State open = game.child_chance(game.root(), 0);
        CHECK(has_action_label(game, open, "Bet 20"));
        CHECK(has_action_label(game, open, "Bet 50"));
        CHECK(game.action_count(game.infoset(open)) == 3);
    }

    {
        // Duplicate of an existing listed size is a no-op.
        StreetConfig dup = tiny_turn_one_bet();
        dup.tree_edits.append(add_size_along(LinePath{}, 0.5));
        const StreetGame game(dup);
        const StreetGame::State open = game.child_chance(game.root(), 0);
        CHECK(game.action_count(game.infoset(open)) == 2);
        CHECK(has_action_label(game, open, "Bet 50"));
    }

    {
        // Path-scoped AddSize only hits the matching decision.
        StreetConfig along = tiny_turn_one_bet();
        LinePath path;
        path.steps.push_back(LineStep{"Check"});
        along.tree_edits.append(add_size_along(path, 0.25));
        const StreetGame game(along);
        StreetGame::State state = game.child_chance(game.root(), 0);
        CHECK(game.action_count(game.infoset(state)) == 2);
        CHECK(!has_action_label(game, state, "Bet 25"));
        int check_action = -1;
        const int infoset = game.infoset(state);
        for (int action = 0; action < game.action_count(infoset); ++action)
        {
            if (game.action_label(infoset, action) == "Check")
            {
                check_action = action;
                break;
            }
        }
        CHECK(check_action >= 0);
        state = game.child_action(state, check_action);
        CHECK(has_action_label(game, state, "Check"));
        CHECK(has_action_label(game, state, "Bet 25"));
        CHECK(has_action_label(game, state, "Bet 50"));
        CHECK(game.action_count(game.infoset(state)) == 3);
    }

    {
        // Ordered edits: AddSize then Force keeps only the injected size.
        StreetConfig ordered = tiny_turn_one_bet();
        ordered.tree_edits.append(add_size_along(LinePath{}, 0.33));
        ordered.tree_edits.append(force_root("b33"));
        const StreetGame game(ordered);
        const StreetGame::State open = game.child_chance(game.root(), 0);
        CHECK(game.action_count(game.infoset(open)) == 1);
        CHECK(has_action_label(game, open, "Bet 33"));
        CHECK(!has_action_label(game, open, "Bet 50"));
        CHECK(!has_action_label(game, open, "Check"));
    }

    // StreetBatch public tree applies the same Force/Remove/AddSize edits.
    {
        StreetConfig plain = tiny_turn_one_bet();
        StreetBatchSolver baseline(plain);
        baseline.prepare_inspection();
        const auto root = baseline.inspect_node(baseline.root_node_id());
        CHECK(root.actions.size() == 2);
        CHECK(baseline.public_decisions() > 1);

        StreetConfig forced = tiny_turn_one_bet();
        forced.tree_edits.append(force_root("Check"));
        StreetBatchSolver forced_solver(forced);
        forced_solver.prepare_inspection();
        const auto forced_root = forced_solver.inspect_node(forced_solver.root_node_id());
        CHECK(forced_root.actions.size() == 1);
        CHECK(forced_root.actions[0].label == "Check");
        CHECK(forced_solver.public_decisions() < baseline.public_decisions());

        StreetConfig removed = tiny_turn_one_bet();
        removed.tree_edits.append(remove_along(LinePath{}, "b50"));
        StreetBatchSolver removed_solver(removed);
        removed_solver.prepare_inspection();
        const auto removed_root = removed_solver.inspect_node(removed_solver.root_node_id());
        CHECK(removed_root.actions.size() == 1);
        CHECK(removed_root.actions[0].label == "Check");
        CHECK(removed_solver.public_decisions() == forced_solver.public_decisions());

        StreetConfig with_add = tiny_turn_one_bet();
        with_add.tree_edits.append(add_size_along(LinePath{}, 0.33));
        StreetBatchSolver added_solver(with_add);
        added_solver.prepare_inspection();
        const auto added_root = added_solver.inspect_node(added_solver.root_node_id());
        CHECK(added_root.actions.size() == 3);
        CHECK(added_root.actions[0].label == "Check");
        CHECK(added_root.actions[1].label == "Bet 33");
        CHECK(added_root.actions[2].label == "Bet 50");
        CHECK(added_solver.public_decisions() > baseline.public_decisions());
    }

    {
        StreetConfig along = tiny_turn_one_bet();
        LinePath path;
        path.steps.push_back(LineStep{"Check"});
        along.tree_edits.append(remove_along(path, "b50"));
        StreetBatchSolver solver(along);
        solver.prepare_inspection();
        const auto root = solver.inspect_node(solver.root_node_id());
        CHECK(root.actions.size() == 2);
        std::string check_child;
        for (const auto& action : root.actions)
        {
            if (action.label == "Check")
            {
                check_child = action.child_id;
            }
        }
        CHECK(!check_child.empty());
        const auto after_check = solver.inspect_node(check_child);
        CHECK(after_check.actions.size() == 1);
        CHECK(after_check.actions[0].label == "Check");
    }

    {
        StreetConfig along = tiny_turn_one_bet();
        LinePath path;
        path.steps.push_back(LineStep{"Check"});
        along.tree_edits.append(add_size_along(path, 0.25));
        StreetBatchSolver solver(along);
        solver.prepare_inspection();
        const auto root = solver.inspect_node(solver.root_node_id());
        CHECK(root.actions.size() == 2);
        std::string check_child;
        for (const auto& action : root.actions)
        {
            if (action.label == "Check")
            {
                check_child = action.child_id;
            }
        }
        CHECK(!check_child.empty());
        const auto after_check = solver.inspect_node(check_child);
        CHECK(after_check.actions.size() == 3);
        CHECK(after_check.actions[0].label == "Check");
        CHECK(after_check.actions[1].label == "Bet 25");
        CHECK(after_check.actions[2].label == "Bet 50");
    }

    // street-config 1 round-trips tree-edit lines and rebuilds the same batch tree.
    {
        StreetConfig edited = tiny_turn_one_bet();
        edited.tree_edits.append(add_size_along(LinePath{}, 0.33));
        edited.tree_edits.append(force_root("c"));
        const std::string text = format_street_config(edited);
        CHECK(text.find("tree-edit add-size - 0.33\n") != std::string::npos);
        CHECK(text.find("tree-edit force - c\n") != std::string::npos);
        const StreetConfig parsed = parse_street_config(text);
        CHECK(format_street_config(parsed) == text);
        CHECK(parsed.tree_edits.size() == 2);
        CHECK(format_tree_edits(parsed.tree_edits) == format_tree_edits(edited.tree_edits));

        StreetBatchSolver original(edited);
        StreetBatchSolver rebuilt(parsed);
        original.prepare_inspection();
        rebuilt.prepare_inspection();
        CHECK(original.public_decisions() == rebuilt.public_decisions());
        CHECK(original.public_terminals() == rebuilt.public_terminals());
        const auto left = original.inspect_node(original.root_node_id());
        const auto right = rebuilt.inspect_node(rebuilt.root_node_id());
        // AddSize then Force: force wins at the root.
        CHECK(left.actions.size() == 1);
        CHECK(right.actions.size() == 1);
        CHECK(left.actions[0].label == "Check");
        CHECK(right.actions[0].label == "Check");
    }
}
