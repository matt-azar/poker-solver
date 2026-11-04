#include "postflop/engine.hpp"

namespace poker::solver
{

StreetBatchSolver::StreetBatchSolver(
    streets::StreetConfig config,
    std::pmr::memory_resource* upstream)
    : upstream_(upstream != nullptr ? upstream : std::pmr::new_delete_resource())
    , budget_(upstream_, budget_bytes(config.memory_mib))
{
    budget_.set_stage("engine");
    engine_storage_ = budget_.allocate(sizeof(Engine), alignof(Engine));
    try
    {
        engine_ = ::new (engine_storage_) Engine(std::move(config), budget_, false);
    }
    catch (...)
    {
        budget_.deallocate(engine_storage_, sizeof(Engine), alignof(Engine));
        engine_storage_ = nullptr;
        throw;
    }
}

StreetBatchSolver::StreetBatchSolver(
    streets::StreetConfig config,
    PlanOnlyTag,
    std::pmr::memory_resource* upstream)
    : upstream_(upstream != nullptr ? upstream : std::pmr::new_delete_resource())
    , budget_(upstream_, budget_bytes(config.memory_mib))
{
    budget_.set_stage("engine");
    engine_storage_ = budget_.allocate(sizeof(Engine), alignof(Engine));
    try
    {
        engine_ = ::new (engine_storage_) Engine(std::move(config), budget_, true);
    }
    catch (...)
    {
        budget_.deallocate(engine_storage_, sizeof(Engine), alignof(Engine));
        engine_storage_ = nullptr;
        throw;
    }
}

StreetBatchSolver::~StreetBatchSolver()
{
    if (engine_ != nullptr)
    {
        engine_->~Engine();
        engine_ = nullptr;
    }
    if (engine_storage_ != nullptr)
    {
        budget_.deallocate(engine_storage_, sizeof(Engine), alignof(Engine));
        engine_storage_ = nullptr;
    }
}

void StreetBatchSolver::note_profile_mutation()
{
    std::lock_guard<std::mutex> lock(value_mu_);
    ++profile_epoch_;
    value_cache_valid_ = false;
}

void StreetBatchSolver::run_iterations(int count, Algorithm algorithm, const LockSet* locks)
{
    note_profile_mutation();
    engine_->check_usable();
    const LockSet* const previous_locks = engine_->locks_;
    engine_->locks_ = locks;
    try
    {
        engine_->reset();
        engine_->train_more(count, algorithm);
    }
    catch (...)
    {
        engine_->locks_ = previous_locks;
        throw;
    }
    engine_->locks_ = previous_locks;
}

void StreetBatchSolver::continue_iterations(int count, Algorithm algorithm, const LockSet* locks)
{
    note_profile_mutation();
    const LockSet* const previous_locks = engine_->locks_;
    engine_->locks_ = locks;
    try
    {
        engine_->train_more(count, algorithm);
    }
    catch (...)
    {
        engine_->locks_ = previous_locks;
        throw;
    }
    engine_->locks_ = previous_locks;
}

void StreetBatchSolver::run_frozen_iterations(int count, Algorithm algorithm, const LockSet* locks)
{
    note_profile_mutation();
    engine_->check_usable();
    const LockSet* const previous_locks = engine_->locks_;
    engine_->locks_ = locks;
    try
    {
        engine_->reset();
        engine_->train_frozen(count, algorithm);
    }
    catch (...)
    {
        engine_->locks_ = previous_locks;
        throw;
    }
    engine_->locks_ = previous_locks;
}

void StreetBatchSolver::continue_frozen_iterations(int count, Algorithm algorithm, const LockSet* locks)
{
    note_profile_mutation();
    const LockSet* const previous_locks = engine_->locks_;
    engine_->locks_ = locks;
    try
    {
        engine_->train_frozen(count, algorithm);
    }
    catch (...)
    {
        engine_->locks_ = previous_locks;
        throw;
    }
    engine_->locks_ = previous_locks;
}

void StreetBatchSolver::initialize_rank_cache()
{
    engine_->check_usable();
    engine_->ensure_ranks();
}

SolveStats StreetBatchSolver::solve_frozen(
    const SolveConfig& config,
    Algorithm algorithm,
    SolveProgress progress,
    void* progress_context)
{
    note_profile_mutation();
    engine_->check_usable();
    const LockSet* const previous_locks = engine_->locks_;
    engine_->locks_ = config.locks;
    if (algorithm == Algorithm::Dcfr)
    {
        engine_->dcfr_params_ = config.dcfr;
    }
    const auto start = std::chrono::steady_clock::now();
    engine_->reset();
    int completed = 0;
    SolveStats stats;
    stats.nash_gap_history.clear();
    stats.nash_gap_iterations.clear();
    bool fresh = false;
    for (int step = 0; step < config.max_iterations; ++step)
    {
        engine_->train_frozen(1, algorithm);
        ++completed;
        fresh = false;
        const bool check_gap = config.nash_gap_threshold >= 0.0
            && config.eval_every > 0
            && completed % config.eval_every == 0;
        if (check_gap)
        {
            apply_evaluation(stats, evaluate());
            stats.nash_gap_history.push_back(stats.nash_gap);
            stats.nash_gap_iterations.push_back(completed);
            fresh = true;
            if (progress != nullptr)
            {
                progress(completed, stats, progress_context);
            }
            if (stats.nash_gap <= config.nash_gap_threshold)
            {
                break;
            }
        }
        if (config.max_wall_seconds >= 0.0)
        {
            const double elapsed = std::chrono::duration<double>(
                std::chrono::steady_clock::now() - start).count();
            if (elapsed >= config.max_wall_seconds)
            {
                stats.time_limit_reached = true;
                break;
            }
        }
    }
    if (!fresh)
    {
        apply_evaluation(stats, evaluate());
        if (config.nash_gap_threshold >= 0.0)
        {
            stats.nash_gap_history.push_back(stats.nash_gap);
            stats.nash_gap_iterations.push_back(completed);
        }
    }
    const auto end = std::chrono::steady_clock::now();
    stats.iterations = completed;
    stats.runtime_seconds = std::chrono::duration<double>(end - start).count();
    stats.memory_bytes_estimate = memory_bytes_estimate();
    engine_->locks_ = previous_locks;
    return stats;
}

SolveStats StreetBatchSolver::solve(
    const SolveConfig& config,
    Algorithm algorithm,
    SolveProgress progress,
    void* progress_context)
{
    note_profile_mutation();
    engine_->check_usable();
    const LockSet* const previous_locks = engine_->locks_;
    engine_->locks_ = config.locks;
    const auto start = std::chrono::steady_clock::now();
    engine_->reset();
    int completed = 0;
    SolveStats stats;
    stats.nash_gap_history.clear();
    stats.nash_gap_iterations.clear();
    bool fresh = false;
    for (int step = 0; step < config.max_iterations; ++step)
    {
        engine_->train_more(1, algorithm);
        ++completed;
        fresh = false;
        const bool check_gap = config.nash_gap_threshold >= 0.0
            && config.eval_every > 0
            && completed % config.eval_every == 0;
        if (check_gap)
        {
            apply_evaluation(stats, evaluate());
            stats.nash_gap_history.push_back(stats.nash_gap);
            stats.nash_gap_iterations.push_back(completed);
            fresh = true;
            if (progress != nullptr)
            {
                progress(completed, stats, progress_context);
            }
            if (stats.nash_gap <= config.nash_gap_threshold)
            {
                break;
            }
        }
        if (config.max_wall_seconds >= 0.0)
        {
            const double elapsed = std::chrono::duration<double>(
                std::chrono::steady_clock::now() - start).count();
            if (elapsed >= config.max_wall_seconds)
            {
                stats.time_limit_reached = true;
                break;
            }
        }
    }
    if (!fresh)
    {
        apply_evaluation(stats, evaluate());
        if (config.nash_gap_threshold >= 0.0)
        {
            stats.nash_gap_history.push_back(stats.nash_gap);
            stats.nash_gap_iterations.push_back(completed);
        }
    }
    const auto end = std::chrono::steady_clock::now();
    stats.iterations = completed;
    stats.runtime_seconds = std::chrono::duration<double>(end - start).count();
    stats.memory_bytes_estimate = memory_bytes_estimate();
    engine_->locks_ = previous_locks;
    return stats;
}

double StreetBatchSolver::expected_utility() const
{
    return engine_->utility_of_response(-1);
}

double StreetBatchSolver::p1_best_response_utility() const
{
    return engine_->utility_of_response(0);
}

double StreetBatchSolver::p2_best_response_utility() const
{
    // Modeled player-1 utility when player 1 best-responds (dual-utility).
    return engine_->utility_of_response(1);
}

EvaluationResult StreetBatchSolver::evaluate() const
{
    return engine_->evaluate_profile();
}

double StreetBatchSolver::nash_gap() const
{
    return evaluate().nash_gap;
}

std::uint64_t StreetBatchSolver::infoset_count() const
{
    // Stored multi-action slots plus implicit one-action infosets.
    if (!engine_->plan_only_)
    {
        return static_cast<std::uint64_t>(engine_->slots.size()) + engine_->planned_implicit_;
    }
    return engine_->planned_slots_ + engine_->planned_implicit_;
}

std::uint64_t StreetBatchSolver::deal_count() const
{
    if (!engine_->deals.empty())
    {
        return static_cast<std::uint64_t>(engine_->deals.size());
    }
    return engine_->counted_deals_;
}

bool StreetBatchSolver::plan_only() const
{
    return engine_->plan_only_;
}

int StreetBatchSolver::public_decisions() const
{
    return engine_->public_decisions;
}

int StreetBatchSolver::public_terminals() const
{
    return engine_->public_terminals;
}

std::uint64_t StreetBatchSolver::decision_node_count() const
{
    return engine_->expanded_decisions;
}

std::uint64_t StreetBatchSolver::terminal_count() const
{
    return engine_->expanded_terminals;
}

int StreetBatchSolver::regret_entries() const
{
    return static_cast<int>(engine_->regret.size());
}

std::size_t StreetBatchSolver::memory_bytes_estimate() const
{
    return engine_->regret.size() * sizeof(TableScalar)
        + engine_->strategy_sum.size() * sizeof(TableScalar);
}

StreetMemoryReport StreetBatchSolver::memory_report() const
{
    return engine_->memory_report();
}

std::vector<StreetPublicNode> StreetBatchSolver::public_tree() const
{
    return engine_->public_tree();
}

bool StreetBatchSolver::set_regret(const std::string& infoset, const std::string& action, double value)
{
    return engine_->assign_labeled_regret(infoset, action, value);
}

bool StreetBatchSolver::regret_value(const std::string& infoset, const std::string& action, double& value) const
{
    return engine_->read_labeled_regret(infoset, action, value);
}

std::span<const TableScalar> StreetBatchSolver::regret_table() const
{
    return std::span<const TableScalar>(engine_->regret.data(), engine_->regret.size());
}

std::span<const TableScalar> StreetBatchSolver::strategy_sum_table() const
{
    return std::span<const TableScalar>(engine_->strategy_sum.data(), engine_->strategy_sum.size());
}

int StreetBatchSolver::thread_count() const
{
    return engine_->config.threads;
}

void StreetBatchSolver::enable_walk_profile(bool enabled)
{
    engine_->check_usable();
    engine_->profile_ = enabled;
    engine_->freeze_seconds_ = 0.0;
    const auto clear = [](Engine::WorkerContext& ctx)
    {
        ctx.order_seconds = 0.0;
        ctx.showdown_seconds = 0.0;
        ctx.decision_seconds = 0.0;
        ctx.chance_seconds = 0.0;
        ctx.fold_seconds = 0.0;
        ctx.collect_seconds = 0.0;
        ctx.expand_seconds = 0.0;
        ctx.support_seconds = 0.0;
    };
    clear(engine_->workspace);
    for (int index = 0; index < engine_->extra_count_; ++index)
    {
        clear(*engine_->extra_contexts_[index]);
    }
}

StreetWalkProfile StreetBatchSolver::walk_profile() const
{
    StreetWalkProfile profile;
    const auto add = [&](const Engine::WorkerContext& ctx)
    {
        profile.order_seconds += ctx.order_seconds;
        profile.showdown_seconds += ctx.showdown_seconds;
        profile.decision_seconds += ctx.decision_seconds;
        profile.chance_seconds += ctx.chance_seconds;
        profile.fold_seconds += ctx.fold_seconds;
        profile.collect_seconds += ctx.collect_seconds;
        profile.expand_seconds += ctx.expand_seconds;
        profile.support_seconds += ctx.support_seconds;
    };
    add(engine_->workspace);
    for (int index = 0; index < engine_->extra_count_; ++index)
    {
        add(*engine_->extra_contexts_[index]);
    }
    profile.freeze_seconds = engine_->freeze_seconds_;
    return profile;
}

int StreetBatchSolver::indexed_hands_for_test(int player) const
{
    return player == 0 ? engine_->n0 : engine_->n1;
}

ShowdownSample StreetBatchSolver::sample_showdown_for_test(
    int hero,
    int turn,
    int river,
    std::span<const double> opponent_amount) const
{
    engine_->ensure_ranks();
    const int opponent = 1 - hero;
    const Engine::RunoutRanks& table = engine_->runout_for(turn, river);
    const int hero_hands = hero == 0 ? engine_->n0 : engine_->n1;
    const int opp_hands = opponent == 0 ? engine_->n0 : engine_->n1;
    if (static_cast<int>(opponent_amount.size()) != opp_hands)
    {
        throw std::invalid_argument("showdown sample amount length");
    }
    engine_->order_reach(engine_->workspace, opponent, opponent_amount, table);
    ShowdownSample sample;
    sample.hero_card0.resize(static_cast<std::size_t>(hero_hands));
    sample.hero_card1.resize(static_cast<std::size_t>(hero_hands));
    sample.opponent_card0.resize(static_cast<std::size_t>(opp_hands));
    sample.opponent_card1.resize(static_cast<std::size_t>(opp_hands));
    sample.hero_rank.assign(table.rank[hero].begin(), table.rank[hero].end());
    sample.opponent_rank.assign(table.rank[opponent].begin(), table.rank[opponent].end());
    sample.order.assign(table.order[opponent].begin(), table.order[opponent].end());
    sample.position.assign(table.pos[opponent].begin(), table.pos[opponent].end());
    sample.worse_end.assign(table.worse_end[hero].begin(), table.worse_end[hero].end());
    sample.better_begin.assign(table.better_begin[hero].begin(), table.better_begin[hero].end());
    sample.card_offset.assign(table.card_off[opponent].begin(), table.card_off[opponent].end());
    sample.card_order.assign(table.card_pos[opponent].begin(), table.card_pos[opponent].end());
    sample.card_cut.assign(table.card_cut[hero].begin(), table.card_cut[hero].end());
    sample.worse_mass.assign(static_cast<std::size_t>(hero_hands), 0.0);
    sample.better_mass.assign(static_cast<std::size_t>(hero_hands), 0.0);
    for (int hand = 0; hand < hero_hands; ++hand)
    {
        sample.hero_card0[static_cast<std::size_t>(hand)] =
            engine_->hole_a[hero][static_cast<std::size_t>(hand)];
        sample.hero_card1[static_cast<std::size_t>(hand)] =
            engine_->hole_b[hero][static_cast<std::size_t>(hand)];
    }
    for (int hand = 0; hand < opp_hands; ++hand)
    {
        sample.opponent_card0[static_cast<std::size_t>(hand)] =
            engine_->hole_a[opponent][static_cast<std::size_t>(hand)];
        sample.opponent_card1[static_cast<std::size_t>(hand)] =
            engine_->hole_b[opponent][static_cast<std::size_t>(hand)];
    }
    for (int hand = 0; hand < hero_hands; ++hand)
    {
        if (!engine_->hand_live(hero, hand, turn, river))
        {
            continue;
        }
        const int c0 = sample.hero_card0[static_cast<std::size_t>(hand)];
        const int c1 = sample.hero_card1[static_cast<std::size_t>(hand)];
        const int opp_hand = engine_->hand_of[opponent][static_cast<std::size_t>(
            poker::holdem::Range::combo_index(c0, c1))];
        const int add_hand = opp_hand >= 0 && opponent_amount[static_cast<std::size_t>(opp_hand)] != 0.0
            ? opp_hand : -1;
        const std::size_t cut_at = static_cast<std::size_t>(hand) * 4;
        const int len0 = sample.card_offset[static_cast<std::size_t>(c0 + 1)]
            - sample.card_offset[static_cast<std::size_t>(c0)];
        const int len1 = sample.card_offset[static_cast<std::size_t>(c1 + 1)]
            - sample.card_offset[static_cast<std::size_t>(c1)];
        sample.worse_mass[static_cast<std::size_t>(hand)] = engine_->slice_reach(
            engine_->workspace, table, opponent, 0, sample.worse_end[static_cast<std::size_t>(hand)],
            c0, c1, 0, 0, sample.card_cut[cut_at], sample.card_cut[cut_at + 1],
            add_hand, opponent_amount, table.pos[opponent]);
        sample.better_mass[static_cast<std::size_t>(hand)] = engine_->slice_reach(
            engine_->workspace, table, opponent, sample.better_begin[static_cast<std::size_t>(hand)], opp_hands,
            c0, c1, sample.card_cut[cut_at + 2], sample.card_cut[cut_at + 3], len0, len1,
            add_hand, opponent_amount, table.pos[opponent]);
    }
    return sample;
}

void StreetBatchSolver::run_single_frozen_pass_for_test(int updating)
{
    note_profile_mutation();
    engine_->check_usable();
    engine_->average_ready = false;
    engine_->ensure_ranks();
    engine_->frozen_pass(updating, 1.0, Algorithm::CfrPlus);
}

void StreetBatchSolver::arm_worker_failure_for_test()
{
    engine_->fail_tickets_.store(1);
}

void StreetBatchSolver::arm_card_delay_for_test(int microseconds)
{
    engine_->delay_us_.store(microseconds);
}

void StreetBatchSolver::prepare_inspection() const
{
    engine_->ensure_average();
}

std::string StreetBatchSolver::root_node_id() const
{
    return engine_->root_node_id();
}

StreetInspection StreetBatchSolver::inspect_node(const std::string& node_id) const
{
    return engine_->inspect_node(node_id);
}

StreetActionValues StreetBatchSolver::action_values(
    const std::string& node_id,
    const std::atomic<bool>* cancel) const
{
    std::lock_guard<std::mutex> lock(value_mu_);
    engine_->ensure_average();
    const std::string canonical = engine_->canonical_node_id(node_id);
    if (value_cache_valid_ && value_cache_node_ == canonical && value_cache_epoch_ == profile_epoch_)
    {
        StreetActionValues cached = value_cache_;
        cached.node_id = node_id;
        cached.query_seconds = 0.0;
        return cached;
    }
    StreetActionValues page = engine_->compute_action_values(node_id, cancel);
    page.profile_epoch = profile_epoch_;
    page.node_id = node_id;
    if (fail_cache_commit_)
    {
        fail_cache_commit_ = false;
        value_cache_valid_ = false;
        throw std::bad_alloc();
    }
    // Stage the replacement first. A throw while copying it leaves the previous
    // page unpublished, and the flag stays false until the key and page are both stored.
    StreetActionValues staged = page;
    std::string staged_node = canonical;
    const std::uint64_t staged_epoch = profile_epoch_;
    value_cache_valid_ = false;
    value_cache_node_ = std::move(staged_node);
    value_cache_epoch_ = staged_epoch;
    value_cache_ = std::move(staged);
    value_cache_valid_ = true;
    return page;
}

StreetRunoutValues StreetBatchSolver::runout_values(
    const std::string& node_id,
    const std::atomic<bool>* cancel) const
{
    std::lock_guard<std::mutex> lock(value_mu_);
    StreetRunoutValues page = engine_->compute_runout_values(node_id, cancel);
    page.profile_epoch = profile_epoch_;
    page.node_id = node_id;
    return page;
}

StreetReachWeights StreetBatchSolver::reaching_weights(const std::string& node_id) const
{
    std::lock_guard<std::mutex> lock(value_mu_);
    return engine_->compute_reaching_weights(node_id);
}

holdem::CategoryComposition StreetBatchSolver::category_composition(
    const std::string& node_id) const
{
    const StreetReachWeights weights = reaching_weights(node_id);
    if (weights.board.size() != 5)
    {
        holdem::CategoryComposition report;
        report.board = weights.board;
        report.available = false;
        report.reason = "made-hand categories require a five-card board";
        return report;
    }
    if (weights.oop.empty() && weights.ip.empty())
    {
        holdem::CategoryComposition report;
        report.board = weights.board;
        report.available = true;
        return report;
    }
    const holdem::Range oop = weights.oop.empty()
        ? holdem::Range{}
        : holdem::Range::parse(weights.oop);
    const holdem::Range ip = weights.ip.empty()
        ? holdem::Range{}
        : holdem::Range::parse(weights.ip);
    return holdem::category_composition(weights.board, oop, ip);
}

const streets::StreetConfig& StreetBatchSolver::config() const
{
    return engine_->config;
}

TrainingTables StreetBatchSolver::training_tables() const
{
    return engine_->export_tables();
}

void StreetBatchSolver::export_training_identity(TrainingTables& out) const
{
    engine_->export_table_identity(out);
}

void StreetBatchSolver::export_training_tables(TrainingTables& out) const
{
    engine_->export_tables_into(out);
}

void StreetBatchSolver::install_training_tables(const TrainingTables& tables)
{
    note_profile_mutation();
    engine_->install_tables(tables);
    // Tables alone do not carry the algorithm. Callers that reopen a solution
    // must bind_training_algorithm from the checkpoint/job tag before continue.
    engine_->algorithm_bound_ = false;
}

void StreetBatchSolver::copy_training_state_from(const StreetBatchSolver& other)
{
    note_profile_mutation();
    engine_->copy_training_state_from(*other.engine_);
}

void StreetBatchSolver::set_dcfr_params(DcfrParams params)
{
    engine_->dcfr_params_ = params;
}

DcfrParams StreetBatchSolver::dcfr_params() const
{
    return engine_->dcfr_params_;
}

std::span<const TableScalar> StreetBatchSolver::prediction_table() const
{
    return engine_->prediction_;
}

void StreetBatchSolver::install_prediction_table(std::span<const double> values)
{
    note_profile_mutation();
    engine_->install_prediction(values);
}

void StreetBatchSolver::bind_training_algorithm(Algorithm algorithm)
{
    engine_->bind_algorithm_for_tables(algorithm);
}

Algorithm StreetBatchSolver::training_algorithm() const
{
    if (!engine_->algorithm_bound_)
    {
        throw std::logic_error("training algorithm is not bound");
    }
    return engine_->bound_algorithm_;
}

bool StreetBatchSolver::has_training_algorithm() const
{
    return engine_->algorithm_bound_;
}

std::uint64_t StreetBatchSolver::profile_epoch() const
{
    std::lock_guard<std::mutex> lock(value_mu_);
    return profile_epoch_;
}

void StreetBatchSolver::arm_value_cache_failure_for_test()
{
    std::lock_guard<std::mutex> lock(value_mu_);
    fail_cache_commit_ = true;
}

int StreetBatchSolver::completed_iterations() const
{
    return engine_->trained;
}

void StreetBatchSolver::set_average_strategy(
    const std::string& node_id,
    int hand,
    std::span<const double> probability)
{
    std::lock_guard<std::mutex> lock(value_mu_);
    ++profile_epoch_;
    value_cache_valid_ = false;
    engine_->set_average_strategy(node_id, hand, probability);
}

void StreetBatchSolver::invalidate_prepared_average()
{
    std::lock_guard<std::mutex> lock(value_mu_);
    ++profile_epoch_;
    value_cache_valid_ = false;
    engine_->invalidate_prepared_average();
}

void StreetBatchSolver::set_average_for_test(
    const std::string& node_id,
    int hand,
    std::span<const double> probability)
{
    set_average_strategy(node_id, hand, probability);
}

std::vector<StreetStrategyEntry> StreetBatchSolver::average_strategy_entries() const
{
    engine_->ensure_average();
    std::vector<StreetStrategyEntry> entries;
    entries.reserve(
        engine_->slots.size() * 2
        + static_cast<std::size_t>(engine_->planned_implicit_));
    for (const Engine::Slot& slot : engine_->slots)
    {
        const Engine::Node& node = engine_->nodes[static_cast<std::size_t>(slot.node)];
        const int actions = engine_->slot_action_count(slot);
        for (int action = 0; action < actions; ++action)
        {
            StreetStrategyEntry entry;
            entry.infoset = engine_->slot_label(slot);
            entry.action.assign(node.action_labels[action].data(), node.action_labels[action].size());
            entry.probability = engine_->sigma[static_cast<std::size_t>(slot.base + action)];
            entries.push_back(std::move(entry));
        }
    }
    // One-action decisions: emit probability 1 without stored rows.
    engine_->append_implicit_strategy_entries(entries);
    return entries;
}

} // namespace poker::solver

