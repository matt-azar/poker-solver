#include "harness.hpp"

#include "explorer/retained_training.hpp"
#include "explorer/session.hpp"
#include "poker/card.hpp"
#include "poker/range.hpp"
#include "solver/street_batch.hpp"

#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>

namespace
{

class Gate
{
public:
    void arrive_and_wait()
    {
        std::unique_lock<std::mutex> lock(mu_);
        ++arrived_;
        cv_.notify_all();
        cv_.wait(lock, [&]() { return open_; });
    }

    void wait_arrived()
    {
        std::unique_lock<std::mutex> lock(mu_);
        cv_.wait(lock, [&]() { return arrived_ >= 1; });
    }

    void release()
    {
        std::lock_guard<std::mutex> lock(mu_);
        open_ = true;
        cv_.notify_all();
    }

private:
    std::mutex mu_;
    std::condition_variable cv_;
    int arrived_ = 0;
    bool open_ = false;
};

struct Probe
{
    int* live = nullptr;

    explicit Probe(int* counter)
        : live(counter)
    {
        ++(*live);
    }

    ~Probe()
    {
        --(*live);
    }
};

std::uint64_t begin_job(poker::explorer::Session& session, std::shared_ptr<void>& retiring)
{
    return session.begin(retiring);
}

void finish_as_cancelled(poker::explorer::Session& session, std::uint64_t job)
{
    session.finish_cancelled(job, "{\"cancelled\":true,\"solution_id\":null}");
}

void test_stop_before_construct()
{
    poker::explorer::Session session;
    std::shared_ptr<void> retiring;
    const std::uint64_t job = begin_job(session, retiring);
    CHECK(session.request_stop(job) == poker::explorer::StopResult::Accepted);
    std::thread worker([&]()
    {
        session.wait_until_quiet();
        retiring.reset();
        session.notify_released();
        if (session.stop_requested(job))
        {
            finish_as_cancelled(session, job);
            return;
        }
        auto permit = session.prepare_success(job);
        CHECK(!permit.allowed);
    });
    worker.join();
    CHECK(session.phase() == poker::explorer::Phase::Cancelled);
    CHECK(!session.running());
    CHECK(!session.borrow(1));
}

void test_stop_during_chunk()
{
    poker::explorer::Session session;
    Gate chunk;
    std::shared_ptr<void> retiring;
    const std::uint64_t job = begin_job(session, retiring);
    bool published = false;
    std::thread worker([&]()
    {
        session.wait_until_quiet();
        retiring.reset();
        chunk.arrive_and_wait();
        if (session.stop_requested(job))
        {
            finish_as_cancelled(session, job);
            return;
        }
        auto permit = session.prepare_success(job);
        if (!permit.allowed)
        {
            finish_as_cancelled(session, job);
            return;
        }
        published = session.commit_success(
            job, std::make_shared<int>(1), permit.solution_id,
            [](std::uint64_t, bool) { return std::string("ok"); });
    });
    chunk.wait_arrived();
    CHECK(session.request_stop(job) == poker::explorer::StopResult::Accepted);
    chunk.release();
    worker.join();
    CHECK(!published);
    CHECK(session.phase() == poker::explorer::Phase::Cancelled);
    CHECK(!session.borrow(1));
}

void test_stop_before_publication()
{
    poker::explorer::Session session;
    Gate chunk;
    Gate before_publish;
    std::shared_ptr<void> retiring;
    const std::uint64_t job = begin_job(session, retiring);
    bool published = false;
    std::thread worker([&]()
    {
        session.wait_until_quiet();
        retiring.reset();
        chunk.arrive_and_wait();
        before_publish.arrive_and_wait();
        if (session.stop_requested(job))
        {
            finish_as_cancelled(session, job);
            return;
        }
        auto permit = session.prepare_success(job);
        if (!permit.allowed)
        {
            finish_as_cancelled(session, job);
            return;
        }
        published = session.commit_success(
            job, std::make_shared<int>(1), permit.solution_id,
            [](std::uint64_t, bool accepted) { return accepted ? std::string("ok") : std::string("no"); });
    });
    chunk.wait_arrived();
    chunk.release();
    before_publish.wait_arrived();
    CHECK(session.request_stop(job) == poker::explorer::StopResult::Accepted);
    before_publish.release();
    worker.join();
    CHECK(!published);
    CHECK(session.phase() == poker::explorer::Phase::Cancelled);
    CHECK(!session.borrow(1));
}

void test_commit_rejects_stop()
{
    poker::explorer::Session session;
    std::shared_ptr<void> retiring;
    const std::uint64_t job = begin_job(session, retiring);
    const auto permit = session.prepare_success(job);
    CHECK(permit.allowed);
    CHECK(session.request_stop(job) == poker::explorer::StopResult::Accepted);
    const bool published = session.commit_success(
        job, std::make_shared<int>(1), permit.solution_id,
        [](std::uint64_t, bool accepted) { return accepted ? std::string("ok") : std::string("no"); });
    CHECK(!published);
    CHECK(session.phase() == poker::explorer::Phase::Cancelled);
    CHECK(session.status().find("no") != std::string::npos);
    CHECK(!session.borrow(permit.solution_id));
}

void test_stop_after_complete()
{
    poker::explorer::Session session;
    std::shared_ptr<void> retiring;
    const std::uint64_t job = begin_job(session, retiring);
    const auto permit = session.prepare_success(job);
    const bool published = session.commit_success(
        job, std::make_shared<int>(4), permit.solution_id,
        [](std::uint64_t, bool) { return std::string("done"); });
    CHECK(published);
    CHECK(session.request_stop(job) == poker::explorer::StopResult::AlreadyComplete);
    CHECK(session.phase() == poker::explorer::Phase::Completed);
    CHECK(session.current_solution() == permit.solution_id);
    std::shared_ptr<void> borrowed = session.borrow(permit.solution_id);
    CHECK(borrowed != nullptr);
    session.release_reader();
}

void test_stale_stop_does_not_cancel_replacement()
{
    poker::explorer::Session session;
    std::shared_ptr<void> retiring;
    const std::uint64_t first = begin_job(session, retiring);
    const auto permit = session.prepare_success(first);
    CHECK(session.commit_success(
        first, std::make_shared<int>(1), permit.solution_id,
        [](std::uint64_t, bool) { return std::string("done"); }));
    const std::uint64_t second = begin_job(session, retiring);
    CHECK(session.request_stop(first) == poker::explorer::StopResult::Stale);
    CHECK(!session.stop_requested(second));
    CHECK(session.phase() == poker::explorer::Phase::Running);
    session.finish_cancelled(second, "cancelled");
}

void test_failure_is_terminal()
{
    poker::explorer::Session session;
    std::shared_ptr<void> retiring;
    const std::uint64_t job = begin_job(session, retiring);
    session.finish_failed(job, "{\"error\":\"construct\"}");
    CHECK(session.phase() == poker::explorer::Phase::Failed);
    CHECK(!session.running());
    CHECK(!session.borrow(1));
    const std::uint64_t next = begin_job(session, retiring);
    CHECK(next != job);
    CHECK(session.phase() == poker::explorer::Phase::Running);
    session.finish_failed(next, "{\"error\":\"launch\"}");
    CHECK(!session.running());
}

void test_throwing_publication_stays_running()
{
    poker::explorer::Session session;
    std::shared_ptr<void> retiring;
    const std::uint64_t job = begin_job(session, retiring);
    const auto permit = session.prepare_success(job);
    const std::uint64_t generation = session.generation();
    bool threw = false;
    try
    {
        session.commit_success(
            job, std::make_shared<int>(1), permit.solution_id,
            [](std::uint64_t, bool) -> std::string { throw std::runtime_error("make"); });
    }
    catch (const std::runtime_error&)
    {
        threw = true;
    }
    CHECK(threw);
    CHECK(session.phase() == poker::explorer::Phase::Running);
    CHECK(session.generation() == generation);
    CHECK(!session.borrow(permit.solution_id));
    session.finish_failed(job, "{\"error\":\"publish\"}");
    CHECK(session.phase() == poker::explorer::Phase::Failed);
    CHECK(session.status().find("publish") != std::string::npos);
    CHECK(!session.borrow(permit.solution_id));
}

void test_throwing_publication_on_cancel_stays_running()
{
    poker::explorer::Session session;
    std::shared_ptr<void> retiring;
    const std::uint64_t job = begin_job(session, retiring);
    const auto permit = session.prepare_success(job);
    CHECK(session.request_stop(job) == poker::explorer::StopResult::Accepted);
    const std::uint64_t generation = session.generation();
    bool threw = false;
    try
    {
        session.commit_success(
            job, std::make_shared<int>(1), permit.solution_id,
            [](std::uint64_t, bool accepted) -> std::string
            {
                if (!accepted)
                {
                    throw std::runtime_error("make");
                }
                return std::string("ok");
            });
    }
    catch (const std::runtime_error&)
    {
        threw = true;
    }
    CHECK(threw);
    CHECK(session.phase() == poker::explorer::Phase::Running);
    CHECK(session.generation() == generation);
    CHECK(!session.borrow(permit.solution_id));
    session.finish_failed(job, "{\"error\":\"publish\"}");
    CHECK(session.phase() == poker::explorer::Phase::Failed);
    CHECK(!session.running());
    CHECK(!session.borrow(permit.solution_id));
}

void test_publication_mismatch_stays_running_until_failed()
{
    poker::explorer::Session session;
    std::shared_ptr<void> retiring;
    const std::uint64_t job = begin_job(session, retiring);
    const auto permit = session.prepare_success(job);
    const bool published = session.commit_success(
        job, std::make_shared<int>(1), permit.solution_id + 1,
        [](std::uint64_t, bool) { return std::string("no"); });
    CHECK(!published);
    CHECK(session.phase() == poker::explorer::Phase::Running);
    session.finish_failed(job, "{\"error\":\"publish\"}");
    CHECK(session.phase() == poker::explorer::Phase::Failed);
    CHECK(!session.borrow(permit.solution_id));
}

void test_replacement_drops_old_engine_before_construct()
{
    poker::explorer::Session session;
    int live = 0;
    std::shared_ptr<void> retiring;
    const std::uint64_t first = begin_job(session, retiring);
    auto probe = std::make_shared<Probe>(&live);
    std::weak_ptr<Probe> weak = probe;
    const auto permit = session.prepare_success(first);
    CHECK(session.commit_success(
        first, probe, permit.solution_id,
        [](std::uint64_t, bool) { return std::string("done"); }));
    probe.reset();
    CHECK(live == 1);
    std::shared_ptr<void> borrowed = session.borrow(permit.solution_id);
    CHECK(borrowed != nullptr);
    const std::uint64_t second = begin_job(session, retiring);
    CHECK(!session.borrow(permit.solution_id));
    Gate released;
    bool saw_dead = false;
    session.set_release_hook([&]()
    {
        saw_dead = live == 0 && weak.expired();
        released.arrive_and_wait();
    });
    bool constructed = false;
    std::thread worker([&]()
    {
        session.wait_until_quiet();
        retiring.reset();
        session.notify_released();
        constructed = true;
    });
    borrowed.reset();
    session.release_reader();
    released.wait_arrived();
    const bool dead_before_construct = saw_dead && !constructed;
    released.release();
    worker.join();
    CHECK(dead_before_construct);
    CHECK(constructed);
    CHECK(session.phase() == poker::explorer::Phase::Running);
    session.finish_cancelled(second, "cancelled");
}

void test_node_identifiers_do_not_alias()
{
    poker::streets::StreetConfig config;
    config.board = {
        poker::holdem::parse_card("Kh"),
        poker::holdem::parse_card("Kd"),
        poker::holdem::parse_card("7c"),
        poker::holdem::parse_card("4s")
    };
    config.pot = 100;
    config.stack = 100;
    config.oop = poker::holdem::Range::parse("AhAd");
    config.ip = poker::holdem::Range::parse("2c3d");
    config.oop_bet_sizes = {};
    config.ip_bet_sizes = {};
    config.allow_all_in = false;
    config.max_raises = 0;
    config.memory_mib = 64;
    poker::solver::StreetBatchSolver solver(config);
    solver.run_frozen_iterations(1, poker::solver::Algorithm::CfrPlus);
    solver.prepare_inspection();
    const auto expect_unknown = [&](const std::string& id)
    {
        bool threw = false;
        try
        {
            solver.inspect_node(id);
        }
        catch (const std::invalid_argument& error)
        {
            threw = std::string(error.what()) == "unknown node";
        }
        CHECK(threw);
    };
    expect_unknown("p18446744073709551617.t-1.r-1");
    expect_unknown("p2147483648.t-1.r-1");
    expect_unknown("p-1.t-1.r-1");
    expect_unknown("p+1.t-1.r-1");
    expect_unknown("p0.t-1.r-1x");
    expect_unknown("p0.t-1.r");
    expect_unknown("p0.t-1.r-1 ");
    const poker::solver::StreetInspection canonical = solver.inspect_node("p0.t-1.r-1");
    const poker::solver::StreetInspection root = solver.inspect_node("p00.t-1.r-1");
    CHECK(root.kind == canonical.kind);
    CHECK(root.place == canonical.place);
    CHECK(root.line == canonical.line);
    CHECK(root.actions.size() == canonical.actions.size());
    CHECK(root.hands.size() == canonical.hands.size());
}

void test_continuation_keeps_the_same_solution()
{
    poker::explorer::Session session;
    std::shared_ptr<void> retiring;
    const std::uint64_t job = session.begin(retiring);
    const auto permit = session.prepare_success(job);
    CHECK(session.commit_success(
        job, std::make_shared<int>(7), permit.solution_id,
        [](std::uint64_t, bool) { return std::string("done"); }));
    std::shared_ptr<void> borrowed = session.borrow(permit.solution_id);
    CHECK(borrowed != nullptr);
    poker::explorer::Session::Claim claim;
    bool committed = false;
    std::thread trainer([&]() {
        // Claim must succeed while a reader still holds the engine so the HTTP
        // accept loop is never parked behind value queries.
        claim = session.claim_completed(permit.solution_id);
        if (claim.allowed)
        {
            session.wait_until_quiet();
            session.request_stop(claim.job_id);
            committed = session.commit_continuation(claim.job_id, [](std::uint64_t) { return std::string("kept"); });
        }
    });
    for (int attempt = 0;
         attempt < 2000 && session.phase() != poker::explorer::Phase::Running;
         ++attempt)
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    CHECK(session.phase() == poker::explorer::Phase::Running);
    CHECK(!session.borrow(permit.solution_id));
    session.release_reader();
    trainer.join();
    CHECK(claim.allowed);
    CHECK(committed);
    CHECK(session.phase() == poker::explorer::Phase::Completed);
    CHECK(session.current_solution() == permit.solution_id);
    CHECK(session.status() == "kept");
    std::shared_ptr<void> again = session.borrow(permit.solution_id);
    CHECK(again != nullptr);
    CHECK(*std::static_pointer_cast<int>(again) == 7);
    session.release_reader();
    CHECK(!session.claim_completed(permit.solution_id + 1).allowed);
    CHECK(session.phase() == poker::explorer::Phase::Completed);
    const auto second = session.claim_completed(permit.solution_id);
    CHECK(second.allowed);
    CHECK(!session.borrow(permit.solution_id));
    CHECK(!session.commit_continuation(second.job_id + 1, [](std::uint64_t) { return std::string("no"); }));
    CHECK(session.phase() == poker::explorer::Phase::Running);
    session.abort_continuation(second.job_id, "restored");
    CHECK(session.phase() == poker::explorer::Phase::Completed);
    CHECK(session.current_solution() == permit.solution_id);
    CHECK(session.borrow(permit.solution_id) != nullptr);
    session.release_reader();
}

void test_failed_continuation_keeps_engine_progress()
{
    poker::explorer::RetainedTraining retained;
    retained.job_id = 1;
    retained.iterations = 1;
    retained.value = 12.5;
    retained.nash_gap = 75.0;
    retained.sample_iterations.push_back(1);
    retained.sample_values.push_back(12.5);
    retained.sample_gaps.push_back(75.0);
    poker::explorer::TrainingSnapshot engine;
    engine.iterations = 6;
    engine.value = 24.9873241595;
    engine.p1_best_response = 10.0;
    engine.p2_best_response = 14.9873241595;
    engine.nash_gap = 24.9873241595;
    poker::explorer::remember_completed_training(retained, 4, 0.25, engine);
    CHECK(retained.iterations == 6);
    CHECK(retained.job_id == 4);
    CHECK(retained.runtime_seconds == 0.25);
    CHECK(retained.value == engine.value);
    CHECK(retained.sample_iterations.size() == 1);
    CHECK(retained.sample_iterations.back() == 1);
    poker::explorer::append_completed_sample(retained, engine);
    CHECK(retained.sample_iterations.size() == 2);
    CHECK(retained.sample_values.size() == 2);
    CHECK(retained.sample_gaps.size() == 2);
    CHECK(retained.sample_iterations.back() == 6);
    CHECK(retained.sample_values.back() == engine.value);
    CHECK(retained.sample_gaps.back() == engine.nash_gap);
    CHECK(retained.iterations + 1 == 7);
    poker::explorer::remember_completed_training(retained, 9, 1.0, engine);
    CHECK(retained.job_id == 4);
    CHECK(retained.runtime_seconds == 0.25);
    poker::explorer::append_completed_sample(retained, engine);
    CHECK(retained.sample_iterations.size() == 2);
}

} // namespace

