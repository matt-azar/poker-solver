#pragma once

#include "poker/equity_calculator.hpp"

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace poker::explorer
{

enum class EquityJobState
{
    Queued,
    Preparing,
    Running,
    Stopping,
    Completed,
    Stopped,
    Cancelled,
    Failed
};

struct EquityJobRequest
{
    int version = 1;
    std::string client_revision;
    std::vector<poker::holdem::EquityCalcPlayerInput> players;
    std::vector<int> board;
    std::vector<int> dead_cards;
    poker::holdem::EquityCalcOptions options;
};

struct EquityJobSnapshot
{
    std::string id;
    EquityJobState state = EquityJobState::Queued;
    EquityJobRequest request;
    poker::holdem::EquityCalcResult result;
    std::string error;
    std::string error_kind;
    std::uint64_t progress_done = 0;
    std::uint64_t progress_total = 0;
    double elapsed_seconds = 0.0;
};

// One calculator worker. Independent of solve Session and ValueWorker.
class EquityJobManager
{
public:
    EquityJobManager();
    ~EquityJobManager();

    EquityJobManager(const EquityJobManager&) = delete;
    EquityJobManager& operator=(const EquityJobManager&) = delete;

    // Validates lightly and enqueues. Throws std::invalid_argument on bad input.
    // Returns job id. Rejects when the queue is saturated.
    std::string enqueue(EquityJobRequest request);

    std::optional<EquityJobSnapshot> status(const std::string& id) const;
    std::optional<EquityJobSnapshot> result(const std::string& id) const;
    bool cancel(const std::string& id);

    void shutdown();

private:
    void thread_main();
    void ensure_started_locked();
    void retain_locked(const std::string& id, EquityJobSnapshot snapshot);
    void prune_locked();

    mutable std::mutex mu_;
    std::condition_variable cv_;
    std::thread thread_;
    bool started_ = false;
    bool stop_ = false;
    std::uint64_t next_id_ = 1;
    std::vector<std::string> queue_;
    std::unordered_map<std::string, EquityJobSnapshot> jobs_;
    std::string current_id_;
    std::atomic<bool> cancel_current_{false};
};

std::string_view equity_job_state_name(EquityJobState state);

} // namespace poker::explorer
