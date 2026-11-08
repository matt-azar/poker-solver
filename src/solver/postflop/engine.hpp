#pragma once

// Private StreetBatchSolver::Engine declaration. Not part of the public API.
// Method definitions live in src/solver/postflop/*.cpp. Algorithm schedules
// (train_frozen_* / train_more_*) are defined out-of-line in
// postflop/algorithms/*.hpp and must be #included from exactly one TU after
// this complete class declaration.

#include "solver/street_batch.hpp"
#include "../street_batch_helpers.hpp"

#include "game/chips.hpp"
#include "game/street_config_text.hpp"
#include "solver/strategy_edit.hpp"
#include "solver/tree_edit.hpp"
#include "poker/card.hpp"
#include "poker/hand_categories.hpp"
#include "poker/hand_eval.hpp"
#include "poker/range.hpp"
#include "solver/chip_payoff.hpp"
#include "solver/dcfr.hpp"
#include "solver/icm.hpp"
#include "solver/incentives.hpp"
#include "solver/regret_matching.hpp"
#include "solver/table_scalar.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <charconv>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <exception>
#include <limits>
#include <memory_resource>
#include <mutex>
#include <new>
#include <numeric>
#include <span>
#include <stdexcept>
#include <system_error>
#include <string>
#include <string_view>
#include <thread>
#include <tuple>
#include <unordered_map>
#include <utility>
#include <vector>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <psapi.h>
#endif

namespace poker::solver
{
using namespace street_batch_detail;

struct StreetBatchSolver::Engine
{
    struct Deal
    {
        int h0 = 0;
        int h1 = 0;
        int combo0 = 0;
        int combo1 = 0;
        int c0 = 0;
        int c1 = 0;
        int d0 = 0;
        int d1 = 0;
        double probability = 0.0;
    };


#define POKER_NODE_STRINGS(alloc)                                                              \
    std::pmr::string(alloc), std::pmr::string(alloc), std::pmr::string(alloc), std::pmr::string(alloc), \
    std::pmr::string(alloc), std::pmr::string(alloc), std::pmr::string(alloc), std::pmr::string(alloc)


#define POKER_NODE_COPY_STRINGS(other, alloc)                     \
    std::pmr::string((other).action_labels[0], alloc),           \
        std::pmr::string((other).action_labels[1], alloc),       \
        std::pmr::string((other).action_labels[2], alloc),       \
        std::pmr::string((other).action_labels[3], alloc),       \
        std::pmr::string((other).action_labels[4], alloc),       \
        std::pmr::string((other).action_labels[5], alloc),       \
        std::pmr::string((other).action_labels[6], alloc),       \
        std::pmr::string((other).action_labels[7], alloc)


#define POKER_NODE_MOVE_STRINGS(other, alloc)                              \
    std::pmr::string(std::move((other).action_labels[0]), alloc),         \
        std::pmr::string(std::move((other).action_labels[1]), alloc),     \
        std::pmr::string(std::move((other).action_labels[2]), alloc),     \
        std::pmr::string(std::move((other).action_labels[3]), alloc),     \
        std::pmr::string(std::move((other).action_labels[4]), alloc),     \
        std::pmr::string(std::move((other).action_labels[5]), alloc),     \
        std::pmr::string(std::move((other).action_labels[6]), alloc),     \
        std::pmr::string(std::move((other).action_labels[7]), alloc)


    struct Node
    {
        using allocator_type = std::pmr::polymorphic_allocator<std::byte>;

        bool terminal = false;
        bool chance = false;
        int deal_which = 0;
        int player = -1;
        int street = 0;
        int depth = 0;
        int card_mode = 0;
        bool mode1_is_turn = false;
        int hands = 0;
        int folded = -1;
        int contrib[2] = {};
        int n_actions = 0;
        int child[8] = {};
        // Path-attributed incentive deltas per seat (0 when incentives empty).
        double incentive_u0 = 0.0;
        double incentive_u1 = 0.0;
        std::pmr::vector<int> slot_of;
        std::pmr::string path;
        std::pmr::string action_labels[8];

        template <typename Alloc>
        Node(std::allocator_arg_t, const Alloc& alloc)
            : slot_of(alloc)
            , path(alloc)
            , action_labels{POKER_NODE_STRINGS(alloc)}
        {
        }

        template <typename Alloc>
        Node(std::allocator_arg_t, const Alloc& alloc, const Node& other)
            : slot_of(other.slot_of, alloc)
            , path(other.path, alloc)
            , action_labels{POKER_NODE_COPY_STRINGS(other, alloc)}
        {
            copy_scalars_from(other);
        }

        template <typename Alloc>
        Node(std::allocator_arg_t, const Alloc& alloc, Node&& other)
            : slot_of(std::move(other.slot_of), alloc)
            , path(std::move(other.path), alloc)
            , action_labels{POKER_NODE_MOVE_STRINGS(other, alloc)}
        {
            copy_scalars_from(other);
        }

