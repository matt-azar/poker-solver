#include "harness.hpp"

#include "poker/card.hpp"
#include "poker/hand_categories.hpp"
#include "poker/hand_eval.hpp"
#include "poker/range.hpp"
#include "solver/street_batch.hpp"
#include "solver/trainer.hpp"

#include <string>
#include <vector>

using poker::holdem::CategoryComposition;
using poker::holdem::DrawCategory;
using poker::holdem::DrawFlags;
using poker::holdem::HandCategory;
using poker::holdem::Range;
using poker::holdem::category_composition;
using poker::holdem::category_name;
using poker::holdem::classify_draws;
using poker::holdem::draw_category_name;
using poker::holdem::kCategoryModel;
using poker::holdem::kDrawCategoryModel;
using poker::holdem::made_hand_category;
using poker::solver::Algorithm;
using poker::solver::StreetBatchSolver;

namespace
{

int card(const char* text)
{
    return poker::holdem::parse_card(text);
}

std::vector<int> board5()
{
    return {card("Ah"), card("Kd"), card("7c"), card("4s"), card("2h")};
}

std::vector<int> flop_rainbow()
{
    return {card("Ah"), card("Kd"), card("7c")};
}

poker::streets::StreetConfig turn_config()
{
    poker::streets::StreetConfig config;
    config.board = {card("Ah"), card("Kd"), card("7c"), card("4s")};
    config.pot = 100;
    config.stack = 100;
    config.oop = Range::parse("AcAd");
    config.ip = Range::parse("KsKc");
    config.oop_bet_sizes = {0.5};
    config.ip_bet_sizes = {0.5};
    config.max_raises = 0;
    config.allow_all_in = false;
    config.memory_mib = 64;
    return config;
}

std::string chance_after_checks(StreetBatchSolver& solver)
{
    std::string node = solver.root_node_id();
    for (int step = 0; step < 8; ++step)
    {
        const poker::solver::StreetInspection view = solver.inspect_node(node);
        if (view.kind == "chance")
        {
            return node;
        }
        CHECK(view.kind == "decision");
        int check = -1;
        for (std::size_t index = 0; index < view.actions.size(); ++index)
        {
            if (view.actions[index].label.find("Check") == 0
                || view.actions[index].label.find("Call") == 0)
            {
                check = static_cast<int>(index);
            }
        }
        CHECK(check >= 0);
        node = view.actions[static_cast<std::size_t>(check)].child_id;
    }
    CHECK(false);
    return node;
}

// Independent flush-draw check: max suit count among holes+board is exactly 4.
bool independent_flush_draw(int hole0, int hole1, const std::vector<int>& board)
{
    int suits[4] = {};
    ++suits[poker::holdem::suit_of(hole0)];
    ++suits[poker::holdem::suit_of(hole1)];
    for (int board_card : board)
    {
        ++suits[poker::holdem::suit_of(board_card)];
    }
    int best = 0;
    for (int count : suits)
    {
        if (count > best)
        {
            best = count;
        }
    }
    return best == 4;
}

} // namespace

