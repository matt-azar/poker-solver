#pragma once

#include "game/street_game.hpp"
#include "poker/hand_categories.hpp"
#include "solver/budget_resource.hpp"
#include "solver/trainer.hpp"
#include "solver/training_state.hpp"

#include <atomic>
#include <cstdint>
#include <memory_resource>
#include <mutex>
#include <span>
#include <stdexcept>
#include <string>
#include <vector>

namespace poker::solver
{

struct StreetStrategyEntry
{
    std::string infoset;
    std::string action;
    double probability = 0.0;
};

// One named piece of live engine allocation. Bytes are what the budget
// resource has requested from its upstream allocator and not yet released.
struct StreetMemoryComponent
{
    std::string name;
    std::uint64_t bytes = 0;
};

// Engine heap measured by the allocation resource. This is not process RSS.
// estimated_peak_bytes is a labeled plan, not the measured allocation.
// reserved_bytes is unused reservation credit. The rank cache is allocated
// before training, so that credit is zero after construction.
// regret_strategy_sum_bytes is only the regret array plus the strategy-sum array.
struct StreetMemoryReport
{
    std::uint64_t memory_budget_bytes = 0;
    std::uint64_t allocated_bytes = 0;
    std::uint64_t peak_allocated_bytes = 0;
    std::uint64_t reserved_bytes = 0;
    std::uint64_t regret_strategy_sum_bytes = 0;
    std::uint64_t estimated_peak_bytes = 0;
    std::uint64_t expanded_terminals = 0;
    std::uint64_t expanded_decisions = 0;
    std::uint64_t process_peak_working_set_bytes = 0;
    double construction_seconds = 0.0;
    // Rank values written before the first pass. Separate from construction.
    double cache_init_seconds = 0.0;
    // Persistent worker threads and their charged contexts. Thread stacks are
    // not included; those stay with the operating system.
    double worker_setup_seconds = 0.0;
    double train_seconds = 0.0;
    double evaluation_seconds = 0.0;
    int thread_count = 1;
    std::vector<StreetMemoryComponent> components;
};

// Cached order and the production worse/better masses for one hero.
// Endpoints are indexes in the opponent's rank order.
struct ShowdownSample
{
    std::vector<int> hero_card0;
    std::vector<int> hero_card1;
    std::vector<int> opponent_card0;
    std::vector<int> opponent_card1;
    std::vector<std::uint32_t> hero_rank;
    std::vector<std::uint32_t> opponent_rank;
    std::vector<int> order;
    std::vector<int> position;
    std::vector<int> worse_end;
    std::vector<int> better_begin;
    // Opponent card-list offsets (53) and rank-order indexes (two per opponent hand).
    std::vector<int> card_offset;
    std::vector<int> card_order;
    // Four cuts per hero hand: card A at L, card B at L, card A at U, card B at U.
    std::vector<int> card_cut;
    std::vector<double> worse_mass;
    std::vector<double> better_mass;
};

// Summed elapsed section durations from an enabled walk profile, not CPU time.
// Order time is nested inside showdown time. Adding the fields does not
// produce a wall-time total. Chance time is the caller's wait and reduction
// at the first public-card split. These are measurements, not part of the solve.
// One public node inside a finished street solve. Identifiers are opaque and
// valid only for this solver. A decision carries the acting player's hands.
// Chance carries the legal next cards. Marginal is the card-removal posterior.
// When reach_defined is false the joint mass is zero and marginals are unused.
struct StreetInspectAction
{
    std::string label;
    std::string child_id;
};

struct StreetInspectHand
{
    std::string combo;
    double reach = 0.0;
    double marginal = 0.0;
    bool structural = false;
    std::vector<double> strategy;
};

struct StreetInspectCard
{
    std::string card;
    std::string child_id;
    bool weight_defined = false;
    double weight = 0.0;
};

struct StreetInspection
{
    std::string node_id;
    std::string kind;
    std::string line;
    std::string place;
    std::vector<std::string> board;
    int player = -1;
    int folded = -1;
    bool reach_defined = false;
    double joint = 0.0;
    std::vector<StreetInspectAction> actions;
    std::vector<StreetInspectHand> hands;
    std::vector<StreetInspectCard> cards;
};

// The value query stopped because a newer query or a replacement solve asked it to.
class StreetValueCancelled : public std::runtime_error
{
public:
    StreetValueCancelled()
        : std::runtime_error("value query cancelled")
    {
    }
};

// Conditional action values for one decision, under the stored average profile.
// Chips are root-centered: the same terminal utility as the recorded solver EV.
// ev_defined is independent of reach_defined. A zero-reach hand can still have
// a counterfactual action value when some compatible opponent reach remains.
struct StreetActionValues
{
    std::string node_id;
    int player = -1;
    std::string units = "chips";
    std::string utility_basis = "root_centered";
    bool reach_defined = false;
    bool node_ev_defined = false;
    double node_ev = 0.0;
    std::uint64_t profile_epoch = 0;
    double query_seconds = 0.0;
    std::vector<std::string> actions;
    std::vector<std::string> combos;
    std::vector<char> ev_defined;
    // Hand-major. Entry hand * actions + action is Q_i(h, a). Meaningful when ev_defined.
    std::vector<double> action_ev;
    // V_i(h) = sum_a average_probability(h, a) * Q_i(h, a). Meaningful when ev_defined.
    std::vector<double> mixed_ev;
};

// One legal next card at a chance node, under the stored average profile.
// A zero card probability leaves the conditional EV undefined.
// OOP and IP chips are each player's own root-centered chips, so they sum to zero.
struct StreetRunoutCard
{
    std::string card;
    std::string child_id;
    bool probability_defined = false;
    double probability = 0.0;
    bool ev_defined = false;
    double oop_ev = 0.0;
    double ip_ev = 0.0;
};

struct StreetRunoutValues
{
    std::string node_id;
    std::string units = "chips";
    std::string utility_basis = "root_centered";
    bool parent_ev_defined = false;
    double parent_oop_ev = 0.0;
    double parent_ip_ev = 0.0;
    std::uint64_t profile_epoch = 0;
    double query_seconds = 0.0;
    std::vector<StreetRunoutCard> cards;
};

// Strategy-conditioned reaching weights at one node, before compatible-pair
// normalization. These are the inputs for check-down equity, not marginals.
struct StreetReachWeights
{
    std::string node_id;
    std::vector<int> board;
    std::string oop;
    std::string ip;
};

// Check-down equity at one node. A fraction of the pot, distinct from chip EV.
struct StreetNodeEquity
{
    std::string node_id;
    std::string units = "fraction of the pot";
    std::string model = "check-down";
    bool defined = false;
    double oop_equity = 0.0;
    double ip_equity = 0.0;
    double query_seconds = 0.0;
};

struct StreetWalkProfile
{
    double order_seconds = 0.0;
    double showdown_seconds = 0.0;
    double decision_seconds = 0.0;
    double chance_seconds = 0.0;
    // Caller-side freeze_sigma / floor_player / fused floor+freeze scans.
    double freeze_seconds = 0.0;
    // Finer train breakdown (optional; zero when unused).
    double fold_seconds = 0.0;
    double collect_seconds = 0.0;
    double expand_seconds = 0.0;
    double support_seconds = 0.0;
};

// Same pass contract as CfrTrainer<StreetGame>. Each pass freezes regret
// matching, sums that player's counterfactual regret, then CFR+ floors only
// that player. The sequential walk and the frozen combo walk both use this
// contract. StreetGame remains the reference. Construction and the workspace
// used by a pass stay inside StreetConfig::memory_mib. That budget is the
// bytes the engine requests from its allocator, not an operating-system limit.
// Scratch, action values, and showdown prefix buffers live in a WorkerContext.
// One context is the caller and the evaluator. Extra contexts exist only when
// the frozen pass uses more than one thread. Training and evaluation do not
// run at the same time. Threads above 1 split the first future public card
// and leave later cards on that worker. Native thread stacks are outside the
// budget. The budget is not touched from a worker.
// upstream observes those requests. A null upstream uses the global new/delete
// resource. Caller-owned inputs and returned strategy text stay outside it.
class StreetBatchSolver
{
public:
    explicit StreetBatchSolver(
        streets::StreetConfig config,
        std::pmr::memory_resource* upstream = nullptr);
    ~StreetBatchSolver();

