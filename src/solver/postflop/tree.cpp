// StreetBatchSolver::Engine method definitions.
#include "engine.hpp"

namespace poker::solver
{


StreetBatchSolver::Engine::Engine(streets::StreetConfig incoming, BudgetResource& budget, bool plan_only)
    : config(std::move(incoming))
    , budget_(&budget)
    , heap_(&budget)
    , combos{std::pmr::vector<int>(heap_), std::pmr::vector<int>(heap_)}
    , deals(heap_)
    , nodes(heap_)
    , parent_link(heap_)
    , slots(heap_)
    , player_slots_{std::pmr::vector<std::uint32_t>(heap_), std::pmr::vector<std::uint32_t>(heap_)}
    , decision_ids(heap_)
    , regret(heap_)
    , strategy_sum(heap_)
    , sigma(heap_)
    , response(heap_)
    , combo_blocked(heap_)
    , combo_low(heap_)
    , combo_high(heap_)
    , combo_to_hand{std::pmr::vector<int>(heap_), std::pmr::vector<int>(heap_)}
    , range_w{std::pmr::vector<double>(heap_), std::pmr::vector<double>(heap_)}
    , hole_a{std::pmr::vector<int>(heap_), std::pmr::vector<int>(heap_)}
    , hole_b{std::pmr::vector<int>(heap_), std::pmr::vector<int>(heap_)}
    , hand_of{std::pmr::vector<int>(heap_), std::pmr::vector<int>(heap_)}
    , twin_hand{std::pmr::vector<int>(heap_), std::pmr::vector<int>(heap_)}
    , runout_ranks(heap_)
    , board_support_(heap_)
    , workspace(heap_)
    , mask{std::pmr::vector<std::uint64_t>(heap_), std::pmr::vector<std::uint64_t>(heap_)}
    , support{std::pmr::vector<Support>(heap_), std::pmr::vector<Support>(heap_)}
    , prediction_(heap_)
    , result0_(heap_)
    , result1_(heap_)
    , mode1_cards_(heap_)
    , mode2_of_(heap_)
    , mode2_turn_(heap_)
    , mode2_river_(heap_)
    , plan_only_(plan_only)
{
    const auto started = std::chrono::steady_clock::now();
    validate();
    build_runout_index();
    budget_->set_stage("public_tree");
    BetState root;
    root.pot = config.pot;
    root.acting = config.first_to_act;
    root.street = 0;
    build_node(root, "", 0);
    index_parents();
    fill_terminal_incentives();
    count_and_index_hands();
    set_hand_counts();
    visit_slots(false);
    estimated_peak_bytes_ = checked_add(budget_->current(), planned_allocation_bytes(), "plan");
    if (plan_only_)
    {
        // Dry-run: labeled peak and tree counts are ready. Skip deals, slot
        // indexes, regret/strategy tables, reach, and worker contexts.
        construction_seconds_ = std::chrono::duration<double>(
            std::chrono::steady_clock::now() - started).count();
        return;
    }
    fill_deals();
    allocate_slot_of();
    allocate_slots();
    visit_slots(true);
    if (static_cast<std::uint64_t>(slots.size()) != planned_slots_ || cursor_ != planned_cursor_)
    {
        throw std::logic_error("street slot registration did not match the memory plan");
    }
    allocate_tables();
    build_reach_table();
    construction_seconds_ = std::chrono::duration<double>(
        std::chrono::steady_clock::now() - started).count();
    const auto setup_started = std::chrono::steady_clock::now();
    try
    {
        setup_workers();
    }
    catch (...)
    {
        join_workers();
        destroy_extra_contexts();
        throw;
    }
    worker_setup_seconds_ = std::chrono::duration<double>(
        std::chrono::steady_clock::now() - setup_started).count();
}



StreetBatchSolver::Engine::~Engine()
{
    join_workers();
    destroy_extra_contexts();
}



void StreetBatchSolver::Engine::destroy_extra_contexts()
{
    for (int index = 0; index < extra_count_; ++index)
    {
        WorkerContext* ctx = extra_contexts_[index];
        extra_contexts_[index] = nullptr;
        if (ctx == nullptr)
        {
            continue;
        }
        ctx->~WorkerContext();
        budget_->deallocate(ctx, sizeof(WorkerContext), alignof(WorkerContext));
    }
    extra_count_ = 0;
}



void StreetBatchSolver::Engine::validate() const
{
    if (config.board.size() != 3 && config.board.size() != 4 && config.board.size() != 5)
    {
        throw std::invalid_argument("street solver board must have 3, 4, or 5 cards");
    }
    holdem::validate_board(config.board.data(), static_cast<int>(config.board.size()));
    if (config.pot <= 0)
    {
        throw std::invalid_argument("pot must be positive");
    }
    if (config.stack < 0)
    {
        throw std::invalid_argument("stack must be nonnegative");
    }
    if (config.first_to_act != 0 && config.first_to_act != 1)
    {
        throw std::invalid_argument("first player must be 0 (OOP) or 1 (IP)");
    }
    if (config.max_raises < 0 || config.max_raises > 6)
    {
        throw std::invalid_argument("max raises must be from 0 through 6");
    }
    if (config.all_in_threshold < 0.0)
    {
        throw std::invalid_argument("all-in threshold must be nonnegative");
    }
    if (config.pot_cap < 0.0)
    {
        throw std::invalid_argument("pot cap must be nonnegative");
    }
    config.rake.validate();
    config.icm.validate(config.pot, config.stack);
    config.incentives.validate();
    if (config.threads < 1 || config.threads > kMaxThreads)
    {
        throw std::invalid_argument(
            "thread count must be a positive integer from 1 through 64");
    }
}



int StreetBatchSolver::Engine::build_node(const BetState& state, std::string_view path, int depth)
{
    if (depth > 48)
    {
        throw std::logic_error("public street tree deeper than 48");
    }
    if (state.terminal)
    {
        Node node(std::allocator_arg, heap_);
        node.terminal = true;
        node.street = state.street;
        node.folded = state.folded;
        node.contrib[0] = state.contrib[0];
        node.contrib[1] = state.contrib[1];
        nodes.push_back(std::move(node));
        ++public_terminals;
        return static_cast<int>(nodes.size()) - 1;
    }
    if (state.chance)
    {
        Node node(std::allocator_arg, heap_);
        node.chance = true;
        node.street = state.street;
        node.deal_which = state.deal_which;
        // Keep street investments for inspection / local_offset (same as terminals).
        node.contrib[0] = state.contrib[0];
        node.contrib[1] = state.contrib[1];
        const int id = static_cast<int>(nodes.size());
        nodes.push_back(std::move(node));
        BetState next = state;
        next.chance = false;
        next.deal_which = 0;
        next.acting = config.first_to_act;
        next.pending_check = false;
        next.last_raise = 0;
        next.num_raises = 0;
        next.committed = next.contrib[0];
        nodes[static_cast<std::size_t>(id)].child[0] = build_node(next, path, depth);
        return id;
    }

    Legal legal = legal_actions(config, state);
    apply_tree_edits(legal, config, state, path, heap_);
    const bool facing = state.committed > state.contrib[state.acting];
    Node node(std::allocator_arg, heap_);
    node.player = state.acting;
    node.street = state.street;
    node.depth = depth;
    node.n_actions = legal.count;
    // Decision nodes need contrib for /values local_offset (Fold-now sunk cost).
    node.contrib[0] = state.contrib[0];
    node.contrib[1] = state.contrib[1];
    node.path.assign(path.data(), path.size());
    if (config.board.size() == 3)
    {
        if (state.street == 0)
        {
            node.card_mode = 0;
        }
        else if (state.street == 1)
        {
            node.card_mode = 1;
            node.mode1_is_turn = true;
        }
        else
        {
            node.card_mode = 2;
        }
    }
    else if (config.board.size() == 5)
    {
        // River: no public cards left to deal.
        node.card_mode = 0;
    }
    else
    {
        node.card_mode = state.street == 0 ? 0 : 1;
        node.mode1_is_turn = false;
    }
    for (int action = 0; action < legal.count; ++action)
    {
        const int street_total = state.contrib[state.acting] + legal.add[action];
        const bool all_in = legal.code[action] != 0 && street_total == config.stack && legal.add[action] > 0;
        node.action_labels[action] = chip_label(
            legal.code[action], legal.add[action], street_total, all_in, facing, heap_);
    }
    const int id = static_cast<int>(nodes.size());
    nodes.push_back(std::move(node));
    ++public_decisions;
    decision_ids.push_back(id);
    for (int action = 0; action < legal.count; ++action)
    {
        const std::pmr::string& label = nodes[static_cast<std::size_t>(id)].action_labels[action];
        std::pmr::string next_path(heap_);
        if (path.empty())
        {
            next_path.assign(label.data(), label.size());
        }
        else
        {
            next_path.reserve(path.size() + 1 + label.size());
            next_path.assign(path.data(), path.size());
            next_path.push_back('/');
            next_path.append(label.data(), label.size());
        }
        const int child = build_node(apply_action(config, state, legal, action), next_path, depth + 1);
        nodes[static_cast<std::size_t>(id)].child[action] = child;
    }
    return id;
}



void StreetBatchSolver::Engine::prepare_pair_scan()
{
    combo_blocked.assign(static_cast<std::size_t>(holdem::kComboCount), 0);
    combo_low.assign(static_cast<std::size_t>(holdem::kComboCount), 0);
    combo_high.assign(static_cast<std::size_t>(holdem::kComboCount), 0);
    for (int combo = 0; combo < holdem::kComboCount; ++combo)
    {
        int low = 0;
        int high = 0;
        holdem::Range::combo_cards(combo, low, high);
        combo_low[static_cast<std::size_t>(combo)] = low;
        combo_high[static_cast<std::size_t>(combo)] = high;
        for (int card : config.board)
        {
            if (card == low || card == high)
            {
                combo_blocked[static_cast<std::size_t>(combo)] = 1;
            }
        }
    }
    joint_mass_ = holdem::joint_mass(
        config.oop, config.ip, config.board.data(), static_cast<int>(config.board.size()));
}



void StreetBatchSolver::Engine::count_and_index_hands()
{
    budget_->set_stage("combos");
    prepare_pair_scan();
    if (joint_mass_ <= 0.0)
    {
        throw std::invalid_argument("ranges leave no legal hand pair");
    }
    combo_to_hand[0].assign(static_cast<std::size_t>(holdem::kComboCount), -1);
    combo_to_hand[1].assign(static_cast<std::size_t>(holdem::kComboCount), -1);
    std::uint64_t count = 0;
    for_each_legal_pair([&](int first, int second, double)
    {
        ++count;
        if (combo_to_hand[0][static_cast<std::size_t>(first)] < 0)
        {
            combo_to_hand[0][static_cast<std::size_t>(first)] = static_cast<int>(combos[0].size());
            combos[0].push_back(first);
        }
        if (combo_to_hand[1][static_cast<std::size_t>(second)] < 0)
        {
            combo_to_hand[1][static_cast<std::size_t>(second)] = static_cast<int>(combos[1].size());
            combos[1].push_back(second);
        }
    });
    if (count == 0)
    {
        throw std::invalid_argument("ranges leave no legal hand pair");
    }
    counted_deals_ = count;
    n0 = static_cast<int>(combos[0].size());
    n1 = static_cast<int>(combos[1].size());
}



void StreetBatchSolver::Engine::fill_deals()
{
    budget_->set_stage("deals");
    deals.reserve(static_cast<std::size_t>(counted_deals_));
    for_each_legal_pair([&](int first, int second, double product)
    {
        Deal deal;
        deal.combo0 = first;
        deal.combo1 = second;
        deal.h0 = combo_to_hand[0][static_cast<std::size_t>(first)];
        deal.h1 = combo_to_hand[1][static_cast<std::size_t>(second)];
        deal.probability = product / joint_mass_;
        deal.c0 = combo_low[static_cast<std::size_t>(first)];
        deal.c1 = combo_high[static_cast<std::size_t>(first)];
        deal.d0 = combo_low[static_cast<std::size_t>(second)];
        deal.d1 = combo_high[static_cast<std::size_t>(second)];
        deals.push_back(deal);
    });
    if (deals.size() != static_cast<std::size_t>(counted_deals_))
    {
        throw std::logic_error("street deal fill did not match the counted pairs");
    }
}



void StreetBatchSolver::Engine::set_hand_counts()
{
    for (Node& node : nodes)
    {
        if (node.terminal || node.chance)
        {
            continue;
        }
        node.hands = node.player == 0 ? n0 : n1;
    }
}



void StreetBatchSolver::Engine::build_runout_index()
{
    budget_->set_stage("runout_index");
    mode1_of_.fill(-1);
    mode1_cards_.clear();
    mode2_of_.clear();
    mode2_turn_.clear();
    mode2_river_.clear();
    bool on_board[52] = {};
    for (int card : config.board)
    {
        on_board[card] = true;
    }
    for (int card = 0; card < 52; ++card)
    {
        if (on_board[card])
        {
            continue;
        }
        mode1_of_[static_cast<std::size_t>(card)] = static_cast<int>(mode1_cards_.size());
        mode1_cards_.push_back(card);
    }
    if (config.board.size() != 3)
    {
        return;
    }
    mode2_of_.assign(static_cast<std::size_t>(52 * 52), -1);
    for (int turn = 0; turn < 52; ++turn)
    {
        if (on_board[turn])
        {
            continue;
        }
        for (int river = 0; river < 52; ++river)
        {
            if (river == turn || on_board[river])
            {
                continue;
            }
            const int key = turn * 52 + river;
            mode2_of_[static_cast<std::size_t>(key)] = static_cast<int>(mode2_turn_.size());
            mode2_turn_.push_back(turn);
            mode2_river_.push_back(river);
        }
    }
}



std::uint64_t StreetBatchSolver::Engine::runout_dim(const Node& node) const
{
    if (node.card_mode == 1)
    {
        return static_cast<std::uint64_t>(mode1_cards_.size());
    }
    if (node.card_mode == 2)
    {
        return static_cast<std::uint64_t>(mode2_turn_.size());
    }
    return 1;
}



int StreetBatchSolver::Engine::slot_action_count(const Slot& slot) const
{
    return nodes[static_cast<std::size_t>(slot.node)].n_actions;
}



std::uint64_t StreetBatchSolver::Engine::slot_index_cells() const
{
    std::uint64_t cells = 0;
    for (const Node& node : nodes)
    {
        if (node.terminal || node.chance || node.n_actions <= 1)
        {
            continue;
        }
        cells = checked_add(
            cells,
            checked_mul(runout_dim(node), static_cast<std::uint64_t>(node.hands), "slot index"),
            "slot index");
    }
    return cells;
}



std::uint64_t StreetBatchSolver::Engine::planned_allocation_bytes() const
{
    const std::uint64_t hands0 = static_cast<std::uint64_t>(n0);
    const std::uint64_t hands1 = static_cast<std::uint64_t>(n1);
    const std::uint64_t wide = hands0 > hands1 ? hands0 : hands1;
    std::uint64_t total = 0;
    const std::uint64_t header = static_cast<std::uint64_t>(
        BudgetResource::request_bytes(0, alignof(std::max_align_t)));
    const auto add = [&](std::uint64_t bytes)
    {
        total = checked_add(total, bytes, "plan");
        total = checked_add(total, header, "plan");
    };
    add(checked_mul(counted_deals_, sizeof(Deal), "plan"));
    // mode1_cards_ / mode2_* catalogs are already live in budget_->current()
    // (built before this plan); do not double-count them here.
    add(checked_mul(slot_index_cells(), sizeof(int), "plan"));
    add(checked_mul(planned_slots_, sizeof(Slot), "plan"));
    // Player-side slot indexes (each multi-action slot appears in exactly one).
    add(checked_mul(planned_slots_, sizeof(std::uint32_t), "plan"));
    // regret + strategy_sum + shared sigma workspace (float storage).
    const std::uint64_t table = checked_mul(
        static_cast<std::uint64_t>(planned_cursor_), sizeof(TableScalar), "plan");
    add(table);
    add(table);
    add(table);
    // ev/pi/aev doubles plus per-depth acting slot bases (wide ints).
    const std::uint64_t scratch_level = checked_add(
        checked_add(
            checked_mul(hands0, sizeof(double) * 10, "plan"),
            checked_mul(hands1, sizeof(double) * 10, "plan"),
            "plan"),
        checked_mul(wide, sizeof(int), "plan"),
        "plan");
    add(checked_mul(32, sizeof(Scratch), "plan"));
    add(checked_mul(32, scratch_level, "plan"));
    add(checked_mul(hands0 + hands1, sizeof(std::uint64_t), "plan"));
    add(checked_mul(hands0 + hands1, sizeof(double), "plan"));
    add(checked_mul((hands0 + hands1) * 2, sizeof(int), "plan"));
    add(checked_mul(static_cast<std::uint64_t>(holdem::kComboCount) * 2, sizeof(int), "plan"));
    // Same-combo twin indexes for showdown identical-hand correction.
    add(checked_mul(hands0 + hands1, sizeof(int), "plan"));
    add(checked_mul(wide + 1, sizeof(double), "plan"));
    add(checked_mul(
        checked_add(checked_mul(wide, 2, "plan"), 52, "plan"),
        sizeof(double),
        "plan"));
    // Rank-ordered opponent amounts for compact showdown prefixes.
    add(checked_mul(wide, sizeof(double), "plan"));
    add(checked_mul(planned_slots_, sizeof(int), "plan"));
    add(checked_mul(hands0 + hands1, sizeof(double), "plan"));
    // Worker-local board support masks reused across decision actions.
    add(checked_mul(hands0 + hands1, sizeof(char), "plan"));
    const int free_cards = 52 - static_cast<int>(config.board.size());
    const std::uint64_t keys = config.board.size() == 5
        ? 1ull
        : config.board.size() == 3
        ? checked_mul(
            static_cast<std::uint64_t>(free_cards),
            static_cast<std::uint64_t>(free_cards - 1),
            "plan")
        : static_cast<std::uint64_t>(free_cards);
    // Walkable boards include the root and, on a flop, each turn-only board.
    const std::uint64_t support_keys = config.board.size() == 5
        ? 1ull
        : config.board.size() == 3
        ? checked_add(
            1ull,
            checked_add(
                static_cast<std::uint64_t>(free_cards),
                keys,
                "plan"),
            "plan")
        : checked_add(1ull, static_cast<std::uint64_t>(free_cards), "plan");
    const auto side_meta = [&](std::uint64_t hands)
    {
        std::uint64_t bytes = checked_mul(hands, sizeof(std::uint32_t), "plan");
        bytes = checked_add(bytes, checked_mul(hands, sizeof(std::uint16_t) * 8, "plan"), "plan");
        bytes = checked_add(bytes, checked_mul(hands * 2, sizeof(std::uint16_t), "plan"), "plan");
        bytes = checked_add(bytes, checked_mul(53, sizeof(std::uint32_t), "plan"), "plan");
        return bytes;
    };
    const std::uint64_t payload = checked_add(side_meta(hands0), side_meta(hands1), "plan");
    // One map node per runout: three pointers plus the mapped object.
    // This is a plan, not the measured allocation.
    const std::uint64_t map_node = 3ull * sizeof(void*) + sizeof(RunoutRanks);
    add(checked_mul(keys, checked_add(payload, map_node, "plan"), "plan"));
    // live char masks plus dense supported-hand index lists per board.
    const std::uint64_t support_payload = checked_add(
        checked_mul(hands0 + hands1, sizeof(char), "plan"),
        checked_mul(hands0 + hands1, sizeof(std::uint16_t), "plan"),
        "plan");
    const std::uint64_t support_node = 3ull * sizeof(void*) + sizeof(BoardSupport);
    add(checked_mul(support_keys, checked_add(support_payload, support_node, "plan"), "plan"));
    if (config.threads > 1)
    {
        const std::uint64_t extra = static_cast<std::uint64_t>(config.threads - 1);
        const std::uint64_t extra_scratch = scratch_level;
        add(checked_mul(extra, sizeof(WorkerContext), "plan"));
        add(checked_mul(extra, checked_mul(32, sizeof(Scratch), "plan"), "plan"));
        add(checked_mul(extra, checked_mul(32, extra_scratch, "plan"), "plan"));
        add(checked_mul(extra, checked_mul(wide + 1, sizeof(double), "plan"), "plan"));
        add(checked_mul(
            extra,
            checked_mul(
                checked_add(checked_mul(wide, 2, "plan"), 52, "plan"),
                sizeof(double),
                "plan"),
            "plan"));
        add(checked_mul(extra, checked_mul(wide, sizeof(double), "plan"), "plan"));
        add(checked_mul(extra, checked_mul(hands0 + hands1, sizeof(double), "plan"), "plan"));
        add(checked_mul(extra, checked_mul(hands0 + hands1, sizeof(char), "plan"), "plan"));
        add(checked_mul(52, hands0 * sizeof(double), "plan"));
        add(checked_mul(52, hands1 * sizeof(double), "plan"));
    }
    return total;
}



void StreetBatchSolver::Engine::allocate_slot_of()
{
    budget_->set_stage("slot_of");
    for (Node& node : nodes)
    {
        if (node.terminal || node.chance || node.n_actions <= 1)
        {
            continue;
        }
        const std::uint64_t count = checked_mul(
            runout_dim(node), static_cast<std::uint64_t>(node.hands), "slot index");
        node.slot_of.assign(static_cast<std::size_t>(count), -1);
    }
}



void StreetBatchSolver::Engine::allocate_slots()
{
    budget_->set_stage("slots");
    slots.reserve(static_cast<std::size_t>(planned_slots_));
    player_slots_[0].clear();
    player_slots_[1].clear();
    if (planned_slots_ > 0)
    {
        // Rough split; exact sizes land during visit_slots commit.
        player_slots_[0].reserve(static_cast<std::size_t>((planned_slots_ + 1) / 2));
        player_slots_[1].reserve(static_cast<std::size_t>(planned_slots_ / 2));
    }
}



int StreetBatchSolver::Engine::card_key(const Node& node, int hand, int turn, int river) const
{
    if (node.card_mode == 0)
    {
        return hand;
    }
    if (node.card_mode == 1)
    {
        const int card = node.mode1_is_turn ? turn : river;
        const int runout = mode1_of_[static_cast<std::size_t>(card)];
        if (runout < 0)
        {
            throw std::logic_error("street slot key used an on-board card");
        }
        return runout * node.hands + hand;
    }
    const int runout = mode2_of_[static_cast<std::size_t>(turn * 52 + river)];
    if (runout < 0)
    {
        throw std::logic_error("street slot key used an illegal runout");
    }
    return runout * node.hands + hand;
}



int StreetBatchSolver::Engine::remaining(const Deal& deal, int turn, int river, int* out) const
{
    bool dead[52] = {};
    for (int card : config.board)
    {
        dead[card] = true;
    }
    dead[deal.c0] = true;
    dead[deal.c1] = true;
    dead[deal.d0] = true;
    dead[deal.d1] = true;
    if (turn >= 0)
    {
        dead[turn] = true;
    }
    if (river >= 0)
    {
        dead[river] = true;
    }
    int count = 0;
    for (int card = 0; card < 52; ++card)
    {
        if (!dead[card])
        {
            out[count++] = card;
        }
    }
    return count;
}



std::string StreetBatchSolver::Engine::place_text(int street, int turn, int river) const
{
    if (config.board.size() == 5)
    {
        return "river";
    }
    if (config.board.size() == 4)
    {
        if (street == 0)
        {
            return "turn";
        }
        return "river " + holdem::format_card(river);
    }
    if (street == 0)
    {
        return "flop";
    }
    if (street == 1)
    {
        return "turn " + holdem::format_card(turn);
    }
    return "turn " + holdem::format_card(turn) + " river " + holdem::format_card(river);
}



void StreetBatchSolver::Engine::add_slot(int node_index, int hand, int turn, int river)
{
    Node& node = nodes[static_cast<std::size_t>(node_index)];
    if (slots.size() >= static_cast<std::size_t>(std::numeric_limits<int>::max()))
    {
        throw std::invalid_argument(
            "street information-set count exceeded the 32-bit stored id limit");
    }
    if (node.n_actions < 0
        || cursor_ > static_cast<std::int64_t>(std::numeric_limits<int>::max()) - node.n_actions)
    {
        throw std::invalid_argument(
            "street regret table exceeded the 32-bit stored id limit");
    }
    if (hand < 0 || hand > static_cast<int>(std::numeric_limits<std::uint16_t>::max()))
    {
        throw std::invalid_argument("street hand index exceeded the packed slot limit");
    }
    const int key = card_key(node, hand, turn, river);
    Slot slot;
    slot.node = node_index;
    slot.base = static_cast<int>(cursor_);
    slot.hand = static_cast<std::uint16_t>(hand);
    slot.turn = static_cast<std::int8_t>(turn);
    slot.river = static_cast<std::int8_t>(river);
    const std::uint32_t slot_index = static_cast<std::uint32_t>(slots.size());
    node.slot_of[static_cast<std::size_t>(key)] = static_cast<int>(slot_index);
    slots.push_back(slot);
    const int player = node.player;
    if (player != 0 && player != 1)
    {
        throw std::logic_error("street slot registered for a non-player node");
    }
    player_slots_[player].push_back(slot_index);
    cursor_ += node.n_actions;
}



void StreetBatchSolver::Engine::note_planned_slot(const Node& node)
{
    if (node.n_actions <= 1)
    {
        ++planned_implicit_;
        return;
    }
    if (node.n_actions < 0
        || planned_cursor_ > static_cast<std::int64_t>(std::numeric_limits<int>::max()) - node.n_actions)
    {
        throw std::invalid_argument(
            "street regret table exceeded the 32-bit stored id limit");
    }
    ++planned_slots_;
    planned_cursor_ += node.n_actions;
}



void StreetBatchSolver::Engine::consider_slot(bool commit, int node_index, int hand, int turn, int river)
{
    const Node& node = nodes[static_cast<std::size_t>(node_index)];
    if (node.n_actions <= 1)
    {
        if (!commit)
        {
            note_planned_slot(node);
        }
        return;
    }
    if (commit)
    {
        add_slot(node_index, hand, turn, river);
        return;
    }
    note_planned_slot(node);
}



// Every legal deal keeps four distinct hole cards off the board, so each
// public node is reached by counted_deals_ times the same runout count.
// extra is 0 on the first street, 1 after the next card, and 2 on the river.
// The product is an expanded-history statistic. It is not a stored node count.
void StreetBatchSolver::Engine::charge_visits(int extra, bool terminal)
{
    std::uint64_t live = 52 - static_cast<std::uint64_t>(config.board.size()) - 4;
    std::uint64_t per_deal = 1;
    for (int i = 0; i < extra; ++i)
    {
        per_deal = checked_mul(per_deal, live, "expanded histories");
        --live;
    }
    const std::uint64_t visits = checked_mul(per_deal, counted_deals_, "expanded histories");
    if (terminal)
    {
        expanded_terminals = checked_add(expanded_terminals, visits, "expanded histories");
        return;
    }
    expanded_decisions = checked_add(expanded_decisions, visits, "expanded histories");
}



void StreetBatchSolver::Engine::visit_slots(bool commit)
{
    bool on_board[52] = {};
    for (int card : config.board)
    {
        on_board[card] = true;
    }
    budget_->set_stage("registration");
    std::pmr::vector<int> card_a[2] = {std::pmr::vector<int>(heap_), std::pmr::vector<int>(heap_)};
    std::pmr::vector<int> card_b[2] = {std::pmr::vector<int>(heap_), std::pmr::vector<int>(heap_)};
    std::pmr::vector<int> hand_at[2] = {std::pmr::vector<int>(heap_), std::pmr::vector<int>(heap_)};
    for (int player = 0; player < 2; ++player)
    {
        const int count = static_cast<int>(combos[player].size());
        card_a[player].resize(static_cast<std::size_t>(count));
        card_b[player].resize(static_cast<std::size_t>(count));
        hand_at[player].assign(static_cast<std::size_t>(holdem::kComboCount), -1);
        for (int hand = 0; hand < count; ++hand)
        {
            const int combo = combos[player][static_cast<std::size_t>(hand)];
            holdem::Range::combo_cards(
                combo, card_a[player][static_cast<std::size_t>(hand)],
                card_b[player][static_cast<std::size_t>(hand)]);
            hand_at[player][static_cast<std::size_t>(combo)] = hand;
        }
    }

    if (!commit)
    {
        planned_slots_ = 0;
        planned_implicit_ = 0;
        planned_cursor_ = 0;
        expanded_decisions = 0;
        expanded_terminals = 0;
        for (const Node& node : nodes)
        {
            if (node.chance)
            {
                continue;
            }
            charge_visits(node.terminal ? node.street : node.card_mode, node.terminal);
        }

        budget_->set_stage("support");
        for (int player = 0; player < 2; ++player)
        {
            const int opp = 1 - player;
            const int count = static_cast<int>(combos[player].size());
            const int opp_count = static_cast<int>(combos[opp].size());
            support[player].assign(static_cast<std::size_t>(count), Support{});
            for (int hand = 0; hand < count; ++hand)
            {
                const int c0 = card_a[player][static_cast<std::size_t>(hand)];
                const int c1 = card_b[player][static_cast<std::size_t>(hand)];
                Support& row = support[player][static_cast<std::size_t>(hand)];
                for (int other = 0; other < opp_count; ++other)
                {
                    const int d0 = card_a[opp][static_cast<std::size_t>(other)];
                    const int d1 = card_b[opp][static_cast<std::size_t>(other)];
                    if (d0 == c0 || d0 == c1 || d1 == c0 || d1 == c1)
                    {
                        continue;
                    }
                    ++row.compatible;
                    ++row.contain[d0];
                    ++row.contain[d1];
                }
            }
        }
    }

    for (int node_index = 0; node_index < static_cast<int>(nodes.size()); ++node_index)
    {
        const Node& node = nodes[static_cast<std::size_t>(node_index)];
        if (node.terminal || node.chance)
        {
            continue;
        }
        const int player = node.player;
        const int opp = 1 - player;
        for (int hand = 0; hand < node.hands; ++hand)
        {
            const Support& row = support[player][static_cast<std::size_t>(hand)];
            const int c0 = card_a[player][static_cast<std::size_t>(hand)];
            const int c1 = card_b[player][static_cast<std::size_t>(hand)];
            if (node.card_mode == 0)
            {
                consider_slot(commit, node_index, hand, -1, -1);
                continue;
            }
            if (node.card_mode == 1)
            {
                for (int card = 0; card < 52; ++card)
                {
                    if (on_board[card] || card == c0 || card == c1)
                    {
                        continue;
                    }
                    if (row.compatible - row.contain[card] <= 0)
                    {
                        continue;
                    }
                    if (node.mode1_is_turn)
                    {
                        consider_slot(commit, node_index, hand, card, -1);
                    }
                    else
                    {
                        consider_slot(commit, node_index, hand, -1, card);
                    }
                }
                continue;
            }
            for (int turn = 0; turn < 52; ++turn)
            {
                if (on_board[turn] || turn == c0 || turn == c1)
                {
                    continue;
                }
                for (int river = 0; river < 52; ++river)
                {
                    if (river == turn || on_board[river] || river == c0 || river == c1)
                    {
                        continue;
                    }
                    int blocked = row.contain[turn] + row.contain[river];
                    const int pair = holdem::Range::combo_index(turn, river);
                    if (hand_at[opp][static_cast<std::size_t>(pair)] >= 0)
                    {
                        --blocked;
                    }
                    if (row.compatible - blocked <= 0)
                    {
                        continue;
                    }
                    consider_slot(commit, node_index, hand, turn, river);
                }
            }
        }
    }
}



std::string StreetBatchSolver::Engine::slot_label(const Slot& slot) const
{
    const Node& node = nodes[static_cast<std::size_t>(slot.node)];
    const int combo = combos[node.player][static_cast<std::size_t>(slot.hand)];
    std::string text = node.player == 0 ? "OOP " : "IP ";
    text += holdem::Range::combo_text(combo);
    text += " | ";
    // Five-card labels match RiverGame / RiverBatchSolver (no place segment).
    if (config.board.size() != 5)
    {
        text += place_text(node.street, static_cast<int>(slot.turn), static_cast<int>(slot.river));
        text += " | ";
    }
    if (node.path.empty())
    {
        text += "open";
    }
    else
    {
        text.append(node.path.data(), node.path.size());
    }
    return text;
}



// Emit probability-1 rows for one-action decisions (no Slot / table storage).
void StreetBatchSolver::Engine::append_implicit_strategy_entries(std::vector<StreetStrategyEntry>& entries) const
{
    if (planned_implicit_ == 0)
    {
        return;
    }
    bool on_board[52] = {};
    for (int card : config.board)
    {
        on_board[card] = true;
    }
    // Outside the engine budget: strategy export is caller-owned.
    std::vector<int> card_a[2];
    std::vector<int> card_b[2];
    std::vector<int> hand_at[2];
    for (int player = 0; player < 2; ++player)
    {
        const int count = static_cast<int>(combos[player].size());
        card_a[player].resize(static_cast<std::size_t>(count));
        card_b[player].resize(static_cast<std::size_t>(count));
        hand_at[player].assign(static_cast<std::size_t>(holdem::kComboCount), -1);
        for (int hand = 0; hand < count; ++hand)
        {
            const int combo = combos[player][static_cast<std::size_t>(hand)];
            holdem::Range::combo_cards(
                combo,
                card_a[player][static_cast<std::size_t>(hand)],
                card_b[player][static_cast<std::size_t>(hand)]);
            hand_at[player][static_cast<std::size_t>(combo)] = hand;
        }
    }
    Slot probe;
    for (int node_index = 0; node_index < static_cast<int>(nodes.size()); ++node_index)
    {
        const Node& node = nodes[static_cast<std::size_t>(node_index)];
        if (node.terminal || node.chance || node.n_actions != 1)
        {
            continue;
        }
        const int player = node.player;
        const int opp = 1 - player;
        for (int hand = 0; hand < node.hands; ++hand)
        {
            const Support& row = support[player][static_cast<std::size_t>(hand)];
            const int c0 = card_a[player][static_cast<std::size_t>(hand)];
            const int c1 = card_b[player][static_cast<std::size_t>(hand)];
            const auto emit = [&](int turn, int river)
            {
                probe.node = node_index;
                probe.hand = static_cast<std::uint16_t>(hand);
                probe.turn = static_cast<std::int8_t>(turn);
                probe.river = static_cast<std::int8_t>(river);
                StreetStrategyEntry entry;
                entry.infoset = slot_label(probe);
                entry.action.assign(
                    node.action_labels[0].data(), node.action_labels[0].size());
                entry.probability = 1.0;
                entries.push_back(std::move(entry));
            };
            if (node.card_mode == 0)
            {
                emit(-1, -1);
                continue;
            }
            if (node.card_mode == 1)
            {
                for (int card = 0; card < 52; ++card)
                {
                    if (on_board[card] || card == c0 || card == c1)
                    {
                        continue;
                    }
                    if (row.compatible - row.contain[card] <= 0)
                    {
                        continue;
                    }
                    if (node.mode1_is_turn)
                    {
                        emit(card, -1);
                    }
                    else
                    {
                        emit(-1, card);
                    }
                }
                continue;
            }
            for (int turn = 0; turn < 52; ++turn)
            {
                if (on_board[turn] || turn == c0 || turn == c1)
                {
                    continue;
                }
                for (int river = 0; river < 52; ++river)
                {
                    if (river == turn || on_board[river] || river == c0 || river == c1)
                    {
                        continue;
                    }
                    int blocked = row.contain[turn] + row.contain[river];
                    const int pair = holdem::Range::combo_index(turn, river);
                    if (hand_at[opp][static_cast<std::size_t>(pair)] >= 0)
                    {
                        --blocked;
                    }
                    if (row.compatible - blocked <= 0)
                    {
                        continue;
                    }
                    emit(turn, river);
                }
            }
        }
    }
}



int StreetBatchSolver::Engine::slot_index(const Node& node, int hand, int turn, int river, double reach) const
{
    const int key = card_key(node, hand, turn, river);
    const int index = node.slot_of[static_cast<std::size_t>(key)];
    if (index >= 0)
    {
        return index;
    }
    const int combo = combos[node.player][static_cast<std::size_t>(hand)];
    const int node_index = static_cast<int>(&node - nodes.data());
    throw std::logic_error(
        "street public tree missed an information set"
        " node " + std::to_string(node_index)
        + " path " + (node.path.empty()
            ? std::string("open")
            : std::string(node.path.data(), node.path.size()))
        + " place " + place_text(node.street, turn, river)
        + " player " + std::to_string(node.player)
        + " hand " + holdem::Range::combo_text(combo)
        + " supported " + std::string(hand_supported(node.player, hand, turn, river) ? "1" : "0")
        + " compatible " + std::to_string(compatible_on(node.player, hand, turn, river))
        + " reach " + std::to_string(reach));
}



StreetMemoryReport StreetBatchSolver::Engine::memory_report() const
{
    StreetMemoryReport report;
    report.memory_budget_bytes = budget_->limit();
    report.allocated_bytes = budget_->current();
    report.peak_allocated_bytes = budget_->peak();
    report.reserved_bytes = budget_->reserved();
    report.regret_strategy_sum_bytes = regret.size() * sizeof(TableScalar)
        + strategy_sum.size() * sizeof(TableScalar);
    report.sigma_workspace_bytes = sigma.size() * sizeof(TableScalar);
    report.table_scalar_bytes = static_cast<int>(sizeof(TableScalar));
    report.estimated_peak_bytes = estimated_peak_bytes_;
    report.expanded_terminals = expanded_terminals;
    report.expanded_decisions = expanded_decisions;
    report.process_peak_working_set_bytes = process_peak_working_set_bytes();
    report.construction_seconds = construction_seconds_;
    report.cache_init_seconds = cache_init_seconds_;
    report.worker_setup_seconds = worker_setup_seconds_;
    report.train_seconds = train_seconds_;
    report.evaluation_seconds = evaluation_seconds_;
    report.thread_count = config.threads;
    report.plan_only = plan_only_;
    for (const BudgetResource::Component& item : budget_->components())
    {
        if (item.bytes == 0)
        {
            continue;
        }
        StreetMemoryComponent component;
        component.name = item.name;
        component.bytes = item.bytes;
        report.components.push_back(std::move(component));
    }
    return report;
}



std::vector<StreetPublicNode> StreetBatchSolver::Engine::public_tree() const
{
    std::vector<StreetPublicNode> out;
    out.reserve(nodes.size());
    for (int index = 0; index < static_cast<int>(nodes.size()); ++index)
    {
        const Node& node = nodes[static_cast<std::size_t>(index)];
        StreetPublicNode item;
        item.index = index;
        item.terminal = node.terminal;
        item.chance = node.chance;
        item.player = node.player;
        item.street = node.street;
        item.path.assign(node.path.data(), node.path.size());
        if (node.chance)
        {
            item.chance_child = node.child[0];
        }
        else if (!node.terminal)
        {
            item.actions.reserve(static_cast<std::size_t>(node.n_actions));
            item.children.reserve(static_cast<std::size_t>(node.n_actions));
            for (int action = 0; action < node.n_actions; ++action)
            {
                StreetPublicAction step;
                step.label.assign(
                    node.action_labels[action].data(), node.action_labels[action].size());
                step.compact = compact_from_display_label(step.label);
                if (step.compact.empty())
                {
                    step.compact = step.label;
                }
                step.child_index = node.child[action];
                item.children.push_back(node.child[action]);
                item.actions.push_back(std::move(step));
            }
        }
        out.push_back(std::move(item));
    }
    return out;
}



std::string StreetBatchSolver::Engine::root_node_id() const
{
    if (nodes.empty())
    {
        throw std::logic_error("street tree is empty");
    }
    return "p0.t-1.r-1";
}



// Leading zeros and other accepted spellings name the same public node.
std::string StreetBatchSolver::Engine::canonical_node_id(const std::string& text) const
{
    int node = 0;
    int turn = -1;
    int river = -1;
    locate_node(text, node, turn, river);
    return node_id(node, turn, river);
}



bool StreetBatchSolver::Engine::parse_node_id(const std::string& text, int& node, int& turn, int& river) const
{
    auto read_number = [&](std::size_t& cursor, int& value) -> bool
    {
        if (cursor >= text.size() || text[cursor] == '+')
        {
            return false;
        }
        long long parsed = 0;
        const char* first = text.data() + cursor;
        const char* last = text.data() + text.size();
        const std::from_chars_result result = std::from_chars(first, last, parsed);
        if (result.ec != std::errc() || result.ptr == first)
        {
            return false;
        }
        if (parsed < std::numeric_limits<int>::min() || parsed > std::numeric_limits<int>::max())
        {
            return false;
        }
        cursor = static_cast<std::size_t>(result.ptr - text.data());
        value = static_cast<int>(parsed);
        return true;
    };
    std::size_t cursor = 0;
    if (text.empty() || text[cursor] != 'p')
    {
        return false;
    }
    ++cursor;
    if (!read_number(cursor, node) || cursor >= text.size() || text[cursor] != '.')
    {
        return false;
    }
    ++cursor;
    if (cursor >= text.size() || text[cursor] != 't')
    {
        return false;
    }
    ++cursor;
    if (!read_number(cursor, turn) || cursor >= text.size() || text[cursor] != '.')
    {
        return false;
    }
    ++cursor;
    if (cursor >= text.size() || text[cursor] != 'r')
    {
        return false;
    }
    ++cursor;
    return read_number(cursor, river) && cursor == text.size();
}



std::string StreetBatchSolver::Engine::node_id(int node, int turn, int river) const
{
    return "p" + std::to_string(node) + ".t" + std::to_string(turn) + ".r" + std::to_string(river);
}



bool StreetBatchSolver::Engine::card_on_board(int card) const
{
    for (int dealt : config.board)
    {
        if (dealt == card)
        {
            return true;
        }
    }
    return false;
}



void StreetBatchSolver::Engine::locate_node(const std::string& text, int& node, int& turn, int& river) const
{
    if (!parse_node_id(text, node, turn, river)
        || node < 0
        || static_cast<std::size_t>(node) >= nodes.size())
    {
        throw std::invalid_argument("unknown node");
    }
    const Node& found = nodes[static_cast<std::size_t>(node)];
    bool want_turn = false;
    bool want_river = false;
    if (config.board.size() == 5)
    {
        // Fixed board: node ids never carry a turn or river card.
    }
    else if (found.chance)
    {
        if (found.deal_which == 1)
        {
            want_turn = false;
            want_river = false;
        }
        else if (config.board.size() == 3)
        {
            want_turn = true;
            want_river = false;
        }
    }
    else if (found.terminal)
    {
        if (config.board.size() == 3)
        {
            want_turn = found.street >= 1;
            want_river = found.street >= 2;
        }
        else
        {
            want_river = found.street >= 1;
        }
    }
    else if (config.board.size() == 4)
    {
        want_river = found.card_mode == 1;
    }
    else if (found.card_mode == 1)
    {
        want_turn = true;
    }
    else if (found.card_mode == 2)
    {
        want_turn = true;
        want_river = true;
    }
    if (want_turn && want_river && turn == river)
    {
        throw std::invalid_argument("node card is duplicated");
    }
    auto require_card = [&](int card, bool wanted)
    {
        if (!wanted)
        {
            if (card != -1)
            {
                throw std::invalid_argument("node does not use that card");
            }
            return;
        }
        if (card < 0 || card >= 52 || card_on_board(card))
        {
            throw std::invalid_argument("node card is dead or out of range");
        }
    };
    require_card(turn, want_turn);
    require_card(river, want_river);
}



void StreetBatchSolver::Engine::index_parents()
{
    budget_->set_stage("parents");
    parent_link.assign(nodes.size(), ParentLink{});
    for (int index = 0; index < static_cast<int>(nodes.size()); ++index)
    {
        const Node& node = nodes[static_cast<std::size_t>(index)];
        const auto claim = [&](int child, int action, bool from_chance)
        {
            if (child < 0)
            {
                return;
            }
            ParentLink& link = parent_link[static_cast<std::size_t>(child)];
            if (link.parent >= 0)
            {
                throw std::logic_error("public node has two parents");
            }
            link.parent = index;
            link.action = action;
            link.from_chance = from_chance;
        };
        if (node.chance)
        {
            claim(node.child[0], -1, true);
        }
        else if (!node.terminal)
        {
            for (int action = 0; action < node.n_actions; ++action)
            {
                claim(node.child[action], action, false);
            }
        }
    }
}



void StreetBatchSolver::Engine::fill_terminal_incentives()
{
    if (!config.incentives.enabled())
    {
        return;
    }
    config.incentives.validate();
    std::vector<IncentiveEdge> rev;
    std::vector<IncentiveEdge> path;
    for (int index = 0; index < static_cast<int>(nodes.size()); ++index)
    {
        Node& node = nodes[static_cast<std::size_t>(index)];
        if (!node.terminal)
        {
            continue;
        }
        rev.clear();
        for (int at = index; at >= 0;)
        {
            const ParentLink& link = parent_link[static_cast<std::size_t>(at)];
            if (link.parent < 0)
            {
                break;
            }
            if (!link.from_chance && link.action >= 0)
            {
                const Node& parent = nodes[static_cast<std::size_t>(link.parent)];
                const std::string_view display(parent.action_labels[link.action]);
                IncentiveEdge edge;
                edge.player = parent.player;
                edge.display_label.assign(display.data(), display.size());
                edge.compact_label = incentive_compact_from_display(display);
                if (edge.compact_label.empty())
                {
                    edge.compact_label = edge.display_label;
                }
                attach_edge_tags(edge, config.incentives);
                rev.push_back(std::move(edge));
            }
            at = link.parent;
        }
        path.assign(rev.rbegin(), rev.rend());
        PlayerPayoff zero;
        zero.utility[0] = 0.0;
        zero.utility[1] = 0.0;
        const PlayerPayoff path_delta =
            apply_path_incentives(config.incentives, zero, path);
        node.incentive_u0 = path_delta.utility[0];
        node.incentive_u1 = path_delta.utility[1];
    }
}



// Replay public betting along the parent chain with the same legal/edits
// path used while building the tree. State at the target node is before that
// node's action (or chance deal).
BetState StreetBatchSolver::Engine::betting_state_along(const std::vector<int>& chain) const
{
    BetState state;
    state.pot = config.pot;
    state.acting = config.first_to_act;
    state.street = 0;
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
        if (node.chance || edge.from_chance)
        {
            state.chance = false;
            state.deal_which = 0;
            state.acting = config.first_to_act;
            state.pending_check = false;
            state.last_raise = 0;
            state.num_raises = 0;
            state.committed = state.contrib[0];
            continue;
        }
        Legal legal = legal_actions(config, state);
        apply_tree_edits(legal, config, state, std::string_view(node.path.data(), node.path.size()), heap_);
        if (edge.action < 0 || edge.action >= legal.count)
        {
            throw std::logic_error("parent action out of legal set");
        }
        state = apply_action(config, state, legal, edge.action);
    }
    return state;
}


} // namespace poker::solver
