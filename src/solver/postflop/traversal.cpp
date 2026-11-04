// StreetBatchSolver::Engine method definitions.
#include "engine.hpp"

namespace poker::solver
{


double StreetBatchSolver::Engine::cfr_deal(int node_index, double pi0, double pi1, double chance, const Deal& deal,
                int turn, int river, int updating, double weight_iter)
{
    return cfr_deal_payoff(
        node_index, pi0, pi1, chance, deal, turn, river, updating, weight_iter).utility[0];
}



// One public-tree pass. responding < 0 plays the sigma strategy.
// A best-responding player picks, per hand, the action with the higher
// utility and keeps the lowest index on a tie. The other player mixes.
void StreetBatchSolver::Engine::parallel_response_chance(
    WorkerContext& ctx,
    const Node& node,
    int turn,
    int river,
    int depth,
    int responding,
    const double* pi0,
    const double* pi1) const
{
    // Same first-future-card split as train; BR writes disjoint response slots
    // per card. Reduce child EV in card order for float-policy parity.
    Scratch& here = ctx.scratch[static_cast<std::size_t>(depth)];
    std::fill(here.ev0.begin(), here.ev0.end(), 0.0);
    std::fill(here.ev1.begin(), here.ev1.end(), 0.0);
    int denom = 52 - static_cast<int>(config.board.size()) - 4;
    std::uint64_t dead = board_mask;
    if (turn >= 0)
    {
        --denom;
        dead |= std::uint64_t{1} << turn;
    }
    if (river >= 0)
    {
        --denom;
        dead |= std::uint64_t{1} << river;
    }
    const double probability = 1.0 / static_cast<double>(denom);
    bool active[52] = {};
    active_count_ = 0;
    for (int card = 0; card < 52; ++card)
    {
        if (((dead >> card) & 1u) != 0)
        {
            continue;
        }
        int next_turn = turn;
        int next_river = river;
        if (node.deal_which == 1)
        {
            next_turn = card;
        }
        else
        {
            next_river = card;
        }
        if (!card_reaches_pair(&ctx, next_turn, next_river, pi0, pi1))
        {
            continue;
        }
        active[card] = true;
        active_cards_[active_count_++] = card;
    }
    const int workers = config.threads;
    const int base = active_count_ / workers;
    const int remainder = active_count_ % workers;
    int cursor = 0;
    for (int worker = 0; worker < workers; ++worker)
    {
        const int count = base + (worker < remainder ? 1 : 0);
        chunk_begin_[worker] = cursor;
        chunk_end_[worker] = cursor + count;
        cursor += count;
    }
    task_node_ = node.child[0];
    task_turn_ = turn;
    task_river_ = river;
    task_depth_ = depth + 1;
    task_responding_ = responding;
    task_pi0_ = pi0;
    task_pi1_ = pi1;
    task_deal_ = node.deal_which;
    // Const NashConv/BR reuses the train worker pool (mutable task fields).
    const_cast<Engine*>(this)->dispatch_workers(PoolJob::Response);
    for (int card = 0; card < 52; ++card)
    {
        if (!active[card])
        {
            continue;
        }
        const double* child_ev0 = result0_.data()
            + static_cast<std::size_t>(card) * static_cast<std::size_t>(n0);
        const double* child_ev1 = result1_.data()
            + static_cast<std::size_t>(card) * static_cast<std::size_t>(n1);
        for (int hand = 0; hand < n0; ++hand)
        {
            here.ev0[static_cast<std::size_t>(hand)] +=
                probability * child_ev0[hand];
        }
        for (int hand = 0; hand < n1; ++hand)
        {
            here.ev1[static_cast<std::size_t>(hand)] +=
                probability * child_ev1[hand];
        }
    }
}



void StreetBatchSolver::Engine::response_walk(
    WorkerContext& ctx,
    int node_index,
    int turn,
    int river,
    int depth,
    int responding,
    bool serial_chance) const
{
    if (depth + 1 >= static_cast<int>(ctx.scratch.size()))
    {
        throw std::logic_error("street best response ran out of scratch");
    }
    const Node& node = nodes[static_cast<std::size_t>(node_index)];
    Scratch& here = ctx.scratch[static_cast<std::size_t>(depth)];
    const double* pi0 = here.pi0.data();
    const double* pi1 = here.pi1.data();
    if (node.terminal)
    {
        apply_terminal(ctx, node, turn, river, pi0, pi1, here.ev0, here.ev1, false);
        return;
    }
    if (node.chance)
    {
        if (!serial_chance && config.threads > 1 && worker_count_ > 0)
        {
            parallel_response_chance(ctx, node, turn, river, depth, responding, pi0, pi1);
            return;
        }
        std::fill(here.ev0.begin(), here.ev0.end(), 0.0);
        std::fill(here.ev1.begin(), here.ev1.end(), 0.0);
        int denom = 52 - static_cast<int>(config.board.size()) - 4;
        std::uint64_t dead = board_mask;
        if (turn >= 0)
        {
            --denom;
            dead |= std::uint64_t{1} << turn;
        }
        if (river >= 0)
        {
            --denom;
            dead |= std::uint64_t{1} << river;
        }
        const double probability = 1.0 / static_cast<double>(denom);
        Scratch& child = ctx.scratch[static_cast<std::size_t>(depth + 1)];
        for (int card = 0; card < 52; ++card)
        {
            if (((dead >> card) & 1u) != 0)
            {
                continue;
            }
            int next_turn = turn;
            int next_river = river;
            if (node.deal_which == 1)
            {
                next_turn = card;
            }
            else
            {
                next_river = card;
            }
            if (!card_reaches_pair(&ctx, next_turn, next_river, pi0, pi1))
            {
                continue;
            }
            ensure_board_support(ctx, next_turn, next_river);
            for (int h0 = 0; h0 < n0; ++h0)
            {
                child.pi0[static_cast<std::size_t>(h0)] =
                    ctx.live0[static_cast<std::size_t>(h0)] ? pi0[h0] : 0.0;
            }
            for (int h1 = 0; h1 < n1; ++h1)
            {
                child.pi1[static_cast<std::size_t>(h1)] =
                    ctx.live1[static_cast<std::size_t>(h1)] ? pi1[h1] : 0.0;
            }
            response_walk(
                ctx, node.child[0], next_turn, next_river, depth + 1, responding, true);
            for (int h0 = 0; h0 < n0; ++h0)
            {
                here.ev0[static_cast<std::size_t>(h0)] +=
                    probability * child.ev0[static_cast<std::size_t>(h0)];
            }
            for (int h1 = 0; h1 < n1; ++h1)
            {
                here.ev1[static_cast<std::size_t>(h1)] +=
                    probability * child.ev1[static_cast<std::size_t>(h1)];
            }
        }
        return;
    }

    ensure_board_support(ctx, turn, river);
    Scratch& child = ctx.scratch[static_cast<std::size_t>(depth + 1)];
    if (node.n_actions <= 1)
    {
        // Implicit check/call — no Slot / slot_of; reach unchanged for
        // supported hands. Skip fill_actor_slot_bases (empty slot_of).
        if (node.player == 0)
        {
            for (int h0 = 0; h0 < n0; ++h0)
            {
                child.pi0[static_cast<std::size_t>(h0)] = hand_supported(0, h0, turn, river)
                    ? pi0[h0] : 0.0;
            }
            std::copy(pi1, pi1 + n1, child.pi1.begin());
        }
        else
        {
            std::copy(pi0, pi0 + n0, child.pi0.begin());
            for (int h1 = 0; h1 < n1; ++h1)
            {
                child.pi1[static_cast<std::size_t>(h1)] = hand_supported(1, h1, turn, river)
                    ? pi1[h1] : 0.0;
            }
        }
        response_walk(
            ctx, node.child[0], turn, river, depth + 1, responding, serial_chance);
        std::copy(child.ev0.begin(), child.ev0.end(), here.ev0.begin());
        std::copy(child.ev1.begin(), child.ev1.end(), here.ev1.begin());
        return;
    }
    const double* actor_pi = node.player == 0 ? pi0 : pi1;
    fill_actor_slot_bases(ctx, here, node, turn, river, actor_pi);
    const bool choosing = node.player == responding;
    for (int action = 0; action < node.n_actions; ++action)
    {
        if (node.player == 0)
        {
            for (int h0 = 0; h0 < n0; ++h0)
            {
                const int base = here.slot_base[static_cast<std::size_t>(h0)];
                if (base < 0)
                {
                    child.pi0[static_cast<std::size_t>(h0)] = 0.0;
                    continue;
                }
                if (choosing)
                {
                    child.pi0[static_cast<std::size_t>(h0)] = pi0[h0];
                }
                else
                {
                    child.pi0[static_cast<std::size_t>(h0)] =
                        pi0[h0] * sigma[static_cast<std::size_t>(base + action)];
                }
            }
            std::copy(pi1, pi1 + n1, child.pi1.begin());
        }
        else
        {
            std::copy(pi0, pi0 + n0, child.pi0.begin());
            for (int h1 = 0; h1 < n1; ++h1)
            {
                const int base = here.slot_base[static_cast<std::size_t>(h1)];
                if (base < 0)
                {
                    child.pi1[static_cast<std::size_t>(h1)] = 0.0;
                    continue;
                }
                if (choosing)
                {
                    child.pi1[static_cast<std::size_t>(h1)] = pi1[h1];
                }
                else
                {
                    child.pi1[static_cast<std::size_t>(h1)] =
                        pi1[h1] * sigma[static_cast<std::size_t>(base + action)];
                }
            }
        }
        response_walk(
            ctx, node.child[action], turn, river, depth + 1, responding, serial_chance);
        std::copy(
            child.ev0.begin(), child.ev0.end(),
            here.aev0.begin() + static_cast<std::size_t>(action * n0));
        std::copy(
            child.ev1.begin(), child.ev1.end(),
            here.aev1.begin() + static_cast<std::size_t>(action * n1));
    }

    // Child chance nodes overwrite the support masks; restore this board.
    ensure_board_support(ctx, turn, river);
    for (int h0 = 0; h0 < n0; ++h0)
    {
        if (!ctx.live0[static_cast<std::size_t>(h0)])
        {
            here.ev0[static_cast<std::size_t>(h0)] = 0.0;
            continue;
        }
        if (node.player == 0 && responding == 0)
        {
            const int index = slot_index(node, h0, turn, river, pi0[h0]);
            int best = 0;
            for (int action = 1; action < node.n_actions; ++action)
            {
                if (here.aev0[static_cast<std::size_t>(action * n0 + h0)]
                    > here.aev0[static_cast<std::size_t>(best * n0 + h0)])
                {
                    best = action;
                }
            }
            here.ev0[static_cast<std::size_t>(h0)] =
                here.aev0[static_cast<std::size_t>(best * n0 + h0)];
            response[static_cast<std::size_t>(index)] = best;
        }
        else if (node.player == 0)
        {
            const int base = here.slot_base[static_cast<std::size_t>(h0)];
            const TableScalar* row = sigma.data() + base;
            double mix = 0.0;
            for (int action = 0; action < node.n_actions; ++action)
            {
                mix += static_cast<double>(row[action])
                    * here.aev0[static_cast<std::size_t>(action * n0 + h0)];
            }
            here.ev0[static_cast<std::size_t>(h0)] = mix;
        }
        else if (responding == 1)
        {
            here.ev0[static_cast<std::size_t>(h0)] = 0.0;
        }
        else
        {
            double mix = 0.0;
            for (int action = 0; action < node.n_actions; ++action)
            {
                mix += here.aev0[static_cast<std::size_t>(action * n0 + h0)];
            }
            here.ev0[static_cast<std::size_t>(h0)] = mix;
        }
    }
    for (int h1 = 0; h1 < n1; ++h1)
    {
        if (!ctx.live1[static_cast<std::size_t>(h1)])
        {
            here.ev1[static_cast<std::size_t>(h1)] = 0.0;
            continue;
        }
        if (node.player == 1 && responding == 1)
        {
            const int index = slot_index(node, h1, turn, river, pi1[h1]);
            int best = 0;
            for (int action = 1; action < node.n_actions; ++action)
            {
                if (here.aev1[static_cast<std::size_t>(action * n1 + h1)]
                    > here.aev1[static_cast<std::size_t>(best * n1 + h1)])
                {
                    best = action;
                }
            }
            here.ev1[static_cast<std::size_t>(h1)] =
                here.aev1[static_cast<std::size_t>(best * n1 + h1)];
            response[static_cast<std::size_t>(index)] = best;
        }
        else if (node.player == 1)
        {
            const int base = here.slot_base[static_cast<std::size_t>(h1)];
            const TableScalar* row = sigma.data() + base;
            double mix = 0.0;
            for (int action = 0; action < node.n_actions; ++action)
            {
                mix += static_cast<double>(row[action])
                    * here.aev1[static_cast<std::size_t>(action * n1 + h1)];
            }
            here.ev1[static_cast<std::size_t>(h1)] = mix;
        }
        else if (responding == 0)
        {
            here.ev1[static_cast<std::size_t>(h1)] = 0.0;
        }
        else
        {
            double mix = 0.0;
            for (int action = 0; action < node.n_actions; ++action)
            {
                mix += here.aev1[static_cast<std::size_t>(action * n1 + h1)];
            }
            here.ev1[static_cast<std::size_t>(h1)] = mix;
        }
    }
}



// Descendant information sets of different cards are disjoint: each slot
// stores the public node and the dealt card. Workers write those entries
// directly. This node and its ancestors stay on the caller and are updated
// only after the join, in ascending card order.
void StreetBatchSolver::Engine::parallel_chance(
    WorkerContext& ctx,
    const Node& node,
    int turn,
    int river,
    int depth,
    int updating,
    double weight_iter,
    const double* pi0,
    const double* pi1)
{
    Scratch& here = ctx.scratch[static_cast<std::size_t>(depth)];
    std::fill(here.ev0.begin(), here.ev0.end(), 0.0);
    std::fill(here.ev1.begin(), here.ev1.end(), 0.0);
    int denom = 52 - static_cast<int>(config.board.size()) - 4;
    std::uint64_t dead = board_mask;
    if (turn >= 0)
    {
        --denom;
        dead |= std::uint64_t{1} << turn;
    }
    if (river >= 0)
    {
        --denom;
        dead |= std::uint64_t{1} << river;
    }
    const double probability = 1.0 / static_cast<double>(denom);
    bool active[52] = {};
    active_count_ = 0;
    for (int card = 0; card < 52; ++card)
    {
        if (((dead >> card) & 1u) != 0)
        {
            continue;
        }
        int next_turn = turn;
        int next_river = river;
        if (node.deal_which == 1)
        {
            next_turn = card;
        }
        else
        {
            next_river = card;
        }
        if (!card_reaches_pair(&ctx, next_turn, next_river, pi0, pi1))
        {
            continue;
        }
        active[card] = true;
        active_cards_[active_count_++] = card;
    }
    const int workers = config.threads;
    const int base = active_count_ / workers;
    const int remainder = active_count_ % workers;
    int cursor = 0;
    for (int worker = 0; worker < workers; ++worker)
    {
        const int count = base + (worker < remainder ? 1 : 0);
        chunk_begin_[worker] = cursor;
        chunk_end_[worker] = cursor + count;
        cursor += count;
    }
    task_node_ = node.child[0];
    task_turn_ = turn;
    task_river_ = river;
    task_depth_ = depth + 1;
    task_updating_ = updating;
    task_weight_ = weight_iter;
    task_pi0_ = pi0;
    task_pi1_ = pi1;
    task_deal_ = node.deal_which;
    const auto started = profile_
        ? std::chrono::steady_clock::now()
        : std::chrono::steady_clock::time_point{};
    dispatch_chance();
    for (int card = 0; card < 52; ++card)
    {
        if (!active[card])
        {
            continue;
        }
        const double* child_ev0 = result0_.data()
            + static_cast<std::size_t>(card) * static_cast<std::size_t>(n0);
        const double* child_ev1 = result1_.data()
            + static_cast<std::size_t>(card) * static_cast<std::size_t>(n1);
        for (int hand = 0; hand < n0; ++hand)
        {
            here.ev0[static_cast<std::size_t>(hand)] +=
                probability * child_ev0[hand];
        }
        for (int hand = 0; hand < n1; ++hand)
        {
            here.ev1[static_cast<std::size_t>(hand)] +=
                probability * child_ev1[hand];
        }
    }
    if (profile_)
    {
        ctx.chance_seconds += std::chrono::duration<double>(
            std::chrono::steady_clock::now() - started).count();
    }
}



void StreetBatchSolver::Engine::frozen_walk(
    WorkerContext& ctx,
    int node_index,
    int turn,
    int river,
    int depth,
    int updating,
    double weight_iter,
    bool serial_chance)
{
    if (depth + 1 >= static_cast<int>(ctx.scratch.size()))
    {
        throw std::logic_error("frozen street traversal ran out of scratch");
    }
    const Node& node = nodes[static_cast<std::size_t>(node_index)];
    Scratch& here = ctx.scratch[static_cast<std::size_t>(depth)];
    const double* pi0 = here.pi0.data();
    const double* pi1 = here.pi1.data();
    if (node.terminal)
    {
        apply_terminal(ctx, node, turn, river, pi0, pi1, here.ev0, here.ev1, false);
        return;
    }
    if (node.chance)
    {
        if (!serial_chance && config.threads > 1)
        {
            parallel_chance(ctx, node, turn, river, depth, updating, weight_iter, pi0, pi1);
            return;
        }
        std::fill(here.ev0.begin(), here.ev0.end(), 0.0);
        std::fill(here.ev1.begin(), here.ev1.end(), 0.0);
        int denom = 52 - static_cast<int>(config.board.size()) - 4;
        std::uint64_t dead = board_mask;
        if (turn >= 0)
        {
            --denom;
            dead |= std::uint64_t{1} << turn;
        }
        if (river >= 0)
        {
            --denom;
            dead |= std::uint64_t{1} << river;
        }
        const double probability = 1.0 / static_cast<double>(denom);
        Scratch& child = ctx.scratch[static_cast<std::size_t>(depth + 1)];
        for (int card = 0; card < 52; ++card)
        {
            if (((dead >> card) & 1u) != 0)
            {
                continue;
            }
            int next_turn = turn;
            int next_river = river;
            if (node.deal_which == 1)
            {
                next_turn = card;
            }
            else
            {
                next_river = card;
            }
            if (!card_reaches_pair(&ctx, next_turn, next_river, pi0, pi1))
            {
                continue;
            }
            ensure_board_support(ctx, next_turn, next_river);
            for (int h0 = 0; h0 < n0; ++h0)
            {
                child.pi0[static_cast<std::size_t>(h0)] =
                    ctx.live0[static_cast<std::size_t>(h0)] ? pi0[h0] : 0.0;
            }
            for (int h1 = 0; h1 < n1; ++h1)
            {
                child.pi1[static_cast<std::size_t>(h1)] =
                    ctx.live1[static_cast<std::size_t>(h1)] ? pi1[h1] : 0.0;
            }
            frozen_walk(
                ctx, node.child[0], next_turn, next_river, depth + 1, updating, weight_iter, true);
            for (int h0 = 0; h0 < n0; ++h0)
            {
                here.ev0[static_cast<std::size_t>(h0)] += probability * child.ev0[static_cast<std::size_t>(h0)];
            }
            for (int h1 = 0; h1 < n1; ++h1)
            {
                here.ev1[static_cast<std::size_t>(h1)] += probability * child.ev1[static_cast<std::size_t>(h1)];
            }
        }
        return;
    }

    ensure_board_support(ctx, turn, river);
    Scratch& child = ctx.scratch[static_cast<std::size_t>(depth + 1)];
    if (node.n_actions <= 1)
    {
        // Implicit probability 1 — copy supported reaches and skip tables.
        if (node.player == 0)
        {
            for (int h0 = 0; h0 < n0; ++h0)
            {
                child.pi0[static_cast<std::size_t>(h0)] =
                    ctx.live0[static_cast<std::size_t>(h0)] ? pi0[h0] : 0.0;
            }
            std::copy(pi1, pi1 + n1, child.pi1.begin());
        }
        else
        {
            std::copy(pi0, pi0 + n0, child.pi0.begin());
            for (int h1 = 0; h1 < n1; ++h1)
            {
                child.pi1[static_cast<std::size_t>(h1)] =
                    ctx.live1[static_cast<std::size_t>(h1)] ? pi1[h1] : 0.0;
            }
        }
        frozen_walk(
            ctx, node.child[0], turn, river, depth + 1, updating, weight_iter, serial_chance);
        ensure_board_support(ctx, turn, river);
        std::copy(child.ev0.begin(), child.ev0.end(), here.ev0.begin());
        std::copy(child.ev1.begin(), child.ev1.end(), here.ev1.begin());
        for (int h0 = 0; h0 < n0; ++h0)
        {
            if (!ctx.live0[static_cast<std::size_t>(h0)])
            {
                here.ev0[static_cast<std::size_t>(h0)] = 0.0;
            }
        }
        for (int h1 = 0; h1 < n1; ++h1)
        {
            if (!ctx.live1[static_cast<std::size_t>(h1)])
            {
                here.ev1[static_cast<std::size_t>(h1)] = 0.0;
            }
        }
        return;
    }
    const double* actor_pi = node.player == 0 ? pi0 : pi1;
    fill_actor_slot_bases(ctx, here, node, turn, river, actor_pi);
    for (int action = 0; action < node.n_actions; ++action)
    {
        const auto expand_started = profile_
            ? std::chrono::steady_clock::now()
            : std::chrono::steady_clock::time_point{};
        if (node.player == 0)
        {
            for (int h0 = 0; h0 < n0; ++h0)
            {
                const int base = here.slot_base[static_cast<std::size_t>(h0)];
                if (base < 0)
                {
                    child.pi0[static_cast<std::size_t>(h0)] = 0.0;
                    continue;
                }
                child.pi0[static_cast<std::size_t>(h0)] =
                    pi0[h0] * sigma[static_cast<std::size_t>(base + action)];
            }
            std::copy(pi1, pi1 + n1, child.pi1.begin());
        }
        else
        {
            std::copy(pi0, pi0 + n0, child.pi0.begin());
            for (int h1 = 0; h1 < n1; ++h1)
            {
                const int base = here.slot_base[static_cast<std::size_t>(h1)];
                if (base < 0)
                {
                    child.pi1[static_cast<std::size_t>(h1)] = 0.0;
                    continue;
                }
                child.pi1[static_cast<std::size_t>(h1)] =
                    pi1[h1] * sigma[static_cast<std::size_t>(base + action)];
            }
        }
        if (profile_)
        {
            ctx.expand_seconds += std::chrono::duration<double>(
                std::chrono::steady_clock::now() - expand_started).count();
        }
        frozen_walk(
            ctx, node.child[action], turn, river, depth + 1, updating, weight_iter, serial_chance);
        const auto copy_started = profile_
            ? std::chrono::steady_clock::now()
            : std::chrono::steady_clock::time_point{};
        // Keep per-action EVs only for the actor (regret / sigma mix). The
        // non-acting side is an unweighted sum over actions — accumulate it
        // into here.ev during the action loop and skip the aev traffic.
        if (node.player == 0)
        {
            std::copy(
                child.ev0.begin(),
                child.ev0.end(),
                here.aev0.begin() + static_cast<std::size_t>(action * n0));
            if (action == 0)
            {
                std::copy(child.ev1.begin(), child.ev1.end(), here.ev1.begin());
            }
            else
            {
                for (int h1 = 0; h1 < n1; ++h1)
                {
                    here.ev1[static_cast<std::size_t>(h1)] +=
                        child.ev1[static_cast<std::size_t>(h1)];
                }
            }
        }
        else
        {
            std::copy(
                child.ev1.begin(),
                child.ev1.end(),
                here.aev1.begin() + static_cast<std::size_t>(action * n1));
            if (action == 0)
            {
                std::copy(child.ev0.begin(), child.ev0.end(), here.ev0.begin());
            }
            else
            {
                for (int h0 = 0; h0 < n0; ++h0)
                {
                    here.ev0[static_cast<std::size_t>(h0)] +=
                        child.ev0[static_cast<std::size_t>(h0)];
                }
            }
        }
        if (profile_)
        {
            ctx.expand_seconds += std::chrono::duration<double>(
                std::chrono::steady_clock::now() - copy_started).count();
        }
    }

    // Child chance nodes overwrite the support masks; restore this board.
    ensure_board_support(ctx, turn, river);
    const auto decision_started = profile_
        ? std::chrono::steady_clock::now()
        : std::chrono::steady_clock::time_point{};
    if (node.player == 0)
    {
        for (int h0 = 0; h0 < n0; ++h0)
        {
            if (!ctx.live0[static_cast<std::size_t>(h0)])
            {
                here.ev0[static_cast<std::size_t>(h0)] = 0.0;
                continue;
            }
            const int base = here.slot_base[static_cast<std::size_t>(h0)];
            const TableScalar* row = sigma.data() + base;
            double mix = 0.0;
            for (int action = 0; action < node.n_actions; ++action)
            {
                mix += row[action] * here.aev0[static_cast<std::size_t>(action * n0 + h0)];
            }
            here.ev0[static_cast<std::size_t>(h0)] = mix;
            if (updating < 0 || updating == 0)
            {
                accumulate_average(
                    strategy_sum.data() + base, row, node.n_actions, weight_iter * pi0[h0]);
                for (int action = 0; action < node.n_actions; ++action)
                {
                    const std::size_t at = static_cast<std::size_t>(base + action);
                    const double instant =
                        here.aev0[static_cast<std::size_t>(action * n0 + h0)] - mix;
                    if (pcfr_collect_)
                    {
                        prediction_[at] += instant;
                    }
                    else
                    {
                        regret[at] += instant;
                    }
                }
            }
        }
        for (int h1 = 0; h1 < n1; ++h1)
        {
            if (!ctx.live1[static_cast<std::size_t>(h1)])
            {
                here.ev1[static_cast<std::size_t>(h1)] = 0.0;
            }
        }
    }
    else
    {
        for (int h0 = 0; h0 < n0; ++h0)
        {
            if (!ctx.live0[static_cast<std::size_t>(h0)])
            {
                here.ev0[static_cast<std::size_t>(h0)] = 0.0;
            }
        }
        for (int h1 = 0; h1 < n1; ++h1)
        {
            if (!ctx.live1[static_cast<std::size_t>(h1)])
            {
                here.ev1[static_cast<std::size_t>(h1)] = 0.0;
                continue;
            }
            const int base = here.slot_base[static_cast<std::size_t>(h1)];
            const TableScalar* row = sigma.data() + base;
            double mix = 0.0;
            for (int action = 0; action < node.n_actions; ++action)
            {
                mix += row[action] * here.aev1[static_cast<std::size_t>(action * n1 + h1)];
            }
            here.ev1[static_cast<std::size_t>(h1)] = mix;
            if (updating < 0 || updating == 1)
            {
                accumulate_average(
                    strategy_sum.data() + base, row, node.n_actions, weight_iter * pi1[h1]);
                for (int action = 0; action < node.n_actions; ++action)
                {
                    // Own-utility regret: ev1 holds player-1 modeled utility.
                    const std::size_t at = static_cast<std::size_t>(base + action);
                    const double instant =
                        here.aev1[static_cast<std::size_t>(action * n1 + h1)] - mix;
                    if (pcfr_collect_)
                    {
                        prediction_[at] += instant;
                    }
                    else
                    {
                        regret[at] += instant;
                    }
                }
            }
        }
    }
    if (profile_)
    {
        ctx.decision_seconds += std::chrono::duration<double>(
            std::chrono::steady_clock::now() - decision_started).count();
    }
}



// Average-policy values. force is only the selected decision: that action is
// taken with probability 1, and every later decision mixes the sigma.
// Hero values are not multiplied by hero reach. Opponent reach is, so an
// opponent's mixed value is the sum of the already-scaled action values.
void StreetBatchSolver::Engine::average_value_walk(
    WorkerContext& ctx,
    int node_index,
    int turn,
    int river,
    int depth,
    bool force,
    const std::atomic<bool>* cancel) const
{
    throw_if_cancelled(cancel);
    if (depth + 1 >= static_cast<int>(ctx.scratch.size()))
    {
        throw std::logic_error("street action values ran out of scratch");
    }
    const Node& node = nodes[static_cast<std::size_t>(node_index)];
    Scratch& here = ctx.scratch[static_cast<std::size_t>(depth)];
    const double* pi0 = here.pi0.data();
    const double* pi1 = here.pi1.data();
    if (node.terminal)
    {
        apply_terminal(ctx, node, turn, river, pi0, pi1, here.ev0, here.ev1, true);
        return;
    }
    if (node.chance)
    {
        std::fill(here.ev0.begin(), here.ev0.end(), 0.0);
        std::fill(here.ev1.begin(), here.ev1.end(), 0.0);
        int denom = 52 - static_cast<int>(config.board.size()) - 4;
        std::uint64_t dead = board_mask;
        if (turn >= 0)
        {
            --denom;
            dead |= std::uint64_t{1} << turn;
        }
        if (river >= 0)
        {
            --denom;
            dead |= std::uint64_t{1} << river;
        }
        const double probability = 1.0 / static_cast<double>(denom);
        Scratch& child = ctx.scratch[static_cast<std::size_t>(depth + 1)];
        for (int card = 0; card < 52; ++card)
        {
            if (((dead >> card) & 1u) != 0)
            {
                continue;
            }
            int next_turn = turn;
            int next_river = river;
            if (node.deal_which == 1)
            {
                next_turn = card;
            }
            else
            {
                next_river = card;
            }
            if (!card_reaches_pair(&ctx, next_turn, next_river, pi0, pi1))
            {
                continue;
            }
            for (int h0 = 0; h0 < n0; ++h0)
            {
                child.pi0[static_cast<std::size_t>(h0)] = hand_supported(0, h0, next_turn, next_river)
                    ? pi0[h0] : 0.0;
            }
            for (int h1 = 0; h1 < n1; ++h1)
            {
                child.pi1[static_cast<std::size_t>(h1)] = hand_supported(1, h1, next_turn, next_river)
                    ? pi1[h1] : 0.0;
            }
            average_value_walk(
                ctx, node.child[0], next_turn, next_river, depth + 1, false, cancel);
            for (int h0 = 0; h0 < n0; ++h0)
            {
                here.ev0[static_cast<std::size_t>(h0)] +=
                    probability * child.ev0[static_cast<std::size_t>(h0)];
            }
            for (int h1 = 0; h1 < n1; ++h1)
            {
                here.ev1[static_cast<std::size_t>(h1)] +=
                    probability * child.ev1[static_cast<std::size_t>(h1)];
            }
        }
        return;
    }

    Scratch& child = ctx.scratch[static_cast<std::size_t>(depth + 1)];
    if (node.n_actions <= 1)
    {
        if (node.player == 0)
        {
            for (int h0 = 0; h0 < n0; ++h0)
            {
                child.pi0[static_cast<std::size_t>(h0)] = hand_supported(0, h0, turn, river)
                    ? pi0[h0] : 0.0;
            }
            std::copy(pi1, pi1 + n1, child.pi1.begin());
        }
        else
        {
            std::copy(pi0, pi0 + n0, child.pi0.begin());
            for (int h1 = 0; h1 < n1; ++h1)
            {
                child.pi1[static_cast<std::size_t>(h1)] = hand_supported(1, h1, turn, river)
                    ? pi1[h1] : 0.0;
            }
        }
        average_value_walk(ctx, node.child[0], turn, river, depth + 1, false, cancel);
        std::copy(child.ev0.begin(), child.ev0.end(), here.ev0.begin());
        std::copy(child.ev1.begin(), child.ev1.end(), here.ev1.begin());
        // Force at a one-action node still records the sole child under aev.
        if (force)
        {
            if (node.player == 0)
            {
                std::copy(
                    child.ev0.begin(),
                    child.ev0.end(),
                    here.aev0.begin());
            }
            else
            {
                std::copy(
                    child.ev1.begin(),
                    child.ev1.end(),
                    here.aev1.begin());
            }
        }
        return;
    }
    for (int action = 0; action < node.n_actions; ++action)
    {
        if (node.player == 0)
        {
            for (int h0 = 0; h0 < n0; ++h0)
            {
                if (!hand_supported(0, h0, turn, river))
                {
                    child.pi0[static_cast<std::size_t>(h0)] = 0.0;
                    continue;
                }
                if (force)
                {
                    child.pi0[static_cast<std::size_t>(h0)] = pi0[h0];
                }
                else
                {
                    const int index = slot_index(node, h0, turn, river, pi0[h0]);
                    const double played = sigma[static_cast<std::size_t>(
                        slots[static_cast<std::size_t>(index)].base + action)];
                    child.pi0[static_cast<std::size_t>(h0)] = pi0[h0] * played;
                }
            }
            std::copy(pi1, pi1 + n1, child.pi1.begin());
        }
        else
        {
            std::copy(pi0, pi0 + n0, child.pi0.begin());
            for (int h1 = 0; h1 < n1; ++h1)
            {
                if (!hand_supported(1, h1, turn, river))
                {
                    child.pi1[static_cast<std::size_t>(h1)] = 0.0;
                    continue;
                }
                if (force)
                {
                    child.pi1[static_cast<std::size_t>(h1)] = pi1[h1];
                }
                else
                {
                    const int index = slot_index(node, h1, turn, river, pi1[h1]);
                    const double played = sigma[static_cast<std::size_t>(
                        slots[static_cast<std::size_t>(index)].base + action)];
                    child.pi1[static_cast<std::size_t>(h1)] = pi1[h1] * played;
                }
            }
        }
        average_value_walk(
            ctx, node.child[action], turn, river, depth + 1, false, cancel);
        std::copy(
            child.ev0.begin(), child.ev0.end(),
            here.aev0.begin() + static_cast<std::size_t>(action * n0));
        std::copy(
            child.ev1.begin(), child.ev1.end(),
            here.aev1.begin() + static_cast<std::size_t>(action * n1));
    }
    if (force)
    {
        return;
    }

    for (int h0 = 0; h0 < n0; ++h0)
    {
        if (!hand_supported(0, h0, turn, river))
        {
            here.ev0[static_cast<std::size_t>(h0)] = 0.0;
            continue;
        }
        if (node.player == 0)
        {
            const int index = slot_index(node, h0, turn, river, pi0[h0]);
            double mix = 0.0;
            for (int action = 0; action < node.n_actions; ++action)
            {
                const double played = sigma[static_cast<std::size_t>(
                    slots[static_cast<std::size_t>(index)].base + action)];
                mix += played * here.aev0[static_cast<std::size_t>(action * n0 + h0)];
            }
            here.ev0[static_cast<std::size_t>(h0)] = mix;
        }
        else
        {
            double mix = 0.0;
            for (int action = 0; action < node.n_actions; ++action)
            {
                mix += here.aev0[static_cast<std::size_t>(action * n0 + h0)];
            }
            here.ev0[static_cast<std::size_t>(h0)] = mix;
        }
    }
    for (int h1 = 0; h1 < n1; ++h1)
    {
        if (!hand_supported(1, h1, turn, river))
        {
            here.ev1[static_cast<std::size_t>(h1)] = 0.0;
            continue;
        }
        if (node.player == 1)
        {
            const int index = slot_index(node, h1, turn, river, pi1[h1]);
            double mix = 0.0;
            for (int action = 0; action < node.n_actions; ++action)
            {
                const double played = sigma[static_cast<std::size_t>(
                    slots[static_cast<std::size_t>(index)].base + action)];
                mix += played * here.aev1[static_cast<std::size_t>(action * n1 + h1)];
            }
            here.ev1[static_cast<std::size_t>(h1)] = mix;
        }
        else
        {
            double mix = 0.0;
            for (int action = 0; action < node.n_actions; ++action)
            {
                mix += here.aev1[static_cast<std::size_t>(action * n1 + h1)];
            }
            here.ev1[static_cast<std::size_t>(h1)] = mix;
        }
    }
}


} // namespace poker::solver
