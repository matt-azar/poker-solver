// StreetBatchSolver::Engine method definitions.
#include "engine.hpp"

namespace poker::solver
{


void StreetBatchSolver::Engine::allocate_tables()
{
    if (cursor_ != planned_cursor_)
    {
        throw std::logic_error("street regret cursor did not match the memory plan");
    }
    const auto entries = static_cast<std::size_t>(cursor_);
    budget_->set_stage("regret");
    regret.assign(entries, TableScalar{0});
    budget_->set_stage("strategy_sum");
    strategy_sum.assign(entries, TableScalar{0});
    budget_->set_stage("sigma");
    sigma.assign(entries, TableScalar{0});
}



void StreetBatchSolver::Engine::reset()
{
    std::fill(regret.begin(), regret.end(), 0.0);
    std::fill(strategy_sum.begin(), strategy_sum.end(), 0.0);
    if (!prediction_.empty())
    {
        std::fill(prediction_.begin(), prediction_.end(), 0.0);
    }
    average_ready = false;
    trained = 0;
    algorithm_bound_ = false;
    bound_algorithm_ = Algorithm::CfrPlus;
    pcfr_collect_ = false;
}



void StreetBatchSolver::Engine::ensure_pcfr_prediction_table()
{
    if (prediction_.size() == regret.size())
    {
        return;
    }
    budget_->set_stage("pcfr_prediction");
    prediction_.assign(regret.size(), 0.0);
}



// Reject algorithm switches on trained state before any table mutation.
// A fresh solve (reset / run_*) clears the binding first.
void StreetBatchSolver::Engine::bind_training_algorithm(Algorithm algorithm)
{
    if (trained > 0 && !algorithm_bound_)
    {
        throw std::invalid_argument(
            "training algorithm is not bound on restored state; bind the solution algorithm first");
    }
    if (algorithm_bound_ && bound_algorithm_ != algorithm)
    {
        throw std::invalid_argument(
            "cannot switch training algorithm on an existing trained state; start a new solve");
    }
    algorithm_bound_ = true;
    bound_algorithm_ = algorithm;
}



void StreetBatchSolver::Engine::bind_algorithm_for_tables(Algorithm algorithm)
{
    algorithm_bound_ = true;
    bound_algorithm_ = algorithm;
}



// True when this call rebuilt the sigma from the stored sums.
// Rebuilding does not change the profile epoch. Training and edits do.
bool StreetBatchSolver::Engine::ensure_average() const
{
    check_usable();
    if (average_ready)
    {
        return false;
    }
    for (const Slot& slot : slots)
    {
        normalize_average(
            strategy_sum.data() + slot.base,
            sigma.data() + slot.base,
            slot_action_count(slot));
    }
    average_ready = true;
    return true;
}



int StreetBatchSolver::Engine::stored_slot(const Node& node, int hand, int turn, int river) const
{
    return node.slot_of[static_cast<std::size_t>(card_key(node, hand, turn, river))];
}



bool StreetBatchSolver::Engine::same_combos(const std::vector<int>& stored, const std::pmr::vector<int>& live) const
{
    if (stored.size() != live.size())
    {
        return false;
    }
    for (std::size_t index = 0; index < stored.size(); ++index)
    {
        if (stored[index] != live[index])
        {
            return false;
        }
    }
    return true;
}



void StreetBatchSolver::Engine::export_table_identity(TrainingTables& tables) const
{
    tables.iterations = trained;
    tables.oop_combos.assign(combos[0].begin(), combos[0].end());
    tables.ip_combos.assign(combos[1].begin(), combos[1].end());
    tables.slot_actions.resize(slots.size());
    for (std::size_t index = 0; index < slots.size(); ++index)
    {
        tables.slot_actions[index] =
            static_cast<std::uint16_t>(slot_action_count(slots[index]));
    }
    tables.regret.clear();
    tables.strategy_sum.clear();
}



void StreetBatchSolver::Engine::export_tables_into(TrainingTables& tables) const
{
    export_table_identity(tables);
    tables.regret.resize(regret.size());
    tables.strategy_sum.resize(strategy_sum.size());
    for (std::size_t index = 0; index < regret.size(); ++index)
    {
        tables.regret[index] = static_cast<double>(regret[index]);
        tables.strategy_sum[index] = static_cast<double>(strategy_sum[index]);
    }
}



TrainingTables StreetBatchSolver::Engine::export_tables() const
{
    TrainingTables tables;
    export_tables_into(tables);
    return tables;
}



void StreetBatchSolver::Engine::install_tables(const TrainingTables& tables)
{
    check_usable();
    if (tables.iterations < 0
        || !same_combos(tables.oop_combos, combos[0])
        || !same_combos(tables.ip_combos, combos[1])
        || tables.slot_actions.size() != slots.size()
        || tables.regret.size() != regret.size()
        || tables.strategy_sum.size() != strategy_sum.size())
    {
        throw std::invalid_argument("training tables do not match this tree");
    }
    for (std::size_t index = 0; index < slots.size(); ++index)
    {
        if (tables.slot_actions[index] != static_cast<std::uint16_t>(slot_action_count(slots[index])))
        {
            throw std::invalid_argument("training tables do not match this tree");
        }
    }
    std::copy(tables.regret.begin(), tables.regret.end(), regret.begin());
    std::copy(tables.strategy_sum.begin(), tables.strategy_sum.end(), strategy_sum.begin());
    trained = tables.iterations;
    average_ready = false;
}



bool StreetBatchSolver::Engine::same_live_combos(
    const std::pmr::vector<int>& left,
    const std::pmr::vector<int>& right) const
{
    if (left.size() != right.size())
    {
        return false;
    }
    for (std::size_t index = 0; index < left.size(); ++index)
    {
        if (left[index] != right[index])
        {
            return false;
        }
    }
    return true;
}



void StreetBatchSolver::Engine::copy_training_state_from(const Engine& other)
{
    check_usable();
    if (regret.size() != other.regret.size()
        || strategy_sum.size() != other.strategy_sum.size()
        || slots.size() != other.slots.size()
        || !same_live_combos(combos[0], other.combos[0])
        || !same_live_combos(combos[1], other.combos[1]))
    {
        throw std::invalid_argument("training state does not match this tree");
    }
    for (std::size_t index = 0; index < slots.size(); ++index)
    {
        if (slot_action_count(slots[index]) != slot_action_count(other.slots[index]))
        {
            throw std::invalid_argument("training state does not match this tree");
        }
    }
    std::copy(other.regret.begin(), other.regret.end(), regret.begin());
    std::copy(other.strategy_sum.begin(), other.strategy_sum.end(), strategy_sum.begin());
    if (other.prediction_.empty())
    {
        if (!prediction_.empty())
        {
            std::fill(prediction_.begin(), prediction_.end(), 0.0);
        }
    }
    else
    {
        ensure_pcfr_prediction_table();
        std::copy(other.prediction_.begin(), other.prediction_.end(), prediction_.begin());
    }
    trained = other.trained;
    algorithm_bound_ = other.algorithm_bound_;
    bound_algorithm_ = other.bound_algorithm_;
    dcfr_params_ = other.dcfr_params_;
    average_ready = false;
}



void StreetBatchSolver::Engine::install_prediction(std::span<const double> values)
{
    check_usable();
    if (values.empty())
    {
        if (!prediction_.empty())
        {
            std::fill(prediction_.begin(), prediction_.end(), 0.0);
        }
        return;
    }
    if (values.size() != regret.size())
    {
        throw std::invalid_argument("prediction table does not match this tree");
    }
    ensure_pcfr_prediction_table();
    for (std::size_t index = 0; index < values.size(); ++index)
    {
        prediction_[index] = static_cast<TableScalar>(values[index]);
    }
}


} // namespace poker::solver
