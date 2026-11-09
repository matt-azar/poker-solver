#pragma once

#include "explorer/session.hpp"

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

namespace poker::explorer
{

// Priority for Study scheduling. Foreground/Auto cancel obsolete work for other
// nodes; Prefetch is expendable and never preempts live selection work.
enum class ValuePriority : std::uint8_t
{
    Prefetch = 0,
    Auto = 1,
    Foreground = 2,
};

struct ValueRequest
{
    std::uint64_t solution_id = 0;
    std::uint64_t job_id = 0;
    // Profile revision captured at publish / strategy edit. Distinct revisions
    // under the same solution_id must not share cached pages.
    std::uint64_t profile_revision = 0;
    std::string node_id;
    // "actions", "runout", or "equity". Results for one kind do not satisfy another.
    std::string kind = "actions";
    ValuePriority priority = ValuePriority::Auto;
};

struct ValueReply
{
    bool ready = false;
    bool ok = false;
    // True when the identity is cached, queued, or running. False means lookup
    // found nothing and enqueue has not accepted the work yet.
    bool known = false;
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

// One background evaluator with a small multi-job queue.
//
// enqueue is idempotent: duplicate identities join queued / running / completed.
// lookup is passive: never starts or cancels work, and returns cached pages even
// while a different job runs. submit keeps the historical GET entry point by
// looking up first and enqueuing only when the identity is unknown.
//
// Foreground/Auto work for a selected node takes priority over prefetch. Cached
// pages are keyed by solution, profile revision, node, and kind.
class ValueWorker
{
public:
    static constexpr std::size_t kResultCacheCap = 48;
    static constexpr std::size_t kMaxPrefetchQueued = 8;

    ValueWorker(Session& session, ValueEvaluate evaluate, ValueErrorBody error_body);
    ~ValueWorker();

    ValueWorker(const ValueWorker&) = delete;
    ValueWorker& operator=(const ValueWorker&) = delete;

    // Idempotent start. Joins an existing queued/running/completed identity.
    ValueReply enqueue(const ValueRequest& request);
    // Passive status. Safe while another job runs; never replaces work.
    ValueReply lookup(const ValueRequest& request) const;
    // Compatibility: lookup, then enqueue when unknown.
    ValueReply submit(const ValueRequest& request);

    void cancel();
    // Soft-cancel then wait until the worker is not holding a session reader.
    // Use on the accept thread only when the evaluator honors cancel promptly.
    void cancel_and_drain();
    void shutdown();
    bool live() const;

private:
    struct CachedResult
    {
        std::uint64_t solution_id = 0;
        std::uint64_t profile_revision = 0;
        std::string node_id;
        std::string kind;
        bool ok = false;
        std::string body;
    };

    struct QueuedJob
    {
        ValueRequest request;
        std::uint64_t serial = 0;
    };

    static bool same_identity(const ValueRequest& left, const ValueRequest& right);
    static int kind_rank(const std::string& kind);
    static int priority_rank(ValuePriority priority);

    void thread_main();
    void ensure_started();
    const CachedResult* find_cached_unlocked(const ValueRequest& request) const;
    void store_cached_unlocked(CachedResult entry);
    void clear_cache_unlocked();
    std::deque<QueuedJob>::iterator find_queued_unlocked(const ValueRequest& request);
    void drop_obsolete_unlocked(const ValueRequest& incoming);
    void insert_queued_unlocked(ValueRequest request);
    ValueReply reply_from_cache_unlocked(const CachedResult& cached, std::uint64_t job_id) const;
    ValueReply pending_reply_unlocked(std::uint64_t job_id) const;

    Session& session_;
    ValueEvaluate evaluate_;
    ValueErrorBody error_body_;
    mutable std::mutex mu_;
    std::condition_variable cv_;
    std::condition_variable idle_;
    std::thread thread_;
    std::atomic<bool> cancel_{false};
    bool started_ = false;
    bool stop_ = false;
    bool inflight_ = false;
    std::uint64_t serial_ = 0;
    std::deque<QueuedJob> queue_;
    ValueRequest inflight_request_;
    std::uint64_t inflight_serial_ = 0;
    std::deque<CachedResult> result_cache_;
};

} // namespace poker::explorer
