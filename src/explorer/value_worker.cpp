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
    const bool finished = has_result_ && result_solution_ == request.solution_id && result_node_ == request.node_id
        && result_kind_ == request.kind && !pending_ && !inflight_;
    const bool same_inflight = inflight_ && inflight_request_.solution_id == request.solution_id
        && inflight_request_.node_id == request.node_id && inflight_request_.kind == request.kind && !pending_;
    const bool same_pending = pending_ && pending_request_.solution_id == request.solution_id
        && pending_request_.node_id == request.node_id && pending_request_.kind == request.kind;
    if (finished)
    {
        reply.ready = true;
        reply.ok = result_ok_;
        reply.body = result_body_;
        reply.job_id = request.job_id;
        return reply;
    }
    if (same_inflight || same_pending)
    {
        reply.job_id = same_pending ? pending_request_.job_id : inflight_request_.job_id;
        return reply;
    }
    ++serial_;
    pending_ = true;
    cancel_.store(true);
    pending_request_ = request;
    has_result_ = false;
    cv_.notify_one();
    return reply;
}

void ValueWorker::cancel()
{
    std::lock_guard<std::mutex> lock(mu_);
    cancel_.store(true);
    pending_ = false;
    ++serial_;
    has_result_ = false;
}

void ValueWorker::cancel_and_drain()
{
    {
        std::lock_guard<std::mutex> lock(mu_);
        cancel_.store(true);
        pending_ = false;
        ++serial_;
        has_result_ = false;
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
        has_result_ = false;
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
            has_result_ = true;
            result_ok_ = ok;
            result_solution_ = request.solution_id;
            result_node_ = request.node_id;
            result_kind_ = request.kind;
            result_body_ = std::move(body);
        }
    }
}

} // namespace poker::explorer
