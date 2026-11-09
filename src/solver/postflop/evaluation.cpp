// StreetBatchSolver::Engine method definitions.
#include "engine.hpp"

namespace poker::solver
{


double StreetBatchSolver::Engine::sum_scratch(const std::pmr::vector<double>& values)
{
    double total = 0.0;
    for (double value : values)
    {
        total += value;
    }
    return total;
}



void StreetBatchSolver::Engine::prepare_response_root() const
{
    response.assign(slots.size(), -1);
    std::fill(workspace.scratch[0].pi0.begin(), workspace.scratch[0].pi0.end(), 1.0);
    std::fill(workspace.scratch[0].pi1.begin(), workspace.scratch[0].pi1.end(), 1.0);
}



double StreetBatchSolver::Engine::utility_of_response(int responding) const
{
    check_usable();
    ensure_ranks();
    const auto started = std::chrono::steady_clock::now();
    ensure_average();
    prepare_response_root();
    response_walk(workspace, 0, -1, -1, 0, responding, false);
    const std::pmr::vector<double>& values = responding == 1
        ? workspace.scratch[0].ev1 : workspace.scratch[0].ev0;
    const double total = sum_scratch(values);
    evaluation_seconds_ += std::chrono::duration<double>(
        std::chrono::steady_clock::now() - started).count();
    return total;
}



EvaluationResult StreetBatchSolver::Engine::evaluate_profile() const
{
    check_usable();
    ensure_ranks();
    const auto started = std::chrono::steady_clock::now();
    ensure_average();
    prepare_response_root();
    response_walk(workspace, 0, -1, -1, 0, -1, false);
    const double u0 = sum_scratch(workspace.scratch[0].ev0);
    const double u1 = sum_scratch(workspace.scratch[0].ev1);
    prepare_response_root();
    response_walk(workspace, 0, -1, -1, 0, 0, false);
    const double br0 = sum_scratch(workspace.scratch[0].ev0);
    prepare_response_root();
    response_walk(workspace, 0, -1, -1, 0, 1, false);
    const double br1 = sum_scratch(workspace.scratch[0].ev1);
    evaluation_seconds_ += std::chrono::duration<double>(
        std::chrono::steady_clock::now() - started).count();
    return make_evaluation(u0, u1, br0, br1);
}



void StreetBatchSolver::Engine::build_reach_table()
{
    board_mask = 0;
    for (int card : config.board)
    {
        board_mask |= std::uint64_t{1} << card;
    }
    budget_->set_stage("ranges");
    const holdem::Range* ranges[2] = {&config.oop, &config.ip};
    for (int player = 0; player < 2; ++player)
    {
        mask[player].assign(combos[player].size(), 0);
        range_w[player].assign(combos[player].size(), 0.0);
        hole_a[player].assign(combos[player].size(), 0);
        hole_b[player].assign(combos[player].size(), 0);
        hand_of[player].assign(static_cast<std::size_t>(holdem::kComboCount), -1);
        for (std::size_t hand = 0; hand < combos[player].size(); ++hand)
        {
            int c0 = 0;
            int c1 = 0;
            const int combo = combos[player][hand];
            holdem::Range::combo_cards(combo, c0, c1);
            mask[player][hand] = (std::uint64_t{1} << c0) | (std::uint64_t{1} << c1);
            hole_a[player][hand] = c0;
            hole_b[player][hand] = c1;
            range_w[player][hand] = ranges[player]->weight(combo);
            hand_of[player][static_cast<std::size_t>(combo)] = static_cast<int>(hand);
        }
    }
    for (int player = 0; player < 2; ++player)
    {
        const int opponent = 1 - player;
        twin_hand[player].assign(combos[player].size(), -1);
        for (std::size_t hand = 0; hand < combos[player].size(); ++hand)
        {
            const int combo = combos[player][hand];
            twin_hand[player][hand] = hand_of[opponent][static_cast<std::size_t>(combo)];
        }
    }
    if (joint_mass_ <= 0.0)
    {
        throw std::logic_error("street ranges have no joint weight");
    }
    joint_scale = 1.0 / joint_mass_;
    prepare_context(workspace);
    budget_->set_stage("response");
    response.assign(slots.size(), -1);
    prepare_rank_cache();
}



StreetBatchSolver::Engine::Continuation StreetBatchSolver::Engine::player_continuation(
    int node_index,
    int turn,
    int river,
    const std::vector<double>& q0,
    const std::vector<double>& q1,
    int player,
    const std::atomic<bool>* cancel) const
{
    const int opponent = 1 - player;
    const int hero_hands = player == 0 ? n0 : n1;
    const int opp_hands = opponent == 0 ? n0 : n1;
    const std::vector<double>& hero_q = player == 0 ? q0 : q1;
    const std::vector<double>& opp_q = player == 0 ? q1 : q0;
    std::vector<double> strategic[2] = {
        std::vector<double>(static_cast<std::size_t>(n0), 0.0),
        std::vector<double>(static_cast<std::size_t>(n1), 0.0)};
    const std::vector<double>* weight[2] = {&q0, &q1};
    for (int who = 0; who < 2; ++who)
    {
        for (int hand = 0; hand < static_cast<int>(strategic[who].size()); ++hand)
        {
            const double prior = range_w[who][static_cast<std::size_t>(hand)];
            if (prior > 0.0)
            {
                strategic[who][static_cast<std::size_t>(hand)] =
                    (*weight[who])[static_cast<std::size_t>(hand)] / prior;
            }
        }
    }
    double peak = 0.0;
    for (int hand = 0; hand < opp_hands; ++hand)
    {
        peak = std::max(
            peak,
            range_w[opponent][static_cast<std::size_t>(hand)]
                * strategic[opponent][static_cast<std::size_t>(hand)]);
    }
    Continuation result;
    if (!(peak > 0.0))
    {
        return result;
    }
    const double reach_scale = 1.0 / peak;
    for (double& value : strategic[opponent])
    {
        value *= reach_scale;
    }
    Scratch& seeded = workspace.scratch[0];
    if (player == 0)
    {
        for (int hand = 0; hand < n0; ++hand)
        {
            seeded.pi0[static_cast<std::size_t>(hand)] =
                hand_supported(0, hand, turn, river) ? 1.0 : 0.0;
        }
        std::copy(strategic[1].begin(), strategic[1].end(), seeded.pi1.begin());
    }
    else
    {
        std::copy(strategic[0].begin(), strategic[0].end(), seeded.pi0.begin());
        for (int hand = 0; hand < n1; ++hand)
        {
            seeded.pi1[static_cast<std::size_t>(hand)] =
                hand_supported(1, hand, turn, river) ? 1.0 : 0.0;
        }
    }
    average_value_walk(workspace, node_index, turn, river, 0, false, false, cancel);
    std::vector<double> amount(static_cast<std::size_t>(opp_hands), 0.0);
    double total = 0.0;
    double by_card[52] = {};
    for (int hand = 0; hand < opp_hands; ++hand)
    {
        if (!hand_live(opponent, hand, turn, river))
        {
            continue;
        }
        const double piece = range_w[opponent][static_cast<std::size_t>(hand)]
            * strategic[opponent][static_cast<std::size_t>(hand)];
        if (piece == 0.0)
        {
            continue;
        }
        amount[static_cast<std::size_t>(hand)] = piece;
        total += piece;
        by_card[hole_a[opponent][static_cast<std::size_t>(hand)]] += piece;
        by_card[hole_b[opponent][static_cast<std::size_t>(hand)]] += piece;
    }
    const Scratch& evaluated = workspace.scratch[0];
    const std::pmr::vector<double>& raw = player == 0 ? evaluated.ev0 : evaluated.ev1;
    std::vector<double> marginal;
    double hand_joint = 0.0;
    marginals_of(hero_q, player, opp_q, opponent, hand_joint, marginal);
    if (!(hand_joint > 0.0))
    {
        return result;
    }
    double node_ev = 0.0;
    bool node_ok = true;
    bool any = false;
    for (int hand = 0; hand < hero_hands; ++hand)
    {
        if (!hand_supported(player, hand, turn, river))
        {
            continue;
        }
        const double open = stable_compatible_mass(
            player, hand, opponent, total, by_card, amount);
        const double prior = range_w[player][static_cast<std::size_t>(hand)];
        if (!(open > 0.0) || !(prior > 0.0))
        {
            if (marginal[static_cast<std::size_t>(hand)] > 0.0)
            {
                node_ok = false;
            }
            continue;
        }
        // ev0 / ev1 hold each seat's own modeled utility (dual-utility).
        const double stored_raw = raw[static_cast<std::size_t>(hand)];
        node_ev += marginal[static_cast<std::size_t>(hand)]
            * (stored_raw / (prior * joint_scale * open));
        any = true;
    }
    result.defined = node_ok && any;
    if (result.defined)
    {
        result.ev = node_ev;
    }
    return result;
}



std::string StreetBatchSolver::Engine::weighted_range(int player, const std::vector<double>& reach) const
{
    std::string text;
    for (int hand = 0; hand < static_cast<int>(reach.size()); ++hand)
    {
        const double weight = reach[static_cast<std::size_t>(hand)];
        if (!(weight > 0.0))
        {
            continue;
        }
        if (!text.empty())
        {
            text.push_back(',');
        }
        text += holdem::Range::combo_text(combos[player][static_cast<std::size_t>(hand)]);
        text.push_back(':');
        text += streets::format_number(weight);
    }
    return text;
}


} // namespace poker::solver
