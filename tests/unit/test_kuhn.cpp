#include "game/kuhn.hpp"
#include "harness.hpp"

#include <set>
#include <utility>
#include <vector>

namespace
{

using namespace poker::kuhn;

void walk_terminals(Deal deal, Sequence sequence, std::vector<Sequence>& terminals)
{
    if (is_terminal(sequence))
    {
        terminals.push_back(sequence);
        return;
    }
    for (Action action : legal_actions(sequence))
    {
        walk_terminals(deal, apply_action(sequence, action), terminals);
    }
}

} // namespace

void run_kuhn_tests()
{
    using namespace poker::kuhn;

    const auto deals = all_deals();
    CHECK(deals.size() == 6);

    std::set<std::pair<int, int>> unique_deals;
    for (const auto deal : deals)
    {
        CHECK(cards_distinct(deal));
        unique_deals.emplace(card_rank(deal.p1), card_rank(deal.p2));
    }
    CHECK(unique_deals.size() == 6);

    CHECK(player_to_act(Sequence::Empty) == Player::P1);
    CHECK(player_to_act(Sequence::Check) == Player::P2);
    CHECK(player_to_act(Sequence::Bet) == Player::P2);
    CHECK(player_to_act(Sequence::CheckBet) == Player::P1);

    const auto first = legal_actions(Sequence::Empty);
    CHECK(first[0] == Action::Check);
    CHECK(first[1] == Action::Bet);
    const auto facing = legal_actions(Sequence::Bet);
    CHECK(facing[0] == Action::Fold);
    CHECK(facing[1] == Action::Call);

    CHECK(apply_action(Sequence::Empty, Action::Check) == Sequence::Check);
    CHECK(apply_action(Sequence::Empty, Action::Bet) == Sequence::Bet);
    CHECK(apply_action(Sequence::Check, Action::Check) == Sequence::CheckCheck);
    CHECK(apply_action(Sequence::Check, Action::Bet) == Sequence::CheckBet);
    CHECK(apply_action(Sequence::Bet, Action::Fold) == Sequence::BetFold);
    CHECK(apply_action(Sequence::Bet, Action::Call) == Sequence::BetCall);
    CHECK(apply_action(Sequence::CheckBet, Action::Fold) == Sequence::CheckBetFold);
    CHECK(apply_action(Sequence::CheckBet, Action::Call) == Sequence::CheckBetCall);

    CHECK(p1_contribution(Sequence::CheckBet) == 1.0);
    CHECK(p2_contribution(Sequence::CheckBet) == 2.0);
    CHECK(p1_contribution(Sequence::CheckBetFold) == 1.0);
    CHECK(p2_contribution(Sequence::CheckBetFold) == 2.0);
    CHECK(p1_contribution(Sequence::Bet) == 2.0);
    CHECK(p2_contribution(Sequence::Bet) == 1.0);
    CHECK(pot_size(Sequence::CheckCheck) == 2.0);
    CHECK(pot_size(Sequence::BetCall) == 4.0);
    CHECK(pot_size(Sequence::CheckBetCall) == 4.0);
    CHECK(pot_size(Sequence::BetFold) == 3.0);

    const Deal jq{Card::Jack, Card::Queen};
    CHECK_NEAR(p1_utility(jq, Sequence::CheckCheck), -1.0, 1e-12);
    CHECK_NEAR(p1_utility(Deal{Card::Queen, Card::Jack}, Sequence::CheckCheck), 1.0, 1e-12);
    CHECK_NEAR(p1_utility(jq, Sequence::BetCall), -2.0, 1e-12);
    CHECK_NEAR(p1_utility(Deal{Card::King, Card::Jack}, Sequence::BetCall), 2.0, 1e-12);
    CHECK_NEAR(p1_utility(jq, Sequence::BetFold), 1.0, 1e-12);
    CHECK_NEAR(p1_utility(jq, Sequence::CheckBetFold), -1.0, 1e-12);

    for (const auto deal : deals)
    {
        std::vector<Sequence> terminals;
        walk_terminals(deal, Sequence::Empty, terminals);
        CHECK(terminals.size() == 5);
        for (Sequence sequence : terminals)
        {
            const double u1 = p1_utility(deal, sequence);
            const double u2 = -u1;
            CHECK_NEAR(u1 + u2, 0.0, 1e-12);
        }
    }

    for (const auto deal : deals)
    {
        const int id_a = infoset_id(Player::P1, deal.p1, Sequence::Empty);
        CHECK(id_a == static_cast<int>(deal.p1));
        CHECK(infoset_id(Player::P1, deal.p1, Sequence::Empty)
              == infoset_id(Player::P1, deal.p1, Sequence::Empty));
        CHECK(infoset_card(id_a) == deal.p1);
        CHECK(infoset_player(id_a) == Player::P1);

        const int id_p2 = infoset_id(Player::P2, deal.p2, Sequence::Check);
        CHECK(infoset_card(id_p2) == deal.p2);
        CHECK(infoset_player(id_p2) == Player::P2);
    }

    const int p1_jack_empty_vs_q = infoset_id(Player::P1, Card::Jack, Sequence::Empty);
    const int p1_jack_empty_vs_k = infoset_id(Player::P1, Card::Jack, Sequence::Empty);
    CHECK(p1_jack_empty_vs_q == p1_jack_empty_vs_k);
    CHECK(p1_jack_empty_vs_q != infoset_id(Player::P1, Card::Queen, Sequence::Empty));
    CHECK(infoset_id(Player::P1, Card::Jack, Sequence::CheckBet)
          != infoset_id(Player::P1, Card::Jack, Sequence::Empty));

    CHECK(!infoset_is_facing_bet(0));
    CHECK(infoset_is_facing_bet(3));
    CHECK(!infoset_is_facing_bet(6));
    CHECK(infoset_is_facing_bet(9));
}
