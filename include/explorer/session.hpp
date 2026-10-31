#pragma once

#include <condition_variable>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <utility>

namespace poker::explorer
{

enum class Phase
{
    Idle,
    Running,
    Completed,
    Paused,
    Cancelled,
    Failed
};

enum class StopResult
{
    Accepted,
    AlreadyComplete,
    Stale
};

enum class PauseResult
{
    Accepted,
    AlreadyComplete,
    Stale
};

// One solve at a time. Stop acceptance and successful publication share this
// mutex. Status text is stored here; callers format it before the call and
// must not re-enter the session from a status callback.
class Session
{
public:
    struct Permit
    {
        bool allowed = false;
        std::uint64_t solution_id = 0;
    };

    std::uint64_t begin(std::shared_ptr<void>& retiring)
    {
        std::lock_guard<std::mutex> lock(mu_);
        if (phase_ == Phase::Running)
        {
            throw std::runtime_error("a solve is already running");
        }
        retiring = std::move(resource_);
        resource_.reset();
        baseline_resource_.reset();
        baseline_solution_id_ = 0;
        solution_id_ = 0;
        pending_solution_ = 0;
        job_id_ = next_job_++;
        phase_ = Phase::Running;
        stop_ = false;
        pause_ = false;
        ++generation_;
        return job_id_;
    }

    // Keeps a prior revision queryable after a locked re-solve publishes a new id.
    // Cleared when a new unbound solve begins or a quiet install replaces the session.
    void set_baseline(std::shared_ptr<void> resource, std::uint64_t solution_id)
    {
        std::lock_guard<std::mutex> lock(mu_);
        if (!resource || solution_id == 0)
        {
            baseline_resource_.reset();
            baseline_solution_id_ = 0;
            return;
        }
        baseline_resource_ = std::move(resource);
        baseline_solution_id_ = solution_id;
    }

    std::uint64_t baseline_solution() const
    {
        std::lock_guard<std::mutex> lock(mu_);
        return baseline_solution_id_;
    }

    void clear_baseline()
    {
        std::lock_guard<std::mutex> lock(mu_);
        baseline_resource_.reset();
        baseline_solution_id_ = 0;
    }

    StopResult request_stop(std::uint64_t job_id)
    {
        std::lock_guard<std::mutex> lock(mu_);
        if (job_id != job_id_)
        {
            return StopResult::Stale;
        }
        if (phase_ == Phase::Completed || phase_ == Phase::Paused)
        {
            return StopResult::AlreadyComplete;
        }
        if (phase_ != Phase::Running)
        {
            return StopResult::Stale;
        }
        stop_ = true;
        return StopResult::Accepted;
    }

    bool stop_requested(std::uint64_t job_id) const
    {
        std::lock_guard<std::mutex> lock(mu_);
        return job_id == job_id_ && stop_;
    }

    PauseResult request_pause(std::uint64_t job_id)
    {
        std::lock_guard<std::mutex> lock(mu_);
        if (job_id != job_id_)
        {
            return PauseResult::Stale;
        }
        if (phase_ == Phase::Completed || phase_ == Phase::Paused)
        {
            return PauseResult::AlreadyComplete;
        }
        if (phase_ != Phase::Running)
        {
            return PauseResult::Stale;
        }
        pause_ = true;
        return PauseResult::Accepted;
    }

    bool pause_requested(std::uint64_t job_id) const
    {
        std::lock_guard<std::mutex> lock(mu_);
        return job_id == job_id_ && pause_;
    }

    bool running() const
    {
        std::lock_guard<std::mutex> lock(mu_);
        return phase_ == Phase::Running;
    }

    Phase phase() const
    {
        std::lock_guard<std::mutex> lock(mu_);
        return phase_;
    }

    std::uint64_t current_job() const
    {
        std::lock_guard<std::mutex> lock(mu_);
        return job_id_;
    }

    std::uint64_t current_solution() const
    {
        std::lock_guard<std::mutex> lock(mu_);
        return solution_id_;
    }

    std::uint64_t generation() const
    {
        std::lock_guard<std::mutex> lock(mu_);
        return generation_;
    }

