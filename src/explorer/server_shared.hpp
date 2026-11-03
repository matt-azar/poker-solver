#pragma once

#include "explorer/checkpoint.hpp"
#include "explorer/incentives_job.hpp"
#include "explorer/range_library.hpp"
#include "explorer/recent_files.hpp"
#include "explorer/retained_training.hpp"
#include "explorer/session.hpp"
#include "explorer/templates.hpp"
#include "explorer/value_worker.hpp"
#include "solver/incentives.hpp"
#include "game/chips.hpp"
#include "game/river_config_text.hpp"
#include "game/river_game.hpp"
#include "game/street_config_text.hpp"
#include "game/street_game.hpp"
#include "poker/equity.hpp"
#include "poker/card.hpp"
#include "poker/hand_categories.hpp"
#include "poker/range.hpp"
#include "solver/memory_plan.hpp"
#include "solver/node_lock.hpp"
#include "solver/river_batch.hpp"
#include "solver/strategy_edit.hpp"
#include "solver/street_batch.hpp"
#include "solver/tree_edit.hpp"

#include <atomic>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
using socket_t = SOCKET;
inline constexpr socket_t kInvalidSocket = INVALID_SOCKET;
inline void close_socket(socket_t socket) { closesocket(socket); }
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
using socket_t = int;
inline constexpr socket_t kInvalidSocket = -1;
inline void close_socket(socket_t socket) { ::close(socket); }
#endif

