#include "explorer/value_worker.hpp"

#include <stdexcept>
#include <utility>

namespace poker::explorer
{

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
        if (it->solution_id == request.solution_id && it->node_id == request.node_id
            && it->kind == request.kind)
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
        if (it->solution_id == entry.solution_id && it->node_id == entry.node_id
            && it->kind == entry.kind)
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

ValueReply ValueWorker::submit(const ValueRequest& request)
{
    std::lock_guard<std::mutex> lock(mu_);
    ValueReply reply;
    reply.job_id = request.job_id;
    if (stop_)
    {
        reply.ready = true;
        reply.ok = false;
        reply.body = error_body_ ? error_body_("value worker stopped", request) : std::string("value worker stopped");
        return reply;
    }
    ensure_started();
    const bool same_inflight = inflight_ && inflight_request_.solution_id == request.solution_id
        && inflight_request_.node_id == request.node_id && inflight_request_.kind == request.kind && !pending_;
    const bool same_pending = pending_ && pending_request_.solution_id == request.solution_id
        && pending_request_.node_id == request.node_id && pending_request_.kind == request.kind;
    // Idle cache hit: reuse a prior page without waking the worker.
    if (const CachedResult* cached = find_cached_unlocked(request);
        cached != nullptr && !pending_ && !inflight_)
    {
        reply.ready = true;
        reply.ok = cached->ok;
        reply.body = cached->body;
        reply.job_id = request.job_id;
        return reply;
    }
    if (same_inflight || same_pending)
    {
        reply.job_id = same_pending ? pending_request_.job_id : inflight_request_.job_id;
        return reply;
    }
    // Different request: queue it and cancel the in-flight walk. Other cached
    // nodes/kinds remain so Study can navigate without recomputing.
    ++serial_;
    pending_ = true;
    cancel_.store(true);
    pending_request_ = request;
    cv_.notify_one();
    return reply;
}

void ValueWorker::cancel()
{
    std::lock_guard<std::mutex> lock(mu_);
    cancel_.store(true);
    pending_ = false;
    ++serial_;
    clear_cache_unlocked();
}

void ValueWorker::cancel_and_drain()
{
    {
        std::lock_guard<std::mutex> lock(mu_);
        cancel_.store(true);
        pending_ = false;
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
        pending_ = false;
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
        std::uint64_t serial = 0;
        {
            std::unique_lock<std::mutex> lock(mu_);
            if (inflight_)
            {
                inflight_ = false;
                idle_.notify_all();
            }
            cv_.wait(lock, [&] { return stop_ || pending_; });
            if (stop_ && !pending_)
            {
                return;
            }
            if (!pending_)
            {
                continue;
            }
            request = pending_request_;
            serial = serial_;
            pending_ = false;
            cancel_.store(false);
            inflight_ = true;
            inflight_serial_ = serial;
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
            if (discard || serial_ != serial || pending_ || stop_)
            {
                continue;
            }
            store_cached_unlocked(CachedResult{
                request.solution_id,
                request.node_id,
                request.kind,
                ok,
                std::move(body),
            });
        }
    }
}

} // namespace poker::explorer