        void copy_scalars_from(const Node& other)
        {
            terminal = other.terminal;
            chance = other.chance;
            deal_which = other.deal_which;
            player = other.player;
            street = other.street;
            depth = other.depth;
            card_mode = other.card_mode;
            mode1_is_turn = other.mode1_is_turn;
            hands = other.hands;
            folded = other.folded;
            contrib[0] = other.contrib[0];
            contrib[1] = other.contrib[1];
            n_actions = other.n_actions;
            incentive_u0 = other.incentive_u0;
            incentive_u1 = other.incentive_u1;
            for (int index = 0; index < 8; ++index)
            {
                child[index] = other.child[index];
            }
        }
    };


#undef POKER_NODE_STRINGS

#undef POKER_NODE_COPY_STRINGS

#undef POKER_NODE_MOVE_STRINGS


    // Compact identity for one multi-action information set. Action count lives
    // on the public Node. One-action decisions are implicit (probability 1) and
    // do not allocate a Slot or regret/strategy row.
    struct Slot
    {
        int node = 0;
        int base = 0;
        std::uint16_t hand = 0;
        std::int8_t turn = -1;
        std::int8_t river = -1;
    };

    static_assert(sizeof(Slot) == 12, "Slot packing");


    // Immutable showdown facts for one runout. Order is rank, then hand index,
    // over every indexed hand, including zero reach and hands blocked by the
    // board. L and U are indexes in the opponent's order. Card lists name
    // positions in that same order. Workers only read this.
    struct RunoutRanks
    {
        using allocator_type = std::pmr::polymorphic_allocator<std::byte>;
        std::pmr::vector<std::uint32_t> rank[2];
        std::pmr::vector<std::uint16_t> order[2];
        std::pmr::vector<std::uint16_t> pos[2];
        std::pmr::vector<std::uint16_t> worse_end[2];
        std::pmr::vector<std::uint16_t> better_begin[2];
        // Four opponent-list cuts per hero hand: a at L, b at L, a at U, b at U.
        std::pmr::vector<std::uint16_t> card_cut[2];
        std::pmr::vector<std::uint16_t> card_pos[2];
        std::pmr::vector<std::uint32_t> card_off[2];

        template <typename Alloc>
        RunoutRanks(std::allocator_arg_t, const Alloc& alloc)
            : rank{std::pmr::vector<std::uint32_t>(alloc), std::pmr::vector<std::uint32_t>(alloc)}
            , order{std::pmr::vector<std::uint16_t>(alloc), std::pmr::vector<std::uint16_t>(alloc)}
            , pos{std::pmr::vector<std::uint16_t>(alloc), std::pmr::vector<std::uint16_t>(alloc)}
            , worse_end{std::pmr::vector<std::uint16_t>(alloc), std::pmr::vector<std::uint16_t>(alloc)}
            , better_begin{std::pmr::vector<std::uint16_t>(alloc), std::pmr::vector<std::uint16_t>(alloc)}
            , card_cut{std::pmr::vector<std::uint16_t>(alloc), std::pmr::vector<std::uint16_t>(alloc)}
            , card_pos{std::pmr::vector<std::uint16_t>(alloc), std::pmr::vector<std::uint16_t>(alloc)}
            , card_off{std::pmr::vector<std::uint32_t>(alloc), std::pmr::vector<std::uint32_t>(alloc)}
        {
        }

        template <typename Alloc>
        RunoutRanks(std::allocator_arg_t, const Alloc& alloc, const RunoutRanks& other)
            : rank{std::pmr::vector<std::uint32_t>(other.rank[0], alloc),
                std::pmr::vector<std::uint32_t>(other.rank[1], alloc)}
            , order{std::pmr::vector<std::uint16_t>(other.order[0], alloc),
                std::pmr::vector<std::uint16_t>(other.order[1], alloc)}
            , pos{std::pmr::vector<std::uint16_t>(other.pos[0], alloc),
                std::pmr::vector<std::uint16_t>(other.pos[1], alloc)}
            , worse_end{std::pmr::vector<std::uint16_t>(other.worse_end[0], alloc),
                std::pmr::vector<std::uint16_t>(other.worse_end[1], alloc)}
            , better_begin{std::pmr::vector<std::uint16_t>(other.better_begin[0], alloc),
                std::pmr::vector<std::uint16_t>(other.better_begin[1], alloc)}
            , card_cut{std::pmr::vector<std::uint16_t>(other.card_cut[0], alloc),
                std::pmr::vector<std::uint16_t>(other.card_cut[1], alloc)}
            , card_pos{std::pmr::vector<std::uint16_t>(other.card_pos[0], alloc),
                std::pmr::vector<std::uint16_t>(other.card_pos[1], alloc)}
            , card_off{std::pmr::vector<std::uint32_t>(other.card_off[0], alloc),
                std::pmr::vector<std::uint32_t>(other.card_off[1], alloc)}
        {
        }