namespace explorer_detail
{

// Owned process-wide study server state (session, workers, static roots).
struct ExplorerAppContext
{
    std::thread worker;
    poker::explorer::ValueWorker* values = nullptr;
    poker::explorer::Session session;
    std::string ui_root = "legacy/ui";
    std::uint64_t equity_max_pair_runouts = poker::holdem::kDefaultMaxPairRunouts;
    std::filesystem::path templates_root;
    std::filesystem::path ranges_root;
};

extern ExplorerAppContext g_app;

struct Job
{
    std::vector<int> board;
    // pot / stack stored in tenths of a chip; JSON emits chip floats.
    int pot = poker::chip_units(100);
    int stack = poker::chip_units(200);
    poker::holdem::Range oop{};
    poker::holdem::Range ip{};
    std::vector<double> oop_bets{};
    std::vector<double> ip_bets{};
    std::vector<double> oop_raises{};
    std::vector<double> ip_raises{};
    std::vector<double> oop_flop_bets{};
    std::vector<double> oop_turn_bets{};
    std::vector<double> oop_river_bets{};
    std::vector<double> ip_flop_bets{};
    std::vector<double> ip_turn_bets{};
    std::vector<double> ip_river_bets{};
    std::vector<double> oop_donk{};
    std::vector<double> oop_raise_multiples{};
    std::vector<double> ip_raise_multiples{};
    double pot_cap = 0.0;
    bool allow_three_bet = true;
    bool allow_all_in = true;
    bool geometric = false;
    bool frozen = false;
    double all_in_threshold = 0.0;
    double accuracy = -1.0;
    double time_limit = -1.0;
    double rake_rate = 0.0;
    double rake_cap = 0.0;
    std::vector<double> icm_stacks{};
    std::vector<double> icm_payouts{};
    poker::solver::IncentiveConfig incentives{};
    int max_raises = 2;
    int iterations = 200;
    int samples = 5;
    int memory_mib = 1024;
    int threads = 1;
    poker::solver::Algorithm algorithm = poker::solver::Algorithm::CfrPlus;
    poker::solver::TreeEditSet tree_edits{};
};
struct HeldSolution
{
    std::uint64_t id = 0;
    std::uint64_t job_id = 0;
    // Prior unlocked (or earlier locked) revision kept queryable after resolve-locked.
    std::uint64_t baseline_solution_id = 0;
    std::shared_ptr<poker::solver::StreetBatchSolver> street;
    std::shared_ptr<poker::solver::RiverBatchSolver> river;
    std::string root_id;
    bool has_memory = false;
    poker::solver::StreetMemoryReport memory{};
    Job job;
    int iterations = 0;
    double runtime_seconds = 0.0;
    double value = 0.0;
    double p1_best_response = 0.0;
    double p2_best_response = 0.0;
    double nash_gap = 0.0;
    bool time_limit_reached = false;
    std::vector<int> sample_iterations;
    std::vector<double> sample_values;
    std::vector<double> sample_gaps;
    poker::solver::LockSet locks;
    // Session-scoped free-form average overlays. Not written to PSOL v2.
    poker::solver::StrategyEditSet strategy_edits;
};
struct HandLine
{
    std::string combo;
    std::string player;
    std::vector<std::pair<std::string, double>> actions;
};
struct StatusDraft
{
    bool running = false;
    bool paused = false;
    bool cancelled = false;
    bool time_limit_reached = false;
    std::string error;
    const Job* job = nullptr;
    int iterations = 0;
    bool has_runtime = false;
    double runtime_seconds = 0.0;
    bool has_value = false;
    double value = 0.0;
    bool has_br = false;
    double p1_best_response = 0.0;
    double p2_best_response = 0.0;
    bool has_gap = false;
    double nash_gap = 0.0;
    const std::vector<int>* sample_iterations = nullptr;
    const std::vector<double>* sample_values = nullptr;
    const std::vector<double>* sample_gaps = nullptr;
    std::uint64_t job_id = 0;
    std::uint64_t solution_id = 0;
    std::uint64_t baseline_solution_id = 0;
    std::uint64_t generation = 0;
    std::string root_id;
    const poker::solver::StreetMemoryReport* memory = nullptr;
    bool include_strategy = false;
    const std::vector<poker::solver::RiverStrategyEntry>* entries = nullptr;
};

bool parse_u64(std::string_view text, std::uint64_t& value);

poker::holdem::ShowdownEquityOptions equity_options(const std::atomic<bool>& cancel);

void append_escaped(std::string& out, const std::string& text);

std::string format_number(double value);

std::size_t find_key(const std::string& text, const char* key);

std::size_t value_at(const std::string& text, std::size_t key_at);

std::string read_string(const std::string& text, const char* key, const std::string& fallback);

double read_number(const std::string& text, const char* key, double fallback);

std::vector<double> read_number_array(const std::string& text, const char* key);

std::vector<std::string> read_string_array(const std::string& text, const char* key);

std::vector<double> optional_sizes(const std::string& text, const char* key);

Job parse_job(const std::string& text);

const char* spot_name(const Job& job);

const char* plays_name(const Job& job);

int rank_index(char rank);

std::string cell_name(int row, int column);

void append_optional(std::string& out, bool present, double value);

std::string build_status(const StatusDraft& draft);

poker::streets::StreetConfig street_config(const Job& job);

void append_tree_edits_json(std::string& out, const poker::solver::TreeEditSet& edits);

std::string memory_plan_json(const poker::solver::StreetMemoryPlan& plan);

std::string public_tree_json(
    const std::vector<poker::solver::StreetPublicNode>& nodes,
    const poker::solver::TreeEditSet& edits);

std::vector<poker::solver::RiverStrategyEntry> street_entries(
    const std::vector<poker::solver::StreetStrategyEntry>& source);

bool parse_prefixed_id(std::string_view text, char prefix, std::uint64_t& id);

const poker::solver::LockSet* locks_arg(const HeldSolution& held);

bool parse_public_node_index(std::string_view text, std::size_t& infoset_id);

std::string node_id_for_infoset(std::size_t infoset_id);

std::string json_locks(const poker::solver::LockSet& locks);

std::string json_strategy_edits(const poker::solver::StrategyEditSet& edits);

poker::solver::StreetInspection inspect_held_node(HeldSolution& held, const std::string& node_id);

void set_held_average_strategy(
    HeldSolution& held,
    const std::string& node_id,
    int hand,
    std::span<const double> probs);

void invalidate_held_average(HeldSolution& held);

void apply_strategy_edit_row(
    HeldSolution& held,
    const std::string& node_id,
    const poker::solver::StrategyEdit& edit,
    const poker::solver::StreetInspection& view);

void reapply_strategy_edits(HeldSolution& held);

void clear_strategy_edits(HeldSolution& held);

std::shared_ptr<HeldSolution> clone_held_baseline(const HeldSolution& source);

std::string json_inspection(
    const poker::solver::StreetInspection& view,
    const poker::solver::StreetMemoryReport& memory,
    std::uint64_t solution_id,
    std::uint64_t job_id);

std::string value_identity(
    std::uint64_t solution_id,
    std::uint64_t job_id,
    const std::string& node_id,
    std::uint64_t generation);

std::string json_value_pending(
    std::uint64_t solution_id,
    std::uint64_t job_id,
    const std::string& node_id,
    std::uint64_t generation);

std::string json_value_error(
    const std::string& message,
    std::uint64_t solution_id,
    std::uint64_t job_id,
    const std::string& node_id,
    std::uint64_t generation);

std::string json_action_values(
    const poker::solver::StreetActionValues& page,
    std::uint64_t solution_id,
    std::uint64_t job_id,
    std::uint64_t generation);

std::string json_runout_values(
    const poker::solver::StreetRunoutValues& page,
    std::uint64_t solution_id,
    std::uint64_t job_id,
    std::uint64_t generation);

void append_equity_distribution(
    std::string& out,
    const std::vector<poker::holdem::EquityDistributionBucket>& buckets);

std::string json_node_equity(
    const poker::solver::StreetNodeEquity& page,
    std::uint64_t solution_id,
    std::uint64_t job_id,
    std::uint64_t generation,
    const std::vector<poker::holdem::EquityDistributionBucket>& oop_distribution = {},
    const std::vector<poker::holdem::EquityDistributionBucket>& ip_distribution = {},
    const std::vector<poker::holdem::EquityHandRow>& oop_hands = {},
    const std::vector<poker::holdem::EquityHandRow>& ip_hands = {});

std::string json_categories(
    const poker::holdem::CategoryComposition& report,
    std::uint64_t solution_id,
    std::uint64_t job_id,
    const std::string& node_id,
    std::uint64_t generation,
    double query_seconds);

void respond_value_query(
    socket_t client,
    std::uint64_t solution_id,
    std::uint64_t job_id,
    const std::string& node_id,
    std::chrono::steady_clock::time_point started,
    const std::string& kind);

StatusDraft draft_for(
    const Job& job,
    std::uint64_t job_id,
    int done,
    double seconds,
    bool evaluated,
    double value,
    double p1,
    double p2,
    double gap,
    const std::vector<int>& sample_iterations,
    const std::vector<double>& sample_values,
    const std::vector<double>& sample_gaps,
    const poker::solver::StreetMemoryReport* memory);

void solve_job(std::uint64_t job_id, Job job);

poker::explorer::TrainingSnapshot completed_snapshot(
    const HeldSolution& held,
    int done,
    double value,
    double p1,
    double p2,
    double gap);

poker::explorer::RetainedTraining take_retained(HeldSolution& held);

void store_retained(HeldSolution& held, poker::explorer::RetainedTraining& retained);

void adopt_completed_training(
    HeldSolution& held,
    std::uint64_t job_id,
    double seconds,
    const poker::explorer::TrainingSnapshot& snapshot);

void continue_job(std::uint64_t job_id, int extra, double time_limit);

void resolve_locked_job(
    std::uint64_t job_id,
    int iterations,
    double accuracy,
    int samples,
    double time_limit,
    bool warm_start);

std::string read_file(const std::string& path);

std::string content_type(const std::string& path);

bool safe_static_asset_path(const std::string& path);

void send_response(
    socket_t client,
    int status,
    const std::string& type,
    const std::string& body,
    const std::string& extra_headers = {});

std::string receive_request(socket_t client);

std::uint8_t algorithm_code(poker::solver::Algorithm algorithm);

poker::solver::Algorithm algorithm_from_code(std::uint8_t code);

Job job_from_street(const poker::streets::StreetConfig& config);

Job job_from_river(const poker::river::RiverConfig& config);

poker::explorer::CheckpointDocument checkpoint_from_held(const HeldSolution& held);

std::shared_ptr<HeldSolution> solution_from_checkpoint(const poker::explorer::CheckpointDocument& document);

void append_size_array_json(std::string& out, const char* key, const std::vector<double>& sizes);

std::string solution_config_json(const HeldSolution& held);

std::string publish_loaded(const std::shared_ptr<HeldSolution>& held);

void handle_client(socket_t client);

std::string executable_directory();

void choose_ui_root();

int run(int argc, char** argv);

}  // namespace explorer_detail