    std::string status() const
    {
        std::lock_guard<std::mutex> lock(mu_);
        return status_;
    }

    void set_progress(std::uint64_t job_id, std::string status)
    {
        std::lock_guard<std::mutex> lock(mu_);
        if (job_id != job_id_ || phase_ != Phase::Running || stop_ || pause_)
        {
            return;
        }
        status_ = std::move(status);
        ++generation_;
    }

    struct Claim
    {
        bool allowed = false;
        std::uint64_t job_id = 0;
    };

    // Takes exclusive training ownership immediately for a completed or paused
    // solution. The solution id and the engine stay. Borrow fails until the
    // continuation is published again. Existing readers may still hold the
    // engine; the continuation thread must wait_until_quiet() before mutating
    // it. Claiming without that wait used to park the HTTP accept loop behind
    // value queries and wedge Continue/Open.
    Claim claim_completed(std::uint64_t solution_id)
    {
        std::lock_guard<std::mutex> lock(mu_);
        if (!queryable_locked() || solution_id == 0 || solution_id != solution_id_ || !resource_)
        {
            return {};
        }
        job_id_ = next_job_++;
        phase_ = Phase::Running;
        stop_ = false;
        pause_ = false;
        ++generation_;
        Claim claim;
        claim.allowed = true;
        claim.job_id = job_id_;
        return claim;
    }

    // The continuation thread is the only user. This does not take a reader.
    std::shared_ptr<void> training_resource(std::uint64_t job_id) const
    {
        std::lock_guard<std::mutex> lock(mu_);
        if (job_id != job_id_ || phase_ != Phase::Running || !resource_)
        {
            return {};
        }
        return resource_;
    }

    // Reserves a solution id. Publication still has to pass commit_success.
    Permit prepare_success(std::uint64_t job_id)
    {
        std::lock_guard<std::mutex> lock(mu_);
        Permit permit;
        if (job_id != job_id_ || phase_ != Phase::Running || stop_ || pause_)
        {
            return permit;
        }
        pending_solution_ = next_solution_++;
        permit.allowed = true;
        permit.solution_id = pending_solution_;
        return permit;
    }

    // make(generation, accepted) runs under the lock and must not call back in.
    // The status string is built before any terminal phase or result is stored.
    // If make throws, the job stays Running and finish_failed can still record it.
    template <typename Make>
    bool commit_success(
        std::uint64_t job_id,
        std::shared_ptr<void> resource,
        std::uint64_t solution_id,
        Make&& make)
    {
        std::lock_guard<std::mutex> lock(mu_);
        if (job_id != job_id_ || phase_ != Phase::Running || solution_id != pending_solution_)
        {
            return false;
        }
        const std::uint64_t next_generation = generation_ + 1;
        const bool accepted = !stop_;
        std::string next_status = make(next_generation, accepted);
        if (!accepted)
        {
            phase_ = Phase::Cancelled;
            resource_.reset();
            solution_id_ = 0;
            pending_solution_ = 0;
            status_ = std::move(next_status);
            generation_ = next_generation;
            return false;
        }
        resource_ = std::move(resource);
        solution_id_ = solution_id;
        phase_ = pause_ ? Phase::Paused : Phase::Completed;
        pause_ = false;
        status_ = std::move(next_status);
        generation_ = next_generation;
        return true;
    }

    // Publication of a solve that already finished at least one iteration when stop
    // was requested. commit_success still discards a stopped job. This path keeps it.
    Permit prepare_kept(std::uint64_t job_id)
    {
        std::lock_guard<std::mutex> lock(mu_);
        Permit permit;
        if (job_id != job_id_ || phase_ != Phase::Running)
        {
            return permit;
        }
        pending_solution_ = next_solution_++;
        permit.allowed = true;
        permit.solution_id = pending_solution_;
        return permit;
    }