        template <typename Alloc>
        RunoutRanks(std::allocator_arg_t, const Alloc& alloc, RunoutRanks&& other)
            : rank{std::pmr::vector<std::uint32_t>(std::move(other.rank[0]), alloc),
                std::pmr::vector<std::uint32_t>(std::move(other.rank[1]), alloc)}
            , order{std::pmr::vector<std::uint16_t>(std::move(other.order[0]), alloc),
                std::pmr::vector<std::uint16_t>(std::move(other.order[1]), alloc)}
            , pos{std::pmr::vector<std::uint16_t>(std::move(other.pos[0]), alloc),
                std::pmr::vector<std::uint16_t>(std::move(other.pos[1]), alloc)}
            , worse_end{std::pmr::vector<std::uint16_t>(std::move(other.worse_end[0]), alloc),
                std::pmr::vector<std::uint16_t>(std::move(other.worse_end[1]), alloc)}
            , better_begin{std::pmr::vector<std::uint16_t>(std::move(other.better_begin[0]), alloc),
                std::pmr::vector<std::uint16_t>(std::move(other.better_begin[1]), alloc)}
            , card_cut{std::pmr::vector<std::uint16_t>(std::move(other.card_cut[0]), alloc),
                std::pmr::vector<std::uint16_t>(std::move(other.card_cut[1]), alloc)}
            , card_pos{std::pmr::vector<std::uint16_t>(std::move(other.card_pos[0]), alloc),
                std::pmr::vector<std::uint16_t>(std::move(other.card_pos[1]), alloc)}
            , card_off{std::pmr::vector<std::uint32_t>(std::move(other.card_off[0]), alloc),
                std::pmr::vector<std::uint32_t>(std::move(other.card_off[1]), alloc)}
        {
        }
    };


    struct Support
    {
        int compatible = 0;
        int contain[52] = {};
    };


    struct Scratch
    {
        using allocator_type = std::pmr::polymorphic_allocator<std::byte>;
        std::pmr::vector<double> ev0;
        std::pmr::vector<double> ev1;
        std::pmr::vector<double> pi0;
        std::pmr::vector<double> pi1;
        std::pmr::vector<double> aev0;
        std::pmr::vector<double> aev1;
        // Acting-player infoset bases for this decision depth only.
        std::pmr::vector<int> slot_base;

        template <typename Alloc>
        Scratch(std::allocator_arg_t, const Alloc& alloc)
            : ev0(alloc)
            , ev1(alloc)
            , pi0(alloc)
            , pi1(alloc)
            , aev0(alloc)
            , aev1(alloc)
            , slot_base(alloc)
        {
        }

        template <typename Alloc>
        Scratch(std::allocator_arg_t, const Alloc& alloc, const Scratch& other)
            : ev0(other.ev0, alloc)
            , ev1(other.ev1, alloc)
            , pi0(other.pi0, alloc)
            , pi1(other.pi1, alloc)
            , aev0(other.aev0, alloc)
            , aev1(other.aev1, alloc)
            , slot_base(other.slot_base, alloc)
        {
        }

        template <typename Alloc>
        Scratch(std::allocator_arg_t, const Alloc& alloc, Scratch&& other)
            : ev0(std::move(other.ev0), alloc)
            , ev1(std::move(other.ev1), alloc)
            , pi0(std::move(other.pi0), alloc)
            , pi1(std::move(other.pi1), alloc)
            , aev0(std::move(other.aev0), alloc)
            , aev1(std::move(other.aev1), alloc)
            , slot_base(std::move(other.slot_base), alloc)
        {
        }
    };


    // Mutable buffers for one traversal. The public tree, slot map, ranges,
    // and the frozen strategy snapshot stay outside this object and are read
    // only during a pass. Evaluation keeps its own context. A pass does not
    // call evaluation, so the two never run together on one solver.
    struct WorkerContext
    {
        using allocator_type = std::pmr::polymorphic_allocator<std::byte>;
        std::pmr::vector<Scratch> scratch;
        std::pmr::vector<double> amount_buf[2];
        std::pmr::vector<double> prefix_buf;
        // Compact card prefixes: one initial zero per card, then one weight per hole card.
        std::pmr::vector<double> block_buf;
        // Opponent amounts in rank order for one showdown prefix build.
        std::pmr::vector<double> ordered_buf;
        // card_off[c] + c bases for the opponent side of the current order_reach.
        std::uint32_t block_base[52] = {};
        // Structural support for the current (turn, river); filled by ensure_board_support.
        std::pmr::vector<char> live0;
        std::pmr::vector<char> live1;
        int support_turn = -2;
        int support_river = -2;
        double order_seconds = 0.0;
        double showdown_seconds = 0.0;
        double decision_seconds = 0.0;
        double chance_seconds = 0.0;
        double fold_seconds = 0.0;
        double collect_seconds = 0.0;
        double expand_seconds = 0.0;
        double support_seconds = 0.0;

