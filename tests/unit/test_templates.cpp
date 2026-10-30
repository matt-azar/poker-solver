#include "harness.hpp"

#include "explorer/templates.hpp"
#include "game/street_config_text.hpp"

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

void test_list_and_read()
{
    const std::filesystem::path root = make_temp_dir("poker-solver-templates-list");
    write_file(
        root / "turn-probe.txt",
        "street-config 1\n"
        "board Ah Kd 7c 4s\n"
        "pot 100\n"
        "stack 100\n"
        "oop-range AhAd:1\n"
        "ip-range 2c3d:1\n"
        "first-to-act 0\n"
        "max-raises 1\n"
        "allow-all-in 0\n"
        "allow-three-bet 1\n"
        "geometric 0\n"
        "all-in-threshold 0\n"
        "pot-cap 0\n"
        "memory-mib 64\n"
        "threads 1\n"
        "oop-bets 0.5\n"
        "ip-bets 0.5\n");
    write_file(
        root / "flop-check-down.txt",
        "street-config 1\n"
        "board Ah Kd 7c\n"
        "pot 100\n"
        "stack 100\n"
        "oop-range AhAd:1\n"
        "ip-range 2c3d:1\n"
        "first-to-act 0\n"
        "max-raises 0\n"
        "allow-all-in 0\n"
        "allow-three-bet 1\n"
        "geometric 0\n"
        "all-in-threshold 0\n"
        "pot-cap 0\n"
        "memory-mib 64\n"
        "threads 1\n");
    write_file(root / "notes.md", "ignore me\n");

    const std::vector<poker::explorer::TemplateInfo> listed =
        poker::explorer::list_templates(root);
    CHECK(listed.size() == 2);
    CHECK(listed[0].id == "flop-check-down");
    CHECK(listed[0].name == "flop check down");
    CHECK(listed[1].id == "turn-probe");
    CHECK(listed[1].name == "turn probe");

    const std::optional<std::string> text =
        poker::explorer::read_template(root, "turn-probe");
    CHECK(text.has_value());
    const poker::streets::StreetConfig config = poker::streets::parse_street_config(*text);
    CHECK(config.board.size() == 4);
    CHECK(config.oop_bet_sizes.size() == 1);

    std::filesystem::remove_all(root);
}

void test_missing_and_traversal()
{
    const std::filesystem::path root = make_temp_dir("poker-solver-templates-bad");
    write_file(root / "ok.txt", "street-config 1\n");

    CHECK(!poker::explorer::read_template(root, "missing").has_value());
    CHECK(!poker::explorer::is_safe_template_id(".."));
    CHECK(!poker::explorer::is_safe_template_id("../ok"));
    CHECK(!poker::explorer::is_safe_template_id("a/b"));
    CHECK(!poker::explorer::is_safe_template_id("a\\b"));
    CHECK(!poker::explorer::is_safe_template_id(""));
    CHECK(!poker::explorer::is_safe_template_id("."));
    CHECK(!poker::explorer::read_template(root, "..").has_value());
    CHECK(!poker::explorer::read_template(root, "../ok").has_value());
    CHECK(!poker::explorer::read_template(root, "a/b").has_value());
    CHECK(!poker::explorer::template_file_for_id(root, "..").has_value());

    std::filesystem::remove_all(root);
}

void test_resolve_env_override()
{
    const std::filesystem::path root = make_temp_dir("poker-solver-templates-env");
    write_file(root / "env-only.txt", "street-config 1\n");
#ifdef _WIN32
    _putenv_s("POKER_SOLVER_TEMPLATES", root.string().c_str());
#else
    setenv("POKER_SOLVER_TEMPLATES", root.string().c_str(), 1);
#endif
    const std::filesystem::path resolved = poker::explorer::resolve_templates_directory();
    CHECK(resolved == std::filesystem::weakly_canonical(root));
    const std::vector<poker::explorer::TemplateInfo> listed =
        poker::explorer::list_templates(resolved);
    CHECK(listed.size() == 1);
    CHECK(listed[0].id == "env-only");
#ifdef _WIN32
    _putenv_s("POKER_SOLVER_TEMPLATES", "");
#else
    unsetenv("POKER_SOLVER_TEMPLATES");
#endif
    std::filesystem::remove_all(root);
}

void test_repo_templates_parse()
{
    const std::filesystem::path candidates[] = {
        std::filesystem::path("configs") / "templates",
        std::filesystem::path("..") / "configs" / "templates",
        std::filesystem::path("..") / ".." / "configs" / "templates",
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
    const std::vector<poker::explorer::TemplateInfo> listed =
        poker::explorer::list_templates(root);
    CHECK(listed.size() >= 2);
    bool saw_flop = false;
    bool saw_turn = false;
    for (const poker::explorer::TemplateInfo& info : listed)
    {
        const std::optional<std::string> text =
            poker::explorer::read_template(root, info.id);
        CHECK(text.has_value());
        if (!text.has_value())
        {
            continue;
        }
        const poker::streets::StreetConfig config =
            poker::streets::parse_street_config(*text);
        if (info.id == "flop-check-down" || info.id == "flop-small-bet")
        {
            CHECK(config.board.size() == 3);
            saw_flop = true;
        }
        if (info.id == "turn-probe")
        {
            CHECK(config.board.size() == 4);
            saw_turn = true;
        }
    }
    CHECK(saw_flop);
    CHECK(saw_turn);
}

} // namespace

void run_template_tests()
{
    test_list_and_read();
    test_missing_and_traversal();
    test_resolve_env_override();
    test_repo_templates_parse();
}
