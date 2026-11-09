#include "explorer/value_worker.hpp"

#include <algorithm>
#include <stdexcept>
#include <utility>

namespace poker::explorer
{

namespace
{

bool is_prefetch(ValuePriority priority)
{
    return priority == ValuePriority::Prefetch;
}

} // namespace

ValueWorker::ValueWorker(Session& session, ValueEvaluate evaluate, ValueErrorBody error_body)
    : session_(session)
    , evaluate_(std::move(evaluate))
    , error_body_(std::move(error_body))
{
}

ValueWorker::~ValueWorker()
{
    shutdown();
}

bool ValueWorker::same_identity(const ValueRequest& left, const ValueRequest& right)
{
    return left.solution_id == right.solution_id && left.profile_revision == right.profile_revision
        && left.node_id == right.node_id && left.kind == right.kind;
}

int ValueWorker::priority_rank(ValuePriority priority)
{
    return static_cast<int>(priority);
}

int ValueWorker::kind_rank(const std::string& kind)
{
    // Action EV is cheaper on measured Study spots; run it before equity.
    if (kind == "actions")
    {
        return 0;
    }
    if (kind == "runout")
    {
        return 1;
    }
    if (kind == "equity")
    {
        return 2;
    }
    return 3;
}

void ValueWorker::ensure_started()
{
    if (started_ || stop_)
    {
        return;
    }
    thread_ = std::thread([this] { thread_main(); });
    started_ = true;
}

const ValueWorker::CachedResult* ValueWorker::find_cached_unlocked(const ValueRequest& request) const
{
    for (auto it = result_cache_.rbegin(); it != result_cache_.rend(); ++it)
    {
        if (it->solution_id == request.solution_id && it->profile_revision == request.profile_revision
            && it->node_id == request.node_id && it->kind == request.kind)
        {
            return &(*it);
        }
    }
    return nullptr;
}

void ValueWorker::store_cached_unlocked(CachedResult entry)
{
    for (auto it = result_cache_.begin(); it != result_cache_.end(); ++it)
    {
        if (it->solution_id == entry.solution_id && it->profile_revision == entry.profile_revision
            && it->node_id == entry.node_id && it->kind == entry.kind)
        {
            result_cache_.erase(it);
            break;
        }
    }
    result_cache_.push_back(std::move(entry));
    while (result_cache_.size() > kResultCacheCap)
    {
        result_cache_.pop_front();
    }
}

void ValueWorker::clear_cache_unlocked()
{
    result_cache_.clear();
}

std::deque<ValueWorker::QueuedJob>::iterator ValueWorker::find_queued_unlocked(const ValueRequest& request)
{
    return std::find_if(queue_.begin(), queue_.end(), [&](const QueuedJob& job) {
        return same_identity(job.request, request);
    });
}

ValueReply ValueWorker::reply_from_cache_unlocked(const CachedResult& cached, std::uint64_t job_id) const
{
    ValueReply reply;
    reply.ready = true;
    reply.ok = cached.ok;
    reply.known = true;
    reply.body = cached.body;
    reply.job_id = job_id;
    return reply;
}

ValueReply ValueWorker::pending_reply_unlocked(std::uint64_t job_id) const
{
    ValueReply reply;
    reply.known = true;
    reply.job_id = job_id;
    return reply;
}

void ValueWorker::drop_obsolete_unlocked(const ValueRequest& incoming)
{
    if (is_prefetch(incoming.priority))
    {
        return;
    }
    // Auto drops expendable prefetch only. Foreground (explicit navigation /
    // selection owner) also replaces queued/inflight work for other nodes.
    const bool drop_other_nodes = incoming.priority == ValuePriority::Foreground;
    for (auto it = queue_.begin(); it != queue_.end();)
    {
        const ValueRequest& queued = it->request;
        if (same_identity(queued, incoming))
        {
            ++it;
            continue;
        }
        const bool other_solution = queued.solution_id != incoming.solution_id;
        const bool other_revision = queued.profile_revision != incoming.profile_revision;
        const bool other_node = queued.node_id != incoming.node_id;
        const bool drop_prefetch = is_prefetch(queued.priority);
        const bool drop = drop_prefetch || other_solution || other_revision
            || (drop_other_nodes && other_node);
        if (drop)
        {
            it = queue_.erase(it);
        }
        else
        {
            ++it;
        }
    }
    if (inflight_)
    {
        const ValueRequest& live = inflight_request_;
        if (same_identity(live, incoming))
        {
            return;
        }
        const bool other_solution = live.solution_id != incoming.solution_id;
        const bool other_revision = live.profile_revision != incoming.profile_revision;
        const bool other_node = live.node_id != incoming.node_id;
        const bool cancel_live = is_prefetch(live.priority) || other_solution || other_revision
            || (drop_other_nodes && other_node);
        if (cancel_live)
        {
            cancel_.store(true);
            ++serial_;
        }
    }
}

void ValueWorker::insert_queued_unlocked(ValueRequest request)
{
    if (is_prefetch(request.priority))
    {
        std::size_t prefetch_count = 0;
        for (const QueuedJob& job : queue_)
        {
            if (is_prefetch(job.request.priority))
            {
                ++prefetch_count;
            }
        }
        if (prefetch_count >= kMaxPrefetchQueued)
        {
            for (auto it = queue_.begin(); it != queue_.end(); ++it)
            {
                if (is_prefetch(it->request.priority))
                {
                    queue_.erase(it);
                    break;
                }
            }
        }
    }

    QueuedJob job;
    job.request = std::move(request);
    job.serial = ++serial_; // unique ticket; cancel also bumps serial_
    queue_.push_back(std::move(job));
    std::stable_sort(queue_.begin(), queue_.end(), [](const QueuedJob& left, const QueuedJob& right) {
        const int left_priority = priority_rank(left.request.priority);
        const int right_priority = priority_rank(right.request.priority);
        if (left_priority != right_priority)
        {
            return left_priority > right_priority;
        }
        const int left_kind = kind_rank(left.request.kind);
        const int right_kind = kind_rank(right.request.kind);
        if (left_kind != right_kind)
        {
            return left_kind < right_kind;
        }
        return left.serial < right.serial;
    });
}

ValueReply ValueWorker::lookup(const ValueRequest& request) const
{
    std::lock_guard<std::mutex> lock(mu_);
    if (const CachedResult* cached = find_cached_unlocked(request); cached != nullptr)
    {
        return reply_from_cache_unlocked(*cached, request.job_id);
    }
    if (inflight_ && same_identity(inflight_request_, request))
    {
        return pending_reply_unlocked(inflight_request_.job_id);
    }
    for (const QueuedJob& job : queue_)
    {
        if (same_identity(job.request, request))
        {
            return pending_reply_unlocked(job.request.job_id);
        }
    }
    ValueReply reply;
    reply.job_id = request.job_id;
    return reply;
}

ValueReply ValueWorker::enqueue(const ValueRequest& request)
{
    std::lock_guard<std::mutex> lock(mu_);
    ValueReply reply;
    reply.job_id = request.job_id;
    if (stop_)
    {
        reply.ready = true;
        reply.ok = false;
        reply.known = true;
        reply.body = error_body_ ? error_body_("value worker stopped", request) : std::string("value worker stopped");
        return reply;
    }
    ensure_started();

    if (const CachedResult* cached = find_cached_unlocked(request); cached != nullptr)
    {
        return reply_from_cache_unlocked(*cached, request.job_id);
    }
    if (inflight_ && same_identity(inflight_request_, request))
    {
        return pending_reply_unlocked(inflight_request_.job_id);
    }
    auto queued = find_queued_unlocked(request);
    if (queued != queue_.end())
    {
        if (priority_rank(request.priority) > priority_rank(queued->request.priority))
        {
            queued->request.priority = request.priority;
            ValueRequest upgraded = queued->request;
            queue_.erase(queued);
            insert_queued_unlocked(std::move(upgraded));
        }
        return pending_reply_unlocked(request.job_id);
    }

    drop_obsolete_unlocked(request);
    if (const CachedResult* cached = find_cached_unlocked(request); cached != nullptr)
    {
        return reply_from_cache_unlocked(*cached, request.job_id);
    }
    if (inflight_ && same_identity(inflight_request_, request))
    {
        return pending_reply_unlocked(inflight_request_.job_id);
    }
    insert_queued_unlocked(request);
    cv_.notify_one();
    return pending_reply_unlocked(request.job_id);
}

ValueReply ValueWorker::submit(const ValueRequest& request)
{
    ValueReply existing = lookup(request);
    if (existing.ready || existing.known)
    {
        return existing;
    }
    return enqueue(request);
}

void ValueWorker::cancel()
{
    std::lock_guard<std::mutex> lock(mu_);
    cancel_.store(true);
    queue_.clear();
    ++serial_;
    clear_cache_unlocked();
}

void ValueWorker::cancel_and_drain()
{
    {
        std::lock_guard<std::mutex> lock(mu_);
        cancel_.store(true);
        queue_.clear();
        ++serial_;
        clear_cache_unlocked();
    }
    cv_.notify_all();
    std::unique_lock<std::mutex> lock(mu_);
    idle_.wait(lock, [&] { return !inflight_; });
}

void ValueWorker::shutdown()
{
    {
        std::lock_guard<std::mutex> lock(mu_);
        stop_ = true;
        queue_.clear();
        cancel_.store(true);
        ++serial_;
        clear_cache_unlocked();
    }
    cv_.notify_all();
    if (thread_.joinable())
    {
        thread_.join();
    }
}

bool ValueWorker::live() const
{
    std::lock_guard<std::mutex> lock(mu_);
    return started_ && !stop_ && thread_.joinable();
}

void ValueWorker::thread_main()
{
    while (true)
    {
        ValueRequest request;
        std::uint64_t run_serial = 0;
        {
            std::unique_lock<std::mutex> lock(mu_);
            if (inflight_)
            {
                inflight_ = false;
                idle_.notify_all();
            }
            cv_.wait(lock, [&] { return stop_ || !queue_.empty(); });
            if (stop_ && queue_.empty())
            {
                return;
            }
            if (queue_.empty())
            {
                continue;
            }
            QueuedJob job = std::move(queue_.front());
            queue_.pop_front();
            request = std::move(job.request);
            run_serial = serial_;
            cancel_.store(false);
            inflight_ = true;
            inflight_serial_ = run_serial;
            inflight_request_ = request;
        }

        std::string body;
        bool ok = false;
        bool discard = false;
        {
            std::shared_ptr<void> borrowed = session_.borrow(request.solution_id);
            if (!borrowed)
            {
                discard = true;
            }
            else
            {
                ReaderLease lease(session_, std::move(borrowed));
                try
                {
                    if (cancel_.load())
                    {
                        throw std::runtime_error("value query cancelled");
                    }
                    body = evaluate_(lease.resource(), request, cancel_);
                    if (cancel_.load() || session_.current_solution() != request.solution_id)
                    {
                        discard = true;
                    }
                    else
                    {
                        ok = true;
                    }
                }
                catch (const std::exception& error)
                {
                    if (cancel_.load() || session_.current_solution() != request.solution_id)
                    {
                        discard = true;
                    }
                    else
                    {
                        body = error_body_ ? error_body_(error.what(), request) : error.what();
                        ok = false;
                    }
                }
            }
        }
        {
            std::lock_guard<std::mutex> lock(mu_);
            inflight_ = false;
            idle_.notify_all();
            // Discard cancelled / replaced walks. serial_ advances only on cancel
            // paths and on insert; compare against the generation captured at start
            // so a later queued sibling does not erase this finished page — only an
            // explicit cancel bumps past run_serial without this job being current.
            // insert_queued also bumps serial_, so use cancel flag + stop instead of
            // serial inequality alone.
            if (discard || stop_ || cancel_.load())
            {
                continue;
            }
            store_cached_unlocked(CachedResult{
                request.solution_id,
                request.profile_revision,
                request.node_id,
                request.kind,
                ok,
                std::move(body),
            });
            (void)run_serial;
        }
    }
}

} // namespace poker::explorer