        explicit WorkerContext(std::pmr::memory_resource* heap)
            : WorkerContext(std::allocator_arg, allocator_type(heap))
        {
        }

        WorkerContext(std::allocator_arg_t, const allocator_type& alloc)
            : scratch(alloc)
            , amount_buf{std::pmr::vector<double>(alloc), std::pmr::vector<double>(alloc)}
            , prefix_buf(alloc)
            , block_buf(alloc)
            , ordered_buf(alloc)
            , live0(alloc)
            , live1(alloc)
        {
        }
    };


    streets::StreetConfig config;

    BudgetResource* budget_ = nullptr;

    std::pmr::memory_resource* heap_ = nullptr;

    std::pmr::vector<int> combos[2];

    struct ParentLink
    {
        int parent = -1;
        int action = -1;
        bool from_chance = false;
    };


    std::pmr::vector<Deal> deals;

    std::pmr::vector<Node> nodes;

    std::pmr::vector<ParentLink> parent_link;

    std::pmr::vector<Slot> slots;

    // Side indexes into `slots` by acting player. Built in add_slot. Floor /
    // discount / PCFR commit scan these instead of skipping interleaved
    // opponent rows; freeze and fused floor+freeze still walk all slots.
    std::pmr::vector<std::uint32_t> player_slots_[2];

    std::pmr::vector<int> decision_ids;

    std::pmr::vector<TableScalar> regret;

    std::pmr::vector<TableScalar> strategy_sum;

    // Shared workspace: frozen strategy during a training pass; normalized
    // sigma during evaluation / browse. Training sets average_ready false
    // before overwriting; ensure_average rebuilds from strategy_sum.
    mutable std::pmr::vector<TableScalar> sigma;

    mutable std::pmr::vector<int> response;

    std::pmr::vector<char> combo_blocked;

    std::pmr::vector<int> combo_low;

    std::pmr::vector<int> combo_high;

    std::pmr::vector<int> combo_to_hand[2];

    std::pmr::vector<double> range_w[2];

    std::pmr::vector<int> hole_a[2];

    std::pmr::vector<int> hole_b[2];

    std::pmr::vector<int> hand_of[2];

    // Same hole cards on the opposite side, or -1 when that combo is absent.
    std::pmr::vector<int> twin_hand[2];

    mutable std::pmr::unordered_map<int, RunoutRanks> runout_ranks;

    // Structural hand_supported masks per walkable (turn, river), including
    // partial boards. Filled once; ensure_board_support only copies them.
    struct BoardSupport
    {
        using allocator_type = std::pmr::polymorphic_allocator<std::byte>;
        std::pmr::vector<char> live0;
        std::pmr::vector<char> live1;
        // Supported hand indexes for terminal loops (same liveness as live0/live1).
        std::pmr::vector<std::uint16_t> idx0;
        std::pmr::vector<std::uint16_t> idx1;

        template <typename Alloc>
        BoardSupport(std::allocator_arg_t, const Alloc& alloc)
            : live0(alloc)
            , live1(alloc)
            , idx0(alloc)
            , idx1(alloc)
        {
        }

        template <typename Alloc>
        BoardSupport(std::allocator_arg_t, const Alloc& alloc, const BoardSupport& other)
            : live0(other.live0, alloc)
            , live1(other.live1, alloc)
            , idx0(other.idx0, alloc)
            , idx1(other.idx1, alloc)
        {
        }

        template <typename Alloc>
        BoardSupport(std::allocator_arg_t, const Alloc& alloc, BoardSupport&& other)
            : live0(std::move(other.live0), alloc)
            , live1(std::move(other.live1), alloc)
            , idx0(std::move(other.idx0), alloc)
            , idx1(std::move(other.idx1), alloc)
        {
        }
    };

    mutable std::pmr::unordered_map<int, BoardSupport> board_support_;

    mutable WorkerContext workspace;

    std::pmr::vector<std::uint64_t> mask[2];

    std::pmr::vector<Support> support[2];

    // PCFR+: last instantaneous CF regret per action slot (prediction m). Empty
    // until the first PCFR+ train allocates it. Cold-starts at zeros; PSOL v3
    // may restore this table for exact continuation.
    std::pmr::vector<TableScalar> prediction_;

    bool pcfr_collect_ = false;

    mutable bool average_ready = false;

    mutable bool ranks_ready_ = false;

    mutable bool support_ready_ = false;

    mutable double cache_init_seconds_ = 0.0;

    double worker_setup_seconds_ = 0.0;

    mutable bool failed_ = false;

    bool profile_ = false;

    static constexpr int kMaxThreads = 64;

    WorkerContext* extra_contexts_[kMaxThreads] = {};

    int extra_count_ = 0;

    // Card-result and task fields are mutable so const BR/NashConv eval can
    // reuse the same worker pool as train (disjoint per-card writes).
    mutable std::pmr::vector<double> result0_;

    mutable std::pmr::vector<double> result1_;

    mutable int active_cards_[52] = {};

