#include "solver/cfr.hpp"

#include "solver/best_response.hpp"

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
    : trainer_(poker::kuhn::KuhnGame{}, Algorithm::VanillaCfr)
{
}

void KuhnCfrTrainer::iterate()
{
    trainer_.run_iterations(1);
}

void KuhnCfrTrainer::solve(int iterations)
{
    trainer_.run_iterations(iterations);
}

std::vector<double> KuhnCfrTrainer::average_strategy() const
{
    return trainer_.average_strategy();
}

double KuhnCfrTrainer::expected_p1_utility() const
{
    return solver::expected_p1_utility(average_strategy());
}

SolveStats KuhnCfrTrainer::evaluate() const
{
    return evaluate_average_strategy(average_strategy());
}

const std::vector<double>& KuhnCfrTrainer::regrets() const
{
    return trainer_.regrets();
}

const std::vector<double>& KuhnCfrTrainer::strategy_sum() const
{
    return trainer_.strategy_sum();
}

std::size_t KuhnCfrTrainer::table_memory_bytes()
{
    CfrTrainer<poker::kuhn::KuhnGame> probe(poker::kuhn::KuhnGame{}, Algorithm::VanillaCfr);
    return probe.memory_bytes_estimate();
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
    for (int action = 0; action < kActionsPerInfoset; ++action)
    {
        const double probability = strategy[static_cast<std::size_t>(entry(infoset, action))];
        util += probability * traverse_expected_p1(
            deal, apply_action(sequence, actions[static_cast<std::size_t>(action)]), strategy);
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
