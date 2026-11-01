#pragma once

#include <algorithm>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

namespace poker::explorer
{

// Named weighted/combo range presets live under configs/ranges by default.
// Resolution order:
// 1. POKER_SOLVER_RANGES when set to a non-empty path
// 2. configs/ranges relative to the current working directory
// 3. configs/ranges next to the executable, then one or two parents up
//    (same layout search as the explorer ui/ root)
// The first existing directory wins. An empty path means none was found.
// Nested folders are supported: ids use forward slashes (e.g. open/utg-open).

struct RangePresetInfo
{
    std::string id;
    std::string name;
    // Relative folder under the ranges root (empty for top-level files).
    std::string folder;
};

inline bool is_safe_range_segment(std::string_view segment)
{
    if (segment.empty() || segment == "." || segment == "..")
    {
        return false;
    }
    for (char character : segment)
    {
        const bool ok = (character >= 'a' && character <= 'z')
            || (character >= 'A' && character <= 'Z')
            || (character >= '0' && character <= '9')
            || character == '-' || character == '_';
        if (!ok)
        {
            return false;
        }
    }
    return true;
}

// Accepts flat ids ("utg-open") and nested ids ("open/utg-open").
// Rejects empty, ".", "..", backslashes, absolute paths, and empty segments.
inline bool is_safe_range_id(std::string_view id)
{
    if (id.empty() || id.front() == '/' || id.back() == '/')
    {
        return false;
    }
    if (id.find('\\') != std::string_view::npos)
    {
        return false;
    }
    if (id.find("//") != std::string_view::npos)
    {
        return false;
    }
    std::size_t start = 0;
    while (start <= id.size())
    {
        const std::size_t slash = id.find('/', start);
        const std::string_view segment = slash == std::string_view::npos
            ? id.substr(start)
            : id.substr(start, slash - start);
        if (!is_safe_range_segment(segment))
        {
            return false;
        }
        if (slash == std::string_view::npos)
        {
            break;
        }
        start = slash + 1;
    }
    return true;
}

inline std::string range_display_name(std::string_view id)
{
    std::string_view leaf = id;
    const std::size_t slash = id.find_last_of('/');
    if (slash != std::string_view::npos)
    {
        leaf = id.substr(slash + 1);
    }
    std::string name(leaf);
    for (char& character : name)
    {
        if (character == '-' || character == '_')
        {
            character = ' ';
        }
    }
    return name;
}

inline std::string range_folder_of(std::string_view id)
{
    const std::size_t slash = id.find_last_of('/');
    if (slash == std::string_view::npos)
    {
        return {};
    }
    return std::string(id.substr(0, slash));
}

inline std::filesystem::path resolve_ranges_directory(
    const std::filesystem::path& executable_directory = {})
{
    if (const char* env = std::getenv("POKER_SOLVER_RANGES"))
    {
        if (env[0] != '\0')
        {
            const std::filesystem::path from_env(env);
            std::error_code error;
            if (std::filesystem::is_directory(from_env, error))
            {
                return std::filesystem::weakly_canonical(from_env, error);
            }
        }
    }

    std::vector<std::filesystem::path> candidates;
    candidates.emplace_back("configs/ranges");
    if (!executable_directory.empty())
    {
        candidates.push_back(executable_directory / "configs" / "ranges");
        candidates.push_back(executable_directory / ".." / "configs" / "ranges");
        candidates.push_back(executable_directory / ".." / ".." / "configs" / "ranges");
    }

    for (const std::filesystem::path& candidate : candidates)
    {
        std::error_code error;
        if (std::filesystem::is_directory(candidate, error))
        {
            return std::filesystem::weakly_canonical(candidate, error);
        }
    }
    return {};
}

inline std::optional<std::filesystem::path> range_file_for_id(
    const std::filesystem::path& directory,
    std::string_view id)
{
    if (!is_safe_range_id(id) || directory.empty())
    {
        return std::nullopt;
    }
    std::filesystem::path relative;
    std::size_t start = 0;
    while (start <= id.size())
    {
        const std::size_t slash = id.find('/', start);
        const std::string_view segment = slash == std::string_view::npos
            ? id.substr(start)
            : id.substr(start, slash - start);
        relative /= std::string(segment);
        if (slash == std::string_view::npos)
        {
            break;
        }
        start = slash + 1;
    }

    const std::filesystem::path with_txt =
        directory / (relative.string() + ".txt");
    std::error_code error;
    if (std::filesystem::is_regular_file(with_txt, error))
    {
        return with_txt;
    }
    const std::filesystem::path bare = directory / relative;
    if (std::filesystem::is_regular_file(bare, error))
    {
        return bare;
    }
    return std::nullopt;
}

inline std::vector<RangePresetInfo> list_range_presets(const std::filesystem::path& directory)
{
    std::vector<RangePresetInfo> presets;
    if (directory.empty())
    {
        return presets;
    }
    std::error_code error;
    if (!std::filesystem::is_directory(directory, error))
    {
        return presets;
    }
    const std::filesystem::path root = std::filesystem::weakly_canonical(directory, error);
    if (error || root.empty())
    {
        return presets;
    }
    for (const std::filesystem::directory_entry& entry :
         std::filesystem::recursive_directory_iterator(root, error))
    {
        if (error || !entry.is_regular_file(error))
        {
            continue;
        }
        const std::filesystem::path path = entry.path();
        const std::string extension = path.extension().string();
        if (!(extension.empty() || extension == ".txt"))
        {
            continue;
        }
        std::filesystem::path relative = std::filesystem::relative(path, root, error);
        if (error || relative.empty())
        {
            continue;
        }
        relative = relative.lexically_normal();
        std::string id;
        bool ok = true;
        const std::filesystem::path parent = relative.parent_path();
        for (const std::filesystem::path& part : parent)
        {
            const std::string segment = part.string();
            if (segment.empty() || segment == ".")
            {
                continue;
            }
            if (segment == ".." || !is_safe_range_segment(segment))
            {
                ok = false;
                break;
            }
            if (!id.empty())
            {
                id.push_back('/');
            }
            id += segment;
        }
        if (!ok)
        {
            continue;
        }
        const std::string leaf = path.stem().string();
        if (!is_safe_range_segment(leaf))
        {
            continue;
        }
        if (!id.empty())
        {
            id.push_back('/');
        }
        id += leaf;
        if (!is_safe_range_id(id))
        {
            continue;
        }
        presets.push_back(RangePresetInfo{id, range_display_name(id), range_folder_of(id)});
    }
    std::sort(
        presets.begin(),
        presets.end(),
        [](const RangePresetInfo& left, const RangePresetInfo& right)
        {
            return left.id < right.id;
        });
    return presets;
}

inline std::optional<std::string> read_range_preset(
    const std::filesystem::path& directory,
    std::string_view id)
{
    const std::optional<std::filesystem::path> path = range_file_for_id(directory, id);
    if (!path.has_value())
    {
        return std::nullopt;
    }
    std::ifstream input(path->string(), std::ios::binary);
    if (!input)
    {
        return std::nullopt;
    }
    std::ostringstream buffer;
    buffer << input.rdbuf();
    std::string text = buffer.str();
    text.erase(std::remove(text.begin(), text.end(), '\r'), text.end());
    return text;
}

} // namespace poker::explorer