    template <typename Make>
    bool commit_kept(
        std::uint64_t job_id,
        std::shared_ptr<void> resource,
        std::uint64_t solution_id,
        Make&& make)
    {
        std::lock_guard<std::mutex> lock(mu_);
        if (job_id != job_id_ || phase_ != Phase::Running || solution_id != pending_solution_)
        {
            return false;
        }
        const std::uint64_t next_generation = generation_ + 1;
        std::string next_status = make(next_generation);
        resource_ = std::move(resource);
        solution_id_ = solution_id;
        phase_ = Phase::Completed;
        stop_ = false;
        pause_ = false;
        status_ = std::move(next_status);
        generation_ = next_generation;
        return true;
    }

    // Like commit_kept, but the published solution is Phase::Paused so Continue
    // can resume the same training state.
    template <typename Make>
    bool commit_paused(
        std::uint64_t job_id,
        std::shared_ptr<void> resource,
        std::uint64_t solution_id,
        Make&& make)
    {
        std::lock_guard<std::mutex> lock(mu_);
        if (job_id != job_id_ || phase_ != Phase::Running || solution_id != pending_solution_)
        {
            return false;
        }
        const std::uint64_t next_generation = generation_ + 1;
        std::string next_status = make(next_generation);
        resource_ = std::move(resource);
        solution_id_ = solution_id;
        phase_ = Phase::Paused;
        stop_ = false;
        pause_ = false;
        status_ = std::move(next_status);
        generation_ = next_generation;
        return true;
    }

    // Replaces a quiet completed, paused, or idle solution. Refuses while training is running.
    // make(generation, solution_id) runs under the lock and must not call back in.
    // Clears any retained baseline — Open / install starts a fresh single revision.
    template <typename Make>
    bool install_completed(std::shared_ptr<void> resource, std::uint64_t& solution_id, Make&& make)
    {
        std::unique_lock<std::mutex> lock(mu_);
        if (phase_ == Phase::Running)
        {
            return false;
        }
        quiet_.wait(lock, [&]() { return readers_ == 0; });
        if (phase_ == Phase::Running || !resource)
        {
            return false;
        }
        baseline_resource_.reset();
        baseline_solution_id_ = 0;
        solution_id_ = next_solution_++;
        pending_solution_ = 0;
        resource_ = std::move(resource);
        phase_ = Phase::Completed;
        stop_ = false;
        pause_ = false;
        job_id_ = 0;
        const std::uint64_t next_generation = generation_ + 1;
        status_ = make(next_generation, solution_id_);
        generation_ = next_generation;
        solution_id = solution_id_;
        return true;
    }

    // Publishes more training on the same solution. A stop keeps the chunks
    // that finished as Completed. A pause keeps them as Paused so Continue can
    // resume. make(generation) runs under the lock and must not call back in.
    template <typename Make>
    bool commit_continuation(std::uint64_t job_id, Make&& make)
    {
        std::lock_guard<std::mutex> lock(mu_);
        if (job_id != job_id_ || phase_ != Phase::Running)
        {
            return false;
        }
        const std::uint64_t next_generation = generation_ + 1;
        std::string next_status = make(next_generation);
        phase_ = (!stop_ && pause_) ? Phase::Paused : Phase::Completed;
        stop_ = false;
        pause_ = false;
        status_ = std::move(next_status);
        generation_ = next_generation;
        return true;
    }

    // An exception while continuing leaves the existing engine queryable.
    void abort_continuation(std::uint64_t job_id, std::string status)
    {
        std::lock_guard<std::mutex> lock(mu_);
        if (job_id != job_id_ || phase_ != Phase::Running)
        {
            return;
        }
        phase_ = Phase::Completed;
        stop_ = false;
        pause_ = false;
        status_ = std::move(status);
        ++generation_;
    }

    void finish_cancelled(std::uint64_t job_id, std::string status)
    {
        std::lock_guard<std::mutex> lock(mu_);
        if (job_id != job_id_ || phase_ != Phase::Running)
        {
            return;
        }
        phase_ = Phase::Cancelled;
        stop_ = true;
        pause_ = false;
        resource_.reset();
        solution_id_ = 0;
        status_ = std::move(status);
        ++generation_;
    }

