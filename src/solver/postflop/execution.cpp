// StreetBatchSolver::Engine method definitions.
#include "engine.hpp"

namespace poker::solver
{


void StreetBatchSolver::Engine::check_usable() const
{
    if (plan_only_)
    {
        throw std::logic_error("plan-only StreetBatchSolver cannot train or evaluate");
    }
    if (failed_)
    {
        throw std::logic_error(
            "street solver failed during a frozen pass and cannot continue");
    }
}



void StreetBatchSolver::Engine::join_workers()
{
    {
        std::lock_guard<std::mutex> lock(pool_mutex_);
        stop_ = true;
    }
    work_cv_.notify_all();
    for (int index = 0; index < worker_count_; ++index)
    {
        if (workers_[index].joinable())
        {
            workers_[index].join();
        }
    }
    worker_count_ = 0;
}



void StreetBatchSolver::Engine::setup_workers()
{
    if (config.threads == 1)
    {
        return;
    }
    budget_->set_stage("workers");
    for (int index = 1; index < config.threads; ++index)
    {
        void* storage = budget_->allocate(sizeof(WorkerContext), alignof(WorkerContext));
        WorkerContext* ctx = nullptr;
        try
        {
            ctx = new (storage) WorkerContext(heap_);
            prepare_context(*ctx);
            extra_contexts_[extra_count_++] = ctx;
        }
        catch (...)
        {
            if (ctx != nullptr)
            {
                ctx->~WorkerContext();
            }
            budget_->deallocate(storage, sizeof(WorkerContext), alignof(WorkerContext));
            destroy_extra_contexts();
            throw;
        }
    }
    budget_->set_stage("card_results");
    result0_.assign(static_cast<std::size_t>(52 * n0), 0.0);
    result1_.assign(static_cast<std::size_t>(52 * n1), 0.0);
    try
    {
        for (int index = 0; index < config.threads - 1; ++index)
        {
            workers_[index] = std::thread([this, index] { worker_main(index + 1); });
            worker_count_ = index + 1;
        }
    }
    catch (...)
    {
        join_workers();
        destroy_extra_contexts();
        throw;
    }
}



StreetBatchSolver::Engine::WorkerContext& StreetBatchSolver::Engine::context_for(int worker_index)
{
    if (worker_index == 0)
    {
        return workspace;
    }
    return *extra_contexts_[worker_index - 1];
}



void StreetBatchSolver::Engine::run_chunk(int worker_index, int begin, int end)
{
    if (worker_index > 0 && fail_tickets_.exchange(0) > 0)
    {
        throw std::runtime_error("injected worker failure");
    }
    if (begin == end)
    {
        return;
    }
    WorkerContext& ctx = context_for(worker_index);
    Scratch& child = ctx.scratch[static_cast<std::size_t>(task_depth_)];
    for (int index = begin; index < end; ++index)
    {
        const int card = active_cards_[index];
        const int pause = delay_us_.load(std::memory_order_relaxed);
        if (pause > 0)
        {
            const int scale = (card * 17) % 5;
            if (scale > 0)
            {
                std::this_thread::sleep_for(std::chrono::microseconds(pause * scale));
            }
        }
        int next_turn = task_turn_;
        int next_river = task_river_;
        if (task_deal_ == 1)
        {
            next_turn = card;
        }
        else
        {
            next_river = card;
        }
        ensure_board_support(ctx, next_turn, next_river);
        for (int hand = 0; hand < n0; ++hand)
        {
            child.pi0[static_cast<std::size_t>(hand)] =
                ctx.live0[static_cast<std::size_t>(hand)] ? task_pi0_[hand] : 0.0;
        }
        for (int hand = 0; hand < n1; ++hand)
        {
            child.pi1[static_cast<std::size_t>(hand)] =
                ctx.live1[static_cast<std::size_t>(hand)] ? task_pi1_[hand] : 0.0;
        }
        frozen_walk(
            ctx, task_node_, next_turn, next_river, task_depth_, task_updating_, task_weight_, true);
        const std::size_t ev0_at = static_cast<std::size_t>(card) * static_cast<std::size_t>(n0);
        const std::size_t ev1_at = static_cast<std::size_t>(card) * static_cast<std::size_t>(n1);
        std::copy(child.ev0.begin(), child.ev0.end(), result0_.begin() + static_cast<std::ptrdiff_t>(ev0_at));
        std::copy(child.ev1.begin(), child.ev1.end(), result1_.begin() + static_cast<std::ptrdiff_t>(ev1_at));
    }
}



void StreetBatchSolver::Engine::run_response_chunk(int worker_index, int begin, int end)
{
    if (worker_index > 0 && fail_tickets_.exchange(0) > 0)
    {
        throw std::runtime_error("injected worker failure");
    }
    if (begin == end)
    {
        return;
    }
    WorkerContext& ctx = context_for(worker_index);
    Scratch& child = ctx.scratch[static_cast<std::size_t>(task_depth_)];
    for (int index = begin; index < end; ++index)
    {
        const int card = active_cards_[index];
        int next_turn = task_turn_;
        int next_river = task_river_;
        if (task_deal_ == 1)
        {
            next_turn = card;
        }
        else
        {
            next_river = card;
        }
        ensure_board_support(ctx, next_turn, next_river);
        for (int hand = 0; hand < n0; ++hand)
        {
            child.pi0[static_cast<std::size_t>(hand)] =
                ctx.live0[static_cast<std::size_t>(hand)] ? task_pi0_[hand] : 0.0;
        }
        for (int hand = 0; hand < n1; ++hand)
        {
            child.pi1[static_cast<std::size_t>(hand)] =
                ctx.live1[static_cast<std::size_t>(hand)] ? task_pi1_[hand] : 0.0;
        }
        response_walk(
            ctx, task_node_, next_turn, next_river, task_depth_, task_responding_, true);
        const std::size_t ev0_at = static_cast<std::size_t>(card) * static_cast<std::size_t>(n0);
        const std::size_t ev1_at = static_cast<std::size_t>(card) * static_cast<std::size_t>(n1);
        std::copy(child.ev0.begin(), child.ev0.end(), result0_.begin() + static_cast<std::ptrdiff_t>(ev0_at));
        std::copy(child.ev1.begin(), child.ev1.end(), result1_.begin() + static_cast<std::ptrdiff_t>(ev1_at));
    }
}



void StreetBatchSolver::Engine::worker_main(int worker_index)
{
    std::uint64_t seen = 0;
    for (;;)
    {
        int begin = 0;
        int end = 0;
        PoolJob job = PoolJob::Chance;
        {
            std::unique_lock<std::mutex> lock(pool_mutex_);
            work_cv_.wait(lock, [&] { return stop_ || epoch_ != seen; });
            if (stop_)
            {
                return;
            }
            seen = epoch_;
            begin = chunk_begin_[worker_index];
            end = chunk_end_[worker_index];
            job = pool_job_;
        }
        std::exception_ptr error;
        try
        {
            if (job == PoolJob::Slots)
            {
                run_slot_range(begin, end);
            }
            else if (job == PoolJob::Response)
            {
                run_response_chunk(worker_index, begin, end);
            }
            else
            {
                run_chunk(worker_index, begin, end);
            }
        }
        catch (...)
        {
            error = std::current_exception();
        }
        {
            std::lock_guard<std::mutex> lock(pool_mutex_);
            if (error && worker_error_ == nullptr)
            {
                worker_error_ = error;
            }
            ++finished_;
        }
        done_cv_.notify_one();
    }
}



void StreetBatchSolver::Engine::dispatch_workers(PoolJob job)
{
    {
        std::lock_guard<std::mutex> lock(pool_mutex_);
        worker_error_ = nullptr;
        finished_ = 0;
        pool_job_ = job;
        ++epoch_;
    }
    work_cv_.notify_all();
    std::exception_ptr caller_error;
    try
    {
        if (job == PoolJob::Slots)
        {
            run_slot_range(chunk_begin_[0], chunk_end_[0]);
        }
        else if (job == PoolJob::Response)
        {
            run_response_chunk(0, chunk_begin_[0], chunk_end_[0]);
        }
        else
        {
            run_chunk(0, chunk_begin_[0], chunk_end_[0]);
        }
    }
    catch (...)
    {
        caller_error = std::current_exception();
    }
    std::exception_ptr worker_error;
    {
        std::unique_lock<std::mutex> lock(pool_mutex_);
        done_cv_.wait(lock, [&] { return finished_ == worker_count_; });
        worker_error = worker_error_;
        worker_error_ = nullptr;
    }
    if (worker_error != nullptr || caller_error != nullptr)
    {
        failed_ = true;
        std::rethrow_exception(worker_error != nullptr ? worker_error : caller_error);
    }
}



void StreetBatchSolver::Engine::dispatch_chance()
{
    dispatch_workers(PoolJob::Chance);
}



void StreetBatchSolver::Engine::partition_slots()
{
    const int workers = config.threads;
    const int total = static_cast<int>(slots.size());
    const int base = total / workers;
    const int remainder = total % workers;
    int cursor = 0;
    for (int worker = 0; worker < workers; ++worker)
    {
        const int count = base + (worker < remainder ? 1 : 0);
        chunk_begin_[worker] = cursor;
        chunk_end_[worker] = cursor + count;
        cursor += count;
    }
}



void StreetBatchSolver::Engine::apply_freeze_range(std::size_t begin, std::size_t end)
{
    const bool predictive =
        bound_algorithm_ == Algorithm::PcfrPlus && prediction_.size() == regret.size();
    double predicted[8];
    for (std::size_t index = begin; index < end; ++index)
    {
        const Slot& slot = slots[index];
        if (predictive)
        {
            for (int action = 0; action < slot_action_count(slot); ++action)
            {
                const std::size_t at = static_cast<std::size_t>(slot.base + action);
                predicted[action] = regret[at] + prediction_[at];
            }
            regret_matching(predicted, sigma.data() + slot.base, slot_action_count(slot));
        }
        else
        {
            regret_matching(
                regret.data() + slot.base,
                sigma.data() + slot.base,
                slot_action_count(slot));
        }
        if (locks_ != nullptr)
        {
            const NodeLock* lock = locks_->find(static_cast<std::size_t>(slot.node));
            apply_lock_to_strategy(
                std::span<TableScalar>(
                    sigma.data() + slot.base,
                    static_cast<std::size_t>(slot_action_count(slot))),
                lock,
                static_cast<std::size_t>(slot.hand));
        }
    }
}



void StreetBatchSolver::Engine::apply_floor_range(std::size_t begin, std::size_t end, int player)
{
    for (std::size_t index = begin; index < end; ++index)
    {
        const Slot& slot = slots[index];
        if (player >= 0 && nodes[static_cast<std::size_t>(slot.node)].player != player)
        {
            continue;
        }
        for (int action = 0; action < slot_action_count(slot); ++action)
        {
            TableScalar& cumulative = regret[static_cast<std::size_t>(slot.base + action)];
            if (cumulative < 0.0)
            {
                cumulative = 0.0;
            }
        }
    }
}



// Floor one player's regrets, then rebuild sigma for every slot.
// Same values as floor_player then freeze_sigma; one slot scan instead of two.
// Under PCFR+, matching uses R+m (prediction_) after the floor.
void StreetBatchSolver::Engine::apply_floor_and_freeze_range(std::size_t begin, std::size_t end, int player)
{
    const bool predictive =
        bound_algorithm_ == Algorithm::PcfrPlus && prediction_.size() == regret.size();
    double predicted[8];
    for (std::size_t index = begin; index < end; ++index)
    {
        const Slot& slot = slots[index];
        if (player >= 0 && nodes[static_cast<std::size_t>(slot.node)].player == player)
        {
            for (int action = 0; action < slot_action_count(slot); ++action)
            {
                TableScalar& cumulative = regret[static_cast<std::size_t>(slot.base + action)];
                if (cumulative < 0.0)
                {
                    cumulative = 0.0;
                }
            }
        }
        if (predictive)
        {
            for (int action = 0; action < slot_action_count(slot); ++action)
            {
                const std::size_t at = static_cast<std::size_t>(slot.base + action);
                predicted[action] = regret[at] + prediction_[at];
            }
            regret_matching(predicted, sigma.data() + slot.base, slot_action_count(slot));
        }
        else
        {
            regret_matching(
                regret.data() + slot.base,
                sigma.data() + slot.base,
                slot_action_count(slot));
        }
        if (locks_ != nullptr)
        {
            const NodeLock* lock = locks_->find(static_cast<std::size_t>(slot.node));
            apply_lock_to_strategy(
                std::span<TableScalar>(
                    sigma.data() + slot.base,
                    static_cast<std::size_t>(slot_action_count(slot))),
                lock,
                static_cast<std::size_t>(slot.hand));
        }
    }
}



// PCFR+: after a walk that wrote instantaneous CF regret into prediction_,
// add those increments into regret, floor the updating player, and keep
// prediction_ as m for the next match. Opponent prediction rows are untouched.
void StreetBatchSolver::Engine::apply_pcfr_commit_range(std::size_t begin, std::size_t end, int player)
{
    for (std::size_t index = begin; index < end; ++index)
    {
        const Slot& slot = slots[index];
        if (player >= 0 && nodes[static_cast<std::size_t>(slot.node)].player != player)
        {
            continue;
        }
        for (int action = 0; action < slot_action_count(slot); ++action)
        {
            const std::size_t at = static_cast<std::size_t>(slot.base + action);
            regret[at] += prediction_[at];
            if (regret[at] < 0.0)
            {
                regret[at] = 0.0;
            }
        }
    }
}



void StreetBatchSolver::Engine::apply_pcfr_zero_prediction_range(std::size_t begin, std::size_t end, int player)
{
    for (std::size_t index = begin; index < end; ++index)
    {
        const Slot& slot = slots[index];
        if (player >= 0 && nodes[static_cast<std::size_t>(slot.node)].player != player)
        {
            continue;
        }
        for (int action = 0; action < slot_action_count(slot); ++action)
        {
            prediction_[static_cast<std::size_t>(slot.base + action)] = 0.0;
        }
    }
}



// DCFR: discount every action entry of the updating player after the pass,
// including entries whose increment this pass was zero. Regret already holds
// the post-pass value; do not add the increment again.
void StreetBatchSolver::Engine::apply_discount_range(std::size_t begin, std::size_t end, int player)
{
    for (std::size_t index = begin; index < end; ++index)
    {
        const Slot& slot = slots[index];
        if (player >= 0 && nodes[static_cast<std::size_t>(slot.node)].player != player)
        {
            continue;
        }
        for (int action = 0; action < slot_action_count(slot); ++action)
        {
            TableScalar& cumulative = regret[static_cast<std::size_t>(slot.base + action)];
            cumulative = static_cast<TableScalar>(dcfr_discount_post_pass(
                cumulative, slot_positive_discount_, slot_negative_discount_));
        }
    }
}



void StreetBatchSolver::Engine::apply_discount_and_freeze_range(std::size_t begin, std::size_t end, int player)
{
    for (std::size_t index = begin; index < end; ++index)
    {
        const Slot& slot = slots[index];
        if (player >= 0 && nodes[static_cast<std::size_t>(slot.node)].player == player)
        {
            for (int action = 0; action < slot_action_count(slot); ++action)
            {
                TableScalar& cumulative = regret[static_cast<std::size_t>(slot.base + action)];
                cumulative = static_cast<TableScalar>(dcfr_discount_post_pass(
                    cumulative, slot_positive_discount_, slot_negative_discount_));
            }
        }
        regret_matching(
            regret.data() + slot.base,
            sigma.data() + slot.base,
            slot_action_count(slot));
        if (locks_ != nullptr)
        {
            const NodeLock* lock = locks_->find(static_cast<std::size_t>(slot.node));
            apply_lock_to_strategy(
                std::span<TableScalar>(
                    sigma.data() + slot.base,
                    static_cast<std::size_t>(slot_action_count(slot))),
                lock,
                static_cast<std::size_t>(slot.hand));
        }
    }
}



void StreetBatchSolver::Engine::run_slot_range(int begin, int end)
{
    const std::size_t first = static_cast<std::size_t>(begin);
    const std::size_t last = static_cast<std::size_t>(end);
    switch (slot_pass_)
    {
    case SlotPass::Freeze:
        apply_freeze_range(first, last);
        break;
    case SlotPass::Floor:
        apply_floor_range(first, last, slot_floor_player_);
        break;
    case SlotPass::FloorAndFreeze:
        apply_floor_and_freeze_range(first, last, slot_floor_player_);
        break;
    case SlotPass::Discount:
        apply_discount_range(first, last, slot_floor_player_);
        break;
    case SlotPass::DiscountAndFreeze:
        apply_discount_and_freeze_range(first, last, slot_floor_player_);
        break;
    case SlotPass::PcfrCommit:
        apply_pcfr_commit_range(first, last, slot_floor_player_);
        break;
    case SlotPass::PcfrZeroPrediction:
        apply_pcfr_zero_prediction_range(first, last, slot_floor_player_);
        break;
    }
}



void StreetBatchSolver::Engine::run_slot_pass(SlotPass pass, int player)
{
    slot_pass_ = pass;
    slot_floor_player_ = player;
    if (config.threads <= 1 || worker_count_ == 0 || slots.empty())
    {
        run_slot_range(0, static_cast<int>(slots.size()));
        return;
    }
    partition_slots();
    dispatch_workers(PoolJob::Slots);
}



// When locks_ is set, locked rows replace RM for matching public nodes.
// Lock infoset_id is the public-node index (slot.node). SelectedCombos
// uses the acting player's hand index (slot.hand). Slots are independent:
// each writes only its own sigma / regret span, so threads > 1
// partition the slot vector with the same worker pool as chance splits.
void StreetBatchSolver::Engine::freeze_sigma()
{
    const auto started = profile_
        ? std::chrono::steady_clock::now()
        : std::chrono::steady_clock::time_point{};
    run_slot_pass(SlotPass::Freeze, -1);
    if (profile_)
    {
        freeze_seconds_ += std::chrono::duration<double>(
            std::chrono::steady_clock::now() - started).count();
    }
}



void StreetBatchSolver::Engine::floor_player(int player)
{
    const auto started = profile_
        ? std::chrono::steady_clock::now()
        : std::chrono::steady_clock::time_point{};
    run_slot_pass(SlotPass::Floor, player);
    if (profile_)
    {
        freeze_seconds_ += std::chrono::duration<double>(
            std::chrono::steady_clock::now() - started).count();
    }
}



void StreetBatchSolver::Engine::floor_and_freeze(int player)
{
    const auto started = profile_
        ? std::chrono::steady_clock::now()
        : std::chrono::steady_clock::time_point{};
    run_slot_pass(SlotPass::FloorAndFreeze, player);
    if (profile_)
    {
        freeze_seconds_ += std::chrono::duration<double>(
            std::chrono::steady_clock::now() - started).count();
    }
}



void StreetBatchSolver::Engine::pcfr_zero_prediction(int player)
{
    run_slot_pass(SlotPass::PcfrZeroPrediction, player);
}



void StreetBatchSolver::Engine::pcfr_commit(int player)
{
    const auto started = profile_
        ? std::chrono::steady_clock::now()
        : std::chrono::steady_clock::time_point{};
    run_slot_pass(SlotPass::PcfrCommit, player);
    if (profile_)
    {
        freeze_seconds_ += std::chrono::duration<double>(
            std::chrono::steady_clock::now() - started).count();
    }
}



void StreetBatchSolver::Engine::discount_player(int player, double positive, double negative)
{
    slot_positive_discount_ = positive;
    slot_negative_discount_ = negative;
    const auto started = profile_
        ? std::chrono::steady_clock::now()
        : std::chrono::steady_clock::time_point{};
    run_slot_pass(SlotPass::Discount, player);
    if (profile_)
    {
        freeze_seconds_ += std::chrono::duration<double>(
            std::chrono::steady_clock::now() - started).count();
    }
}



void StreetBatchSolver::Engine::discount_and_freeze(int player, double positive, double negative)
{
    slot_positive_discount_ = positive;
    slot_negative_discount_ = negative;
    const auto started = profile_
        ? std::chrono::steady_clock::now()
        : std::chrono::steady_clock::time_point{};
    run_slot_pass(SlotPass::DiscountAndFreeze, player);
    if (profile_)
    {
        freeze_seconds_ += std::chrono::duration<double>(
            std::chrono::steady_clock::now() - started).count();
    }
}



void StreetBatchSolver::Engine::frozen_pass(int updating, double weight_iter, Algorithm algorithm)
{
    freeze_sigma();
    std::fill(workspace.scratch[0].pi0.begin(), workspace.scratch[0].pi0.end(), 1.0);
    std::fill(workspace.scratch[0].pi1.begin(), workspace.scratch[0].pi1.end(), 1.0);
    frozen_walk(workspace, 0, -1, -1, 0, updating, weight_iter, false);
    if (algorithm == Algorithm::CfrPlus)
    {
        floor_player(updating);
    }
    else if (algorithm == Algorithm::Dcfr)
    {
        discount_player(updating, slot_positive_discount_, slot_negative_discount_);
    }
}



void StreetBatchSolver::Engine::throw_if_cancelled(const std::atomic<bool>* cancel) const
{
    if (cancel != nullptr && cancel->load(std::memory_order_relaxed))
    {
        throw StreetValueCancelled();
    }
}


} // namespace poker::solver