    mutable int active_count_ = 0;

    // Dynamic claim cursor for Chance/Response first-card tasks. Workers race
    // fetch_add until index >= active_count_; static chunk ranges only gate
    // whether a worker enters the steal loop (all workers get [0, active]).
    mutable std::atomic<int> next_active_{0};

    mutable int chunk_begin_[kMaxThreads] = {};

    mutable int chunk_end_[kMaxThreads] = {};

    mutable int task_node_ = 0;

    mutable int task_turn_ = -1;

    mutable int task_river_ = -1;

    mutable int task_depth_ = 0;

    mutable int task_updating_ = -1;

    mutable int task_responding_ = -1;

    mutable int task_deal_ = 0;

    mutable double task_weight_ = 1.0;

    mutable const double* task_pi0_ = nullptr;

    mutable const double* task_pi1_ = nullptr;

    std::thread workers_[kMaxThreads];

    int worker_count_ = 0;

    mutable std::mutex pool_mutex_;

    mutable std::condition_variable work_cv_;

    mutable std::condition_variable done_cv_;

    mutable std::uint64_t epoch_ = 0;

    mutable int finished_ = 0;

    bool stop_ = false;

    mutable std::exception_ptr worker_error_;

    std::atomic<int> fail_tickets_{0};

    std::atomic<int> delay_us_{0};

    enum class PoolJob : unsigned char
    {
        Chance = 0,
        Slots = 1,
        Response = 2,
    };

    enum class SlotPass : unsigned char
    {
        Freeze = 0,
        Floor = 1,
        FloorAndFreeze = 2,
        Discount = 3,
        DiscountAndFreeze = 4,
        PcfrCommit = 5,
        PcfrZeroPrediction = 6,
    };

    mutable PoolJob pool_job_ = PoolJob::Chance;

    SlotPass slot_pass_ = SlotPass::Freeze;

    int slot_floor_player_ = -1;

    // When true, chunk_begin_/chunk_end_ index player_slots_[slot_floor_player_]
    // rather than the dense slots vector (player-only slot passes).
    bool slot_pass_player_list_ = false;

    double slot_positive_discount_ = 1.0;

    double slot_negative_discount_ = 0.5;

    double freeze_seconds_ = 0.0;

    int n0 = 0;

    int n1 = 0;

    int public_decisions = 0;

    int public_terminals = 0;

    std::uint64_t expanded_decisions = 0;

    std::uint64_t expanded_terminals = 0;

    std::uint64_t counted_deals_ = 0;

    std::uint64_t planned_slots_ = 0;

    // Supported (node, hand, runout) infosets with exactly one legal action.
    // Counted for infoset_count / strategy export; no Slot or table rows.
    std::uint64_t planned_implicit_ = 0;

    std::int64_t planned_cursor_ = 0;

    std::uint64_t estimated_peak_bytes_ = 0;

    // Legal public cards / ordered pairs off the board. Dense slot_of indexes
    // use these instead of full 52 / 52×52 maps that include on-board cards.
    // mode2_of_ is allocated only on flops (card_mode 2); turn/river skip it.
    std::array<int, 52> mode1_of_{};

    std::pmr::vector<int> mode1_cards_;

    std::pmr::vector<int> mode2_of_;

    std::pmr::vector<int> mode2_turn_;

    std::pmr::vector<int> mode2_river_;

    std::uint64_t max_rank_keys_ = 0;

    bool plan_only_ = false;

    double construction_seconds_ = 0.0;

    double train_seconds_ = 0.0;

    mutable double evaluation_seconds_ = 0.0;

    double joint_mass_ = 0.0;

    int trained = 0;

    bool algorithm_bound_ = false;

    Algorithm bound_algorithm_ = Algorithm::CfrPlus;

    DcfrParams dcfr_params_{};

    double joint_scale = 0.0;

    std::uint64_t board_mask = 0;

    // Non-owning; set for the duration of solve()/solve_frozen() from SolveConfig::locks.
    const LockSet* locks_ = nullptr;


    explicit Engine(streets::StreetConfig incoming, BudgetResource& budget, bool plan_only = false);


    ~Engine();


    void destroy_extra_contexts();


    std::int64_t cursor_ = 0;


    void validate() const;


    int build_node(const BetState& state, std::string_view path, int depth);


    void prepare_pair_scan();


    template <typename Visit>
    void for_each_legal_pair(Visit&& visit) const
    {
        for (int first = 0; first < holdem::kComboCount; ++first)
        {
            const double left = config.oop.weight(first);
            if (left == 0.0 || combo_blocked[static_cast<std::size_t>(first)] != 0)
            {
                continue;
            }
            const int a0 = combo_low[static_cast<std::size_t>(first)];
            const int a1 = combo_high[static_cast<std::size_t>(first)];
            for (int second = 0; second < holdem::kComboCount; ++second)
            {
                const double right = config.ip.weight(second);
                if (right == 0.0 || combo_blocked[static_cast<std::size_t>(second)] != 0)
                {
                    continue;
                }
                const int b0 = combo_low[static_cast<std::size_t>(second)];
                const int b1 = combo_high[static_cast<std::size_t>(second)];
                if (a0 == b0 || a0 == b1 || a1 == b0 || a1 == b1)
                {
                    continue;
                }
                visit(first, second, left * right);
            }
        }
    }


