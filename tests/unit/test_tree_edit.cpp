#include "harness.hpp"

#include "game/street_game.hpp"
#include "poker/card.hpp"
#include "poker/range.hpp"
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
using poker::streets::StreetConfig;
using poker::streets::StreetGame;

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

    // StreetGame applies Force/Remove to legal actions; AddSize stays stored only.
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
        LineEdit add;
        add.kind = LineEditKind::AddSize;
        add.size_pot_fraction = 0.33;
        with_add.tree_edits.append(std::move(add));
        CHECK(with_add.tree_edits.size() == 1);
        const StreetGame game(with_add);
        const StreetGame::State open = game.child_chance(game.root(), 0);
        CHECK(game.action_count(game.infoset(open)) == 2);
        CHECK(has_action_label(game, open, "Check"));
        CHECK(has_action_label(game, open, "Bet 50"));
        CHECK(!has_action_label(game, open, "Bet 33"));
    }
}
