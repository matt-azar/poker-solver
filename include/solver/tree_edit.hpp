#pragma once

#include <cstddef>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace poker::solver
{

// How a LineEdit constrains the betting tree before build.
// Force keeps only the named action at that decision along the path.
// Remove drops the named action (check/fold may remain subject to game rules).
// AddSize injects one extra bet/raise size at the matching public decision:
// pot fraction uses the same basis as listed sizes (pot, or pot+to_call when
// facing); Nc is an absolute chip size. Illegal or duplicate sizes are skipped;
// edits apply in list order so later Force/Remove can see an earlier AddSize.
enum class LineEditKind
{
    Force,
    Remove,
    AddSize
};

// One action step in a public line. label is the canonical action string the
// tree would display (e.g. "c", "b50", "r100"). Empty labels are rejected.
struct LineStep
{
    std::string label;
};

// A root-to-decision path of action labels. Empty path means the root decision.
struct LinePath
{
    std::vector<LineStep> steps;

    bool empty() const
    {
        return steps.empty();
    }

    std::size_t size() const
    {
        return steps.size();
    }
};

inline bool valid_action_label(std::string_view label)
{
    if (label.empty())
    {
        return false;
    }
    for (const char character : label)
    {
        if (character <= ' ' || character == '#' || character == '\'' || character == '"')
        {
            return false;
        }
    }
    return true;
}

inline bool valid_line_path(const LinePath& path)
{
    for (const LineStep& step : path.steps)
    {
        if (!valid_action_label(step.label))
        {
            return false;
        }
    }
    return true;
}

// One tree edit. AddSize requires size_pot_fraction >= 0 (0 means an explicit
// chip amount in size_chips > 0). Force/Remove ignore size fields.
struct LineEdit
{
    LineEditKind kind = LineEditKind::Force;
    LinePath path;
    // For Force/Remove: the action label at path's decision. For AddSize: unused
    // (the new size is carried in size_*); prefer leaving action empty.
    std::string action;
    double size_pot_fraction = -1.0;
    int size_chips = 0;

    bool uses_chip_size() const
    {
        return kind == LineEditKind::AddSize && size_chips > 0;
    }
};

inline bool validate_line_edit(const LineEdit& edit)
{
    if (!valid_line_path(edit.path))
    {
        return false;
    }
    if (edit.kind == LineEditKind::AddSize)
    {
        if (!edit.action.empty())
        {
            return false;
        }
        if (edit.size_chips > 0)
        {
            return edit.size_pot_fraction < 0.0;
        }
        return edit.size_pot_fraction >= 0.0 && edit.size_chips == 0;
    }
    if (!valid_action_label(edit.action))
    {
        return false;
    }
    if (edit.size_pot_fraction >= 0.0 || edit.size_chips != 0)
    {
        return false;
    }
    return true;
}

// Ordered list of line edits. Later edits may target paths created by earlier
// AddSize intents; the build pass interprets order. This container does not
// expand a StreetGame — it only stores and validates the edit list.
struct TreeEditSet
{
    std::vector<LineEdit> edits;

    void clear()
    {
        edits.clear();
    }

    bool empty() const
    {
        return edits.empty();
    }

    std::size_t size() const
    {
        return edits.size();
    }

    void append(LineEdit edit)
    {
        if (!validate_line_edit(edit))
        {
            throw std::invalid_argument("invalid line edit");
        }
        edits.push_back(std::move(edit));
    }

    bool valid() const
    {
        for (const LineEdit& edit : edits)
        {
            if (!validate_line_edit(edit))
            {
                return false;
            }
        }
        return true;
    }
};

inline const char* line_edit_kind_token(LineEditKind kind)
{
    switch (kind)
    {
    case LineEditKind::Force:
        return "force";
    case LineEditKind::Remove:
        return "remove";
    case LineEditKind::AddSize:
        return "add-size";
    }
    return "force";
}

inline std::optional<LineEditKind> parse_line_edit_kind(std::string_view token)
{
    if (token == "force")
    {
        return LineEditKind::Force;
    }
    if (token == "remove")
    {
        return LineEditKind::Remove;
    }
    if (token == "add-size")
    {
        return LineEditKind::AddSize;
    }
    return std::nullopt;
}

// Text form, one edit per line (LF). Path steps are '/'-separated after the
// kind token. Examples:
//   force c/b50 r100
//   remove c b50
//   add-size c 0.33
//   add-size  20c
// Empty path is written as a single '-' before the action/size.
inline std::string format_tree_edits(const TreeEditSet& set)
{
    if (!set.valid())
    {
        throw std::invalid_argument("cannot format invalid tree edits");
    }
    std::ostringstream out;
    for (const LineEdit& edit : set.edits)
    {
        out << line_edit_kind_token(edit.kind) << ' ';
        if (edit.path.empty())
        {
            out << '-';
        }
        else
        {
            for (std::size_t i = 0; i < edit.path.steps.size(); ++i)
            {
                if (i != 0)
                {
                    out << '/';
                }
                out << edit.path.steps[i].label;
            }
        }
        if (edit.kind == LineEditKind::AddSize)
        {
            out << ' ';
            if (edit.uses_chip_size())
            {
                out << edit.size_chips << 'c';
            }
            else
            {
                out << edit.size_pot_fraction;
            }
        }
        else
        {
            out << ' ' << edit.action;
        }
        out << '\n';
    }
    return out.str();
}

inline TreeEditSet parse_tree_edits(std::string_view text)
{
    TreeEditSet set;
    std::size_t cursor = 0;
    while (cursor < text.size())
    {
        std::size_t end = text.find('\n', cursor);
        if (end == std::string_view::npos)
        {
            end = text.size();
        }
        std::string_view line = text.substr(cursor, end - cursor);
        cursor = end < text.size() ? end + 1 : end;
        if (!line.empty() && line.back() == '\r')
        {
            line.remove_suffix(1);
        }
        if (line.empty())
        {
            continue;
        }

        const std::size_t first_space = line.find(' ');
        if (first_space == std::string_view::npos)
        {
            throw std::invalid_argument("tree edit line missing fields");
        }
        const auto kind = parse_line_edit_kind(line.substr(0, first_space));
        if (!kind)
        {
            throw std::invalid_argument("unknown tree edit kind");
        }
        std::string_view rest = line.substr(first_space + 1);
        const std::size_t second_space = rest.find(' ');
        if (second_space == std::string_view::npos)
        {
            throw std::invalid_argument("tree edit line missing action or size");
        }
        std::string_view path_token = rest.substr(0, second_space);
        std::string_view tail = rest.substr(second_space + 1);
        if (tail.empty() || tail.find(' ') != std::string_view::npos)
        {
            throw std::invalid_argument("tree edit line has extra fields");
        }

        LineEdit edit;
        edit.kind = *kind;
        if (path_token != "-")
        {
            std::size_t path_cursor = 0;
            while (path_cursor < path_token.size())
            {
                std::size_t slash = path_token.find('/', path_cursor);
                if (slash == std::string_view::npos)
                {
                    slash = path_token.size();
                }
                const std::string_view step = path_token.substr(path_cursor, slash - path_cursor);
                if (!valid_action_label(step))
                {
                    throw std::invalid_argument("invalid path step in tree edit");
                }
                edit.path.steps.push_back(LineStep{std::string(step)});
                path_cursor = slash < path_token.size() ? slash + 1 : slash;
            }
        }

        if (edit.kind == LineEditKind::AddSize)
        {
            if (!tail.empty() && tail.back() == 'c')
            {
                const std::string chips(tail.substr(0, tail.size() - 1));
                try
                {
                    edit.size_chips = std::stoi(chips);
                }
                catch (const std::exception&)
                {
                    throw std::invalid_argument("invalid chip size in tree edit");
                }
                if (edit.size_chips <= 0)
                {
                    throw std::invalid_argument("chip size must be positive");
                }
            }
            else
            {
                try
                {
                    edit.size_pot_fraction = std::stod(std::string(tail));
                }
                catch (const std::exception&)
                {
                    throw std::invalid_argument("invalid pot fraction in tree edit");
                }
            }
        }
        else
        {
            edit.action = std::string(tail);
        }

        set.append(std::move(edit));
    }
    return set;
}

} // namespace poker::solver
