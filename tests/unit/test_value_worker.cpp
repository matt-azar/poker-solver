#include "harness.hpp"

#include "explorer/session.hpp"
#include "explorer/value_worker.hpp"

#include <atomic>
#include <chrono>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace
{

using poker::explorer::ReaderLease;
using poker::explorer::Session;
using poker::explorer::ValueReply;
using poker::explorer::ValueRequest;
using poker::explorer::ValueWorker;

std::uint64_t publish(Session& session, std::shared_ptr<void> resource)
{
    std::shared_ptr<void> retiring;
    const std::uint64_t job = session.begin(retiring);
    const auto permit = session.prepare_success(job);
    CHECK(permit.allowed);
    const bool committed = session.commit_success(
        job,
        std::move(resource),
        permit.solution_id,
        [](std::uint64_t, bool) { return std::string("ok"); });
    CHECK(committed);
    return permit.solution_id;
}

ValueReply wait_ready(ValueWorker& worker, const ValueRequest& request)
{
    ValueReply reply;
    for (int attempt = 0; attempt < 2000; ++attempt)
    {
        reply = worker.submit(request);
        if (reply.ready)
        {
            return reply;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    CHECK(reply.ready);
    return reply;
}

void test_idle_shutdown_joins()
{
    Session session;
    {
        ValueWorker worker(
            session,
            [](const std::shared_ptr<void>&, const ValueRequest&, const std::atomic<bool>&) {
                return std::string("ok");
            },
            [](const std::string& what, const ValueRequest&) { return what; });
        CHECK(!worker.live());
        worker.shutdown();
        CHECK(!worker.live());
        worker.shutdown();
        CHECK(!worker.live());
        CHECK(session.reader_count() == 0);
    }
    CHECK(session.reader_count() == 0);
}

void test_exception_then_success()
{
    Session session;
    const std::uint64_t solution = publish(session, std::make_shared<int>(1));
    int calls = 0;
    ValueWorker worker(
        session,
        [&](const std::shared_ptr<void>&, const ValueRequest& request, const std::atomic<bool>&) {
            ++calls;
            if (calls == 1)
            {
                throw std::runtime_error("boom");
            }
            return request.node_id;
        },
        [](const std::string& what, const ValueRequest&) { return what; });
    ValueRequest first;
    first.solution_id = solution;
    first.job_id = 1;
    first.node_id = "A";
    const ValueReply failed = wait_ready(worker, first);
    CHECK(!failed.ok);
    CHECK(failed.body == "boom");
    CHECK(session.reader_count() == 0);
    ValueRequest second = first;
    second.node_id = "B";
    const ValueReply ok = wait_ready(worker, second);
    CHECK(ok.ok);
    CHECK(ok.body == "B");
    CHECK(session.reader_count() == 0);
    worker.shutdown();
    worker.shutdown();
    CHECK(!worker.live());
}

void test_idle_cache_keeps_prior_nodes()
{
    Session session;
    const std::uint64_t solution = publish(session, std::make_shared<int>(1));
    int calls = 0;
    ValueWorker worker(
        session,
        [&](const std::shared_ptr<void>&, const ValueRequest& request, const std::atomic<bool>&) {
            ++calls;
            return request.kind + ":" + request.node_id;
        },
        [](const std::string& what, const ValueRequest&) { return what; });
    ValueRequest values_a;
    values_a.solution_id = solution;
    values_a.job_id = 1;
    values_a.node_id = "A";
    values_a.kind = "actions";
    CHECK(wait_ready(worker, values_a).body == "actions:A");
    ValueRequest equity_a = values_a;
    equity_a.kind = "equity";
    equity_a.job_id = 2;
    CHECK(wait_ready(worker, equity_a).body == "equity:A");
    ValueRequest values_b = values_a;
    values_b.node_id = "B";
    values_b.job_id = 3;
    CHECK(wait_ready(worker, values_b).body == "actions:B");
    const int after_three = calls;
    // Returning to A/values and A/equity must hit the LRU without re-evaluate.
    const ValueReply again_values = worker.submit(values_a);
    CHECK(again_values.ready);
    CHECK(again_values.ok);
    CHECK(again_values.body == "actions:A");
    const ValueReply again_equity = worker.submit(equity_a);
    CHECK(again_equity.ready);
    CHECK(again_equity.ok);
    CHECK(again_equity.body == "equity:A");
    CHECK(calls == after_three);
    worker.shutdown();
}

void test_newer_node_supersedes_paused_walk()
{
    Session session;
    const std::uint64_t solution = publish(session, std::make_shared<int>(1));
    std::atomic<bool> entered{false};
    ValueWorker worker(
        session,
        [&](const std::shared_ptr<void>&, const ValueRequest& request, const std::atomic<bool>& cancel) {
            if (request.node_id == "A")
            {
                entered.store(true);
                while (!cancel.load())
                {
                    std::this_thread::sleep_for(std::chrono::milliseconds(1));
                }
                throw std::runtime_error("cancelled");
            }
            return request.node_id;
        },
        [](const std::string& what, const ValueRequest&) { return what; });
    ValueRequest first;
    first.solution_id = solution;
    first.job_id = 1;
    first.node_id = "A";
    first.priority = poker::explorer::ValuePriority::Foreground;
    const ValueReply pending = worker.submit(first);
    CHECK(!pending.ready);
    for (int attempt = 0; attempt < 2000 && !entered.load(); ++attempt)
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    CHECK(entered.load());
    ValueRequest second = first;
    second.node_id = "B";
    second.job_id = 2;
    second.priority = poker::explorer::ValuePriority::Foreground;
    CHECK(!worker.submit(second).ready);
    const ValueReply ready = wait_ready(worker, second);
    CHECK(ready.ok);
    CHECK(ready.body == "B");
    entered.store(false);
    const ValueReply stale = worker.submit(first);
    CHECK(!stale.ready || stale.body != "A");
    for (int attempt = 0; attempt < 2000 && !entered.load(); ++attempt)
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    CHECK(entered.load());
    CHECK(session.reader_count() == 1);
    worker.shutdown();
    CHECK(!worker.live());
    CHECK(session.reader_count() == 0);
}

void test_replacement_destroys_engine_before_the_next_one()
{
    Session session;
    std::vector<const char*> events;
    struct Marker
    {
        std::vector<const char*>* events = nullptr;
        ~Marker()
        {
            events->push_back("destroyed");
        }
    };
    auto marker = std::make_shared<Marker>();
    marker->events = &events;
    const std::uint64_t solution = publish(session, marker);
    marker.reset();
    std::atomic<bool> entered{false};
    ValueWorker worker(
        session,
        [&](const std::shared_ptr<void>&, const ValueRequest&, const std::atomic<bool>& cancel) {
            entered.store(true);
            while (!cancel.load())
            {
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
            }
            throw std::runtime_error("cancelled");
            return std::string();
        },
        [](const std::string& what, const ValueRequest&) { return what; });
    ValueRequest request;
    request.solution_id = solution;
    request.job_id = 1;
    request.node_id = "root";
    CHECK(!worker.submit(request).ready);
    for (int attempt = 0; attempt < 2000 && !entered.load(); ++attempt)
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    CHECK(entered.load());
    std::shared_ptr<void> retiring;
    const std::uint64_t next_job = session.begin(retiring);
    CHECK(next_job != 0);
    std::thread replacement([&] {
        session.wait_until_quiet();
        retiring.reset();
        events.push_back("constructed");
    });
    worker.cancel();
    replacement.join();
    int destroyed_at = -1;
    int constructed_at = -1;
    for (int index = 0; index < static_cast<int>(events.size()); ++index)
    {
        if (std::string(events[static_cast<std::size_t>(index)]) == "destroyed")
        {
            destroyed_at = index;
        }
        if (std::string(events[static_cast<std::size_t>(index)]) == "constructed")
        {
            constructed_at = index;
        }
    }
    CHECK(destroyed_at >= 0);
    CHECK(constructed_at > destroyed_at);
    CHECK(session.reader_count() == 0);
    worker.shutdown();
    CHECK(!worker.live());
    CHECK(session.reader_count() == 0);
}

void test_shutdown_during_query_and_pending_work()
{
    Session session;
    const std::uint64_t solution = publish(session, std::make_shared<int>(1));
    std::atomic<bool> entered{false};
    ValueWorker worker(
        session,
        [&](const std::shared_ptr<void>&, const ValueRequest& request, const std::atomic<bool>& cancel) {
            entered.store(true);
            while (!cancel.load())
            {
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
            }
            if (request.node_id == "A")
            {
                throw std::runtime_error("cancelled");
            }
            return request.node_id;
        },
        [](const std::string& what, const ValueRequest&) { return what; });
    ValueRequest first;
    first.solution_id = solution;
    first.job_id = 1;
    first.node_id = "A";
    CHECK(!worker.submit(first).ready);
    for (int attempt = 0; attempt < 2000 && !entered.load(); ++attempt)
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    CHECK(entered.load());
    ValueRequest second = first;
    second.node_id = "B";
    CHECK(!worker.submit(second).ready);
    worker.shutdown();
    CHECK(!worker.live());
    CHECK(session.reader_count() == 0);
    worker.shutdown();
    CHECK(!worker.live());
    CHECK(session.reader_count() == 0);
}

void test_destructor_releases_readers_without_shutdown()
{
    Session session;
    const std::uint64_t solution = publish(session, std::make_shared<int>(1));
    std::atomic<bool> entered{false};
    {
        ValueWorker worker(
            session,
            [&](const std::shared_ptr<void>&, const ValueRequest&, const std::atomic<bool>& cancel) {
                entered.store(true);
                while (!cancel.load())
                {
                    std::this_thread::sleep_for(std::chrono::milliseconds(1));
                }
                throw std::runtime_error("cancelled");
                return std::string();
            },
            [](const std::string& what, const ValueRequest&) { return what; });
        ValueRequest request;
        request.solution_id = solution;
        request.job_id = 1;
        request.node_id = "A";
        CHECK(!worker.submit(request).ready);
        for (int attempt = 0; attempt < 2000 && !entered.load(); ++attempt)
        {
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        CHECK(entered.load());
        CHECK(session.reader_count() == 1);
    }
    CHECK(session.reader_count() == 0);
}

void test_cancel_and_drain_releases_reader()
{
    Session session;
    const std::uint64_t solution = publish(session, std::make_shared<int>(1));
    std::atomic<bool> entered{false};
    ValueWorker worker(
        session,
        [&](const std::shared_ptr<void>&, const ValueRequest&, const std::atomic<bool>& cancel) {
            entered.store(true);
            while (!cancel.load())
            {
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
            }
            throw std::runtime_error("cancelled");
            return std::string();
        },
        [](const std::string& what, const ValueRequest&) { return what; });
    ValueRequest request;
    request.solution_id = solution;
    request.job_id = 1;
    request.node_id = "root";
    CHECK(!worker.submit(request).ready);
    for (int attempt = 0; attempt < 2000 && !entered.load(); ++attempt)
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    CHECK(entered.load());
    CHECK(session.reader_count() == 1);
    worker.cancel_and_drain();
    CHECK(session.reader_count() == 0);
    worker.shutdown();
    CHECK(!worker.live());
}

void test_dual_metrics_run_once_with_safe_status_reads()
{
    Session session;
    const std::uint64_t solution = publish(session, std::make_shared<int>(1));
    std::atomic<int> action_calls{0};
    std::atomic<int> equity_calls{0};
    ValueWorker worker(
        session,
        [&](const std::shared_ptr<void>&, const ValueRequest& request, const std::atomic<bool>&) {
            if (request.kind == "actions")
            {
                ++action_calls;
                std::this_thread::sleep_for(std::chrono::milliseconds(20));
                return std::string("{\"pending\":false,\"kind\":\"actions\"}");
            }
            ++equity_calls;
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
            return std::string("{\"pending\":false,\"kind\":\"equity\"}");
        },
        [](const std::string& what, const ValueRequest&) { return what; });

    ValueRequest actions;
    actions.solution_id = solution;
    actions.job_id = 1;
    actions.node_id = "root";
    actions.kind = "actions";
    actions.priority = poker::explorer::ValuePriority::Foreground;
    ValueRequest equity = actions;
    equity.job_id = 2;
    equity.kind = "equity";

    CHECK(!worker.enqueue(actions).ready);
    CHECK(!worker.enqueue(equity).ready);
    // Interleaved status reads must not restart or replace either job.
    for (int attempt = 0; attempt < 50; ++attempt)
    {
        const ValueReply action_status = worker.lookup(actions);
        const ValueReply equity_status = worker.lookup(equity);
        CHECK(action_status.known || action_status.ready);
        CHECK(equity_status.known || equity_status.ready);
        if (action_status.ready && equity_status.ready)
        {
            CHECK(action_status.ok);
            CHECK(equity_status.ok);
            break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    const ValueReply action_ready = wait_ready(worker, actions);
    const ValueReply equity_ready = wait_ready(worker, equity);
    CHECK(action_ready.ok);
    CHECK(equity_ready.ok);
    CHECK(action_calls.load() == 1);
    CHECK(equity_calls.load() == 1);
    worker.shutdown();
}

void test_cache_hit_while_busy()
{
    Session session;
    const std::uint64_t solution = publish(session, std::make_shared<int>(1));
    std::atomic<int> calls{0};
    std::atomic<bool> hold_child{true};
    ValueWorker worker(
        session,
        [&](const std::shared_ptr<void>&, const ValueRequest& request, const std::atomic<bool>&) {
            ++calls;
            if (request.node_id == "child")
            {
                while (hold_child.load())
                {
                    std::this_thread::sleep_for(std::chrono::milliseconds(1));
                }
            }
            return request.kind + ":" + request.node_id;
        },
        [](const std::string& what, const ValueRequest&) { return what; });

    ValueRequest root_actions;
    root_actions.solution_id = solution;
    root_actions.job_id = 1;
    root_actions.node_id = "root";
    root_actions.kind = "actions";
    CHECK(wait_ready(worker, root_actions).body == "actions:root");
    const int after_root = calls.load();

    ValueRequest child = root_actions;
    child.node_id = "child";
    child.job_id = 2;
    child.priority = poker::explorer::ValuePriority::Prefetch;
    CHECK(!worker.enqueue(child).ready);
    for (int attempt = 0; attempt < 2000 && calls.load() == after_root; ++attempt)
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    CHECK(calls.load() > after_root);
    const ValueReply cached = worker.lookup(root_actions);
    CHECK(cached.ready);
    CHECK(cached.ok);
    CHECK(cached.body == "actions:root");
    CHECK(calls.load() == after_root + 1);
    hold_child.store(false);
    CHECK(wait_ready(worker, child).body == "actions:child");
    worker.shutdown();
}

void test_lookup_does_not_start_work()
{
    Session session;
    const std::uint64_t solution = publish(session, std::make_shared<int>(1));
    int calls = 0;
    ValueWorker worker(
        session,
        [&](const std::shared_ptr<void>&, const ValueRequest& request, const std::atomic<bool>&) {
            ++calls;
            return request.node_id;
        },
        [](const std::string& what, const ValueRequest&) { return what; });
    ValueRequest request;
    request.solution_id = solution;
    request.job_id = 1;
    request.node_id = "root";
    const ValueReply absent = worker.lookup(request);
    CHECK(!absent.ready);
    CHECK(!absent.known);
    CHECK(calls == 0);
    worker.shutdown();
}

} // namespace

void run_value_worker_tests()
{
    test_idle_shutdown_joins();
    test_exception_then_success();
    test_idle_cache_keeps_prior_nodes();
    test_newer_node_supersedes_paused_walk();
    test_replacement_destroys_engine_before_the_next_one();
    test_shutdown_during_query_and_pending_work();
    test_destructor_releases_readers_without_shutdown();
    test_cancel_and_drain_releases_reader();
    test_dual_metrics_run_once_with_safe_status_reads();
    test_cache_hit_while_busy();
    test_lookup_does_not_start_work();
}
