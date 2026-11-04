#include "game/kuhn.hpp"

#include <stdexcept>

namespace poker::kuhn
{
namespace
{

[[noreturn]] void fail(const char* message)
{
    throw std::logic_error(message);
}

} // namespace

std::array<Deal, kNumDeals> all_deals()
{
    std::array<Deal, kNumDeals> deals{};
    int index = 0;
    for (int a = 0; a < kNumCards; ++a)
    {
        for (int b = 0; b < kNumCards; ++b)
        {
            if (a == b)
            {
                continue;
            }
            deals[index++] = Deal{static_cast<Card>(a), static_cast<Card>(b)};
        }
    }
    return deals;
}

bool cards_distinct(Deal deal)
{
    return deal.p1 != deal.p2;
}

int card_rank(Card card)
{
    return static_cast<int>(card);
}

std::string_view card_name(Card card)
{
    switch (card)
    {
    case Card::Jack:
        return "Jack";
    case Card::Queen:
        return "Queen";
    case Card::King:
        return "King";
    }
    return "?";
}

std::string_view action_name(Action action)
{
    switch (action)
    {
    case Action::Check:
        return "Check";
    case Action::Bet:
        return "Bet";
    case Action::Fold:
        return "Fold";
    case Action::Call:
        return "Call";
    }
    return "?";
}

std::string_view player_name(Player player)
{
    return player == Player::P1 ? "P1" : "P2";
}

std::string_view sequence_name(Sequence sequence)
{
    switch (sequence)
    {
    case Sequence::Empty:
        return "";
    case Sequence::Check:
        return "Check";
    case Sequence::Bet:
        return "Bet";
    case Sequence::CheckCheck:
        return "Check-Check";
    case Sequence::CheckBet:
        return "Check-Bet";
    case Sequence::BetFold:
        return "Bet-Fold";
    case Sequence::BetCall:
        return "Bet-Call";
    case Sequence::CheckBetFold:
        return "Check-Bet-Fold";
    case Sequence::CheckBetCall:
        return "Check-Bet-Call";
    }
    return "?";
}

Player player_to_act(Sequence sequence)
{
    switch (sequence)
    {
    case Sequence::Empty:
    case Sequence::CheckBet:
        return Player::P1;
    case Sequence::Check:
    case Sequence::Bet:
        return Player::P2;
    default:
        fail("player_to_act on terminal sequence");
    }
}

bool is_terminal(Sequence sequence)
{
    switch (sequence)
    {
    case Sequence::CheckCheck:
    case Sequence::BetFold:
    case Sequence::BetCall:
    case Sequence::CheckBetFold:
    case Sequence::CheckBetCall:
        return true;
    default:
        return false;
    }
}

bool is_showdown(Sequence sequence)
{
    return sequence == Sequence::CheckCheck
        || sequence == Sequence::BetCall
        || sequence == Sequence::CheckBetCall;
}

bool is_fold(Sequence sequence)
{
    return sequence == Sequence::BetFold || sequence == Sequence::CheckBetFold;
}

std::array<Action, kActionsPerInfoset> legal_actions(Sequence sequence)
{
    switch (sequence)
    {
    case Sequence::Empty:
    case Sequence::Check:
        return {Action::Check, Action::Bet};
    case Sequence::Bet:
    case Sequence::CheckBet:
        return {Action::Fold, Action::Call};
    default:
        fail("legal_actions on terminal sequence");
    }
}

bool is_legal(Sequence sequence, Action action)
{
    if (is_terminal(sequence))
    {
        return false;
    }
    const auto actions = legal_actions(sequence);
    return action == actions[0] || action == actions[1];
}

Sequence apply_action(Sequence sequence, Action action)
{
    switch (sequence)
    {
    case Sequence::Empty:
        if (action == Action::Check)
        {
            return Sequence::Check;
        }
        if (action == Action::Bet)
        {
            return Sequence::Bet;
        }
        break;
    case Sequence::Check:
        if (action == Action::Check)
        {
            return Sequence::CheckCheck;
        }
        if (action == Action::Bet)
        {
            return Sequence::CheckBet;
        }
        break;
    case Sequence::Bet:
        if (action == Action::Fold)
        {
            return Sequence::BetFold;
        }
        if (action == Action::Call)
        {
            return Sequence::BetCall;
        }
        break;
    case Sequence::CheckBet:
        if (action == Action::Fold)
        {
            return Sequence::CheckBetFold;
        }
        if (action == Action::Call)
        {
            return Sequence::CheckBetCall;
        }
        break;
    default:
        break;
    }
    fail("illegal action for sequence");
}

int infoset_id(Player player, Card private_card, Sequence sequence)
{
    const int card = static_cast<int>(private_card);
    if (player == Player::P1)
    {
        if (sequence == Sequence::Empty)
        {
            return card;
        }
        if (sequence == Sequence::CheckBet)
        {
            return 3 + card;
        }
    }
    else
    {
        if (sequence == Sequence::Check)
        {
            return 6 + card;
        }
        if (sequence == Sequence::Bet)
        {
            return 9 + card;
        }
    }
    fail("infoset_id for a sequence that is not a decision of this player");
}

Player infoset_player(int infoset)
{
    return infoset < 6 ? Player::P1 : Player::P2;
}

Card infoset_card(int infoset)
{
    return static_cast<Card>(infoset % 3);
}

bool infoset_is_facing_bet(int infoset)
{
    return (infoset >= 3 && infoset <= 5) || infoset >= 9;
}

std::string infoset_label(int infoset)
{
    std::string label;
    label += player_name(infoset_player(infoset));
    label += ' ';
    label += card_name(infoset_card(infoset));
    if (infoset < 3)
    {
        label += " (first action)";
    }
    else if (infoset < 6)
    {
        label += " (facing bet)";
    }
    else if (infoset < 9)
    {
        label += " (facing check)";
    }
    else
    {
        label += " (facing bet)";
    }
    return label;
}

Action local_action_to_action(int infoset, int local_action)
{
    const bool facing_bet = infoset_is_facing_bet(infoset);
    if (local_action == 0)
    {
        return facing_bet ? Action::Fold : Action::Check;
    }
    return facing_bet ? Action::Call : Action::Bet;
}

int action_to_local_action(int infoset, Action action)
{
    if (infoset_is_facing_bet(infoset))
    {
        if (action == Action::Fold)
        {
            return 0;
        }
        if (action == Action::Call)
        {
            return 1;
        }
    }
    else
    {
        if (action == Action::Check)
        {
            return 0;
        }
        if (action == Action::Bet)
        {
            return 1;
        }
    }
    fail("action not legal at infoset");
}

double p1_contribution(Sequence sequence)
{
    switch (sequence)
    {
    case Sequence::Empty:
    case Sequence::Check:
    case Sequence::CheckCheck:
    case Sequence::CheckBet:
    case Sequence::CheckBetFold:
        return kAnte;
    case Sequence::Bet:
    case Sequence::BetFold:
    case Sequence::BetCall:
    case Sequence::CheckBetCall:
        return kAnte + kBetSize;
    }
    fail("p1_contribution");
}

double p2_contribution(Sequence sequence)
{
    switch (sequence)
    {
    case Sequence::Empty:
    case Sequence::Check:
    case Sequence::CheckCheck:
    case Sequence::Bet:
    case Sequence::BetFold:
        return kAnte;
    case Sequence::BetCall:
    case Sequence::CheckBet:
    case Sequence::CheckBetFold:
    case Sequence::CheckBetCall:
        return kAnte + kBetSize;
    }
    fail("p2_contribution");
}

double pot_size(Sequence sequence)
{
    return p1_contribution(sequence) + p2_contribution(sequence);
}

double p1_utility(Deal deal, Sequence sequence)
{
    if (!cards_distinct(deal))
    {
        fail("duplicate cards in deal");
    }
    if (!is_terminal(sequence))
    {
        fail("p1_utility on non-terminal sequence");
    }

    const double p1_put = p1_contribution(sequence);
    const double p2_put = p2_contribution(sequence);
    const double pot = p1_put + p2_put;

    if (sequence == Sequence::BetFold)
    {
        return pot - p1_put;
    }
    if (sequence == Sequence::CheckBetFold)
    {
        return -p1_put;
    }

    if (card_rank(deal.p1) > card_rank(deal.p2))
    {
        return pot - p1_put;
    }
    return -p1_put;
}

Card private_card(Deal deal, Player player)
{
    return player == Player::P1 ? deal.p1 : deal.p2;
}

Card opponent_card(Deal deal, Player player)
{
    return player == Player::P1 ? deal.p2 : deal.p1;
}

} // namespace poker::kuhn