    StreetBatchSolver(const StreetBatchSolver&) = delete;
    StreetBatchSolver& operator=(const StreetBatchSolver&) = delete;

    // Called after an accuracy check with the iterations completed so far.
    // The stats iteration count and runtime are not filled in yet.
    using SolveProgress = void (*)(int iterations, const SolveStats& stats, void* context);

    // Honors SolveConfig::locks: after regret matching, locked rows replace the
    // current strategy for matching public nodes (infoset_id == node index) and
    // SelectedCombos hand indices. Null locks keep today's unlocked path.
    SolveStats solve(
        const SolveConfig& config,
        Algorithm algorithm,
        SolveProgress progress = nullptr,
        void* progress_context = nullptr);
    // One public-tree pass per player. The strategy is frozen for the pass and
    // CFR+ floors only the player who just accumulated regret.
    // Same SolveConfig::locks contract as solve().
    SolveStats solve_frozen(
        const SolveConfig& config,
        Algorithm algorithm,
        SolveProgress progress = nullptr,
        void* progress_context = nullptr);
    // Write the rank cache before training. Later passes do not fill it again.
    void initialize_rank_cache();
    // Optional locks apply for this call only (saved/restored like solve()).
    // Null keeps the unlocked path bit-identical to the prior no-locks API.
    void run_iterations(int count, Algorithm algorithm, const LockSet* locks = nullptr);
    void continue_iterations(int count, Algorithm algorithm, const LockSet* locks = nullptr);
    void run_frozen_iterations(int count, Algorithm algorithm, const LockSet* locks = nullptr);
    void continue_frozen_iterations(int count, Algorithm algorithm, const LockSet* locks = nullptr);

