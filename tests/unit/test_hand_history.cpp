#include "harness.hpp"

#include "solver/hand_history.hpp"

#include <stdexcept>
#include <string>

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

void run_hand_history_tests()
{
    // Check-down to showdown with named hole cards.
    poker::solver::HandHistoryRecord check_down;
    check_down.board = "Ah Kd 7c 4s 2h";
    check_down.pot = 100;
    check_down.stack = 200;
    check_down.oop_hole = "AcAd";
    check_down.ip_hole = "KsKc";
    check_down.actions.push_back({0, "Check"});
    check_down.actions.push_back({1, "Check"});
    check_down.terminal_pot = 100;
    check_down.outcome = "showdown";
    check_down.p0_net = 50;

    const std::string check_text = poker::solver::format_hand_history(check_down);
    CHECK(check_text.find("hand-history 1\n") == 0);
    CHECK(check_text.find("board Ah Kd 7c 4s 2h\n") != std::string::npos);
    CHECK(check_text.find("pot 100\n") != std::string::npos);
    CHECK(check_text.find("stack 200\n") != std::string::npos);
    CHECK(check_text.find("oop-hole AcAd\n") != std::string::npos);
    CHECK(check_text.find("ip-hole KsKc\n") != std::string::npos);
    CHECK(check_text.find("action 0 Check\n") != std::string::npos);
    CHECK(check_text.find("action 1 Check\n") != std::string::npos);
    CHECK(check_text.find("terminal-pot 100\n") != std::string::npos);
    CHECK(check_text.find("outcome showdown\n") != std::string::npos);
    CHECK(check_text.find("p0-net 50\n") != std::string::npos);

    const poker::solver::HandHistoryRecord parsed_check =
        poker::solver::parse_hand_history(check_text);
    CHECK(parsed_check.board == check_down.board);
    CHECK(parsed_check.pot == 100);
    CHECK(parsed_check.stack == 200);
    CHECK(parsed_check.oop_hole == "AcAd");
    CHECK(parsed_check.ip_hole == "KsKc");
    CHECK(parsed_check.oop_label.empty());
    CHECK(parsed_check.ip_label.empty());
    CHECK(parsed_check.actions.size() == 2);
    CHECK(parsed_check.actions[0].player == 0);
    CHECK(parsed_check.actions[0].label == "Check");
    CHECK(parsed_check.actions[1].player == 1);
    CHECK(parsed_check.actions[1].label == "Check");
    CHECK(parsed_check.terminal_pot == 100);
    CHECK(parsed_check.outcome == "showdown");
    CHECK(parsed_check.p0_net == 50);
    CHECK(poker::solver::format_hand_history(parsed_check) == check_text);

    // Bet-fold line with range labels and no hole cards (ranges-only export).
    poker::solver::HandHistoryRecord bet_fold;
    bet_fold.board = "Ah Kd 7c 4s 2h";
    bet_fold.pot = 100;
    bet_fold.stack = 100;
    bet_fold.oop_label = "AcAd,5c5d";
    bet_fold.ip_label = "KsKc";
    bet_fold.actions.push_back({0, "Bet 100"});
    bet_fold.actions.push_back({1, "Fold"});
    bet_fold.terminal_pot = 200;
    bet_fold.outcome = "fold";
    bet_fold.p0_net = 50;

    const std::string fold_text = poker::solver::format_hand_history(bet_fold);
    CHECK(fold_text.find("hand-history 1\n") == 0);
    CHECK(fold_text.find("oop-hole") == std::string::npos);
    CHECK(fold_text.find("ip-hole") == std::string::npos);
    CHECK(fold_text.find("oop-label AcAd,5c5d\n") != std::string::npos);
    CHECK(fold_text.find("ip-label KsKc\n") != std::string::npos);
    CHECK(fold_text.find("action 0 Bet 100\n") != std::string::npos);
    CHECK(fold_text.find("action 1 Fold\n") != std::string::npos);
    CHECK(fold_text.find("terminal-pot 200\n") != std::string::npos);
    CHECK(fold_text.find("outcome fold\n") != std::string::npos);
    CHECK(fold_text.find("p0-net 50\n") != std::string::npos);

    const poker::solver::HandHistoryRecord parsed_fold =
        poker::solver::parse_hand_history(fold_text);
    CHECK(parsed_fold.oop_hole.empty());
    CHECK(parsed_fold.ip_hole.empty());
    CHECK(parsed_fold.oop_label == "AcAd,5c5d");
    CHECK(parsed_fold.ip_label == "KsKc");
    CHECK(parsed_fold.actions.size() == 2);
    CHECK(parsed_fold.actions[0].label == "Bet 100");
    CHECK(parsed_fold.actions[1].label == "Fold");
    CHECK(parsed_fold.outcome == "fold");
    CHECK(parsed_fold.p0_net == 50);
    CHECK(poker::solver::format_hand_history(parsed_fold) == fold_text);

    CHECK(throws_invalid([] { poker::solver::parse_hand_history("hand-history 2\n"); }));
    CHECK(throws_invalid([] {
        poker::solver::parse_hand_history("hand-history 1\npot 100\n");
    }));
    CHECK(throws_invalid([] {
        poker::solver::parse_hand_history(
            "hand-history 1\n"
            "board Ah\npot 1\nstack 1\nterminal-pot 1\noutcome showdown\np0-net 0\n"
            "unknown 1\n");
    }));
    CHECK(throws_invalid([] {
        poker::solver::HandHistoryRecord bad;
        bad.board = "Ah";
        bad.pot = 1;
        bad.stack = 1;
        bad.terminal_pot = 1;
        bad.outcome = "split";
        bad.p0_net = 0;
        (void)poker::solver::format_hand_history(bad);
    }));
}