    void count_and_index_hands();


    void fill_deals();


    void set_hand_counts();


    void build_runout_index();


    std::uint64_t runout_dim(const Node& node) const;


    int slot_action_count(const Slot& slot) const;


    std::uint64_t slot_index_cells() const;


    std::uint64_t planned_allocation_bytes() const;


    void allocate_slot_of();


    void allocate_slots();


    void allocate_tables();


    int card_key(const Node& node, int hand, int turn, int river) const;


    int remaining(const Deal& deal, int turn, int river, int* out) const;


    std::string place_text(int street, int turn, int river) const;


    void add_slot(int node_index, int hand, int turn, int river);


    void note_planned_slot(const Node& node);


    void consider_slot(bool commit, int node_index, int hand, int turn, int river);


    // Every legal deal keeps four distinct hole cards off the board, so each
    // public node is reached by counted_deals_ times the same runout count.
    // extra is 0 on the first street, 1 after the next card, and 2 on the river.
    // The product is an expanded-history statistic. It is not a stored node count.
    void charge_visits(int extra, bool terminal);


    void visit_slots(bool commit);


    std::string slot_label(const Slot& slot) const;


    // Emit probability-1 rows for one-action decisions (no Slot / table storage).
    void append_implicit_strategy_entries(std::vector<StreetStrategyEntry>& entries) const;


    int slot_index(const Node& node, int hand, int turn, int river, double reach) const;


    PlayerPayoff terminal_modeled(const Node& node, const Deal& deal, int turn, int river) const;


    double payoff(const Node& node, const Deal& deal, int turn, int river) const;


    PlayerPayoff cfr_deal_payoff(int node_index, double pi0, double pi1, double chance, const Deal& deal,
                                 int turn, int river, int updating, double weight_iter);


    double cfr_deal(int node_index, double pi0, double pi1, double chance, const Deal& deal,
                    int turn, int river, int updating, double weight_iter);


    void reset();


    void ensure_pcfr_prediction_table();


    // Reject algorithm switches on trained state before any table mutation.
    // A fresh solve (reset / run_*) clears the binding first.
    void bind_training_algorithm(Algorithm algorithm);


    void bind_algorithm_for_tables(Algorithm algorithm);


    // Algorithm schedules (bodies in src/solver/postflop/algorithms/*.hpp).
    void train_more_vanilla_iterations(int count);

    void train_more_cfr_plus_iterations(int count);

    void train_frozen_vanilla_iterations(int count);

    void train_frozen_cfr_plus_iterations(int count);

    void train_frozen_dcfr_iterations(int count);

    void train_frozen_pcfr_plus_iterations(int count);


    void train_more(int count, Algorithm algorithm);


    // True when this call rebuilt the sigma from the stored sums.
    // Rebuilding does not change the profile epoch. Training and edits do.
    bool ensure_average() const;


    int stored_slot(const Node& node, int hand, int turn, int river) const;


    // One public-tree pass. responding < 0 plays the sigma strategy.
    // A best-responding player picks, per hand, the action with the higher
    // utility and keeps the lowest index on a tie. The other player mixes.
    void parallel_response_chance(
        WorkerContext& ctx,
        const Node& node,
        int turn,
        int river,
        int depth,
        int responding,
        const double* pi0,
        const double* pi1) const;


    void response_walk(
        WorkerContext& ctx,
        int node_index,
        int turn,
        int river,
        int depth,
        int responding,
        bool serial_chance) const;


    static double sum_scratch(const std::pmr::vector<double>& values);


    void prepare_response_root() const;


    double utility_of_response(int responding) const;


    EvaluationResult evaluate_profile() const;


    void build_reach_table();


    void prepare_context(WorkerContext& ctx);


    const BoardSupport& board_support_for(int turn, int river) const;


    void ensure_board_support(WorkerContext& ctx, int turn, int river) const;


    void fill_actor_slot_bases(
        WorkerContext& ctx,
        Scratch& here,
        const Node& node,
        int turn,
        int river,
        const double* pi) const;


    void prepare_rank_cache();


    // Every (turn, river) the frozen walk can request, including partial boards
    // such as (turn, -1) on a flop before the river is dealt.
    void prepare_support_cache();


    void ensure_support_masks() const;


    bool hand_live(int player, int hand, int turn, int river) const;


    void fill_ranks(RunoutRanks& table, int turn, int river) const;


    void fill_showdown(RunoutRanks& table) const;


    // Rank storage is reserved during construction. The values and the
    // showdown order are written once, on the calling thread, before a pass
    // reads them.
    void ensure_ranks() const;


