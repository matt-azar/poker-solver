#pragma once

// Bounded most-recently-used list of PSOL solution paths for the explorer.
// Persists under ~/.poker-solver/recent_psol.txt by default (JSON array).
// Override the sidecar path with POKER_SOLVER_RECENT_FILE for tests or custom layouts.
// Opening a listed path must still go through POST /api/open (same validation as Open).

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

namespace poker::explorer
{

inline constexpr std::size_t kMaxRecentFiles = 10;

struct RecentFile
{
    std::string path;
    std::string name;
    std::int64_t mtime = 0;
};

inline void append_json_string(std::string& out, std::string_view text)
{
    out.push_back('"');
    for (char character : text)
    {
        if (character == '"' || character == '\\')
        {
            out.push_back('\\');
            out.push_back(character);
        }
        else if (character == '\n')
        {
            out += "\\n";
        }
        else if (character == '\r')
        {
            out += "\\r";
        }
        else if (character == '\t')
        {
            out += "\\t";
        }
        else
        {
            out.push_back(character);
        }
    }
    out.push_back('"');
}

inline bool parse_json_string(std::string_view text, std::size_t& cursor, std::string& value)
{
    while (cursor < text.size()
        && (text[cursor] == ' ' || text[cursor] == '\n' || text[cursor] == '\r'
            || text[cursor] == '\t'))
    {
        ++cursor;
    }
    if (cursor >= text.size() || text[cursor] != '"')
    {
        return false;
    }
    ++cursor;
    value.clear();
    while (cursor < text.size())
    {
        const char character = text[cursor++];
        if (character == '"')
        {
            return true;
        }
        if (character == '\\')
        {
            if (cursor >= text.size())
            {
                return false;
            }
            const char escaped = text[cursor++];
            if (escaped == 'n')
            {
                value.push_back('\n');
            }
            else if (escaped == 'r')
            {
                value.push_back('\r');
            }
            else if (escaped == 't')
            {
                value.push_back('\t');
            }
            else
            {
                value.push_back(escaped);
            }
            continue;
        }
        value.push_back(character);
    }
    return false;
}

inline bool parse_json_int(std::string_view text, std::size_t& cursor, std::int64_t& value)
{
    while (cursor < text.size()
        && (text[cursor] == ' ' || text[cursor] == '\n' || text[cursor] == '\r'
            || text[cursor] == '\t'))
    {
        ++cursor;
    }
    if (cursor >= text.size())
    {
        return false;
    }
    const bool negative = text[cursor] == '-';
    if (negative)
    {
        ++cursor;
    }
    if (cursor >= text.size() || text[cursor] < '0' || text[cursor] > '9')
    {
        return false;
    }
    std::int64_t parsed = 0;
    while (cursor < text.size() && text[cursor] >= '0' && text[cursor] <= '9')
    {
        parsed = parsed * 10 + (text[cursor] - '0');
        ++cursor;
    }
    value = negative ? -parsed : parsed;
    return true;
}

inline std::filesystem::path default_recent_file_path()
{
    const char* home = nullptr;
#ifdef _WIN32
    home = std::getenv("USERPROFILE");
#else
    home = std::getenv("HOME");
#endif
    if (home == nullptr || home[0] == '\0')
    {
        return std::filesystem::temp_directory_path() / "poker-solver-recent_psol.txt";
    }
    return std::filesystem::path(home) / ".poker-solver" / "recent_psol.txt";
}

// Resolution: POKER_SOLVER_RECENT_FILE when set, else ~/.poker-solver/recent_psol.txt.
inline std::filesystem::path resolve_recent_file_path()
{
    if (const char* env = std::getenv("POKER_SOLVER_RECENT_FILE"))
    {
        if (env[0] != '\0')
        {
            return std::filesystem::path(env);
        }
    }
    return default_recent_file_path();
}

inline std::string normalize_recent_path(const std::string& path)
{
    std::error_code error;
    const std::filesystem::path candidate(path);
    const std::filesystem::path absolute = std::filesystem::absolute(candidate, error);
    if (error)
    {
        return candidate.lexically_normal().generic_string();
    }
    const std::filesystem::path canonical = std::filesystem::weakly_canonical(absolute, error);
    if (!error)
    {
        return canonical.generic_string();
    }
    return absolute.lexically_normal().generic_string();
}

inline std::string recent_display_name(const std::string& path, const std::string& name)
{
    if (!name.empty())
    {
        return name;
    }
    return std::filesystem::path(path).filename().string();
}

inline std::int64_t file_mtime_seconds(const std::filesystem::path& path)
{
    std::error_code error;
    const auto file_time = std::filesystem::last_write_time(path, error);
    if (error)
    {
        const auto now = std::chrono::system_clock::now().time_since_epoch();
        return std::chrono::duration_cast<std::chrono::seconds>(now).count();
    }
    const auto system_time = std::chrono::clock_cast<std::chrono::system_clock>(file_time);
    return std::chrono::duration_cast<std::chrono::seconds>(system_time.time_since_epoch()).count();
}

inline std::string serialize_recent_files(const std::vector<RecentFile>& entries)
{
    std::string out = "[\n";
    for (std::size_t index = 0; index < entries.size(); ++index)
    {
        if (index > 0)
        {
            out += ",\n";
        }
        out += "{\"path\":";
        append_json_string(out, entries[index].path);
        out += ",\"name\":";
        append_json_string(out, entries[index].name);
        out += ",\"mtime\":";
        out += std::to_string(entries[index].mtime);
        out += "}";
    }
    out += "\n]\n";
    return out;
}

inline std::vector<RecentFile> parse_recent_files(std::string_view text)
{
    std::vector<RecentFile> entries;
    std::size_t cursor = 0;
    while (cursor < text.size()
        && (text[cursor] == ' ' || text[cursor] == '\n' || text[cursor] == '\r'
            || text[cursor] == '\t'))
    {
        ++cursor;
    }
    if (cursor >= text.size() || text[cursor] != '[')
    {
        return entries;
    }
    ++cursor;
    while (cursor < text.size())
    {
        while (cursor < text.size()
            && (text[cursor] == ' ' || text[cursor] == '\n' || text[cursor] == '\r'
                || text[cursor] == '\t' || text[cursor] == ','))
        {
            ++cursor;
        }
        if (cursor < text.size() && text[cursor] == ']')
        {
            break;
        }
        if (cursor >= text.size() || text[cursor] != '{')
        {
            break;
        }
        ++cursor;
        RecentFile entry;
        bool saw_path = false;
        while (cursor < text.size() && text[cursor] != '}')
        {
            while (cursor < text.size()
                && (text[cursor] == ' ' || text[cursor] == '\n' || text[cursor] == '\r'
                    || text[cursor] == '\t' || text[cursor] == ','))
            {
                ++cursor;
            }
            if (cursor < text.size() && text[cursor] == '}')
            {
                break;
            }
            std::string key;
            if (!parse_json_string(text, cursor, key))
            {
                return {};
            }
            while (cursor < text.size()
                && (text[cursor] == ' ' || text[cursor] == '\n' || text[cursor] == '\r'
                    || text[cursor] == '\t'))
            {
                ++cursor;
            }
            if (cursor >= text.size() || text[cursor] != ':')
            {
                return {};
            }
            ++cursor;
            if (key == "path" || key == "name")
            {
                std::string value;
                if (!parse_json_string(text, cursor, value))
                {
                    return {};
                }
                if (key == "path")
                {
                    entry.path = std::move(value);
                    saw_path = true;
                }
                else
                {
                    entry.name = std::move(value);
                }
            }
            else if (key == "mtime")
            {
                if (!parse_json_int(text, cursor, entry.mtime))
                {
                    return {};
                }
            }
            else
            {
                return {};
            }
        }
        if (cursor < text.size() && text[cursor] == '}')
        {
            ++cursor;
        }
        if (saw_path && !entry.path.empty())
        {
            entry.name = recent_display_name(entry.path, entry.name);
            entries.push_back(std::move(entry));
        }
    }
    return entries;
}

inline std::vector<RecentFile> load_recent_files(const std::filesystem::path& sidecar)
{
    std::ifstream input(sidecar.string(), std::ios::binary);
    if (!input)
    {
        return {};
    }
    std::ostringstream buffer;
    buffer << input.rdbuf();
    return parse_recent_files(buffer.str());
}

inline bool save_recent_files(
    const std::filesystem::path& sidecar,
    const std::vector<RecentFile>& entries)
{
    std::error_code error;
    const std::filesystem::path parent = sidecar.parent_path();
    if (!parent.empty())
    {
        std::filesystem::create_directories(parent, error);
        if (error)
        {
            return false;
        }
    }
    const std::filesystem::path temporary = sidecar.string() + ".tmp";
    {
        std::ofstream output(temporary.string(), std::ios::binary | std::ios::trunc);
        if (!output)
        {
            return false;
        }
        output << serialize_recent_files(entries);
        if (!output)
        {
            std::filesystem::remove(temporary, error);
            return false;
        }
    }
    std::filesystem::rename(temporary, sidecar, error);
    if (error)
    {
        std::filesystem::remove(sidecar, error);
        std::filesystem::rename(temporary, sidecar, error);
        if (error)
        {
            std::filesystem::remove(temporary, error);
            return false;
        }
    }
    return true;
}

inline std::vector<RecentFile> list_recent_files(
    const std::filesystem::path& sidecar,
    bool drop_missing = true)
{
    std::vector<RecentFile> entries = load_recent_files(sidecar);
    if (!drop_missing)
    {
        if (entries.size() > kMaxRecentFiles)
        {
            entries.resize(kMaxRecentFiles);
        }
        return entries;
    }
    std::vector<RecentFile> kept;
    kept.reserve(entries.size());
    for (RecentFile& entry : entries)
    {
        std::error_code error;
        if (!std::filesystem::is_regular_file(entry.path, error))
        {
            continue;
        }
        kept.push_back(std::move(entry));
        if (kept.size() == kMaxRecentFiles)
        {
            break;
        }
    }
    return kept;
}

inline void record_recent_file(
    const std::filesystem::path& sidecar,
    const std::string& path,
    const std::string& display_name = {})
{
    if (path.empty())
    {
        return;
    }
    const std::string normalized = normalize_recent_path(path);
    RecentFile incoming;
    incoming.path = normalized;
    incoming.name = recent_display_name(normalized, display_name);
    incoming.mtime = file_mtime_seconds(normalized);

    std::vector<RecentFile> entries = load_recent_files(sidecar);
    entries.erase(
        std::remove_if(
            entries.begin(),
            entries.end(),
            [&](const RecentFile& entry)
            {
                return normalize_recent_path(entry.path) == normalized;
            }),
        entries.end());
    entries.insert(entries.begin(), std::move(incoming));
    if (entries.size() > kMaxRecentFiles)
    {
        entries.resize(kMaxRecentFiles);
    }
    save_recent_files(sidecar, entries);
}

inline void clear_recent_files(const std::filesystem::path& sidecar)
{
    save_recent_files(sidecar, {});
}

inline void record_recent_file(const std::string& path, const std::string& display_name = {})
{
    record_recent_file(resolve_recent_file_path(), path, display_name);
}

inline std::vector<RecentFile> list_recent_files(bool drop_missing = true)
{
    return list_recent_files(resolve_recent_file_path(), drop_missing);
}

inline void clear_recent_files()
{
    clear_recent_files(resolve_recent_file_path());
}

} // namespace poker::explorer
