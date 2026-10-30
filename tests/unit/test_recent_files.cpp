#include "harness.hpp"

#include "explorer/recent_files.hpp"

#include <cstdlib>
#include <filesystem>
#include <fstream>
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

void write_dummy(const std::filesystem::path& path)
{
    std::ofstream out(path.string(), std::ios::binary);
    out << "psol-placeholder\n";
}

void set_recent_env(const std::filesystem::path& path)
{
#ifdef _WIN32
    _putenv_s("POKER_SOLVER_RECENT_FILE", path.string().c_str());
#else
    setenv("POKER_SOLVER_RECENT_FILE", path.string().c_str(), 1);
#endif
}

void clear_recent_env()
{
#ifdef _WIN32
    _putenv_s("POKER_SOLVER_RECENT_FILE", "");
#else
    unsetenv("POKER_SOLVER_RECENT_FILE");
#endif
}

void test_add_dedupe_cap()
{
    const std::filesystem::path root = make_temp_dir("poker-solver-recent-dedupe");
    const std::filesystem::path sidecar = root / "recent_psol.txt";
    const std::filesystem::path first = root / "one.psol";
    const std::filesystem::path second = root / "two.psol";
    const std::filesystem::path third = root / "three.psol";
    write_dummy(first);
    write_dummy(second);
    write_dummy(third);

    poker::explorer::record_recent_file(sidecar, first.string(), "one");
    poker::explorer::record_recent_file(sidecar, second.string(), "two");
    poker::explorer::record_recent_file(sidecar, first.string(), "one-again");

    const std::vector<poker::explorer::RecentFile> listed =
        poker::explorer::list_recent_files(sidecar, false);
    CHECK(listed.size() == 2);
    CHECK(listed[0].path == poker::explorer::normalize_recent_path(first.string()));
    CHECK(listed[0].name == "one-again");
    CHECK(listed[1].path == poker::explorer::normalize_recent_path(second.string()));
    CHECK(listed[1].name == "two");

    for (int index = 0; index < 12; ++index)
    {
        const std::filesystem::path path =
            root / ("cap-" + std::to_string(index) + ".psol");
        write_dummy(path);
        poker::explorer::record_recent_file(sidecar, path.string());
    }
    const std::vector<poker::explorer::RecentFile> capped =
        poker::explorer::list_recent_files(sidecar, false);
    CHECK(capped.size() == poker::explorer::kMaxRecentFiles);
    CHECK(capped[0].path
        == poker::explorer::normalize_recent_path((root / "cap-11.psol").string()));

    std::filesystem::remove_all(root);
}

void test_persist_round_trip()
{
    const std::filesystem::path root = make_temp_dir("poker-solver-recent-persist");
    const std::filesystem::path sidecar = root / "recent_psol.txt";
    const std::filesystem::path path = root / "saved.psol";
    write_dummy(path);

    set_recent_env(sidecar);
    poker::explorer::record_recent_file(path.string(), "saved");
    const std::filesystem::path resolved = poker::explorer::resolve_recent_file_path();
    CHECK(resolved == sidecar);

    const std::vector<poker::explorer::RecentFile> from_disk =
        poker::explorer::load_recent_files(sidecar);
    CHECK(from_disk.size() == 1);
    CHECK(from_disk[0].path == poker::explorer::normalize_recent_path(path.string()));
    CHECK(from_disk[0].name == "saved");
    CHECK(from_disk[0].mtime > 0);

    const std::string text = poker::explorer::serialize_recent_files(from_disk);
    const std::vector<poker::explorer::RecentFile> parsed =
        poker::explorer::parse_recent_files(text);
    CHECK(parsed.size() == 1);
    CHECK(parsed[0].path == from_disk[0].path);
    CHECK(parsed[0].name == from_disk[0].name);
    CHECK(parsed[0].mtime == from_disk[0].mtime);

    poker::explorer::clear_recent_files();
    CHECK(poker::explorer::list_recent_files(false).empty());

    clear_recent_env();
    std::filesystem::remove_all(root);
}

void test_drop_missing()
{
    const std::filesystem::path root = make_temp_dir("poker-solver-recent-missing");
    const std::filesystem::path sidecar = root / "recent_psol.txt";
    const std::filesystem::path keep = root / "keep.psol";
    const std::filesystem::path gone = root / "gone.psol";
    write_dummy(keep);
    write_dummy(gone);

    poker::explorer::record_recent_file(sidecar, keep.string());
    poker::explorer::record_recent_file(sidecar, gone.string());
    std::filesystem::remove(gone);

    const std::vector<poker::explorer::RecentFile> with_missing =
        poker::explorer::list_recent_files(sidecar, false);
    CHECK(with_missing.size() == 2);

    const std::vector<poker::explorer::RecentFile> dropped =
        poker::explorer::list_recent_files(sidecar, true);
    CHECK(dropped.size() == 1);
    CHECK(dropped[0].path == poker::explorer::normalize_recent_path(keep.string()));

    std::filesystem::remove_all(root);
}

} // namespace

void run_recent_files_tests()
{
    test_add_dedupe_cap();
    test_persist_round_trip();
    test_drop_missing();
}