void run_hand_category_tests()
{
    const std::vector<int> board = board5();
    CHECK(made_hand_category(card("Ac"), card("Ad"), board) == HandCategory::ThreeOfAKind);
    CHECK(made_hand_category(card("Qc"), card("Qs"), board) == HandCategory::Pair);
    CHECK(category_name(HandCategory::ThreeOfAKind) == "three of a kind");

    const CategoryComposition empty_board = category_composition(
        std::vector<int>{},
        Range::parse("AcAd"),
        Range::parse("QcQs"));
    CHECK(!empty_board.available);
    CHECK(empty_board.reason.find("flop") != std::string::npos);

    // Quads vs trips on Ah Ad 7c 4s 2h.
    const std::vector<int> quads_board = {
        card("Ah"), card("Ad"), card("7c"), card("4s"), card("2h")};
    const CategoryComposition report = category_composition(
        quads_board,
        Range::parse("AsAc"),
        Range::parse("7d7s"));
    CHECK(report.available);
    CHECK(report.model == kCategoryModel);
    CHECK(report.exclusive);
    CHECK(report.player0.defined);
    CHECK(report.player1.defined);
    CHECK_NEAR(report.player0.fraction[static_cast<std::size_t>(HandCategory::FourOfAKind)], 1.0, 1e-12);
    // 7d7s on Ah Ad 7c is sevens full of aces.
    CHECK_NEAR(report.player1.fraction[static_cast<std::size_t>(HandCategory::FullHouse)], 1.0, 1e-12);

    // Weighted mix: trips weight 1, pair weight 3.
    const CategoryComposition weighted = category_composition(
        board,
        Range::parse("AcAd:1,QcQs:3"),
        Range::parse("2c3d"));
    CHECK(weighted.available);
    CHECK(weighted.player0.defined);
    CHECK_NEAR(weighted.player0.total_mass, 4.0, 1e-12);
    CHECK_NEAR(
        weighted.player0.fraction[static_cast<std::size_t>(HandCategory::ThreeOfAKind)],
        0.25,
        1e-12);
    CHECK_NEAR(
        weighted.player0.fraction[static_cast<std::size_t>(HandCategory::Pair)],
        0.75,
        1e-12);

    const std::string json = poker::holdem::category_composition_json(report, 0.0);
    CHECK(json.find("\"kind\":\"categories\"") != std::string::npos);
    CHECK(json.find("\"model\":\"made-hand\"") != std::string::npos);
    CHECK(json.find("\"exclusive\":true") != std::string::npos);
    CHECK(json.find("\"available\":true") != std::string::npos);

    // --- Draw / backdoor classification (independent checks) ---
    CHECK(draw_category_name(DrawCategory::FlushDraw) == "flush draw");
    CHECK(draw_category_name(DrawCategory::Oesd) == "oesd");

    const std::vector<int> flop = flop_rainbow();
    // Qh Jh on Ah Kd 7c: three hearts → backdoor flush; ranks A,K,Q,J → gutshot to T.
    const DrawFlags qj_hearts = classify_draws(card("Qh"), card("Jh"), flop);
    CHECK(!qj_hearts.flush_draw);
    CHECK(qj_hearts.backdoor_flush);
    CHECK(!qj_hearts.oesd);
    CHECK(qj_hearts.gutshot);
    CHECK(independent_flush_draw(card("Qh"), card("Jh"), flop) == qj_hearts.flush_draw);

    // 9h 8h on Ah Kd 7c: four hearts? Ah + 9h 8h = 3 hearts → backdoor flush.
    // Ranks A,K,9,8,7 → windows: 9,8,7 need 6+T or 5+6 etc. Completing one-card:
    // window 5-9: have 7,8,9 missing 5,6 → backdoor; window 6-T: have 7,8,9 missing 6,T.
    // window 7-J: have 7,8,9 missing T,J. No 4-of-5 → no gutshot/oesd; backdoor straight yes.
    const DrawFlags ninety_eight_hearts = classify_draws(card("9h"), card("8h"), flop);
    CHECK(!ninety_eight_hearts.flush_draw);
    CHECK(ninety_eight_hearts.backdoor_flush);
    CHECK(!ninety_eight_hearts.oesd);
    CHECK(!ninety_eight_hearts.gutshot);
    CHECK(ninety_eight_hearts.backdoor_straight);

    // Th 9h on Ah Kh 7c (two hearts on board): Th 9h + Ah Kh = 4 hearts → flush draw.
    const std::vector<int> flop_two_hearts = {card("Ah"), card("Kh"), card("7c")};
    const DrawFlags flush_draw_hand = classify_draws(card("Th"), card("9h"), flop_two_hearts);
    CHECK(flush_draw_hand.flush_draw);
    CHECK(!flush_draw_hand.backdoor_flush);
    CHECK(independent_flush_draw(card("Th"), card("9h"), flop_two_hearts));

    // Jc Tc on Ah Kd 7c: ranks A,K,J,T,7 → gutshot to Q (AKQJT).
    const DrawFlags jt = classify_draws(card("Jc"), card("Tc"), flop);
    CHECK(jt.gutshot);
    CHECK(!jt.oesd);

    // 9c 8d on 7h 6s 2c: ranks 9,8,7,6,2 → OESD (5 or T).
    const std::vector<int> connected_flop = {card("7h"), card("6s"), card("2c")};
    const DrawFlags oesd_hand = classify_draws(card("9c"), card("8d"), connected_flop);
    CHECK(oesd_hand.oesd);
    CHECK(!oesd_hand.gutshot);

    // Turn: backdoors are off; flush draw still on.
    const std::vector<int> turn_two_hearts = {
        card("Ah"), card("Kh"), card("7c"), card("2d")};
    const DrawFlags turn_fd = classify_draws(card("Th"), card("9h"), turn_two_hearts);
    CHECK(turn_fd.flush_draw);
    CHECK(!turn_fd.backdoor_flush);
    CHECK(!turn_fd.backdoor_straight);

    // Weighted draw composition: FD hand weight 1, air weight 1.
    const CategoryComposition draws = category_composition(
        flop_two_hearts,
        Range::parse("Th9h:1,2c3d:1"),
        Range::parse("QcQd"));
    CHECK(draws.available);
    CHECK(draws.model == kDrawCategoryModel);
    CHECK(!draws.exclusive);
    CHECK(draws.categories.size() == 5);
    CHECK(draws.player0.defined);
    CHECK_NEAR(draws.player0.total_mass, 2.0, 1e-12);
    CHECK_NEAR(
        draws.player0.fraction[static_cast<std::size_t>(DrawCategory::FlushDraw)],
        0.5,
        1e-12);
    // Multi-label: flush-draw fraction + others need not sum to 1.
    double draw_fraction_sum = 0.0;
    for (double value : draws.player0.fraction)
    {
        draw_fraction_sum += value;
    }
    CHECK(draw_fraction_sum + 1e-12 >= 0.5);

    const std::string draw_json = poker::holdem::category_composition_json(draws, 0.0);
    CHECK(draw_json.find("\"model\":\"draws\"") != std::string::npos);
    CHECK(draw_json.find("\"exclusive\":false") != std::string::npos);
    CHECK(draw_json.find("flush draw") != std::string::npos);

    // Independent enumeration of flush-draw mass on a tiny weighted range.
    {
        const Range tiny = Range::parse("Th9h:2,9c8d:1,2c3d:1");
        double fd_mass = 0.0;
        double total = 0.0;
        for (int index = 0; index < poker::holdem::kComboCount; ++index)
        {
            const double weight = tiny.weight(index);
            if (!(weight > 0.0))
            {
                continue;
            }
            int c0 = 0;
            int c1 = 0;
            Range::combo_cards(index, c0, c1);
            if (c0 == card("Ah") || c0 == card("Kh") || c0 == card("7c")
                || c1 == card("Ah") || c1 == card("Kh") || c1 == card("7c"))
            {
                continue;
            }
            total += weight;
            if (independent_flush_draw(c0, c1, flop_two_hearts))
            {
                fd_mass += weight;
            }
        }
        const CategoryComposition check = category_composition(
            flop_two_hearts, tiny, Range::parse("QcQd"));
        CHECK_NEAR(check.player0.total_mass, total, 1e-12);
        CHECK_NEAR(
            check.player0.mass[static_cast<std::size_t>(DrawCategory::FlushDraw)],
            fd_mass,
            1e-12);
        CHECK_NEAR(
            check.player0.fraction[static_cast<std::size_t>(DrawCategory::FlushDraw)],
            fd_mass / total,
            1e-12);
    }

    StreetBatchSolver turn(turn_config());
    turn.continue_iterations(1, Algorithm::CfrPlus);
    // StreetBatchSolver still gates made-hand-only; holdem helper reports draws.
    const CategoryComposition batch_turn = turn.category_composition(turn.root_node_id());
    CHECK(!batch_turn.available);
    const CategoryComposition helper_turn = category_composition(
        turn_config().board,
        turn_config().oop,
        turn_config().ip);
    CHECK(helper_turn.available);
    CHECK(helper_turn.model == kDrawCategoryModel);

    const std::string chance = chance_after_checks(turn);
    const poker::solver::StreetRunoutValues runout = turn.runout_values(chance, nullptr);
    CHECK(!runout.cards.empty());
    const CategoryComposition dealt = turn.category_composition(runout.cards.front().child_id);
    CHECK(dealt.available);
    CHECK(dealt.board.size() == 5);
    CHECK(dealt.model == kCategoryModel);
    CHECK(dealt.player0.defined);
    CHECK(dealt.player1.defined);
}