    void finish_failed(std::uint64_t job_id, std::string status)
    {
        std::lock_guard<std::mutex> lock(mu_);
        if (job_id != job_id_ || phase_ != Phase::Running)
        {
            return;
        }
        phase_ = Phase::Failed;
        resource_.reset();
        solution_id_ = 0;
        status_ = std::move(status);
        ++generation_;
    }

    std::shared_ptr<void> borrow(std::uint64_t solution_id)
    {
        std::lock_guard<std::mutex> lock(mu_);
        if (solution_id == 0)
        {
            return {};
        }
        if (queryable_locked() && solution_id == solution_id_ && resource_)
        {
            ++readers_;
            return resource_;
        }
        // Baseline stays readable while the scenario solution is queryable.
        if (queryable_locked() && solution_id == baseline_solution_id_ && baseline_resource_)
        {
            ++readers_;
            return baseline_resource_;
        }
        return {};
    }

    void release_reader()
    {
        std::lock_guard<std::mutex> lock(mu_);
        if (readers_ > 0)
        {
            --readers_;
        }
        if (readers_ == 0)
        {
            quiet_.notify_all();
        }
    }

    int reader_count() const
    {
        std::lock_guard<std::mutex> lock(mu_);
        return readers_;
    }

    void wait_until_quiet()
    {
        std::unique_lock<std::mutex> lock(mu_);
        quiet_.wait(lock, [&]() { return readers_ == 0; });
    }

    void set_release_hook(std::function<void()> hook)
    {
        std::lock_guard<std::mutex> lock(mu_);
        release_hook_ = std::move(hook);
    }

    void notify_released()
    {
        std::function<void()> hook;
        {
            std::lock_guard<std::mutex> lock(mu_);
            hook = release_hook_;
        }
        if (hook)
        {
            hook();
        }
    }

private:
    bool queryable_locked() const
    {
        return phase_ == Phase::Completed || phase_ == Phase::Paused;
    }

    mutable std::mutex mu_;
    std::condition_variable quiet_;
    Phase phase_ = Phase::Idle;
    bool stop_ = false;
    bool pause_ = false;
    std::uint64_t job_id_ = 0;
    std::uint64_t next_job_ = 1;
    std::uint64_t solution_id_ = 0;
    std::uint64_t next_solution_ = 1;
    std::uint64_t pending_solution_ = 0;
    std::uint64_t generation_ = 0;
    int readers_ = 0;
    std::shared_ptr<void> resource_;
    std::shared_ptr<void> baseline_resource_;
    std::uint64_t baseline_solution_id_ = 0;
    std::string status_ =
        "{\"running\":false,\"paused\":false,\"cancelled\":false,\"error\":\"\",\"solution_id\":null,"
        "\"root_node_id\":null,\"job_id\":null,\"status_generation\":0}";
    std::function<void()> release_hook_;
};

// Drops the borrowed engine before it tells a replacement that the session is quiet.
class ReaderLease
{
public:
    ReaderLease() = default;

    ReaderLease(Session& session, std::shared_ptr<void> resource)
        : session_(resource ? &session : nullptr)
        , resource_(std::move(resource))
    {
    }

    ~ReaderLease()
    {
        release();
    }

    ReaderLease(const ReaderLease&) = delete;
    ReaderLease& operator=(const ReaderLease&) = delete;

    ReaderLease(ReaderLease&& other) noexcept
        : session_(other.session_)
        , resource_(std::move(other.resource_))
    {
        other.session_ = nullptr;
    }

    ReaderLease& operator=(ReaderLease&& other) noexcept
    {
        if (this != &other)
        {
            release();
            session_ = other.session_;
            resource_ = std::move(other.resource_);
            other.session_ = nullptr;
        }
        return *this;
    }

    explicit operator bool() const
    {
        return static_cast<bool>(resource_);
    }

    const std::shared_ptr<void>& resource() const
    {
        return resource_;
    }

    void release()
    {
        resource_.reset();
        if (session_ != nullptr)
        {
            session_->release_reader();
            session_ = nullptr;
        }
    }

private:
    Session* session_ = nullptr;
    std::shared_ptr<void> resource_;
};

} // namespace poker::explorer
