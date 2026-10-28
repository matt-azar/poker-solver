#include "poker/card.hpp"
#include "poker/equity.hpp"
#include "poker/hand_eval.hpp"

#include <array>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <random>
#include <string>
#include <vector>

namespace
{

int g_failures = 0;
int g_passed = 0;

void check(bool condition, const char* text, int line)
{
    if (!condition)
    {
        std::cerr << "FAIL " << line << " " << text << "\n";
        ++g_failures;
    }
    else
    {
        ++g_passed;
    }
}

#define CHECK(condition) check(static_cast<bool>(condition), #condition, __LINE__)

bool near(double left, double right, double tolerance)
{
    return std::abs(left - right) <= tolerance;
}

#define CHECK_NEAR(left, right, tolerance) CHECK(near((left), (right), (tolerance)))

using poker::holdem::ComboShowdown;
using poker::holdem::EquityError;
using poker::holdem::EquityFailure;
using poker::holdem::Range;
using poker::holdem::ShowdownEquity;
using poker::holdem::ShowdownEquityOptions;
using poker::holdem::kComboCount;
using poker::holdem::kDeckSize;
using poker::holdem::parse_equity_board;
using poker::holdem::parse_equity_range;
using poker::holdem::showdown_equity;
using poker::holdem::showdown_equity_json;

const ComboShowdown* find_combo(const std::vector<ComboShowdown>& rows, int index)
{
    for (const ComboShowdown& row : rows)
    {
        if (row.index == index)
        {
            return &row;
        }
    }
    return nullptr;
}

int combo_of(const char* text)
{
    const Range range = Range::parse(text);
    for (int index = 0; index < kComboCount; ++index)
    {
        if (range.weight(index) > 0.0)
        {
            return index;
        }
    }
    return -1;
}

template <typename Function>
EquityError expect_failure(EquityFailure failure, Function function)
{
    try
    {
        function();
    }
    catch (const EquityError& error)
    {
        CHECK(error.failure() == failure);
        return error;
    }
    CHECK(false);
    return EquityError(failure, "missing equity error");
}

struct ReferenceCombo
{
    bool defined = false;
    long double mass = 0.0;
    long double win = 0.0;
    long double tie = 0.0;
    long double loss = 0.0;
    long double equity = 0.0;
    long double marginal = 0.0;
    double weight = 0.0;
};

struct ReferenceResult
{
    bool joint_defined = false;
    ReferenceCombo player0[1326];
    ReferenceCombo player1[1326];
    long double equity0 = 0.0;
    long double equity1 = 0.0;
};

ReferenceResult reference_equity(
    const std::vector<int>& board,
    const Range& player0,
    const Range& player1)
{
    const int board_count = static_cast<int>(board.size());
    std::uint64_t dead_board = 0;
    for (int card : board)
    {
        dead_board |= std::uint64_t{1} << card;
    }

    ReferenceResult result;
    for (int hero = kComboCount - 1; hero >= 0; --hero)
    {
        const double hero_weight = player0.weight(hero);
        if (!(hero_weight > 0.0))
        {
            continue;
        }
        int hero0 = 0;
        int hero1 = 0;
        Range::combo_cards(hero, hero0, hero1);
        const bool hero_blocked = (dead_board & ((std::uint64_t{1} << hero0) | (std::uint64_t{1} << hero1))) != 0;
        result.player0[hero].weight = hero_weight;
        if (hero_blocked)
        {
            continue;
        }
        for (int villain = kComboCount - 1; villain >= 0; --villain)
        {
            const double villain_weight = player1.weight(villain);
            if (!(villain_weight > 0.0))
            {
                continue;
            }
            int villain0 = 0;
            int villain1 = 0;
            Range::combo_cards(villain, villain0, villain1);
            if ((dead_board & ((std::uint64_t{1} << villain0) | (std::uint64_t{1} << villain1))) != 0)
            {
                continue;
            }
            if (hero0 == villain0 || hero0 == villain1 || hero1 == villain0 || hero1 == villain1)
            {
                continue;
            }

            std::vector<int> outcomes;
            std::uint64_t dead = dead_board | (std::uint64_t{1} << hero0) | (std::uint64_t{1} << hero1)
                | (std::uint64_t{1} << villain0) | (std::uint64_t{1} << villain1);
            std::vector<int> available;
            for (int card = kDeckSize - 1; card >= 0; --card)
            {
                if ((dead & (std::uint64_t{1} << card)) == 0)
                {
                    available.push_back(card);
                }
            }
            std::vector<int> full(5);
            for (int i = 0; i < board_count; ++i)
            {
                full[static_cast<std::size_t>(i)] = board[static_cast<std::size_t>(i)];
            }
            if (board_count == 5)
            {
                outcomes.push_back(poker::holdem::compare_showdown(
                    hero0, hero1, villain0, villain1, full));
            }
            else if (board_count == 4)
            {
                for (int river : available)
                {
                    full[4] = river;
                    outcomes.push_back(poker::holdem::compare_showdown(
                        hero0, hero1, villain0, villain1, full));
                }
            }
            else
            {
                for (std::size_t i = 0; i < available.size(); ++i)
                {
                    for (std::size_t j = i + 1; j < available.size(); ++j)
                    {
                        full[3] = available[i];
                        full[4] = available[j];
                        outcomes.push_back(poker::holdem::compare_showdown(
                            hero0, hero1, villain0, villain1, full));
                    }
                }
            }

            int wins = 0;
            int ties = 0;
            int losses = 0;
            for (int outcome : outcomes)
            {
                if (outcome > 0)
                {
                    ++wins;
                }
                else if (outcome < 0)
                {
                    ++losses;
                }
                else
                {
                    ++ties;
                }
            }
            const int total = static_cast<int>(outcomes.size());
            CHECK(total == (board_count == 5 ? 1 : board_count == 4 ? 44 : 990));
            const long double inv = 1.0L / static_cast<long double>(total);
            const long double win = static_cast<long double>(wins) * inv;
            const long double tie = static_cast<long double>(ties) * inv;
            const long double loss = static_cast<long double>(losses) * inv;
            const long double equity = (static_cast<long double>(wins) + 0.5L * static_cast<long double>(ties)) * inv;
            result.player0[hero].mass += villain_weight;
            result.player0[hero].win += villain_weight * win;
            result.player0[hero].tie += villain_weight * tie;
            result.player0[hero].loss += villain_weight * loss;
            result.player0[hero].equity += villain_weight * equity;
            result.player1[villain].weight = villain_weight;
            result.player1[villain].mass += hero_weight;
            result.player1[villain].win += hero_weight * loss;
            result.player1[villain].tie += hero_weight * tie;
            result.player1[villain].loss += hero_weight * win;
            result.player1[villain].equity += hero_weight * ((static_cast<long double>(losses) + 0.5L * static_cast<long double>(ties)) * inv);
        }
    }

    long double z0 = 0.0L;
    long double z1 = 0.0L;
    for (int index = 0; index < kComboCount; ++index)
    {
        if (result.player0[index].mass > 0.0L)
        {
            result.player0[index].defined = true;
            result.player0[index].win /= result.player0[index].mass;
            result.player0[index].tie /= result.player0[index].mass;
            result.player0[index].loss /= result.player0[index].mass;
            result.player0[index].equity /= result.player0[index].mass;
            z0 += result.player0[index].weight * result.player0[index].mass;
        }
        if (player1.weight(index) > 0.0)
        {
            result.player1[index].weight = player1.weight(index);
        }
        if (result.player1[index].mass > 0.0L)
        {
            result.player1[index].defined = true;
            result.player1[index].win /= result.player1[index].mass;
            result.player1[index].tie /= result.player1[index].mass;
            result.player1[index].loss /= result.player1[index].mass;
            result.player1[index].equity /= result.player1[index].mass;
            z1 += result.player1[index].weight * result.player1[index].mass;
        }
    }
    if (z0 > 0.0L && z1 > 0.0L)
    {
        result.joint_defined = true;
        for (int index = 0; index < kComboCount; ++index)
        {
            if (result.player0[index].defined)
            {
                result.player0[index].marginal = (result.player0[index].weight * result.player0[index].mass) / z0;
                result.equity0 += result.player0[index].marginal * result.player0[index].equity;
            }
            if (result.player1[index].defined)
            {
                result.player1[index].marginal = (result.player1[index].weight * result.player1[index].mass) / z1;
                result.equity1 += result.player1[index].marginal * result.player1[index].equity;
            }
        }
    }
    return result;
}

void expect_matches(const ShowdownEquity& actual, const ReferenceResult& expected, double tolerance)
{
    CHECK(actual.joint_defined == expected.joint_defined);
    CHECK_NEAR(actual.player0.equity, static_cast<double>(expected.equity0), tolerance);
    CHECK_NEAR(actual.player1.equity, static_cast<double>(expected.equity1), tolerance);
    const std::vector<ComboShowdown>* rows[2] = {&actual.player0.combos, &actual.player1.combos};
    const ReferenceCombo* reference[2] = {expected.player0, expected.player1};
    for (int player = 0; player < 2; ++player)
    {
        for (const ComboShowdown& row : *rows[player])
        {
            const ReferenceCombo& item = reference[player][row.index];
            CHECK(row.defined == item.defined);
            if (!row.defined)
            {
                continue;
            }
            CHECK_NEAR(row.win, static_cast<double>(item.win), tolerance);
            CHECK_NEAR(row.tie, static_cast<double>(item.tie), tolerance);
            CHECK_NEAR(row.loss, static_cast<double>(item.loss), tolerance);
            CHECK_NEAR(row.equity, static_cast<double>(item.equity), tolerance);
            CHECK_NEAR(row.marginal, static_cast<double>(item.marginal), tolerance);
            CHECK_NEAR(row.compatible_mass, static_cast<double>(item.mass), tolerance);
        }
    }
}

std::array<double, 1326> copy_weights(const Range& range)
{
    return range.weights();
}

void test_river_certainty_and_royal_tie()
{
    const std::vector<int> board = parse_equity_board("Kh Kd 7c 4s 2h");
    const Range oop = parse_equity_range("AhAd");
    const Range ip = parse_equity_range("2c3d");
    const ShowdownEquity equity = showdown_equity(board, oop, ip);
    CHECK(equity.joint_defined);
    CHECK(equity.work.legal_pairs == 1);
    CHECK(equity.work.completions_per_pair == 1);
    CHECK(equity.work.pair_runouts == 1);
    CHECK(equity.player0.equity == 1.0);
    CHECK(equity.player0.win == 1.0);
    CHECK(equity.player0.loss == 0.0);
    CHECK(equity.player1.equity == 0.0);
    CHECK(equity.player1.win == 0.0);
    CHECK(equity.player1.loss == 1.0);
    const ComboShowdown* aces = find_combo(equity.player0.combos, combo_of("AhAd"));
    const ComboShowdown* air = find_combo(equity.player1.combos, combo_of("2c3d"));
    CHECK(aces != nullptr && aces->defined && aces->equity == 1.0 && aces->win == 1.0);
    CHECK(air != nullptr && air->defined && air->equity == 0.0 && air->loss == 1.0);

    const std::vector<int> royal = parse_equity_board("Ah Kh Qh Jh Th");
    const ShowdownEquity tied = showdown_equity(royal, parse_equity_range("2c2d"), parse_equity_range("3c3d"));
    CHECK(tied.joint_defined);
    CHECK(tied.player0.win == 0.0);
    CHECK(tied.player0.tie == 1.0);
    CHECK(tied.player0.equity == 0.5);
    CHECK(tied.player1.win == 0.0);
    CHECK(tied.player1.tie == 1.0);
    CHECK(tied.player1.equity == 0.5);
    CHECK_NEAR(tied.player0.equity + tied.player1.equity, 1.0, 0.0);
}

void test_completion_counts_and_blockers()
{
    const std::vector<int> flop = parse_equity_board("Ah Kd 7c");
    const ShowdownEquity flop_equity = showdown_equity(
        flop, parse_equity_range("2c2d"), parse_equity_range("9c9d,AhAs"));
    CHECK(flop_equity.work.legal_pairs == 1);
    CHECK(flop_equity.work.completions_per_pair == 990);
    CHECK(flop_equity.work.pair_runouts == 990);
    const ComboShowdown* blocked = find_combo(flop_equity.player1.combos, combo_of("AhAs"));
    CHECK(blocked != nullptr && !blocked->defined);
    const ComboShowdown* nines = find_combo(flop_equity.player1.combos, combo_of("9c9d"));
    CHECK(nines != nullptr && nines->defined);

    const std::vector<int> turn = parse_equity_board("Ah Kd 7c 2s");
    const ShowdownEquity turn_equity = showdown_equity(
        turn, parse_equity_range("3c3d"), parse_equity_range("9c9d"));
    CHECK(turn_equity.work.legal_pairs == 1);
    CHECK(turn_equity.work.completions_per_pair == 44);
    CHECK(turn_equity.work.pair_runouts == 44);

    const std::vector<int> river = parse_equity_board("Qc Jd 2c 8h 5s");
    const ShowdownEquity overlap = showdown_equity(
        river, parse_equity_range("AhAd"), parse_equity_range("AhAc,9c9d"));
    CHECK(overlap.work.legal_pairs == 1);
    CHECK(overlap.work.pair_runouts == 1);
    const ComboShowdown* suited = find_combo(overlap.player1.combos, combo_of("AhAc"));
    CHECK(suited != nullptr && !suited->defined);
    expect_matches(flop_equity, reference_equity(flop, parse_equity_range("2c2d"), parse_equity_range("9c9d,AhAs")), 1e-12);
    expect_matches(turn_equity, reference_equity(turn, parse_equity_range("3c3d"), parse_equity_range("9c9d")), 1e-12);
}

void test_asymmetric_oracle()
{
    const std::vector<int> board = parse_equity_board("Ah Kd 7c");
    const Range oop = parse_equity_range("2c2d:1,3c3d:2,QcQd:0.5");
    const Range ip = parse_equity_range("9c9d:0.25,8c8d:4,2h2s:1e-6");
    ShowdownEquityOptions options;
    options.max_pair_runouts = 100000;
    const ShowdownEquity equity = showdown_equity(board, oop, ip, options);
    expect_matches(equity, reference_equity(board, oop, ip), 1e-12);
    CHECK(equity.joint_defined);
    CHECK_NEAR(equity.player0.equity + equity.player1.equity, 1.0, 1e-12);
    double marginals = 0.0;
    for (const ComboShowdown& row : equity.player0.combos)
    {
        if (!row.defined)
        {
            continue;
        }
        marginals += row.marginal;
        CHECK_NEAR(row.win + row.tie + row.loss, 1.0, 1e-12);
    }
    CHECK_NEAR(marginals, 1.0, 1e-12);
}

void test_tiny_compatible_mass()
{
    const std::vector<int> board = parse_equity_board("Kh Kd 7c 4s");
    const int aces = combo_of("AhAd");
    for (const char* epsilon : {"1e-12", "1e-18"})
    {
        const Range oop = parse_equity_range("AhAd,9c9d");
        const Range ip = parse_equity_range(std::string("AhAc:1,2c3d:") + epsilon);
        ShowdownEquityOptions options;
        options.max_pair_runouts = 100000;
        const ShowdownEquity equity = showdown_equity(board, oop, ip, options);
        const ComboShowdown* hero = find_combo(equity.player0.combos, aces);
        CHECK(hero != nullptr);
        CHECK(hero->defined);
        CHECK(hero->equity == 1.0);
        CHECK(hero->win == 1.0);
        CHECK(std::isfinite(hero->equity));
        CHECK(hero->compatible_mass == std::stod(epsilon));
        CHECK(hero->marginal > 0.0);
        const ComboShowdown* nines = find_combo(equity.player0.combos, combo_of("9c9d"));
        const ComboShowdown* blocked = find_combo(equity.player1.combos, combo_of("AhAc"));
        const ComboShowdown* tiny = find_combo(equity.player1.combos, combo_of("2c3d"));
        CHECK(nines != nullptr && nines->defined && std::isfinite(nines->equity));
        CHECK(blocked != nullptr && blocked->defined);
        CHECK(blocked->compatible_mass == 1.0);
        CHECK(std::isfinite(blocked->equity));
        CHECK(tiny != nullptr && tiny->defined);
        CHECK(tiny->compatible_mass == 2.0);
        CHECK(std::isfinite(equity.player0.equity));
        CHECK(std::isfinite(equity.player1.equity));
        expect_matches(equity, reference_equity(board, oop, ip), 1e-12);
    }
}

void test_rescaling_and_prior()
{
    const std::vector<int> board = parse_equity_board("Kh Kd 7c 4s 2h");
    const ShowdownEquity base = showdown_equity(
        board, parse_equity_range("AhAd:1,3c3d:1"), parse_equity_range("9c9d"));
    const ShowdownEquity scaled = showdown_equity(
        board, parse_equity_range("AhAd:4,3c3d:4"), parse_equity_range("9c9d:4"));
    CHECK(base.player0.equity == scaled.player0.equity);
    CHECK(base.player1.equity == scaled.player1.equity);
    const int aces = combo_of("AhAd");
    CHECK(find_combo(base.player0.combos, aces)->equity == find_combo(scaled.player0.combos, aces)->equity);

    const ShowdownEquity heavy = showdown_equity(
        board, parse_equity_range("AhAd:3,3c3d:1"), parse_equity_range("9c9d"));
    CHECK(find_combo(base.player0.combos, aces)->equity == find_combo(heavy.player0.combos, aces)->equity);
    CHECK(std::abs(base.player0.equity - heavy.player0.equity) > 0.1);
    CHECK_NEAR(heavy.player0.equity, 0.75, 1e-12);
    double unweighted = 0.0;
    int defined = 0;
    for (const ComboShowdown& row : heavy.player0.combos)
    {
        if (!row.defined)
        {
            continue;
        }
        unweighted += row.equity;
        ++defined;
    }
    unweighted /= static_cast<double>(defined);
    CHECK(std::abs(unweighted - heavy.player0.equity) > 0.1);
    double reconstructed = 0.0;
    for (const ComboShowdown& row : heavy.player0.combos)
    {
        if (row.defined)
        {
            reconstructed += row.marginal * row.equity;
        }
    }
    CHECK_NEAR(reconstructed, heavy.player0.equity, 1e-12);
    expect_matches(heavy, reference_equity(board, parse_equity_range("AhAd:3,3c3d:1"), parse_equity_range("9c9d")), 1e-12);
}

void test_undefined_and_invalid()
{
    const std::vector<int> board = parse_equity_board("Kh Kd 7c 4s 2h");
    const ShowdownEquity empty = showdown_equity(board, parse_equity_range(""), parse_equity_range(""));
    CHECK(!empty.joint_defined);
    CHECK(empty.player0.combos.empty());
    CHECK(empty.work.legal_pairs == 0);
    const std::string empty_json = showdown_equity_json(empty, board, 0.0);
    CHECK(empty_json.find("\"joint_defined\":false") != std::string::npos);
    CHECK(empty_json.find("\"model\":\"check-down\"") != std::string::npos);
    CHECK(empty_json.find("\"equity\":null") != std::string::npos);

    const ShowdownEquity blocked = showdown_equity(
        board, parse_equity_range("AhAd"), parse_equity_range("AhAc"));
    CHECK(!blocked.joint_defined);
    CHECK(blocked.player0.combos.size() == 1);
    CHECK(!blocked.player0.combos[0].defined);
    const std::string blocked_json = showdown_equity_json(blocked, board, 0.0);
    CHECK(blocked_json.find("\"defined\":false") != std::string::npos);
    CHECK(blocked_json.find("\"marginal\":null") != std::string::npos);

    const std::vector<int> dead_board = parse_equity_board("Ah Kd 7c 4s 2h");
    const ShowdownEquity dead = showdown_equity(
        dead_board, parse_equity_range("AhAd,2c2d"), parse_equity_range("9c9d"));
    const ComboShowdown* dead_aces = find_combo(dead.player0.combos, combo_of("AhAd"));
    const ComboShowdown* deuces = find_combo(dead.player0.combos, combo_of("2c2d"));
    CHECK(dead_aces != nullptr && !dead_aces->defined);
    CHECK(deuces != nullptr && deuces->defined && deuces->equity == 1.0);

    expect_failure(EquityFailure::InvalidInput, [] { parse_equity_board("Kh Kd"); });
    expect_failure(EquityFailure::InvalidInput, [] { parse_equity_board("Kh Kh 7c 4s"); });
    expect_failure(EquityFailure::InvalidInput, [] { parse_equity_board("Kx 7c 4s"); });
    expect_failure(EquityFailure::InvalidInput, [] { parse_equity_range("not-a-hand"); });
    expect_failure(EquityFailure::InvalidWeight, [] { parse_equity_range("AhAd:-1"); });
    expect_failure(EquityFailure::InvalidWeight, [] { parse_equity_range("AhAd:nan"); });
    expect_failure(EquityFailure::InvalidWeight, [] { parse_equity_range("AhAd:inf"); });
    int bad_board[3] = {0, 1, 99};
    expect_failure(EquityFailure::InvalidInput, [&] {
        showdown_equity(bad_board, parse_equity_range("AhAd"), parse_equity_range("KcKd"));
    });
}

void test_swap_suits_and_identities()
{
    const std::vector<int> board = parse_equity_board("Kh Kd 7c 4s");
    const Range oop = parse_equity_range("AhAd:1,8c8d:2");
    const Range ip = parse_equity_range("2c2d:1,QcQd:3");
    ShowdownEquityOptions options;
    options.max_pair_runouts = 100000;
    const ShowdownEquity forward = showdown_equity(board, oop, ip, options);
    const ShowdownEquity swapped = showdown_equity(board, ip, oop, options);
    CHECK_NEAR(forward.player0.equity, swapped.player1.equity, 1e-12);
    CHECK_NEAR(forward.player1.equity, swapped.player0.equity, 1e-12);
    for (const ComboShowdown& row : forward.player0.combos)
    {
        const ComboShowdown* other = find_combo(swapped.player1.combos, row.index);
        CHECK(other != nullptr && other->defined == row.defined);
        if (row.defined)
        {
            CHECK_NEAR(row.equity, other->equity, 1e-12);
        }
    }

    auto map_card = [](int card) {
        return poker::holdem::make_card(
            poker::holdem::rank_of(card),
            (poker::holdem::suit_of(card) + 1) % 4);
    };
    std::vector<int> mapped_board;
    for (int card : board)
    {
        mapped_board.push_back(map_card(card));
    }
    Range mapped_oop;
    Range mapped_ip;
    for (int index = 0; index < kComboCount; ++index)
    {
        if (oop.weight(index) == 0.0 && ip.weight(index) == 0.0)
        {
            continue;
        }
        int card0 = 0;
        int card1 = 0;
        Range::combo_cards(index, card0, card1);
        const int mapped = Range::combo_index(map_card(card0), map_card(card1));
        if (oop.weight(index) > 0.0)
        {
            int low = 0;
            int high = 0;
            Range::combo_cards(mapped, low, high);
            mapped_oop.set_weight(low, high, oop.weight(index));
        }
        if (ip.weight(index) > 0.0)
        {
            int low = 0;
            int high = 0;
            Range::combo_cards(mapped, low, high);
            mapped_ip.set_weight(low, high, ip.weight(index));
        }
    }
    const ShowdownEquity permuted = showdown_equity(mapped_board, mapped_oop, mapped_ip, options);
    CHECK_NEAR(forward.player0.equity, permuted.player0.equity, 1e-12);
    CHECK_NEAR(forward.player1.equity, permuted.player1.equity, 1e-12);
    CHECK_NEAR(forward.player0.win + forward.player0.tie + forward.player0.loss, 1.0, 1e-12);
    CHECK_NEAR(forward.player0.equity + forward.player1.equity, 1.0, 1e-12);
}

struct Probe
{
    int calls = 0;
};

bool trip_on_third(void* context)
{
    Probe* probe = static_cast<Probe*>(context);
    ++probe->calls;
    return probe->calls >= 3;
}

bool always_cancel(void*)
{
    return true;
}

void test_work_limit_and_cancellation()
{
    const std::vector<int> flop = parse_equity_board("Ah Kd 7c");
    const Range oop = parse_equity_range("2c2d");
    const Range ip = parse_equity_range("9c9d");
    const auto before = copy_weights(oop);
    ShowdownEquityOptions too_small;
    too_small.max_pair_runouts = 989;
    const EquityError limited = expect_failure(EquityFailure::WorkLimit, [&] { showdown_equity(flop, oop, ip, too_small); });
    CHECK(limited.required_pair_runouts() == 990);
    CHECK(limited.allowed_pair_runouts() == 989);
    CHECK(limited.what() == std::string("equity work limit exceeded: required 990 pair-runouts, allowed 989"));
    CHECK(copy_weights(oop) == before);
    ShowdownEquityOptions exact;
    exact.max_pair_runouts = 990;
    const ShowdownEquity accepted = showdown_equity(flop, oop, ip, exact);
    CHECK(accepted.work.pair_runouts == 990);
    CHECK(accepted.joint_defined);

    const std::vector<int> river = parse_equity_board("As Kd Qc Jh 9c");
    const Range wide = parse_equity_range("random");
    const EquityError wide_limit = expect_failure(
        EquityFailure::WorkLimit, [&] { showdown_equity(river, wide, wide); });
    CHECK(wide_limit.required_pair_runouts() == 1070190);
    CHECK(wide_limit.allowed_pair_runouts() == poker::holdem::kDefaultMaxPairRunouts);

    const std::vector<int> sample = parse_equity_board("Kh Kd 7c 4s 2h");
    const Range left = parse_equity_range("2c2d,3c3d");
    const Range right = parse_equity_range("4c4d,5c5d");
    Probe probe;
    ShowdownEquityOptions cancel;
    cancel.cancel_poll = trip_on_third;
    cancel.cancel_context = &probe;
    expect_failure(EquityFailure::Cancelled, [&] { showdown_equity(sample, left, right, cancel); });
    CHECK(probe.calls >= 3);
    CHECK(copy_weights(left) == copy_weights(parse_equity_range("2c2d,3c3d")));
    ShowdownEquityOptions stop;
    stop.cancel_poll = always_cancel;
    expect_failure(EquityFailure::Cancelled, [&] { showdown_equity(sample, left, right, stop); });
    const ShowdownEquity after = showdown_equity(sample, left, right);
    CHECK(after.joint_defined);
    CHECK(after.work.legal_pairs == 4);
}

void test_inputs_determinism_and_random()
{
    const std::vector<int> board = parse_equity_board("Ah Kd 7c 2s");
    const Range oop = parse_equity_range("QcQd:1.5,8c8d:0.25");
    const Range ip = parse_equity_range("3c3d:2,JcJd:1");
    const auto left_before = copy_weights(oop);
    const auto right_before = copy_weights(ip);
    ShowdownEquityOptions options;
    options.max_pair_runouts = 100000;
    const ShowdownEquity first = showdown_equity(board, oop, ip, options);
    const ShowdownEquity second = showdown_equity(board, oop, ip, options);
    CHECK(copy_weights(oop) == left_before);
    CHECK(copy_weights(ip) == right_before);
    CHECK(first.player0.equity == second.player0.equity);
    CHECK(first.player1.equity == second.player1.equity);
    CHECK(first.player0.combos.size() == second.player0.combos.size());
    for (std::size_t i = 0; i < first.player0.combos.size(); ++i)
    {
        CHECK(first.player0.combos[i].equity == second.player0.combos[i].equity);
        CHECK(first.player0.combos[i].marginal == second.player0.combos[i].marginal);
    }

    std::mt19937 rng(20260328);
    std::uniform_int_distribution<int> cards(0, 51);
    std::uniform_real_distribution<double> weights(0.05, 3.0);
    const std::vector<int> streets[] = {
        parse_equity_board("Ah Kd 7c"),
        parse_equity_board("Ah Kd 7c 2s"),
        parse_equity_board("Ah Kd 7c 2s 9d"),
    };
    for (const std::vector<int>& street : streets)
    {
        Range sparse0;
        Range sparse1;
        auto add_combos = [&](Range& range, int count) {
            int added = 0;
            while (added < count)
            {
                const int card0 = cards(rng);
                const int card1 = cards(rng);
                if (card0 == card1)
                {
                    continue;
                }
                bool on_board = false;
                for (int card : street)
                {
                    if (card == card0 || card == card1)
                    {
                        on_board = true;
                    }
                }
                if (on_board)
                {
                    continue;
                }
                range.set_weight(card0, card1, weights(rng));
                ++added;
            }
        };
        add_combos(sparse0, 3);
        add_combos(sparse1, 3);
        ShowdownEquityOptions sparse_options;
        sparse_options.max_pair_runouts = 100000;
        const ShowdownEquity sparse = showdown_equity(street, sparse0, sparse1, sparse_options);
        expect_matches(sparse, reference_equity(street, sparse0, sparse1), 1e-12);
    }

    std::mt19937 larger_rng(8675309);
    const std::vector<int> flop = parse_equity_board("Qs Jh 4c");
    Range larger0;
    Range larger1;
    auto add_larger = [&](Range& range) {
        int added = 0;
        while (added < 5)
        {
            const int card0 = cards(larger_rng);
            const int card1 = cards(larger_rng);
            if (card0 == card1 || card0 == poker::holdem::parse_card("Qs") || card1 == poker::holdem::parse_card("Qs")
                || card0 == poker::holdem::parse_card("Jh") || card1 == poker::holdem::parse_card("Jh")
                || card0 == poker::holdem::parse_card("4c") || card1 == poker::holdem::parse_card("4c"))
            {
                continue;
            }
            range.set_weight(card0, card1, weights(larger_rng));
            ++added;
        }
    };
    add_larger(larger0);
    add_larger(larger1);
    ShowdownEquityOptions larger_options;
    larger_options.max_pair_runouts = 1000000;
    const ShowdownEquity larger = showdown_equity(flop, larger0, larger1, larger_options);
    expect_matches(larger, reference_equity(flop, larger0, larger1), 1e-12);
}

} // namespace

int main()
{
    test_river_certainty_and_royal_tie();
    test_completion_counts_and_blockers();
    test_asymmetric_oracle();
    test_tiny_compatible_mass();
    test_rescaling_and_prior();
    test_undefined_and_invalid();
    test_swap_suits_and_identities();
    test_work_limit_and_cancellation();
    test_inputs_determinism_and_random();
    std::cout << "passed=" << g_passed << " failed=" << g_failures << "\n";
    return g_failures == 0 ? 0 : 1;
}
