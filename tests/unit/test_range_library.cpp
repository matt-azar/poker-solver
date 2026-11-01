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
    std::filesystem::create_directories(path.parent_path());
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
    CHECK(listed[0].folder.empty());
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

void test_nested_folders()
{
    const std::filesystem::path root = make_temp_dir("poker-solver-ranges-nested");
    write_file(root / "open" / "utg-open.txt", "JJ+,AQs+,AKo");
    write_file(root / "open" / "jj-plus.txt", "JJ+");
    write_file(root / "defend" / "btn-call.txt", "22+,A2s+,ATo+");
    write_file(root / "broadway.txt", "TT+,AQ+");
    write_file(root / "open" / "skip.md", "ignore\n");
    write_file(root / "bad name" / "x.txt", "AA\n");

    CHECK(poker::explorer::is_safe_range_id("open/utg-open"));
    CHECK(poker::explorer::is_safe_range_id("a/b/c"));
    CHECK(!poker::explorer::is_safe_range_id("/open/utg-open"));
    CHECK(!poker::explorer::is_safe_range_id("open//utg-open"));
    CHECK(!poker::explorer::is_safe_range_id("open/../utg-open"));
    CHECK(!poker::explorer::is_safe_range_id("open\\utg-open"));

    const std::vector<poker::explorer::RangePresetInfo> listed =
        poker::explorer::list_range_presets(root);
    CHECK(listed.size() == 4);
    CHECK(listed[0].id == "broadway");
    CHECK(listed[0].folder.empty());
    CHECK(listed[1].id == "defend/btn-call");
    CHECK(listed[1].folder == "defend");
    CHECK(listed[1].name == "btn call");
    CHECK(listed[2].id == "open/jj-plus");
    CHECK(listed[2].folder == "open");
    CHECK(listed[3].id == "open/utg-open");
    CHECK(listed[3].folder == "open");

    const std::optional<std::string> nested =
        poker::explorer::read_range_preset(root, "open/utg-open");
    CHECK(nested.has_value());
    CHECK(poker::holdem::Range::parse(trim_range_text(*nested)).total() > 0.0);
    CHECK(poker::explorer::range_file_for_id(root, "defend/btn-call").has_value());
    CHECK(!poker::explorer::read_range_preset(root, "open/missing").has_value());
    CHECK(!poker::explorer::read_range_preset(root, "open/../broadway").has_value());

    std::filesystem::remove_all(root);
}

void test_missing_and_traversal()
{
    const std::filesystem::path root = make_temp_dir("poker-solver-ranges-bad");
    write_file(root / "ok.txt", "AA\n");

    CHECK(!poker::explorer::read_range_preset(root, "missing").has_value());
    CHECK(!poker::explorer::is_safe_range_id(".."));
    CHECK(!poker::explorer::is_safe_range_id("../ok"));
    CHECK(!poker::explorer::is_safe_range_id("a\\b"));
    CHECK(!poker::explorer::is_safe_range_id(""));
    CHECK(!poker::explorer::is_safe_range_id("."));
    CHECK(!poker::explorer::read_range_preset(root, "..").has_value());
    CHECK(!poker::explorer::read_range_preset(root, "../ok").has_value());
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
    bool saw_nested = false;
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
        if (info.id == "open/utg-open" || info.id == "utg-open")
        {
            saw_utg = true;
        }
        if (info.id == "open/jj-plus" || info.id == "jj-plus")
        {
            saw_jj = true;
            CHECK(range.total() == 24.0);
        }
        if (!info.folder.empty())
        {
            saw_nested = true;
            CHECK(info.id.find('/') != std::string::npos);
        }
    }
    CHECK(saw_utg);
    CHECK(saw_jj);
    CHECK(saw_nested);
}

} // namespace

void run_range_library_tests()
{
    test_list_and_read();
    test_nested_folders();
    test_missing_and_traversal();
    test_resolve_env_override();
    test_repo_presets_parse();
}
