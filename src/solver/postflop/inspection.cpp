// StreetBatchSolver::Engine method definitions.
#include "engine.hpp"

namespace poker::solver
{


bool StreetBatchSolver::Engine::implicit_infoset_action(const std::string& infoset, const std::string& action) const
{
    if (planned_implicit_ == 0)
    {
        return false;
    }
    std::vector<StreetStrategyEntry> implicit;
    append_implicit_strategy_entries(implicit);
    for (const StreetStrategyEntry& entry : implicit)
    {
        if (entry.infoset == infoset && entry.action == action)
        {
            return true;
        }
    }
    return false;
}



bool StreetBatchSolver::Engine::assign_labeled_regret(const std::string& infoset, const std::string& action, double value)
{
    for (const Slot& slot : slots)
    {
        if (slot_label(slot) != infoset)
        {
            continue;
        }
        const Node& node = nodes[static_cast<std::size_t>(slot.node)];
        for (int index = 0; index < slot_action_count(slot); ++index)
        {
            if (std::string_view(node.action_labels[index]) != action)
            {
                continue;
            }
            regret[static_cast<std::size_t>(slot.base + index)] = value;
            average_ready = false;
            return true;
        }
    }
    // One-action infosets have no row; only the fixed zero regret is accepted.
    return implicit_infoset_action(infoset, action) && value == 0.0;
}



bool StreetBatchSolver::Engine::read_labeled_regret(const std::string& infoset, const std::string& action, double& value) const
{
    for (const Slot& slot : slots)
    {
        if (slot_label(slot) != infoset)
        {
            continue;
        }
        const Node& node = nodes[static_cast<std::size_t>(slot.node)];
        for (int index = 0; index < slot_action_count(slot); ++index)
        {
            if (std::string_view(node.action_labels[index]) != action)
            {
                continue;
            }
            value = regret[static_cast<std::size_t>(slot.base + index)];
            return true;
        }
    }
    if (implicit_infoset_action(infoset, action))
    {
        value = 0.0;
        return true;
    }
    return false;
}



void StreetBatchSolver::Engine::fill_inspection_betting(
    StreetInspection& view,
    const BetState& state,
    int node_index,
    int turn,
    int river) const
{
    view.pot = state.pot;
    view.contrib[0] = state.contrib[0];
    view.contrib[1] = state.contrib[1];
    view.stacks[0] = config.stack - state.contrib[0];
    view.stacks[1] = config.stack - state.contrib[1];
    const Node& node = nodes[static_cast<std::size_t>(node_index)];
    if (!node.terminal && !node.chance && state.acting >= 0)
    {
        view.to_call = state.committed - state.contrib[state.acting];
        if (view.to_call < 0)
        {
            view.to_call = 0;
        }
    }
    else
    {
        view.to_call = 0;
    }
    const ParentLink& link = parent_link[static_cast<std::size_t>(node_index)];
    if (link.parent >= 0)
    {
        int parent_turn = turn;
        int parent_river = river;
        if (link.from_chance)
        {
            const Node& parent = nodes[static_cast<std::size_t>(link.parent)];
            if (parent.deal_which == 1)
            {
                parent_turn = -1;
            }
            else
            {
                parent_river = -1;
            }
        }
        view.parent_id = node_id(link.parent, parent_turn, parent_river);
    }
}



void StreetBatchSolver::Engine::fill_opponent_hands(
    StreetInspection& view,
    int opponent,
    const std::vector<double>& reach,
    const std::vector<double>& other,
    int seen_turn,
    int seen_river) const
{
    view.opponent_player = opponent;
    double hand_joint = 0.0;
    std::vector<double> marginal;
    marginals_of(reach, opponent, other, 1 - opponent, hand_joint, marginal);
    const int hands = opponent == 0 ? n0 : n1;
    view.opponent_hands.resize(static_cast<std::size_t>(hands));
    for (int hand = 0; hand < hands; ++hand)
    {
        StreetInspectHand row;
        const int combo = combos[opponent][static_cast<std::size_t>(hand)];
        row.combo = holdem::Range::combo_text(combo);
        row.structural = hand_supported(opponent, hand, seen_turn, seen_river);
        row.reach = row.structural ? reach[static_cast<std::size_t>(hand)] : 0.0;
        if (view.reach_defined)
        {
            row.marginal = marginal[static_cast<std::size_t>(hand)];
        }
        view.opponent_hands[static_cast<std::size_t>(hand)] = std::move(row);
    }
}



StreetInspection StreetBatchSolver::Engine::inspect_node(const std::string& text) const
{
    ensure_average();
    int node_index = 0;
    int target_turn = -1;
    int target_river = -1;
    locate_node(text, node_index, target_turn, target_river);
    std::vector<int> chain;
    for (int at = node_index; at >= 0; at = parent_link[static_cast<std::size_t>(at)].parent)
    {
        chain.push_back(at);
        if (chain.size() > nodes.size())
        {
            throw std::logic_error("node parent cycle");
        }
    }
    std::reverse(chain.begin(), chain.end());
    if (chain.empty() || chain.front() != 0)
    {
        throw std::invalid_argument("unknown node");
    }

    std::vector<double> q0(range_w[0].begin(), range_w[0].end());
    std::vector<double> q1(range_w[1].begin(), range_w[1].end());
    int seen_turn = -1;
    int seen_river = -1;
    zero_unsupported(q0, 0, seen_turn, seen_river);
    zero_unsupported(q1, 1, seen_turn, seen_river);
    std::string line;
    for (std::size_t step = 0; step + 1 < chain.size(); ++step)
    {
        const int current = chain[step];
        const int next = chain[step + 1];
        const Node& node = nodes[static_cast<std::size_t>(current)];
        const ParentLink& edge = parent_link[static_cast<std::size_t>(next)];
        if (edge.parent != current)
        {
            throw std::logic_error("node parent chain broke");
        }
        if (node.chance)
        {
            const int card = node.deal_which == 1 ? target_turn : target_river;
            if (card < 0)
            {
                throw std::invalid_argument("node card is dead or out of range");
            }
            zero_card(q0, 0, card);
            zero_card(q1, 1, card);
            if (node.deal_which == 1)
            {
                seen_turn = card;
            }
            else
            {
                seen_river = card;
            }
            zero_unsupported(q0, 0, seen_turn, seen_river);
            zero_unsupported(q1, 1, seen_turn, seen_river);
        }
        else
        {
            const int action = edge.action;
            std::vector<double>& acting = node.player == 0 ? q0 : q1;
            for (int hand = 0; hand < static_cast<int>(acting.size()); ++hand)
            {
                if (!hand_supported(node.player, hand, seen_turn, seen_river))
                {
                    acting[static_cast<std::size_t>(hand)] = 0.0;
                    continue;
                }
                if (node.n_actions <= 1)
                {
                    continue;
                }
                const int slot = stored_slot(node, hand, seen_turn, seen_river);
                if (slot < 0)
                {
                    throw std::logic_error("supported hand has no information set");
                }
                acting[static_cast<std::size_t>(hand)] *= sigma[static_cast<std::size_t>(
                    slots[static_cast<std::size_t>(slot)].base + action)];
            }
            const std::string label(
                node.action_labels[action].data(), node.action_labels[action].size());
            if (line.empty())
            {
                line = label;
            }
            else
            {
                line.push_back('/');
                line += label;
            }
        }
    }
    if (seen_turn != target_turn || seen_river != target_river)
    {
        throw std::invalid_argument("unknown node");
    }

    const BetState betting = betting_state_along(chain);
    const Node& node = nodes[static_cast<std::size_t>(node_index)];
    StreetInspection view;
    view.node_id = text;
    view.line = line.empty() ? "open" : line;
    for (int card : config.board)
    {
        view.board.push_back(holdem::format_card(card));
    }
    if (seen_turn >= 0)
    {
        view.board.push_back(holdem::format_card(seen_turn));
    }
    if (seen_river >= 0)
    {
        view.board.push_back(holdem::format_card(seen_river));
    }
    fill_inspection_betting(view, betting, node_index, seen_turn, seen_river);
    const double joint = joint_mass_of(q0, q1);
    view.joint = joint;
    view.reach_defined = joint > 0.0;
    if (node.terminal)
    {
        view.kind = "terminal";
        view.folded = node.folded;
        view.place = place_text(node.street, seen_turn, seen_river);
        return view;
    }
    if (node.chance)
    {
        view.kind = "chance";
        view.place = node.deal_which == 1 ? "deal turn" : "deal river";
        bool dealt[52] = {};
        for (int card : config.board)
        {
            dealt[card] = true;
        }
        if (seen_turn >= 0)
        {
            dealt[seen_turn] = true;
        }
        if (seen_river >= 0)
        {
            dealt[seen_river] = true;
        }
        double occupied[52] = {};
        int board_count = 0;
        int next_cards = 0;
        if (view.reach_defined)
        {
            double marginal_joint = 0.0;
            std::vector<double> marginal0;
            std::vector<double> marginal1;
            marginals_of(q0, 0, q1, 1, marginal_joint, marginal0);
            marginals_of(q1, 1, q0, 0, marginal_joint, marginal1);
            for (int hand = 0; hand < n0; ++hand)
            {
                const double weight = marginal0[static_cast<std::size_t>(hand)];
                occupied[hole_a[0][static_cast<std::size_t>(hand)]] += weight;
                occupied[hole_b[0][static_cast<std::size_t>(hand)]] += weight;
            }
            for (int hand = 0; hand < n1; ++hand)
            {
                const double weight = marginal1[static_cast<std::size_t>(hand)];
                occupied[hole_a[1][static_cast<std::size_t>(hand)]] += weight;
                occupied[hole_b[1][static_cast<std::size_t>(hand)]] += weight;
            }
            for (int card = 0; card < 52; ++card)
            {
                if (dealt[card])
                {
                    ++board_count;
                }
            }
            next_cards = 52 - board_count - 4;
            if (next_cards <= 0)
            {
                throw std::logic_error("chance node has no next card");
            }
        }
        const int child = node.child[0];
        for (int card = 0; card < 52; ++card)
        {
            if (dealt[card])
            {
                continue;
            }
            StreetInspectCard choice;
            choice.card = holdem::format_card(card);
            const int next_turn = node.deal_which == 1 ? card : seen_turn;
            const int next_river = node.deal_which == 1 ? seen_river : card;
            choice.child_id = node_id(child, next_turn, next_river);
            choice.weight_defined = view.reach_defined;
            if (choice.weight_defined)
            {
                choice.weight = (1.0 - occupied[card]) / static_cast<double>(next_cards);
            }
            view.cards.push_back(std::move(choice));
        }
        return view;
    }

    view.kind = "decision";
    view.player = node.player;
    view.place = place_text(node.street, seen_turn, seen_river);
    if (!node.path.empty())
    {
        view.line.assign(node.path.data(), node.path.size());
    }
    for (int action = 0; action < node.n_actions; ++action)
    {
        StreetInspectAction item;
        item.label.assign(node.action_labels[action].data(), node.action_labels[action].size());
        item.child_id = node_id(node.child[action], seen_turn, seen_river);
        view.actions.push_back(std::move(item));
    }
    const std::vector<double>& reach = node.player == 0 ? q0 : q1;
    const std::vector<double>& other = node.player == 0 ? q1 : q0;
    double hand_joint = 0.0;
    std::vector<double> marginal;
    marginals_of(reach, node.player, other, 1 - node.player, hand_joint, marginal);
    view.joint = hand_joint;
    view.reach_defined = hand_joint > 0.0;
    const int hands = node.player == 0 ? n0 : n1;
    view.hands.resize(static_cast<std::size_t>(hands));
    for (int hand = 0; hand < hands; ++hand)
    {
        StreetInspectHand row;
        const int combo = combos[node.player][static_cast<std::size_t>(hand)];
        row.combo = holdem::Range::combo_text(combo);
        row.structural = hand_supported(node.player, hand, seen_turn, seen_river);
        row.reach = row.structural ? reach[static_cast<std::size_t>(hand)] : 0.0;
        if (view.reach_defined)
        {
            row.marginal = marginal[static_cast<std::size_t>(hand)];
        }
        if (row.structural)
        {
            if (node.n_actions <= 1)
            {
                row.strategy.assign(1, 1.0);
            }
            else
            {
                const int slot = stored_slot(node, hand, seen_turn, seen_river);
                if (slot < 0)
                {
                    throw std::logic_error("supported hand has no information set");
                }
                const Slot& stored = slots[static_cast<std::size_t>(slot)];
                row.strategy.resize(static_cast<std::size_t>(slot_action_count(stored)));
                for (int action = 0; action < slot_action_count(stored); ++action)
                {
                    row.strategy[static_cast<std::size_t>(action)] =
                        sigma[static_cast<std::size_t>(stored.base + action)];
                }
            }
        }
        view.hands[static_cast<std::size_t>(hand)] = std::move(row);
    }
    fill_opponent_hands(
        view, 1 - node.player, other, reach, seen_turn, seen_river);
    return view;
}



void StreetBatchSolver::Engine::set_average_strategy(const std::string& text, int hand, std::span<const double> probability)
{
    ensure_average();
    int node_index = 0;
    int turn = -1;
    int river = -1;
    locate_node(text, node_index, turn, river);
    const Node& node = nodes[static_cast<std::size_t>(node_index)];
    if (node.chance || node.terminal)
    {
        throw std::invalid_argument("sigma applies to a decision node");
    }
    const int hands = node.player == 0 ? n0 : n1;
    if (hand < 0 || hand >= hands || static_cast<int>(probability.size()) != node.n_actions)
    {
        throw std::invalid_argument("sigma hand or action count");
    }
    if (!validate_strategy_probs(probability, node.n_actions))
    {
        throw std::invalid_argument("invalid strategy probability row");
    }
    if (!hand_supported(node.player, hand, turn, river))
    {
        throw std::invalid_argument("hand has no information set on this node");
    }
    if (node.n_actions <= 1)
    {
        if (probability.size() != 1 || !(std::abs(probability[0] - 1.0) <= 1e-12))
        {
            throw std::invalid_argument("one-action nodes are fixed at probability 1");
        }
        average_ready = true;
        return;
    }
    const int slot = stored_slot(node, hand, turn, river);
    if (slot < 0)
    {
        throw std::logic_error("supported hand has no information set");
    }
    const Slot& stored = slots[static_cast<std::size_t>(slot)];
    for (int action = 0; action < slot_action_count(stored); ++action)
    {
        sigma[static_cast<std::size_t>(stored.base + action)] = static_cast<TableScalar>(
            probability[static_cast<std::size_t>(action)]);
    }
    average_ready = true;
}



void StreetBatchSolver::Engine::invalidate_prepared_average()
{
    average_ready = false;
}



void StreetBatchSolver::Engine::set_average_for_test(const std::string& text, int hand, std::span<const double> probability)
{
    set_average_strategy(text, hand, probability);
}



void StreetBatchSolver::Engine::replay_weights(
    int node_index,
    int turn,
    int river,
    std::vector<double>& q0,
    std::vector<double>& q1) const
{
    std::vector<int> chain;
    for (int at = node_index; at >= 0; at = parent_link[static_cast<std::size_t>(at)].parent)
    {
        chain.push_back(at);
        if (chain.size() > nodes.size())
        {
            throw std::logic_error("node parent cycle");
        }
    }
    std::reverse(chain.begin(), chain.end());
    if (chain.empty() || chain.front() != 0)
    {
        throw std::invalid_argument("unknown node");
    }
    q0.assign(range_w[0].begin(), range_w[0].end());
    q1.assign(range_w[1].begin(), range_w[1].end());
    int seen_turn = -1;
    int seen_river = -1;
    zero_unsupported(q0, 0, seen_turn, seen_river);
    zero_unsupported(q1, 1, seen_turn, seen_river);
    for (std::size_t step = 0; step + 1 < chain.size(); ++step)
    {
        const int current = chain[step];
        const int next = chain[step + 1];
        const Node& node = nodes[static_cast<std::size_t>(current)];
        const ParentLink& edge = parent_link[static_cast<std::size_t>(next)];
        if (edge.parent != current)
        {
            throw std::logic_error("node parent chain broke");
        }
        if (node.chance)
        {
            const int card = node.deal_which == 1 ? turn : river;
            if (card < 0)
            {
                throw std::invalid_argument("node card is dead or out of range");
            }
            zero_card(q0, 0, card);
            zero_card(q1, 1, card);
            if (node.deal_which == 1)
            {
                seen_turn = card;
            }
            else
            {
                seen_river = card;
            }
            zero_unsupported(q0, 0, seen_turn, seen_river);
            zero_unsupported(q1, 1, seen_turn, seen_river);
        }
        else
        {
            const int action = edge.action;
            std::vector<double>& acting = node.player == 0 ? q0 : q1;
            for (int hand = 0; hand < static_cast<int>(acting.size()); ++hand)
            {
                if (!hand_supported(node.player, hand, seen_turn, seen_river))
                {
                    acting[static_cast<std::size_t>(hand)] = 0.0;
                    continue;
                }
                if (node.n_actions <= 1)
                {
                    continue;
                }
                const int slot = stored_slot(node, hand, seen_turn, seen_river);
                if (slot < 0)
                {
                    throw std::logic_error("supported hand has no information set");
                }
                acting[static_cast<std::size_t>(hand)] *= sigma[static_cast<std::size_t>(
                    slots[static_cast<std::size_t>(slot)].base + action)];
            }
        }
    }
    if (seen_turn != turn || seen_river != river)
    {
        throw std::invalid_argument("unknown node");
    }
}



StreetActionValues StreetBatchSolver::Engine::compute_action_values(
    const std::string& text,
    const std::atomic<bool>* cancel) const
{
    const auto started = std::chrono::steady_clock::now();
    ensure_average();
    ensure_ranks();
    int node_index = 0;
    int turn = -1;
    int river = -1;
    locate_node(text, node_index, turn, river);
    const Node& node = nodes[static_cast<std::size_t>(node_index)];
    if (node.chance || node.terminal)
    {
        throw std::invalid_argument("action values require a decision node");
    }
    std::vector<double> q0;
    std::vector<double> q1;
    replay_weights(node_index, turn, river, q0, q1);
    const int actor = node.player;
    const int opponent = 1 - actor;
    const int hero_hands = actor == 0 ? n0 : n1;
    const int opp_hands = opponent == 0 ? n0 : n1;
    std::vector<double> strategic[2] = {
        std::vector<double>(static_cast<std::size_t>(n0), 0.0),
        std::vector<double>(static_cast<std::size_t>(n1), 0.0)};
    const std::vector<double>* weight[2] = {&q0, &q1};
    for (int player = 0; player < 2; ++player)
    {
        for (int hand = 0; hand < static_cast<int>(strategic[player].size()); ++hand)
        {
            const double prior = range_w[player][static_cast<std::size_t>(hand)];
            if (prior > 0.0)
            {
                strategic[player][static_cast<std::size_t>(hand)] =
                    (*weight[player])[static_cast<std::size_t>(hand)] / prior;
            }
        }
    }
    StreetActionValues page;
    page.node_id = text;
    page.player = actor;
    page.reach_defined = joint_mass_of(q0, q1) > 0.0;
    page.actions.resize(static_cast<std::size_t>(node.n_actions));
    for (int action = 0; action < node.n_actions; ++action)
    {
        page.actions[static_cast<std::size_t>(action)].assign(
            node.action_labels[action].data(), node.action_labels[action].size());
    }
    page.combos.resize(static_cast<std::size_t>(hero_hands));
    for (int hand = 0; hand < hero_hands; ++hand)
    {
        page.combos[static_cast<std::size_t>(hand)] = holdem::Range::combo_text(
            combos[actor][static_cast<std::size_t>(hand)]);
    }
    page.ev_defined.assign(static_cast<std::size_t>(hero_hands), 0);
    page.action_ev.assign(static_cast<std::size_t>(hero_hands * node.n_actions), 0.0);
    page.mixed_ev.assign(static_cast<std::size_t>(hero_hands), 0.0);

    double peak = 0.0;
    for (int hand = 0; hand < opp_hands; ++hand)
    {
        peak = std::max(
            peak,
            range_w[opponent][static_cast<std::size_t>(hand)]
                * strategic[opponent][static_cast<std::size_t>(hand)]);
    }
    if (!(peak > 0.0))
    {
        page.query_seconds = std::chrono::duration<double>(
            std::chrono::steady_clock::now() - started).count();
        return page;
    }
    const double reach_scale = 1.0 / peak;
    for (double& value : strategic[opponent])
    {
        value *= reach_scale;
    }

    Scratch& seeded = workspace.scratch[0];
    if (actor == 0)
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
    average_value_walk(workspace, node_index, turn, river, 0, true, cancel);

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
    const std::pmr::vector<double>& raw = actor == 0 ? evaluated.aev0 : evaluated.aev1;
    const int raw_stride = actor == 0 ? n0 : n1;
    std::vector<double> marginal;
    double hand_joint = 0.0;
    const std::vector<double>& hero_weight = actor == 0 ? q0 : q1;
    const std::vector<double>& opp_weight = actor == 0 ? q1 : q0;
    marginals_of(hero_weight, actor, opp_weight, opponent, hand_joint, marginal);
    double node_ev = 0.0;
    bool node_ok = page.reach_defined;
    for (int hand = 0; hand < hero_hands; ++hand)
    {
        if (!hand_supported(actor, hand, turn, river))
        {
            continue;
        }
        const double open = stable_compatible_mass(
            actor, hand, opponent, total, by_card, amount);
        const double prior = range_w[actor][static_cast<std::size_t>(hand)];
        if (!(open > 0.0) || !(prior > 0.0))
        {
            if (page.reach_defined && marginal[static_cast<std::size_t>(hand)] > 0.0)
            {
                node_ok = false;
            }
            continue;
        }
        int base = -1;
        if (node.n_actions > 1)
        {
            const int slot = stored_slot(node, hand, turn, river);
            if (slot < 0)
            {
                throw std::logic_error("supported hand has no information set");
            }
            base = slots[static_cast<std::size_t>(slot)].base;
        }
        double mixed = 0.0;
        for (int action = 0; action < node.n_actions; ++action)
        {
            // aev0 / aev1 hold each seat's own modeled utility (dual-utility).
            const double stored_raw = raw[static_cast<std::size_t>(action * raw_stride + hand)];
            const double denom = prior * joint_scale * open;
            const double conditional = stored_raw / denom;
            page.action_ev[static_cast<std::size_t>(hand * node.n_actions + action)] = conditional;
            const double played = base < 0
                ? 1.0
                : static_cast<double>(sigma[static_cast<std::size_t>(base + action)]);
            mixed += played * conditional;
        }
        page.ev_defined[static_cast<std::size_t>(hand)] = 1;
        page.mixed_ev[static_cast<std::size_t>(hand)] = mixed;
        if (page.reach_defined)
        {
            node_ev += marginal[static_cast<std::size_t>(hand)] * mixed;
        }
    }
    page.node_ev_defined = node_ok;
    if (node_ok)
    {
        page.node_ev = node_ev;
    }
    // Sunk-cost shift for UI local EV: acting seat's utility if they folded now.
    {
        PlayerPayoff fold_pay = apply_icm_terminal(
            config.icm,
            ChipPayoff::terminal(
                config.pot,
                node.contrib[0],
                node.contrib[1],
                actor,
                0,
                config.rake));
        page.local_offset = -fold_pay.utility[static_cast<std::size_t>(actor)];
    }
    page.query_seconds = std::chrono::duration<double>(
        std::chrono::steady_clock::now() - started).count();
    return page;
}



StreetRunoutValues StreetBatchSolver::Engine::compute_runout_values(
    const std::string& text,
    const std::atomic<bool>* cancel) const
{
    const auto started = std::chrono::steady_clock::now();
    ensure_average();
    ensure_ranks();
    int node_index = 0;
    int turn = -1;
    int river = -1;
    locate_node(text, node_index, turn, river);
    const Node& node = nodes[static_cast<std::size_t>(node_index)];
    if (!node.chance)
    {
        throw std::invalid_argument("runout values require a chance node");
    }
    std::vector<double> q0;
    std::vector<double> q1;
    replay_weights(node_index, turn, river, q0, q1);
    StreetRunoutValues page;
    page.node_id = text;
    const bool reach_defined = joint_mass_of(q0, q1) > 0.0;
    bool dealt[52] = {};
    for (int card : config.board)
    {
        dealt[card] = true;
    }
    if (turn >= 0)
    {
        dealt[turn] = true;
    }
    if (river >= 0)
    {
        dealt[river] = true;
    }
    double occupied[52] = {};
    int next_cards = 0;
    if (reach_defined)
    {
        double marginal_joint = 0.0;
        std::vector<double> marginal0;
        std::vector<double> marginal1;
        marginals_of(q0, 0, q1, 1, marginal_joint, marginal0);
        marginals_of(q1, 1, q0, 0, marginal_joint, marginal1);
        for (int hand = 0; hand < n0; ++hand)
        {
            const double weight = marginal0[static_cast<std::size_t>(hand)];
            occupied[hole_a[0][static_cast<std::size_t>(hand)]] += weight;
            occupied[hole_b[0][static_cast<std::size_t>(hand)]] += weight;
        }
        for (int hand = 0; hand < n1; ++hand)
        {
            const double weight = marginal1[static_cast<std::size_t>(hand)];
            occupied[hole_a[1][static_cast<std::size_t>(hand)]] += weight;
            occupied[hole_b[1][static_cast<std::size_t>(hand)]] += weight;
        }
        int board_count = 0;
        for (int card = 0; card < 52; ++card)
        {
            if (dealt[card])
            {
                ++board_count;
            }
        }
        next_cards = 52 - board_count - 4;
        if (next_cards <= 0)
        {
            throw std::logic_error("chance node has no next card");
        }
    }
    const int child = node.child[0];
    bool parent_ok = reach_defined;
    double parent_oop = 0.0;
    double parent_ip = 0.0;
    for (int card = 0; card < 52; ++card)
    {
        if (dealt[card])
        {
            continue;
        }
        throw_if_cancelled(cancel);
        StreetRunoutCard row;
        row.card = holdem::format_card(card);
        const int next_turn = node.deal_which == 1 ? card : turn;
        const int next_river = node.deal_which == 1 ? river : card;
        row.child_id = node_id(child, next_turn, next_river);
        row.probability_defined = reach_defined;
        if (reach_defined)
        {
            row.probability = (1.0 - occupied[card]) / static_cast<double>(next_cards);
        }
        if (reach_defined && row.probability > 0.0)
        {
            std::vector<double> child_q0 = q0;
            std::vector<double> child_q1 = q1;
            zero_card(child_q0, 0, card);
            zero_card(child_q1, 1, card);
            zero_unsupported(child_q0, 0, next_turn, next_river);
            zero_unsupported(child_q1, 1, next_turn, next_river);
            const Continuation oop = player_continuation(
                child, next_turn, next_river, child_q0, child_q1, 0, cancel);
            const Continuation ip = player_continuation(
                child, next_turn, next_river, child_q0, child_q1, 1, cancel);
            row.ev_defined = oop.defined && ip.defined;
            if (row.ev_defined)
            {
                row.oop_ev = oop.ev;
                row.ip_ev = ip.ev;
                parent_oop += row.probability * row.oop_ev;
                parent_ip += row.probability * row.ip_ev;
            }
            else
            {
                parent_ok = false;
            }
        }
        else if (reach_defined && row.probability == 0.0)
        {
            row.ev_defined = false;
        }
        else
        {
            parent_ok = false;
        }
        page.cards.push_back(std::move(row));
    }
    page.parent_ev_defined = parent_ok;
    if (parent_ok)
    {
        page.parent_oop_ev = parent_oop;
        page.parent_ip_ev = parent_ip;
    }
    page.query_seconds = std::chrono::duration<double>(
        std::chrono::steady_clock::now() - started).count();
    return page;
}



StreetReachWeights StreetBatchSolver::Engine::compute_reaching_weights(const std::string& text) const
{
    ensure_average();
    int node_index = 0;
    int turn = -1;
    int river = -1;
    locate_node(text, node_index, turn, river);
    std::vector<double> q0;
    std::vector<double> q1;
    replay_weights(node_index, turn, river, q0, q1);
    StreetReachWeights weights;
    weights.node_id = text;
    weights.board = config.board;
    if (turn >= 0)
    {
        weights.board.push_back(turn);
    }
    if (river >= 0)
    {
        weights.board.push_back(river);
    }
    weights.oop = weighted_range(0, q0);
    weights.ip = weighted_range(1, q1);
    return weights;
}


} // namespace poker::solver
