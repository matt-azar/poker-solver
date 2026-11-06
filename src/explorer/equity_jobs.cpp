#include "explorer/equity_jobs.hpp"

#include <algorithm>
#include <chrono>
#include <stdexcept>

namespace poker::explorer
{
namespace
{

constexpr std::size_t kMaxQueuedJobs = 4;
constexpr std::size_t kMaxRetainedJobs = 32;

} // namespace

std::string_view equity_job_state_name(EquityJobState state)
{
    switch (state)
    {
    case EquityJobState::Queued:
        return "queued";
    case EquityJobState::Preparing:
        return "preparing";
    case EquityJobState::Running:
        return "running";
    case EquityJobState::Stopping:
        return "stopping";
    case EquityJobState::Completed:
        return "completed";
    case EquityJobState::Stopped:
        return "stopped";
    case EquityJobState::Cancelled:
        return "cancelled";
    case EquityJobState::Failed:
        return "failed";
    }
    return "failed";
}

EquityJobManager::EquityJobManager() = default;

EquityJobManager::~EquityJobManager()
{
    shutdown();
}

void EquityJobManager::ensure_started_locked()
{
    if (started_)
    {
        return;
    }
    started_ = true;
    stop_ = false;
    thread_ = std::thread([this] { thread_main(); });
}

void EquityJobManager::prune_locked()
{
    while (jobs_.size() > kMaxRetainedJobs)
    {
        std::string oldest;
        for (const auto& [id, snap] : jobs_)
        {
            if (id == current_id_)
            {
                continue;
            }
            if (snap.state == EquityJobState::Queued || snap.state == EquityJobState::Preparing
                || snap.state == EquityJobState::Running || snap.state == EquityJobState::Stopping)
            {
                continue;
            }
            oldest = id;
            break;
        }
        if (oldest.empty())
        {
            break;
        }
        jobs_.erase(oldest);
    }
}

void EquityJobManager::retain_locked(const std::string& id, EquityJobSnapshot snapshot)
{
    jobs_[id] = std::move(snapshot);
    prune_locked();
}

std::string EquityJobManager::enqueue(EquityJobRequest request)
{
    if (request.players.size() < 2 || request.players.size() > 6)
    {
        throw std::invalid_argument("equity job requires 2 to 6 players");
    }
    const std::size_t board_n = request.board.size();
    if (!(board_n == 0 || board_n == 3 || board_n == 4 || board_n == 5))
    {
        throw std::invalid_argument("equity board must contain 0, 3, 4, or 5 cards");
    }

    std::lock_guard<std::mutex> lock(mu_);
    if (queue_.size() >= kMaxQueuedJobs)
    {
        throw std::runtime_error("equity calculator queue is full");
    }
    ensure_started_locked();
    const std::string id = "eq" + std::to_string(next_id_++);
    EquityJobSnapshot snap;
    snap.id = id;
    snap.state = EquityJobState::Queued;
    snap.request = std::move(request);
    jobs_[id] = snap;
    queue_.push_back(id);
    cv_.notify_one();
    return id;
}

std::optional<EquityJobSnapshot> EquityJobManager::status(const std::string& id) const
{
    std::lock_guard<std::mutex> lock(mu_);
    const auto it = jobs_.find(id);
    if (it == jobs_.end())
    {
        return std::nullopt;
    }
    return it->second;
}

std::optional<EquityJobSnapshot> EquityJobManager::result(const std::string& id) const
{
    std::lock_guard<std::mutex> lock(mu_);
    const auto it = jobs_.find(id);
    if (it == jobs_.end())
    {
        return std::nullopt;
    }
    if (it->second.state != EquityJobState::Completed && it->second.state != EquityJobState::Stopped
        && it->second.state != EquityJobState::Failed && it->second.state != EquityJobState::Cancelled)
    {
        return std::nullopt;
    }
    return it->second;
}

bool EquityJobManager::cancel(const std::string& id)
{
    std::lock_guard<std::mutex> lock(mu_);
    const auto it = jobs_.find(id);
    if (it == jobs_.end())
    {
        return false;
    }
    if (it->second.state == EquityJobState::Completed || it->second.state == EquityJobState::Stopped
        || it->second.state == EquityJobState::Failed || it->second.state == EquityJobState::Cancelled)
    {
        return true;
    }
    if (it->second.state == EquityJobState::Queued)
    {
        queue_.erase(std::remove(queue_.begin(), queue_.end(), id), queue_.end());
        it->second.state = EquityJobState::Cancelled;
        it->second.error = "cancelled before start";
        it->second.error_kind = "cancelled";
        return true;
    }
    it->second.state = EquityJobState::Stopping;
    if (current_id_ == id)
    {
        cancel_current_.store(true, std::memory_order_relaxed);
    }
    return true;
}

void EquityJobManager::shutdown()
{
    {
        std::lock_guard<std::mutex> lock(mu_);
        if (!started_)
        {
            return;
        }
        stop_ = true;
        cancel_current_.store(true, std::memory_order_relaxed);
        cv_.notify_all();
    }
    if (thread_.joinable())
    {
        thread_.join();
    }
    std::lock_guard<std::mutex> lock(mu_);
    started_ = false;
}

void EquityJobManager::thread_main()
{
    for (;;)
    {
        EquityJobSnapshot job;
        {
            std::unique_lock<std::mutex> lock(mu_);
            cv_.wait(lock, [&] { return stop_ || !queue_.empty(); });
            if (stop_ && queue_.empty())
            {
                return;
            }
            if (queue_.empty())
            {
                continue;
            }
            const std::string id = queue_.front();
            queue_.erase(queue_.begin());
            auto it = jobs_.find(id);
            if (it == jobs_.end() || it->second.state == EquityJobState::Cancelled)
            {
                continue;
            }
            current_id_ = id;
            cancel_current_.store(false, std::memory_order_relaxed);
            it->second.state = EquityJobState::Preparing;
            job = it->second;
        }

        const auto started = std::chrono::steady_clock::now();
        {
            std::lock_guard<std::mutex> lock(mu_);
            auto it = jobs_.find(job.id);
            if (it != jobs_.end())
            {
                it->second.state = EquityJobState::Running;
            }
        }

        poker::holdem::EquityCalcOptions options = job.request.options;
        options.cancel_poll = [](void* context) {
            return static_cast<std::atomic<bool>*>(context)->load(std::memory_order_relaxed);
        };
        options.cancel_context = &cancel_current_;
        options.progress = [](void* context, std::uint64_t done, std::uint64_t total) {
            auto* self = static_cast<EquityJobManager*>(context);
            std::lock_guard<std::mutex> lock(self->mu_);
            auto it = self->jobs_.find(self->current_id_);
            if (it != self->jobs_.end())
            {
                it->second.progress_done = done;
                it->second.progress_total = total;
            }
        };
        options.progress_context = this;

        try
        {
            poker::holdem::EquityCalcResult calc = poker::holdem::calculate_equity(
                job.request.players,
                job.request.board,
                job.request.dead_cards,
                options);
            const auto ended = std::chrono::steady_clock::now();
            std::lock_guard<std::mutex> lock(mu_);
            auto it = jobs_.find(job.id);
            if (it == jobs_.end())
            {
                current_id_.clear();
                continue;
            }
            it->second.result = std::move(calc);
            it->second.elapsed_seconds =
                std::chrono::duration<double>(ended - started).count();
            if (it->second.result.stopped || it->second.state == EquityJobState::Stopping)
            {
                it->second.state = EquityJobState::Stopped;
            }
            else
            {
                it->second.state = EquityJobState::Completed;
            }
            it->second.progress_done =
                it->second.result.exact_complete ? it->second.result.work.exact_deals
                                                 : it->second.result.accepted_samples;
            it->second.progress_total = it->second.progress_done;
        }
        catch (const poker::holdem::EquityCalcError& error)
        {
            std::lock_guard<std::mutex> lock(mu_);
            auto it = jobs_.find(job.id);
            if (it == jobs_.end())
            {
                current_id_.clear();
                continue;
            }
            it->second.error = error.what();
            switch (error.failure())
            {
            case poker::holdem::EquityCalcFailure::Cancelled:
                it->second.state = EquityJobState::Cancelled;
                it->second.error_kind = "cancelled";
                break;
            case poker::holdem::EquityCalcFailure::WorkLimit:
                it->second.state = EquityJobState::Failed;
                it->second.error_kind = "work_limit";
                break;
            case poker::holdem::EquityCalcFailure::SampleLimit:
                it->second.state = EquityJobState::Failed;
                it->second.error_kind = "sample_limit";
                break;
            case poker::holdem::EquityCalcFailure::InvalidWeight:
                it->second.state = EquityJobState::Failed;
                it->second.error_kind = "invalid_weight";
                break;
            case poker::holdem::EquityCalcFailure::NumericalRange:
                it->second.state = EquityJobState::Failed;
                it->second.error_kind = "numerical_range";
                break;
            case poker::holdem::EquityCalcFailure::NoLegalJoint:
                it->second.state = EquityJobState::Failed;
                it->second.error_kind = "no_legal_joint";
                break;
            default:
                it->second.state = EquityJobState::Failed;
                it->second.error_kind = "invalid_input";
                break;
            }
        }
        catch (const std::exception& error)
        {
            std::lock_guard<std::mutex> lock(mu_);
            auto it = jobs_.find(job.id);
            if (it != jobs_.end())
            {
                it->second.state = EquityJobState::Failed;
                it->second.error = error.what();
                it->second.error_kind = "failed";
            }
        }

        {
            std::lock_guard<std::mutex> lock(mu_);
            current_id_.clear();
            cancel_current_.store(false, std::memory_order_relaxed);
            prune_locked();
        }
    }
}

} // namespace poker::explorer