    const std::pmr::vector<std::uint32_t>& ranks_for(int player, int turn, int river) const;


    const RunoutRanks& runout_for(int turn, int river) const;


    void collect_reach(
        WorkerContext& ctx,
        int player,
        int turn,
        int river,
        const double* pi,
        bool use_board,
        std::pmr::vector<double>& amount,
        double& total,
        double* by_card) const;


    // Subtraction is trusted only when the remainder dominates rounding of the inputs.
    // A zero result is trusted only when both inputs are zero. A negative residual is not.
    bool difference_is_stable(double total, double removed, double difference) const;


    bool shares_hole(int hero, int hero_hand, int opponent, int opponent_hand) const;


    double direct_compatible_mass(int hero, int hand, int opponent, std::span<const double> opp_amount) const;


    double stable_compatible_mass(
        int hero,
        int hand,
        int opponent,
        double total,
        const double* by_card,
        std::span<const double> opp_amount) const;


    double blocked_reach(int hero, int hand, const double* by_card, std::span<const double> opp_amount) const;


    // Opponents in the initial support who are removed by these public cards.
    // The pair adjustment matches registration, including an opponent combo
    // that holds both cards.
    int compatible_on(int player, int hand, int turn, int river) const;


    // Structural support ignores strategy. A hand that meets the board, or that
    // has no compatible opponent left on this board, has no history here.
    bool hand_supported(int player, int hand, int turn, int river) const;


    // Same-pair condition: some legal pair on this board has positive reach on
    // at least one side. A positive-reach hand with no compatible partner does
    // not qualify. Chance probabilities are not renormalized over the cards
    // this keeps.
    bool card_reaches_pair(
        WorkerContext* profile_ctx,
        int turn,
        int river,
        const double* pi0,
        const double* pi1) const;


    void order_reach(
        WorkerContext& ctx,
        int player,
        std::span<const double> amount,
        const RunoutRanks& table) const;


    double slice_reach(
        const WorkerContext& ctx,
        const RunoutRanks& table,
        int player,
        int begin,
        int end,
        int c0,
        int c1,
        int cut0_begin,
        int cut1_begin,
        int cut0_end,
        int cut1_end,
        int add_hand,
        std::span<const double> amount,
        std::span<const std::uint16_t> pos) const;


    void direct_rank_masses(
        const RunoutRanks& table,
        int hero,
        int hand,
        std::span<const double> opp_amount,
        double& worse_mass,
        double& better_mass,
        double* tie_mass = nullptr) const;


    void showdown_side(
        WorkerContext& ctx,
        int hero,
        int turn,
        int river,
        double win_pay,
        double lose_pay,
        double tie_pay,
        std::span<const double> opp_amount,
        std::span<double> ev,
        bool stable) const;


    void apply_terminal(
        WorkerContext& ctx,
        const Node& node,
        int turn,
        int river,
        const double* pi0,
        const double* pi1,
        std::span<double> ev0,
        std::span<double> ev1,
        bool stable) const;


    void check_usable() const;


    void join_workers();


    void setup_workers();


    WorkerContext& context_for(int worker_index);


    void run_chunk(int worker_index, int begin, int end);


    void run_response_chunk(int worker_index, int begin, int end);


    void worker_main(int worker_index);


    void dispatch_workers(PoolJob job);


    void dispatch_chance();


    void partition_slots();


    void partition_player_slots(int player);


    void apply_freeze_range(std::size_t begin, std::size_t end);


    void apply_floor_range(std::size_t begin, std::size_t end, int player);


    // Floor one player's regrets, then rebuild sigma for every slot.
    // Same values as floor_player then freeze_sigma; one slot scan instead of two.
    // Under PCFR+, matching uses R+m (prediction_) after the floor.
    void apply_floor_and_freeze_range(std::size_t begin, std::size_t end, int player);


    // PCFR+: after a walk that wrote instantaneous CF regret into prediction_,
    // add those increments into regret, floor the updating player, and keep
    // prediction_ as m for the next match. Opponent prediction rows are untouched.
    void apply_pcfr_commit_range(std::size_t begin, std::size_t end, int player);


    void apply_pcfr_zero_prediction_range(std::size_t begin, std::size_t end, int player);


    // DCFR: discount every action entry of the updating player after the pass,
    // including entries whose increment this pass was zero. Regret already holds
    // the post-pass value; do not add the increment again.
    void apply_discount_range(std::size_t begin, std::size_t end, int player);


    void apply_discount_and_freeze_range(std::size_t begin, std::size_t end, int player);


    void run_slot_range(int begin, int end);


    void run_slot_pass(SlotPass pass, int player);


    // Descendant information sets of different cards are disjoint: each slot
    // stores the public node and the dealt card. Workers write those entries
    // directly. This node and its ancestors stay on the caller and are updated
    // only after the join, in ascending card order.
    void parallel_chance(
        WorkerContext& ctx,
        const Node& node,
        int turn,
        int river,
        int depth,
        int updating,
        double weight_iter,
        const double* pi0,
        const double* pi1);


