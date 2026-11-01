#pragma once

#include "solver/node_lock.hpp"

#include <algorithm>
#include <cstddef>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace poker::solver
{

// How a StrategyEdit overlays stored average-strategy rows at one public node.
// Distinct from LockSet: edits rewrite the prepared average profile for browse /
// EV / export views; they do not constrain CFR regret matching.
enum class StrategyEditKind
{
    FullNode,        // same probability row for every structural hand
    SelectedCombos,  // row applies only to listed hand indices
};

// One free-form average-strategy edit at an infoset / public-node key.
// probs must be nonempty, nonnegative, length == action_count, and sum to 1
// within kLockProbSumTolerance (same contract as ActionLockRow when locked).
struct StrategyEdit
{
    std::size_t infoset_id = 0;
    StrategyEditKind kind = StrategyEditKind::FullNode;
    std::vector<std::size_t> hand_indices;
    std::vector<double> probs;
};

inline bool validate_strategy_probs(std::span<const double> probs, int action_count)
{
    // Empty is not a valid stored-strategy row (unlike an unlocked lock).
    if (probs.empty())
    {
        return false;
    }
    return validate_action_row(probs, action_count);
}

inline std::vector<double> make_strategy_probs(std::span<const double> probs, int action_count)
{
    if (!validate_strategy_probs(probs, action_count))
    {
        throw std::invalid_argument("invalid strategy probability row");
    }
    return std::vector<double>(probs.begin(), probs.end());
}

inline bool strategy_hand_is_selected(const StrategyEdit& edit, std::size_t hand_index)
{
    if (edit.kind == StrategyEditKind::FullNode)
    {
        return true;
    }
    for (const std::size_t index : edit.hand_indices)
    {
        if (index == hand_index)
        {
            return true;
        }
    }
    return false;
}

// Collection of StrategyEdit keyed by infoset / public-node id.
class StrategyEditSet
{
public:
    void upsert(StrategyEdit edit)
    {
        if (edit.probs.empty())
        {
            throw std::invalid_argument("strategy edit requires a probability row");
        }
        if (edit.kind == StrategyEditKind::SelectedCombos && edit.hand_indices.empty())
        {
            throw std::invalid_argument("selected strategy edit needs hand indices");
        }
        const std::size_t id = edit.infoset_id;
        by_id_[id] = std::move(edit);
    }

    bool erase(std::size_t infoset_id)
    {
        return by_id_.erase(infoset_id) > 0;
    }

    // Remove one hand from a SelectedCombos edit. FullNode cannot be partially
    // cleared this way. Erases the node edit when no hands remain.
    bool erase_hand(std::size_t infoset_id, std::size_t hand_index)
    {
        const auto it = by_id_.find(infoset_id);
        if (it == by_id_.end())
        {
            return false;
        }
        if (it->second.kind != StrategyEditKind::SelectedCombos)
        {
            return false;
        }
        auto& indices = it->second.hand_indices;
        const auto found = std::find(indices.begin(), indices.end(), hand_index);
        if (found == indices.end())
        {
            return false;
        }
        indices.erase(found);
        if (indices.empty())
        {
            by_id_.erase(it);
        }
        return true;
    }

    const StrategyEdit* find(std::size_t infoset_id) const
    {
        const auto it = by_id_.find(infoset_id);
        if (it == by_id_.end())
        {
            return nullptr;
        }
        return &it->second;
    }

    void clear()
    {
        by_id_.clear();
    }

    bool empty() const
    {
        return by_id_.empty();
    }

    std::size_t size() const
    {
        return by_id_.size();
    }

    std::vector<std::size_t> infoset_ids() const
    {
        std::vector<std::size_t> ids;
        ids.reserve(by_id_.size());
        for (const auto& entry : by_id_)
        {
            ids.push_back(entry.first);
        }
        std::sort(ids.begin(), ids.end());
        return ids;
    }

private:
    std::unordered_map<std::size_t, StrategyEdit> by_id_;
};

} // namespace poker::solver
