#include "harness.hpp"

#include "poker/card.hpp"
#include "poker/hand_eval.hpp"
#include "poker/range.hpp"

#include <chrono>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

using namespace poker::holdem;

namespace
{

int card(const char* text)
{
    return parse_card(text);
}

int nonzero_count(const Range& range)
{
    int count = 0;
    for (int index = 0; index < kComboCount; ++index)
    {
        if (range.weight(index) > 0.0)
        {
            ++count;
        }
    }
    return count;
}

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

HandValue value_of(std::initializer_list<const char*> names)
{
    std::vector<int> cards;
    for (const char* name : names)
    {
        cards.push_back(card(name));
    }
    return evaluate(cards);
}

} // namespace

void run_holdem_tests()
{
    CHECK(kDeckSize == 52);
    CHECK(kComboCount == 1326);
    CHECK(make_card(12, 2) == card("Ah"));
    CHECK(rank_of(card("Ah")) == 12);
    CHECK(suit_of(card("Ah")) == 2);
    CHECK(card("10h") == card("Th"));
    CHECK(card("td") == card("Td"));
    CHECK(format_card(card("As")) == "As");

    for (int id = 0; id < kDeckSize; ++id)
    {
        CHECK(parse_card(format_card(id)) == id);
    }
    CHECK(throws_invalid([] { parse_card("Ax"); }));
    CHECK(throws_invalid([] { parse_card("A"); }));

    int duplicate_board[] = {card("Ah"), card("Kd"), card("Ah")};
    CHECK(throws_invalid([&] { validate_board(duplicate_board, 3); }));
    int short_board[] = {card("Ah"), card("Kd")};
    CHECK(throws_invalid([&] { validate_board(short_board, 2); }));
    int flop[] = {card("Ah"), card("Kd"), card("Qs")};
    validate_board(flop, 3);
    CHECK(throws_invalid([&] { validate_private(card("Ah"), card("2c"), flop, 3); }));
    CHECK(throws_invalid([&] { validate_private(card("2c"), card("2c"), flop, 3); }));
    validate_private(card("2c"), card("3d"), flop, 3);

    Deck deck;
    CHECK(deck.count() == 52);
    deck.remove(card("Ah"));
    deck.remove(card("Kd"));
    CHECK(deck.count() == 50);
    CHECK(!deck.contains(card("Ah")));
    CHECK(deck.cards().size() == 50);
    CHECK(throws_invalid([&] { deck.remove(card("Ah")); }));

    const HandValue wheel = value_of({"Ah", "2c", "3d", "4h", "5s"});
    const HandValue six_high = value_of({"2c", "3d", "4h", "5s", "6c"});
    const HandValue broadway = value_of({"Ac", "Kd", "Qh", "Js", "Tc"});
    const HandValue not_straight = value_of({"Ah", "Kd", "2c", "3d", "4s"});
    CHECK(wheel.category == HandCategory::Straight);
    CHECK(wheel.tiebreak[0] == 3);
    CHECK(six_high.tiebreak[0] == 4);
    CHECK(compare_values(six_high, wheel) > 0);
    CHECK(compare_values(broadway, six_high) > 0);
    CHECK(not_straight.category == HandCategory::HighCard);

    const HandValue royal = value_of({"Ah", "Kh", "Qh", "Jh", "Th"});
    const HandValue steel_wheel = value_of({"Ah", "2h", "3h", "4h", "5h"});
    CHECK(royal.category == HandCategory::StraightFlush);
    CHECK(royal.tiebreak[0] == 12);
    CHECK(steel_wheel.category == HandCategory::StraightFlush);
    CHECK(steel_wheel.tiebreak[0] == 3);
    CHECK(compare_values(royal, steel_wheel) > 0);
    CHECK(category_name(HandCategory::StraightFlush) == "straight flush");

    const HandValue flush = value_of({"Ah", "Kh", "Qh", "Jh", "9h"});
    const HandValue weaker_flush = value_of({"Ah", "Kh", "Qh", "Jh", "8h"});
    CHECK(flush.category == HandCategory::Flush);
    CHECK(compare_values(flush, broadway) > 0);
    CHECK(compare_values(flush, weaker_flush) > 0);

    const HandValue aces_full = value_of({"Ah", "Ad", "Ac", "Kh", "Kd"});
    const HandValue kings_full = value_of({"Kh", "Kd", "Kc", "Ah", "Ad"});
    CHECK(aces_full.category == HandCategory::FullHouse);
    CHECK(compare_values(aces_full, kings_full) > 0);
    CHECK(compare_values(aces_full, flush) > 0);

    const HandValue quads = value_of({"Ah", "Ad", "Ac", "As", "Kh"});
    CHECK(quads.category == HandCategory::FourOfAKind);
    CHECK(quads.tiebreak[0] == 12);
    CHECK(quads.tiebreak[1] == 11);
    CHECK(compare_values(quads, aces_full) > 0);

    const HandValue trips = value_of({"Ah", "Ad", "Ac", "Kh", "Qs"});
    const HandValue two_pair = value_of({"Ah", "Ad", "Kh", "Kd", "2c"});
    const HandValue two_pair_better_kicker = value_of({"Ah", "Ad", "Kh", "Kd", "3c"});
    const HandValue pair = value_of({"Ah", "Ad", "Qh", "Jh", "Tc"});
    CHECK(trips.category == HandCategory::ThreeOfAKind);
    CHECK(two_pair.category == HandCategory::TwoPair);
    CHECK(pair.category == HandCategory::Pair);
    CHECK(compare_values(two_pair, pair) > 0);
    CHECK(compare_values(trips, two_pair) > 0);
    CHECK(compare_values(two_pair_better_kicker, two_pair) > 0);
    CHECK(compare_values(wheel, trips) > 0);

    std::vector<int> seven = {
        card("Ah"), card("Kh"), card("Qh"), card("Jh"), card("Th"), card("2c"), card("3d")};
    CHECK(evaluate(seven) == royal);
    std::vector<int> board_straight = {card("2c"), card("3d"), card("4h"), card("5s"), card("6c")};
    std::vector<int> higher_straight = board_straight;
    higher_straight.push_back(card("7c"));
    higher_straight.push_back(card("8d"));
    CHECK(compare_values(evaluate(higher_straight), evaluate(board_straight)) > 0);

    int paired_board[] = {card("Ac"), card("Ad"), card("Ah"), card("As"), card("Kc")};
    CHECK(compare_showdown(card("2c"), card("3d"), card("4c"), card("5d"), paired_board) == 0);
    int royal_board[] = {card("Ah"), card("Kh"), card("Qh"), card("Jh"), card("Th")};
    CHECK(compare_showdown(card("2c"), card("3d"), card("4c"), card("5d"), royal_board) == 0);
    int dry_board[] = {card("2c"), card("5d"), card("8h"), card("Jh"), card("Kc")};
    CHECK(compare_showdown(card("Ac"), card("Qd"), card("3c"), card("4s"), dry_board) > 0);

    CHECK(throws_invalid([] { evaluate(std::vector<int>{card("Ah"), card("Ah"), card("Kd"), card("Qc"), card("Js")}); }));

    for (int low = 0; low < kDeckSize; ++low)
    {
        for (int high = low + 1; high < kDeckSize; ++high)
        {
            int recovered0 = -1;
            int recovered1 = -1;
            const int index = Range::combo_index(low, high);
            Range::combo_cards(index, recovered0, recovered1);
            CHECK(recovered0 == low);
            CHECK(recovered1 == high);
            CHECK(Range::combo_index(high, low) == index);
        }
    }
    CHECK(Range::combo_text(Range::combo_index(card("Kd"), card("Ah"))) == "AhKd");

    CHECK(nonzero_count(Range::parse("AA")) == 6);
    CHECK(nonzero_count(Range::parse("AKs")) == 4);
    CHECK(nonzero_count(Range::parse("AKo")) == 12);
    CHECK(nonzero_count(Range::parse("AK")) == 16);
    CHECK(nonzero_count(Range::parse("QQ+")) == 18);
    CHECK(nonzero_count(Range::parse("22-77")) == 36);
    CHECK(nonzero_count(Range::parse("A5s-A2s")) == 16);
    CHECK(nonzero_count(Range::parse("ATs+")) == 16);
    CHECK(nonzero_count(Range::parse("random")) == 1326);
    CHECK(Range::parse("AA").total() == 6.0);
    CHECK_NEAR(Range::parse("AhKh:0.5,AsKs:1.5").total(), 2.0, 1e-12);
    CHECK_NEAR(Range::parse("AA,AhAd:2").weight_of(card("Ah"), card("Ad")), 2.0, 1e-12);
    CHECK_NEAR(Range::parse("AA,AhAd:2").weight_of(card("Ac"), card("As")), 1.0, 1e-12);
    CHECK(Range::parse("").total() == 0.0);
    Range zeros;
    zeros.normalize();
    CHECK(zeros.total() == 0.0);

    Range uniform = Range::parse("*");
    uniform.normalize();
    CHECK_NEAR(uniform.total(), 1.0, 1e-12);
    CHECK_NEAR(uniform.weight(0), 1.0 / 1326.0, 1e-12);

    Range aces = Range::parse("AA");
    const int dead_ace[] = {card("Ah")};
    Range live_aces = aces.conditioned(dead_ace, 1);
    CHECK(nonzero_count(live_aces) == 3);
    CHECK_NEAR(live_aces.total(), 1.0, 1e-12);
    CHECK_NEAR(live_aces.weight_of(card("Ac"), card("Ad")), 1.0 / 3.0, 1e-12);
    CHECK(live_aces.weight_of(card("Ah"), card("Ad")) == 0.0);

    const Range left = Range::parse("AhKh:2,2c3d:1");
    const Range right = Range::parse("4c5d");
    const auto weighted = joint_distribution(left, right, nullptr, 0);
    CHECK(weighted.size() == 2);
    double heavy = 0.0;
    double light = 0.0;
    for (const HandPairProbability& row : weighted)
    {
        if (row.combo0 == Range::combo_index(card("Ah"), card("Kh")))
        {
            heavy = row.probability;
        }
        else
        {
            light = row.probability;
        }
    }
    CHECK_NEAR(heavy, 2.0 / 3.0, 1e-12);
    CHECK_NEAR(light, 1.0 / 3.0, 1e-12);

    const Range suited_broadway = Range::parse("AhKh,AdKd");
    const Range other_broadway = Range::parse("AsKs,AhKd");
    const auto blocked = joint_distribution(suited_broadway, other_broadway, nullptr, 0);
    CHECK(blocked.size() == 2);
    CHECK_NEAR(blocked[0].probability, 0.5, 1e-12);
    CHECK_NEAR(blocked[1].probability, 0.5, 1e-12);

    int ace_board[] = {card("Ah"), card("Kd"), card("Qs")};
    const auto board_blocked = joint_distribution(left, right, ace_board, 3);
    CHECK(board_blocked.size() == 1);
    CHECK(board_blocked[0].combo0 == Range::combo_index(card("2c"), card("3d")));
    CHECK_NEAR(board_blocked[0].probability, 1.0, 1e-12);

    Range everyone = Range::parse("random");
    CHECK_NEAR(joint_mass(everyone, everyone, nullptr, 0), 1326.0 * 1225.0, 1e-6);
    int three_board[] = {0, 1, 2};
    CHECK_NEAR(joint_mass(everyone, everyone, three_board, 3), 1176.0 * 1081.0, 1e-6);

    const Range round_trip = Range::from_json(Range::parse("AhKd:0.25,2c2d:1").to_json());
    CHECK_NEAR(round_trip.weight_of(card("Ah"), card("Kd")), 0.25, 1e-12);
    CHECK_NEAR(round_trip.weight_of(card("2c"), card("2d")), 1.0, 1e-12);
    CHECK(round_trip.total() == Range::parse("AhKd:0.25,2c2d:1").total());
    CHECK(throws_invalid([] { Range::parse("AA:-1"); }));
    CHECK(throws_invalid([] { Range::parse("AKs-KQs"); }));

    const auto started = std::chrono::steady_clock::now();
    int evaluated = 0;
    int order_mismatches = 0;
    for (int a = 0; a < kDeckSize; ++a)
    {
        for (int b = a + 1; b < kDeckSize; ++b)
        {
            for (int c = b + 1; c < kDeckSize; ++c)
            {
                for (int d = c + 1; d < kDeckSize; ++d)
                {
                    for (int e = d + 1; e < kDeckSize; ++e)
                    {
                        const int cards[] = {a, b, c, d, e};
                        const HandValue first = evaluate(cards);
                        const int shuffled[] = {e, c, a, d, b};
                        if (!(evaluate(shuffled) == first))
                        {
                            ++order_mismatches;
                        }
                        ++evaluated;
                    }
                }
            }
        }
    }
    const double seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
    std::cout << "holdem_five_card_hands=" << evaluated << " seconds=" << seconds << "\n";
    CHECK(evaluated == 2598960);
    CHECK(order_mismatches == 0);
}
