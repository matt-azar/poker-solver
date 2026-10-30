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
// The library is flat: only regular files in that directory are listed.

struct RangePresetInfo
{
    std::string id;
    std::string name;
};

inline bool is_safe_range_id(std::string_view id)
{
    if (id.empty() || id == "." || id == "..")
    {
        return false;
    }
    for (char character : id)
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

inline std::string range_display_name(std::string_view id)
{
    std::string name(id);
    for (char& character : name)
    {
        if (character == '-' || character == '_')
        {
            character = ' ';
        }
    }
    return name;
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
    const std::filesystem::path with_txt = directory / (std::string(id) + ".txt");
    std::error_code error;
    if (std::filesystem::is_regular_file(with_txt, error))
    {
        return with_txt;
    }
    const std::filesystem::path bare = directory / std::string(id);
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
    for (const std::filesystem::directory_entry& entry :
         std::filesystem::directory_iterator(directory, error))
    {
        if (error || !entry.is_regular_file(error))
        {
            continue;
        }
        const std::filesystem::path path = entry.path();
        const std::string stem = path.stem().string();
        const std::string extension = path.extension().string();
        if (!(extension.empty() || extension == ".txt"))
        {
            continue;
        }
        if (!is_safe_range_id(stem))
        {
            continue;
        }
        presets.push_back(RangePresetInfo{stem, range_display_name(stem)});
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
