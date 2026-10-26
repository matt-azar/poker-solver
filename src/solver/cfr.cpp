#include "solver/cfr.hpp"

#include "solver/best_response.hpp"
#include "solver/regret_matching.hpp"

#include <array>

namespace poker::solver
{
namespace
{

int entry(int infoset, int local_action)
{
    return infoset * poker::kuhn::kActionsPerInfoset + local_action;
}

} // namespace

KuhnCfrTrainer::KuhnCfrTrainer()
    : regret_(poker::kuhn::kStrategyEntries, 0.0)
    , strategy_sum_(poker::kuhn::kStrategyEntries, 0.0)
{
}

std::size_t KuhnCfrTrainer::table_memory_bytes()
{
    return 2 * poker::kuhn::kStrategyEntries * sizeof(double);
}

void KuhnCfrTrainer::iterate()
{
    const auto deals = poker::kuhn::all_deals();
    for (const auto deal : deals)
    {
        cfr(deal, poker::kuhn::Sequence::Empty, 1.0, 1.0, poker::kuhn::kDealProbability);
    }
}

void KuhnCfrTrainer::solve(int iterations)
{
    for (int t = 0; t < iterations; ++t)
    {
        iterate();
    }
}

std::vector<double> KuhnCfrTrainer::average_strategy() const
{
    std::vector<double> out(poker::kuhn::kStrategyEntries, 0.0);
    for (int infoset = 0; infoset < poker::kuhn::kNumInfosets; ++infoset)
    {
        normalize_average(
            strategy_sum_.data() + entry(infoset, 0),
            out.data() + entry(infoset, 0),
            poker::kuhn::kActionsPerInfoset);
    }
    return out;
}

double KuhnCfrTrainer::expected_p1_utility() const
{
    return solver::expected_p1_utility(average_strategy());
}

SolveStats KuhnCfrTrainer::evaluate() const
{
    return evaluate_average_strategy(average_strategy());
}

double KuhnCfrTrainer::cfr(poker::kuhn::Deal deal,
                           poker::kuhn::Sequence sequence,
                           double pi1,
                           double pi2,
                           double pi_chance)
{
    using namespace poker::kuhn;

    if (is_terminal(sequence))
    {
        return p1_utility(deal, sequence);
    }

    const Player player = player_to_act(sequence);
    const Card card = private_card(deal, player);
    const int infoset = infoset_id(player, card, sequence);
    const auto actions = legal_actions(sequence);

    std::array<double, kActionsPerInfoset> sigma{};
    regret_matching(
        regret_.data() + entry(infoset, 0),
        sigma.data(),
        kActionsPerInfoset);

    const double reach_i = player == Player::P1 ? pi1 : pi2;
    accumulate_average(
        strategy_sum_.data() + entry(infoset, 0),
        sigma.data(),
        kActionsPerInfoset,
        reach_i);

    std::array<double, kActionsPerInfoset> action_util{};
    double node_util = 0.0;
    for (int a = 0; a < kActionsPerInfoset; ++a)
    {
        const Sequence child = apply_action(sequence, actions[a]);
        if (player == Player::P1)
        {
            action_util[a] = cfr(deal, child, pi1 * sigma[a], pi2, pi_chance);
        }
        else
        {
            action_util[a] = cfr(deal, child, pi1, pi2 * sigma[a], pi_chance);
        }
        node_util += sigma[a] * action_util[a];
    }

    const double opp_cf = (player == Player::P1 ? pi2 : pi1) * pi_chance;
    for (int a = 0; a < kActionsPerInfoset; ++a)
    {
        const double instant = player == Player::P1
            ? (action_util[a] - node_util)
            : (node_util - action_util[a]);
        regret_[entry(infoset, a)] += opp_cf * instant;
    }

    return node_util;
}

double traverse_expected_p1(poker::kuhn::Deal deal,
                            poker::kuhn::Sequence sequence,
                            const std::vector<double>& strategy)
{
    using namespace poker::kuhn;

    if (is_terminal(sequence))
    {
        return p1_utility(deal, sequence);
    }

    const Player player = player_to_act(sequence);
    const int infoset = infoset_id(player, private_card(deal, player), sequence);
    const auto actions = legal_actions(sequence);

    double util = 0.0;
    for (int a = 0; a < kActionsPerInfoset; ++a)
    {
        const double p = strategy[entry(infoset, a)];
        util += p * traverse_expected_p1(deal, apply_action(sequence, actions[a]), strategy);
    }
    return util;
}

double expected_p1_utility(const std::vector<double>& strategy)
{
    double util = 0.0;
    for (const auto deal : poker::kuhn::all_deals())
    {
        util += poker::kuhn::kDealProbability
            * traverse_expected_p1(deal, poker::kuhn::Sequence::Empty, strategy);
    }
    return util;
}

} // namespace poker::solver
