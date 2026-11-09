// StreetBatchSolver::Engine method definitions.
#include "engine.hpp"

namespace poker::solver
{


PlayerPayoff StreetBatchSolver::Engine::terminal_modeled(const Node& node, const Deal& deal, int turn, int river) const
{
    int outcome = 0;
    if (node.folded < 0)
    {
        int board[5];
        int count = 0;
        for (int card : config.board)
        {
            board[count++] = card;
        }
        if (turn >= 0)
        {
            board[count++] = turn;
        }
        if (river >= 0)
        {
            board[count++] = river;
        }
        if (count != 5)
        {
            throw std::logic_error("showdown without five board cards");
        }
        outcome = holdem::compare_showdown(
            deal.c0, deal.c1, deal.d0, deal.d1, std::span<const int>(board, 5));
    }
    const PlayerPayoff chips = ChipPayoff::terminal(
        config.pot,
        node.contrib[0],
        node.contrib[1],
        node.folded,
        outcome,
        config.rake);
    PlayerPayoff paid = apply_icm_terminal(config.icm, chips);
    paid.utility[0] += node.incentive_u0;
    paid.utility[1] += node.incentive_u1;
    return paid;
}



double StreetBatchSolver::Engine::payoff(const Node& node, const Deal& deal, int turn, int river) const
{
    return terminal_modeled(node, deal, turn, river).utility[0];
}



PlayerPayoff StreetBatchSolver::Engine::cfr_deal_payoff(int node_index, double pi0, double pi1, double chance, const Deal& deal,
                             int turn, int river, int updating, double weight_iter)
{
    const Node& node = nodes[static_cast<std::size_t>(node_index)];
    if (node.terminal)
    {
        return terminal_modeled(node, deal, turn, river);
    }
    if (node.chance)
    {
        int cards[52];
        const int count = remaining(deal, turn, river, cards);
        const double probability = 1.0 / static_cast<double>(count);
        PlayerPayoff value;
        for (int i = 0; i < count; ++i)
        {
            int next_turn = turn;
            int next_river = river;
            if (node.deal_which == 1)
            {
                next_turn = cards[i];
            }
            else
            {
                next_river = cards[i];
            }
            const PlayerPayoff child = cfr_deal_payoff(
                node.child[0], pi0, pi1, chance * probability, deal,
                next_turn, next_river, updating, weight_iter);
            value.utility[0] += probability * child.utility[0];
            value.utility[1] += probability * child.utility[1];
        }
        return value;
    }

    if (node.n_actions <= 1)
    {
        // Implicit probability 1 — no stored row or regret.
        return cfr_deal_payoff(
            node.child[0], pi0, pi1, chance, deal, turn, river, updating, weight_iter);
    }
    const int hand = node.player == 0 ? deal.h0 : deal.h1;
    const double reach = node.player == 0 ? pi0 : pi1;
    const int index = slot_index(node, hand, turn, river, reach);
    const int base = slots[static_cast<std::size_t>(index)].base;
    const TableScalar* row = sigma.data() + base;
    const bool update = updating < 0 || updating == node.player;
    if (update)
    {
        accumulate_average(strategy_sum.data() + base, row, node.n_actions, weight_iter * reach);
    }
    PlayerPayoff action_utility[8];
    PlayerPayoff node_utility;
    for (int action = 0; action < node.n_actions; ++action)
    {
        if (node.player == 0)
        {
            action_utility[action] = cfr_deal_payoff(
                node.child[action], pi0 * row[action], pi1, chance, deal,
                turn, river, updating, weight_iter);
        }
        else
        {
            action_utility[action] = cfr_deal_payoff(
                node.child[action], pi0, pi1 * row[action], chance, deal,
                turn, river, updating, weight_iter);
        }
        node_utility.utility[0] += row[action] * action_utility[action].utility[0];
        node_utility.utility[1] += row[action] * action_utility[action].utility[1];
    }
    if (update)
    {
        const double opponent_reach = (node.player == 0 ? pi1 : pi0) * chance;
        for (int action = 0; action < node.n_actions; ++action)
        {
            const double instant = action_utility[action].utility[node.player]
                - node_utility.utility[node.player];
            regret[static_cast<std::size_t>(base + action)] += opponent_reach * instant;
        }
    }
    return node_utility;
}



void StreetBatchSolver::Engine::prepare_context(WorkerContext& ctx)
{
    const int wide = n0 > n1 ? n0 : n1;
    budget_->set_stage("scratch");
    ctx.scratch.resize(32);
    for (Scratch& level : ctx.scratch)
    {
        level.ev0.assign(static_cast<std::size_t>(n0), 0.0);
        level.ev1.assign(static_cast<std::size_t>(n1), 0.0);
        level.pi0.assign(static_cast<std::size_t>(n0), 0.0);
        level.pi1.assign(static_cast<std::size_t>(n1), 0.0);
        level.aev0.assign(static_cast<std::size_t>(8 * n0), 0.0);
        level.aev1.assign(static_cast<std::size_t>(8 * n1), 0.0);
        level.slot_base.assign(static_cast<std::size_t>(wide), -1);
    }
    budget_->set_stage("prefix");
    const std::uint64_t block_entries = checked_add(
        checked_mul(static_cast<std::uint64_t>(wide), 2, "showdown prefix"),
        52,
        "showdown prefix");
    ctx.prefix_buf.assign(static_cast<std::size_t>(wide + 1), 0.0);
    ctx.block_buf.assign(static_cast<std::size_t>(block_entries), 0.0);
    ctx.ordered_buf.assign(static_cast<std::size_t>(wide), 0.0);
    budget_->set_stage("terminal_buffers");
    ctx.amount_buf[0].assign(static_cast<std::size_t>(n0), 0.0);
    ctx.amount_buf[1].assign(static_cast<std::size_t>(n1), 0.0);
    ctx.live0.assign(static_cast<std::size_t>(n0), 0);
    ctx.live1.assign(static_cast<std::size_t>(n1), 0);
    ctx.support_turn = -2;
    ctx.support_river = -2;
}



const StreetBatchSolver::Engine::BoardSupport& StreetBatchSolver::Engine::board_support_for(int turn, int river) const
{
    ensure_support_masks();
    const int key = (turn + 1) * 64 + (river + 1);
    const auto found = board_support_.find(key);
    if (found == board_support_.end() || found->second.live0.empty())
    {
        throw std::logic_error("street board support cache missed a reserved board");
    }
    return found->second;
}



void StreetBatchSolver::Engine::ensure_board_support(WorkerContext& ctx, int turn, int river) const
{
    if (ctx.support_turn == turn && ctx.support_river == river)
    {
        return;
    }
    const auto started = profile_
        ? std::chrono::steady_clock::now()
        : std::chrono::steady_clock::time_point{};
    const BoardSupport& masks = board_support_for(turn, river);
    std::copy(masks.live0.begin(), masks.live0.end(), ctx.live0.begin());
    std::copy(masks.live1.begin(), masks.live1.end(), ctx.live1.begin());
    ctx.support_turn = turn;
    ctx.support_river = river;
    if (profile_)
    {
        ctx.support_seconds += std::chrono::duration<double>(
            std::chrono::steady_clock::now() - started).count();
    }
}



void StreetBatchSolver::Engine::fill_actor_slot_bases(
    WorkerContext& ctx,
    Scratch& here,
    const Node& node,
    int turn,
    int river,
    const double* pi) const
{
    const int hands = node.player == 0 ? n0 : n1;
    const std::pmr::vector<char>& live = node.player == 0 ? ctx.live0 : ctx.live1;
    for (int hand = 0; hand < hands; ++hand)
    {
        if (!live[static_cast<std::size_t>(hand)])
        {
            here.slot_base[static_cast<std::size_t>(hand)] = -1;
            continue;
        }
        const int index = slot_index(node, hand, turn, river, pi[hand]);
        here.slot_base[static_cast<std::size_t>(hand)] =
            slots[static_cast<std::size_t>(index)].base;
    }
}



void StreetBatchSolver::Engine::prepare_rank_cache()
{
    budget_->set_stage("rank_cache");
    bool on_board[52] = {};
    for (int card : config.board)
    {
        on_board[card] = true;
    }
    const int free_cards = 52 - static_cast<int>(config.board.size());
    if (config.board.size() == 5)
    {
        max_rank_keys_ = 1;
    }
    else if (config.board.size() == 3)
    {
        max_rank_keys_ =
            static_cast<std::uint64_t>(free_cards) * static_cast<std::uint64_t>(free_cards - 1);
    }
    else
    {
        max_rank_keys_ = static_cast<std::uint64_t>(free_cards);
    }
    runout_ranks.reserve(static_cast<std::size_t>(max_rank_keys_));
    const auto reserve_key = [&](int turn, int river)
    {
        const int key = (turn + 1) * 64 + (river + 1);
        const auto inserted = runout_ranks.try_emplace(key);
        RunoutRanks& table = inserted.first->second;
        const auto reserve_side = [&](int side, int hands)
        {
            if (hands < 0 || hands > 65535)
            {
                throw std::invalid_argument(
                    "showdown hand count does not fit in 16 bits");
            }
            table.rank[side].reserve(static_cast<std::size_t>(hands));
            table.order[side].reserve(static_cast<std::size_t>(hands));
            table.pos[side].reserve(static_cast<std::size_t>(hands));
            table.worse_end[side].reserve(static_cast<std::size_t>(hands));
            table.better_begin[side].reserve(static_cast<std::size_t>(hands));
            const std::uint64_t cuts = checked_mul(
                static_cast<std::uint64_t>(hands), 4, "showdown card cut");
            table.card_cut[side].reserve(static_cast<std::size_t>(cuts));
            const std::uint64_t listed = checked_mul(
                static_cast<std::uint64_t>(hands), 2, "showdown card list");
            table.card_pos[side].reserve(static_cast<std::size_t>(listed));
            table.card_off[side].reserve(53);
        };
        reserve_side(0, n0);
        reserve_side(1, n1);
    };
    if (config.board.size() == 5)
    {
        reserve_key(-1, -1);
    }
    else if (config.board.size() == 4)
    {
        for (int river = 0; river < 52; ++river)
        {
            if (!on_board[river])
            {
                reserve_key(-1, river);
            }
        }
    }
    else
    {
        for (int turn = 0; turn < 52; ++turn)
        {
            if (on_board[turn])
            {
                continue;
            }
            for (int river = 0; river < 52; ++river)
            {
                if (on_board[river] || river == turn)
                {
                    continue;
                }
                reserve_key(turn, river);
            }
        }
    }
    if (runout_ranks.size() != static_cast<std::size_t>(max_rank_keys_))
    {
        throw std::logic_error("street rank cache did not reserve every runout");
    }
    prepare_support_cache();
}



// Every (turn, river) the frozen walk can request, including partial boards
// such as (turn, -1) on a flop before the river is dealt.
void StreetBatchSolver::Engine::prepare_support_cache()
{
    budget_->set_stage("board_support");
    bool on_board[52] = {};
    for (int card : config.board)
    {
        on_board[card] = true;
    }
    const auto reserve = [&](int turn, int river)
    {
        const int key = (turn + 1) * 64 + (river + 1);
        const auto inserted = board_support_.try_emplace(key);
        BoardSupport& masks = inserted.first->second;
        masks.live0.reserve(static_cast<std::size_t>(n0));
        masks.live1.reserve(static_cast<std::size_t>(n1));
        masks.idx0.reserve(static_cast<std::size_t>(n0));
        masks.idx1.reserve(static_cast<std::size_t>(n1));
    };
    reserve(-1, -1);
    if (config.board.size() == 3)
    {
        for (int turn = 0; turn < 52; ++turn)
        {
            if (on_board[turn])
            {
                continue;
            }
            reserve(turn, -1);
            for (int river = 0; river < 52; ++river)
            {
                if (on_board[river] || river == turn)
                {
                    continue;
                }
                reserve(turn, river);
            }
        }
    }
    else if (config.board.size() == 4)
    {
        for (int river = 0; river < 52; ++river)
        {
            if (!on_board[river])
            {
                reserve(-1, river);
            }
        }
    }
}



void StreetBatchSolver::Engine::ensure_support_masks() const
{
    if (support_ready_)
    {
        return;
    }
    const auto started = std::chrono::steady_clock::now();
    for (auto& entry : board_support_)
    {
        const int key = entry.first;
        const int turn = key / 64 - 1;
        const int river = key % 64 - 1;
        BoardSupport& masks = entry.second;
        if (!masks.live0.empty())
        {
            continue;
        }
        masks.live0.resize(static_cast<std::size_t>(n0));
        masks.live1.resize(static_cast<std::size_t>(n1));
        masks.idx0.clear();
        masks.idx1.clear();
        for (int hand = 0; hand < n0; ++hand)
        {
            const bool live = hand_supported(0, hand, turn, river);
            masks.live0[static_cast<std::size_t>(hand)] = live ? 1 : 0;
            if (live)
            {
                masks.idx0.push_back(static_cast<std::uint16_t>(hand));
            }
        }
        for (int hand = 0; hand < n1; ++hand)
        {
            const bool live = hand_supported(1, hand, turn, river);
            masks.live1[static_cast<std::size_t>(hand)] = live ? 1 : 0;
            if (live)
            {
                masks.idx1.push_back(static_cast<std::uint16_t>(hand));
            }
        }
    }
    support_ready_ = true;
    cache_init_seconds_ += std::chrono::duration<double>(
        std::chrono::steady_clock::now() - started).count();
}



bool StreetBatchSolver::Engine::hand_live(int player, int hand, int turn, int river) const
{
    const std::uint64_t bits = mask[player][static_cast<std::size_t>(hand)];
    if (turn >= 0 && ((bits >> turn) & 1u) != 0)
    {
        return false;
    }
    if (river >= 0 && ((bits >> river) & 1u) != 0)
    {
        return false;
    }
    return true;
}



void StreetBatchSolver::Engine::fill_ranks(RunoutRanks& table, int turn, int river) const
{
    if (!table.rank[0].empty())
    {
        return;
    }
    int board[5];
    int count = 0;
    for (int card : config.board)
    {
        board[count++] = card;
    }
    if (turn >= 0)
    {
        board[count++] = turn;
    }
    if (river >= 0)
    {
        board[count++] = river;
    }
    if (count != 5)
    {
        throw std::logic_error("showdown without five board cards");
    }
    for (int side = 0; side < 2; ++side)
    {
        const int hands = side == 0 ? n0 : n1;
        if (table.rank[side].capacity() < static_cast<std::size_t>(hands))
        {
            throw std::logic_error("street rank cache exceeded its reserved bound");
        }
        table.rank[side].assign(static_cast<std::size_t>(hands), 0);
        for (int hand = 0; hand < hands; ++hand)
        {
            if (!hand_live(side, hand, turn, river))
            {
                continue;
            }
            int cards[7];
            cards[0] = hole_a[side][static_cast<std::size_t>(hand)];
            cards[1] = hole_b[side][static_cast<std::size_t>(hand)];
            for (int i = 0; i < 5; ++i)
            {
                cards[2 + i] = board[i];
            }
            table.rank[side][static_cast<std::size_t>(hand)] = pack_rank(
                holdem::evaluate(std::span<const int>(cards, 7)));
        }
    }
    fill_showdown(table);
}



void StreetBatchSolver::Engine::fill_showdown(RunoutRanks& table) const
{
    for (int side = 0; side < 2; ++side)
    {
        const int hands = static_cast<int>(table.rank[side].size());
        if (table.order[side].capacity() < static_cast<std::size_t>(hands)
            || table.pos[side].capacity() < static_cast<std::size_t>(hands)
            || table.card_pos[side].capacity() < static_cast<std::size_t>(hands) * 2
            || table.card_off[side].capacity() < 53)
        {
            throw std::logic_error("street showdown cache exceeded its reserved bound");
        }
        table.order[side].resize(static_cast<std::size_t>(hands));
        for (int hand = 0; hand < hands; ++hand)
        {
            table.order[side][static_cast<std::size_t>(hand)] = static_cast<std::uint16_t>(hand);
        }
        std::sort(table.order[side].begin(), table.order[side].end(), [&](std::uint16_t left, std::uint16_t right)
        {
            const std::uint32_t left_rank = table.rank[side][left];
            const std::uint32_t right_rank = table.rank[side][right];
            if (left_rank != right_rank)
            {
                return left_rank < right_rank;
            }
            return left < right;
        });
        table.pos[side].resize(static_cast<std::size_t>(hands));
        int counts[52] = {};
        for (int index = 0; index < hands; ++index)
        {
            const int hand = table.order[side][static_cast<std::size_t>(index)];
            table.pos[side][static_cast<std::size_t>(hand)] = static_cast<std::uint16_t>(index);
            ++counts[hole_a[side][static_cast<std::size_t>(hand)]];
            ++counts[hole_b[side][static_cast<std::size_t>(hand)]];
        }
        table.card_off[side].resize(53);
        table.card_off[side][0] = 0;
        for (int card = 0; card < 52; ++card)
        {
            table.card_off[side][static_cast<std::size_t>(card + 1)] =
                table.card_off[side][static_cast<std::size_t>(card)]
                + static_cast<std::uint32_t>(counts[card]);
        }
        if (table.card_off[side][52] != static_cast<std::uint32_t>(hands) * 2u)
        {
            throw std::logic_error("showdown card lists did not cover both hole cards");
        }
        table.card_pos[side].resize(static_cast<std::size_t>(hands) * 2);
        std::uint32_t cursor[52];
        for (int card = 0; card < 52; ++card)
        {
            cursor[card] = table.card_off[side][static_cast<std::size_t>(card)];
        }
        for (int index = 0; index < hands; ++index)
        {
            const int hand = table.order[side][static_cast<std::size_t>(index)];
            const int first = hole_a[side][static_cast<std::size_t>(hand)];
            const int second = hole_b[side][static_cast<std::size_t>(hand)];
            table.card_pos[side][cursor[first]++] = static_cast<std::uint16_t>(index);
            table.card_pos[side][cursor[second]++] = static_cast<std::uint16_t>(index);
        }
    }
    for (int hero = 0; hero < 2; ++hero)
    {
        const int opponent = 1 - hero;
        const int hero_hands = static_cast<int>(table.rank[hero].size());
        const int opp_hands = static_cast<int>(table.order[opponent].size());
        if (table.worse_end[hero].capacity() < static_cast<std::size_t>(hero_hands)
            || table.better_begin[hero].capacity() < static_cast<std::size_t>(hero_hands)
            || table.card_cut[hero].capacity() < static_cast<std::size_t>(hero_hands) * 4)
        {
            throw std::logic_error("street showdown cache exceeded its reserved bound");
        }
        table.worse_end[hero].resize(static_cast<std::size_t>(hero_hands));
        table.better_begin[hero].resize(static_cast<std::size_t>(hero_hands));
        table.card_cut[hero].resize(static_cast<std::size_t>(hero_hands) * 4);
        const auto list_cut = [&](int card, int order_end) -> int
        {
            const std::uint32_t begin = table.card_off[opponent][static_cast<std::size_t>(card)];
            const std::uint32_t end = table.card_off[opponent][static_cast<std::size_t>(card + 1)];
            std::uint32_t lower = begin;
            std::uint32_t upper = end;
            while (lower < upper)
            {
                const std::uint32_t mid = lower + (upper - lower) / 2;
                if (table.card_pos[opponent][mid] < static_cast<std::uint16_t>(order_end))
                {
                    lower = mid + 1;
                }
                else
                {
                    upper = mid;
                }
            }
            const std::uint32_t cut = lower - begin;
            if (cut > 65535u)
            {
                throw std::logic_error("showdown card-list cut does not fit in 16 bits");
            }
            return static_cast<int>(cut);
        };
        for (int hand = 0; hand < hero_hands; ++hand)
        {
            const std::uint32_t rank = table.rank[hero][static_cast<std::size_t>(hand)];
            int lower = 0;
            int upper = opp_hands;
            while (lower < upper)
            {
                const int mid = lower + (upper - lower) / 2;
                const int opp_hand = table.order[opponent][static_cast<std::size_t>(mid)];
                if (table.rank[opponent][static_cast<std::size_t>(opp_hand)] < rank)
                {
                    lower = mid + 1;
                }
                else
                {
                    upper = mid;
                }
            }
            const int worse = lower;
            lower = 0;
            upper = opp_hands;
            while (lower < upper)
            {
                const int mid = lower + (upper - lower) / 2;
                const int opp_hand = table.order[opponent][static_cast<std::size_t>(mid)];
                if (table.rank[opponent][static_cast<std::size_t>(opp_hand)] <= rank)
                {
                    lower = mid + 1;
                }
                else
                {
                    upper = mid;
                }
            }
            const int better = lower;
            const int c0 = hole_a[hero][static_cast<std::size_t>(hand)];
            const int c1 = hole_b[hero][static_cast<std::size_t>(hand)];
            table.worse_end[hero][static_cast<std::size_t>(hand)] = static_cast<std::uint16_t>(worse);
            table.better_begin[hero][static_cast<std::size_t>(hand)] = static_cast<std::uint16_t>(better);
            const std::size_t cut_at = static_cast<std::size_t>(hand) * 4;
            table.card_cut[hero][cut_at] = static_cast<std::uint16_t>(list_cut(c0, worse));
            table.card_cut[hero][cut_at + 1] = static_cast<std::uint16_t>(list_cut(c1, worse));
            table.card_cut[hero][cut_at + 2] = static_cast<std::uint16_t>(list_cut(c0, better));
            table.card_cut[hero][cut_at + 3] = static_cast<std::uint16_t>(list_cut(c1, better));
        }
    }
}



// Rank storage is reserved during construction. The values and the
// showdown order are written once, on the calling thread, before a pass
// reads them.
void StreetBatchSolver::Engine::ensure_ranks() const
{
    if (ranks_ready_)
    {
        return;
    }
    const auto started = std::chrono::steady_clock::now();
    for (auto& entry : runout_ranks)
    {
        const int key = entry.first;
        const int turn = key / 64 - 1;
        const int river = key % 64 - 1;
        fill_ranks(entry.second, turn, river);
    }
    ranks_ready_ = true;
    cache_init_seconds_ += std::chrono::duration<double>(
        std::chrono::steady_clock::now() - started).count();
}



const std::pmr::vector<std::uint32_t>& StreetBatchSolver::Engine::ranks_for(int player, int turn, int river) const
{
    const int key = (turn + 1) * 64 + (river + 1);
    const auto found = runout_ranks.find(key);
    if (found == runout_ranks.end())
    {
        throw std::logic_error("street rank cache missed a reserved runout");
    }
    const RunoutRanks& table = found->second;
    if (table.rank[player].empty())
    {
        throw std::logic_error("street rank cache was read before it was initialized");
    }
    return table.rank[player];
}



const StreetBatchSolver::Engine::RunoutRanks& StreetBatchSolver::Engine::runout_for(int turn, int river) const
{
    const int key = (turn + 1) * 64 + (river + 1);
    const auto found = runout_ranks.find(key);
    if (found == runout_ranks.end() || found->second.order[0].empty())
    {
        throw std::logic_error("street showdown cache was read before it was initialized");
    }
    return found->second;
}



void StreetBatchSolver::Engine::collect_reach(
    WorkerContext& ctx,
    int player,
    int turn,
    int river,
    const double* pi,
    bool use_board,
    std::pmr::vector<double>& amount,
    double& total,
    double* by_card) const
{
    const auto started = profile_
        ? std::chrono::steady_clock::now()
        : std::chrono::steady_clock::time_point{};
    const int hands = player == 0 ? n0 : n1;
    amount.assign(static_cast<std::size_t>(hands), 0.0);
    total = 0.0;
    if (by_card != nullptr)
    {
        std::fill(by_card, by_card + 52, 0.0);
    }
    if (use_board)
    {
        const BoardSupport& masks = board_support_for(turn, river);
        const std::pmr::vector<std::uint16_t>& live_idx = player == 0 ? masks.idx0 : masks.idx1;
        const double* weights = range_w[player].data();
        const int* hole0 = hole_a[player].data();
        const int* hole1 = hole_b[player].data();
        if (by_card != nullptr)
        {
            for (std::uint16_t hand_u : live_idx)
            {
                const int hand = static_cast<int>(hand_u);
                if (pi[hand] == 0.0)
                {
                    continue;
                }
                const double piece = weights[static_cast<std::size_t>(hand)] * pi[hand];
                if (piece == 0.0)
                {
                    continue;
                }
                amount[static_cast<std::size_t>(hand)] = piece;
                total += piece;
                by_card[hole0[static_cast<std::size_t>(hand)]] += piece;
                by_card[hole1[static_cast<std::size_t>(hand)]] += piece;
            }
        }
        else
        {
            for (std::uint16_t hand_u : live_idx)
            {
                const int hand = static_cast<int>(hand_u);
                if (pi[hand] == 0.0)
                {
                    continue;
                }
                const double piece = weights[static_cast<std::size_t>(hand)] * pi[hand];
                if (piece == 0.0)
                {
                    continue;
                }
                amount[static_cast<std::size_t>(hand)] = piece;
                total += piece;
            }
        }
    }
    else
    {
        for (int hand = 0; hand < hands; ++hand)
        {
            if (pi[hand] == 0.0)
            {
                continue;
            }
            const double piece = range_w[player][static_cast<std::size_t>(hand)] * pi[hand];
            if (piece == 0.0)
            {
                continue;
            }
            amount[static_cast<std::size_t>(hand)] = piece;
            total += piece;
            if (by_card != nullptr)
            {
                by_card[hole_a[player][static_cast<std::size_t>(hand)]] += piece;
                by_card[hole_b[player][static_cast<std::size_t>(hand)]] += piece;
            }
        }
    }
    if (profile_)
    {
        ctx.collect_seconds += std::chrono::duration<double>(
            std::chrono::steady_clock::now() - started).count();
    }
}



// Subtraction is trusted only when the remainder dominates rounding of the inputs.
// A zero result is trusted only when both inputs are zero. A negative residual is not.
bool StreetBatchSolver::Engine::difference_is_stable(double total, double removed, double difference) const
{
    if (!std::isfinite(total) || !std::isfinite(removed) || !std::isfinite(difference))
    {
        return false;
    }
    if (difference < 0.0)
    {
        return false;
    }
    if (difference == 0.0)
    {
        return total == 0.0 && removed == 0.0;
    }
    const double scale = std::max(total, std::abs(removed));
    return difference > scale * 1e-3;
}



bool StreetBatchSolver::Engine::shares_hole(int hero, int hero_hand, int opponent, int opponent_hand) const
{
    const int c0 = hole_a[hero][static_cast<std::size_t>(hero_hand)];
    const int c1 = hole_b[hero][static_cast<std::size_t>(hero_hand)];
    const int o0 = hole_a[opponent][static_cast<std::size_t>(opponent_hand)];
    const int o1 = hole_b[opponent][static_cast<std::size_t>(opponent_hand)];
    return o0 == c0 || o0 == c1 || o1 == c0 || o1 == c1;
}



double StreetBatchSolver::Engine::direct_compatible_mass(int hero, int hand, int opponent, std::span<const double> opp_amount) const
{
    double sum = 0.0;
    for (int other = 0; other < static_cast<int>(opp_amount.size()); ++other)
    {
        const double piece = opp_amount[static_cast<std::size_t>(other)];
        if (!(piece > 0.0) || shares_hole(hero, hand, opponent, other))
        {
            continue;
        }
        sum += piece;
    }
    return sum;
}



double StreetBatchSolver::Engine::stable_compatible_mass(
    int hero,
    int hand,
    int opponent,
    double total,
    const double* by_card,
    std::span<const double> opp_amount) const
{
    const double blocked = blocked_reach(hero, hand, by_card, opp_amount);
    const double open = total - blocked;
    if (difference_is_stable(total, blocked, open))
    {
        return open;
    }
    return direct_compatible_mass(hero, hand, opponent, opp_amount);
}



double StreetBatchSolver::Engine::blocked_reach(int hero, int hand, const double* by_card, std::span<const double> opp_amount) const
{
    const int c0 = hole_a[hero][static_cast<std::size_t>(hand)];
    const int c1 = hole_b[hero][static_cast<std::size_t>(hand)];
    double blocked = by_card[c0] + by_card[c1];
    const int opp_hand = twin_hand[hero][static_cast<std::size_t>(hand)];
    if (opp_hand >= 0)
    {
        blocked -= opp_amount[static_cast<std::size_t>(opp_hand)];
    }
    return blocked;
}



// Opponents in the initial support who are removed by these public cards.
// The pair adjustment matches registration, including an opponent combo
// that holds both cards.
int StreetBatchSolver::Engine::compatible_on(int player, int hand, int turn, int river) const
{
    const Support& row = support[player][static_cast<std::size_t>(hand)];
    int blocked = 0;
    if (turn >= 0)
    {
        blocked += row.contain[turn];
    }
    if (river >= 0)
    {
        blocked += row.contain[river];
    }
    if (turn >= 0 && river >= 0)
    {
        const int pair = holdem::Range::combo_index(turn, river);
        if (hand_of[1 - player][static_cast<std::size_t>(pair)] >= 0)
        {
            --blocked;
        }
    }
    return row.compatible - blocked;
}



// Structural support ignores strategy. A hand that meets the board, or that
// has no compatible opponent left on this board, has no history here.
bool StreetBatchSolver::Engine::hand_supported(int player, int hand, int turn, int river) const
{
    if (range_w[player][static_cast<std::size_t>(hand)] <= 0.0)
    {
        return false;
    }
    if (!hand_live(player, hand, turn, river))
    {
        return false;
    }
    return compatible_on(player, hand, turn, river) > 0;
}



// Same-pair condition: some legal pair on this board has positive reach on
// at least one side. A positive-reach hand with no compatible partner does
// not qualify. Chance probabilities are not renormalized over the cards
// this keeps.
bool StreetBatchSolver::Engine::card_reaches_pair(
    WorkerContext* profile_ctx,
    int turn,
    int river,
    const double* pi0,
    const double* pi1) const
{
    const auto started = profile_ && profile_ctx != nullptr
        ? std::chrono::steady_clock::now()
        : std::chrono::steady_clock::time_point{};
    const BoardSupport& masks = board_support_for(turn, river);
    bool found = false;
    for (int hand = 0; hand < n0; ++hand)
    {
        if (pi0[hand] > 0.0 && masks.live0[static_cast<std::size_t>(hand)])
        {
            found = true;
            break;
        }
    }
    if (!found)
    {
        for (int hand = 0; hand < n1; ++hand)
        {
            if (pi1[hand] > 0.0 && masks.live1[static_cast<std::size_t>(hand)])
            {
                found = true;
                break;
            }
        }
    }
    if (profile_ && profile_ctx != nullptr)
    {
        profile_ctx->support_seconds += std::chrono::duration<double>(
            std::chrono::steady_clock::now() - started).count();
    }
    return found;
}



void StreetBatchSolver::Engine::order_reach(
    WorkerContext& ctx,
    int player,
    std::span<const double> amount,
    const RunoutRanks& table) const
{
    const auto started = profile_
        ? std::chrono::steady_clock::now()
        : std::chrono::steady_clock::time_point{};
    const int hands = static_cast<int>(amount.size());
    const std::uint64_t blocks = static_cast<std::uint64_t>(hands) * 2u + 52u;
    if (ctx.prefix_buf.capacity() < amount.size() + 1
        || ctx.block_buf.capacity() < blocks
        || ctx.ordered_buf.capacity() < amount.size()
        || static_cast<int>(table.order[player].size()) != hands
        || table.card_off[player].size() != 53
        || table.card_off[player][52] != static_cast<std::uint32_t>(hands) * 2u)
    {
        throw std::logic_error("street showdown prefix exceeded its reserved bound");
    }
    // Avoid full zero-fills: every prefix[1..] and every non-base block slot is
    // written below; only prefix[0] and each card's base slot must start at 0.
    ctx.prefix_buf.resize(static_cast<std::size_t>(hands + 1));
    ctx.block_buf.resize(static_cast<std::size_t>(blocks));
    ctx.ordered_buf.resize(static_cast<std::size_t>(hands));
    double* ordered = ctx.ordered_buf.data();
    double* prefix = ctx.prefix_buf.data();
    const std::uint16_t* order = table.order[player].data();
    prefix[0] = 0.0;
    double running = 0.0;
    for (int index = 0; index < hands; ++index)
    {
        const double piece = amount[static_cast<std::size_t>(order[static_cast<std::size_t>(index)])];
        ordered[static_cast<std::size_t>(index)] = piece;
        running += piece;
        prefix[static_cast<std::size_t>(index + 1)] = running;
    }
    double* block = ctx.block_buf.data();
    const std::uint32_t* card_off = table.card_off[player].data();
    const std::uint16_t* card_pos = table.card_pos[player].data();
    for (int card = 0; card < 52; ++card)
    {
        const std::uint32_t begin = card_off[static_cast<std::size_t>(card)];
        const std::uint32_t end = card_off[static_cast<std::size_t>(card + 1)];
        const std::uint32_t base = begin + static_cast<std::uint32_t>(card);
        ctx.block_base[static_cast<std::size_t>(card)] = base;
        block[static_cast<std::size_t>(base)] = 0.0;
        double total = 0.0;
        for (std::uint32_t at = begin; at < end; ++at)
        {
            total += ordered[card_pos[at]];
            block[static_cast<std::size_t>(base + (at - begin) + 1)] = total;
        }
    }
    if (profile_)
    {
        ctx.order_seconds += std::chrono::duration<double>(
            std::chrono::steady_clock::now() - started).count();
    }
}



double StreetBatchSolver::Engine::slice_reach(
    const WorkerContext& ctx,
    const RunoutRanks& table,
    int player,
    int begin,
    int end,
    int c0,
    int c1,
    int cut0_begin,
    int cut1_begin,
    int cut0_end,
    int cut1_end,
    int add_hand,
    std::span<const double> amount,
    std::span<const std::uint16_t> pos) const
{
    if (end <= begin)
    {
        return 0.0;
    }
    const auto blocked = [&](int card, int cut) -> double
    {
        if (card < 0 || card >= 52 || cut < 0)
        {
            throw std::logic_error("showdown card prefix index");
        }
        const std::uint32_t base = table.card_off[player][static_cast<std::size_t>(card)]
            + static_cast<std::uint32_t>(card);
        const std::uint32_t index = base + static_cast<std::uint32_t>(cut);
        if (index >= ctx.block_buf.size())
        {
            throw std::logic_error("showdown card prefix index");
        }
        return ctx.block_buf[static_cast<std::size_t>(index)];
    };
    double sum = ctx.prefix_buf[static_cast<std::size_t>(end)] - ctx.prefix_buf[static_cast<std::size_t>(begin)];
    sum -= blocked(c0, cut0_end) - blocked(c0, cut0_begin);
    sum -= blocked(c1, cut1_end) - blocked(c1, cut1_begin);
    if (add_hand >= 0)
    {
        const int at = pos[static_cast<std::size_t>(add_hand)];
        if (at >= begin && at < end)
        {
            sum += amount[static_cast<std::size_t>(add_hand)];
        }
    }
    return sum;
}



void StreetBatchSolver::Engine::direct_rank_masses(
    const RunoutRanks& table,
    int hero,
    int hand,
    std::span<const double> opp_amount,
    double& worse_mass,
    double& better_mass,
    double* tie_mass) const
{
    const int opponent = 1 - hero;
    const int worse = table.worse_end[hero][static_cast<std::size_t>(hand)];
    const int after_tie = table.better_begin[hero][static_cast<std::size_t>(hand)];
    worse_mass = 0.0;
    better_mass = 0.0;
    if (tie_mass != nullptr)
    {
        *tie_mass = 0.0;
    }
    for (int other = 0; other < static_cast<int>(opp_amount.size()); ++other)
    {
        const double piece = opp_amount[static_cast<std::size_t>(other)];
        if (!(piece > 0.0) || shares_hole(hero, hand, opponent, other))
        {
            continue;
        }
        const int at = table.pos[opponent][static_cast<std::size_t>(other)];
        if (at < worse)
        {
            worse_mass += piece;
        }
        else if (at >= after_tie)
        {
            better_mass += piece;
        }
        else if (tie_mass != nullptr)
        {
            *tie_mass += piece;
        }
    }
}



void StreetBatchSolver::Engine::showdown_side(
    WorkerContext& ctx,
    int hero,
    int turn,
    int river,
    double win_pay,
    double lose_pay,
    double tie_pay,
    std::span<const double> opp_amount,
    std::span<double> ev,
    bool stable) const
{
    const auto started = profile_
        ? std::chrono::steady_clock::now()
        : std::chrono::steady_clock::time_point{};
    const int opp = 1 - hero;
    const RunoutRanks& table = runout_for(turn, river);
    order_reach(ctx, opp, opp_amount, table);
    const int opp_hands = static_cast<int>(opp_amount.size());
    double amount_total = 0.0;
    if (stable)
    {
        for (double piece : opp_amount)
        {
            if (piece > 0.0)
            {
                amount_total += piece;
            }
        }
    }
    const bool need_ties = tie_pay != 0.0;
    const BoardSupport& masks = board_support_for(turn, river);
    const std::pmr::vector<std::uint16_t>& live_idx = hero == 0 ? masks.idx0 : masks.idx1;
    std::fill(ev.begin(), ev.end(), 0.0);
    const double* prefix = ctx.prefix_buf.data();
    const double* block = ctx.block_buf.data();
    const std::uint32_t* block_base = ctx.block_base;
    const std::uint16_t* worse_end = table.worse_end[hero].data();
    const std::uint16_t* better_begin = table.better_begin[hero].data();
    const std::uint16_t* card_cut = table.card_cut[hero].data();
    const std::uint32_t* card_off = table.card_off[opp].data();
    const std::uint16_t* pos = table.pos[opp].data();
    const int* hole0 = hole_a[hero].data();
    const int* hole1 = hole_b[hero].data();
    const int* twins = twin_hand[hero].data();
    const double* weights = range_w[hero].data();
    const double low_pay = hero == 0 ? win_pay : lose_pay;
    const double high_pay = hero == 0 ? lose_pay : win_pay;
    const double scale = joint_scale;
    const double prefix_end = prefix[static_cast<std::size_t>(opp_hands)];
    for (std::uint16_t hand_u : live_idx)
    {
        const int hand = static_cast<int>(hand_u);
        const int worse = worse_end[static_cast<std::size_t>(hand)];
        const int after_tie = better_begin[static_cast<std::size_t>(hand)];
        const int c0 = hole0[static_cast<std::size_t>(hand)];
        const int c1 = hole1[static_cast<std::size_t>(hand)];
        const std::size_t cut_at = static_cast<std::size_t>(hand) * 4;
        const int cut0_worse = card_cut[cut_at];
        const int cut1_worse = card_cut[cut_at + 1];
        const int cut0_better = card_cut[cut_at + 2];
        const int cut1_better = card_cut[cut_at + 3];
        const std::uint32_t base0 = block_base[static_cast<std::size_t>(c0)];
        const std::uint32_t base1 = block_base[static_cast<std::size_t>(c1)];
        const int len0 = static_cast<int>(
            card_off[static_cast<std::size_t>(c0 + 1)] - card_off[static_cast<std::size_t>(c0)]);
        const int len1 = static_cast<int>(
            card_off[static_cast<std::size_t>(c1 + 1)] - card_off[static_cast<std::size_t>(c1)]);
        const double b0_0 = block[static_cast<std::size_t>(base0)];
        const double b0_w = block[static_cast<std::size_t>(base0 + static_cast<std::uint32_t>(cut0_worse))];
        const double b0_b = block[static_cast<std::size_t>(base0 + static_cast<std::uint32_t>(cut0_better))];
        const double b0_l = block[static_cast<std::size_t>(base0 + static_cast<std::uint32_t>(len0))];
        const double b1_0 = block[static_cast<std::size_t>(base1)];
        const double b1_w = block[static_cast<std::size_t>(base1 + static_cast<std::uint32_t>(cut1_worse))];
        const double b1_b = block[static_cast<std::size_t>(base1 + static_cast<std::uint32_t>(cut1_better))];
        const double b1_l = block[static_cast<std::size_t>(base1 + static_cast<std::uint32_t>(len1))];
        const int twin = twins[static_cast<std::size_t>(hand)];
        const int add_hand = twin >= 0 && opp_amount[static_cast<std::size_t>(twin)] != 0.0
            ? twin : -1;
        const int add_at = add_hand >= 0 ? static_cast<int>(pos[static_cast<std::size_t>(add_hand)]) : -1;
        const double add_piece = add_hand >= 0 ? opp_amount[static_cast<std::size_t>(add_hand)] : 0.0;
        // prefix[0] is always 0 after order_reach.
        double worse_mass = prefix[static_cast<std::size_t>(worse)]
            - (b0_w - b0_0) - (b1_w - b1_0);
        if (add_at >= 0 && add_at < worse)
        {
            worse_mass += add_piece;
        }
        double better_mass = prefix_end - prefix[static_cast<std::size_t>(after_tie)]
            - (b0_l - b0_b) - (b1_l - b1_b);
        if (add_at >= after_tie && add_at < opp_hands)
        {
            better_mass += add_piece;
        }
        double tie_mass = 0.0;
        if (need_ties)
        {
            tie_mass = prefix[static_cast<std::size_t>(after_tie)] - prefix[static_cast<std::size_t>(worse)]
                - (b0_b - b0_w) - (b1_b - b1_w);
            if (add_at >= worse && add_at < after_tie)
            {
                tie_mass += add_piece;
            }
        }
        if (stable)
        {
            const bool worse_ok = difference_is_stable(amount_total, amount_total - worse_mass, worse_mass);
            const bool better_ok = difference_is_stable(amount_total, amount_total - better_mass, better_mass);
            const bool tie_ok = !need_ties
                || difference_is_stable(amount_total, amount_total - tie_mass, tie_mass);
            if (!worse_ok || !better_ok || !tie_ok)
            {
                direct_rank_masses(
                    table, hero, hand, opp_amount, worse_mass, better_mass,
                    need_ties ? &tie_mass : nullptr);
            }
        }
        double weighted = low_pay * worse_mass + high_pay * better_mass;
        if (need_ties)
        {
            weighted += tie_pay * tie_mass;
        }
        ev[static_cast<std::size_t>(hand)] =
            weights[static_cast<std::size_t>(hand)] * scale * weighted;
    }
    if (profile_)
    {
        ctx.showdown_seconds += std::chrono::duration<double>(
            std::chrono::steady_clock::now() - started).count();
    }
}



void StreetBatchSolver::Engine::apply_terminal(
    WorkerContext& ctx,
    const Node& node,
    int turn,
    int river,
    const double* pi0,
    const double* pi1,
    std::span<double> ev0,
    std::span<double> ev1,
    bool stable) const
{
    double total0 = 0.0;
    double total1 = 0.0;
    if (node.folded >= 0)
    {
        double by0[52];
        double by1[52];
        collect_reach(ctx, 0, turn, river, pi0, true, ctx.amount_buf[0], total0, by0);
        collect_reach(ctx, 1, turn, river, pi1, true, ctx.amount_buf[1], total1, by1);
        const auto fold_started = profile_
            ? std::chrono::steady_clock::now()
            : std::chrono::steady_clock::time_point{};
        PlayerPayoff fold_pay = apply_icm_terminal(
            config.icm,
            ChipPayoff::terminal(
                config.pot,
                node.contrib[0],
                node.contrib[1],
                node.folded,
                0,
                config.rake));
        fold_pay.utility[0] += node.incentive_u0;
        fold_pay.utility[1] += node.incentive_u1;
        const BoardSupport& fold_masks = board_support_for(turn, river);
        std::fill(ev0.begin(), ev0.end(), 0.0);
        std::fill(ev1.begin(), ev1.end(), 0.0);
        for (std::uint16_t hand_u : fold_masks.idx0)
        {
            const int hand = static_cast<int>(hand_u);
            const double open = stable
                ? stable_compatible_mass(0, hand, 1, total1, by1, ctx.amount_buf[1])
                : total1 - blocked_reach(0, hand, by1, ctx.amount_buf[1]);
            ev0[static_cast<std::size_t>(hand)] =
                fold_pay.utility[0] * range_w[0][static_cast<std::size_t>(hand)]
                * joint_scale * open;
        }
        for (std::uint16_t hand_u : fold_masks.idx1)
        {
            const int hand = static_cast<int>(hand_u);
            const double open = stable
                ? stable_compatible_mass(1, hand, 0, total0, by0, ctx.amount_buf[0])
                : total0 - blocked_reach(1, hand, by0, ctx.amount_buf[0]);
            ev1[static_cast<std::size_t>(hand)] =
                fold_pay.utility[1] * range_w[1][static_cast<std::size_t>(hand)]
                * joint_scale * open;
        }
        if (profile_)
        {
            ctx.fold_seconds += std::chrono::duration<double>(
                std::chrono::steady_clock::now() - fold_started).count();
        }
        return;
    }
    // Showdown only needs hand-indexed amounts; skip by-card aggregates.
    collect_reach(ctx, 0, turn, river, pi0, true, ctx.amount_buf[0], total0, nullptr);
    collect_reach(ctx, 1, turn, river, pi1, true, ctx.amount_buf[1], total1, nullptr);
    PlayerPayoff win_paid = apply_icm_terminal(
        config.icm,
        ChipPayoff::terminal(
            config.pot, node.contrib[0], node.contrib[1], -1, 1, config.rake));
    PlayerPayoff lose_paid = apply_icm_terminal(
        config.icm,
        ChipPayoff::terminal(
            config.pot, node.contrib[0], node.contrib[1], -1, -1, config.rake));
    PlayerPayoff tie_paid = apply_icm_terminal(
        config.icm,
        ChipPayoff::terminal(
            config.pot, node.contrib[0], node.contrib[1], -1, 0, config.rake));
    win_paid.utility[0] += node.incentive_u0;
    win_paid.utility[1] += node.incentive_u1;
    lose_paid.utility[0] += node.incentive_u0;
    lose_paid.utility[1] += node.incentive_u1;
    tie_paid.utility[0] += node.incentive_u0;
    tie_paid.utility[1] += node.incentive_u1;
    showdown_side(
        ctx, 0, turn, river,
        win_paid.utility[0], lose_paid.utility[0], tie_paid.utility[0],
        ctx.amount_buf[1], ev0, stable);
    // Pass player-1 utilities: showdown_side swaps win/lose for hero 1 so
    // beating worse opponents scores lose_paid.utility[1] (p0 lost).
    showdown_side(
        ctx, 1, turn, river,
        win_paid.utility[1], lose_paid.utility[1], tie_paid.utility[1],
        ctx.amount_buf[0], ev1, stable);
}



void StreetBatchSolver::Engine::zero_unsupported(std::vector<double>& reach, int player, int turn, int river) const
{
    for (int hand = 0; hand < static_cast<int>(reach.size()); ++hand)
    {
        if (!hand_supported(player, hand, turn, river))
        {
            reach[static_cast<std::size_t>(hand)] = 0.0;
        }
    }
}



void StreetBatchSolver::Engine::zero_card(std::vector<double>& reach, int player, int card) const
{
    for (int hand = 0; hand < static_cast<int>(reach.size()); ++hand)
    {
        if (hole_a[player][static_cast<std::size_t>(hand)] == card
            || hole_b[player][static_cast<std::size_t>(hand)] == card)
        {
            reach[static_cast<std::size_t>(hand)] = 0.0;
        }
    }
}



double StreetBatchSolver::Engine::joint_mass_of(const std::vector<double>& left, const std::vector<double>& right) const
{
    double total = 0.0;
    double by_card[52] = {};
    for (int hand = 0; hand < static_cast<int>(right.size()); ++hand)
    {
        const double weight = right[static_cast<std::size_t>(hand)];
        if (weight == 0.0)
        {
            continue;
        }
        total += weight;
        by_card[hole_a[1][static_cast<std::size_t>(hand)]] += weight;
        by_card[hole_b[1][static_cast<std::size_t>(hand)]] += weight;
    }
    double joint = 0.0;
    for (int hand = 0; hand < static_cast<int>(left.size()); ++hand)
    {
        const double weight = left[static_cast<std::size_t>(hand)];
        if (weight == 0.0)
        {
            continue;
        }
        const int card0 = hole_a[0][static_cast<std::size_t>(hand)];
        const int card1 = hole_b[0][static_cast<std::size_t>(hand)];
        double blocked = by_card[card0] + by_card[card1];
        const int same = hand_of[1][static_cast<std::size_t>(holdem::Range::combo_index(card0, card1))];
        if (same >= 0)
        {
            blocked -= right[static_cast<std::size_t>(same)];
        }
        const double open = total - blocked;
        const double mass = difference_is_stable(total, blocked, open)
            ? open
            : direct_compatible_mass(0, hand, 1, right);
        joint += weight * mass;
    }
    return joint;
}



void StreetBatchSolver::Engine::marginals_of(
    const std::vector<double>& reach,
    int player,
    const std::vector<double>& opponent,
    int opponent_player,
    double& joint,
    std::vector<double>& marginal) const
{
    double total = 0.0;
    double by_card[52] = {};
    for (int hand = 0; hand < static_cast<int>(opponent.size()); ++hand)
    {
        const double weight = opponent[static_cast<std::size_t>(hand)];
        if (weight == 0.0)
        {
            continue;
        }
        total += weight;
        by_card[hole_a[opponent_player][static_cast<std::size_t>(hand)]] += weight;
        by_card[hole_b[opponent_player][static_cast<std::size_t>(hand)]] += weight;
    }
    joint = 0.0;
    marginal.assign(reach.size(), 0.0);
    for (int hand = 0; hand < static_cast<int>(reach.size()); ++hand)
    {
        const int card0 = hole_a[player][static_cast<std::size_t>(hand)];
        const int card1 = hole_b[player][static_cast<std::size_t>(hand)];
        double blocked = by_card[card0] + by_card[card1];
        const int same = hand_of[opponent_player][static_cast<std::size_t>(
            holdem::Range::combo_index(card0, card1))];
        if (same >= 0)
        {
            blocked -= opponent[static_cast<std::size_t>(same)];
        }
        const double open = total - blocked;
        const double mass = difference_is_stable(total, blocked, open)
            ? open
            : direct_compatible_mass(player, hand, opponent_player, opponent);
        const double piece = reach[static_cast<std::size_t>(hand)] * mass;
        marginal[static_cast<std::size_t>(hand)] = piece;
        joint += piece;
    }
    if (joint > 0.0)
    {
        for (double& value : marginal)
        {
            value /= joint;
        }
    }
}



namespace
{

void check_equity_cancel(const std::atomic<bool>* cancel)
{
    if (cancel != nullptr && cancel->load())
    {
        throw StreetValueCancelled();
    }
}

bool board_has_card(std::span<const int> board, int card)
{
    for (int seen : board)
    {
        if (seen == card)
        {
            return true;
        }
    }
    return false;
}

holdem::PlayerShowdown finish_checkdown_player(
    int player,
    std::span<const double> reach,
    std::span<const double> win_mass,
    std::span<const double> tie_mass,
    std::span<const double> compatible_mass,
    std::span<const int> combo_ids)
{
    holdem::PlayerShowdown out;
    double weight_compat = 0.0;
    double weighted_equity = 0.0;
    double weighted_win = 0.0;
    double weighted_tie = 0.0;
    double weighted_loss = 0.0;
    for (int hand = 0; hand < static_cast<int>(reach.size()); ++hand)
    {
        const double weight = reach[static_cast<std::size_t>(hand)];
        if (!(weight > 0.0) || !std::isfinite(weight))
        {
            continue;
        }
        const double compatible = compatible_mass[static_cast<std::size_t>(hand)];
        holdem::ComboShowdown row;
        row.index = combo_ids[static_cast<std::size_t>(hand)];
        row.combo = holdem::Range::combo_text(row.index);
        row.input_weight = weight;
        if (!(compatible > 0.0) || !std::isfinite(compatible))
        {
            row.defined = false;
            out.combos.push_back(std::move(row));
            continue;
        }
        const double wins = win_mass[static_cast<std::size_t>(hand)];
        const double ties = tie_mass[static_cast<std::size_t>(hand)];
        const double losses = compatible - wins - ties;
        row.defined = true;
        row.compatible_mass = compatible;
        row.marginal = weight * compatible;
        row.win = wins / compatible;
        row.tie = ties / compatible;
        row.loss = losses / compatible;
        row.equity = (wins + 0.5 * ties) / compatible;
        weight_compat += row.marginal;
        weighted_equity += row.marginal * row.equity;
        weighted_win += row.marginal * row.win;
        weighted_tie += row.marginal * row.tie;
        weighted_loss += row.marginal * row.loss;
        out.combos.push_back(std::move(row));
        (void)player;
    }
    if (weight_compat > 0.0 && std::isfinite(weight_compat))
    {
        out.defined = true;
        out.equity = weighted_equity / weight_compat;
        out.win = weighted_win / weight_compat;
        out.tie = weighted_tie / weight_compat;
        out.loss = weighted_loss / weight_compat;
    }
    return out;
}

} // namespace

holdem::ShowdownEquity StreetBatchSolver::Engine::compute_checkdown_equity(
    const std::string& text,
    const std::atomic<bool>* cancel) const
{
    ensure_average();
    ensure_ranks();
    check_equity_cancel(cancel);
    int node_index = 0;
    int node_turn = -1;
    int node_river = -1;
    locate_node(text, node_index, node_turn, node_river);
    std::vector<double> q0;
    std::vector<double> q1;
    replay_weights(node_index, node_turn, node_river, q0, q1);

    std::vector<int> board = config.board;
    if (node_turn >= 0)
    {
        board.push_back(node_turn);
    }
    if (node_river >= 0)
    {
        board.push_back(node_river);
    }

    holdem::ShowdownEquity result;
    result.work.completions_per_pair = board.size() >= 5 ? 1
        : (board.size() == 4 ? 44 : 990);
    // Solver path cost tracks completions × indexed hands, not pair-runouts.
    result.work.legal_pairs = 0;
    result.work.pair_runouts = 0;

    std::vector<double> win0(static_cast<std::size_t>(n0), 0.0);
    std::vector<double> tie0(static_cast<std::size_t>(n0), 0.0);
    std::vector<double> compat0(static_cast<std::size_t>(n0), 0.0);
    std::vector<double> win1(static_cast<std::size_t>(n1), 0.0);
    std::vector<double> tie1(static_cast<std::size_t>(n1), 0.0);
    std::vector<double> compat1(static_cast<std::size_t>(n1), 0.0);
    std::vector<double> amount0(static_cast<std::size_t>(n0), 0.0);
    std::vector<double> amount1(static_cast<std::size_t>(n1), 0.0);

    const auto accumulate_side = [&](
        int hero,
        int turn,
        int river,
        std::span<const double> hero_reach,
        std::span<const double> opp_amount,
        std::vector<double>& win_acc,
        std::vector<double>& tie_acc,
        std::vector<double>& compat_acc)
    {
        const int opp = 1 - hero;
        const RunoutRanks& table = runout_for(turn, river);
        order_reach(workspace, opp, opp_amount, table);
        const int opp_hands = static_cast<int>(opp_amount.size());
        double amount_total = 0.0;
        for (double piece : opp_amount)
        {
            if (piece > 0.0)
            {
                amount_total += piece;
            }
        }
        const BoardSupport& masks = board_support_for(turn, river);
        const std::pmr::vector<std::uint16_t>& live_idx = hero == 0 ? masks.idx0 : masks.idx1;
        const double* prefix = workspace.prefix_buf.data();
        const double* block = workspace.block_buf.data();
        const std::uint32_t* block_base = workspace.block_base;
        const std::uint16_t* worse_end = table.worse_end[hero].data();
        const std::uint16_t* better_begin = table.better_begin[hero].data();
        const std::uint16_t* card_cut = table.card_cut[hero].data();
        const std::uint32_t* card_off = table.card_off[opp].data();
        const std::uint16_t* pos = table.pos[opp].data();
        const int* hole0 = hole_a[hero].data();
        const int* hole1 = hole_b[hero].data();
        const int* twins = twin_hand[hero].data();
        const double prefix_end = prefix[static_cast<std::size_t>(opp_hands)];
        for (std::uint16_t hand_u : live_idx)
        {
            const int hand = static_cast<int>(hand_u);
            if (!(hero_reach[static_cast<std::size_t>(hand)] > 0.0))
            {
                continue;
            }
            const int worse = worse_end[static_cast<std::size_t>(hand)];
            const int after_tie = better_begin[static_cast<std::size_t>(hand)];
            const int c0 = hole0[static_cast<std::size_t>(hand)];
            const int c1 = hole1[static_cast<std::size_t>(hand)];
            const std::size_t cut_at = static_cast<std::size_t>(hand) * 4;
            const int cut0_worse = card_cut[cut_at];
            const int cut1_worse = card_cut[cut_at + 1];
            const int cut0_better = card_cut[cut_at + 2];
            const int cut1_better = card_cut[cut_at + 3];
            const std::uint32_t base0 = block_base[static_cast<std::size_t>(c0)];
            const std::uint32_t base1 = block_base[static_cast<std::size_t>(c1)];
            const int len0 = static_cast<int>(
                card_off[static_cast<std::size_t>(c0 + 1)] - card_off[static_cast<std::size_t>(c0)]);
            const int len1 = static_cast<int>(
                card_off[static_cast<std::size_t>(c1 + 1)] - card_off[static_cast<std::size_t>(c1)]);
            const double b0_0 = block[static_cast<std::size_t>(base0)];
            const double b0_w = block[static_cast<std::size_t>(base0 + static_cast<std::uint32_t>(cut0_worse))];
            const double b0_b = block[static_cast<std::size_t>(base0 + static_cast<std::uint32_t>(cut0_better))];
            const double b0_l = block[static_cast<std::size_t>(base0 + static_cast<std::uint32_t>(len0))];
            const double b1_0 = block[static_cast<std::size_t>(base1)];
            const double b1_w = block[static_cast<std::size_t>(base1 + static_cast<std::uint32_t>(cut1_worse))];
            const double b1_b = block[static_cast<std::size_t>(base1 + static_cast<std::uint32_t>(cut1_better))];
            const double b1_l = block[static_cast<std::size_t>(base1 + static_cast<std::uint32_t>(len1))];
            const int twin = twins[static_cast<std::size_t>(hand)];
            const int add_hand = twin >= 0 && opp_amount[static_cast<std::size_t>(twin)] != 0.0
                ? twin : -1;
            const int add_at = add_hand >= 0 ? static_cast<int>(pos[static_cast<std::size_t>(add_hand)]) : -1;
            const double add_piece = add_hand >= 0 ? opp_amount[static_cast<std::size_t>(add_hand)] : 0.0;
            double worse_mass = prefix[static_cast<std::size_t>(worse)]
                - (b0_w - b0_0) - (b1_w - b1_0);
            if (add_at >= 0 && add_at < worse)
            {
                worse_mass += add_piece;
            }
            double better_mass = prefix_end - prefix[static_cast<std::size_t>(after_tie)]
                - (b0_l - b0_b) - (b1_l - b1_b);
            if (add_at >= after_tie && add_at < opp_hands)
            {
                better_mass += add_piece;
            }
            double tie_mass = prefix[static_cast<std::size_t>(after_tie)] - prefix[static_cast<std::size_t>(worse)]
                - (b0_b - b0_w) - (b1_b - b1_w);
            if (add_at >= worse && add_at < after_tie)
            {
                tie_mass += add_piece;
            }
            const bool worse_ok = difference_is_stable(amount_total, amount_total - worse_mass, worse_mass);
            const bool better_ok = difference_is_stable(amount_total, amount_total - better_mass, better_mass);
            const bool tie_ok = difference_is_stable(amount_total, amount_total - tie_mass, tie_mass);
            if (!worse_ok || !better_ok || !tie_ok)
            {
                direct_rank_masses(table, hero, hand, opp_amount, worse_mass, better_mass, &tie_mass);
            }
            // worse_end is opponents with lower pack_rank than hero → hero wins.
            // Chip-EV showdown_side remaps pays by seat; equity does not.
            const double hero_win = worse_mass;
            const double hero_loss = better_mass;
            const double compatible = hero_win + hero_loss + tie_mass;
            if (!(compatible > 0.0))
            {
                continue;
            }
            win_acc[static_cast<std::size_t>(hand)] += hero_win;
            tie_acc[static_cast<std::size_t>(hand)] += tie_mass;
            compat_acc[static_cast<std::size_t>(hand)] += compatible;
        }
    };

    const auto accumulate_runout = [&](int turn, int river)
    {
        check_equity_cancel(cancel);
        for (int hand = 0; hand < n0; ++hand)
        {
            amount0[static_cast<std::size_t>(hand)] =
                hand_live(0, hand, turn, river) ? q0[static_cast<std::size_t>(hand)] : 0.0;
        }
        for (int hand = 0; hand < n1; ++hand)
        {
            amount1[static_cast<std::size_t>(hand)] =
                hand_live(1, hand, turn, river) ? q1[static_cast<std::size_t>(hand)] : 0.0;
        }
        accumulate_side(0, turn, river, q0, amount1, win0, tie0, compat0);
        accumulate_side(1, turn, river, q1, amount0, win1, tie1, compat1);
    };

    if (board.size() >= 5)
    {
        // River configs use the reserved (-1,-1) key; flop/turn solutions that
        // already dealt both cards use the node's (turn, river).
        if (config.board.size() == 5)
        {
            accumulate_runout(-1, -1);
        }
        else
        {
            accumulate_runout(node_turn, node_river);
        }
        result.work.completions_per_pair = 1;
    }
    else if (board.size() == 4)
    {
        result.work.completions_per_pair = 0;
        for (int river = 0; river < 52; ++river)
        {
            if (board_has_card(board, river))
            {
                continue;
            }
            ++result.work.completions_per_pair;
            if (config.board.size() == 4)
            {
                accumulate_runout(-1, river);
            }
            else
            {
                accumulate_runout(node_turn, river);
            }
        }
    }
    else
    {
        // Flop root: one representative per unordered completion (turn < river).
        result.work.completions_per_pair = 0;
        for (int turn = 0; turn < 52; ++turn)
        {
            if (board_has_card(board, turn))
            {
                continue;
            }
            for (int river = turn + 1; river < 52; ++river)
            {
                if (board_has_card(board, river))
                {
                    continue;
                }
                ++result.work.completions_per_pair;
                accumulate_runout(turn, river);
            }
        }
    }

    std::vector<int> combos0(combos[0].begin(), combos[0].end());
    std::vector<int> combos1(combos[1].begin(), combos[1].end());
    result.player0 = finish_checkdown_player(0, q0, win0, tie0, compat0, combos0);
    result.player1 = finish_checkdown_player(1, q1, win1, tie1, compat1, combos1);
    result.joint_defined = result.player0.defined && result.player1.defined;
    return result;
}


} // namespace poker::solver
