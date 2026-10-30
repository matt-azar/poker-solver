#include "harness.hpp"

#include "explorer/range_library.hpp"
#include "poker/range.hpp"

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <optional>
#include <string>
#include <vector>

namespace
{

std::filesystem::path make_temp_dir(const char* name)
{
    const std::filesystem::path root =
        std::filesystem::temp_directory_path() / name;
    std::filesystem::remove_all(root);
    std::filesystem::create_directories(root);
    return root;
}

void write_file(const std::filesystem::path& path, const std::string& text)
{
    std::ofstream out(path.string(), std::ios::binary);
    out << text;
}

std::string trim_range_text(std::string text)
{
    while (!text.empty()
        && (text.back() == '\n' || text.back() == '\r'
            || text.back() == ' ' || text.back() == '\t'))
    {
        text.pop_back();
    }
    return text;
}

void test_list_and_read()
{
    const std::filesystem::path root = make_temp_dir("poker-solver-ranges-list");
    write_file(root / "utg-open.txt", "JJ+,AQs+,AKo");
    write_file(root / "jj-plus.txt", "JJ+");
    write_file(root / "notes.md", "ignore me\n");

    const std::vector<poker::explorer::RangePresetInfo> listed =
        poker::explorer::list_range_presets(root);
    CHECK(listed.size() == 2);
    CHECK(listed[0].id == "jj-plus");
    CHECK(listed[0].name == "jj plus");
    CHECK(listed[1].id == "utg-open");
    CHECK(listed[1].name == "utg open");

    const std::optional<std::string> text =
        poker::explorer::read_range_preset(root, "utg-open");
    CHECK(text.has_value());
    const poker::holdem::Range range =
        poker::holdem::Range::parse(trim_range_text(*text));
    CHECK(range.total() > 0.0);

    std::filesystem::remove_all(root);
}

void test_missing_and_traversal()
{
    const std::filesystem::path root = make_temp_dir("poker-solver-ranges-bad");
    write_file(root / "ok.txt", "AA\n");

    CHECK(!poker::explorer::read_range_preset(root, "missing").has_value());
    CHECK(!poker::explorer::is_safe_range_id(".."));
    CHECK(!poker::explorer::is_safe_range_id("../ok"));
    CHECK(!poker::explorer::is_safe_range_id("a/b"));
    CHECK(!poker::explorer::is_safe_range_id("a\\b"));
    CHECK(!poker::explorer::is_safe_range_id(""));
    CHECK(!poker::explorer::is_safe_range_id("."));
    CHECK(!poker::explorer::read_range_preset(root, "..").has_value());
    CHECK(!poker::explorer::read_range_preset(root, "../ok").has_value());
    CHECK(!poker::explorer::read_range_preset(root, "a/b").has_value());
    CHECK(!poker::explorer::range_file_for_id(root, "..").has_value());

    std::filesystem::remove_all(root);
}

void test_resolve_env_override()
{
    const std::filesystem::path root = make_temp_dir("poker-solver-ranges-env");
    write_file(root / "env-only.txt", "KK\n");
#ifdef _WIN32
    _putenv_s("POKER_SOLVER_RANGES", root.string().c_str());
#else
    setenv("POKER_SOLVER_RANGES", root.string().c_str(), 1);
#endif
    const std::filesystem::path resolved = poker::explorer::resolve_ranges_directory();
    CHECK(resolved == std::filesystem::weakly_canonical(root));
    const std::vector<poker::explorer::RangePresetInfo> listed =
        poker::explorer::list_range_presets(resolved);
    CHECK(listed.size() == 1);
    CHECK(listed[0].id == "env-only");
#ifdef _WIN32
    _putenv_s("POKER_SOLVER_RANGES", "");
#else
    unsetenv("POKER_SOLVER_RANGES");
#endif
    std::filesystem::remove_all(root);
}

void test_repo_presets_parse()
{
    const std::filesystem::path candidates[] = {
        std::filesystem::path("configs") / "ranges",
        std::filesystem::path("..") / "configs" / "ranges",
        std::filesystem::path("..") / ".." / "configs" / "ranges",
    };
    std::filesystem::path root;
    for (const std::filesystem::path& candidate : candidates)
    {
        std::error_code error;
        if (std::filesystem::is_directory(candidate, error))
        {
            root = candidate;
            break;
        }
    }
    CHECK(!root.empty());
    if (root.empty())
    {
        return;
    }
    const std::vector<poker::explorer::RangePresetInfo> listed =
        poker::explorer::list_range_presets(root);
    CHECK(listed.size() >= 3);
    bool saw_utg = false;
    bool saw_jj = false;
    for (const poker::explorer::RangePresetInfo& info : listed)
    {
        const std::optional<std::string> text =
            poker::explorer::read_range_preset(root, info.id);
        CHECK(text.has_value());
        if (!text.has_value())
        {
            continue;
        }
        const poker::holdem::Range range =
            poker::holdem::Range::parse(trim_range_text(*text));
        CHECK(range.total() > 0.0);
        if (info.id == "utg-open")
        {
            saw_utg = true;
        }
        if (info.id == "jj-plus")
        {
            saw_jj = true;
            CHECK(range.total() == 24.0);
        }
    }
    CHECK(saw_utg);
    CHECK(saw_jj);
}

} // namespace

void run_range_library_tests()
{
    test_list_and_read();
    test_missing_and_traversal();
    test_resolve_env_override();
    test_repo_presets_parse();
}