    double expected_utility() const;
    double p1_best_response_utility() const;
    double p2_best_response_utility() const;
    double nash_gap() const;

    std::uint64_t infoset_count() const;
    std::uint64_t deal_count() const;
    int public_decisions() const;
    int public_terminals() const;
    // Expanded histories. These are not stored nodes.
    std::uint64_t decision_node_count() const;
    std::uint64_t terminal_count() const;
    int regret_entries() const;
    // Regret array plus strategy-sum array only.
    std::size_t memory_bytes_estimate() const;
    StreetMemoryReport memory_report() const;

    std::vector<StreetStrategyEntry> average_strategy_entries() const;
    // Normalize the average profile once. Later node queries only read it.
    void prepare_inspection() const;
    std::string root_node_id() const;
    StreetInspection inspect_node(const std::string& node_id) const;
    // One subtree evaluation. Forces each legal action at this decision, then
    // both players follow the average profile. Does not train or rewrite regrets.
    // cancel may be null. A true flag throws StreetValueCancelled.
    // The cached page is keyed by the canonical node and the profile epoch.
    // Training, reset, continuation, and an explicit average edit require
    // exclusive use of this solver. Those calls advance the epoch and drop the
    // page. A read that only rebuilds the average does not.
    StreetActionValues action_values(
        const std::string& node_id,
        const std::atomic<bool>* cancel = nullptr) const;
    // Every legal next card at a turn or river chance node.
    StreetRunoutValues runout_values(
        const std::string& node_id,
        const std::atomic<bool>* cancel = nullptr) const;
    StreetReachWeights reaching_weights(const std::string& node_id) const;
    // Made-hand category fractions from strategy-weighted reaches. Available
    // only when the node's board has five cards. Incomplete boards are omitted.
    holdem::CategoryComposition category_composition(const std::string& node_id) const;
    const streets::StreetConfig& config() const;
    TrainingTables training_tables() const;
    // Rebuilds nothing. The tree must already match the combo order and action counts.
    void install_training_tables(const TrainingTables& tables);
    std::uint64_t profile_epoch() const;
    // The next successful evaluation throws before its page can replace the cache.
    void arm_value_cache_failure_for_test();
    int completed_iterations() const;
    // Replace one structural hand's average at a node. Inspection reads this
    // profile instead of recomputing it.
    void set_average_for_test(
        const std::string& node_id,
        int hand,
        std::span<const double> probability);
    std::span<const double> regret_table() const;
    std::span<const double> strategy_sum_table() const;
    int thread_count() const;
    void enable_walk_profile(bool enabled);
    StreetWalkProfile walk_profile() const;
    // One CFR+ pass for one player. Descendants of the other player stay put.
    void run_single_frozen_pass_for_test(int updating);
    int indexed_hands_for_test(int player) const;
    // Production showdown masses for one hero, plus the cached order and the
    // opponent-order endpoints. opponent_amount is one weight per opponent hand.
    ShowdownSample sample_showdown_for_test(
        int hero,
        int turn,
        int river,
        std::span<const double> opponent_amount) const;
    void arm_worker_failure_for_test();
    void arm_card_delay_for_test(int microseconds);
    bool set_regret(const std::string& infoset, const std::string& action, double value);
    bool regret_value(const std::string& infoset, const std::string& action, double& value) const;

private:
    struct Engine;
    void note_profile_mutation();
    std::pmr::memory_resource* upstream_ = nullptr;
    BudgetResource budget_;
    void* engine_storage_ = nullptr;
    Engine* engine_ = nullptr;
    // One completed page. Queries share the evaluation scratch, so they take this lock.
    // The profile epoch lives here, outside the engine budget. It counts profile
    // mutations, not average rebuilds.
    mutable std::mutex value_mu_;
    mutable std::uint64_t profile_epoch_ = 0;
    mutable bool fail_cache_commit_ = false;
    mutable bool value_cache_valid_ = false;
    mutable std::string value_cache_node_;
    mutable std::uint64_t value_cache_epoch_ = 0;
    mutable StreetActionValues value_cache_{};
};
} // namespace poker::solver
