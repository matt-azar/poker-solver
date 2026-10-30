#include "harness.hpp"

#include "solver/tree_edit.hpp"

#include <stdexcept>
#include <string>

using poker::solver::LineEdit;
using poker::solver::LineEditKind;
using poker::solver::LinePath;
using poker::solver::LineStep;
using poker::solver::TreeEditSet;
using poker::solver::format_tree_edits;
using poker::solver::parse_tree_edits;
using poker::solver::validate_line_edit;

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
}
