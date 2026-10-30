#include "harness.hpp"

#include "solver/strategy_report.hpp"

#include <stdexcept>
#include <string>
#include <vector>

namespace
{

bool throws_invalid(const auto& call)
{
    try
    {
        call();
    }
    catch (const std::invalid_argument&)
    {
        return true;
    }
    return false;
}

} // namespace

void run_strategy_report_tests()
{
    poker::solver::StrategyReport report;
    report.board = "Ah Kd 7c 4s";
    report.pot = 100;
    report.stack = 200;
    report.algorithm = "cfr_plus";
    report.iterations = 40;
    report.has_nash_gap = true;
    report.nash_gap = 1.25;
    report.weighting = "reach";
    report.root_player = 0;
    report.root_actions.push_back({"Check", 0.25});
    report.root_actions.push_back({"Bet100", 0.75});

    const std::string text = poker::solver::format_strategy_report(report);
    CHECK(text.find("strategy-report 1\n") == 0);
    CHECK(text.find("board Ah Kd 7c 4s\n") != std::string::npos);
    CHECK(text.find("pot 100\n") != std::string::npos);
    CHECK(text.find("stack 200\n") != std::string::npos);
    CHECK(text.find("algorithm cfr_plus\n") != std::string::npos);
    CHECK(text.find("iterations 40\n") != std::string::npos);
    CHECK(text.find("nash_gap 1.25\n") != std::string::npos);
    CHECK(text.find("weighting reach\n") != std::string::npos);
    CHECK(text.find("root-player 0\n") != std::string::npos);
    CHECK(text.find("root-action Check 0.25\n") != std::string::npos);
    CHECK(text.find("root-action Bet100 0.75\n") != std::string::npos);

    const poker::solver::StrategyReport parsed = poker::solver::parse_strategy_report(text);
    CHECK(parsed.board == report.board);
    CHECK(parsed.pot == report.pot);
    CHECK(parsed.stack == report.stack);
    CHECK(parsed.algorithm == report.algorithm);
    CHECK(parsed.iterations == report.iterations);
    CHECK(parsed.has_nash_gap);
    CHECK_NEAR(parsed.nash_gap, 1.25, 1e-12);
    CHECK(parsed.weighting == "reach");
    CHECK(parsed.root_player == 0);
    CHECK(parsed.root_actions.size() == 2);
    CHECK(parsed.root_actions[0].label == "Check");
    CHECK_NEAR(parsed.root_actions[0].probability, 0.25, 1e-12);
    CHECK(parsed.root_actions[1].label == "Bet100");
    CHECK_NEAR(parsed.root_actions[1].probability, 0.75, 1e-12);
    CHECK(poker::solver::format_strategy_report(parsed) == text);

    poker::solver::StrategyReport without_gap = report;
    without_gap.has_nash_gap = false;
    const std::string no_gap = poker::solver::format_strategy_report(without_gap);
    CHECK(no_gap.find("nash_gap") == std::string::npos);
    CHECK(poker::solver::parse_strategy_report(no_gap).has_nash_gap == false);

    CHECK(throws_invalid([] { poker::solver::parse_strategy_report("strategy-report 2\n"); }));
    CHECK(throws_invalid([] {
        poker::solver::parse_strategy_report("strategy-report 1\npot 100\n");
    }));
    CHECK(throws_invalid([] {
        poker::solver::parse_strategy_report(
            "strategy-report 1\n"
            "board Ah\npot 1\nstack 1\nalgorithm cfr_plus\niterations 1\n"
            "weighting reach\nroot-player 0\nunknown 1\n");
    }));

    const std::vector<std::string> labels = {"Check", "Bet"};
    const std::vector<double> reaches = {1.0, 3.0};
    const std::vector<std::vector<double>> strategies = {
        {1.0, 0.0},
        {0.0, 1.0},
    };
    const auto mixed = poker::solver::aggregate_reach_weighted(labels, reaches, strategies);
    CHECK(mixed.size() == 2);
    CHECK(mixed[0].label == "Check");
    CHECK_NEAR(mixed[0].probability, 0.25, 1e-12);
    CHECK(mixed[1].label == "Bet");
    CHECK_NEAR(mixed[1].probability, 0.75, 1e-12);

    const std::vector<std::string> infosets = {
        "OOP AhAd | open",
        "OOP AhAd | open",
        "OOP 5c5d | open",
        "OOP 5c5d | open",
        "IP KsKc | Check",
        "IP KsKc | Check",
    };
    const std::vector<std::string> open_actions = {
        "Check",
        "Bet100",
        "Check",
        "Bet100",
        "Fold",
        "Call",
    };
    const std::vector<double> open_probs = {0.0, 1.0, 0.5, 0.5, 0.25, 0.75};
    const auto open = poker::solver::aggregate_open_infosets_unweighted(
        infosets, open_actions, open_probs);
    CHECK(open.size() == 2);
    CHECK(open[0].label == "Check");
    CHECK_NEAR(open[0].probability, 0.25, 1e-12);
    CHECK(open[1].label == "Bet100");
    CHECK_NEAR(open[1].probability, 0.75, 1e-12);
}
