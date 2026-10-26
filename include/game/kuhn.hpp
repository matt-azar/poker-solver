#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <string_view>

namespace poker::kuhn
{

enum class Card : std::uint8_t
{
    Jack = 0,
    Queen = 1,
    King = 2
};

enum class Player : std::uint8_t
{
    P1 = 0,
    P2 = 1
};

enum class Action : std::uint8_t
{
    Check = 0,
    Bet = 1,
    Fold = 2,
    Call = 3
};

enum class Sequence : std::uint8_t
{
    Empty = 0,
    Check = 1,
    Bet = 2,
    CheckCheck = 3,
    CheckBet = 4,
    BetFold = 5,
    BetCall = 6,
    CheckBetFold = 7,
    CheckBetCall = 8
};

struct Deal
{
    Card p1;
    Card p2;
};

inline constexpr int kNumCards = 3;
inline constexpr int kNumDeals = 6;
inline constexpr int kNumInfosets = 12;
inline constexpr int kActionsPerInfoset = 2;
inline constexpr int kStrategyEntries = kNumInfosets * kActionsPerInfoset;
inline constexpr double kAnte = 1.0;
inline constexpr double kBetSize = 1.0;
inline constexpr double kDealProbability = 1.0 / 6.0;
inline constexpr double kEquilibriumP1Value = -1.0 / 18.0;

std::array<Deal, kNumDeals> all_deals();

bool cards_distinct(Deal deal);
int card_rank(Card card);
std::string_view card_name(Card card);
std::string_view action_name(Action action);
std::string_view player_name(Player player);
std::string_view sequence_name(Sequence sequence);

Player player_to_act(Sequence sequence);
bool is_terminal(Sequence sequence);
bool is_showdown(Sequence sequence);
bool is_fold(Sequence sequence);

std::array<Action, kActionsPerInfoset> legal_actions(Sequence sequence);
Sequence apply_action(Sequence sequence, Action action);
bool is_legal(Sequence sequence, Action action);

int infoset_id(Player player, Card private_card, Sequence sequence);
Player infoset_player(int infoset);
Card infoset_card(int infoset);
bool infoset_is_facing_bet(int infoset);
std::string infoset_label(int infoset);
Action local_action_to_action(int infoset, int local_action);
int action_to_local_action(int infoset, Action action);

double pot_size(Sequence sequence);
double p1_contribution(Sequence sequence);
double p2_contribution(Sequence sequence);

// Player 1 net chip utility, including antes. Player 2 utility is the negation.
double p1_utility(Deal deal, Sequence sequence);

Card private_card(Deal deal, Player player);
Card opponent_card(Deal deal, Player player);

} // namespace poker::kuhn