    void frozen_walk(
        WorkerContext& ctx,
        int node_index,
        int turn,
        int river,
        int depth,
        int updating,
        double weight_iter,
        bool serial_chance);


    // When locks_ is set, locked rows replace RM for matching public nodes.
    // Lock infoset_id is the public-node index (slot.node). SelectedCombos
    // uses the acting player's hand index (slot.hand). Slots are independent:
    // each writes only its own sigma / regret span, so threads > 1
    // partition the slot vector with the same worker pool as chance splits.
    void freeze_sigma();


    void floor_player(int player);


    void floor_and_freeze(int player);


    void pcfr_zero_prediction(int player);


    void pcfr_commit(int player);


    void discount_player(int player, double positive, double negative);


    void discount_and_freeze(int player, double positive, double negative);


    void frozen_pass(int updating, double weight_iter, Algorithm algorithm);


    void train_frozen(int count, Algorithm algorithm);


    bool implicit_infoset_action(const std::string& infoset, const std::string& action) const;


    bool assign_labeled_regret(const std::string& infoset, const std::string& action, double value);


    bool read_labeled_regret(const std::string& infoset, const std::string& action, double& value) const;


    StreetMemoryReport memory_report() const;


    std::vector<StreetPublicNode> public_tree() const;


    std::string root_node_id() const;


    // Leading zeros and other accepted spellings name the same public node.
    std::string canonical_node_id(const std::string& text) const;


    bool parse_node_id(const std::string& text, int& node, int& turn, int& river) const;


    std::string node_id(int node, int turn, int river) const;


    bool card_on_board(int card) const;


    void locate_node(const std::string& text, int& node, int& turn, int& river) const;


    void zero_unsupported(std::vector<double>& reach, int player, int turn, int river) const;


    void zero_card(std::vector<double>& reach, int player, int card) const;


    double joint_mass_of(const std::vector<double>& left, const std::vector<double>& right) const;


    void marginals_of(
        const std::vector<double>& reach,
        int player,
        const std::vector<double>& opponent,
        int opponent_player,
        double& joint,
        std::vector<double>& marginal) const;


    void index_parents();


    void fill_terminal_incentives();


    // Replay public betting along the parent chain with the same legal/edits
    // path used while building the tree. State at the target node is before that
    // node's action (or chance deal).
    BetState betting_state_along(const std::vector<int>& chain) const;


    void fill_inspection_betting(
        StreetInspection& view,
        const BetState& state,
        int node_index,
        int turn,
        int river) const;


    void fill_opponent_hands(
        StreetInspection& view,
        int opponent,
        const std::vector<double>& reach,
        const std::vector<double>& other,
        int seen_turn,
        int seen_river) const;


    StreetInspection inspect_node(const std::string& text) const;


    void set_average_strategy(const std::string& text, int hand, std::span<const double> probability);


    void invalidate_prepared_average();


    void set_average_for_test(const std::string& text, int hand, std::span<const double> probability);


    void throw_if_cancelled(const std::atomic<bool>* cancel) const;


    // Average-policy values. force is only the selected decision: that action is
    // taken with probability 1, and every later decision mixes the sigma.
    // Hero values are not multiplied by hero reach. Opponent reach is, so an
    // opponent's mixed value is the sum of the already-scaled action values.
    void average_value_walk(
        WorkerContext& ctx,
        int node_index,
        int turn,
        int river,
        int depth,
        bool force,
        const std::atomic<bool>* cancel) const;


    void replay_weights(
        int node_index,
        int turn,
        int river,
        std::vector<double>& q0,
        std::vector<double>& q1) const;


    StreetActionValues compute_action_values(
        const std::string& text,
        const std::atomic<bool>* cancel) const;


    struct Continuation
    {
        bool defined = false;
        double ev = 0.0;
    };


    Continuation player_continuation(
        int node_index,
        int turn,
        int river,
        const std::vector<double>& q0,
        const std::vector<double>& q1,
        int player,
        const std::atomic<bool>* cancel) const;


    bool same_combos(const std::vector<int>& stored, const std::pmr::vector<int>& live) const;


    void export_table_identity(TrainingTables& tables) const;


    void export_tables_into(TrainingTables& tables) const;


    TrainingTables export_tables() const;


    void install_tables(const TrainingTables& tables);


    bool same_live_combos(
        const std::pmr::vector<int>& left,
        const std::pmr::vector<int>& right) const;


    void copy_training_state_from(const Engine& other);


    void install_prediction(std::span<const double> values);


    std::string weighted_range(int player, const std::vector<double>& reach) const;


    StreetRunoutValues compute_runout_values(
        const std::string& text,
        const std::atomic<bool>* cancel) const;


    StreetReachWeights compute_reaching_weights(const std::string& text) const;

};

} // namespace poker::solver