void test_kept_stop_publishes_the_resource()
{
    poker::explorer::Session session;
    std::shared_ptr<void> retiring;
    const std::uint64_t job = session.begin(retiring);
    CHECK(session.request_stop(job) == poker::explorer::StopResult::Accepted);
    const poker::explorer::Session::Permit permit = session.prepare_kept(job);
    CHECK(permit.allowed);
    auto resource = std::make_shared<int>(7);
    const bool published = session.commit_kept(
        job,
        resource,
        permit.solution_id,
        [](std::uint64_t) { return std::string("{\"kept\":true}"); });
    CHECK(published);
    CHECK(session.phase() == poker::explorer::Phase::Completed);
    CHECK(session.current_solution() == permit.solution_id);
    {
        poker::explorer::ReaderLease lease(session, session.borrow(permit.solution_id));
        CHECK(static_cast<bool>(lease));
        CHECK(*std::static_pointer_cast<int>(lease.resource()) == 7);
    }
    std::uint64_t replaced = 0;
    CHECK(session.install_completed(
        std::make_shared<int>(3),
        replaced,
        [](std::uint64_t, std::uint64_t) { return std::string("{\"loaded\":true}"); }));
    CHECK(replaced != 0);
    CHECK(session.current_solution() == replaced);
    std::shared_ptr<void> retiring_again;
    const std::uint64_t running = session.begin(retiring_again);
    std::uint64_t ignored = 0;
    CHECK(!session.install_completed(
        std::make_shared<int>(1),
        ignored,
        [](std::uint64_t, std::uint64_t) { return std::string("{}"); }));
    session.finish_cancelled(running, "cancelled");
}

void run_session_tests()
{
    test_kept_stop_publishes_the_resource();
    test_stop_before_construct();
    test_stop_during_chunk();
    test_stop_before_publication();
    test_commit_rejects_stop();
    test_stop_after_complete();
    test_stale_stop_does_not_cancel_replacement();
    test_failure_is_terminal();
    test_throwing_publication_stays_running();
    test_throwing_publication_on_cancel_stays_running();
    test_publication_mismatch_stays_running_until_failed();
    test_replacement_drops_old_engine_before_construct();
    test_node_identifiers_do_not_alias();
    test_continuation_keeps_the_same_solution();
    test_failed_continuation_keeps_engine_progress();
}
