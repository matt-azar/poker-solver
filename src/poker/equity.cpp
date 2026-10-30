#include "poker/equity.hpp"

#include "poker/card.hpp"
#include "poker/hand_eval.hpp"

#include <charconv>
#include <cmath>

namespace poker::holdem
{
namespace
{

struct Accumulator
{
    double sum = 0.0;
    double compensation = 0.0;

    void add(double value)
    {
        const double adjusted = value - compensation;
        const double next = sum + adjusted;
        compensation = (next - sum) - adjusted;
        sum = next;
    }

    double value() const { return sum; }
};

struct HandRef
{
    int index = 0;
    int card0 = 0;
    int card1 = 0;
    double weight = 0.0;
    bool blocked = false;
    bool supported = false;
    // Largest compatible opponent weight. Conditional fractions use this, not the range maximum.
    double opponent_scale = 0.0;
};

struct Bin
{
    Accumulator win;
    Accumulator tie;
    Accumulator loss;
    Accumulator equity;
    // Opponent weights divided by this hand's own largest compatible opponent.
    Accumulator scaled_mass;
    // Direct sum of the original opponent weights.
    Accumulator original_mass;
};

[[noreturn]] void fail(EquityFailure failure, const std::string& message)
{
    throw EquityError(failure, message);
}

void check_cancel(const ShowdownEquityOptions& options)
{
    if (options.cancel_poll != nullptr && options.cancel_poll(options.cancel_context))
    {
        fail(EquityFailure::Cancelled, "equity calculation cancelled");
    }
}

void validate_equity_board(std::span<const int> board)
{
    if (board.size() < 3 || board.size() > 5)
    {
        fail(EquityFailure::InvalidInput, "invalid equity input: equity board must contain 3, 4, or 5 distinct cards");
    }
    for (std::size_t i = 0; i < board.size(); ++i)
    {
        if (!valid_card(board[i]))
        {
            fail(EquityFailure::InvalidInput, "invalid equity input: equity board contains an invalid card");
        }
        for (std::size_t j = 0; j < i; ++j)
        {
            if (board[i] == board[j])
            {
                fail(EquityFailure::InvalidInput, "invalid equity input: equity board contains a duplicate card");
            }
        }
    }
}

void validate_weights(const Range& range)
{
    const std::array<double, kComboCount>& weights = range.weights();
    for (double weight : weights)
    {
        if (!std::isfinite(weight) || weight < 0.0)
        {
            fail(EquityFailure::InvalidWeight, "invalid equity weight: a range weight must be finite and nonnegative");
        }
    }
}

std::uint64_t completions_for(std::size_t board_count)
{
    if (board_count == 5)
    {
        return 1;
    }
    if (board_count == 4)
    {
        return 44;
    }
    return 990;
}

std::uint64_t board_mask(std::span<const int> board)
{
    std::uint64_t mask = 0;
    for (int card : board)
    {
        mask |= std::uint64_t{1} << card;
    }
    return mask;
}

bool blocked_by(int card0, int card1, std::uint64_t dead)
{
    const std::uint64_t hand = (std::uint64_t{1} << card0) | (std::uint64_t{1} << card1);
    return (hand & dead) != 0;
}

bool shares_card(const HandRef& left, const HandRef& right)
{
    return left.card0 == right.card0 || left.card0 == right.card1 || left.card1 == right.card0
        || left.card1 == right.card1;
}

std::vector<HandRef> collect_hands(const Range& range, std::uint64_t dead)
{
    std::vector<HandRef> hands;
    for (int index = 0; index < kComboCount; ++index)
    {
        const double weight = range.weight(index);
        if (!(weight > 0.0))
        {
            continue;
        }
        HandRef hand;
        hand.index = index;
        Range::combo_cards(index, hand.card0, hand.card1);
        hand.weight = weight;
        hand.blocked = blocked_by(hand.card0, hand.card1, dead);
        hands.push_back(hand);
    }
    return hands;
}

std::uint64_t count_legal_pairs(const std::vector<HandRef>& left, const std::vector<HandRef>& right)
{
    std::uint64_t pairs = 0;
    for (const HandRef& hero : left)
    {
        if (hero.blocked)
        {
            continue;
        }
        for (const HandRef& villain : right)
        {
            if (villain.blocked || shares_card(hero, villain))
            {
                continue;
            }
            if (pairs == UINT64_MAX)
            {
                fail(EquityFailure::WorkLimit, "equity work limit exceeded: pair count overflow");
            }
            ++pairs;
        }
    }
    return pairs;
}

void mark_supported(std::vector<HandRef>& left, std::vector<HandRef>& right)
{
    for (HandRef& hero : left)
    {
        if (hero.blocked)
        {
            continue;
        }
        for (HandRef& villain : right)
        {
            if (villain.blocked || shares_card(hero, villain))
            {
                continue;
            }
            hero.supported = true;
            villain.supported = true;
        }
    }
}

// Divide by the largest participating weight so a uniform scale change stays near 1.
// A positive compatible weight that underflows to zero is rejected rather than dropped.
double scaled_weight(double weight, double scale)
{
    const double scaled = weight / scale;
    if (!std::isfinite(scaled) || !(scaled > 0.0))
    {
        fail(
            EquityFailure::NumericalRange,
            "equity numerical range exceeded: a compatible weight is lost when normalized");
    }
    return scaled;
}

// The largest joint contribution must be a normal double. A smaller subnormal
// contribution can sit beside it. When every contribution underflows, the
// relative weights are no longer represented, and the input is rejected.
void require_normal_joint(bool any_normal, bool any_subnormal)
{
    if (!any_normal && any_subnormal)
    {
        fail(
            EquityFailure::NumericalRange,
            "equity numerical range exceeded: joint contributions are below the normal range");
    }
}

double participant_scale(const std::vector<HandRef>& hands)
{
    double scale = 0.0;
    for (const HandRef& hand : hands)
    {
        if (hand.supported && hand.weight > scale)
        {
            scale = hand.weight;
        }
    }
    if (!(scale > 0.0) || !std::isfinite(scale))
    {
        fail(EquityFailure::NumericalRange, "equity numerical range exceeded: no finite scale for a legal joint");
    }
    for (const HandRef& hand : hands)
    {
        if (hand.supported)
        {
            scaled_weight(hand.weight, scale);
        }
    }
    return scale;
}

void assign_opponent_scales(std::vector<HandRef>& heroes, const std::vector<HandRef>& villains)
{
    for (HandRef& hero : heroes)
    {
        hero.opponent_scale = 0.0;
        if (!hero.supported)
        {
            continue;
        }
        for (const HandRef& villain : villains)
        {
            if (!villain.supported || shares_card(hero, villain))
            {
                continue;
            }
            if (villain.weight > hero.opponent_scale)
            {
                hero.opponent_scale = villain.weight;
            }
        }
        if (!(hero.opponent_scale > 0.0) || !std::isfinite(hero.opponent_scale))
        {
            fail(EquityFailure::NumericalRange, "equity numerical range exceeded: no finite scale for a legal joint");
        }
    }
}

void require_representable_side(
    const std::vector<HandRef>& heroes,
    const std::vector<HandRef>& villains,
    double hero_scale,
    double villain_scale)
{
    Accumulator joint;
    bool any = false;
    bool any_normal = false;
    bool any_subnormal = false;
    for (const HandRef& hero : heroes)
    {
        if (!hero.supported)
        {
            continue;
        }
        Accumulator mass;
        for (const HandRef& villain : villains)
        {
            if (!villain.supported || shares_card(hero, villain))
            {
                continue;
            }
            mass.add(villain.weight);
            // The largest opponent of this hand normalizes to 1. A smaller one may be subnormal.
            scaled_weight(villain.weight, hero.opponent_scale);
        }
        const double original_mass = mass.value();
        const double mass_unit = original_mass / villain_scale;
        const double term = scaled_weight(hero.weight, hero_scale) * mass_unit;
        if (!std::isfinite(original_mass) || !(original_mass > 0.0) || !std::isfinite(mass_unit) || mass_unit < 0.0
            || !std::isfinite(term) || term < 0.0)
        {
            fail(EquityFailure::NumericalRange, "equity numerical range exceeded: compatible mass is not representable");
        }
        if (term > 0.0)
        {
            joint.add(term);
            any = true;
            if (std::isnormal(term))
            {
                any_normal = true;
            }
            else if (std::isfinite(term))
            {
                any_subnormal = true;
            }
        }
    }
    require_normal_joint(any_normal, any_subnormal);
    const double total = joint.value();
    if (!any || !std::isfinite(total) || !(total > 0.0))
    {
        fail(EquityFailure::NumericalRange, "equity numerical range exceeded: joint mass is not representable");
    }
}

std::uint64_t checked_product(std::uint64_t pairs, std::uint64_t completions)
{
    if (pairs != 0 && completions > UINT64_MAX / pairs)
    {
        fail(EquityFailure::WorkLimit, "equity work limit exceeded: pair-runout count overflow");
    }
    return pairs * completions;
}

double fraction(int count, int total)
{
    if (count <= 0)
    {
        return 0.0;
    }
    if (count >= total)
    {
        return 1.0;
    }
    return static_cast<double>(count) / static_cast<double>(total);
}

double equity_fraction(int wins, int ties, int total)
{
    if (wins >= total)
    {
        return 1.0;
    }
    if (ties >= total)
    {
        return 0.5;
    }
    if (wins == 0 && ties == 0)
    {
        return 0.0;
    }
    return (static_cast<double>(wins) + 0.5 * static_cast<double>(ties)) / static_cast<double>(total);
}

struct PairScore
{
    double win = 0.0;
    double tie = 0.0;
    double loss = 0.0;
    double equity = 0.0;
    double villain_equity = 0.0;
};

PairScore score_pair(
    const HandRef& hero,
    const HandRef& villain,
    std::span<const int> board,
    std::uint64_t dead_board,
    const ShowdownEquityOptions& options)
{
    const std::uint64_t dead = dead_board | (std::uint64_t{1} << hero.card0) | (std::uint64_t{1} << hero.card1)
        | (std::uint64_t{1} << villain.card0) | (std::uint64_t{1} << villain.card1);
    int available[49];
    int available_count = 0;
    for (int card = 0; card < kDeckSize; ++card)
    {
        if ((dead & (std::uint64_t{1} << card)) == 0)
        {
            available[available_count++] = card;
        }
    }

    int full[5];
    const int board_count = static_cast<int>(board.size());
    for (int i = 0; i < board_count; ++i)
    {
        full[i] = board[static_cast<std::size_t>(i)];
    }

    int wins = 0;
    int ties = 0;
    int losses = 0;
    int scored = 0;
    const auto accept = [&](int river_a, int river_b) {
        if (board_count <= 3)
        {
            full[3] = river_a;
            full[4] = river_b;
        }
        else if (board_count == 4)
        {
            full[4] = river_a;
        }
        const int comparison = compare_showdown(
            hero.card0,
            hero.card1,
            villain.card0,
            villain.card1,
            std::span<const int>(full, 5));
        if (comparison > 0)
        {
            ++wins;
        }
        else if (comparison < 0)
        {
            ++losses;
        }
        else
        {
            ++ties;
        }
        ++scored;
        if (scored % 16 == 0)
        {
            check_cancel(options);
        }
    };

    if (board_count == 5)
    {
        accept(0, 0);
    }
    else if (board_count == 4)
    {
        for (int i = 0; i < available_count; ++i)
        {
            accept(available[i], 0);
        }
    }
    else
    {
        for (int i = 0; i < available_count; ++i)
        {
            for (int j = i + 1; j < available_count; ++j)
            {
                accept(available[i], available[j]);
            }
        }
    }

    const int expected = board_count == 5 ? 1 : (board_count == 4 ? 44 : 990);
    if (scored != expected || wins + ties + losses != expected)
    {
        throw std::logic_error("showdown completion count mismatch");
    }

    PairScore score;
    score.win = fraction(wins, expected);
    score.tie = fraction(ties, expected);
    score.loss = fraction(losses, expected);
    score.equity = equity_fraction(wins, ties, expected);
    score.villain_equity = equity_fraction(losses, ties, expected);
    return score;
}

// unit_weight is opponent_weight / this hand's largest compatible opponent. That largest
// opponent is exactly 1, so its fraction is stored unchanged. A global range scale would
// turn another hand's only opponent into a subnormal and make unit_weight * fraction a
// different positive number.
double scale_fraction(double unit_weight, double fraction)
{
    if (unit_weight == 1.0)
    {
        return fraction;
    }
    const double product = unit_weight * fraction;
    if (!std::isfinite(product))
    {
        fail(EquityFailure::NumericalRange, "equity numerical range exceeded: a showdown fraction is not representable");
    }
    return product;
}

void add_outcome(Bin& bin, double opponent_weight, double unit_weight, double win, double tie, double loss, double equity)
{
    bin.win.add(scale_fraction(unit_weight, win));
    bin.tie.add(scale_fraction(unit_weight, tie));
    bin.loss.add(scale_fraction(unit_weight, loss));
    bin.equity.add(scale_fraction(unit_weight, equity));
    bin.scaled_mass.add(unit_weight);
    bin.original_mass.add(opponent_weight);
}

double finite_ratio(double numerator, double denominator)
{
    const double value = numerator / denominator;
    if (!std::isfinite(value))
    {
        fail(EquityFailure::NumericalRange, "equity numerical range exceeded: a showdown fraction is not representable");
    }
    return value;
}

// bins == nullptr is a structurally empty joint: success, with every row undefined.
// A positive joint that cannot be represented throws NumericalRange instead of returning that shape.
PlayerShowdown finish_player(
    const std::vector<HandRef>& hands,
    const std::vector<Bin>* bins,
    double own_scale,
    double opponent_scale)
{
    PlayerShowdown player;
    player.combos.reserve(hands.size());
    std::vector<double> joint_terms;
    joint_terms.reserve(hands.size());
    Accumulator joint;
    for (const HandRef& hand : hands)
    {
        ComboShowdown row;
        row.index = hand.index;
        row.combo = Range::combo_text(hand.index);
        row.input_weight = hand.weight;
        const Bin* bin = bins == nullptr ? nullptr : &(*bins)[static_cast<std::size_t>(hand.index)];
        if (bins == nullptr || !hand.supported || bin == nullptr)
        {
            row.defined = false;
            joint_terms.push_back(0.0);
            player.combos.push_back(row);
            continue;
        }
        const double scaled_mass = bin->scaled_mass.value();
        const double original_mass = bin->original_mass.value();
        const double mass_unit = original_mass / opponent_scale;
        const double term = scaled_weight(hand.weight, own_scale) * mass_unit;
        if (!std::isfinite(scaled_mass) || !(scaled_mass > 0.0) || !std::isfinite(original_mass) || !(original_mass > 0.0)
            || !std::isfinite(mass_unit) || mass_unit < 0.0 || !std::isfinite(term) || term < 0.0)
        {
            fail(EquityFailure::NumericalRange, "equity numerical range exceeded: compatible mass is not representable");
        }
        row.defined = true;
        row.compatible_mass = original_mass;
        row.win = finite_ratio(bin->win.value(), scaled_mass);
        row.tie = finite_ratio(bin->tie.value(), scaled_mass);
        row.loss = finite_ratio(bin->loss.value(), scaled_mass);
        row.equity = finite_ratio(bin->equity.value(), scaled_mass);
        joint.add(term);
        joint_terms.push_back(term);
        player.combos.push_back(row);
    }

    if (bins == nullptr)
    {
        return player;
    }

    bool any_normal = false;
    bool any_subnormal = false;
    for (const double term : joint_terms)
    {
        if (std::isnormal(term))
        {
            any_normal = true;
        }
        else if (std::isfinite(term) && term > 0.0)
        {
            any_subnormal = true;
        }
    }
    require_normal_joint(any_normal, any_subnormal);

    const double z = joint.value();
    if (!std::isfinite(z) || !(z > 0.0))
    {
        fail(EquityFailure::NumericalRange, "equity numerical range exceeded: joint mass is not representable");
    }

    player.defined = true;
    Accumulator win;
    Accumulator tie;
    Accumulator loss;
    Accumulator equity;
    for (std::size_t i = 0; i < player.combos.size(); ++i)
    {
        ComboShowdown& row = player.combos[i];
        if (!row.defined)
        {
            continue;
        }
        row.marginal = joint_terms[i] / z;
        if (!std::isfinite(row.marginal))
        {
            fail(EquityFailure::NumericalRange, "equity numerical range exceeded: a marginal is not representable");
        }
        win.add(row.marginal * row.win);
        tie.add(row.marginal * row.tie);
        loss.add(row.marginal * row.loss);
        equity.add(row.marginal * row.equity);
    }
    player.win = win.value();
    player.tie = tie.value();
    player.loss = loss.value();
    player.equity = equity.value();
    if (!std::isfinite(player.win) || !std::isfinite(player.tie) || !std::isfinite(player.loss) || !std::isfinite(player.equity))
    {
        fail(EquityFailure::NumericalRange, "equity numerical range exceeded: a showdown aggregate is not representable");
    }
    return player;
}

std::string format_number(double value)
{
    char buffer[64];
    const auto result = std::to_chars(buffer, buffer + sizeof(buffer), value, std::chars_format::general, 17);
    if (result.ec != std::errc{})
    {
        return "0";
    }
    return std::string(buffer, result.ptr);
}

void append_number_or_null(std::string& out, bool defined, double value)
{
    if (!defined)
    {
        out += "null";
        return;
    }
    out += format_number(value);
}

std::vector<HandRef> prepared_hands(std::span<const int> board, const Range& range)
{
    validate_equity_board(board);
    validate_weights(range);
    return collect_hands(range, board_mask(board));
}

} // namespace

EquityError::EquityError(
    EquityFailure failure,
    const std::string& message,
    std::uint64_t required_pair_runouts,
    std::uint64_t allowed_pair_runouts)
    : std::runtime_error(message)
    , failure_(failure)
    , required_(required_pair_runouts)
    , allowed_(allowed_pair_runouts)
{
}

ShowdownWork measure_showdown_work(
    std::span<const int> board,
    const Range& player0,
    const Range& player1)
{
    const std::vector<HandRef> hands0 = prepared_hands(board, player0);
    const std::vector<HandRef> hands1 = prepared_hands(board, player1);
    ShowdownWork work;
    work.legal_pairs = count_legal_pairs(hands0, hands1);
    work.completions_per_pair = completions_for(board.size());
    work.pair_runouts = checked_product(work.legal_pairs, work.completions_per_pair);
    return work;
}

ShowdownEquity showdown_equity(
    std::span<const int> board,
    const Range& player0,
    const Range& player1,
    const ShowdownEquityOptions& options)
{
    std::vector<HandRef> hands0 = prepared_hands(board, player0);
    std::vector<HandRef> hands1 = prepared_hands(board, player1);
    check_cancel(options);

    ShowdownEquity result;
    result.work.legal_pairs = count_legal_pairs(hands0, hands1);
    result.work.completions_per_pair = completions_for(board.size());
    result.work.pair_runouts = checked_product(result.work.legal_pairs, result.work.completions_per_pair);
    if (result.work.pair_runouts > options.max_pair_runouts)
    {
        throw EquityError(
            EquityFailure::WorkLimit,
            "equity work limit exceeded: required " + std::to_string(result.work.pair_runouts)
                + " pair-runouts, allowed " + std::to_string(options.max_pair_runouts),
            result.work.pair_runouts,
            options.max_pair_runouts);
    }

    if (result.work.legal_pairs == 0)
    {
        result.player0 = finish_player(hands0, nullptr, 1.0, 1.0);
        result.player1 = finish_player(hands1, nullptr, 1.0, 1.0);
        result.joint_defined = false;
        return result;
    }

    mark_supported(hands0, hands1);
    const double scale0 = participant_scale(hands0);
    const double scale1 = participant_scale(hands1);
    assign_opponent_scales(hands0, hands1);
    assign_opponent_scales(hands1, hands0);
    require_representable_side(hands0, hands1, scale0, scale1);
    require_representable_side(hands1, hands0, scale1, scale0);

    const std::uint64_t dead = board_mask(board);
    std::vector<Bin> bins0(static_cast<std::size_t>(kComboCount));
    std::vector<Bin> bins1(static_cast<std::size_t>(kComboCount));
    for (const HandRef& hero : hands0)
    {
        if (!hero.supported)
        {
            continue;
        }
        for (const HandRef& villain : hands1)
        {
            if (!villain.supported || shares_card(hero, villain))
            {
                continue;
            }
            check_cancel(options);
            const PairScore score = score_pair(hero, villain, board, dead, options);
            add_outcome(
                bins0[static_cast<std::size_t>(hero.index)],
                villain.weight,
                scaled_weight(villain.weight, hero.opponent_scale),
                score.win,
                score.tie,
                score.loss,
                score.equity);
            add_outcome(
                bins1[static_cast<std::size_t>(villain.index)],
                hero.weight,
                scaled_weight(hero.weight, villain.opponent_scale),
                score.loss,
                score.tie,
                score.win,
                score.villain_equity);
        }
    }

    result.player0 = finish_player(hands0, &bins0, scale0, scale1);
    result.player1 = finish_player(hands1, &bins1, scale1, scale0);
    if (!result.player0.defined || !result.player1.defined)
    {
        fail(EquityFailure::NumericalRange, "equity numerical range exceeded: a legal joint was not representable");
    }
    result.joint_defined = true;
    return result;
}

std::vector<int> parse_equity_board(std::string_view text)
{
    std::vector<int> cards;
    std::size_t cursor = 0;
    while (cursor < text.size())
    {
        while (cursor < text.size() && (text[cursor] == ' ' || text[cursor] == ',' || text[cursor] == '\t'))
        {
            ++cursor;
        }
        if (cursor >= text.size())
        {
            break;
        }
        std::size_t end = cursor;
        while (end < text.size() && text[end] != ' ' && text[end] != ',' && text[end] != '\t')
        {
            ++end;
        }
        try
        {
            cards.push_back(parse_card(text.substr(cursor, end - cursor)));
        }
        catch (const std::invalid_argument& error)
        {
            fail(EquityFailure::InvalidInput, std::string("invalid equity input: ") + error.what());
        }
        cursor = end;
    }
    validate_equity_board(cards);
    return cards;
}

Range parse_equity_range(std::string_view text)
{
    try
    {
        Range range = Range::parse(text);
        validate_weights(range);
        return range;
    }
    catch (const EquityError&)
    {
        throw;
    }
    catch (const std::invalid_argument& error)
    {
        const std::string message = error.what();
        if (message.find("weight") != std::string::npos)
        {
            fail(EquityFailure::InvalidWeight, "invalid equity weight: " + message);
        }
        fail(EquityFailure::InvalidInput, "invalid equity input: " + message);
    }
}

void append_combo(std::string& out, const ComboShowdown& row)
{
    out += "{\"combo\":\"";
    out += row.combo;
    out += "\",\"index\":";
    out += std::to_string(row.index);
    out += ",\"input_weight\":";
    out += format_number(row.input_weight);
    out += ",\"defined\":";
    out += row.defined ? "true" : "false";
    out += ",\"compatible_mass\":";
    append_number_or_null(out, row.defined, row.compatible_mass);
    out += ",\"marginal\":";
    append_number_or_null(out, row.defined, row.marginal);
    out += ",\"win\":";
    append_number_or_null(out, row.defined, row.win);
    out += ",\"tie\":";
    append_number_or_null(out, row.defined, row.tie);
    out += ",\"loss\":";
    append_number_or_null(out, row.defined, row.loss);
    out += ",\"equity\":";
    append_number_or_null(out, row.defined, row.equity);
    out += '}';
}

void append_player(std::string& out, const PlayerShowdown& player)
{
    out += "{\"equity\":";
    append_number_or_null(out, player.defined, player.equity);
    out += ",\"win\":";
    append_number_or_null(out, player.defined, player.win);
    out += ",\"tie\":";
    append_number_or_null(out, player.defined, player.tie);
    out += ",\"loss\":";
    append_number_or_null(out, player.defined, player.loss);
    out += ",\"combos\":[";
    for (std::size_t i = 0; i < player.combos.size(); ++i)
    {
        if (i != 0)
        {
            out += ',';
        }
        append_combo(out, player.combos[i]);
    }
    out += "]}";
}

std::vector<EquityDistributionBucket> empty_equity_distribution()
{
    std::vector<EquityDistributionBucket> buckets(
        static_cast<std::size_t>(kEquityDistributionBuckets));
    for (int i = 0; i < kEquityDistributionBuckets; ++i)
    {
        buckets[static_cast<std::size_t>(i)].lo =
            static_cast<double>(i) / static_cast<double>(kEquityDistributionBuckets);
        buckets[static_cast<std::size_t>(i)].hi =
            static_cast<double>(i + 1) / static_cast<double>(kEquityDistributionBuckets);
        buckets[static_cast<std::size_t>(i)].weight = 0.0;
    }
    return buckets;
}

std::vector<EquityDistributionBucket> equity_distribution(
    std::span<const double> equities,
    std::span<const double> weights)
{
    if (equities.size() != weights.size())
    {
        throw std::invalid_argument("equity_distribution: equities and weights size mismatch");
    }
    std::vector<EquityDistributionBucket> buckets = empty_equity_distribution();
    for (std::size_t i = 0; i < equities.size(); ++i)
    {
        const double weight = weights[i];
        if (!std::isfinite(weight) || weight < 0.0)
        {
            throw EquityError(EquityFailure::InvalidWeight, "equity_distribution: weight must be finite and nonnegative");
        }
        if (weight == 0.0)
        {
            continue;
        }
        double equity = equities[i];
        if (!std::isfinite(equity))
        {
            throw EquityError(EquityFailure::InvalidInput, "equity_distribution: equity must be finite");
        }
        if (equity < 0.0)
        {
            equity = 0.0;
        }
        else if (equity > 1.0)
        {
            equity = 1.0;
        }
        int index = static_cast<int>(equity * static_cast<double>(kEquityDistributionBuckets));
        if (index >= kEquityDistributionBuckets)
        {
            index = kEquityDistributionBuckets - 1;
        }
        buckets[static_cast<std::size_t>(index)].weight += weight;
    }
    return buckets;
}

std::vector<EquityDistributionBucket> equity_distribution(const PlayerShowdown& player)
{
    std::vector<double> equities;
    std::vector<double> weights;
    equities.reserve(player.combos.size());
    weights.reserve(player.combos.size());
    for (const ComboShowdown& row : player.combos)
    {
        if (!row.defined || row.input_weight <= 0.0)
        {
            continue;
        }
        equities.push_back(row.equity);
        weights.push_back(row.input_weight);
    }
    return equity_distribution(equities, weights);
}

std::string showdown_equity_json(
    const ShowdownEquity& equity,
    std::span<const int> board,
    double elapsed_seconds)
{
    std::string out;
    out += "{\"model\":\"";
    out += kEquityModel;
    out += "\",\"units\":\"";
    out += kEquityUnits;
    out += "\",\"tie_share\":0.5,\"board\":[";
    for (std::size_t i = 0; i < board.size(); ++i)
    {
        if (i != 0)
        {
            out += ',';
        }
        out += '"';
        out += format_card(board[i]);
        out += '"';
    }
    out += "],\"joint_defined\":";
    out += equity.joint_defined ? "true" : "false";
    out += ",\"legal_pairs\":";
    out += std::to_string(equity.work.legal_pairs);
    out += ",\"completions_per_pair\":";
    out += std::to_string(equity.work.completions_per_pair);
    out += ",\"pair_runouts\":";
    out += std::to_string(equity.work.pair_runouts);
    out += ",\"elapsed_seconds\":";
    out += format_number(elapsed_seconds);
    out += ",\"players\":[";
    append_player(out, equity.player0);
    out += ',';
    append_player(out, equity.player1);
    out += "]}";
    return out;
}

} // namespace poker::holdem
