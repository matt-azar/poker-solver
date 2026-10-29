#pragma once

#include "explorer/session.hpp"

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

namespace poker::explorer
{

struct ValueRequest
{
    std::uint64_t solution_id = 0;
    std::uint64_t job_id = 0;
    std::string node_id;
    // "actions", "runout", or "equity". Results for one kind do not satisfy another.
    std::string kind = "actions";
};

struct ValueReply
{
    bool ready = false;
    bool ok = false;
    std::uint64_t job_id = 0;
    std::string body;
};

// The evaluator may throw. A throw after cancellation, or after the solution
// has been replaced, is discarded. Any other exception becomes error_body.
// Cancellation is the caller's flag. This worker does not interrupt a terminal
// batch; the evaluator is expected to notice the flag at public-node boundaries.
using ValueEvaluate = std::function<std::string(
    const std::shared_ptr<void>& resource,
    const ValueRequest& request,
    const std::atomic<bool>& cancel)>;

using ValueErrorBody = std::function<std::string(const std::string& what, const ValueRequest& request)>;

// One background query. shutdown is idempotent, joins outside the queue lock,
// and runs before the Session it borrows from is destroyed.
class ValueWorker
{
public:
    ValueWorker(Session& session, ValueEvaluate evaluate, ValueErrorBody error_body);
    ~ValueWorker();

    ValueWorker(const ValueWorker&) = delete;
    ValueWorker& operator=(const ValueWorker&) = delete;

    ValueReply submit(const ValueRequest& request);
    void cancel();
    void shutdown();
    bool live() const;

private:
    void thread_main();
    void ensure_started();

    Session& session_;
    ValueEvaluate evaluate_;
    ValueErrorBody error_body_;
    mutable std::mutex mu_;
    std::condition_variable cv_;
    std::thread thread_;
    std::atomic<bool> cancel_{false};
    bool started_ = false;
    bool stop_ = false;
    bool pending_ = false;
    bool inflight_ = false;
    bool has_result_ = false;
    bool result_ok_ = false;
    std::uint64_t serial_ = 0;
    ValueRequest pending_request_;
    ValueRequest inflight_request_;
    std::uint64_t inflight_serial_ = 0;
    std::uint64_t result_solution_ = 0;
    std::string result_node_;
    std::string result_kind_;
    std::string result_body_;
};

} // namespace poker::explorer
